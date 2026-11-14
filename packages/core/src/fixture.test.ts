import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import { describe, expect, it } from "vite-plus/test";

import { parseNote, splitNote } from "./note.ts";
import { patch, type Path, type YamlValue } from "./patch.ts";
import { resolveRelation } from "./paths.ts";
import { parseManifest, validate } from "./schema.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/nadia");
const notes = readdirSync(ROOT, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".md"))
  .map((file) => ({ path: relative(ROOT, join(ROOT, file)), raw: readFileSync(join(ROOT, file), "utf8") }));
const manifest = parseManifest(readFileSync(join(ROOT, "okf-base.yaml"), "utf8"));

/** Every scalar's path and value, from the source. */
function leaves(yaml: string): [Path, YamlValue][] {
  const out: [Path, YamlValue][] = [];
  const doc = parseDocument(yaml);
  const walk = (node: unknown, path: Path) => {
    if (isMap(node)) {
      for (const p of node.items)
        if (isPair(p) && isScalar(p.key)) walk(p.value, [...path, String(p.key.value)]);
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, [...path, i]));
    } else if (isScalar(node)) {
      out.push([path, node.toJS(doc)]);
    }
  };
  walk(doc.contents, []);
  return out;
}

describe("the fixture record", () => {
  it("has notes to test", () => expect(notes.length).toBeGreaterThanOrEqual(8));

  it.each(notes)("$path round-trips byte for byte", ({ raw }) => {
    expect(patch(raw, [])).toBe(raw);
    // Writing every value back as it is leaves the file untouched, comments and quoting included.
    for (const [path, value] of leaves(splitNote(raw).yaml)) {
      expect(patch(raw, [{ op: "set", path, value }]), JSON.stringify(path)).toBe(raw);
    }
  });

  it.each(notes)("$path is valid against okf-base.yaml", ({ raw }) => {
    expect(validate(manifest, parseNote(raw).data)).toEqual([]);
  });

  it.each(notes)("$path relations point at notes in the record", ({ path, raw }) => {
    const data = parseNote(raw).data;
    const sources = Array.isArray(data["sources"]) ? data["sources"] : [];
    const proves = Array.isArray(data["proves"]) ? data["proves"] : [];
    const relations = [
      ...(typeof data["supersedes"] === "string" ? [data["supersedes"]] : []),
      ...sources.map((source: unknown) => Reflect.get(Object(source), "resource")),
      ...proves,
    ].filter((relation): relation is string => typeof relation === "string");
    const paths = new Set(notes.map((note) => note.path));
    for (const relation of relations) expect(paths, relation).toContain(resolveRelation(path, relation));
  });
});
