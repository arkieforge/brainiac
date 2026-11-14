import { describe, expect, it } from "vite-plus/test";

import { parseNote } from "./note.ts";
import { patch, PatchError } from "./patch.ts";

const note = `---
id: 01JD7QA1ZK8M3V5X6Y7Z8A9BCD   # sync id
type: TestScore
title: "IELTS Academic, November 2026"
overall: 8.0
sections: {listening: 8.5, reading: 8.0}
date: 2026-11-02
sources:
  - {id: trf, resource: ../../documents/ielts-trf-2026.md, page: 1}
verified:
  by: human
  fields: [overall]
tags:
- english
---
## Notes

Booked through the British Council.

## Prep

Two mock tests.
`;

describe("patch front-matter", () => {
  it("rewrites only the value of an existing scalar, keeping the trailing comment", () => {
    const out = patch(note, [{ op: "set", path: ["id"], value: "01JD7QA1ZK8M3V5X6Y7Z8A9BCE" }]);
    expect(out).toBe(note.replace("01JD7QA1ZK8M3V5X6Y7Z8A9BCD", "01JD7QA1ZK8M3V5X6Y7Z8A9BCE"));
  });

  it("leaves the raw text alone when the value is already there", () => {
    expect(patch(note, [{ op: "set", path: ["overall"], value: 8 }])).toBe(note);
    expect(patch(note, [{ op: "set", path: ["sections"], value: { listening: 8.5, reading: 8 } }])).toBe(
      note,
    );
  });

  it("quotes a string that would otherwise read as a number", () => {
    const out = patch(note, [{ op: "set", path: ["overall"], value: "8.0" }]);
    expect(out).toContain(`overall: "8.0"\n`);
    expect(parseNote(out).data["overall"]).toBe("8.0");
  });

  it("edits inside a flow mapping by rewriting just that mapping", () => {
    const out = patch(note, [{ op: "set", path: ["sections", "writing"], value: 7 }]);
    expect(out).toBe(
      note.replace("{listening: 8.5, reading: 8.0}", "{listening: 8.5, reading: 8, writing: 7}"),
    );
  });

  it("adds a key to a block mapping at its indentation", () => {
    const out = patch(note, [{ op: "set", path: ["verified", "at"], value: "2026-11-03" }]);
    expect(out).toBe(note.replace("  fields: [overall]\n", "  fields: [overall]\n  at: 2026-11-03\n"));
  });

  it("adds a new top-level field, creating parents as flow mappings", () => {
    const out = patch(note, [{ op: "set", path: ["portal", "login"], value: "secret:portal.tum" }]);
    expect(out).toBe(note.replace("- english\n---", "- english\nportal: {login: secret:portal.tum}\n---"));
  });

  it("replaces a block collection with one flow line", () => {
    const out = patch(note, [{ op: "set", path: ["verified"], value: { by: "agent" } }]);
    expect(out).toBe(
      note.replace("verified:\n  by: human\n  fields: [overall]\n", "verified: {by: agent}\n"),
    );
  });

  it("removes a field's lines and keeps its neighbours", () => {
    const out = patch(note, [{ op: "unset", path: ["title"] }]);
    expect(out).toBe(note.replace(`title: "IELTS Academic, November 2026"\n`, ""));
    expect(patch(note, [{ op: "unset", path: ["nope"] }])).toBe(note);
  });

  it("empties a nested block mapping to {} instead of null", () => {
    const once = patch(note, [{ op: "unset", path: ["verified", "fields"] }]);
    expect(once).toBe(note.replace("  fields: [overall]\n", ""));
    const twice = patch(once, [{ op: "unset", path: ["verified", "by"] }]);
    expect(parseNote(twice).data["verified"]).toEqual({});
  });

  it("appends to block and flow lists", () => {
    expect(patch(note, [{ op: "append", path: ["tags"], value: "tum" }])).toBe(
      note.replace("- english\n", "- english\n- tum\n"),
    );
    expect(patch(note, [{ op: "append", path: ["verified", "fields"], value: "sections" }])).toBe(
      note.replace("[overall]", "[overall, sections]"),
    );
    const out = patch(note, [{ op: "append", path: ["sources"], value: { id: "web", page: 2 } }]);
    expect(out).toBe(note.replace("page: 1}\n", "page: 1}\n  - {id: web, page: 2}\n"));
  });

  it("creates a list when appending to a missing or empty field", () => {
    const out = patch(note, [{ op: "append", path: ["aliases"], value: "IELTS 2026" }]);
    expect(parseNote(out).data["aliases"]).toEqual(["IELTS 2026"]);
    const empty = patch("---\nid: x\nlist:\n---\n", [{ op: "append", path: ["list"], value: 1 }]);
    expect(empty).toBe("---\nid: x\nlist: [1]\n---\n");
  });

  it("edits a list item by index", () => {
    const out = patch(note, [{ op: "set", path: ["sources", 0, "page"], value: 2 }]);
    expect(out).toBe(note.replace("page: 1}", "page: 2}"));
    expect(patch(note, [{ op: "unset", path: ["tags", 0] }])).toContain("tags: []\n");
  });

  it("writes text with newlines as one quoted line", () => {
    const out = patch(note, [{ op: "set", path: ["title"], value: "line one\nline two" }]);
    expect(out).toContain(`title: "line one\\nline two"\n`);
    expect(parseNote(out).data["title"]).toBe("line one\nline two");
  });

  it("adds front-matter to a note without any", () => {
    expect(patch("# Hi\n", [{ op: "set", path: ["type"], value: "Fact" }])).toBe(
      "---\ntype: Fact\n---\n# Hi\n",
    );
  });

  it("refuses paths through scalars and new list indexes", () => {
    expect(() => patch(note, [{ op: "set", path: ["type", "x"], value: 1 }])).toThrow(PatchError);
    expect(() => patch(note, [{ op: "set", path: ["tags", 5], value: 1 }])).toThrow(PatchError);
    expect(() => patch(note, [{ op: "append", path: ["type"], value: 1 }])).toThrow(PatchError);
  });
});

describe("patch sections", () => {
  it("replaces one section and keeps the rest of the body", () => {
    const out = patch(note, [{ op: "section", heading: "Notes", content: "Booked again." }]);
    expect(out).toBe(note.replace("\nBooked through the British Council.\n\n", "\nBooked again.\n\n"));
  });

  it("replaces the last section up to the end of the body", () => {
    const out = patch(note, [{ op: "section", heading: "Prep", content: "Three mock tests.\n" }]);
    expect(out).toBe(note.replace("\nTwo mock tests.\n", "\nThree mock tests.\n"));
  });

  it("adds a missing section at the end", () => {
    const out = patch(note, [{ op: "section", heading: "Result", content: "Passed." }]);
    expect(out).toBe(`${note}\n## Result\n\nPassed.\n`);
  });

  it("treats subsections as part of their parent section", () => {
    const body = "# Trip\n\nintro\n\n## Day 1\n\nwalk\n\n# Next\n";
    expect(patch(body, [{ op: "section", heading: "Trip", content: "short" }])).toBe(
      "# Trip\n\nshort\n\n# Next\n",
    );
  });

  it("ignores headings inside code fences", () => {
    const body = "---\nid: x\n---\n## Code\n\n```sh\n# Prep\n```\n\n## Prep\n\nold\n";
    const out = patch(body, [{ op: "section", heading: "Prep", content: "new" }]);
    expect(out).toBe(body.replace("\nold\n", "\nnew\n"));
  });
});
