// The note form: which fields a note shows, and how one edit becomes the note's next raw text. An edit patches
// only the YAML node of its field (`patch` in @brainiac/core), so every other byte of the note stays as written,
// comments and quoting included. Input is checked against the type's schema before anything is sent.
import {
  BUILT_IN_TYPES,
  parseNote,
  patch,
  splitNote,
  validate,
  type Manifest,
  type YamlValue,
} from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";

type Types = Manifest["types"];
export type FieldSpec = Types[string]["fields"][string];
type Kind = NonNullable<FieldSpec["kind"]>;

export interface Field {
  readonly name: string;
  readonly spec: FieldSpec;
  readonly value: unknown;
  /** Lists, mappings and requirements show as text; editing them waits for a form of their own. */
  readonly editable: boolean;
}

/** Front-matter every note has, shown in the pane's header rather than the form. */
const HEADER = new Set(["id", "type"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A field's kind read from its value, for notes whose type has no schema. */
function inferred(value: unknown): FieldSpec {
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (Array.isArray(value)) return { kind: "list" };
  if (typeof value === "object" && value !== null) return { kind: "mapping" };
  if (typeof value === "string" && DATE.test(value)) return { kind: "date" };
  return { kind: "text" };
}

const kindOf = (spec: FieldSpec): Kind | "choice" => (spec.values ? "choice" : (spec.kind ?? "text"));

/** The type's schema in the record's manifest, if it declares one. */
function typeSpec(manifest: Manifest | null, type: unknown): Types[string] | undefined {
  const types: Types = { ...BUILT_IN_TYPES, ...manifest?.types };
  return typeof type === "string" && Object.hasOwn(types, type) ? types[type] : undefined;
}

/**
 * The fields a note's form shows: its type's schema fields in the manifest's order, then any other key the note
 * has. A type without a schema shows the note's own keys, each with the kind its value has.
 */
export function fieldsOf(data: Readonly<Record<string, unknown>>, manifest: Manifest | null): Field[] {
  const declared = typeSpec(manifest, data["type"])?.fields ?? {};
  const names = [
    ...(Object.hasOwn(declared, "title") ? [] : ["title"]),
    ...Object.keys(declared),
    ...Object.keys(data).filter((key) => !Object.hasOwn(declared, key)),
  ].filter((name, i, all) => !HEADER.has(name) && all.indexOf(name) === i);
  return names.map((name) => {
    const spec = declared[name] ?? inferred(data[name] ?? "");
    const kind = kindOf(spec);
    return {
      name,
      spec,
      value: data[name],
      editable: kind !== "list" && kind !== "mapping" && kind !== "requirements",
    };
  });
}

/** What an input shows for a value. */
export function inputOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** What the person typed, as the value to store; `undefined` clears the field. */
function valueOf(spec: FieldSpec, input: string | boolean): YamlValue | undefined | { issue: string } {
  if (typeof input === "boolean") return input;
  const text = input.trim();
  if (text === "") return undefined;
  if (kindOf(spec) !== "number") return input;
  const number = Number(text);
  return Number.isFinite(number) ? number : { issue: "must be a number" };
}

export type Edited = { readonly raw: string } | { readonly issue: string };

/**
 * The note's next raw text with `field` set to what the person typed, or what is wrong with the input. Checked
 * with the record's own validator: against the type's schema when the manifest has one, otherwise against the
 * kind the field's current value has.
 */
export function editField(
  raw: string,
  manifest: Manifest | null,
  field: Field,
  input: string | boolean,
): Edited {
  const value = valueOf(field.spec, input);
  if (typeof value === "object" && value !== null && "issue" in value)
    return { issue: `${field.name} ${value.issue}.` };
  const { data } = parseNote(raw);
  const next: Record<string, unknown> = { ...data };
  if (value === undefined) delete next[field.name];
  else next[field.name] = value;
  // Without a schema for the type, check this one field as a type of its own.
  const schema: Manifest =
    manifest && typeSpec(manifest, data["type"])
      ? manifest
      : {
          schema_version: 1,
          types: { [String(data["type"] ?? "Note")]: { version: 1, fields: { [field.name]: field.spec } } },
        };
  const issue = validate(schema, { ...next, type: next["type"] ?? "Note" }).find(
    (i) => i.field === field.name,
  );
  if (issue) return { issue: issue.message };
  const op =
    value === undefined
      ? ({ op: "unset", path: [field.name] } as const)
      : ({ op: "set", path: [field.name], value } as const);
  return { raw: patch(raw, [op]) };
}

/** A note's text at a revision: what an edit was made on. */
export interface Base {
  readonly rev: number;
  readonly raw: string;
}

/** An online save's answer: what the record now has, why it wasn't saved, or undefined when nothing changed. */
export type Saved = Base | { readonly error: string } | undefined;

/**
 * Saves a sensitive note's edit online only, straight to the record (`POST /api/notes/<id>`), one at a time per
 * note. `edit` turns the base into the new text; the base is `base` when given (the text a draft was typed over,
 * so a note changed since is a conflict, never an overwrite), otherwise the latest text the tab knows, so a
 * field edit made while an earlier one is on its way builds on it. Edits that change nothing aren't sent.
 */
export type SaveOnline = (noteId: string, edit: (raw: string) => string, base?: Base) => Promise<Saved>;

/**
 * A sensitive note's edits never enter the sync client: its queue (pending and blocked edits, with their text)
 * is written to this device's IndexedDB, and sensitive notes are cached only on a device the person marked as
 * theirs (contract §5). The client's queue can't drop an entry either, since the record waits for every number.
 */
export const savesOnline = (client: SyncClient, noteId: string): boolean =>
  client.state.remote.get(noteId)?.class === "sensitive";

/**
 * Sends one field edit as the person's change to the note: through the sync client (the record's mutation
 * path), or online only for a sensitive note. Resolves to what is wrong with the input, or why it wasn't saved;
 * nothing is sent for input the schema refuses.
 */
export async function commitField(
  client: SyncClient,
  noteId: string,
  manifest: Manifest | null,
  field: Field,
  input: string | boolean,
  online: SaveOnline,
): Promise<string | undefined> {
  const base = client.working(noteId);
  if (base === undefined) return "This note is gone.";
  const edited = editField(base, manifest, field, input);
  if ("issue" in edited) return edited.issue;
  // Online, whether it changes anything is judged in order against the latest text the record accepted: the
  // client's copy lags an earlier save still on its way, so typing back its old value is still a change.
  if (savesOnline(client, noteId)) {
    const saved = await online(noteId, (latest) => {
      const again = editField(latest, manifest, field, input);
      return "raw" in again ? again.raw : latest;
    });
    return saved && "error" in saved ? saved.error : undefined;
  }
  if (edited.raw !== base) client.edit(noteId, edited.raw, base);
  return undefined;
}

/** The note with `body` as its body: the front-matter's bytes stay exactly as they are, never re-serialized. */
export const withBody = (raw: string, body: string): string => raw.slice(0, splitNote(raw).bodyStart) + body;

/** The note's body, as the editor edits it. */
export const bodyOf = (raw: string): string => splitNote(raw).body;
