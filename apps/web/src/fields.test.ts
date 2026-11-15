// The form's change -> raw -> put path, on the fixture student's notes: an edit sends the note with only its field's
// YAML node changed, byte for byte, and input the schema refuses sends nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest, parseNote, type ClientMessage, type Manifest } from "@brainiac/core";
import { emptyState, SyncClient } from "@brainiac/sync";
import { describe, expect, it } from "vite-plus/test";

import { bodyOf, commitField, editField, fieldsOf, withBody } from "./fields.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures/nadia");
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8");
const manifest = parseManifest(fixture("okf-base.yaml"));
const IELTS = fixture("facts/tests/ielts-2026-11.md");
const ID = "01M6ADBH80DEGPEVAAVR2625V1";

/** A tab's sync client holding `raw` as the record's version of the note, and what it sends. */
function tab(raw: string) {
  const sent: ClientMessage[] = [];
  const state = emptyState("tab");
  state.remote.set(ID, { rev: 3, path: "facts/tests/ielts-2026-11.md", raw, class: "sensitive" });
  state.cursor = 10;
  const client = new SyncClient(state, {
    send: (message) => sent.push(message),
    newClientId: () => "tab-2",
    schemaVersion: 0,
    appVersion: "test",
  });
  client.receive({ type: "welcome", clientId: "tab", highWater: 0, ackedUpTo: 0 });
  return { client, sent };
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

  it("sends a put that changes only the edited field's node, every other byte as it was", () => {
    const cases = [
      // A plain scalar with a comment after the next key's value.
      ["expires", "2028-12-01", "expires: 2028-11-02", "expires: 2028-12-01"],
      // A changed scalar is rewritten in place, quoted as patch writes it; the comment and padding after it stay.
      ["trf_number", "26GB009999KARN001A", '"26GB001234KARN001A"', "26GB009999KARN001A"],
      ["title", "IELTS Academic, Nov 2026", '"IELTS Academic, November 2026"', '"IELTS Academic, Nov 2026"'],
    ] as const;
    for (const [name, input, before, after] of cases) {
      const { client, sent } = tab(IELTS);
      expect(commitField(client, ID, manifest, field(IELTS, name), input)).toBeUndefined();
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

  it("checks input against the schema as typed, and sends nothing it refuses", () => {
    const { client, sent } = tab(IELTS);
    expect(commitField(client, ID, manifest, field(IELTS, "overall"), "eight")).toMatch(/number/);
    expect(commitField(client, ID, manifest, field(IELTS, "date"), "2026-13-45")).toMatch(/date/);
    expect(commitField(client, ID, manifest, field(IELTS, "date"), "")).toMatch(/required/);
    // Without a manifest, the value's own kind still holds.
    expect(editField(IELTS, null, field(IELTS, "expires", null), "next year")).toHaveProperty("issue");
    expect(sent).toEqual([]);
    // Typing the value it already has changes nothing, so nothing goes out either.
    expect(commitField(client, ID, manifest, field(IELTS, "overall"), "8")).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("clears an optional field by removing only its line", () => {
    const { client, sent } = tab(IELTS);
    expect(commitField(client, ID, manifest, field(IELTS, "expires"), "")).toBeUndefined();
    expect(sent[0]).toMatchObject({ change: { raw: IELTS.replace("expires: 2028-11-02\n", "") } });
  });

  it("edits the body without touching a byte of the front-matter", () => {
    const body = bodyOf(IELTS);
    const edited = withBody(IELTS, `${body}\nAlso took the speaking test online.\n`);
    expect(edited.startsWith(IELTS.slice(0, IELTS.length - body.length))).toBe(true);
    expect(bodyOf(edited)).toBe(`${body}\nAlso took the speaking test online.\n`);
  });
});
