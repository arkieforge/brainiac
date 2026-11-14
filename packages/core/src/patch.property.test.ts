import fc from "fast-check";
import { isMap, isNode, isPair, isScalar, isSeq, parseDocument } from "yaml";
import { describe, expect, it } from "vite-plus/test";

import { parseNote, splitNote } from "./note.ts";
import { patch, type Path, type PatchOp, type YamlValue } from "./patch.ts";

// Front-matter written the many ways people and tools write it: comments, both quote styles, flow and block
// collections, zero-indent lists, empty values.
const word = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/).filter((w) => !["true", "false", "null"].includes(w));
const scalarSource = fc.oneof(
  fc.integer({ min: -999, max: 9999 }).map(String),
  fc.constantFrom("8.0", "1.5", "true", "false", "2026-11-02", "~"),
  word,
  fc.string({ maxLength: 10 }).map((s) => JSON.stringify(s)),
  fc.stringMatching(/^[a-z ]{0,8}$/).map((s) => `'${s}'`),
);
const comment = fc.option(fc.constantFrom("  # checked", " # from the TRF", "   #x"), { nil: "" });

const entrySource = (key: string) =>
  fc.oneof(
    fc.tuple(scalarSource, comment).map(([value, note]) => `${key}: ${value}${note}\n`),
    fc.constant(`${key}:\n`),
    fc
      .uniqueArray(word, { minLength: 1, maxLength: 3 })
      .chain((keys) =>
        fc.tuple(
          fc.constant(keys),
          fc.array(scalarSource, { minLength: keys.length, maxLength: keys.length }),
        ),
      )
      .map(([keys, values]) => `${key}: {${keys.map((k, i) => `${k}: ${values[i]}`).join(", ")}}\n`),
    fc.array(scalarSource, { maxLength: 3 }).map((values) => `${key}: [${values.join(", ")}]\n`),
    fc
      .uniqueArray(word, { minLength: 1, maxLength: 3 })
      .chain((keys) =>
        fc.tuple(
          fc.constant(keys),
          fc.array(scalarSource, { minLength: keys.length, maxLength: keys.length }),
          comment,
        ),
      )
      .map(
        ([keys, values, note]) => `${key}:\n${keys.map((k, i) => `  ${k}: ${values[i]}${note}\n`).join("")}`,
      ),
    fc
      .tuple(fc.array(scalarSource, { minLength: 1, maxLength: 3 }), fc.constantFrom("", "  "))
      .map(([values, indent]) => `${key}:\n${values.map((v) => `${indent}- ${v}\n`).join("")}`),
    // Compact mappings as list items, like an Application's requirements.
    fc
      .array(fc.tuple(scalarSource, scalarSource), { minLength: 1, maxLength: 3 })
      .map((items) => `${key}:\n${items.map(([a, b]) => `  - need: ${a}\n    check: ${b}\n`).join("")}`),
  );

const decoration = fc.constantFrom("", "", "# a comment line\n", "\n");

interface Entry {
  readonly key: string;
  readonly decoration: string;
  readonly text: string;
}

const frontMatter = fc
  .uniqueArray(word, { minLength: 1, maxLength: 5 })
  .chain((keys) =>
    fc.tuple(
      ...keys.map((key) =>
        fc.tuple(decoration, entrySource(key)).map(([d, text]): Entry => ({ key, decoration: d, text })),
      ),
    ),
  );

const value: fc.Arbitrary<YamlValue> = fc.letrec<{ value: YamlValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
    fc.string({ maxLength: 12 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(word, tie("value"), { maxKeys: 3 }),
  ),
})).value;

interface Leaf {
  readonly path: Path;
  readonly source: string;
}

/** Every scalar in the YAML with its exact source text. */
function leaves(yaml: string): Leaf[] {
  const out: Leaf[] = [];
  const walk = (node: unknown, path: Path) => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isPair(pair) && isScalar(pair.key)) walk(pair.value, [...path, String(pair.key.value)]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => walk(item, [...path, index]));
    } else if (isNode(node) && node.range) {
      out.push({ path, source: yaml.slice(node.range[0], node.range[1]) });
    }
  };
  walk(parseDocument(yaml).contents, []);
  return out;
}

const startsWith = (path: Path, prefix: Path) => prefix.every((segment, i) => path[i] === segment);

/** The node an op may rewrite: the nearest flow collection around the target, or the target itself. */
function editedPath(yaml: string, op: Exclude<PatchOp, { op: "section" }>): Path {
  const doc = parseDocument(yaml);
  for (let i = 1; i <= op.path.length; i++) {
    const node = doc.getIn(op.path.slice(0, i), true);
    if ((isMap(node) || isSeq(node)) && node.flow) return op.path.slice(0, i);
  }
  const parent = op.path.length > 1 ? doc.getIn(op.path.slice(0, -1), true) : undefined;
  // Removing a list item renumbers the items after it, so the list is the node that changed.
  if (op.op === "unset" && typeof op.path.at(-1) === "number") return op.path.slice(0, -1);
  if (op.op === "unset" && (isMap(parent) || isSeq(parent)) && parent.items.length === 1)
    return op.path.slice(0, -1);
  return op.path;
}

const read = (data: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, segment) => (typeof node === "object" && node !== null ? Reflect.get(node, segment) : undefined),
    data,
  );

const noteFrom = (entries: readonly Entry[]) =>
  `---\n${entries.map((e) => e.decoration + e.text).join("")}---\n# Body\n`;

describe("patch (property)", () => {
  it("changes only the bytes of the edited node, and the edit reads back", () => {
    const cases = frontMatter.chain((entries) => {
      const yaml = splitNote(noteFrom(entries)).yaml;
      const paths = leaves(yaml).map((leaf) => leaf.path);
      const topKeys = Object.keys(parseNote(noteFrom(entries)).data);
      const target = fc.oneof(
        fc.constantFrom(...(paths.length > 0 ? paths : [[topKeys[0] ?? "a"]])),
        fc.constantFrom(...topKeys).map((key): Path => [key]),
        word.map((key): Path => [key]),
      );
      const op: fc.Arbitrary<Exclude<PatchOp, { op: "section" }>> = fc.oneof(
        fc.tuple(target, value).map(([path, v]) => ({ op: "set" as const, path, value: v })),
        target.map((path) => ({ op: "unset" as const, path })),
        fc
          .tuple(fc.constantFrom(...topKeys), value)
          .map(([key, v]) => ({ op: "append" as const, path: [key], value: v })),
      );
      return fc.tuple(fc.constant(entries), op);
    });

    fc.assert(
      fc.property(cases, ([entries, op]) => {
        const raw = noteFrom(entries);
        const before = parseNote(raw).data;
        let out: string;
        try {
          out = patch(raw, [op]);
        } catch (error) {
          // Refusals are fine (a path through a scalar, appending to a non-list); silent damage is not.
          expect(error).toHaveProperty("name", "PatchError");
          return;
        }
        const after = parseNote(out).data;
        const target = read(after, op.path);
        if (op.op === "set") expect(target).toEqual(op.value);
        const index = op.path.at(-1);
        if (op.op === "unset" && typeof index === "number") {
          const list = read(before, op.path.slice(0, -1));
          expect(read(after, op.path.slice(0, -1))).toEqual(
            Array.isArray(list) ? list.filter((_, i) => i !== index) : list,
          );
        } else if (op.op === "unset") {
          expect(target).toBeUndefined();
        }
        if (op.op === "append") expect(Array.isArray(target) ? target.at(-1) : target).toEqual(op.value);

        // Every other top-level entry is still there byte for byte, in order.
        const edited = editedPath(splitNote(raw).yaml, op);
        let from = 0;
        for (const entry of entries) {
          const kept = entry.key === String(edited[0]) ? entry.decoration : entry.decoration + entry.text;
          const at = out.indexOf(kept, from);
          expect(at, `kept: ${JSON.stringify(kept)}`).toBeGreaterThanOrEqual(from);
          from = at + kept.length;
        }

        // Every scalar outside the edited node keeps its exact source text.
        const kept = new Map(
          leaves(splitNote(out).yaml).map((leaf) => [JSON.stringify(leaf.path), leaf.source]),
        );
        for (const leaf of leaves(splitNote(raw).yaml)) {
          if (startsWith(leaf.path, edited) || startsWith(edited, leaf.path)) continue;
          expect(kept.get(JSON.stringify(leaf.path)), `leaf ${JSON.stringify(leaf.path)}`).toBe(leaf.source);
        }
        // Nothing else in the data moved either.
        for (const key of Object.keys(before)) {
          if (key !== String(edited[0])) expect(after[key]).toEqual(before[key]);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
