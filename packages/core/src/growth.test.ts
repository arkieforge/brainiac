import { describe, expect, it } from "vite-plus/test";

import { areaClass, CATALOG, mergeType, newTypeIssues, type TypeDraft } from "./growth.ts";
import { parseManifest, setType } from "./schema.ts";

const base: TypeDraft = { folder: "history/travel", fields: { country: { kind: "text" } } };

describe("mergeType", () => {
  it("takes what only one side changed, from both sides", () => {
    const mine = { ...base, fields: { ...base.fields, visa: { kind: "text" as const } } };
    const theirs = {
      ...base,
      headline: "{country}",
      fields: { ...base.fields, city: { kind: "text" as const } },
    };
    expect(mergeType(base, mine, theirs)).toEqual({
      merged: {
        folder: "history/travel",
        headline: "{country}",
        fields: { country: { kind: "text" }, city: { kind: "text" }, visa: { kind: "text" } },
      },
    });
  });

  it("refuses the same field changed two ways, and never unions a field's values", () => {
    const values = (v: string[]) => ({ ...base, fields: { ...base.fields, purpose: { values: v } } });
    expect(mergeType(base, values(["study", "work"]), values(["study", "family"]))).toEqual({
      conflicts: ["fields.purpose"],
    });
    // Both sides adding the same thing is no conflict.
    expect(mergeType(undefined, values(["study"]), values(["study"]))).toEqual({ merged: values(["study"]) });
  });
});

describe("newTypeIssues", () => {
  it("lets a type in with 3 fields of its own, or its own dates and a status", () => {
    expect(
      newTypeIssues("MusicGrade", {
        folder: "facts/music",
        fields: {
          board: { kind: "text" },
          grade: { kind: "number" },
          date: { kind: "date" },
          tags: { kind: "list" },
        },
      }),
    ).toEqual([]);
    expect(
      newTypeIssues("Residency", {
        folder: "history/residencies",
        fields: { start: { kind: "date" }, status: {} },
      }),
    ).toEqual([]);
    // Shared fields like title and tags don't earn a type.
    expect(
      newTypeIssues("MusicGrade", { folder: "facts/music", fields: { title: {}, tags: {}, grade: {} } })[0],
    ).toMatch(/1 field of its own.*Fact with tags/);
  });
});

describe("areaClass", () => {
  it("is the area's class, compared as the record compares paths", () => {
    expect(areaClass("History/Travel/jp.md")).toBe("sensitive");
    expect(areaClass("facts/tests/ielts.md")).toBe("sensitive");
    expect(areaClass("facts/roles/acme.md")).toBe("normal");
    expect(areaClass("historyx/a.md")).toBe("normal");
  });
});

describe("CATALOG", () => {
  it("holds types a manifest can hold, each named as its id says", () => {
    for (const [id, { name, ...draft }] of Object.entries(CATALOG)) {
      const yaml = setType("", name, { ...draft, version: 1, catalog: id });
      expect(parseManifest(yaml).types[name]?.catalog).toBe(id);
      expect(newTypeIssues(name, draft).every((issue) => issue.includes("catalog"))).toBe(true);
    }
  });
});

describe("setType", () => {
  it("rewrites only the type it sets, keeping the person's comments", () => {
    const yaml = "# my types\nschema_version: 1\ntypes:\n  Role: # jobs\n    version: 1\n    fields: {}\n";
    const next = setType(yaml, "Trip", { version: 1, fields: { country: { kind: "text" } } });
    expect(next).toContain("# my types");
    expect(next).toContain("# jobs");
    expect(Object.keys(parseManifest(next).types)).toEqual(["Role", "Trip"]);
    expect(parseManifest(setType(next, "Trip", undefined)).types).toEqual(parseManifest(yaml).types);
  });
});
