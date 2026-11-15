// Answering a question on the site, on the fixture student's notes: a normal note's answer is a queued edit like
// any other, a sensitive note's goes online only and never enters this device's queue, and input the schema
// refuses sends nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest, parseNote, patch, type ClientMessage } from "@brainiac/core";
import { emptyState, SyncClient, type Store, type Write } from "@brainiac/sync";
import { describe, expect, it } from "vite-plus/test";

import type { SaveOnline } from "./fields.ts";
import { answer, questionsOf } from "./questions.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const manifest = parseManifest(readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"));
const ROLE = patch(readFileSync(join(FIXTURES, "facts/roles/acme-intern-2025.md"), "utf8"), [
  { op: "unset", path: ["end"] },
]);
const ID = "01M6AGSCW0VCVQ4638KZVD05RK";
const NOW = Date.UTC(2026, 10, 15);

/** A tab holding the role, missing its end date, as the record's version; what it queues, writes and saves online. */
function tab(cls: "normal" | "sensitive") {
  const sent: ClientMessage[] = [];
  const writes: Write[] = [];
  const online: string[] = [];
  const store: Store = { load: async () => undefined, write: async (write) => void writes.push(write) };
  const state = emptyState("tab");
  state.remote.set(ID, { rev: 2, path: "facts/roles/acme-intern-2025.md", raw: ROLE, class: cls });
  state.cursor = 4;
  const client = new SyncClient(state, {
    send: (message) => sent.push(message),
    newClientId: () => "tab-2",
    schemaVersion: 0,
    appVersion: "test",
    store,
  });
  client.receive({ type: "welcome", clientId: "tab", highWater: 0, ackedUpTo: 0 });
  writes.length = 0;
  const save: SaveOnline = async (_noteId, edit) => {
    const raw = edit(ROLE);
    online.push(raw);
    return { rev: 3, raw };
  };
  const [question] = questionsOf(client, manifest, NOW);
  if (!question) throw new Error("the role should ask for its end date");
  return { client, sent, writes, online, save, question };
}

describe("answering", () => {
  it("a normal note's answer is a queued edit, and the question is gone from the tab at once", async () => {
    const { client, sent, online, save, question } = tab("normal");
    expect(question.text).toBe("When did your role at Acme Robotics end?");
    expect(await answer(client, manifest, question, { value: "2025-09-30" }, save)).toBeUndefined();
    expect(online).toEqual([]);
    expect(sent.map((m) => m.type)).toEqual(["mutate"]);
    expect(parseNote(client.working(ID) ?? "").data["end"]).toBe("2025-09-30");
    expect(questionsOf(client, manifest, NOW)).toEqual([]);
  });

  it("a sensitive note's answer goes online only: nothing queued, nothing written to this device", async () => {
    const { client, sent, writes, online, save, question } = tab("sensitive");
    expect(question.sensitive).toBe(true);
    expect(await answer(client, manifest, question, { ongoing: true }, save)).toBeUndefined();
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
    expect(parseNote(online[0] ?? "").data["current"]).toBe(true);
  });

  it("input the schema refuses sends nothing and says why", async () => {
    const { client, sent, save, question } = tab("normal");
    expect(await answer(client, manifest, question, { value: "last autumn" }, save)).toMatch(/end must be/);
    expect(sent).toEqual([]);
  });
});
