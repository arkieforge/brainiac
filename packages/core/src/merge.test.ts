import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { merge, merge3 } from "./merge.ts";

const note = (fm: string, body = "## Notes\n\nTook it in the city centre.\n") =>
  `---\nid: 01M6ADBH80DEGPEVAAVR2625V1\n${fm}---\n${body}`;

describe("merge (front-matter fields)", () => {
  const base = note("overall: 8.0   # as printed\nstatus: preparing\n");

  it("takes each side's change to a different field, keeping their bytes", () => {
    const mine = note("overall: 8.5   # as printed\nstatus: preparing\n");
    const theirs = note("overall: 8.0   # as printed\nstatus: submitted\n");
    expect(merge(base, mine, theirs)).toEqual({
      raw: note("overall: 8.5   # as printed\nstatus: submitted\n"),
      fields: [],
      body: false,
    });
  });

  it("keeps theirs and reports a field both changed differently", () => {
    const mine = note("overall: 8.5\nstatus: preparing\n");
    const theirs = note("overall: 9\nstatus: preparing\n");
    expect(merge(base, mine, theirs)).toEqual({ raw: theirs, fields: ["overall"], body: false });
  });

  it("merges the same change on both sides, and an added or removed field", () => {
    const mine = note("overall: 9\nexpires: 2028-11-02\n");
    const theirs = note("overall: 9\nstatus: preparing\n");
    const merged = merge(base, mine, theirs);
    expect(merged.fields).toEqual([]);
    expect(merged.raw).toBe(note("overall: 9\nexpires: 2028-11-02\n"));
  });

  it("returns the untouched side's text byte for byte", () => {
    const mine = note("overall:   8.50\nstatus: preparing\n");
    expect(merge(base, mine, base).raw).toBe(mine);
    expect(merge(base, base, mine).raw).toBe(mine);
  });

  it("merges body edits in separate places and conflicts on the same place", () => {
    const b = note("", "a\nb\nc\nd\ne\n");
    expect(merge(b, note("", "A\nb\nc\nd\ne\n"), note("", "a\nb\nc\nd\nE\n"))).toEqual({
      raw: note("", "A\nb\nc\nd\nE\n"),
      fields: [],
      body: false,
    });
    const theirs = note("", "a\nb\nC2\nd\ne\n");
    expect(merge(b, note("", "a\nb\nC1\nd\ne\n"), theirs)).toEqual({ raw: theirs, fields: [], body: true });
  });
});

const text = fc
  .array(fc.constantFrom("a\n", "b\n", "c\n", "d\n", "e\n"), { maxLength: 12 })
  .map((l) => l.join(""));

describe("merge3 (body)", () => {
  it("one side unchanged gives the other side", () => {
    fc.assert(
      fc.property(text, text, (o, a) => {
        expect(merge3(o, a, o)).toBe(a);
        expect(merge3(o, o, a)).toBe(a);
        expect(merge3(o, a, a)).toBe(a);
      }),
    );
  });

  // Each side rewrites lines on its own side of a line both keep: both edits always survive.
  it("edits on either side of an unchanged line both land", () => {
    const block = fc.array(fc.constantFrom("x\n", "y\n", "z\n"), { maxLength: 5 }).map((l) => l.join(""));
    fc.assert(
      fc.property(block, block, block, block, (head, tail, newHead, newTail) => {
        const o = `${head}=keep=\n${tail}`;
        expect(merge3(o, `${newHead}=keep=\n${tail}`, `${head}=keep=\n${newTail}`)).toBe(
          `${newHead}=keep=\n${newTail}`,
        );
      }),
    );
  });

  it("a region both rewrote differently is a conflict", () => {
    expect(merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n")).toBeUndefined();
    // Touching edits with no kept line between them conflict too.
    expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n")).toBeUndefined();
  });
});
