// Conformance cases for the vault (contract §5): every upload starts unclassified and agent-invisible, is
// cleared only by clean checks plus the person's confirmation, and a passport's number goes to the vault.
// cases.ts runs them on both engines; apps/worker/test/vault.test.ts runs the DO's sealing and R2 half.
import { deepStrictEqual as same, equal, notEqual, ok, throws } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  classifyFile,
  connect,
  dataKey,
  getFile,
  getNote,
  grant,
  kindHash,
  migrate,
  readText,
  recordUpload,
  restrict,
  sealFile,
  unseal,
  type Classified,
  type Connection,
  type Context,
  type Signature,
  type Sql,
  type Uploaded,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const human: Context = { actor: "human", now: T0 };
const via = (connection: Connection): Context => ({
  actor: `connection:${connection.id}`,
  connection,
  now: T0,
});

// The fixture student's passport, issued by ICAO's specimen state Utopia (UTO): nobody real.
const PASSPORT = [
  "PASSPORT / PASSEPORT",
  "P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<",
  "XK12345679UTO0103141F3105043<<<<<<<<<<<<<<04",
  "",
].join("\n");
const TRANSCRIPT = "Northvale University\nStudent ID: 2019331001\nCGPA 3.82 on a scale of 4\n";
const STATEMENT = "Monthly statement\nIBAN: DE89 3704 0044 0532 0130 00\n";

let signatures = 0;
const signed = (): Signature => ({ credentialId: "passkey-1", counter: ++signatures, assertion: "{}" });

function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  ok(manifest);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  return dataKey(sql, "the stage's vault key");
}

function connectionFor(sql: Sql, grants: Partial<Pick<Connection, "level" | "sensitive">> = {}) {
  const made = connect(sql, { kind: "cli" }, T0);
  if (Object.keys(grants).length === 0) return made;
  const result = grant(sql, { ...made, connectionId: made.id, ...grants }, signed());
  ok("connection" in result, JSON.stringify(result));
  return result.connection;
}

function upload(sql: Sql, key: Uint8Array, content: string | Uint8Array, ctx: Context, kind?: string) {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const { sha256 } = sealFile(key, bytes);
  const result = recordUpload(
    sql,
    key,
    {
      sha256,
      r2Key: `blobs/test/${sha256}`,
      mime: "text/plain",
      bytes: bytes.length,
      text: readText(bytes, "text/plain"),
      ...(kind && { kind }),
    },
    ctx,
  );
  return { sha256, result };
}

const plain = (text: string, mime = "text/plain") => readText(Buffer.from(text), mime);

const fileOf = (result: Uploaded | Classified) => {
  ok("file" in result && result.file, JSON.stringify(result));
  return result.file;
};
const classOf = (sql: Sql, sha256: string) => getFile(sql, sha256)?.class;

export const vaultCases: Record<string, Case> = {
  "an upload starts unclassified, and an agent's kind is only a suggestion": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const agent = connectionFor(sql, { sensitive: true });
    const { sha256, result } = upload(sql, key, TRANSCRIPT, via(agent), "transcript");
    // The agent gets the summary: no size, type, kind or text.
    same(fileOf(result), {
      sha256,
      class: "unclassified",
      summary: "Unclassified document, waiting for you.",
    });
    same(getFile(sql, sha256)?.kind, "transcript");
    equal(getFile(sql, sha256)?.confirmedAt, null);
    // Nor can it confirm the kind itself.
    equal((classifyFile(sql, sha256, "transcript", via(agent)) as { status: string }).status, "forbidden");
    equal(classOf(sql, sha256), "unclassified");
  },

  "the person's confirmation clears a file the checks found clean": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const { sha256 } = upload(sql, key, TRANSCRIPT, human);
    const file = fileOf(classifyFile(sql, sha256, "transcript", human));
    ok("checks" in file);
    same([file.class, file.checks, file.findings, file.confirmed], ["sensitive", "clean", [], true]);
    // Cleared files are sensitive: no scope, no file; with it, what it is but still not its contents.
    same(upload(sql, key, TRANSCRIPT, via(connectionFor(sql))).result, { file: undefined });
    same(fileOf(upload(sql, key, TRANSCRIPT, via(connectionFor(sql, { sensitive: true }))).result), {
      sha256,
      class: "sensitive",
      kind: "transcript",
      mime: "text/plain",
      bytes: TRANSCRIPT.length,
    });
  },

  "a kind chosen at upload never skips the checks": (sql, fixtures) => {
    const key = record(sql, fixtures);
    // Mislabelled: a bank statement called a certificate stays in the vault.
    const { sha256, result } = upload(sql, key, STATEMENT, human, "certificate");
    const file = fileOf(result);
    ok("checks" in file);
    same([file.class, file.checks, file.findings, file.confirmed], ["vault", "found", ["iban"], true]);
    // So do grouped identity numbers, whatever they're called.
    for (const typed of [
      "Passport Number: XK 1234567",
      "National ID Number: 1990 1234 56789",
      "Visa No.: 12345678",
    ])
      equal(classOf(sql, upload(sql, key, typed, human, "certificate").sha256), "vault", typed);
    // Whatever kind the person picks later, what the checks found keeps it there.
    equal(fileOf(classifyFile(sql, sha256, "transcript", human)).class, "vault");
    // An agent with every scope gets the summary only.
    const agent = connectionFor(sql, { sensitive: true, level: "write" });
    same(fileOf(upload(sql, key, STATEMENT, via(agent)).result), {
      sha256,
      class: "vault",
      summary: "Vault document: only you can open it.",
      kind: "transcript",
      noteId: null,
    });
  },

  "a file the checks can't read is never cleared": (sql, fixtures) => {
    const key = record(sql, fixtures);
    // Only plain text, markdown or CSV can be read whole, and only bytes that hide nothing.
    equal(plain("CGPA 3.82"), "CGPA 3.82");
    equal(plain("CGPA 3.82", "text/markdown; charset=utf-8"), "CGPA 3.82");
    equal(plain("CGPA 3.82", "image/svg+xml"), undefined);
    equal(plain("CGPA 3.82", "text/html"), undefined);
    equal(plain("\n%PDF-1.7\nP<UTOKARIM<<NADIA"), undefined);
    equal(plain("<svg><text>IBAN DE&#56;&#57; 3704</text></svg>"), undefined);
    equal(plain("IBAN DE&#56;&#57; 3704 0044 0532 0130 00"), undefined);
    equal(plain(`![scan](data:image/png;base64,${"iVBORw0KGgo".repeat(30)})`), undefined);
    equal(readText(Uint8Array.of(0x50, 0x00, 0x41), "text/plain"), undefined);
    equal(readText(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), "text/plain"), undefined);
    equal(plain(`Scan: ${"89 50 4E 47 0D 0A 1A 0A ".repeat(20)}`), undefined);
    equal(plain(`${"89 50 4E 47 0D 0A 1A 0A 00 00 00 0D 49 48 44 52\n".repeat(16)}`), undefined);
    // Marks with letter grades or `AB` for absent aren't a hex dump.
    const marks = Array.from({ length: 70 }, (_, i) => (i % 9 === 0 ? "AB" : String(40 + (i % 50)))).join(
      " ",
    );
    equal(plain(marks), marks);
    const grades = Array.from(
      { length: 40 },
      (_, i) => `${["AA", "BA", "BB", "CB", "CC"][i % 5]} ${60 + i}`,
    ).join("\n");
    equal(plain(grades), grades);
    const sheet = Array.from(
      { length: 32 },
      (_, i) => `${["EEE", "ECE", "CE", "BE", "ACC"][i % 5]}${101 + i * 7} ${60 + i}`,
    ).join("\n");
    equal(plain(sheet), sheet);
    // An MRZ's fillers aren't markup.
    equal(plain(PASSPORT), PASSPORT);
    const { sha256 } = upload(sql, key, Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3), human, "transcript");
    const file = getFile(sql, sha256);
    same([file?.class, file?.checks, file?.confirmedAt], ["unclassified", "unreadable", T0]);
  },

  "a passport's MRZ goes to an IdDocument note and its number to the vault, sealed": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const { sha256, result } = upload(sql, key, PASSPORT, human);
    ok("note" in result && result.note?.status === "applied", JSON.stringify(result));
    const file = getFile(sql, sha256);
    same([file?.class, file?.checks, JSON.parse(file?.findings ?? "")], ["vault", "found", ["mrz"]]);
    const note = getNote(sql, file?.noteId ?? "");
    same([note?.path, note?.class], ["identity/passport-uto-2031-05-04.md", "sensitive"]);
    const name = `passport.uto.${sha256.slice(0, 12)}`;
    const { id: _, ...fields } = parseNote(note?.raw ?? "").data;
    same(fields, {
      type: "IdDocument",
      title: "Passport, UTO",
      kind: "passport",
      issuer: "UTO",
      number: `secret:${name}`,
      surname: "KARIM",
      given_names: "NADIA",
      nationality: "UTO",
      birth_date: "2001-03-14",
      sex: "F",
      expires: "2031-05-04",
    });
    // The number is nowhere in the record but sealed in its secret.
    const [secret] = sql.all<{ name: string; ciphertext: string; policy: string }>(
      "SELECT name, ciphertext, policy FROM secrets",
    );
    same([secret?.name, secret?.policy], [name, "ask"]);
    const sealed = Buffer.from(secret?.ciphertext ?? "", "base64");
    ok(!sealed.toString("latin1").includes("XK1234567"));
    equal(Buffer.from(unseal(key, sealed, `secret:${name}`)).toString(), "XK1234567");
    throws(() => unseal(key, sealed, "secret:another"));
    const everything =
      JSON.stringify(sql.all("SELECT * FROM notes")) + JSON.stringify(sql.all("SELECT * FROM files"));
    ok(!everything.includes("XK1234567"));
  },

  "an agent that uploads a passport learns nothing it couldn't see": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const blind = connectionFor(sql, { level: "write" });
    const { sha256, result } = upload(sql, key, PASSPORT, via(blind));
    // No note result (it's sensitive), no kind, no note id.
    same(result, { file: { sha256, class: "vault", summary: "Vault document: only you can open it." } });
    const noteId = getFile(sql, sha256)?.noteId;
    ok(noteId && getNote(sql, noteId));
    // With the scope it sees which note holds the fields, never the file.
    const scoped = connectionFor(sql, { sensitive: true });
    same(fileOf(upload(sql, key, PASSPORT, via(scoped)).result), {
      sha256,
      class: "vault",
      summary: "Vault document: only you can open it.",
      kind: null,
      noteId,
    });
  },

  "a passport that parses stays in the vault whatever kind the person picks": (sql, fixtures) => {
    const key = record(sql, fixtures);
    // Names fill the top line and optional data the bottom: no filler pair anywhere.
    const full =
      "P<UTOKARIMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nXK12345679UTO0103141F31050431234567890123454\n";
    const { sha256 } = upload(sql, key, full, human, "certificate");
    same([classOf(sql, sha256), getFile(sql, sha256)?.checks], ["vault", "found"]);
  },

  "a second scan of the same passport keeps the first note and secret": (sql, fixtures) => {
    const key = record(sql, fixtures);
    upload(sql, key, PASSPORT, human);
    const { sha256, result } = upload(sql, key, `Scanned again\n${PASSPORT}`, human);
    ok("note" in result && result.note?.status === "invalid", JSON.stringify(result));
    equal(getFile(sql, sha256)?.class, "vault");
    equal(getFile(sql, sha256)?.noteId, null);
    equal(sql.all("SELECT name FROM secrets").length, 1);
  },

  "loosening a confirmed kind needs the person's passkey, tightening doesn't": (sql, fixtures) => {
    const key = record(sql, fixtures);
    // A transcript the person called a passport: in the vault, though the checks found nothing.
    const { sha256 } = upload(sql, key, TRANSCRIPT, human, "passport");
    equal(classOf(sql, sha256), "vault");
    const asked = classifyFile(sql, sha256, "transcript", human);
    ok("status" in asked && asked.status === "needsApproval", JSON.stringify(asked));
    const file = getFile(sql, sha256);
    ok(file);
    equal(asked.challenge, kindHash(file, "transcript"));
    // A signature over another change doesn't do.
    const other = classifyFile(sql, sha256, "transcript", human, {
      challenge: kindHash(file, "certificate"),
      signature: signed(),
    });
    ok("error" in other);
    equal(classOf(sql, sha256), "vault");
    const signature = signed();
    equal(
      fileOf(classifyFile(sql, sha256, "transcript", human, { challenge: asked.challenge, signature })).class,
      "sensitive",
    );
    // Tightening needs nothing; loosening again asks again, for a new challenge, and the old signature is spent.
    equal(fileOf(classifyFile(sql, sha256, "visa", human)).class, "vault");
    const reasked = classifyFile(sql, sha256, "transcript", human);
    ok("status" in reasked && reasked.status === "needsApproval");
    notEqual(reasked.challenge, asked.challenge);
    ok(
      "error" in classifyFile(sql, sha256, "transcript", human, { challenge: reasked.challenge, signature }),
    );
  },

  "a read connection can't upload": (sql, fixtures) => {
    const key = record(sql, fixtures);
    const restricted = restrict(sql, connectionFor(sql).id, { level: "read" });
    ok("connection" in restricted);
    same(upload(sql, key, TRANSCRIPT, via(restricted.connection)).result, {
      status: "forbidden",
      reason: "This connection can only read.",
    });
    equal(sql.all("SELECT sha256 FROM files").length, 0);
  },

  "the data key is made once, kept wrapped, and opens only with its vault key": (sql) => {
    migrate(sql);
    const key = dataKey(sql, "vault key one");
    same(dataKey(sql, "vault key one"), key);
    const [stored] = sql.all<{ value: string }>("SELECT value FROM meta WHERE key = 'dataKey'");
    ok(stored && !Buffer.from(stored.value, "base64").includes(Buffer.from(key)));
    throws(() => dataKey(sql, "vault key two"));
    equal(sql.all("SELECT key FROM meta WHERE key = 'dataKey'").length, 1);
  },
};
