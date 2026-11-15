import { describe, expect, it } from "vite-plus/test";

import { parseNote } from "./note.ts";

describe("parseNote", () => {
  it("reads front-matter as YAML 1.2 whatever its %YAML line says, as other readers show it", () => {
    // `--- # x` isn't the closing fence, so the directive sits inside the front-matter.
    const note = "---\n%YAML 1.1\n--- # x\nscore: 010\nok: yes\n---\nbody\n";
    expect(parseNote(note).data).toEqual({ score: 10, ok: "yes" });
  });
});
