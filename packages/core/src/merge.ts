import { parseNote, splitNote, type Note } from "./note.ts";
import { deepEqual, patch, type PatchOp, type YamlValue } from "./patch.ts";

export interface Merged {
  /** The merged text: `theirs` with the fields and body text only `mine` changed. */
  readonly raw: string;
  /** Top-level fields both sides changed to different values; `raw` keeps theirs. */
  readonly fields: readonly string[];
  /** Both sides changed the body in the same place; `raw` keeps their body. */
  readonly body: boolean;
}

/**
 * Three-way merge of a note (the sync engine's merge rules). `base` is the text both sides started from,
 * `mine` the incoming edit, `theirs` the current text. A field or body region only one side changed takes
 * that side; both sides changing it the same way is merged; differently is a conflict, kept as theirs and
 * reported. Only `mine`'s changes are written into `theirs`, so its formatting survives.
 * Throws `NoteParseError` if any side's front-matter is not valid YAML.
 */
export function merge(base: string, mine: string, theirs: string): Merged {
  // Nothing happened on one side: the other side's text, byte for byte.
  if (theirs === base || mine === theirs) return { raw: mine, fields: [], body: false };
  if (mine === base) return { raw: theirs, fields: [], body: false };
  const b = parseNote(base);
  const m = parseNote(mine);
  const t = parseNote(theirs);
  const ops: PatchOp[] = [];
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(b.data), ...Object.keys(m.data), ...Object.keys(t.data)])) {
    const at = (side: Note) => [Object.hasOwn(side.data, key), side.data[key]] as const;
    const [vb, vm, vt] = [at(b), at(m), at(t)];
    if (same(vm, vt) || same(vm, vb)) continue;
    if (!same(vt, vb)) {
      fields.push(key);
      continue;
    }
    ops.push(vm[0] ? { op: "set", path: [key], value: vm[1] as YamlValue } : { op: "unset", path: [key] });
  }
  let raw = patch(theirs, ops);
  const body = merge3(b.body, m.body, t.body);
  if (body !== undefined && body !== t.body) raw = raw.slice(0, splitNote(raw).bodyStart) + body;
  return { raw, fields, body: body === undefined };
}

/** Two sides' value for one field, each as [present, value]. */
const same = (x: readonly [boolean, unknown], y: readonly [boolean, unknown]) =>
  x[0] === y[0] && deepEqual(x[1], y[1]);

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Pairs of indexes of a longest common subsequence of lines, in order. */
function matches(a: readonly string[], b: readonly string[]): Map<number, number> {
  // shortcut: O(n·m) table; fine for notes, swap in Myers' diff if bodies grow past a few thousand lines.
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) pairs.set(i++, j++);
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Line-based three-way merge (diff3): `undefined` when both sides changed the same region differently,
 * including edits that touch with no unchanged line between them.
 */
export function merge3(base: string, mine: string, theirs: string): string | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const [o, a, b] = [lines(base), lines(mine), lines(theirs)];
  const toA = matches(o, a);
  const toB = matches(o, b);
  let out = "";
  let [i, j, k] = [0, 0, 0];
  const settle = (iEnd: number, jEnd: number, kEnd: number): boolean => {
    const [oc, ac, bc] = [o.slice(i, iEnd).join(""), a.slice(j, jEnd).join(""), b.slice(k, kEnd).join("")];
    if (ac === oc || ac === bc) out += bc;
    else if (bc === oc) out += ac;
    else return false;
    return true;
  };
  for (let next = 0; next < o.length; next++) {
    const ja = toA.get(next);
    const kb = toB.get(next);
    // A base line both sides kept, past where each side has got to, ends the region before it.
    if (ja === undefined || kb === undefined || ja < j || kb < k) continue;
    if (!settle(next, ja, kb)) return undefined;
    out += o[next];
    [i, j, k] = [next + 1, ja + 1, kb + 1];
  }
  return settle(o.length, a.length, b.length) ? out : undefined;
}
