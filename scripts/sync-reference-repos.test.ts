import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { isCheckedOut, refFor } from "./sync-reference-repos.ts";

const repo = { id: "effect", url: "u", ref: "main", versionOf: "effect", tag: (v: string) => `effect@${v}` };

describe("refFor", () => {
  it("clones the tag of the pinned version", () => {
    expect(refFor(repo, { effect: "4.1.4" })).toBe("effect@4.1.4");
  });

  it("falls back to the default ref for ranges, workspace specs or missing deps", () => {
    expect(refFor(repo, { effect: "catalog:" })).toBe("main");
    expect(refFor(repo, {})).toBe("main");
    expect(refFor({ id: "t3code", url: "u", ref: "main" }, { effect: "4.1.4" })).toBe("main");
  });
});

describe("isCheckedOut", () => {
  it("treats a folder without git metadata as missing, so a half-finished clone is retried", () => {
    const dir = mkdtempSync(join(tmpdir(), "repos-"));
    expect(isCheckedOut(dir)).toBe(false);
    mkdirSync(join(dir, ".git"));
    expect(isCheckedOut(dir)).toBe(true);
  });
});
