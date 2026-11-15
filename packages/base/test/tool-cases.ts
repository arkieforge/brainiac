// Conformance cases for the MCP tools (tools.ts), on the fixture record: the filter, cursors, levels, the sensitive
// scope, the approval list and what results never contain. cases.ts runs them on both engines; the transports
// are tested in apps/worker (auth.test.ts).
import { deepStrictEqual as same, equal, match, ok } from "node:assert/strict";

import { parseNote, type PlanItem } from "@brainiac/core";

import {
  callTool,
  connect,
  getNote,
  grant,
  migrate,
  mutate,
  putNote,
  recordApproval,
  releaseDue,
  SCAN_LIMIT,
  type Connection,
  type Context,
  type NoteClass,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const DAY = 24 * 60 * 60_000;

const PATHS = {
  tum: "applications/tum-msc-informatics-2027/application.md",
  trf: "documents/ielts-trf-2026.md",
  transcript: "documents/transcript-bsc.md",
  bsc: "facts/education/bsc-northvale.md",
  role: "facts/roles/acme-intern-2025.md",
  oldIelts: "facts/tests/ielts-2025-03.md",
  ielts: "facts/tests/ielts-2026-11.md",
  okafor: "people/dr-okafor.md",
} as const;

type Ids = Record<keyof typeof PATHS, string>;

let signatures = 0;
const signature = () => ({
  credentialId: "passkey-1",
  counter: ++signatures,
  assertion: `{"n":${signatures}}`,
});

/** The whole fixture record with its manifest, as the person made it; test scores are sensitive. */
function record(sql: Sql, fixtures: readonly Fixture[]): Ids {
  migrate(sql);
  const raw = (path: string) => {
    const found = fixtures.find((f) => f.path === path);
    ok(found, path);
    return found.raw;
  };
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", raw("okf-base.yaml"));
  const ids = Object.fromEntries(
    Object.entries(PATHS).map(([key, path]) => {
      const cls: NoteClass = path.startsWith("facts/tests/") ? "sensitive" : "normal";
      const mutation = { op: "create", path, raw: raw(path), class: cls } as const;
      let result = mutate(sql, mutation, { actor: "human", now: T0 });
      // The November score arrives verified, which takes the person's passkey.
      if (result.status === "needsApproval") {
        const approved = recordApproval(sql, result.items, signature(), T0);
        ok("approvalId" in approved);
        result = mutate(sql, mutation, { actor: "human", now: T0, approvalId: approved.approvalId });
      }
      ok(result.status === "applied", JSON.stringify(result));
      return [key, result.noteId];
    }),
  );
  return ids as Ids;
}

/** A CLI connection with the grants the person signed for; the floor (propose, no sensitive scope) by default. */
function connection(sql: Sql, grants: Partial<Pick<Connection, "level" | "sensitive" | "holdDays">> = {}) {
  const made = connect(sql, { kind: "cli" }, T0);
  if (Object.keys(grants).length === 0) return made;
  const result = grant(sql, { ...made, connectionId: made.id, ...grants }, signature());
  ok("connection" in result, JSON.stringify(result));
  return result.connection;
}

const as = (made: Connection, now = T0): Context => ({
  actor: `connection:${made.id}`,
  connection: made,
  now,
});

/** A tool's answer, which must be one (not a refused call). */
function call(
  sql: Sql,
  ctx: Context,
  name: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const answer = callTool(sql, name, args, ctx);
  ok(answer.ok, `${name} ${JSON.stringify(args)}: ${JSON.stringify(answer)}`);
  ok(typeof answer.value === "object" && answer.value !== null);
  return answer.value as Record<string, unknown>;
}

/** Why a call was refused before it ran. */
function refused(sql: Sql, ctx: Context, name: string, args: Record<string, unknown>): string {
  const answer = callTool(sql, name, args, ctx);
  ok(!answer.ok, `${name} should be refused: ${JSON.stringify(answer)}`);
  return answer.error;
}

interface QueryRow {
  readonly id: string;
  readonly path?: string;
  readonly rev?: number;
  readonly fields: Record<string, unknown>;
}

const rows = (sql: Sql, ctx: Context, args: Record<string, unknown>) =>
  call(sql, ctx, "query", args)["rows"] as QueryRow[];
const ids = (sql: Sql, ctx: Context, args: Record<string, unknown>) =>
  rows(sql, ctx, args).map((row) => row.id);
const revOf = (sql: Sql, id: string) => getNote(sql, id)?.rev ?? -1;
const fieldsOf = (sql: Sql, id: string) => parseNote(getNote(sql, id)?.raw ?? "").data;

export const toolCases: Record<string, Case> = {
  "query filters front-matter with eq, in, gte, lte, exists, has and text": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const agent = as(connection(sql));
    // Case and Unicode form don't matter to eq; eq on a list means it contains the value.
    same(ids(sql, agent, { type: "Role", where: { org: { eq: "ACME robotics" } } }), [n.role]);
    same(ids(sql, agent, { where: { tags: { eq: "python" } } }), [n.role]);
    same(ids(sql, agent, { where: { tags: { has: "robotics" } } }), [n.role]);
    same(ids(sql, agent, { where: { kind: { in: ["transcript", "university"] } }, sort: ["title"] }), [
      n.transcript,
      n.tum,
    ]);
    same(ids(sql, agent, { type: "Education", where: { cgpa: { gte: 3.8, lte: 4 } } }), [n.bsc]);
    same(ids(sql, agent, { type: "Education", where: { cgpa: { gte: 3.9 } } }), []);
    // Dates compare as dates; a missing field matches only exists: false.
    same(ids(sql, agent, { type: "Document", where: { expires: { gte: "2028-01-01" } } }), [n.trf]);
    same(ids(sql, agent, { type: "Document", where: { expires: { exists: false } } }), [n.transcript]);
    // has on a mapping is "has this key"; dotted paths reach into mappings and lists.
    same(ids(sql, agent, { where: { "sources.page": { eq: 2 } } }), [n.bsc]);
    same(ids(sql, agent, { where: { "requirements.need": { text: "recommendation letters" } } }), [n.tum]);
    // The top-level text looks anywhere in the note, accents and case aside.
    same(ids(sql, agent, { text: "OKÁFOR January" }), [n.tum]);
    same(ids(sql, agent, { type: "Person", fields: ["org", "role"] }).length, 1);
    same(rows(sql, agent, { type: "Person", fields: ["org", "role"] })[0]?.fields, {
      org: "Northvale University, School of Computing",
      role: "referee",
    });
  },

  "query: a null field reads as missing, and comparing with null is refused rather than dropped": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const me = connection(sql, { level: "write", holdDays: 0 });
    const writer = as(me);
    equal(
      call(sql, writer, "update", { id: n.trf, rev: revOf(sql, n.trf), set: { expires: null } })["status"],
      "applied",
    );
    // Stored as null, not removed.
    ok(Object.hasOwn(fieldsOf(sql, n.trf), "expires"));
    same(ids(sql, writer, { type: "Document", where: { expires: { exists: false } }, sort: ["title"] }), [
      n.transcript,
      n.trf,
    ]);
    same(ids(sql, writer, { type: "Document", where: { expires: { gte: "2000-01-01" } } }), []);
    match(refused(sql, writer, "query", { where: { expires: { eq: null } } }), /exists": false/);
    match(refused(sql, writer, "query", { where: { expires: {} } }), /names no operator/);
    match(refused(sql, writer, "query", { where: { expires: { ne: 1 } } }), /ne must be removed/);
  },

  "query compares dates in UTC, a date-time against a plain date by its UTC day": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    // 01:00 in +05:00 is still the day before in UTC.
    const set = { seen: "2025-07-01T01:00:00+05:00" };
    equal(call(sql, writer, "update", { id: n.role, rev: revOf(sql, n.role), set })["status"], "applied");
    same(ids(sql, writer, { where: { seen: { gte: "2025-07-01" } } }), []);
    same(ids(sql, writer, { where: { seen: { eq: "2025-06-30" } } }), [n.role]);
    same(ids(sql, writer, { where: { seen: { lte: "2025-06-30T20:00:00Z" } } }), [n.role]);
    same(ids(sql, writer, { where: { seen: { lte: "2025-06-30T19:59:59Z" } } }), []);
  },

  "query pages with stable cursors, and a cursor only pages its own query": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    const first = call(sql, writer, "query", { sort: ["title"], limit: 2 });
    const firstIds = (first["rows"] as QueryRow[]).map((r) => r.id);
    same(firstIds, [n.transcript, n.bsc]);
    ok(typeof first["next"] === "string");
    // A note added before the next page, sorting before the cursor, never shifts what comes after it.
    equal(
      call(sql, writer, "create", { type: "Person", fields: { title: "Aaron Abbot", role: "advisor" } })[
        "status"
      ],
      "applied",
    );
    const second = call(sql, writer, "query", { sort: ["title"], limit: 2, cursor: first["next"] });
    same(
      (second["rows"] as QueryRow[]).map((r) => r.id),
      [n.okafor, n.trf],
    );
    const third = call(sql, writer, "query", { sort: ["title"], limit: 2, cursor: second["next"] });
    same(
      (third["rows"] as QueryRow[]).map((r) => r.id),
      [n.role, n.tum],
    );
    equal(third["next"], null);
    match(
      refused(sql, writer, "query", { sort: ["-title"], limit: 2, cursor: first["next"] }),
      /doesn't belong/,
    );
    match(refused(sql, writer, "query", { cursor: "not-a-cursor" }), /doesn't belong/);
    // The default order is newest date first, notes without a date last, then by id.
    same(ids(sql, writer, { type: "Document" }), [n.transcript, n.trf]);
  },

  "query refuses to scan past the limit without a type, and pages are at most 100 rows": (sql, fixtures) => {
    record(sql, fixtures);
    const agent = as(connection(sql));
    sql.transaction(() => {
      for (let i = 0; i <= SCAN_LIMIT; i++) {
        const id = `01M7${String(i).padStart(22, "0")}`;
        const raw = `---\nid: ${id}\ntype: Person\ntitle: P${i}\nrole: referee\n---\n`;
        putNote(sql, { id, path: `people/p${i}.md`, raw, rev: 1, hash: "h", seq: 1000 + i, class: "normal" });
      }
    });
    match(refused(sql, agent, "query", {}), /more than 10000 notes\. Add a type/);
    equal(rows(sql, agent, { type: "Role" }).length, 1);
    equal(rows(sql, agent, { type: "Person", limit: 100 }).length, 100);
    match(refused(sql, agent, "query", { type: "Person", limit: 101 }), /limit/);
  },

  "every read leaves out what the connection may not see, and the sensitive scope lets it in": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const floor = as(connection(sql));
    const scoped = as(connection(sql, { sensitive: true }));
    same(ids(sql, floor, { type: "TestScore" }), []);
    same(ids(sql, scoped, { type: "TestScore" }), [n.ielts, n.oldIelts]);
    same(ids(sql, floor, { text: "listening" }), []);
    const hidden = call(sql, floor, "get", {
      ids: [n.ielts, "01M6ZZZZZZZZZZZZZZZZZZZZZZ"],
      paths: ["FACTS/tests/ielts-2026-11.md"],
    });
    same(hidden, {
      notes: [],
      missing: [n.ielts, "01M6ZZZZZZZZZZZZZZZZZZZZZZ", "FACTS/tests/ielts-2026-11.md"],
    });
    const seen = call(sql, scoped, "get", { paths: ["FACTS/tests/ielts-2026-11.md"], history: true });
    const [note] = seen["notes"] as Record<string, unknown>[];
    same(
      [note?.["id"], note?.["rev"], note?.["class"], note?.["verified"]],
      [n.ielts, 1, "sensitive", ["overall", "sections"]],
    );
    same(note?.["history"], [{ rev: 1, at: new Date(T0).toISOString(), by: "the person" }]);
    const plain = (
      call(sql, floor, "get", { ids: [n.role], body: false })["notes"] as Record<string, unknown>[]
    )[0];
    same([plain?.["verified"], Object.hasOwn(plain ?? {}, "body")], [[], false]);

    // describe counts only what the caller sees.
    const described = call(sql, floor, "describe");
    same(described["you"], { level: "propose", sensitive: false, holdDays: 3 });
    same((described["counts"] as Record<string, unknown>)["byType"], {
      Application: 1,
      Document: 2,
      Education: 1,
      Person: 1,
      Role: 1,
    });
    equal((call(sql, scoped, "describe")["counts"] as Record<string, unknown>)["notes"] as number, 8);
    ok(Object.hasOwn(described["types"] as object, "InboxItem"));
    ok(Object.hasOwn(described["types"] as object, "TestScore"));
  },

  "a read connection reads and changes nothing; propose waits; add and request_info don't": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const reader = as(connection(sql, { level: "read" }));
    for (const [name, args] of [
      ["create", { type: "Person", fields: { title: "Someone", role: "referee" } }],
      ["update", { id: n.role, rev: 1, set: { org: "Acme" } }],
      ["add", { text: "A note" }],
      ["request_info", { question: "When?" }],
      ["undo", { run: "01M6RUN0000000000000000001" }],
    ] as const)
      equal(call(sql, reader, name, args)["status"], "forbidden", name);
    equal(rows(sql, reader, { type: "Role" }).length, 1);

    const proposer = as(connection(sql));
    const asked = call(sql, proposer, "update", { id: n.role, rev: 1, set: { org: "Acme" } });
    same([asked["status"], asked["autoApplyAt"]], ["proposed", null]);
    equal(revOf(sql, n.role), 1);
    // add files straight into the inbox, as the connection, and can sit beside a note.
    const added = call(sql, proposer, "add", { text: "Won the hackathon in March.", attach_to: n.role });
    equal(added["status"], "applied");
    const item = getNote(sql, String(added["id"]));
    same(
      [item?.path.startsWith("inbox/"), item?.type, fieldsOf(sql, String(added["id"]))["attached_to"]],
      [true, "InboxItem", "../facts/roles/acme-intern-2025.md"],
    );
    ok(item?.raw.endsWith("Won the hackathon in March."));
    equal(
      call(sql, proposer, "request_info", {
        question: "When did the internship end?",
        note: n.role,
        field: "end",
      })["status"],
      "queued",
    );
    // A floor connection can't attach to, or ask about, a note it can't see.
    match(refused(sql, proposer, "add", { text: "x", attach_to: n.ielts }), /No note with id/);
    match(refused(sql, proposer, "request_info", { question: "x", note: n.ielts }), /No note with id/);
  },

  "proposals and questions list for the connection that may see them": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const proposer = as(connection(sql));
    const scoped = as(connection(sql, { sensitive: true }));
    const mine = call(sql, proposer, "update", { id: n.role, rev: 1, set: { org: "Acme" } });
    call(sql, scoped, "update", { id: n.ielts, rev: 1, append: { sources: { id: "note" } } });
    same(
      rows(sql, proposer, { type: "Proposal" }).map((r) => [r.id, r.fields["yours"], r.fields["notes"]]),
      [[mine["proposal"], true, [n.role]]],
    );
    equal(rows(sql, scoped, { type: "Proposal", where: { yours: { eq: true } } }).length, 1);
    equal(rows(sql, scoped, { type: "Proposal" }).length, 2);

    call(sql, scoped, "request_info", { question: "Is 8.0 the final score?", note: n.ielts, suggested: 8 });
    call(sql, proposer, "request_info", { question: "Which internship came first?" });
    same(
      rows(sql, proposer, { type: "Question" }).map((r) => r.fields["question"]),
      ["Which internship came first?"],
    );
    equal(rows(sql, scoped, { type: "Question", where: { status: { eq: "open" } } }).length, 2);
    equal(call(sql, proposer, "describe")["openQuestions"], 1);

    // Withdrawing is only for your own proposals.
    equal(call(sql, scoped, "update", { withdraw: mine["proposal"] })["status"], "invalid");
    equal(call(sql, proposer, "update", { withdraw: mine["proposal"] })["status"], "withdrawn");
    equal(rows(sql, proposer, { type: "Proposal", where: { status: { eq: "open" } } }).length, 0);
  },

  "create writes a typed note where its type lives, and warns instead of duplicating": (sql, fixtures) => {
    record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    const fields = {
      title: "Research Assistant, Northvale NLP Lab",
      org: "Northvale University",
      start: "2025-10-01",
    };
    const preview = call(sql, writer, "create", { type: "Role", fields, dry_run: true });
    same([preview["dryRun"], preview["status"]], [true, "applied"]);
    equal(rows(sql, writer, { type: "Role" }).length, 1);
    const made = call(sql, writer, "create", {
      type: "Role",
      fields,
      body: "Annotated a Bangla NER corpus.\n",
    });
    equal(made["status"], "applied");
    equal(made["path"], "facts/roles/research-assistant-northvale-nlp-lab.md");
    const note = getNote(sql, String(made["id"]));
    ok(note?.raw.endsWith("---\nAnnotated a Bangla NER corpus.\n"));
    equal(
      sql.all<{ actor: string }>("SELECT actor FROM revisions WHERE noteId = ?", note?.id ?? "")[0]?.actor,
      writer.actor,
    );

    const twin = call(sql, writer, "create", {
      type: "Role",
      fields: { ...fields, title: "research assistant, northvale nlp lab" },
    });
    same([twin["status"], (twin["duplicate"] as Record<string, unknown>)["id"]], ["duplicate", made["id"]]);
    // Asked for anyway, it gets a path of its own.
    const again = call(sql, writer, "create", { type: "Role", fields, duplicate_ok: true });
    equal(again["status"], "applied");
    match(String(again["path"]), /^facts\/roles\/research-assistant-northvale-nlp-lab-[0-9a-z]{6}\.md$/);
  },

  "create reports what the type requires, and a superseding test score waits out the hold": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", sensitive: true }));
    const missing = call(sql, writer, "create", {
      type: "TestScore",
      fields: { title: "IELTS Academic, May 2027", test: "ielts-academic" },
    });
    equal(missing["status"], "invalid");
    match(JSON.stringify(missing["issues"]), /overall is required/);
    const made = call(sql, writer, "create", {
      type: "TestScore",
      fields: { title: "IELTS Academic, May 2027", test: "ielts-academic", overall: 8.5, date: "2027-05-02" },
      link: { supersedes: n.oldIelts },
      sensitive: true,
    });
    same([made["status"], made["autoApplyAt"]], ["proposed", new Date(T0 + 3 * DAY).toISOString()]);
    match(refused(sql, writer, "create", { type: "Role", fields: { id: "x" } }), /id is set for you/);
  },

  "update needs the rev it read, edits by field, section and link, and null in a patch is a value": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", sensitive: true, holdDays: 0 }));
    match(refused(sql, writer, "update", { id: n.tum, set: { status: "submitted" } }), /rev is required/);
    same(call(sql, writer, "update", { id: n.tum, rev: 0, set: { status: "submitted" } }), {
      status: "conflict",
      id: n.tum,
      rev: 1,
      message: "The note is at rev 1 now. Get it again and send your change with that rev.",
    });
    const edited = call(sql, writer, "update", {
      id: n.tum,
      rev: 1,
      set: { status: "submitted", "requirements.3.check": null },
      section: [{ heading: "Plan", content: "Letters asked for in January.\n" }],
      link: { referees: n.okafor },
    });
    same([edited["status"], edited["rev"]], ["applied", 2]);
    const data = fieldsOf(sql, n.tum);
    same(
      [data["status"], (data["requirements"] as Record<string, unknown>[])[3]?.["check"], data["referees"]],
      ["submitted", null, "../../people/dr-okafor.md"],
    );
    ok(getNote(sql, n.tum)?.raw.includes("## Plan\n\nLetters asked for in January.\n"));
    // Linking a list adds once; unlinking removes it.
    call(sql, writer, "update", { id: n.trf, rev: 1, link: { proves: [n.ielts, n.bsc] } });
    same(fieldsOf(sql, n.trf)["proves"], [
      "../facts/tests/ielts-2026-11.md",
      "../facts/education/bsc-northvale.md",
    ]);
    call(sql, writer, "update", { id: n.trf, rev: 2, unlink: { proves: n.ielts } });
    same(fieldsOf(sql, n.trf)["proves"], ["../facts/education/bsc-northvale.md"]);
    match(
      refused(sql, writer, "update", { id: n.trf, rev: 3, link: { proves: "01M6ZZZZZZZZZZZZZZZZZZZZZZ" } }),
      /No note with id/,
    );
    match(
      refused(sql, writer, "update", { id: n.trf, rev: 3, delete: true, set: { a: 1 } }),
      /one kind of change/,
    );
    match(refused(sql, writer, "update", { rev: 3, set: { a: 1 } }), /Name one note/);
  },

  "update deletes and restores, and a dry run changes nothing": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    const dry = call(sql, writer, "update", { id: n.okafor, rev: 1, delete: true, dry_run: true });
    same(
      [dry["dryRun"], dry["status"], (dry["changes"] as Record<string, unknown>[])[0]?.["live"]],
      [true, "applied", { before: true, after: false }],
    );
    equal(getNote(sql, n.okafor)?.deletedAt, null);
    equal(call(sql, writer, "update", { id: n.okafor, rev: 1, delete: true })["status"], "applied");
    same(ids(sql, writer, { type: "Person" }), []);
    equal(call(sql, writer, "update", { id: n.okafor, rev: 2, restore: true })["status"], "applied");
    same(ids(sql, writer, { type: "Person" }), [n.okafor]);
    equal(call(sql, writer, "update", { id: n.okafor, rev: 3, restore: true })["status"], "invalid");
  },

  "a bulk update needs its dry-run count, applies as one run, and undo takes it back": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    const where = { type: "Document" };
    const unconfirmed = call(sql, writer, "update", { ...where, set: { checked: true } });
    same([unconfirmed["status"], unconfirmed["matched"]], ["unconfirmed", 2]);
    const dry = call(sql, writer, "update", { ...where, set: { checked: true }, dry_run: true });
    same([dry["matched"], (dry["changes"] as unknown[]).length], [2, 2]);
    equal(fieldsOf(sql, n.trf)["checked"], undefined);
    const done = call(sql, writer, "update", { ...where, set: { checked: true }, expect: 2 });
    equal(done["status"], "applied");
    same([fieldsOf(sql, n.trf)["checked"], fieldsOf(sql, n.transcript)["checked"]], [true, true]);
    const undone = call(sql, writer, "undo", { run: done["run"] });
    same(
      [undone["status"], (undone["undone"] as string[]).toSorted()],
      ["applied", [n.trf, n.transcript].toSorted()],
    );
    equal(fieldsOf(sql, n.trf)["checked"], undefined);
    equal(call(sql, writer, "undo", { run: "01M6RUN0000000000000000001" })["status"], "invalid");
    // One bad note stops the whole change.
    const bad = call(sql, writer, "update", { ...where, set: { kind: "letter" }, expect: 2 });
    equal(bad["status"], "invalid");
    equal(fieldsOf(sql, n.trf)["kind"], "test-report");
  },

  "updates wider than 20 notes and deletes past 5, even one per call, need the person's passkey": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    const me = connection(sql, { level: "write", holdDays: 0 });
    const writer = as(me);
    for (let i = 0; i < 21; i++)
      equal(
        call(sql, writer, "create", { type: "Person", fields: { title: `Referee ${i}`, role: "referee" } })[
          "status"
        ],
        "applied",
      );
    const where = { type: "Person", where: { title: { text: "referee" } } };
    const wide = call(sql, writer, "update", { ...where, set: { org: "Northvale" }, expect: 21 });
    equal(wide["status"], "needsApproval");
    const approved = recordApproval(sql, wide["items"] as PlanItem[], signature(), T0);
    ok("approvalId" in approved);
    equal(
      call(sql, writer, "update", {
        ...where,
        set: { org: "Northvale" },
        expect: 21,
        approval_id: approved.approvalId,
      })["status"],
      "applied",
    );

    // Five single deletes pass; the sixth in a day needs a signature, as a six-note delete would.
    const people = ids(sql, writer, { ...where, limit: 6 });
    for (const id of people.slice(0, 5))
      equal(call(sql, writer, "update", { id, rev: revOf(sql, id), delete: true })["status"], "applied");
    const sixth = people[5] ?? "";
    equal(
      call(sql, writer, "update", { id: sixth, rev: revOf(sql, sixth), delete: true })["status"],
      "needsApproval",
    );
    equal(
      call(sql, as(me, T0 + DAY + 1), "update", { id: sixth, rev: revOf(sql, sixth), delete: true })[
        "status"
      ],
      "applied",
    );
  },

  "a change to a verified value needs approval, and the approval it cites lets exactly it through": (
    sql,
    fixtures,
  ) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write", sensitive: true, holdDays: 0 }));
    const held = call(sql, writer, "update", { id: n.ielts, rev: 1, set: { overall: 8.5 } });
    equal(held["status"], "needsApproval");
    match(String(held["message"]), /passkey/);
    equal(revOf(sql, n.ielts), 1);
    const approved = recordApproval(sql, held["items"] as PlanItem[], signature(), T0);
    ok("approvalId" in approved);
    // The approval covers that change, not another.
    equal(
      call(sql, writer, "update", {
        id: n.ielts,
        rev: 1,
        set: { overall: 9 },
        approval_id: approved.approvalId,
      })["status"],
      "needsApproval",
    );
    equal(
      call(sql, writer, "update", {
        id: n.ielts,
        rev: 1,
        set: { overall: 8.5 },
        approval_id: approved.approvalId,
      })["status"],
      "applied",
    );
  },

  "a held bulk change applies whole when its hold runs out, or waits if a note moved on": (sql, fixtures) => {
    const n = record(sql, fixtures);
    const writer = as(connection(sql, { level: "write" }));
    const where = { type: "Role", where: { org: { exists: true } } };
    const held = call(sql, writer, "update", { ...where, set: { org: "Acme Robotics GmbH" }, expect: 1 });
    equal(held["status"], "proposed");
    releaseDue(sql, T0 + 4 * DAY);
    equal(fieldsOf(sql, n.role)["org"], "Acme Robotics GmbH");

    const both = { type: "Education", where: { degree: { exists: true } } };
    call(sql, writer, "create", {
      type: "Education",
      fields: { title: "MSc", institution: "TUM", degree: "MSc Informatics" },
    });
    const again = call(sql, writer, "update", { ...both, set: { scale: 5 }, expect: 2 });
    equal(again["status"], "proposed");
    mutate(
      sql,
      {
        op: "patch",
        noteId: n.bsc,
        baseRev: revOf(sql, n.bsc),
        ops: [{ op: "set", path: ["cgpa"], value: 3.9 }],
      },
      { actor: "human", now: T0 },
    );
    releaseDue(sql, T0 + 8 * DAY);
    equal(fieldsOf(sql, n.bsc)["scale"], 4);
    same(sql.all("SELECT status, autoApplyAt FROM proposals WHERE id = ?", String(again["proposal"])), [
      { status: "open", autoApplyAt: null },
    ]);
  },

  "arguments: undeclared ones are refused, null reads as omitted, a required one can't be null": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    const agent = as(connection(sql));
    match(refused(sql, agent, "query", { type: "Role", bogus: 1 }), /bogus must be removed/);
    same(
      call(sql, agent, "query", { type: "Role", limit: null, cursor: null, where: null }),
      call(sql, agent, "query", { type: "Role" }),
    );
    match(refused(sql, agent, "undo", { run: null }), /run must be a string/);
    match(refused(sql, agent, "request_info", {}), /question must be a string/);
    match(refused(sql, agent, "nope", {}), /No tool named nope/);
  },

  "no tool answer carries a secret, a hidden note's values or another record's": (sql, fixtures) => {
    const n = record(sql, fixtures);
    sql.all(
      "INSERT INTO secrets (name, ciphertext, policy) VALUES ('portal.tum', 'CANARY-SECRET-9137', 'ask')",
    );
    const agent = as(connection(sql, { level: "write", holdDays: 0 }));
    const answers = [
      callTool(sql, "describe", {}, agent),
      callTool(sql, "query", { text: "26GB001234KARN001A" }, agent),
      callTool(sql, "query", { where: { trf_number: { exists: true } } }, agent),
      callTool(sql, "get", { ids: Object.values(n), history: true }, agent),
      callTool(sql, "query", { type: "Proposal" }, agent),
      callTool(sql, "update", { type: "TestScore", set: { overall: 1 }, dry_run: true }, agent),
      callTool(
        sql,
        "update",
        { where: { title: { text: "ielts" } }, set: { note: 1 }, dry_run: true },
        agent,
      ),
    ];
    const text = JSON.stringify(answers);
    for (const canary of ["CANARY-SECRET-9137", "26GB001234KARN001A", "computer-delivered", "Writing held"])
      ok(!text.includes(canary), `${canary} leaked: ${text}`);
    // The portal login is a reference to the vault, never the secret.
    ok(text.includes("secret:portal.tum"));
  },
};
