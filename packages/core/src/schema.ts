import { type, type Type } from "arktype";
import { parse, parseDocument } from "yaml";

import { isUlid } from "./ids.ts";
import { isRelationPath } from "./paths.ts";

// What a manifest (okf-base.yaml) may say about one field. A field with `values` is a choice of those.
export const FieldSpec = type({
  "kind?": "'text' | 'number' | 'boolean' | 'date' | 'relation' | 'list' | 'mapping' | 'requirements'",
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
      /** Bumped by every change to the type, so a change made from an older version is merged or refused (growth.ts). */
      version: "number.integer >= 1",
      /** The shared catalog entry the type was taken from, like `trip@2` (growth.ts `CATALOG`). */
      "catalog?": "string",
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
export type TypeSpec = Manifest["types"][string];

export class ManifestError extends Error {
  override readonly name = "ManifestError";
}

/** Reads `okf-base.yaml`. A malformed manifest fails loudly, naming the setting that is wrong. */
export function parseManifest(yaml: string): Manifest {
  const manifest = ManifestSpec(parse(yaml));
  if (manifest instanceof type.errors) throw new ManifestError(`okf-base.yaml: ${manifest.summary}`);
  return manifest;
}

/**
 * `okf-base.yaml` with one type set to `spec`, or removed without one, through the YAML document, so the person's
 * comments and the other types' values survive (the yaml library may move a comment onto its own line). Starts a
 * manifest when `yaml` is empty.
 */
export function setType(yaml: string, name: string, spec: TypeSpec | undefined): string {
  const doc = parseDocument(yaml === "" ? "schema_version: 1\ntypes: {}\n" : yaml);
  if (spec === undefined) doc.deleteIn(["types", name]);
  else doc.setIn(["types", name], doc.createNode(spec));
  return doc.toString();
}

/** The bounds a requirement check may put on its `field`. */
export const BOUNDS = ["gte", "lte", "gt", "lt"] as const;

/**
 * What one requirement of an Application checks (review.ts `requirementsOf`): notes of `type` whose other keys
 * equal the note's own, `field` within the bounds, valid on the application's `valid_on` date (today without one),
 * at least `count_gte` of them (1 by default). `for: this` is a note whose `for` names the application. Thresholds
 * live here and only here: the requirement's `need` is words for the person, never read as a check.
 */
const RequirementCheck = type({
  type: "string > 0",
  "field?": "string > 0",
  "gte?": "number",
  "lte?": "number",
  "gt?": "number",
  "lt?": "number",
  "valid_on?": "string > 0",
  "count_gte?": "number.integer >= 1",
  "for?": "'this'",
  "[string]": "string | number | boolean",
}).narrow(
  (spec, ctx) =>
    spec.field !== undefined ||
    !BOUNDS.some((bound) => spec[bound] !== undefined) ||
    ctx.reject({ expected: "a check naming the field its bound compares, like field: overall" }),
);

/** One requirement: what the portal asks for in words, and the check that decides it. `manual` is one the person ticks with `done: true`. */
const Requirement = type({
  need: "string > 0",
  check: RequirementCheck.or("'manual'").describe(
    "a typed check like {type: TestScore, field: overall, gte: 6.5}, or manual",
  ),
  "done?": "boolean",
}).narrow(
  (requirement, ctx) =>
    requirement.done === undefined ||
    requirement.check === "manual" ||
    ctx.reject({
      expected: "done only with check: manual, since a typed check passes on the record's notes",
    }),
);

/** One requirement as written in a note, or why it isn't one Brainiac can check. */
export function parseRequirement(item: unknown): typeof Requirement.infer | { readonly invalid: string } {
  const requirement = Requirement(item);
  return requirement instanceof type.errors ? { invalid: requirement.summary } : requirement;
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
  requirements: Requirement.array(),
} satisfies Record<NonNullable<FieldSpec["kind"]>, Type<unknown>>;

const EXAMPLES = {
  text: "Some text",
  number: 8,
  boolean: true,
  date: "2026-11-02",
  relation: "../people/dr-okafor.md",
  list: "[a, b]",
  mapping: "{key: value}",
  requirements:
    "[{need: IELTS 6.5 or higher, check: {type: TestScore, test: ielts-academic, field: overall, gte: 6.5, valid_on: deadline}}]",
} satisfies Record<NonNullable<FieldSpec["kind"]>, string | number | boolean>;

/**
 * Types every record has, whatever its manifest says: what `add` captures into `inbox/` waits there as one of
 * these until an agent files it, and what an agent asks with `request_info` waits in `questions/`. A manifest
 * type of the same name wins.
 */
export const BUILT_IN_TYPES: Manifest["types"] = {
  // Something worth keeping that fits no type and doesn't earn one (growth.ts `newTypeIssues`): a fact with tags.
  Fact: {
    version: 1,
    held: true,
    folder: "facts",
    fields: {
      tags: { kind: "list", example: "[music, grade-exam]" },
      date: { kind: "date" },
    },
  },
  // `me.md`: who the person is, in their own words. Brainiac never writes it; describe puts a summary from the record
  // before it (core me.ts `aboutYou`).
  Me: { version: 1, fields: {} },
  // The person's preferences (docs/product/features/customization.md), one note per kind in `settings/`. They never
  // grant access: levels, scopes and privacy live in the record's own tables. A glossary's `terms` map a word to
  // what it also means (`CGPA: GPA`, or a list), and search reads them both ways (packages/base/src/glossary.ts).
  Settings: {
    version: 1,
    folder: "settings",
    key: ["kind"],
    fields: {
      kind: { values: ["agents", "glossary", "views", "review", "outputs"], required: true },
      terms: { kind: "mapping", example: "{CGPA: GPA, NTU: Northvale Technical University}" },
    },
  },
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
  // A paper, which the ORCID connector proposes from the person's works (packages/base/src/orcid.ts). The DOI
  // connector owns `synced` (packages/base/src/papers.ts), with the author position when the person's linked ORCID
  // iD names them; `position` is the person's own, and wins.
  Paper: {
    version: 1,
    held: true,
    folder: "facts/papers",
    headline: "{title} · {synced.venue} · {synced.published|year} · author {position}",
    key: ["doi"],
    fields: {
      doi: { kind: "text", example: "10.5555/12345678" },
      position: { kind: "number", example: 1, ask: "Which author are you on {title}? 1 is the first." },
      sources: { kind: "list" },
      synced: { kind: "mapping", example: "{doi: 10.5555/12345678, position: 2}" },
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
  // A target the person applies to (docs/product/features/applications.md): its requirements are checked against
  // the record (review.ts `requirementsOf`), and an application stops relying on anything once its status is decision.
  Application: {
    version: 1,
    folder: "applications",
    headline: "{title} · {status} · deadline {deadline}",
    fields: {
      kind: { values: ["university", "scholarship", "job"], required: true },
      deadline: { kind: "date", required: true },
      portal: { kind: "text", example: "https://campus.tum.de" },
      portal_login: { kind: "text", example: "secret:portal.tum" },
      status: { values: ["researching", "preparing", "submitted", "interview", "decision"], required: true },
      requirements: { kind: "requirements" },
      // What the portal takes, in its order, each under the file name it wants: a Draft (rendered to PDF) or a
      // Document with a file. Built into a zip on the site (packages/base/src/drafts.ts).
      packet: { kind: "list", example: "[{item: cv-v2.md, name: Karim_Nadia_CV.pdf}]" },
    },
  },
  // A CV, resume, statement of purpose, cover letter or essay the person's Claude wrote from the record with `draft`:
  // the text is the body, in markdown, and `claims` holds the value each number, date and name in it comes from, so
  // `draft {verify}` can check it again whenever the record changes. One application's drafts sit in its folder,
  // one note per version (cv-v2.md); a draft for an application that is submitted or past it is frozen.
  Draft: {
    version: 1,
    folder: "applications",
    headline: "{title} · {kind}",
    fields: {
      kind: { values: ["cv", "resume", "sop", "cover-letter", "essay"], required: true },
      for: { kind: "relation", example: "application.md" },
      claims: {
        kind: "list",
        example: "[{note: ../../facts/education/bsc-northvale.md, field: cgpa, value: 3.82}]",
      },
    },
  },
  // Someone in the record: a referee who writes the person's letters, an advisor, family for visa forms.
  Person: {
    version: 1,
    folder: "people",
    headline: "{title} · {role} · {org}",
    fields: {
      role: { values: ["referee", "advisor", "family"], required: true },
      org: { kind: "text", example: "Northvale University, School of Computing" },
    },
  },
  // Where one letter for one application stands (docs/product/features/applications.md, "Letters, status only");
  // the letter itself goes through the institution's own system. Only `received` (the portal shows it arrived)
  // meets a requirement, and until then a letter an open application waits on is a question (questions.ts).
  Letter: {
    version: 1,
    folder: "letters",
    headline: "{title} · {status}",
    fields: {
      referee: { kind: "relation", required: true, example: "../people/dr-okafor.md" },
      for: {
        kind: "relation",
        required: true,
        example: "../applications/tum-msc-informatics-2027/application.md",
      },
      status: { values: ["to-ask", "requested", "sent", "received"], required: true },
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
