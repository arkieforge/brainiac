// The protocol's named failure cases, each played out against the record's real `serve`.
import { DAY_MS, mutate } from "@brainiac/base";
import { parseNote, patch } from "@brainiac/core";
import { describe, expect, it } from "vite-plus/test";

import { addLine, setField, World, type Device } from "./sim.ts";

const A = "01M6AAAAAAAAAAAAAAAAAAAAA1";

function start() {
  const world = new World();
  world.seed(A, "notes/a.md");
  const laptop = world.device("laptop");
  const phone = world.device("phone");
  world.settle();
  return { world, laptop, phone };
}

const field = (world: World, key: string) => parseNote(world.note(A)?.raw ?? "").data[key];
const revisions = (world: World) =>
  world.sql.all<{ raw: string }>("SELECT raw FROM revisions WHERE noteId = ?", A);

function expectConverged(world: World, ...devices: Device[]) {
  const live = world.live();
  for (const d of devices) {
    expect(d.client.state.pending, d.name).toEqual([]);
    expect(
      new Map([...d.client.state.remote].map(([id, n]) => [id, { rev: n.rev, raw: n.raw }])),
      d.name,
    ).toEqual(live);
  }
}

/** Another machine with this id makes the record reset the laptop over its first pending change. */
function reset(laptop: Device) {
  const [first] = laptop.client.state.pending;
  laptop.client.receive({
    type: "reset",
    clientId: laptop.client.state.clientId,
    clientSeq: first?.clientSeq ?? 0,
    reason: "test",
  });
}

/** A device's state as a backup tool would copy it. */
const copy = (device: Device) => structuredClone(device.client.state);

describe("sync chaos", () => {
  it("applies reordered and repeated mutations once, in order", () => {
    const { world, laptop } = start();
    setField(laptop, A, "status", "one");
    setField(laptop, A, "title", "two");
    const first = structuredClone(laptop.link.up[0]!);
    // 2 arrives first and is refused as a gap; 1 applies; the client resends 2.
    world.up(laptop, 1);
    world.up(laptop, 0);
    world.settle();
    // A late duplicate of 1 gets its stored result again and changes nothing.
    laptop.link.up.push(first);
    world.settle();
    expect([field(world, "status"), field(world, "title")]).toEqual(["one", "two"]);
    expect(revisions(world)).toHaveLength(3);
    expectConverged(world, laptop);
  });

  it("repairs a week-old backup without applying anything twice or reverting newer edits", () => {
    const { world, laptop, phone } = start();
    world.disconnect(laptop);
    setField(laptop, A, "status", "draft");
    const backup = copy(laptop);
    const oldId = backup.clientId;
    world.settle();
    // A week of other edits after the backup was taken.
    setField(phone, A, "status", "final");
    setField(laptop, A, "title", "renamed");
    world.settle();

    world.retire(laptop);
    const restored = world.device("laptop", backup);
    world.settle();
    expect(restored.client.state.clientId).not.toBe(oldId);
    // The draft it held is not replayed over the newer value.
    expect([field(world, "status"), field(world, "title")]).toEqual(["final", "renamed"]);
    const setsDraft = world.sql
      .all<{ patch: string }>("SELECT patch FROM revisions WHERE noteId = ?", A)
      .filter((r) => JSON.parse(r.patch).fields.status?.after === "draft");
    expect(setsDraft).toHaveLength(1);
    // The draft already landed, so its replay is answered as applied: no conflict to pick.
    expect(restored.client.state.blocked.size).toBe(0);
    expect(world.sql.all("SELECT * FROM proposals")).toEqual([]);
    expectConverged(world, restored, phone);
  });

  it("splits a cloned vault into two identities and keeps both copies' edits", () => {
    const { world, laptop } = start();
    world.disconnect(laptop);
    const clone = world.device("clone", copy(laptop));
    setField(laptop, A, "title", "from the laptop");
    setField(clone, A, "status", "from the clone");
    world.settle();
    expect(laptop.client.state.clientId).not.toBe(clone.client.state.clientId);
    expect([field(world, "title"), field(world, "status")]).toEqual(["from the laptop", "from the clone"]);
    expectConverged(world, laptop, clone);
  });

  it("resets the second of two machines sharing an id while both are online", () => {
    const { world, laptop } = start();
    const other = world.device("other", copy(laptop));
    world.settle();
    setField(laptop, A, "title", "first");
    world.settle();
    // The other machine reuses clientSeq 1 for a different change.
    setField(other, A, "status", "second");
    world.settle();
    setField(laptop, A, "kind", "third");
    world.settle();
    expect([field(world, "title"), field(world, "status"), field(world, "kind")]).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(laptop.client.state.clientId).not.toBe(other.client.state.clientId);
    expectConverged(world, laptop, other);
  });

  it("repairs under a new id when its connection is re-issued, edits made offline included", () => {
    const { world, laptop } = start();
    setField(laptop, A, "title", "before");
    world.settle();
    const oldId = laptop.client.state.clientId;
    world.disconnect(laptop);
    setField(laptop, A, "status", "offline");
    // `brainiac logout` and `login` again: the same vault now speaks for a new connection.
    laptop.actor = "connection:reissued";
    world.settle();
    expect(laptop.client.state.clientId).not.toBe(oldId);
    expect([field(world, "title"), field(world, "status")]).toEqual(["before", "offline"]);
    expect(laptop.client.state.blocked.size).toBe(0);
    expect(world.sql.all("SELECT actor FROM clients WHERE clientId = ?", oldId)).toEqual([
      { actor: "human" },
    ]);
  });

  it("blocks a refused edit, uses up its number, and keeps going", () => {
    const { world, laptop } = start();
    const good = world.note(A)?.raw ?? "";
    laptop.client.edit(A, "---\nid: [\n---\n");
    // The person fixes the file; this edit starts from the broken text.
    laptop.client.edit(A, good.replace("type: Note", "type: Note\nstatus: after"));
    world.settle();
    // The fix landed, so the refused edit before it is no longer blocked.
    expect(laptop.client.state.blocked.has(A)).toBe(false);
    expect(field(world, "status")).toBe("after");
    const [client] = world.sql.all<{ highWater: number }>(
      "SELECT highWater FROM clients WHERE clientId = ?",
      laptop.client.state.clientId,
    );
    expect(client?.highWater).toBe(2);
  });

  it("a refused edit stays blocked until an edit made on its text lands, through a chain of them", () => {
    const { world, laptop } = start();
    const broken = "---\nid: [\n---\nhalf\n";
    const worse = `${broken}more\n`;
    laptop.client.edit(A, broken);
    laptop.client.edit(A, worse, broken);
    world.settle();
    expect(laptop.client.state.blocked.get(A)?.length).toBe(2);
    // An edit made on the record's text fixes nothing the person wrote in the refused ones.
    setField(laptop, A, "title", "elsewhere");
    world.settle();
    expect(laptop.client.state.blocked.get(A)?.length).toBe(2);
    // The fix starts from the refused text, which has no readable base, so it repeats the record's fields.
    const now = world.note(A)?.raw ?? "";
    laptop.client.edit(A, now.replace("type: Note", "type: Note\nstatus: fixed"), worse);
    world.settle();
    expect(laptop.client.state.blocked.has(A)).toBe(false);
  });

  it("a change the record accepted stays in view until its push arrives", () => {
    const { world, laptop } = start();
    setField(laptop, A, "status", "landed");
    const C = "01M6AAAAAAAAAAAAAAAAAAAAA9";
    laptop.client.create(C, "notes/c.md", `---\nid: ${C}\ntype: Note\ntitle: c\n---\n`, "normal");
    while (world.up(laptop));
    // Each result comes just before its push; between them the view must not fall back.
    for (let step = 0; laptop.link.down.length > 0; step++) {
      world.down(laptop);
      expect(laptop.client.working(A), `after message ${step}`).toContain("status: landed");
      if (laptop.client.state.pending.every((p) => p.noteId !== C))
        expect(laptop.client.working(C)).toBeDefined();
    }
  });

  it("a change the record didn't apply stops showing at the next push", () => {
    const { world, laptop, phone } = start();
    const old = laptop.client.working(A)!;
    laptop.client.delete(A);
    world.settle();
    // Its old text again, on purpose: against the deleted note the record changes nothing and pushes nothing.
    laptop.client.edit(A, old, old);
    while (world.up(laptop) || world.down(laptop));
    const later = "01M6AAAAAAAAAAAAAAAAAAAAA8";
    phone.client.create(
      later,
      "notes/later.md",
      `---\nid: ${later}\ntype: Note\ntitle: later\n---\n`,
      "normal",
    );
    const heard: string[] = [];
    laptop.client.subscribe((ids) => heard.push(...ids));
    world.settle(); // any later push
    expect(laptop.client.working(A)).toBeUndefined();
    expect(heard).toContain(A); // a daemon reflects it, and takes the file away
  });

  it("a conflict stays blocked until the record moves past it", () => {
    const { world, laptop, phone } = start();
    world.disconnect(laptop);
    setField(laptop, A, "status", "laptop");
    setField(phone, A, "status", "phone");
    world.settle();
    expect(laptop.client.state.blocked.get(A)?.at(-1)?.reason).toBe("conflict");
    setField(phone, A, "title", "picked");
    world.settle();
    expect(laptop.client.state.blocked.has(A)).toBe(false);
  });

  // The original applied its change but went offline before acknowledging it, so its result is still stored.
  it("a clone that connects later never takes the original's result as its own", () => {
    const { world, laptop } = start();
    const before = copy(laptop);
    setField(laptop, A, "title", "from the laptop");
    world.up(laptop);
    world.disconnect(laptop);
    const clone = world.device("clone", before);
    setField(clone, A, "status", "from the clone");
    world.settle();
    expect([field(world, "title"), field(world, "status")]).toEqual(["from the laptop", "from the clone"]);
    expect(clone.client.state.clientId).not.toBe(laptop.client.state.clientId);
    expectConverged(world, laptop, clone);
  });

  it("refuses a create that isn't valid YAML without holding up what comes after it", () => {
    const { world, laptop } = start();
    const B = "01M6BBBBBBBBBBBBBBBBBBBBB1";
    laptop.client.create(B, "notes/b.md", "---\nid: [\n---\n", "normal");
    setField(laptop, A, "status", "after");
    world.settle();
    expect(field(world, "status")).toBe("after");
    expect(laptop.client.state.blocked.get(B)?.at(-1)?.reason).toMatch(/YAML/);
    expectConverged(world, laptop);
  });

  it("keeps an offline edit to a note deleted since whose path another note took", () => {
    const { world, laptop, phone } = start();
    world.disconnect(laptop);
    setField(laptop, A, "title", "offline edit");
    // While the laptop is away, the phone deletes the note and a new one takes its path.
    phone.client.delete(A);
    while (world.up(phone) || world.down(phone));
    const B = "01M6BBBBBBBBBBBBBBBBBBBBB1";
    phone.client.create(B, "notes/a.md", `---\nid: ${B}\ntype: Note\n---\n`, "normal");
    while (world.up(phone) || world.down(phone));
    world.settle();
    expect(world.note(A)?.deletedAt).not.toBeNull();
    const kept = laptop.client.state.blocked.get(A)?.at(-1);
    expect(kept?.reason).toMatch(/taken/);
    expect(kept && "raw" in kept.change && kept.change.raw).toContain("offline edit");
    expectConverged(world, laptop, phone);
  });

  it("repair resends a create that already landed as a create, never over edits made since", () => {
    const { world, laptop, phone } = start();
    const C = "01M6CCCCCCCCCCCCCCCCCCCCC1";
    laptop.client.create(C, "notes/c.md", `---\nid: ${C}\ntype: Note\ntitle: orig\n---\n`, "normal");
    world.up(laptop);
    // Its result is lost; the push of the create still arrives.
    laptop.link.down = laptop.link.down.filter((m) => m.type !== "result");
    while (world.down(laptop) || world.down(phone));
    setField(phone, C, "title", "newer");
    world.up(phone);
    while (world.down(laptop) || world.down(phone));
    // Another machine with this id makes the record reset it.
    laptop.client.receive({
      type: "reset",
      clientId: laptop.client.state.clientId,
      clientSeq: 1,
      reason: "test",
    });
    world.settle();
    expect(parseNote(world.note(C)?.raw ?? "").data["title"]).toBe("newer");
    expect(world.reverts()).toEqual([]);
    expectConverged(world, laptop, phone);
  });

  it("ignores a snapshot overtaken by a newer one", () => {
    const world = new World();
    world.seed(A, "notes/a.md");
    const phone = world.device("phone");
    world.settle();
    const tab = world.device("tab");
    world.connect(tab);
    world.up(tab);
    phone.client.create(
      "01M6BBBBBBBBBBBBBBBBBBBBB1",
      "notes/b.md",
      "---\nid: 01M6BBBBBBBBBBBBBBBBBBBBB1\n---\n",
      "normal",
    );
    world.up(phone);
    tab.client.connect();
    world.up(tab);
    // Waiting for the tab: welcome 1, snapshot at seq 1, the push 1 to 2, welcome 2, snapshot at seq 2.
    world.down(tab, 4);
    world.down(tab, 2);
    while (world.down(tab));
    world.settle();
    expectConverged(world, tab, phone);
  });

  describe("repair after results were lost", () => {
    const C = "01M6CCCCCCCCCCCCCCCCCCCCC1";
    /** The laptop creates C; it lands, but the result never comes back. Everyone else sees it. */
    function landedUnanswered() {
      const { world, laptop, phone } = start();
      laptop.client.create(C, "notes/c.md", `---\nid: ${C}\ntype: Note\ntitle: orig\n---\n`, "normal");
      world.up(laptop);
      laptop.link.down = laptop.link.down.filter((m) => m.type !== "result");
      while (world.down(laptop) || world.down(phone));
      return { world, laptop, phone };
    }
    const title = (world: World) => parseNote(world.note(C)?.raw ?? "").data["title"];

    it("a local delete made before another device's edit still waits for the person", () => {
      const { world, laptop, phone } = landedUnanswered();
      setField(phone, C, "title", "newer");
      world.up(phone);
      while (world.down(laptop) || world.down(phone));
      laptop.client.delete(C);
      reset(laptop);
      world.settle();
      expect([world.note(C)?.deletedAt, title(world)]).toEqual([null, "newer"]);
      expect(laptop.client.state.blocked.get(C)?.at(-1)?.reason).toBe("conflict");
      expectConverged(world, laptop, phone);
    });

    it("an edit and a local undo of it both replay, in order", () => {
      const { world, laptop, phone } = start();
      setField(laptop, A, "title", "temporary");
      world.up(laptop);
      // Offline before the result arrives; the undo waits in the queue.
      world.disconnect(laptop);
      setField(laptop, A, "title", "notes/a.md");
      reset(laptop);
      world.settle();
      expect(field(world, "title")).toBe("notes/a.md");
      expectConverged(world, laptop, phone);
    });

    it("a create that landed stays deleted when another device deleted it since", () => {
      const { world, laptop, phone } = landedUnanswered();
      phone.client.delete(C);
      world.up(phone);
      while (world.down(laptop) || world.down(phone));
      reset(laptop);
      world.settle();
      expect(world.note(C)?.deletedAt).not.toBeNull();
      expect(world.sql.all("SELECT * FROM proposals")).toEqual([]);
      expectConverged(world, laptop, phone);
    });
  });

  // After the record itself is restored, every hello's cursor is ahead of it, so each gets a snapshot.
  it("ignores an overtaken snapshot even after the record was restored", () => {
    const world = new World();
    world.seed(A, "notes/a.md");
    const phone = world.device("phone");
    world.settle();
    const tab = world.device("tab");
    tab.client.state.cursor = 99;
    world.connect(tab);
    world.up(tab);
    phone.client.create(
      "01M6BBBBBBBBBBBBBBBBBBBBB1",
      "notes/b.md",
      "---\nid: 01M6BBBBBBBBBBBBBBBBBBBBB1\n---\n",
      "normal",
    );
    world.up(phone);
    tab.client.connect();
    world.up(tab);
    world.down(tab, 4);
    world.down(tab, 2);
    while (world.down(tab));
    world.settle();
    expectConverged(world, tab, phone);
  });

  it("refuses YAML that expands past the alias limit, and keeps going", () => {
    const { world, laptop } = start();
    const B = "01M6BBBBBBBBBBBBBBBBBBBBB1";
    const bomb = `---\nid: ${B}\na: &a [x, x, x, x, x, x, x, x, x, x]\n${Array.from(
      { length: 12 },
      (_, i) =>
        `l${i}: &l${i} [${Array(10)
          .fill(i === 0 ? "*a" : `*l${i - 1}`)
          .join(", ")}]`,
    ).join("\n")}\n---\n`;
    laptop.client.create(B, "notes/b.md", bomb, "normal");
    setField(laptop, A, "status", "after");
    world.settle();
    expect(field(world, "status")).toBe("after");
    expect(laptop.client.state.blocked.get(B)?.at(-1)?.reason).toMatch(/can't be read|alias/i);
  });

  // The backup holds changes that later landed and were acknowledged; the record has moved on since.
  it("a restored backup never replays changes that already landed", () => {
    const { world, laptop, phone } = start();
    const C = "01M6CCCCCCCCCCCCCCCCCCCCC1";
    world.disconnect(laptop);
    laptop.client.create(C, "notes/c.md", `---\nid: ${C}\ntype: Note\ntitle: orig\n---\n`, "normal");
    setField(laptop, C, "title", "later");
    setField(laptop, A, "status", "B");
    const backup = copy(laptop);
    world.settle();
    // The laptop reconnects, acknowledging every result, so the record forgets them.
    world.disconnect(laptop);
    world.settle();
    // Someone else deletes C and sets A's status back to what it was.
    phone.client.delete(C);
    setField(phone, A, "status", "A-again");
    world.settle();

    world.retire(laptop);
    const restored = world.device("laptop", backup);
    world.settle();
    expect(world.note(C)?.deletedAt).not.toBeNull();
    expect(field(world, "status")).toBe("A-again");
    expect(world.sql.all("SELECT * FROM proposals")).toEqual([]);
    expectConverged(world, restored, phone);
  });

  it("refuses front-matter that refers to itself, and keeps going", () => {
    const { world, laptop } = start();
    const B = "01M6BBBBBBBBBBBBBBBBBBBBB1";
    laptop.client.create(B, "notes/b.md", `---\nid: ${B}\na: &a [*a]\n---\n`, "normal");
    setField(laptop, A, "status", "after");
    world.settle();
    expect(field(world, "status")).toBe("after");
    expect(laptop.client.state.blocked.get(B)?.at(-1)?.reason).toMatch(/can't be read/);
  });

  // Answers that wrote nothing (a change the record already had, a delete of a deleted note) count too.
  it("a restored backup never replays changes the record answered without writing", () => {
    const { world, laptop, phone } = start();
    const C = "01M6CCCCCCCCCCCCCCCCCCCCC1";
    phone.client.create(C, "notes/c.md", `---\nid: ${C}\ntype: Note\n---\n`, "normal");
    world.settle();
    // Both make the same change to A, and both delete C, while the laptop is away.
    world.disconnect(laptop);
    setField(laptop, A, "status", "B");
    laptop.client.delete(C);
    const backup = copy(laptop);
    setField(phone, A, "status", "B");
    phone.client.delete(C);
    while (world.up(phone) || world.down(phone));
    world.settle();
    world.disconnect(laptop);
    world.settle();
    // Then the phone takes status back out (as it was before either change), and the person restores C.
    phone.client.edit(A, patch(phone.client.working(A) ?? "", [{ op: "unset", path: ["status"] }]));
    world.settle();
    const tomb = world.note(C);
    if (!tomb) throw new Error("C is gone");
    mutate(
      world.sql,
      { op: "put", noteId: C, baseRev: tomb.rev, raw: tomb.raw },
      { actor: "site", now: Date.now() },
    );
    world.disconnect(phone);
    world.retire(laptop);
    const restored = world.device("laptop", backup);
    world.settle();
    expect(field(world, "status")).toBeUndefined();
    expect(world.note(C)?.deletedAt).toBeNull();
    expectConverged(world, restored, phone);
  });

  it("a laptop offline for 100 days catches up from a snapshot and lands its edits without reverting newer ones", () => {
    const D = "01M6DDDDDDDDDDDDDDDDDDDDD1";
    const world = new World();
    world.seed(A, "notes/a.md");
    world.seed(D, "notes/d.md");
    const laptop = world.device("laptop");
    const phone = world.device("phone");
    world.settle();
    world.disconnect(laptop);
    setField(laptop, A, "title", "offline title");
    addLine(laptop, A, "offline line");
    setField(laptop, D, "status", "offline edit");
    // While the laptop is away the phone edits one note and deletes the other.
    setField(phone, A, "status", "final");
    phone.client.delete(D);
    while (world.up(phone) || world.down(phone));
    // Past the 30-day tombstones and the 90-day change feed: the record keeps neither for the laptop.
    world.later(100 * DAY_MS);
    expect(world.sql.all("SELECT * FROM changes")).toEqual([]);
    expect(world.note(D)).toBeUndefined();

    const snapshots: number[] = [];
    const receive = laptop.client.receive.bind(laptop.client);
    laptop.client.receive = (message) => {
      if (message.type === "snapshot") snapshots.push(message.seq);
      receive(message);
    };
    world.settle();
    expect(snapshots.length).toBeGreaterThan(0);
    expect([field(world, "title"), field(world, "status")]).toEqual(["offline title", "final"]);
    expect(world.note(A)?.raw).toContain("offline line");
    // The edit to the note purged meanwhile is refused, never dropped: it stays on the laptop, with its text.
    const kept = laptop.client.state.blocked.get(D)?.at(-1);
    expect(kept && "raw" in kept.change && kept.change.raw).toContain("offline edit");
    expect(world.reverts()).toEqual([]);
    expectConverged(world, laptop, phone);
  });
});
