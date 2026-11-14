// The client conformance suite: every case runs with the browser's store (IndexedDB, under happy-dom) and
// the laptop's (state.db, in Bun), so a tab and the daemon keep the same promises (stores.test.ts).
// Cases throw on failure, with node:assert, which both runtimes provide.
import { deepStrictEqual as same, equal, ok, rejects } from "node:assert/strict";

import { SyncClient, type Store } from "../src/index.ts";
import { addLine, setField, World, type Device } from "./sim.ts";

/** Opens the storage called `name`; the same name opens the same storage again, as after a restart. */
export type Open = (name: string) => Store;
export type Case = (open: Open) => Promise<void>;
export type CaseResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const A = "01M6AAAAAAAAAAAAAAAAAAAAA1";
const B = "01M6AAAAAAAAAAAAAAAAAAAAA2";

function start(open: Open) {
  const world = new World();
  world.seed(A, "notes/a.md");
  world.seed(B, "notes/b.md");
  const laptop = world.device("laptop", undefined, open("laptop"));
  const phone = world.device("phone");
  world.settle();
  return { world, laptop, phone };
}

/** Nothing waits on the device, and its remote layer is the record's live notes. */
function synced(world: World, device: Device): void {
  same(device.client.state.pending, []);
  same(
    new Map([...device.client.state.remote].map(([id, n]) => [id, { rev: n.rev, raw: n.raw }])),
    world.live(),
  );
}

/** How often `line` is in the note's text: once means applied once, however often it was sent. */
const times = (world: World, noteId: string, line: string) =>
  world
    .note(noteId)
    ?.raw.split("\n")
    .filter((l) => l === line).length ?? 0;

export const cases: Record<string, Case> = {
  async "an edit made offline survives a restart and lands once"(open) {
    const { world, laptop } = start(open);
    world.disconnect(laptop);
    ok(addLine(laptop, A, "offline"));
    const again = await world.restart(laptop, open("laptop"));
    ok(again.client.working(A)?.includes("offline\n"));
    world.settle();
    equal(times(world, A, "offline"), 1);
    synced(world, again);
  },

  async "an app closed before its answer arrives: the edit lands once"(open) {
    const { world, laptop } = start(open);
    ok(addLine(laptop, A, "sent"));
    ok(world.up(laptop)); // applied by the record; the answer never reaches this run of the app
    const again = await world.restart(laptop, open("laptop"));
    world.settle();
    equal(times(world, A, "sent"), 1);
    equal(world.note(A)?.rev, 2);
    synced(world, again);
  },

  async "a flapping network and restarts lose no edit and apply none twice"(open) {
    const { world, laptop, phone } = start(open);
    let device = laptop;
    const lines: string[] = [];
    for (let i = 0; i < 24; i++) {
      const line = `flap ${i}`;
      ok(addLine(device, i % 3 ? A : B, line));
      lines.push(line);
      if (i % 4 === 0) ok(setField(phone, A, "status", `s${i}`));
      if (i % 2 === 0) world.connect(device);
      for (let n = 0; n < i % 3; n++) world.up(device);
      if (i % 3 === 1) world.down(device);
      for (let n = 0; n < 2; n++) if (!world.up(phone)) world.down(phone);
      world.disconnect(device);
      if (i % 5 === 4) device = await world.restart(device, open("laptop"));
    }
    world.settle();
    for (const [i, line] of lines.entries()) equal(times(world, i % 3 ? A : B, line), 1, line);
    synced(world, device);
    synced(world, phone);
  },

  async "pending edits show over a snapshot, merged as the record will merge them"(open) {
    const { world, laptop, phone } = start(open);
    world.disconnect(laptop);
    ok(setField(laptop, A, "status", "mine"));
    ok(setField(phone, A, "title", "theirs"));
    ok(addLine(phone, A, "their line"));
    while (world.up(phone) || world.down(phone)); // the laptop stays offline
    // A cursor ahead of the record (restored from a backup) gets a snapshot instead of the changes.
    laptop.client.state.cursor = 99;
    const seen: string[] = [];
    laptop.client.subscribe((ids) => seen.push(...ids));
    world.connect(laptop);
    ok(world.up(laptop)); // hello; the mutate it sends after welcome stays in flight
    while (world.down(laptop));
    const shown = laptop.client.working(A) ?? "";
    ok(
      shown.includes("status: mine") && shown.includes("title: theirs") && shown.includes("their line"),
      shown,
    );
    ok(seen.includes(A));
    const again = await world.restart(laptop, open("laptop"));
    equal(again.client.working(A), shown);
    world.settle();
    equal(world.note(A)?.raw, shown);
    synced(world, again);
  },

  async "the remote layer survives a restart, so catching up sends only what changed"(open) {
    const { world, laptop, phone } = start(open);
    ok(setField(phone, B, "status", "moved"));
    world.settle();
    const again = await world.restart(laptop, open("laptop"));
    world.connect(again);
    ok(world.up(again));
    same(
      again.link.down.map((m) => m.type),
      ["welcome", "changes"],
    );
    world.settle();
    synced(world, again);
  },

  async "a refused edit stays blocked across a restart until dismissed"(open) {
    const { world, laptop } = start(open);
    laptop.client.edit(A, "---\nid: [\n---\nhalf saved\n");
    world.settle();
    let again = await world.restart(laptop, open("laptop"));
    ok(again.client.state.blocked.get(A)?.[0]?.reason.match(/front-matter/i), "blocked with its reason");
    again.client.dismiss(A);
    again = await world.restart(again, open("laptop"));
    equal(again.client.state.blocked.size, 0);
    world.settle();
    synced(world, again);
  },

  async "after a failed write, the next one rewrites the whole remote layer"(open) {
    const world = new World();
    world.seed(A, "notes/a.md");
    const real = open("laptop");
    let fail = true;
    const flaky: Store = {
      load: () => real.load(),
      write: (write) => {
        if (!fail) return real.write(write);
        fail = false;
        return Promise.reject(new Error("disk full"));
      },
    };
    const laptop = world.device("laptop", undefined, flaky);
    world.settle(); // the snapshot's write fails
    await rejects(laptop.client.saved(), /disk full/);
    world.seed(B, "notes/b.md");
    const phone = world.device("phone");
    world.settle();
    ok(setField(phone, B, "status", "pushed"));
    world.settle(); // one changed note, written with every other
    await laptop.client.saved();
    synced(world, await world.restart(laptop, open("laptop")));
  },

  async "sensitive notes stay out of the store unless the device keeps them"(open) {
    const world = new World();
    world.seed(A, "notes/a.md");
    world.seed(B, "grades/b.md", "## Grades\n\nGPA 3.9\n", "sensitive");
    const laptop = world.device("laptop", undefined, open("laptop"));
    world.settle();
    await laptop.client.saved();
    const stored = await open("laptop").load();
    same([...(stored?.remote.keys() ?? [])], [A]);
    equal(stored?.cursor, null, "a restart takes a snapshot to get them back");
    const again = await world.restart(laptop, open("laptop"));
    world.settle();
    synced(world, again);

    // A device the person marked as theirs, with "keep sensitive notes on this device" on.
    const own = await SyncClient.open({
      send: () => {},
      newClientId: () => "own",
      schemaVersion: 1,
      appVersion: "test",
      store: open("own"),
      keepSensitive: true,
    });
    own.connect();
    own.receive({
      type: "snapshot",
      seq: 2,
      attempt: 1,
      notes: [
        { noteId: B, seq: 2, deleted: false, rev: 1, path: "grades/b.md", raw: "kept", class: "sensitive" },
      ],
    });
    await own.saved();
    const kept = await open("own").load();
    equal(kept?.remote.get(B)?.raw, "kept");
    equal(kept?.cursor, 2);
  },
};

/** Runs one case, catching its failure as data, for runners that report across a process boundary. */
export async function runCase(name: string, open: Open): Promise<CaseResult> {
  try {
    await cases[name]!(open);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
}
