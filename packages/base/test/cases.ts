// The engine conformance suite: every case runs on a fresh database in bun:sqlite and in a Durable Object
// in workerd (engines.test.ts), so cloud and local are proved to run the same SQL the same way.
// Cases throw on failure, with node:assert, which both runtimes provide.
import { deepStrictEqual as same, equal, ok, throws } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  chunkNote,
  getNote,
  getNoteByPath,
  listNotes,
  migrate,
  putChunks,
  putNote,
  quantize,
  SCHEMA_VERSION,
  schemaVersion,
  PERSON,
  search,
  type Results,
  type NoteInput,
  type Principal,
  type Sql,
} from "../src/index.ts";
import { approvalCases } from "./approval-cases.ts";
import { fillCases } from "./fill-cases.ts";
import { connectionCases } from "./connection-cases.ts";
import { githubCases } from "./github-cases.ts";
import { importCases } from "./import-cases.ts";
import { ingestCases } from "./ingest-cases.ts";
import { linksCases } from "./links-cases.ts";
import { mutateCases } from "./mutate-cases.ts";
import { orcidCases } from "./orcid-cases.ts";
import { papersCases } from "./papers-cases.ts";
import { privacyCases } from "./privacy-cases.ts";
import { profilesCases } from "./profiles-cases.ts";
import { remindersCases } from "./reminders-cases.ts";
import { vaultCases } from "./vault-cases.ts";
import { toolCases } from "./tool-cases.ts";

/** A connection without the sensitive scope, as every connection starts. */
export const AGENT: Principal = { sensitive: false };

/** What search found: note ids, and a file's sha256 for one of its pages. */
export const hitIds = (results: Results) =>
  results.hits.map((hit) => ("noteId" in hit ? hit.noteId : hit.fileSha));

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
  "file_tokens",
  "files",
  "fills",
  "github_repos",
  "inbox_leases",
  "jobs",
  "landed",
  "meta",
  "notes",
  "orcid_works",
  "passkey_keys",
  "proposals",
  "questions",
  "reminders",
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

const ROLE = "facts/roles/acme-intern-2025.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const BSC = "facts/education/bsc-northvale.md";
const IELTS = "facts/tests/ielts-2026-11.md";

/** The fixture student's notes in the scripts the tokenizer must keep whole; the Arabic is vocalized. */
const SCRIPTS = {
  bangla: "আমি ঢাকা বিশ্ববিদ্যালয়ে কম্পিউটার বিজ্ঞান পড়েছি",
  hindi: "मैंने दिल्ली विश्वविद्यालय में कंप्यूटर विज्ञान पढ़ा",
  arabic: "دَرَسْتُ عُلُومَ الحَاسُوبِ فِي جَامِعَةِ القَاهِرَةِ",
  joined: "বিশ্ববিদ্যালয়ের র\u200D্যাংকিং. می\u200Cخواهم",
};

/** What search found, with each hit's fused score. */
const scores = (results: Results) =>
  results.hits.map((hit) => ["noteId" in hit ? hit.noteId : hit.fileSha, hit.score]);

const byPath = (sql: Sql, path: string) => {
  const note = getNoteByPath(sql, path);
  ok(note, `no live note at ${path}`);
  return note;
};

export const cases: Record<string, Case> = {
  ...mutateCases,
  ...approvalCases,
  ...connectionCases,
  ...privacyCases,
  ...vaultCases,
  ...fillCases,
  ...ingestCases,
  ...linksCases,
  ...remindersCases,
  ...papersCases,
  ...profilesCases,
  ...toolCases,
  ...githubCases,
  ...orcidCases,
  ...importCases,
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

  "search reads only the families its principal may see, and only live notes": (sql, fixtures) => {
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

    same(hitIds(search(sql, AGENT, "okafor letter")), [tum.id]);
    same(hitIds(search(sql, AGENT, "listening")), []);
    same(hitIds(search(sql, PERSON, "listening")), [ielts.id]);
    // Diacritics fold, and FTS5 syntax in the query is plain text.
    same(hitIds(search(sql, AGENT, "Okáfor")), [tum.id]);
    same(hitIds(search(sql, AGENT, 'letter" OR "listening')), []);
    same(hitIds(search(sql, AGENT, "   ")), []);

    putNote(sql, { ...tum, deletedAt: 1_000, rev: 2, seq: 100 });
    same(hitIds(search(sql, AGENT, "okafor")), []);
  },

  "re-indexing a note replaces its chunks in both families": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const role = byPath(sql, "facts/roles/acme-intern-2025.md");
    putChunks(sql, role.id, 1, [{ family: "normal", header: "[Role]", text: "transit routing intern" }]);
    // The note turns sensitive: its words leave the normal index in the same call.
    putNote(sql, { ...role, class: "sensitive", rev: 2, seq: 100 });
    putChunks(sql, role.id, 2, [{ family: "sensitive", header: "[Role]", text: "transit routing intern" }]);
    same(hitIds(search(sql, AGENT, "transit")), []);
    same(hitIds(search(sql, PERSON, "transit")), [role.id]);
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
    same(hitIds(search(sql, AGENT, "transit")), []);
  },

  "a chunk from an older revision only nominates its note: the current text decides": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const [role, tum] = [ROLE, TUM].map((path) => byPath(sql, path));
    ok(role && tum);
    const index = (note: typeof role, text: string, vector: number[]) =>
      putChunks(sql, note.id, note.rev, [
        { family: "normal", header: `[${note.type}]`, text, vector: quantize(vector) },
      ]);
    // Indexed at rev 1 with these words, then edited, and not re-indexed yet.
    index(role, "fleet telemetry firmware art", [0.8, 0.6]);
    index(tum, "telemetry from the portal", [1, 0]);
    const raw = role.raw.replace("fleet telemetry dashboard", "telemetry planner artist");
    putNote(sql, { ...role, raw, rev: 2, seq: 100 });
    const found = (q: string, query = {}) =>
      search(sql, AGENT, q, query).hits.map((h) => ["noteId" in h && h.noteId, h.matched]);
    // Still there: matched, and the snippet is the new text.
    same(found("telemetry"), [
      [role.id, "words"],
      [tum.id, "words"],
    ]);
    ok(search(sql, AGENT, "telemetry").hits[0]?.snippet.includes("telemetry planner artist"));
    // Gone, wholly or in part, or only the start of a longer word now: no match.
    same(found("firmware"), []);
    same(found("telemetry firmware"), []);
    same(found("art"), []);
    // An old match neither lifts a hit by meaning nor takes a place under the limit.
    same(found("firmware", { vector: [1, 0] }), [
      [tum.id, "meaning"],
      [role.id, "meaning"],
    ]);
    same(found("telemetry firmware", { limit: 1 }), []);
    same(found("telemetry art", { vector: [0.8, 0.6], limit: 1 }), [[role.id, "meaning"]]);
    // A word that cuts into several is those words in a row, as FTS5 reads it.
    index(tum, "transit-apps in the portal", [1, 0]);
    putNote(sql, {
      ...tum,
      raw: tum.raw.replace("Ask Dr Okafor", "transit and other apps. Ask Dr Okafor"),
      rev: 2,
      seq: 200,
    });
    same(found("transit-apps"), []);
    same(found("apps transit"), [[tum.id, "words"]]);
    // Nor across the header and the text: the current header ends "Winter 2027]" and the text starts "kind".
    index(tum, "2027 kind of intake", [1, 0]);
    same(found("2027-kind"), []);
  },

  "old matches never fill the keyword ranking's pool ahead of a current one": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    for (let i = 0; i < 120; i++) {
      const id = `01M6P00L${String(i).padStart(18, "0")}`;
      const raw = `---\nid: ${id}\ntype: Note\ntitle: Cluster ${i}\n---\nkubernetes kubernetes cluster\n`;
      const path = `notes/cluster-${i}.md`;
      putNote(sql, { id, path, raw, rev: 1, hash: id, seq: 1000 + i, class: "normal" });
      putChunks(sql, id, 1, [
        { family: "normal", header: `[Note · Cluster ${i}]`, text: "kubernetes kubernetes cluster" },
      ]);
      // Edited since: the word is gone, and the re-index hasn't run.
      const edited = raw.replace("kubernetes kubernetes", "nomad");
      putNote(sql, { id, path, raw: edited, rev: 2, hash: id, seq: 2000 + i, class: "normal" });
    }
    const role = byPath(sql, ROLE);
    const filler = "Kept the robots running. ".repeat(20);
    const raw = role.raw.replace("Built the fleet", `${filler}I also ran kubernetes once. Built the fleet`);
    putNote(sql, { ...role, raw, rev: 2, seq: 3000 });
    const note = getNote(sql, role.id);
    ok(note);
    putChunks(sql, role.id, 2, chunkNote(note));
    same(hitIds(search(sql, AGENT, "kubernetes")), [role.id]);
  },

  "a retitled note's snippet still comes from the section that matched": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const role = byPath(sql, ROLE);
    const long = `${"Kept the robots running through the night shift. ".repeat(50)}\n\n## Plan\n\nShip the firmware fix.\n`;
    putNote(sql, { ...role, raw: `${role.raw}${long}`, rev: 2, seq: 100 });
    const indexed = getNote(sql, role.id);
    ok(indexed);
    putChunks(sql, role.id, 2, chunkNote(indexed));
    // The title is in every chunk's header, so after a retitle no old header is current.
    const raw = indexed.raw.replace("title: Software Engineering Intern, Acme Robotics", "title: SWE intern");
    putNote(sql, { ...indexed, raw, rev: 3, seq: 101 });
    const [hit] = search(sql, AGENT, "firmware").hits;
    equal(hit?.snippet, "Ship the firmware fix.");
  },

  "vectors rank by exact cosine and fuse with keywords by reciprocal rank": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const [role, tum, bsc, ielts] = [ROLE, TUM, BSC, IELTS].map((path) => byPath(sql, path));
    ok(role && tum && bsc && ielts);
    const put = (note: typeof role, text: string, vector: number[]) =>
      putChunks(sql, note.id, note.rev, [
        { family: note.class, header: `[${note.type}]`, text, vector: quantize(vector) },
      ]);
    put(role, "fleet telemetry dashboard", [1, 0, 0]);
    put(tum, "telemetry from the portal", [0.5, 0.8, 0]);
    put(bsc, "named entity recognition", [0, 1, 0.1]);
    // Nearest of all, but sensitive.
    put(ielts, "listening and writing", [0, 1, 0.1]);
    const vector = [0, 1, 0.1];
    // Keyword ranks role 1, tum 2; cosine ranks bsc 1, tum 2, role 3. Fused, by 1 / (60 + rank):
    same(scores(search(sql, AGENT, "telemetry", { vector })), [
      [role.id, 1 / 61 + 1 / 63],
      [tum.id, 1 / 62 + 1 / 62],
      [bsc.id, 1 / 61],
    ]);
    same(
      search(sql, AGENT, "telemetry", { vector }).hits.map((hit) => hit.matched),
      ["both", "both", "meaning"],
    );
    equal(search(sql, AGENT, "telemetry", { vector }).mode, "hybrid");
    ok(hitIds(search(sql, PERSON, "telemetry", { vector })).includes(ielts.id));
    same(search(sql, AGENT, "telemetry", { vector, limit: 1 }).hits.length, 1);
    // A limit is a whole number from 0 to 100, whatever a caller passes.
    for (const [limit, count] of [
      [-1, 0],
      [Number.NaN, 0],
      [1.5, 1],
      [1e9, 3],
    ] as const) {
      same(search(sql, AGENT, "telemetry", { vector, limit }).hits.length, count, String(limit));
    }
    // Without a vector, keyword-only, and it says so.
    const keyword = search(sql, AGENT, "telemetry");
    same([keyword.mode, hitIds(keyword)], ["keyword", [role.id, tum.id]]);
    // A question embedded another way, or vectors from another model, can't be compared: keyword-only.
    equal(search(sql, AGENT, "telemetry", { vector: [0, 1, 0.1, 0] }).mode, "keyword");
    sql.all("UPDATE vectors SET model = 'another-model'");
    equal(search(sql, AGENT, "telemetry", { vector }).mode, "keyword");
  },

  "a limit only cuts the fused ranking: it never changes which hit comes first": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const [role, tum, bsc] = [ROLE, TUM, BSC].map((path) => byPath(sql, path));
    ok(role && tum && bsc);
    putChunks(sql, role.id, role.rev, [
      { family: "normal", header: "[Role]", text: "fleet telemetry dashboard" },
    ]);
    putChunks(sql, tum.id, tum.rev, [
      { family: "normal", header: "[Application]", text: "telemetry", vector: quantize([0.6, 0.8]) },
    ]);
    putChunks(sql, bsc.id, bsc.rev, [
      { family: "normal", header: "[Education]", text: "named entities", vector: quantize([0, 1]) },
    ]);
    // Second by words and by meaning, first fused.
    const vector = [0, 1];
    same(hitIds(search(sql, AGENT, "telemetry", { vector })), [tum.id, bsc.id, role.id]);
    same(hitIds(search(sql, AGENT, "telemetry", { vector, limit: 1 })), [tum.id]);
  },

  "one long note can't crowd other matches out of the keyword ranking": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const [role, tum] = [ROLE, TUM].map((path) => byPath(sql, path));
    ok(role && tum);
    const sections = Array.from({ length: 150 }, (_, i) => ({
      family: "normal" as const,
      header: `[Role › Part ${i}]`,
      text: "telemetry telemetry telemetry",
    }));
    putChunks(sql, role.id, role.rev, sections);
    putChunks(sql, tum.id, tum.rev, [{ family: "normal", header: "[Application]", text: "telemetry once" }]);
    same(hitIds(search(sql, AGENT, "telemetry")), [role.id, tum.id]);
  },

  "a snippet finds the matched word however it is written, and starts there": (sql, fixtures) => {
    migrate(sql);
    seed(sql, fixtures);
    const role = byPath(sql, ROLE);
    const filler = "Kept the robots running through the night shift. ".repeat(12);
    const raw = role.raw.replace("Built the fleet", `${filler}Dr Okáfor reviewed the fleet`);
    putNote(sql, { ...role, raw, rev: 2, seq: 100 });
    const note = getNote(sql, role.id);
    ok(note);
    putChunks(sql, role.id, 2, chunkNote(note));
    const [hit] = search(sql, AGENT, "okafor").hits;
    ok(hit?.snippet.startsWith("…") && hit.snippet.includes("Dr Okáfor reviewed"), hit?.snippet);
    // Stretched with tatweel, and a word that only ends like another doesn't count as it.
    const arabic = role.raw.replace(
      "Built the fleet",
      `start artist ${filler}the جـامـعـة art fleet, by Ọ̀ṣun`,
    );
    putNote(sql, { ...role, raw: arabic, rev: 3, seq: 101 });
    const stretched = getNote(sql, role.id);
    ok(stretched);
    putChunks(sql, role.id, 3, chunkNote(stretched));
    for (const [question, word] of [
      ["جامعة", "جـامـعـة"],
      ["art -", "art fleet"],
      // Two marks on one letter, which NFC can't join into it.
      ["osun", "Ọ̀ṣun"],
      // A word that cuts into several, as FTS5 matches it: those words in a row.
      ["fleet-by", "fleet, by"],
    ] as const) {
      const snippet = search(sql, AGENT, question).hits[0]?.snippet ?? "";
      ok(snippet.startsWith("…") && snippet.includes(word), `${question}: ${snippet}`);
    }
  },

  "Bangla, Hindi and Arabic words match whole, with or without harakat": (sql) => {
    migrate(sql);
    const ids = Object.entries(SCRIPTS).map(([title, body], i) => {
      const id = `01M6SCR1PT00000000000000${i}${i}`;
      const raw = `---\nid: ${id}\ntype: Note\ntitle: ${title}\n---\n${body}\n`;
      putNote(sql, { id, path: `notes/${title}.md`, raw, rev: 1, hash: title, seq: i + 1, class: "normal" });
      const note = getNote(sql, id);
      ok(note);
      putChunks(sql, id, 1, chunkNote(note));
      return id;
    });
    const [bangla, hindi, arabic, joined] = ids;
    same(hitIds(search(sql, AGENT, "বিশ্ববিদ্যালয়ে")), [bangla]);
    // The same word with য় typed as two code points.
    same(hitIds(search(sql, AGENT, "বিশ্ববিদ্যাল\u09AF\u09BCে")), [bangla]);
    same(hitIds(search(sql, AGENT, "विश्वविद्यालय कंप्यूटर")), [hindi]);
    // A piece of a word, cut at a vowel sign, is not a word.
    same(hitIds(search(sql, AGENT, "কম")), []);
    same(hitIds(search(sql, AGENT, "क")), []);
    // The text is vocalized; the question isn't, then is.
    same(hitIds(search(sql, AGENT, "جامعة القاهرة")), [arabic]);
    same(hitIds(search(sql, AGENT, "جَامِعَةِ")), [arabic]);
    // র‍্য is typed with a zero-width joiner, which unicode61 reads as a space; Persian and Urdu use a ZWNJ.
    same(hitIds(search(sql, AGENT, "র্যাংকিং")), [joined]);
    same(hitIds(search(sql, AGENT, "্যাংকিং")), []);
    same(hitIds(search(sql, AGENT, "میخواهم")), [joined]);
  },

  "the tokenizer migration keeps every chunk searchable, as whole words": (sql) => {
    migrate(sql);
    // The record as the version before it left it: unicode61 cutting words at combining marks.
    for (const family of ["normal", "sensitive"]) {
      sql.all(`DROP TABLE chunks_fts_${family}`);
      sql.all(
        `CREATE VIRTUAL TABLE chunks_fts_${family} USING fts5(header, text, tokenize = 'unicode61 remove_diacritics 2')`,
      );
    }
    const id = "01M6SCR1PT000000000000MIGR";
    const raw = `---\nid: ${id}\ntype: Note\ntitle: Bangla\n---\n${SCRIPTS.bangla}\n`;
    putNote(sql, { id, path: "notes/bangla.md", raw, rev: 1, hash: "bn", seq: 1, class: "normal" });
    const note = getNote(sql, id);
    ok(note);
    putChunks(sql, id, 1, chunkNote(note));
    // Back to the version before the tokenizer migration, without what the ones after it added (the leases' rev,
    // the fills table, the sync clients' owners, the secrets' proposals, the files' paths and names, the audit
    // rows' background mark, the ORCID works proposed, the files' upload times and shares, the expiry reminders).
    sql.all("ALTER TABLE inbox_leases DROP COLUMN rev");
    sql.all("DROP TABLE fills");
    sql.all("ALTER TABLE clients DROP COLUMN actor");
    sql.all("ALTER TABLE secrets DROP COLUMN proposalId");
    sql.all("DROP INDEX files_path");
    sql.all("ALTER TABLE files DROP COLUMN path");
    sql.all("ALTER TABLE files DROP COLUMN name");
    sql.all("ALTER TABLE audit DROP COLUMN background");
    sql.all("DROP TABLE orcid_works");
    sql.all("ALTER TABLE files DROP COLUMN uploadedAt");
    sql.all("ALTER TABLE files DROP COLUMN sharedAt");
    sql.all("ALTER TABLE files DROP COLUMN shares");
    sql.all("DROP TABLE reminders");
    sql.all("INSERT INTO audit (at, actor, tool, noteIds) VALUES (1, 'connection:old', 'get', '[]')");
    sql.all("UPDATE meta SET value = ? WHERE key = 'schemaVersion'", String(SCHEMA_VERSION - 10));
    // The bug: a fragment matched inside other words.
    same(hitIds(search(sql, AGENT, "কম")), [id]);
    same(migrate(sql), { from: SCHEMA_VERSION - 10, to: SCHEMA_VERSION });
    // A row from before the background mark reads as a foreground call.
    same(sql.all("SELECT background FROM audit"), [{ background: 0 }]);
    same(hitIds(search(sql, AGENT, "কম্পিউটার")), [id]);
    same(hitIds(search(sql, AGENT, "কম")), []);
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
