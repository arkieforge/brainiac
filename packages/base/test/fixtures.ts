import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Fixture } from "./cases.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/nadia");

/** The fictional student's notes and manifest, by bundle-relative path. Read here: workerd has no filesystem. */
export const fixtures: Fixture[] = readdirSync(ROOT, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".md") || file === "okf-base.yaml")
  .toSorted()
  .map((path) => ({ path, raw: readFileSync(join(ROOT, path), "utf8") }));
