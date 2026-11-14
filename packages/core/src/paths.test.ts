import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { isUlid, ulid } from "./ids.ts";
import { findClash, normalizePath, PathError, relationTo, resolveRelation } from "./paths.ts";

describe("paths", () => {
  it("treats NFC and NFD spellings and case differences as one name", () => {
    const nfd = "documents/Résumé.md";
    expect(normalizePath(nfd)).toBe("documents/Résumé.md");
    expect(findClash(["documents/Résumé.md"], nfd)).toBe("documents/Résumé.md");
    expect(findClash(["documents/CV.md"], "documents/cv.md")).toBe("documents/CV.md");
    expect(findClash(["documents/cv.md"], "documents/cv-2.md")).toBeUndefined();
  });

  it("refuses paths that could leave the record", () => {
    for (const bad of ["/etc/passwd", "../x.md", "a/../../x.md", "a//b.md", "a\\b.md", "./a.md"]) {
      expect(() => normalizePath(bad), bad).toThrow(PathError);
    }
    expect(() => resolveRelation("facts/tests/a.md", "../../../x.md")).toThrow(PathError);
  });

  it("resolves relations relative to the note", () => {
    expect(resolveRelation("facts/tests/ielts-2026-11.md", "ielts-2025-03.md")).toBe(
      "facts/tests/ielts-2025-03.md",
    );
    expect(resolveRelation("facts/tests/ielts-2026-11.md", "../../documents/trf.md")).toBe(
      "documents/trf.md",
    );
  });

  it("writes the relation that resolves back to the target", () => {
    const segment = fc.stringMatching(/^[a-z0-9-]{1,6}$/);
    const path = fc
      .array(segment, { minLength: 0, maxLength: 3 })
      .chain((dirs) => segment.map((name) => [...dirs, `${name}.md`].join("/")));
    fc.assert(
      fc.property(path, path, (from, to) => {
        expect(resolveRelation(from, relationTo(from, to))).toBe(to);
      }),
    );
  });
});

describe("ulid", () => {
  it("matches the spec's time encoding and sorts by time", () => {
    expect(ulid(1469918176385, new Uint8Array(16)).slice(0, 10)).toBe("01ARYZ6S41");
    const [a, b] = [ulid(1_000), ulid(2_000)];
    expect(isUlid(a) && isUlid(b) && a < b).toBe(true);
    expect(isUlid("01M6ADBH80DEGPEVAAVR2625VI")).toBe(false); // I is not in the alphabet
  });
});
