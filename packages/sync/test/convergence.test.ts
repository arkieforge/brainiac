import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { addLine, setField, World, type Device } from "./sim.ts";

const NOTES = ["01M6AAAAAAAAAAAAAAAAAAAAA1", "01M6AAAAAAAAAAAAAAAAAAAAA2", "01M6AAAAAAAAAAAAAAAAAAAAA3"];
const FIELDS = ["status", "title", "overall"];

const device = fc.integer({ min: 0, max: 2 });
const step = fc.oneof(
  {
    arbitrary: fc.record({ t: fc.constant("field"), d: device, note: fc.nat(2), field: fc.nat(2) }),
    weight: 6,
  },
  { arbitrary: fc.record({ t: fc.constant("line"), d: device, note: fc.nat(2) }), weight: 3 },
  { arbitrary: fc.record({ t: fc.constant("delete"), d: device, note: fc.nat(2) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant("create"), d: device }), weight: 1 },
  // Delivery picks any waiting message, so messages arrive out of order.
  { arbitrary: fc.record({ t: fc.constant("up"), d: device, pick: fc.nat(5) }), weight: 8 },
  { arbitrary: fc.record({ t: fc.constant("down"), d: device, pick: fc.nat(5) }), weight: 8 },
  { arbitrary: fc.record({ t: fc.constant("drop"), d: device }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant("connect"), d: device }), weight: 3 },
);

/** Every value a device wrote, and where: it must end in the record (a revision or a proposal) or be blocked. */
type Written = { device: Device; noteId: string; token: string };

function run(steps: readonly Record<string, number | string>[]) {
  const world = new World();
  for (const [i, id] of NOTES.entries()) world.seed(id, `notes/n${i}.md`);
  const devices = [world.device("laptop"), world.device("phone"), world.device("tab")];
  // Everyone starts in sync; the steps then take them apart.
  world.settle();
  const written: Written[] = [];
  let tokens = 0;
  const token = () => `t${++tokens}z`;

  for (const s of steps) {
    const d = devices[Number(s["d"])]!;
    const noteId = NOTES[Number(s["note"] ?? 0)]!;
    switch (s["t"]) {
      case "field": {
        const value = token();
        if (setField(d, noteId, FIELDS[Number(s["field"])]!, value))
          written.push({ device: d, noteId, token: value });
        break;
      }
      case "line": {
        const value = token();
        if (addLine(d, noteId, value)) written.push({ device: d, noteId, token: value });
        break;
      }
      case "delete":
        if (d.client.working(noteId) !== undefined) d.client.delete(noteId);
        break;
      case "create": {
        const value = token();
        const id = `01M6CREATED${String(tokens).padStart(15, "0")}`;
        d.client.create(
          id,
          `made/${value}.md`,
          `---\nid: ${id}\ntype: Note\ntitle: ${value}\n---\n`,
          "normal",
        );
        written.push({ device: d, noteId: id, token: value });
        break;
      }
      case "up":
        world.up(d, Number(s["pick"]));
        break;
      case "down":
        world.down(d, Number(s["pick"]));
        break;
      case "drop":
        world.disconnect(d);
        break;
      case "connect":
        if (!d.link.connected) world.connect(d);
        break;
    }
  }
  world.settle();
  return { world, devices, written };
}

describe("three devices, random edits, disconnects and offline periods", () => {
  it("always converge with nothing lost", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 30, maxLength: 200 }), (steps) => {
        const { world, devices, written } = run(steps);
        const live = world.live();
        for (const d of devices) {
          expect(d.client.state.pending, d.name).toEqual([]);
          const remote = new Map(
            [...d.client.state.remote].map(([id, note]) => [id, { rev: note.rev, raw: note.raw }]),
          );
          expect(remote, d.name).toEqual(live);
        }
        for (const w of written) {
          const blocked = w.device.client.state.blocked.get(w.noteId);
          const inBlocked =
            blocked !== undefined && "raw" in blocked.change && blocked.change.raw.includes(w.token);
          expect(world.kept(w.noteId, w.token) || inBlocked, `${w.device.name} wrote ${w.token}`).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
