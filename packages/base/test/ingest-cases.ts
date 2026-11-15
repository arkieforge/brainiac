// Conformance cases for ingest: a PDF's extracted text goes through the vault's checks before anything is
// indexed, a cleared file's pages are searched only by who may see them, results for an older revision never
// install, and vectors are stored as int8 with their model. cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { ulid } from "@brainiac/core";

import {
  classifyFile,
  connect,
  dataKey,
  dequantize,
  dueJobs,
  EMBED_MODEL,
  fileOwner,
  finishJob,
  getFile,
  grant,
  IN_FLIGHT,
  INDEX_VERSION,
  installFile,
  jobInput,
  LEASE_MS,
  markDispatched,
  mayClear,
  migrate,
  mutate,
  nextWake,
  pdfHidesText,
  PERSON,
  putChunks,
  quantize,
  readText,
  recordUpload,
  reindex,
  search,
  sealFile,
  type Context,
  type Sql,
} from "../src/index.ts";
import { AGENT, hitIds, type Case, type Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const human: Context = { actor: "human", now: T0 };

// The fixture student's passport, issued by ICAO's specimen state Utopia (UTO): nobody real.
const MRZ = "P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<\nXK12345679UTO0103141F3105043<<<<<<<<<<<<<<04\n";
const PAGES = [
  "Northvale University transcript\nSemester 1 GPA 3.1",
  "Semester 2 GPA 3.4\nThesis on transit apps",
];

function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  ok(manifest);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  return dataKey(sql, "the stage's vault key");
}

/** A PDF as the DO records it: sealed, no text until a `file` job extracts it. */
function uploadPdf(sql: Sql, key: Uint8Array, content: string, ctx: Context, kind?: string) {
  const bytes = Buffer.from(`%PDF-1.7\n${content}`);
  const { sha256 } = sealFile(key, bytes);
  const upload = { sha256, r2Key: `blobs/test/${sha256}`, mime: "application/pdf", bytes: bytes.length };
  const result = recordUpload(sql, key, { ...upload, text: undefined, ...(kind && { kind }) }, ctx);
  ok("file" in result, JSON.stringify(result));
  return sha256;
}

/** The file's pending job, as the consumer gets it. */
function fileJob(sql: Sql, sha256: string) {
  const job = dueJobs(sql, T0).find((j) => j.noteId === fileOwner(sha256));
  ok(job, "no file job");
  const input = jobInput(sql, job.id);
  ok(input && "file" in input);
  return { id: job.id, file: input.file };
}

const text = (pages: readonly string[]) => ({ text: pages.join("\n"), pages });
// One vector per page, as the consumer embeds `chunkFile`'s chunks.
const vectors = (n: number) => Array.from({ length: n }, (_, i) => quantize([i + 1, -0.5, 0.25]));

/** A one-stream PDF, as far as `pdfHidesText` reads one. */
const flatePdf = (stream: Uint8Array) =>
  Buffer.concat([
    Buffer.from("%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"),
    stream,
    Buffer.from("\nendstream\n"),
  ]);

export const ingestCases: Record<string, Case> = {
  "a PDF is extracted before its checks run, and only a cleared one's pages are searched": (
    sql,
    fixtures,
  ) => {
    const key = record(sql, fixtures);
    const sha256 = uploadPdf(sql, key, PAGES.join("\f"), human, "transcript");
    // Nothing has read it yet: unclassified, and a job to extract it.
    same([getFile(sql, sha256)?.checks, getFile(sql, sha256)?.class], ["unreadable", "unclassified"]);
    const job = fileJob(sql, sha256);
    equal(mayClear(job.file), true);
    same(hitIds(search(sql, PERSON, "transit")), []);

    equal(installFile(sql, key, job.id, text(PAGES), vectors(2), T0), "installed");
    const file = getFile(sql, sha256);
    same([file?.checks, file?.class, file?.pages], ["clean", "sensitive", 2]);
    // Cleared files are sensitive: the person finds the page, a connection without the scope finds nothing.
    same(
      search(sql, PERSON, "transit").hits.map((hit) => ("page" in hit ? [hit.fileSha, hit.page] : hit)),
      [[sha256, 2]],
    );
    same(hitIds(search(sql, AGENT, "transit")), []);
    same(hitIds(search(sql, { sensitive: true, types: ["Education"] }, "transit")), []);
    // Stored as int8 with the model, one per page.
    const stored = sql.all<{ model: string; q: ArrayBuffer | Uint8Array }>(
      `SELECT model, q FROM vectors JOIN chunks ON chunks.id = vectors.chunkId WHERE chunks.noteId = ?
       ORDER BY chunks.page`,
      fileOwner(sha256),
    );
    same(
      stored.map((row) => [row.model, Array.from(dequantize(row.q))]),
      [
        [EMBED_MODEL, [127, -63, 32]],
        [EMBED_MODEL, [127, -32, 16]],
      ],
    );
  },

  "what extraction finds keeps a PDF in the vault, and its passport is written as the uploader": (
    sql,
    fixtures,
  ) => {
    const key = record(sql, fixtures);
    // An agent's upload waits as a proposal, as it would have at upload time.
    const floor = connect(sql, { kind: "cli" }, T0);
    const signed = { credentialId: "passkey-1", counter: 1, assertion: "{}" };
    const granted = grant(sql, { ...floor, connectionId: floor.id, sensitive: true }, signed);
    ok("connection" in granted, JSON.stringify(granted));
    const agent = granted.connection;
    const via: Context = { actor: `connection:${agent.id}`, connection: agent, now: T0 };
    const other = uploadPdf(sql, key, `Passport\n${MRZ}`, via);
    equal(installFile(sql, key, fileJob(sql, other).id, text([`Passport\n${MRZ}`]), [], T0), "installed");
    same([getFile(sql, other)?.class, getFile(sql, other)?.noteId], ["vault", null]);
    same(
      sql.all<{ actor: string }>("SELECT actor FROM proposals WHERE status = 'open'").map((p) => p.actor),
      [via.actor],
    );

    const sha256 = uploadPdf(sql, key, MRZ, human);
    const job = fileJob(sql, sha256);
    // Unconfirmed, so the consumer embeds nothing.
    equal(mayClear(job.file), false);
    equal(installFile(sql, key, job.id, text([MRZ]), [], T0), "installed");
    const file = getFile(sql, sha256);
    same([file?.checks, file?.findings, file?.class], ["found", '["mrz"]', "vault"]);
    // The person's own upload writes the note; the agent's proposal never took its path.
    ok(file?.noteId);
    same(hitIds(search(sql, PERSON, "UTO")), []);
    // Confirming any kind keeps it there, and nothing is indexed.
    ok("file" in classifyFile(sql, sha256, "transcript", human));
    equal(getFile(sql, sha256)?.class, "vault");
    same(sql.all("SELECT id FROM chunks WHERE noteId = ?", fileOwner(sha256)), []);
    // What the checks found means the job embeds nothing next time.
    const vaulted = getFile(sql, sha256);
    ok(vaulted);
    equal(mayClear(vaulted), false);

    // A later extraction (a new pipeline) of the agent's passport doesn't parse it again: its proposal waits.
    sql.all("UPDATE files SET pipelineVersion = 0 WHERE sha256 = ?", other);
    reindex(sql);
    equal(installFile(sql, key, fileJob(sql, other).id, text([`Passport\n${MRZ}`]), [], T0), "installed");
    equal(sql.all("SELECT id FROM proposals WHERE status = 'open'").length, 1);
  },

  "a page that needs reading keeps the whole file unclassified": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const sha256 = uploadPdf(sql, key, `${PAGES[0]}\f`, human, "transcript");
    const job = fileJob(sql, sha256);
    // Page 2's text came out garbled: what it says isn't what the checks read.
    equal(
      installFile(sql, key, job.id, text([PAGES[0] ?? "", "\uFFFD\uFFFD 3.\uFFFD"]), vectors(1), T0),
      "installed",
    );
    same([getFile(sql, sha256)?.checks, getFile(sql, sha256)?.class], ["unreadable", "unclassified"]);
    same(hitIds(search(sql, PERSON, "Northvale")), []);
    // So is a PDF with no text at all: outlines, say, which the checks can't read.
    const outlines = uploadPdf(sql, key, "\f", human, "transcript");
    equal(installFile(sql, key, fileJob(sql, outlines).id, text(["\n", "\n\n"]), [], T0), "installed");
    equal(getFile(sql, outlines)?.class, "unclassified");
    // A blank page among pages with text is read.
    const blank = uploadPdf(sql, key, `${PAGES[0]}\f\f`, human, "transcript");
    equal(
      installFile(sql, key, fileJob(sql, blank).id, text([PAGES[0] ?? "", "\n"]), vectors(1), T0),
      "installed",
    );
    equal(getFile(sql, blank)?.class, "sensitive");
    // Text that isn't in toMarkdown's page shape is unread too.
    const other = uploadPdf(sql, key, "odd", human, "transcript");
    equal(
      installFile(sql, key, fileJob(sql, other).id, { text: "odd", pages: undefined }, [], T0),
      "installed",
    );
    equal(getFile(sql, other)?.checks, "unreadable");
  },

  "a cleared plain-text file is indexed as one page, read whole": (sql, fixtures) => {
    const key = record(sql, fixtures);
    // A table with no numbers would need reading in a PDF; in plain text every byte is there.
    const notes = "| Course | Teacher |\n| --- | --- |\n| Thesis | Dr Okafor |\n";
    const bytes = Buffer.from(notes);
    const { sha256 } = sealFile(key, bytes);
    const upload = { sha256, r2Key: `blobs/test/${sha256}`, mime: "text/markdown", bytes: bytes.length };
    ok(
      "file" in
        recordUpload(sql, key, { ...upload, text: readText(bytes, "text/markdown"), kind: "notes" }, human),
    );
    equal(getFile(sql, sha256)?.class, "sensitive");
    equal(installFile(sql, key, fileJob(sql, sha256).id, text([notes]), vectors(1), T0), "installed");
    equal(getFile(sql, sha256)?.class, "sensitive");
    same(hitIds(search(sql, PERSON, "Okafor")), [sha256]);
  },

  "a result for a file the person confirmed since is dropped, and the new revision has its own job": (
    sql,
    fixtures,
  ) => {
    const key = record(sql, fixtures);
    const sha256 = uploadPdf(sql, key, PAGES.join("\f"), human);
    const old = fileJob(sql, sha256);
    ok("file" in classifyFile(sql, sha256, "transcript", human));
    equal(installFile(sql, key, old.id, text(PAGES), [], T0), "dropped");
    same([getFile(sql, sha256)?.checks, getFile(sql, sha256)?.pipelineVersion], ["unreadable", 0]);
    const fresh = fileJob(sql, sha256);
    equal(fresh.file.rev, 1);
    equal(installFile(sql, key, fresh.id, text(PAGES), vectors(2), T0), "installed");
    equal(hitIds(search(sql, PERSON, "transit")).length, 1);
  },

  "a file moved to the vault leaves search in the same transaction": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const sha256 = uploadPdf(sql, key, PAGES.join("\f"), human, "transcript");
    equal(installFile(sql, key, fileJob(sql, sha256).id, text(PAGES), vectors(2), T0), "installed");
    equal(hitIds(search(sql, PERSON, "transit")).length, 1);
    // Tightening needs no passkey, and no job has run since.
    equal(getFile(sql, sha256)?.class, "sensitive");
    classifyFile(sql, sha256, "bank-statement", human);
    equal(getFile(sql, sha256)?.class, "vault");
    same(hitIds(search(sql, PERSON, "transit")), []);
    same(sql.all("SELECT chunkId FROM vectors"), []);
  },

  "a new index version re-indexes every note and cleared file once": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const role = fixtures.find((f) => f.path === "facts/roles/acme-intern-2025.md");
    ok(role);
    const created = mutate(sql, { op: "create", path: role.path, raw: role.raw, class: "normal" }, human);
    ok(created.status === "applied");
    const sha256 = uploadPdf(sql, key, PAGES.join("\f"), human, "transcript");
    equal(installFile(sql, key, fileJob(sql, sha256).id, text(PAGES), vectors(2), T0), "installed");
    sql.all("DELETE FROM jobs");
    // A record whose index an older version built.
    sql.all("INSERT INTO meta (key, value) VALUES ('index', 'chunks-0')");
    equal(reindex(sql), true);
    same(sql.all<{ kind: string; noteId: string }>("SELECT kind, noteId FROM jobs ORDER BY kind"), [
      { kind: "file", noteId: fileOwner(sha256) },
      { kind: "index", noteId: created.noteId },
    ]);
    same(sql.all("SELECT value FROM meta WHERE key = 'index'"), [{ value: INDEX_VERSION }]);
    equal(reindex(sql), false);
  },

  // The PDF check opens streams with node:zlib, which must behave the same in workerd and Bun.
  "a PDF's compressed text passes, and an image compressed twice inside it doesn't": () => {
    equal(pdfHidesText(flatePdf(deflateSync("BT /F1 12 Tf (Semester 1 GPA 3.1) Tj ET"))), false);
    equal(pdfHidesText(flatePdf(deflateSync(deflateSync("q BI /W 8 /H 8 ID \x00 EI Q")))), true);
  },

  "no more than IN_FLIGHT jobs are out at once, and the newest goes first": (sql, fixtures) => {
    record(sql, fixtures);
    const created = (n: number, now: number) =>
      Array.from({ length: n }, (_, i) => {
        const id = ulid(now);
        const raw = `---\nid: ${id}\ntype: InboxItem\n---\nItem ${i}\n`;
        const path = `inbox/${id.toLowerCase()}.md`;
        const made = mutate(sql, { op: "create", path, raw, class: "normal" }, { ...human, now });
        ok(made.status === "applied");
        return made.noteId;
      });
    // A backlog (a re-index, say), then an upload a moment later.
    const backlog = created(IN_FLIGHT + 5, T0);
    const [fresh] = created(1, T0);
    const first = dueJobs(sql, T0 + 1_000);
    equal(first.length, IN_FLIGHT);
    equal(first[0]?.noteId, fresh);
    markDispatched(
      sql,
      first.map((job) => job.id),
      T0 + 1_000,
    );
    // Full: nothing more goes out, and the record wakes when a lease runs out, not at once.
    same(dueJobs(sql, T0 + 1_000), []);
    equal(nextWake(sql, T0 + 1_000), T0 + 1_000 + LEASE_MS);
    // An install makes room for one more, from what is still waiting.
    const [done] = first;
    ok(done);
    equal(
      finishJob(sql, done.id, () => {}),
      "installed",
    );
    equal(nextWake(sql, T0 + 1_000), T0 + 1_000);
    const [next, ...none] = dueJobs(sql, T0 + 1_000);
    same(none, []);
    ok(next && backlog.includes(next.noteId) && !first.some((job) => job.id === next.id));
    markDispatched(sql, [next.id], T0 + 1_000);
    // Later, the first jobs' leases ran out while newer ones fill the queue: those are due, but can't go until
    // there's room, so the record doesn't wake for them over and over.
    const later = T0 + 1_000 + LEASE_MS;
    markDispatched(
      sql,
      dueJobs(sql, later).map((job) => job.id),
      later,
    );
    same(dueJobs(sql, later), []);
    equal(nextWake(sql, later), later + LEASE_MS);
  },

  "a job dispatched before a re-index never installs over it": (sql, fixtures) => {
    record(sql, fixtures);
    const role = fixtures.find((f) => f.path === "facts/roles/acme-intern-2025.md");
    ok(role);
    const created = mutate(sql, { op: "create", path: role.path, raw: role.raw, class: "normal" }, human);
    ok(created.status === "applied");
    const [old] = dueJobs(sql, T0);
    ok(old);
    markDispatched(sql, [old.id], T0);
    sql.all("INSERT INTO meta (key, value) VALUES ('index', 'chunks-0')");
    equal(reindex(sql), true);
    // Same note, same revision: only the job the re-index made may install.
    const stale = { family: "normal", header: "[Role]", text: "built the old way" } as const;
    equal(
      finishJob(sql, old.id, () => putChunks(sql, created.noteId, created.rev, [stale])),
      "dropped",
    );
    same(hitIds(search(sql, PERSON, "built the old way")), []);
    equal(dueJobs(sql, T0).length, 1);
  },
};
