// Structure that grows (docs/internals/record-format.md): where a new kind of info goes. An existing type first,
// then a vetted one from the shared catalog, and a type of the person's own only when it earns one; each type in
// the area that holds its kind of info, with that area's privacy class. Pure, so the record and a laptop agree.
import { deepEqual } from "./patch.ts";
import { pathKey } from "./paths.ts";
import type { TypeSpec } from "./schema.ts";

/** A type as an agent or the catalog describes it: everything but the `version`, which the record keeps. */
export type TypeDraft = Omit<TypeSpec, "version">;

const relation = { kind: "relation" } as const;
const sources = { kind: "list" } as const;

/**
 * Vetted types any record can take by id (`catalog: trip@2`): fields, relations and a headline people have
 * already thought through, so two people's trips are the same shape. Change an entry only by adding one with the
 * next version: records keep the entry they took.
 */
export const CATALOG: Readonly<Record<string, TypeDraft & { readonly name: string }>> = {
  "education@1": {
    name: "Education",
    held: true,
    folder: "facts/education",
    headline: "{degree} · {institution} · {start|year}–{end|year}",
    key: ["institution", "degree"],
    fields: {
      institution: { kind: "text", required: true, example: "Northvale University" },
      degree: { kind: "text", required: true, example: "BSc Computer Science" },
      start: { kind: "date" },
      end: { kind: "date", ask: "When did your {degree} at {institution} end?" },
      current: { kind: "boolean" },
      cgpa: { kind: "number", example: 3.82 },
      scale: { kind: "number", example: 4 },
      sources,
    },
  },
  "role@1": {
    name: "Role",
    held: true,
    folder: "facts/roles",
    headline: "{title} · {org} · {start|month}–{end|month}",
    key: ["org", "title", "start"],
    fields: {
      org: { kind: "text", required: true, example: "Acme Robotics" },
      kind: { values: ["internship", "job", "research", "volunteer"] },
      start: { kind: "date", required: true },
      end: { kind: "date", ask: "When did your role at {org} end?" },
      current: { kind: "boolean" },
      sources,
    },
  },
  "test-score@1": {
    name: "TestScore",
    held: true,
    folder: "facts/tests",
    headline: "{test} · {overall|1} · {date} · expires {expires|month}",
    key: ["test", "date"],
    fields: {
      test: {
        values: ["ielts-academic", "toefl-ibt", "gre", "gmat", "duolingo", "pte-academic"],
        required: true,
      },
      overall: { kind: "number", required: true, example: 8.0 },
      sections: { kind: "mapping", example: "{listening: 8.5, reading: 8.0}" },
      date: { kind: "date", required: true },
      expires: { kind: "date" },
      supersedes: relation,
      sources,
    },
  },
  "award@1": {
    name: "Award",
    held: true,
    folder: "facts/awards",
    headline: "{title} · {issuer} · {date|year}",
    key: ["issuer", "title", "date"],
    fields: {
      issuer: { kind: "text", required: true, example: "Northvale University" },
      date: { kind: "date", required: true },
      kind: { values: ["prize", "scholarship", "grant", "honor"] },
      amount: { kind: "text", example: "EUR 2,000" },
      sources,
    },
  },
  "volunteering@1": {
    name: "Volunteering",
    held: true,
    folder: "facts/volunteering",
    headline: "{title} · {org} · {start|month}–{end|month}",
    key: ["org", "start"],
    fields: {
      org: { kind: "text", required: true, example: "City Library" },
      start: { kind: "date", required: true },
      end: { kind: "date", ask: "When did you stop volunteering at {org}?" },
      current: { kind: "boolean" },
      hours: { kind: "number", example: 120 },
      sources,
    },
  },
  "talk@1": {
    name: "Talk",
    held: true,
    folder: "facts/talks",
    headline: "{title} · {event} · {date}",
    key: ["event", "date"],
    fields: {
      event: { kind: "text", required: true, example: "ACL 2024" },
      date: { kind: "date", required: true },
      kind: { values: ["talk", "poster", "panel", "workshop"] },
      city: { kind: "text" },
      for: relation,
      sources,
    },
  },
  "patent@1": {
    name: "Patent",
    held: true,
    folder: "facts/patents",
    headline: "{title} · {office} · {status} · {filed|year}",
    key: ["office", "number"],
    fields: {
      office: { kind: "text", required: true, example: "EPO" },
      number: { kind: "text", example: "EP1234567" },
      filed: { kind: "date", required: true },
      granted: { kind: "date" },
      status: { values: ["filed", "granted", "lapsed", "withdrawn"], required: true },
      sources,
    },
  },
  "course@1": {
    name: "Course",
    held: true,
    folder: "facts/courses",
    headline: "{title} · {provider} · {end|year}",
    key: ["provider", "title"],
    fields: {
      provider: { kind: "text", required: true, example: "Coursera" },
      start: { kind: "date" },
      end: { kind: "date" },
      grade: { kind: "text" },
      certificate: { kind: "text", example: "https://coursera.org/verify/ABC123" },
      sources,
    },
  },
  "trip@2": {
    name: "Trip",
    held: true,
    folder: "history/travel",
    headline: "{country} · {city} · {start|month}–{end|month} · {purpose}",
    key: ["country", "start"],
    fields: {
      country: { kind: "text", required: true, example: "Japan" },
      city: { kind: "text" },
      purpose: { values: ["study", "work", "conference", "tourism", "family", "transit"] },
      start: { kind: "date", required: true },
      end: { kind: "date", ask: "When did your trip to {country} end?" },
      for: relation,
      proved_by: relation,
    },
  },
  "address@1": {
    name: "Address",
    held: true,
    folder: "history/addresses",
    headline: "{city} · {country} · {start|month}–{end|month}",
    key: ["line", "start"],
    fields: {
      line: { kind: "text", required: true, example: "12 Lake Road" },
      city: { kind: "text", required: true },
      country: { kind: "text", required: true },
      start: { kind: "date", required: true },
      end: { kind: "date" },
      current: { kind: "boolean" },
    },
  },
  "gap@1": {
    name: "Gap",
    held: true,
    folder: "history/gaps",
    headline: "{start|month}–{end|month} · {reason}",
    key: ["start"],
    fields: {
      start: { kind: "date", required: true },
      end: { kind: "date" },
      reason: { kind: "text", required: true, example: "Family care" },
    },
  },
  "id-document@1": {
    name: "IdDocument",
    held: true,
    folder: "identity",
    headline: "{kind} · {issuer} · expires {expires}",
    key: ["kind", "issuer", "number"],
    fields: {
      kind: { values: ["passport", "national-id"], required: true },
      issuer: { kind: "text", required: true, example: "UTO" },
      // The number itself lives in the secrets vault; the note names it.
      number: { kind: "text", example: "secret:passport.uto.3f2a9c1b07de" },
      issued: { kind: "date" },
      expires: { kind: "date", ask: "When does your {kind} from {issuer} expire?" },
    },
  },
  "license@1": {
    name: "License",
    held: true,
    folder: "identity/licenses",
    headline: "{kind} · {issuer} · expires {expires}",
    key: ["kind", "issuer"],
    fields: {
      kind: { values: ["driving", "professional"], required: true },
      issuer: { kind: "text", required: true },
      number: { kind: "text", example: "secret:license.driving" },
      issued: { kind: "date" },
      expires: { kind: "date" },
    },
  },
  "visa@1": {
    name: "Visa",
    held: true,
    folder: "identity/visas",
    headline: "{country} · {kind} · expires {expires}",
    key: ["country", "issued"],
    fields: {
      country: { kind: "text", required: true, example: "Germany" },
      kind: { kind: "text", example: "student" },
      issued: { kind: "date", required: true },
      expires: { kind: "date", required: true },
      number: { kind: "text", example: "secret:visa.de" },
    },
  },
  "vaccination@1": {
    name: "Vaccination",
    held: true,
    folder: "health/vaccinations",
    headline: "{vaccine} · dose {dose} · {date}",
    key: ["vaccine", "dose"],
    fields: {
      vaccine: { kind: "text", required: true, example: "MMR" },
      dose: { kind: "number", example: 2 },
      date: { kind: "date", required: true },
      proved_by: relation,
    },
  },
  "funds-proof@1": {
    name: "FundsProof",
    held: true,
    folder: "finance",
    headline: "{kind} · {amount} {currency} · {date}",
    key: ["kind", "date"],
    fields: {
      kind: {
        values: ["bank-statement", "sponsorship", "scholarship", "loan", "blocked-account"],
        required: true,
      },
      amount: { kind: "number", required: true, example: 11904 },
      currency: { kind: "text", required: true, example: "EUR" },
      date: { kind: "date", required: true },
      proved_by: relation,
    },
  },
  "person@1": {
    name: "Person",
    folder: "people",
    headline: "{title} · {role} · {org}",
    fields: {
      role: { values: ["referee", "advisor", "family"], required: true },
      org: { kind: "text" },
      email: { kind: "text" },
    },
  },
};

/** The folders a record grows into, each with the class its notes take (docs/internals/record-format.md). */
const SENSITIVE_AREAS = ["facts/tests", "history", "identity", "health", "finance", "people"];
/** Folders that hold what Brainiac itself keeps there; no type of the person's own goes in them. */
const RESERVED = ["inbox", "questions", "unorganized", "settings", "documents/files"];

const within = (path: string, folder: string) => {
  const [p, f] = [pathKey(path), pathKey(folder)];
  return p === f || p.startsWith(`${f}/`);
};

/** The class a note placed at `path` takes: sensitive in a sensitive area, else normal. */
export const areaClass = (path: string): "normal" | "sensitive" =>
  SENSITIVE_AREAS.some((area) => within(path, area)) ? "sensitive" : "normal";

/** Fields that describe a note rather than being a type's own: they don't count toward earning a type. */
const SHARED = new Set(["title", "tags", "sources", "verified", "supersedes", "notes"]);

/**
 * Why a new type of the person's own (not from the catalog) can't be added, if it can't: its name, a catalog type
 * of that name, its folder, and the rule that a type earns its place with 3 fields of its own, or its own dates
 * and a status. Anything less stays a Fact with tags.
 */
export function newTypeIssues(name: string, draft: TypeDraft): string[] {
  const issues: string[] = [];
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name))
    issues.push(`${name}: a type's name is one word in PascalCase, like MusicGrade.`);
  const listed = Object.entries(CATALOG).find(([, entry]) => entry.name === name);
  if (listed)
    issues.push(`${name} is in the shared catalog: send catalog: "${listed[0]}" instead of its fields.`);
  if (draft.folder === undefined) issues.push(`${name} needs a folder, like facts/music.`);
  else if (RESERVED.some((folder) => within(draft.folder ?? "", folder)))
    issues.push(
      `${draft.folder} holds what Brainiac keeps there; put ${name} in an area like facts/ or history/.`,
    );
  const own = Object.entries(draft.fields).filter(([field]) => !SHARED.has(field));
  const dated = own.some(([, spec]) => spec.kind === "date") && own.some(([field]) => field === "status");
  if (own.length < 3 && !dated)
    issues.push(
      `${name} has ${own.length} field${own.length === 1 ? "" : "s"} of its own: a new type needs 3, or its own dates and a status. Keep it a Fact with tags instead (create {type: "Fact", fields: {title, tags}}).`,
    );
  return issues;
}

/** A type's parts that merge on their own: each setting, and each field by name. */
function partsOf(spec: TypeDraft | undefined): Map<string, unknown> {
  const parts = new Map<string, unknown>();
  for (const [key, value] of Object.entries(spec ?? {})) {
    if (key === "version" || value === undefined) continue;
    if (key !== "fields") parts.set(key, value);
    else
      for (const [field, fieldSpec] of Object.entries(spec?.fields ?? {}))
        parts.set(`fields.${field}`, fieldSpec);
  }
  return parts;
}

/**
 * Three-way merge of one type, as the sync engine merges a note: `base` is the type the change was made from (absent
 * for a new one), `mine` the change, `theirs` the type now. A setting or field only one side changed takes that
 * side; both changing it alike is fine; both changing it differently (the same field with another kind or other
 * values, two headlines) is a conflict, never a union of the two.
 */
export function mergeType(
  base: TypeDraft | undefined,
  mine: TypeDraft,
  theirs: TypeDraft | undefined,
): { readonly merged: TypeDraft } | { readonly conflicts: readonly string[] } {
  const [b, m, t] = [partsOf(base), partsOf(mine), partsOf(theirs)];
  const out = new Map(t);
  const conflicts: string[] = [];
  for (const key of new Set([...b.keys(), ...m.keys(), ...t.keys()])) {
    const [vb, vm, vt] = [b.get(key), m.get(key), t.get(key)];
    if (deepEqual(vm, vt) || deepEqual(vm, vb)) continue;
    if (!deepEqual(vt, vb)) conflicts.push(key);
    else if (vm === undefined) out.delete(key);
    else out.set(key, vm);
  }
  if (conflicts.length > 0) return { conflicts };
  const fields: TypeDraft["fields"] = {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of out) {
    if (key.startsWith("fields.")) Object.assign(fields, { [key.slice("fields.".length)]: value });
    else merged[key] = value;
  }
  // Built from parts that each came from a TypeDraft, so it is one.
  return { merged: { ...(merged as Omit<TypeDraft, "fields">), fields } };
}
