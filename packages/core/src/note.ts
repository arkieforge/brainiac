import { isScalar, parseDocument, visit, type Document } from "yaml";

/** A note's raw text cut into its front-matter YAML and markdown body, with offsets into the raw text. */
export interface NoteParts {
  /** The YAML between the `---` fences, without them. Empty when the note has no front-matter. */
  readonly yaml: string;
  /** Offset of `yaml` in the raw text. */
  readonly yamlStart: number;
  readonly body: string;
  /** Offset of `body` in the raw text. */
  readonly bodyStart: number;
  readonly hasFrontMatter: boolean;
}

// The closing fence is the first line that is exactly `---` (CRLF allowed).
const FRONT_MATTER = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

/** Splits raw note text; the stored form is always this raw text, never a re-serialization. */
export function splitNote(raw: string): NoteParts {
  const match = raw.startsWith("---") ? FRONT_MATTER.exec(raw) : null;
  if (!match || match.index !== 0) {
    return { yaml: "", yamlStart: 0, body: raw, bodyStart: 0, hasFrontMatter: false };
  }
  const yaml = match[1] ?? "";
  const yamlStart = raw.indexOf("\n") + 1;
  return {
    yaml,
    yamlStart,
    body: raw.slice(match[0].length),
    bodyStart: match[0].length,
    hasFrontMatter: true,
  };
}

export class NoteParseError extends Error {
  override readonly name = "NoteParseError";
}

/**
 * Parses the front-matter with the yaml Document API, which keeps comments and source ranges. Always as YAML
 * 1.2's core schema: a `%YAML 1.1` line can't make `010` read as 8, and tags (`!!timestamp`, `!!binary`,
 * `!!omap`) are refused rather than read into types the stored JSON would blur. A key must be a plain name
 * (text, a number or true/false), and two keys that read alike (`1` and `"1"`) are refused, since a reader
 * would show one value and the record store the other.
 */
export function parseFrontMatter(yaml: string): Document.Parsed {
  const doc = parseDocument(yaml, {
    keepSourceTokens: true,
    version: "1.2",
    schema: "core",
    resolveKnownTags: false,
    uniqueKeys: (a, b) => a === b || (isScalar(a) && isScalar(b) && String(a.value) === String(b.value)),
  });
  const [error] = [...doc.errors, ...doc.warnings.filter((warning) => warning.code === "TAG_RESOLVE_FAILED")];
  if (error) throw new NoteParseError(`Front-matter is not valid YAML: ${error.message}`);
  visit(doc, {
    Pair: (_, pair) => {
      // Aliases, mappings, lists and null as keys all become text JSON can confuse with another key.
      const key: unknown = isScalar(pair.key) ? pair.key.value : undefined;
      const plain =
        typeof key === "string" ||
        typeof key === "boolean" ||
        (typeof key === "number" &&
          Number.isFinite(key) &&
          (!Number.isInteger(key) || Number.isSafeInteger(key)));
      if (!plain) throw new NoteParseError("Front-matter keys must be plain names.");
    },
  });
  return doc;
}

/**
 * Throws unless `value` survives JSON exactly: strings, booleans, null, safe finite numbers, and lists and plain
 * mappings of them, with no `__proto__` key (it reads as an object's prototype in most code). Front-matter is
 * stored and judged (approvals compare and sign it) as JSON, so anything JSON would lose or blur is refused.
 */
function assertJson(value: unknown, key: string, path: readonly unknown[] = []): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new Error(`${key} is too long for a number: quote it.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${key} can't be stored.`);
  // An alias that contains itself (`a: &a [*a]`) can't be stored.
  if (path.includes(value)) throw new Error(`${key} contains itself.`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    throw new Error(`${key} must be a plain mapping, list or value.`);
  for (const [k, v] of Object.entries(value)) {
    if (k === "__proto__") throw new Error("__proto__ can't be a field name.");
    assertJson(v, k, [...path, value]);
  }
}

export interface Note {
  /** Front-matter as plain data (`{}` when there is none). */
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export function parseNote(raw: string): Note {
  const parts = splitNote(raw);
  const doc = parseFrontMatter(parts.yaml);
  let data: unknown;
  try {
    data = doc.toJS() ?? {};
    assertJson(data, "front-matter");
  } catch (error) {
    // Valid YAML that can't become data (too many aliases, an unknown one, a cycle) is unreadable all the same.
    throw new NoteParseError(
      `Front-matter can't be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof data !== "object" || Array.isArray(data) || data === null) {
    throw new NoteParseError("Front-matter must be a mapping of fields.");
  }
  return { data: Object.fromEntries(Object.entries(data)), body: parts.body };
}
