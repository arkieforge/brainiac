import { parseDocument, type Document } from "yaml";

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

/** Parses the front-matter with the yaml Document API, which keeps comments and source ranges. */
export function parseFrontMatter(yaml: string): Document.Parsed {
  const doc = parseDocument(yaml, { keepSourceTokens: true });
  const [error] = doc.errors;
  if (error) throw new NoteParseError(`Front-matter is not valid YAML: ${error.message}`);
  return doc;
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
    // Front-matter is stored as JSON: an alias that contains itself (`a: &a [*a]`) can't be. A `__proto__` key
    // reads as an object's prototype in most code that touches it, so no field may have that name.
    JSON.stringify(data, (key, value: unknown) => {
      if (key === "__proto__") throw new Error("__proto__ can't be a field name.");
      return value;
    });
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
