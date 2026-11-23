// The fixture student's notes in a tab's sync client, for browser tests (fixtures/README.md). The files are read
// through Vite's `?raw`, since a browser test has no file system.
import { parseManifest } from "@brainiac/core";
import { emptyState, SyncClient } from "@brainiac/sync";

import manifestYaml from "../../../fixtures/nadia/okf-base.yaml?raw";
import march from "../../../fixtures/nadia/facts/tests/ielts-2025-03.md?raw";
import november from "../../../fixtures/nadia/facts/tests/ielts-2026-11.md?raw";

export const manifest = parseManifest(manifestYaml);
export const IELTS_2025 = {
  id: "01M6A9XNM0AR4BM0ESE4KX8KVB",
  path: "facts/tests/ielts-2025-03.md",
  raw: march,
};
export const IELTS_2026 = {
  id: "01M6ADBH80DEGPEVAAVR2625V1",
  path: "facts/tests/ielts-2026-11.md",
  raw: november,
};

type Note = typeof IELTS_2025;

/** A live tab holding `notes` at rev 3 as the record's versions, and a way to deliver another tab's change. */
export function tab(...notes: readonly Note[]) {
  const state = emptyState("tab");
  for (const note of notes)
    state.remote.set(note.id, { rev: 3, path: note.path, raw: note.raw, class: "normal" });
  state.cursor = 10;
  const client = new SyncClient(state, {
    send: () => {},
    newClientId: () => "tab-2",
    schemaVersion: 0,
    appVersion: "test",
  });
  client.receive({ type: "welcome", clientId: "tab", highWater: 0, ackedUpTo: 0 });
  /** Another tab's edit of `note`, arriving as the record's push. */
  const push = (note: Note, raw: string) =>
    client.receive({
      type: "changes",
      from: 10,
      to: 11,
      items: [{ noteId: note.id, seq: 11, deleted: false, rev: 4, path: note.path, raw, class: "normal" }],
    });
  return { client, push };
}
