import { type, type Type } from "arktype";
import { parse } from "yaml";

import { isUlid } from "./ids.ts";
import { isRelationPath } from "./paths.ts";

// What a manifest (okf-base.yaml) may say about one field. A field with `values` is a choice of those.
const FieldSpec = type({
  "kind?": "'text' | 'number' | 'boolean' | 'date' | 'relation' | 'list' | 'mapping'",
  "values?": "string[] > 0",
  "required?": "boolean",
  "example?": "string | number | boolean",
});
type FieldSpec = typeof FieldSpec.infer;

const ManifestSpec = type({
  schema_version: "number.integer >= 1",
  types: {
    "[string]": {
      version: "number.integer >= 1",
      "folder?": "string",
      /** A fact type: a connection's change to an existing value waits out the hold window (contract §3). */
      "held?": "boolean",
      fields: { "[string]": FieldSpec },
    },
  },
});
export type Manifest = typeof ManifestSpec.infer;

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

/** Reads `okf-base.yaml`. A malformed manifest fails loudly, naming the setting that is wrong. */
export function parseManifest(yaml: string): Manifest {
  const manifest = ManifestSpec(parse(yaml));
  if (manifest instanceof type.errors) throw new ManifestError(`okf-base.yaml: ${manifest.summary}`);
  return manifest;
}

const KINDS = {
  text: type("string"),
  number: type("number"),
  boolean: type("boolean"),
  date: type(/^\d{4}-\d{2}-\d{2}$/)
    .narrow((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s))
    .describe("a date like 2026-11-02"),
  relation: type("string")
    .narrow(isRelationPath)
    .describe("a relative path to a note, like ../people/dr-okafor.md"),
  list: type("unknown[]").describe("a list"),
  mapping: type("Record<string, unknown>").describe("a mapping of fields"),
} satisfies Record<NonNullable<FieldSpec["kind"]>, Type<unknown>>;

const EXAMPLES = {
  text: "Some text",
  number: 8,
  boolean: true,
  date: "2026-11-02",
  relation: "../people/dr-okafor.md",
  list: "[a, b]",
  mapping: "{key: value}",
} satisfies Record<NonNullable<FieldSpec["kind"]>, string | number | boolean>;

/**
 * Types every record has, whatever its manifest says: what `add` captures into `inbox/` waits there as one of
 * these until an agent files it. A manifest type of the same name wins.
 */
export const BUILT_IN_TYPES: Manifest["types"] = {
  InboxItem: {
    version: 1,
    folder: "inbox",
    fields: {
      url: { kind: "text", example: "https://example.org/award" },
      attached_to: { kind: "relation" },
    },
  },
};

// Every note has these, whatever its type.
const ID: FieldSpec = { kind: "text", required: true, example: "01JD7QA1ZK8M3V5X6Y7Z8A9BCD" };
const ULID = type("string").narrow(isUlid).describe("a ULID (26 characters, 0-9 and A-Z without I, L, O, U)");

export interface Issue {
  readonly field: string;
  /** `status must be "preparing" or "submitted" (was "draft"). Example: status: preparing` */
  readonly message: string;
}

/** Checks a note's front-matter against its type in the manifest. Empty means valid. */
export function validate(manifest: Manifest, data: Readonly<Record<string, unknown>>): Issue[] {
  const issues = [check("id", ID, data["id"], ULID)];
  const typeNames = Object.keys(manifest.types);
  const noteType = data["type"];
  // Own keys only: a note typed `constructor` must not find Object.prototype's.
  const types = { ...BUILT_IN_TYPES, ...manifest.types };
  const spec = typeof noteType === "string" && Object.hasOwn(types, noteType) ? types[noteType] : undefined;
  if (!spec) {
    const choice: FieldSpec = {
      values: typeNames.length > 0 ? typeNames : ["(none declared)"],
      required: true,
    };
    issues.push(check("type", choice, noteType));
    return issues.filter((issue) => issue !== undefined);
  }
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    issues.push(check(field, fieldSpec, data[field]));
  }
  return issues.filter((issue) => issue !== undefined);
}

function check(field: string, spec: FieldSpec, value: unknown, kind = kindOf(spec)): Issue | undefined {
  const example = spec.example ?? spec.values?.[0] ?? EXAMPLES[spec.kind ?? "text"];
  const hint = `Example: ${field}: ${String(example)}`;
  if (value === undefined || value === null) {
    return spec.required ? { field, message: `${field} is required. ${hint}` } : undefined;
  }
  const result = kind(value);
  return result instanceof type.errors
    ? { field, message: `${field} ${result.summary}. ${hint}` }
    : undefined;
}

function kindOf(spec: FieldSpec): Type<unknown> {
  return spec.values ? type.enumerated(...spec.values) : KINDS[spec.kind ?? "text"];
}
