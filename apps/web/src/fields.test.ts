// The form's change -> raw -> put path, on the fixture student's notes: an edit sends the note with only its field's
// YAML node changed, byte for byte, and input the schema refuses sends nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest, parseNote, type ClientMessage, type Manifest } from "@brainiac/core";
import { emptyState, SyncClient, type Store, type Write } from "@brainiac/sync";
import { describe, expect, it } from "vite-plus/test";

import {
  bodyOf,
  commitField as commit,
  editField,
  fieldsOf,
  withBody,
  type Field,
  type SaveOnline,
} from "./fields.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const manifest = parseManifest(fixture("okf-base.yaml"));
const IELTS = fixture("facts/tests/ielts-2026-11.md");
const ID = "01M6ADBH80DEGPEVAAVR2625V1";

/**
 * A tab's sync client holding `raw` as the record's version of the note, what it sends, what it writes to its
 * store (IndexedDB in a browser) after it started, and the online saves it makes.
 */
function tab(raw: string, cls: "normal" | "sensitive" = "normal") {
  const sent: ClientMessage[] = [];
  const writes: Write[] = [];
  const online: { noteId: string; raw: string }[] = [];
  const store: Store = { load: async () => undefined, write: async (write) => void writes.push(write) };
  const state = emptyState("tab");
  state.remote.set(ID, { rev: 3, path: "facts/tests/ielts-2026-11.md", raw, class: cls });
  state.cursor = 10;
  const client = new SyncClient(state, {
    send: (message) => sent.push(message),
    newClientId: () => "tab-2",
    schemaVersion: 0,
    appVersion: "test",
    store,
  });
  client.receive({ type: "welcome", clientId: "tab", highWater: 0, ackedUpTo: 0 });
  writes.length = 0; // only what the edit itself writes
  const save: SaveOnline = async (noteId, edit) => void online.push({ noteId, raw: edit(raw) });
  const commitField = (noteId: string, schema: Manifest | null, f: Field, input: string | boolean) =>
    commit(client, noteId, schema, f, input, save);
  return { client, sent, writes, online, commitField };
}

const field = (raw: string, name: string, schema: Manifest | null = manifest) => {
  const found = fieldsOf(parseNote(raw).data, schema).find((f) => f.name === name);
  if (!found) throw new Error(`no field ${name}`);
  return found;
};

describe("field form", () => {
  it("shows the type's schema fields, then the note's other keys", () => {
    const names = fieldsOf(parseNote(IELTS).data, manifest).map((f) => f.name);
    expect(names.slice(0, 4)).toEqual(["title", "test", "overall", "sections"]);
    expect(fieldsOf(parseNote(IELTS).data, manifest).find((f) => f.name === "test")?.spec.values).toEqual([
      "ielts-academic",
      "toefl-ibt",
      "gre",
    ]);
    // No manifest: the note's own keys, each with the kind its value has.
    const plain = fieldsOf(parseNote(IELTS).data, null);
    expect(plain.find((f) => f.name === "overall")?.spec).toEqual({ kind: "number" });
    expect(plain.find((f) => f.name === "date")?.spec).toEqual({ kind: "date" });
    expect(plain.find((f) => f.name === "sections")?.editable).toBe(false);
  });

  it("sends a put that changes only the edited field's node, every other byte as it was", async () => {
    const cases = [
      // A plain scalar with a comment after the next key's value.
      ["expires", "2028-12-01", "expires: 2028-11-02", "expires: 2028-12-01"],
      // A changed scalar is rewritten in place, quoted as patch writes it; the comment and padding after it stay.
      ["trf_number", "26GB009999KARN001A", '"26GB001234KARN001A"', "26GB009999KARN001A"],
      ["title", "IELTS Academic, Nov 2026", '"IELTS Academic, November 2026"', '"IELTS Academic, Nov 2026"'],
    ] as const;
    for (const [name, input, before, after] of cases) {
      const { client, sent, commitField } = tab(IELTS);
      expect(await commitField(ID, manifest, field(IELTS, name), input)).toBeUndefined();
      const expected = IELTS.replace(before, after);
      expect(expected).not.toBe(IELTS);
      expect(sent).toEqual([
        expect.objectContaining({
          type: "mutate",
          noteId: ID,
          baseRev: 3,
          change: { kind: "put", raw: expected, base: IELTS },
        }),
      ]);
      expect(client.working(ID)).toBe(expected);
    }
  });

  it("checks input against the schema as typed, and sends nothing it refuses", async () => {
    const { sent, commitField } = tab(IELTS);
    expect(await commitField(ID, manifest, field(IELTS, "overall"), "eight")).toMatch(/number/);
    expect(await commitField(ID, manifest, field(IELTS, "date"), "2026-13-45")).toMatch(/date/);
    expect(await commitField(ID, manifest, field(IELTS, "date"), "")).toMatch(/required/);
    // Without a manifest, the value's own kind still holds.
    expect(editField(IELTS, null, field(IELTS, "expires", null), "next year")).toHaveProperty("issue");
    expect(sent).toEqual([]);
    // Typing the value it already has changes nothing, so nothing goes out either.
    expect(await commitField(ID, manifest, field(IELTS, "overall"), "8")).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("clears an optional field by removing only its line", async () => {
    const { sent, commitField } = tab(IELTS);
    expect(await commitField(ID, manifest, field(IELTS, "expires"), "")).toBeUndefined();
    expect(sent[0]).toMatchObject({ change: { raw: IELTS.replace("expires: 2028-11-02\n", "") } });
  });

  it("never queues or stores a sensitive note's edit on the device: it saves online", async () => {
    const { client, sent, writes, online, commitField } = tab(IELTS, "sensitive");
    expect(await commitField(ID, manifest, field(IELTS, "trf_number"), "26GB009999KARN001A")).toBeUndefined();
    expect(online).toEqual([
      { noteId: ID, raw: IELTS.replace('"26GB001234KARN001A"', "26GB009999KARN001A") },
    ]);
    expect(sent).toEqual([]);
    expect(client.state.pending).toEqual([]);
    expect(client.state.blocked.size).toBe(0);
    // Nothing about the note reached the store: not its id, not either version of its text.
    const stored = JSON.stringify(writes);
    for (const secret of [ID, "26GB001234KARN001A", "26GB009999KARN001A"])
      expect(stored).not.toContain(secret);
  });

  it("queues a normal note's edit in the client, as the store keeps it until the record answers", async () => {
    const { writes, online, commitField } = tab(IELTS, "normal");
    expect(await commitField(ID, manifest, field(IELTS, "trf_number"), "26GB009999KARN001A")).toBeUndefined();
    expect(online).toEqual([]);
    expect(writes.at(-1)?.saved.pending).toEqual([
      expect.objectContaining({ noteId: ID, change: expect.objectContaining({ kind: "put" }) }),
    ]);
  });

  it("edits the body without touching a byte of the front-matter", () => {
    const body = bodyOf(IELTS);
    const edited = withBody(IELTS, `${body}\nAlso took the speaking test online.\n`);
    expect(edited.startsWith(IELTS.slice(0, IELTS.length - body.length))).toBe(true);
    expect(bodyOf(edited)).toBe(`${body}\nAlso took the speaking test online.\n`);
  });
});
