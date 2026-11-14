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
    expect(restored.client.state.blocked.get(A)?.reason).toBe("conflict");
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
    expect(laptop.client.state.blocked.get(A)?.reason).toMatch(/YAML/);
    expect(field(world, "status")).toBe("after");
    const [client] = world.sql.all<{ highWater: number }>(
      "SELECT highWater FROM clients WHERE clientId = ?",
      laptop.client.state.clientId,
    );
    expect(client?.highWater).toBe(2);
  });
});
