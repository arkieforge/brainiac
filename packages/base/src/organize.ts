// Versioned types (docs/internals/record-format.md, "Structure that grows"): every change to the record's manifest
// is a new `schema` row in the run that made it, so undoing the run takes it back with the run's notes. A change
// says which version of each type it was made from: one made from an older version merges with what changed since,
// or is refused naming the conflict, never a union of the two. mutate.ts applies them inside its runs.
import {
  BUILT_IN_TYPES,
  CATALOG,
  deepEqual,
  mergeType,
  newTypeIssues,
  parseManifest,
  setType,
  validate,
  type Issue,
  type PlanItem,
  type TypeDraft,
  type TypeSpec,
} from "@brainiac/core";

import { principalOf, type Connection } from "./connections.ts";
import { getNote, listNotes } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import { search } from "./search.ts";
import type { Sql } from "./sql.ts";

/** One type to add or change: from the catalog by id, or as the change spells it out. */
export type TypeChange = {
  readonly name: string;
  /** The type's version the change was made from (describe shows it); 0 for a type the record doesn't have. */
  readonly base: number;
} & ({ readonly catalog: string } | { readonly draft: TypeDraft });

/** The manifest's place in a plan a passkey signs: a schema change is part of the change it signs. */
export const MANIFEST = "okf-base.yaml";

interface SchemaRow {
  readonly version: number;
  readonly manifest: string;
}

const latest = (sql: Sql) =>
  sql.all<SchemaRow>("SELECT version, manifest FROM schema ORDER BY version DESC LIMIT 1")[0];

const typesOf = (row: SchemaRow | undefined) => (row ? parseManifest(row.manifest).types : {});

/** The type as the record had it at `version`, from the manifest's history. */
function typeAt(sql: Sql, name: string, version: number): TypeSpec | undefined {
  for (const row of sql.all<SchemaRow>("SELECT version, manifest FROM schema ORDER BY version DESC")) {
    const spec = typesOf(row)[name];
    if (spec?.version === version) return spec;
  }
  return undefined;
}

/** What a schema step did: the plan item for the manifest (none when nothing changed) and the types it changed. */
export interface Typed {
  readonly item?: PlanItem;
  readonly types: readonly string[];
  /** The record had no manifest before, so every note now meets one. */
  readonly first: boolean;
}

/** Writes the next manifest version with `changed` set (a type removed where `undefined`), in `runId`. */
function writeManifest(
  sql: Sql,
  changed: ReadonlyMap<string, TypeSpec | undefined>,
  ctx: { readonly actor: string; readonly now: number },
  runId: string,
): Typed {
  const from = latest(sql);
  if (changed.size === 0) return { types: [], first: false };
  const before = typesOf(from);
  let yaml = from?.manifest ?? "";
  const fields: Record<string, { before?: TypeSpec; after?: TypeSpec }> = {};
  for (const [name, spec] of changed) {
    yaml = setType(yaml, name, spec);
    const was = before[name];
    fields[name] = { ...(was && { before: was }), ...(spec && { after: spec }) };
  }
  parseManifest(yaml);
  sql.all(
    "INSERT INTO schema (version, manifest, runId, actor, at) VALUES (?, ?, ?, ?, ?)",
    (from?.version ?? 0) + 1,
    yaml,
    runId,
    ctx.actor,
    ctx.now,
  );
  return {
    item: {
      noteId: MANIFEST,
      baseRev: from?.version ?? 0,
      path: MANIFEST,
      class: "normal",
      patch: { fields },
    },
    types: [...changed.keys()],
    first: from === undefined,
  };
}

/**
 * Adds or changes types, in `runId`. A new type of the person's own must earn its place (core `newTypeIssues`); a
 * change made from an older version merges with what changed since (core `mergeType`). Nothing is written when any
 * change can't apply.
 */
export function changeTypes(
  sql: Sql,
  changes: readonly TypeChange[],
  ctx: { readonly actor: string; readonly now: number },
  runId: string,
): Typed | { readonly issues: readonly Issue[] } {
  const now = typesOf(latest(sql));
  const issues: Issue[] = [];
  const changed = new Map<string, TypeSpec>();
  for (const change of changes) {
    const { name, base } = change;
    const field = `types.${name}`;
    const fail = (message: string) => issues.push({ field, message });
    const current = Object.hasOwn(now, name) ? now[name] : undefined;
    let draft: TypeDraft;
    if ("catalog" in change) {
      const entry = CATALOG[change.catalog];
      if (!entry || entry.name !== name) {
        fail(`The catalog has no ${change.catalog} named ${name}. describe lists the catalog.`);
        continue;
      }
      const { name: _name, ...spec } = entry;
      draft = { ...spec, catalog: change.catalog };
    } else draft = change.draft;
    if (!current && Object.hasOwn(BUILT_IN_TYPES, name)) {
      fail(`${name} is built into Brainiac, so organize doesn't change it.`);
      continue;
    }
    if (!current && base !== 0) {
      fail(`The record has no type ${name} now: send base 0 to add it.`);
      continue;
    }
    if (current && base > current.version) {
      fail(`${name} is at version ${current.version}, so base ${base} is no version of it.`);
      continue;
    }
    const unearned = !current && !("catalog" in change) ? newTypeIssues(name, draft) : [];
    if (unearned.length > 0) {
      for (const message of unearned) fail(message);
      continue;
    }
    let next = draft;
    if (current && base !== current.version) {
      const merged = mergeType(base === 0 ? undefined : typeAt(sql, name, base), draft, current);
      if ("conflicts" in merged) {
        fail(
          `${name} changed since version ${base} (it is at ${current.version}), and both changes touch ${merged.conflicts.join(", ")}. Nothing was merged: read describe again and plan from the type as it is now.`,
        );
        continue;
      }
      next = merged.merged;
    }
    const { version: _version, ...was } = current ?? { version: 0 };
    if (current && deepEqual(next, was)) continue;
    changed.set(name, { ...next, version: (current?.version ?? 0) + 1 });
  }
  return issues.length > 0 ? { issues } : writeManifest(sql, changed, ctx, runId);
}

/**
 * Takes back the type changes run `runId` made, newest first, in `undoRunId`. A type changed again since can't go
 * back, and nothing does.
 */
export function revertTypes(
  sql: Sql,
  runId: string,
  ctx: { readonly actor: string; readonly now: number },
  undoRunId: string,
): Typed | { readonly issues: readonly Issue[] } {
  const now = typesOf(latest(sql));
  const changed = new Map<string, TypeSpec | undefined>();
  const issues: Issue[] = [];
  const rows = sql.all<SchemaRow>(
    "SELECT version, manifest FROM schema WHERE runId = ? ORDER BY version DESC",
    runId,
  );
  for (const row of rows) {
    const set = typesOf(row);
    const was = typesOf(
      sql.all<SchemaRow>(
        "SELECT version, manifest FROM schema WHERE version < ? ORDER BY version DESC LIMIT 1",
        row.version,
      )[0],
    );
    for (const name of new Set([...Object.keys(set), ...Object.keys(was)])) {
      if (deepEqual(set[name], was[name])) continue;
      const is = changed.has(name) ? changed.get(name) : now[name];
      if (!deepEqual(is, set[name])) {
        issues.push({
          field: `types.${name}`,
          message: `Nothing was undone: ${name} changed again since this run, so undo can't put it back.`,
        });
        continue;
      }
      const back = was[name];
      // A new version, so a change made from the one the run set is merged with this, not applied over it.
      changed.set(name, back && { ...back, version: (set[name]?.version ?? back.version) + 1 });
    }
  }
  return issues.length > 0 ? { issues } : writeManifest(sql, changed, ctx, undoRunId);
}

/**
 * The live notes of `types` (every type, after a record's first manifest) that no longer meet their type, as issues:
 * named when `connection` may see them, counted when it can't, so a change never says what a hidden note holds.
 */
export function brokenNotes(sql: Sql, typed: Typed, connection: Connection | undefined): Issue[] {
  if (typed.types.length === 0) return [];
  const manifest = parseManifest(latest(sql)?.manifest ?? "");
  const notes = typed.first ? listNotes(sql) : typed.types.flatMap((type) => listNotes(sql, { type }));
  const broken = notes.filter((note) => validate(manifest, JSON.parse(note.fm)).length > 0);
  if (broken.length === 0) return [];
  const reader = principalOf(connection);
  const seen = broken.filter((note) => project(note, reader)).map((note) => note.path);
  const hidden = broken.length - seen.length;
  return [
    {
      field: "types",
      message: `Nothing changed: ${broken.length} note${broken.length === 1 ? "" : "s"} wouldn't meet ${broken.length === 1 ? "its" : "their"} type any more${seen.length > 0 ? ` (${seen.join(", ")}${hidden > 0 ? `, and ${hidden} you can't see` : ""})` : ""}. Change those notes in the same organize, or keep the type as it is.`,
    },
  ];
}

/** The most notes one self-test asks about. */
const SELF_TEST = 20;

export interface SelfTest {
  readonly asked: number;
  /** Each question whose note a search no longer finds in its first 8 hits. */
  readonly missed: readonly { readonly question: string; readonly note: string }[];
}

/**
 * The person's retrieval self-test after a structural change: for each note the change placed, a question from the
 * record itself (its type and title), asked the way `ask` asks it, must find that note among its first 8 hits.
 * As `reader`, over what it may see, so its questions never quote a note it can't.
 */
export function selfTest(sql: Sql, reader: Principal, noteIds: readonly string[], now: number): SelfTest {
  const questions = [...new Set(noteIds)].flatMap((id) => {
    const note = project(getNote(sql, id), reader);
    if (!note || note.deletedAt !== null) return [];
    const title = note.title ?? note.path.split("/").at(-1)?.replace(/\.md$/i, "");
    return [{ question: [note.type, title].filter(Boolean).join(" "), note: id }];
  });
  const asked = questions.slice(0, SELF_TEST);
  const missed = asked.filter(
    ({ question, note }) =>
      !search(sql, reader, question, { anyWord: true, limit: 8, now }).hits.some(
        (hit) => "noteId" in hit && hit.noteId === note,
      ),
  );
  return { asked: asked.length, missed };
}
