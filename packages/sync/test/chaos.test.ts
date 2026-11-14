// The protocol's named failure cases, each played out against the record's real `serve`.
import { parseNote } from "@brainiac/core";
import { describe, expect, it } from "vite-plus/test";

import { setField, World, type Device } from "./sim.ts";

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
    // The draft it held is not replayed over the newer value; the clash is kept for the person.
    expect([field(world, "status"), field(world, "title")]).toEqual(["final", "renamed"]);
    const setsDraft = world.sql
      .all<{ patch: string }>("SELECT patch FROM revisions WHERE noteId = ?", A)
      .filter((r) => JSON.parse(r.patch).fields.status?.after === "draft");
    expect(setsDraft).toHaveLength(1);
    expect(restored.client.state.blocked.get(A)?.at(-1)?.reason).toBe("conflict");
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

  it("blocks a refused edit, uses up its number, and keeps going", () => {
    const { world, laptop } = start();
    const good = world.note(A)?.raw ?? "";
    laptop.client.edit(A, "---\nid: [\n---\n");
    // The person fixes the file; this edit starts from the broken text.
    laptop.client.edit(A, good.replace("type: Note", "type: Note\nstatus: after"));
    world.settle();
    expect(laptop.client.state.blocked.get(A)?.at(-1)?.reason).toMatch(/YAML/);
    expect(field(world, "status")).toBe("after");
    const [client] = world.sql.all<{ highWater: number }>(
      "SELECT highWater FROM clients WHERE clientId = ?",
      laptop.client.state.clientId,
    );
    expect(client?.highWater).toBe(2);
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
});
