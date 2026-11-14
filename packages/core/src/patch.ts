import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  stringify,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import { parseFrontMatter, splitNote } from "./note.ts";

/** A value that can be written into front-matter. */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | readonly YamlValue[]
  | { readonly [key: string]: YamlValue };

/** Keys and list indexes from the front-matter root, e.g. `["sections", "writing"]` or `["sources", 0, "page"]`. */
export type Path = readonly (string | number)[];

export type PatchOp =
  /** Sets a field, creating missing parent mappings. Setting the value it already has changes nothing. */
  | { readonly op: "set"; readonly path: Path; readonly value: YamlValue }
  /** Removes a field or list item; a missing one is a no-op. */
  | { readonly op: "unset"; readonly path: Path }
  /** Adds an item to the end of a list, creating the list if the field is missing or empty. */
  | { readonly op: "append"; readonly path: Path; readonly value: YamlValue }
  /**
   * Replaces the body under a markdown heading, up to the next heading of the same or a higher level.
   * A missing section is added at the end of the body as a heading of `level` (default 2).
   */
  | { readonly op: "section"; readonly heading: string; readonly content: string; readonly level?: number };

export class PatchError extends Error {
  override readonly name = "PatchError";
}

/**
 * Applies `ops` to raw note text in order. Only the bytes of the edited node change: every other key,
 * comment, quote style and blank line stays exactly as written, because the stored form is the raw text.
 */
export function patch(raw: string, ops: readonly PatchOp[]): string {
  return ops.reduce(applyOp, raw);
}

function applyOp(raw: string, op: PatchOp): string {
  const parts = splitNote(raw);
  if (op.op === "section") {
    return raw.slice(0, parts.bodyStart) + setSection(parts.body, op.heading, op.content, op.level ?? 2);
  }
  if (op.path.length === 0) throw new PatchError("A front-matter path needs at least one key.");
  const doc = parseFrontMatter(parts.yaml);
  const edit = new Editor(doc, parts.yaml);
  const yaml =
    op.op === "set"
      ? edit.set(op.path, op.value)
      : op.op === "unset"
        ? edit.unset(op.path)
        : edit.append(op.path, op.value);
  if (yaml === parts.yaml) return raw;
  const closed = yaml === "" || yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  if (!parts.hasFrontMatter) return `---\n${closed}---\n${raw}`;
  return raw.slice(0, parts.yamlStart) + closed + raw.slice(parts.yamlStart + parts.yaml.length);
}

/** Where a value lives: the document root, a mapping pair, or a list item. */
type Slot =
  | { readonly kind: "root" }
  | { readonly kind: "pair"; readonly pair: Pair; readonly parent: YAMLMap }
  | { readonly kind: "item"; readonly index: number; readonly parent: YAMLSeq };

class Editor {
  private readonly doc: Document.Parsed;
  private readonly src: string;

  constructor(doc: Document.Parsed, src: string) {
    this.doc = doc;
    this.src = src;
  }

  set(path: Path, value: YamlValue): string {
    const { slots, rest } = this.walk(path);
    const slot = slots.at(-1) ?? ROOT;
    const node = this.nodeAt(slot);
    if (rest.length === 0) {
      return deepEqual(this.toJS(node), value) ? this.src : this.replace(slot, value);
    }
    const [key, ...deeper] = rest;
    if (typeof key !== "string" || deeper.some((segment) => typeof segment !== "string")) {
      throw new PatchError(`${format(path)}: list items can only be added with append.`);
    }
    const nested = deeper.reduceRight<YamlValue>((inner, segment) => ({ [segment]: inner }), value);
    if (node === null || (isScalar(node) && node.value === null)) {
      return slot.kind === "root" ? this.appendRootLine(key, nested) : this.replace(slot, { [key]: nested });
    }
    if (!isMap(node)) throw new PatchError(`${format(path.slice(0, slots.length))} is not a mapping.`);
    return node.flow
      ? this.replace(slot, { ...this.mapJS(node), [key]: nested })
      : this.insertPair(node, key, nested);
  }

  unset(path: Path): string {
    const { slots, rest } = this.walk(path);
    const slot = slots.at(-1);
    if (rest.length > 0 || slot === undefined || slot.kind === "root") return this.src;
    const parentSlot = slots.at(-2) ?? ROOT;
    const { parent } = slot;
    if (parent.flow) {
      const next = isMap(parent)
        ? Object.fromEntries(Object.entries(this.mapJS(parent)).filter(([key]) => key !== path.at(-1)))
        : this.listJS(parent).filter((_, index) => slot.kind !== "item" || index !== slot.index);
      return this.replace(parentSlot, next);
    }
    // Emptying a nested block collection writes `{}` or `[]`, so the field keeps its kind instead of becoming null.
    if (parent.items.length === 1 && parentSlot.kind !== "root") {
      return this.replace(parentSlot, isMap(parent) ? {} : []);
    }
    const node = slot.kind === "pair" ? slot.pair.value : parent.items[slot.index];
    const first = slot.kind === "pair" ? slot.pair.key : node;
    if (!isNode(first) || !first.range)
      throw new PatchError(`${format(path)} has no position in the source.`);
    const start = this.lineStartIfOnlyPrefix(
      slot.kind === "item" ? this.dashBefore(first.range[0]) : first.range[0],
    );
    // The value's own end, not its outer range, which can swallow comment lines that follow it.
    const last = isNode(node) && node.range ? node.range[1] : first.range[1];
    const end = this.lineEnd(last);
    // The first key of a compact `- key: value` item: leave the dash on its own line and the rest of the
    // mapping below it untouched (comments and anchors included), which is still the same list item.
    if (
      slot.kind === "pair" &&
      start === first.range[0] &&
      this.src.slice(this.lineStart(start), start).trim()
    ) {
      const dashEnd = this.src.slice(0, start).trimEnd().length;
      const lineBreak = /\r?\n$/.exec(this.src.slice(dashEnd, end))?.[0].length ?? 0;
      return this.splice(dashEnd, end - lineBreak, "");
    }
    return this.splice(start, end, "");
  }

  append(path: Path, value: YamlValue): string {
    const { slots, rest } = this.walk(path);
    if (rest.length > 0) return this.set(path, [value]);
    const slot = slots.at(-1) ?? ROOT;
    const node = this.nodeAt(slot);
    if (node === null || (isScalar(node) && node.value === null)) return this.replace(slot, [value]);
    if (!isSeq(node)) throw new PatchError(`${format(path)} is not a list.`);
    if (node.flow || node.items.length === 0) return this.replace(slot, [...this.listJS(node), value]);
    const first = node.items[0];
    if (!isNode(first) || !first.range || !node.range)
      throw new PatchError(`${format(path)} has no position.`);
    const dash = this.dashBefore(first.range[0]);
    const indent = " ".repeat(dash - this.lineStart(dash));
    return this.insertLine(node.range[1], `${indent}- ${render(value)}`);
  }

  /** Follows `path` as far as it exists. */
  private walk(path: Path): { slots: Slot[]; rest: Path } {
    const slots: Slot[] = [];
    let node: unknown = this.doc.contents;
    for (const [index, segment] of path.entries()) {
      const slot = childSlot(node, segment);
      if (!slot) return { slots, rest: path.slice(index) };
      slots.push(slot);
      node = this.nodeAt(slot);
    }
    return { slots, rest: [] };
  }

  private nodeAt(slot: Slot): unknown {
    if (slot.kind === "root") return this.doc.contents;
    if (slot.kind === "pair") return slot.pair.value;
    return slot.parent.items[slot.index];
  }

  private toJS(node: unknown): unknown {
    return isNode(node) ? node.toJS(this.doc) : node;
  }

  private listJS(seq: YAMLSeq): unknown[] {
    const js = this.toJS(seq);
    return Array.isArray(js) ? js : [];
  }

  private mapJS(map: YAMLMap): Record<string, unknown> {
    const js = this.toJS(map);
    return typeof js === "object" && js !== null && !Array.isArray(js)
      ? Object.fromEntries(Object.entries(js))
      : {};
  }

  /** Rewrites the value in `slot`: a scalar or flow value in place, a block collection as one flow line. */
  private replace(slot: Slot, value: unknown): string {
    const node = this.nodeAt(slot);
    const text = render(value);
    if (slot.kind === "root") {
      if (!isNode(node) || !node.range) throw new PatchError("Front-matter must be a mapping of fields.");
      return this.splice(node.range[0], node.range[1], text);
    }
    if (isNode(node) && node.range && !isBlockCollection(node)) {
      const [start, end] = node.range;
      return this.splice(start, end, this.spaced(start, text) + this.closing(end));
    }
    if (slot.kind === "item") {
      if (!isNode(node) || !node.range) throw new PatchError("List item has no position in the source.");
      const [start, end] = node.range;
      return this.splice(start, end, text + this.closing(end));
    }
    // A pair whose value is a block collection (or missing): rewrite everything after the colon.
    const colon = this.colonAfter(slot.pair);
    const end = isNode(node) && node.range ? node.range[1] : colon;
    return this.splice(colon, end, ` ${text}${this.closing(end)}`);
  }

  /**
   * What must follow a value that replaced the span ending at `end`: the line break a block value ended
   * with, or a space when a comment comes straight after (`a: # note`), since `3# note` is one string.
   */
  private closing(end: number): string {
    if (end > 0 && this.src[end - 1] === "\n") return "\n";
    return this.src[end] === "#" ? " " : "";
  }

  private insertPair(map: YAMLMap, key: string, value: YamlValue): string {
    const first = map.items[0]?.key;
    if (!isNode(first) || !first.range || !map.range) return this.appendRootLine(key, value);
    const indent = " ".repeat(first.range[0] - this.lineStart(first.range[0]));
    return this.insertLine(map.range[1], `${indent}${render(key)}: ${render(value)}`);
  }

  private appendRootLine(key: string, value: YamlValue): string {
    return this.insertLine(this.src.length, `${render(key)}: ${render(value)}`);
  }

  /** Inserts a whole line at `at`, which is a line start or the end of the source. */
  private insertLine(at: number, line: string): string {
    const lead = at === 0 || this.src[at - 1] === "\n" ? "" : "\n";
    return this.splice(at, at, `${lead}${line}\n`);
  }

  private splice(start: number, end: number, text: string): string {
    return this.src.slice(0, start) + text + this.src.slice(end);
  }

  /** `key:5` is a different key, so a value written right after a colon or dash gets a space. */
  private spaced(at: number, text: string): string {
    const before = this.src[at - 1];
    return before === ":" || before === "-" ? ` ${text}` : text;
  }

  private colonAfter(pair: Pair): number {
    const key = pair.key;
    const from = isNode(key) && key.range ? key.range[1] : 0;
    const colon = this.src.indexOf(":", from);
    if (colon === -1) throw new PatchError("Mapping pair has no colon.");
    return colon + 1;
  }

  /** The `-` that introduces a block list item whose value starts at `at`. */
  private dashBefore(at: number): number {
    const dash = this.src.lastIndexOf("-", at - 1);
    return dash === -1 ? at : dash;
  }

  private lineStart(at: number): number {
    return this.src.lastIndexOf("\n", at - 1) + 1;
  }

  /** The line start before `at` when only indentation precedes it, else `at` (a compact `- key: value`). */
  private lineStartIfOnlyPrefix(at: number): number {
    const start = this.lineStart(at);
    return this.src.slice(start, at).trim() === "" ? start : at;
  }

  private lineEnd(at: number): number {
    if (at > 0 && this.src[at - 1] === "\n") return at;
    const newline = this.src.indexOf("\n", at);
    return newline === -1 ? this.src.length : newline + 1;
  }
}

const ROOT: Slot = { kind: "root" };

function childSlot(node: unknown, segment: string | number): Slot | undefined {
  if (isMap(node) && typeof segment === "string") {
    const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === segment);
    return pair ? { kind: "pair", pair, parent: node } : undefined;
  }
  if (isSeq(node) && typeof segment === "number" && segment >= 0 && segment < node.items.length) {
    return { kind: "item", index: segment, parent: node };
  }
  return undefined;
}

function isBlockCollection(node: Node): boolean {
  return (isMap(node) || isSeq(node)) && !node.flow;
}

/** One-line YAML for a value: `{a: 1}`, `[x, y]`, `"8.0"`. Falls back to JSON, which is valid YAML, for text with newlines. */
function render(value: unknown): string {
  const yaml = stringify(value, {
    collectionStyle: "flow",
    flowCollectionPadding: false,
    lineWidth: 0,
  }).trimEnd();
  return yaml.includes("\n") ? JSON.stringify(value) : yaml;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aEntries = Object.entries(a);
  const bKeys = Object.keys(b);
  return (
    aEntries.length === bKeys.length &&
    aEntries.every(([key, value]) => key in b && deepEqual(value, Reflect.get(b, key)))
  );
}

const format = (path: Path) => path.map((segment) => String(segment)).join(".") || "front-matter";

/** Replaces one section's text; bytes outside it stay as written. Headings inside code fences don't count. */
function setSection(body: string, heading: string, content: string, level: number): string {
  const lines = [...body.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0] !== "");
  let fence: string | undefined;
  let found: { end: number; level: number } | undefined;
  for (const { 0: line, index } of lines) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (fence === undefined) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    // Closing hashes count only after whitespace, so `## C#` is the heading "C#".
    const match = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?\n?$/.exec(line);
    if (!match) continue;
    const hashes = match[1]?.length ?? 0;
    if (found) {
      if (hashes <= found.level) return replaceSection(body, found.end, index, content, true);
    } else if (match[2] === heading.trim()) {
      found = { end: index + line.length, level: hashes };
    }
  }
  if (found) return replaceSection(body, found.end, body.length, content, false);
  const gap = body === "" ? "" : body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${gap}${"#".repeat(level)} ${heading.trim()}\n\n${content.replace(/\n+$/, "")}\n`;
}

/** A section reads `heading`, blank line, text, then a blank line before the next heading. */
function replaceSection(body: string, start: number, end: number, content: string, beforeHeading: boolean) {
  const text = `\n${content.replace(/^\n+|\n+$/g, "")}\n${beforeHeading ? "\n" : ""}`;
  return body.slice(0, start) + text + body.slice(end);
}
