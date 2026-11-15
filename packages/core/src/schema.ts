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
  /** Ask the person for it while it's empty, in these words: `When did your role at {org} end?` (questions.ts). */
  "ask?": "string",
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
      /** One line per item in the overview: `{degree} · {institution} · {end|year}` (review.ts). */
      "headline?": "string",
      /** The fields that name one item: two notes with the same values are the same thing (review.ts). */
      "key?": "string[]",
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
 * these until an agent files it, and what an agent asks with `request_info` waits in `questions/`. A manifest
 * type of the same name wins.
 */
export const BUILT_IN_TYPES: Manifest["types"] = {
  // Every upload's sidecar note (packages/base/src/vault.ts), so a record can hold one whatever its manifest says.
  // `kind` is optional: an upload's is unknown until the person says what it is.
  Document: {
    version: 1,
    folder: "documents",
    headline: "{title} · {kind} · issued {issued}",
    fields: {
      kind: { kind: "text", example: "transcript" },
      issuer: { kind: "text" },
      issued: { kind: "date" },
      expires: { kind: "date" },
      file: { kind: "text", example: "files/transcript-bsc.pdf" },
      proves: { kind: "list" },
      extracted: { kind: "mapping", example: "{cgpa: 3.82, scale: 4}" },
    },
  },
  InboxItem: {
    version: 1,
    folder: "inbox",
    fields: {
      url: { kind: "text", example: "https://example.org/award" },
      attached_to: { kind: "relation" },
    },
  },
  // What `request_info` asks the person (questions.ts). `suggested`, `was` and `answer` hold a value of the asked
  // field's own kind, so they aren't declared here.
  Question: {
    version: 1,
    folder: "questions",
    fields: {
      about: { kind: "relation" },
      field: { kind: "text" },
      why: { kind: "text" },
      status: { values: ["open", "answered", "not-applicable"], required: true },
      // `filer` when background filing asked it, from an inbox item nobody checked.
      from: { values: ["filer"] },
    },
  },
  // What the GitHub connector proposes for a repo (packages/base/src/github.ts). `synced` is the connector's own
  // block, which it refreshes directly; every other field is the person's.
  Project: {
    version: 1,
    held: true,
    folder: "facts/projects",
    fields: {
      role: { kind: "text", example: "Lead developer (team of 3)" },
      summary: { kind: "text" },
      sources: { kind: "list" },
      synced: { kind: "mapping", example: "{repo_id: R_kgDOJx, stars: 214}" },
    },
  },
  // One of the person's own public profiles, checked for drift (packages/core/src/profiles.ts). `name`, `headline`,
  // `about` and `location` are what the person wants it to say; `synced` is what the profiles connector last saw.
  Profile: {
    version: 1,
    folder: "profiles",
    fields: {
      site: { values: ["linkedin", "x", "scholar"], required: true },
      url: { kind: "text", required: true, example: "https://www.linkedin.com/in/nadia-karim" },
      name: { kind: "text" },
      headline: { kind: "text" },
      about: { kind: "text" },
      location: { kind: "text" },
      synced: { kind: "mapping", example: "{url: https://x.com/nadia, owned: true}" },
    },
  },
  // A page the person saved (packages/base/src/links.ts). `for` names the application that relies on it, if one
  // does; `synced` is what the links connector last saw there: whether it answers, its text, its PDF snapshot.
  Link: {
    version: 1,
    folder: "links",
    headline: "{title}",
    fields: {
      url: { kind: "text", required: true, example: "https://www.daad.de/en/scholarships" },
      title: { kind: "text" },
      for: { kind: "relation", example: "../applications/tum-msc-informatics-2027/application.md" },
      synced: { kind: "mapping", example: "{url: https://www.daad.de/en/scholarships, status: live}" },
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
