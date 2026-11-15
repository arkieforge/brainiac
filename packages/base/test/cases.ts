// The engine conformance suite: every case runs on a fresh database in bun:sqlite and in a Durable Object
// in workerd (engines.test.ts), so cloud and local are proved to run the same SQL the same way.
// Cases throw on failure, with node:assert, which both runtimes provide.
import { deepStrictEqual as same, equal, ok, throws } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  getNote,
  getNoteByPath,
  listNotes,
  migrate,
  putChunks,
  putNote,
  SCHEMA_VERSION,
  schemaVersion,
  search,
  type NoteInput,
  type Sql,
} from "../src/index.ts";
import { approvalCases } from "./approval-cases.ts";
import { mutateCases } from "./mutate-cases.ts";

export interface Fixture {
  readonly path: string;
  readonly raw: string;
}

export type CaseResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type Case = (sql: Sql, fixtures: readonly Fixture[]) => void;

const tables = (sql: Sql) =>
  sql
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name)
    // Engine internals: FTS5's shadow tables and the DO's own `_cf_` tables.
    .filter((name) => !/^chunks_fts_\w+_|^_cf_|^sqlite_/.test(name));

const ALL_TABLES = [
  "approvals",
  "audit",
  "changes",
  "checks",
  "chunks",
  "chunks_fts_normal",
  "chunks_fts_sensitive",
  "clients",
  "connections",
  "edges",
  "files",
  "inbox_leases",
  "jobs",
  "landed",
  "meta",
  "notes",
  "passkey_keys",
  "proposals",
  "questions",
  "results",
  "review_runs",
  "revisions",
  "schema",
  "secrets",
  "tokens",
  "vectors",
];

/** Fixture notes as the mutation path would store them; test scores are sensitive, as in the manifest. */
const asNotes = (fixtures: readonly Fixture[]): NoteInput[] =>
  fixtures
    .filter((fixture) => fixture.path.endsWith(".md"))
    .map((fixture, i) => ({
      id: String(parseNote(fixture.raw).data["id"]),
      path: fixture.path,
      raw: fixture.raw,
      rev: 1,
      hash: `hash-${i}`,
      seq: i + 1,
      class: fixture.path.startsWith("facts/tests/") ? "sensitive" : "normal",
    }));

const seed = (sql: Sql, fixtures: readonly Fixture[]) => {
  const notes = asNotes(fixtures);
  sql.transaction(() => notes.forEach((note) => putNote(sql, note)));
  return notes;
};

const byPath = (sql: Sql, path: string) => {
  const note = getNoteByPath(sql, path);
  ok(note, `no live note at ${path}`);
  return note;
};

export const cases: Record<string, Case> = {
  ...mutateCases,
  ...approvalCases,
  "a new record migrates to the latest version": (sql) => {
    same(migrate(sql), { from: 0, to: SCHEMA_VERSION });
    equal(schemaVersion(sql), SCHEMA_VERSION);
    same(tables(sql), ALL_TABLES);
  },

  // The shape every Base DO on main has before this package: a meta table at version 0.
  "a version 0 record migrates lazily, on first use": (sql) => {
    sql.all("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.all("INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', '0')");
    equal(schemaVersion(sql), 0);
    same(migrate(sql), { from: 0, to: SCHEMA_VERSION });
    same(tables(sql), ALL_TABLES);
  },

  "migrating an up-to-date record changes nothing and keeps its notes": (sql, fixtures) => {
    migrate(sql);
    const notes = seed(sql, fixtures);
    const before = listNotes(sql);
    same(migrate(sql), { from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    same(listNotes(sql), before);
    equal(before.length, notes.length);
  },

  // A rollback: the previous Worker wakes a record the new one already migrated.
  "a record newer than the code is left alone and still answers queries": (sql, fixtures) => {
    migrate(sql);
    const notes = seed(sql, fixtures);
    sql.all("UPDATE meta SET value = ? WHERE key = 'schemaVersion'", String(SCHEMA_VERSION + 1));
    same(migrate(sql), { from: SCHEMA_VERSION + 1, to: SCHEMA_VERSION + 1 });
    equal(listNotes(sql).length, notes.length);
  },

  "a failed migration leaves the record as it was": (sql) => {
    sql.all("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // A table a migration also creates makes it fail halfway.
    sql.all("CREATE TABLE audit (id INTEGER PRIMARY KEY)");
    throws(() => migrate(sql));
    equal(schemaVersion(sql), 0);
    same(tables(sql), ["audit", "meta"]);
  },

  "every fixture note round-trips with its raw text untouched": (sql, fixtures) => {
    migrate(sql);
    for (const note of seed(sql, fixtures)) {
      const row = getNote(sql, note.id);
      ok(row, note.path);
      equal(row.raw, note.raw);
      same(JSON.parse(row.fm), parseNote(note.raw).data);
      same(
        {
          path: row.path,
          rev: row.rev,
          hash: row.hash,
          seq: row.seq,
          class: row.class,
          deletedAt: row.deletedAt,
        },
        { path: note.path, rev: 1, hash: note.hash, seq: note.seq, class: note.class, deletedAt: null },
      );
    }
  },

  "hot front-matter fields are columns generated from the text": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const ielts = byPath(sql, "facts/tests/ielts-2026-11.md");
    same(
      {
        type: ielts.type,
        title: ielts.title,
        date: ielts.date,
        expires: ielts.expires,
        deadline: ielts.deadline,
      },
      {
        type: "TestScore",
        title: "IELTS Academic, November 2026",
        date: "2026-11-02",
        expires: "2028-11-02",
        deadline: null,
      },
    );
    const tum = byPath(sql, "applications/tum-msc-informatics-2027/application.md");
    same(
      { type: tum.type, kind: tum.kind, status: tum.status, deadline: tum.deadline },
      { type: "Application", kind: "university", status: "preparing", deadline: "2027-05-31" },
    );

    // An edit to the text moves the columns with it.
    putNote(sql, {
      ...ielts,
      raw: ielts.raw.replace("date: 2026-11-02", "date: 2026-11-09"),
      rev: 2,
      seq: 100,
    });
    equal(byPath(sql, "facts/tests/ielts-2026-11.md").date, "2026-11-09");
    // And queries on them use the indexes.
    const plan = sql
      .all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM notes WHERE deadline < '2028-01-01'")
      .map((row) => row.detail)
      .join("\n");
    ok(plan.includes("notes_deadline"), plan);
  },

  "listNotes filters by type, newest first, and skips tombstones": (sql, fixtures) => {
    migrate(sql);
    const notes = seed(sql, fixtures);
    same(
      listNotes(sql, { type: "TestScore" }).map((note) => note.path),
      ["facts/tests/ielts-2026-11.md", "facts/tests/ielts-2025-03.md"],
    );
    const old = byPath(sql, "facts/tests/ielts-2025-03.md");
    putNote(sql, { ...old, deletedAt: 1_000, rev: 2, seq: 100 });
    same(
      listNotes(sql, { type: "TestScore" }).map((note) => note.path),
      ["facts/tests/ielts-2026-11.md"],
    );
    equal(listNotes(sql).length, notes.length - 1);
    // The tombstone is still there by id, for undo and sync.
    equal(getNote(sql, old.id)?.deletedAt, 1_000);
    equal(getNoteByPath(sql, old.path), undefined);
  },

  "two live notes can't share a path, but a tombstone frees it": (sql, fixtures) => {
    migrate(sql);
    const [first] = seed(sql, fixtures);
    ok(first);
    const twin = { ...first, id: "01M6ZZZZZZZZZZZZZZZZZZZZZZ" };
    throws(() => putNote(sql, twin), /UNIQUE/);
    putNote(sql, { ...first, deletedAt: 1_000, rev: 2, seq: 100 });
    putNote(sql, twin);
    equal(byPath(sql, first.path).id, twin.id);
  },

  "the schema rejects values outside its enums": (sql, fixtures) => {
    migrate(sql);
    const [first] = asNotes(fixtures);
    ok(first);
    // @ts-expect-error: `secret` is not a note class; secrets live in the vault, never in notes.
    throws(() => putNote(sql, { ...first, class: "secret" }), /CHECK/);
  },

  "search finds words in one family only, and only live notes": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const tum = byPath(sql, "applications/tum-msc-informatics-2027/application.md");
    const ielts = byPath(sql, "facts/tests/ielts-2026-11.md");
    putChunks(sql, tum.id, tum.rev, [
      {
        family: "normal",
        header: "[Application · TUM MSc Informatics]",
        text: "Ask Dr Okafor for the first letter",
      },
    ]);
    putChunks(sql, ielts.id, ielts.rev, [
      { family: "sensitive", header: "[TestScore · IELTS Academic]", text: "Overall 8.0, listening 8.5" },
    ]);

    same(
      search(sql, "normal", "okafor letter").map((hit) => hit.noteId),
      [tum.id],
    );
    same(search(sql, "normal", "listening"), []);
    same(
      search(sql, "sensitive", "listening").map((hit) => hit.noteId),
      [ielts.id],
    );
    // Diacritics fold, and FTS5 syntax in the query is plain text.
    same(
      search(sql, "normal", "Okáfor").map((hit) => hit.noteId),
      [tum.id],
    );
    same(search(sql, "normal", 'letter" OR "listening'), []);
    same(search(sql, "normal", "   "), []);

    putNote(sql, { ...tum, deletedAt: 1_000, rev: 2, seq: 100 });
    same(search(sql, "normal", "okafor"), []);
  },

  "re-indexing a note replaces its chunks in both families": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const role = byPath(sql, "facts/roles/acme-intern-2025.md");
    putChunks(sql, role.id, 1, [{ family: "normal", header: "[Role]", text: "transit routing intern" }]);
    // The note turns sensitive: its words leave the normal index in the same call.
    putNote(sql, { ...role, class: "sensitive", rev: 2, seq: 100 });
    putChunks(sql, role.id, 2, [{ family: "sensitive", header: "[Role]", text: "transit routing intern" }]);
    same(search(sql, "normal", "transit"), []);
    same(
      search(sql, "sensitive", "transit").map((hit) => hit.noteId),
      [role.id],
    );
    same(sql.all("SELECT rev, family FROM chunks WHERE noteId = ?", role.id), [
      { rev: 2, family: "sensitive" },
    ]);
  },

  "a normal-family hit on a note that turned sensitive is dropped": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const role = byPath(sql, "facts/roles/acme-intern-2025.md");
    putChunks(sql, role.id, 1, [{ family: "normal", header: "[Role]", text: "transit routing intern" }]);
    putNote(sql, { ...role, class: "sensitive", rev: 2, seq: 100 });
    same(search(sql, "normal", "transit"), []);
  },
};

export function runCase(name: string, sql: Sql, fixtures: readonly Fixture[]): CaseResult {
  const run = cases[name];
  if (!run) return { ok: false, error: `no case named ${name}` };
  try {
    run(sql, fixtures);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
}
