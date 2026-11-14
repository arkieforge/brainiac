import { describe, expect, it } from "vite-plus/test";

import { ManifestError, parseManifest, validate } from "./schema.ts";

const manifest = parseManifest(`
schema_version: 1
types:
  TestScore:
    version: 1
    fields:
      test: {values: [ielts-academic, toefl-ibt], required: true}
      overall: {kind: number, required: true, example: 8.0}
      date: {kind: date, required: true}
      supersedes: {kind: relation}
  Fact:
    version: 1
    fields: {}
`);

const valid = {
  id: "01M6ADBH80DEGPEVAAVR2625V1",
  type: "TestScore",
  test: "ielts-academic",
  overall: 8,
  date: "2026-11-02",
};

describe("validate", () => {
  it("accepts a note that matches its type", () => {
    expect(validate(manifest, valid)).toEqual([]);
  });

  it("names the field, the allowed values and an example", () => {
    expect(validate(manifest, { ...valid, test: "ielts" })).toEqual([
      {
        field: "test",
        message: 'test must be "ielts-academic" or "toefl-ibt" (was "ielts"). Example: test: ielts-academic',
      },
    ]);
    expect(validate(manifest, { ...valid, overall: "8.0" })).toEqual([
      { field: "overall", message: "overall must be a number (was a string). Example: overall: 8" },
    ]);
    const [date] = validate(manifest, { ...valid, date: "2026-02-30" });
    expect(date?.message).toBe(
      'date must be a date like 2026-11-02 (was "2026-02-30"). Example: date: 2026-11-02',
    );
  });

  it("reports missing required fields and a bad id or relation", () => {
    const { overall: _, ...withoutOverall } = valid;
    expect(validate(manifest, withoutOverall)).toEqual([
      { field: "overall", message: "overall is required. Example: overall: 8" },
    ]);
    const issues = validate(manifest, { ...valid, id: "note-1", supersedes: "/etc/passwd" });
    expect(issues.map((issue) => issue.field)).toEqual(["id", "supersedes"]);
  });

  it("treats object built-ins as unknown types instead of crashing", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      expect(validate(manifest, { ...valid, type }).map((issue) => issue.field)).toEqual(["type"]);
    }
  });

  it("lists the declared types when the type is unknown", () => {
    expect(validate(manifest, { ...valid, type: "Trip" })).toEqual([
      { field: "type", message: 'type must be "Fact" or "TestScore" (was "Trip"). Example: type: TestScore' },
    ]);
  });
});

describe("parseManifest", () => {
  it("names the setting that is wrong", () => {
    expect(() =>
      parseManifest("schema_version: 1\ntypes: {A: {version: 1, fields: {x: {kind: str}}}}"),
    ).toThrow(ManifestError);
    expect(() =>
      parseManifest("schema_version: 1\ntypes: {A: {version: 1, fields: {x: {kind: str}}}}"),
    ).toThrow(/types\.A\.fields\.x\.kind/);
  });
});
