// The canary suite for the authorization projection; cases.ts runs it on both engines. Values planted in the
// fixture student's sensitive notes must never reach a principal without access, on any read surface.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { ulid, type ClientMessage, type ServerMessage } from "@brainiac/core";

import {
  changesSince,
  chunkNote,
  currentSeq,
  getNote,
  connect,
  decide,
  getNoteByPath,
  grant,
  migrate,
  mutate,
  openReview,
  PERSON,
  purge,
  putChunks,
  recordApproval,
  search,
  serve,
  startReview,
  TOMBSTONE_MS,
  undoRun,
  type NoteRow,
  type Principal,
  type Signature,
  type Sql,
} from "../src/index.ts";
import { AGENT, hitIds, type Case, type Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 14);
const ctx = { actor: "connection:agent", now: T0 };

const IELTS = "facts/tests/ielts-2026-11.md";
const OKAFOR = "people/dr-okafor.md";
const ROLE = "facts/roles/acme-intern-2025.md";

let signatures = 100;
/** A passkey assertion the DO has checked, as approval-cases.ts makes them. */
const signature = (counter: number): Signature => ({
  credentialId: "passkey-privacy",
  counter,
  assertion: `{"n":${counter}}`,
});

/** Planted only in sensitive notes; finding any of them in an output is a leak. */
const CANARY = /CANARY-\w+/g;

const plant = (path: string, raw: string) =>
  path === IELTS
    ? raw
        .replace("26GB001234KARN001A", "CANARY-TRF-7Q3X")
        .replace("city centre.", "city centre. CANARY-BODY-7Q3X")
    : path === OKAFOR
      ? raw.replace("Thesis supervisor.", "Thesis supervisor. CANARY-PERSON-7Q3X")
      : raw;

/** Indexes every live note at its current revision, as the jobs consumer would. */
function install(sql: Sql): void {
  for (const note of sql.all<NoteRow>("SELECT * FROM notes WHERE deletedAt IS NULL")) {
    sql.transaction(() => {
      sql.all("DELETE FROM jobs WHERE noteId = ?", note.id);
      putChunks(sql, note.id, note.rev, chunkNote(note));
    });
  }
}

/**
 * The fixture student's record, made through the mutation path and indexed, with canaries planted in its
 * sensitive notes (test scores and people are sensitive, as their areas are).
 */
export function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const ids: Record<string, string> = {};
  const hidden = new Set<string>();
  for (const fixture of fixtures.filter((f) => f.path.endsWith(".md"))) {
    const sensitive = fixture.path.startsWith("facts/tests/") || fixture.path.startsWith("people/");
    const raw = plant(fixture.path, fixture.raw);
    const cls = sensitive ? "sensitive" : "normal";
    const create = { op: "create", path: fixture.path, raw, class: cls } as const;
    const person = { actor: "human", now: T0 };
    let result = mutate(sql, create, person);
    // A note that arrives verified (the IELTS score) lands with the person's signature over it.
    if (result.status === "needsApproval") {
      const approved = recordApproval(sql, result.items, signature(++signatures), T0);
      ok("approvalId" in approved, JSON.stringify(approved));
      result = mutate(sql, create, { ...person, approvalId: approved.approvalId });
    }
    ok(result.status === "applied", JSON.stringify(result));
    ids[fixture.path] = result.noteId;
    if (sensitive) hidden.add(result.noteId);
  }
  install(sql);
  return { ids, hidden };
}

const hello = (clientId: string, cursor: number | null): ClientMessage => ({
  type: "hello",
  clientId,
  cursor,
  lastAssigned: 0,
  ackedUpTo: 0,
  schemaVersion: 1,
  appVersion: "test",
  attempt: 0,
});

/**
 * Every canary in what a reader was sent, and every hidden note it was sent as more than gone: a search hit,
 * or a feed item with its path and text.
 */
function leaks(outputs: readonly unknown[], hidden: ReadonlySet<string>): string[] {
  const found: string[] = [];
  JSON.stringify(outputs, (_key, value: unknown) => {
    if (typeof value === "string") found.push(...(value.match(CANARY) ?? []));
    if (typeof value === "object" && value !== null && "noteId" in value) {
      const gone = "deleted" in value && value.deleted === true;
      if (hidden.has(String(value.noteId)) && !gone) found.push(`note ${String(value.noteId)}`);
    }
    return value;
  });
  return found;
}

/** What a reader gets from every read surface there is: the feed on hello, a later feed, a push, search. */
function readEverything(sql: Sql, reader: Principal, clientId: string): unknown[] {
  const words = ["CANARY-TRF-7Q3X", "CANARY-BODY-7Q3X", "CANARY-PERSON-7Q3X", "computer", "supervisor"];
  return [
    ...serve(sql, hello(clientId, null), ctx, reader).replies,
    changesSince(sql, 0, reader),
    ...words.map((word) => search(sql, reader, word)),
  ];
}

/** Every note state in a reader's messages, and the ids of those it was sent whole. */
const visible = (messages: readonly ServerMessage[]) =>
  messages.flatMap((m) => (m.type === "snapshot" ? m.notes : m.type === "changes" ? m.items : []));
const live = (messages: readonly ServerMessage[]) =>
  visible(messages)
    .filter((note) => !note.deleted)
    .map((note) => note.noteId);

export const privacyCases: Record<string, Case> = {
  "no read surface shows a canary to a connection without the sensitive scope": (sql, fixtures) => {
    const { ids, hidden } = record(sql, fixtures);
    const ielts = ids[IELTS];
    ok(ielts);
    // The person sees the canaries, so the suite isn't passing on an empty record.
    ok(leaks(readEverything(sql, PERSON, "person-tab"), hidden).length > 0);

    const outputs = readEverything(sql, AGENT, "agent");
    // Its own changes to a note it can't see are refused exactly as for a note that doesn't exist.
    const put = (noteId: string, clientSeq: number): ClientMessage => ({
      type: "mutate",
      clientId: "agent",
      clientSeq,
      changeId: `c${clientSeq}`,
      ackedUpTo: 0,
      noteId,
      baseRev: 1,
      change: { kind: "put", raw: fixtures.find((f) => f.path === IELTS)?.raw ?? "", base: "" },
    });
    const refused = serve(sql, put(ielts, 1), ctx, AGENT).replies;
    const missing = serve(sql, put("01M6ZZZZZZZZZZZZZZZZZZZZZZ", 2), ctx, AGENT).replies;
    same(
      refused.map((m) => (m.type === "result" ? m.error : m.type)),
      [`No note with id ${ielts}.`],
    );
    same(
      missing.map((m) => (m.type === "result" ? m.error : m.type)),
      ["No note with id 01M6ZZZZZZZZZZZZZZZZZZZZZZ."],
    );
    equal(getNote(sql, ielts)?.rev, 1);
    // A path that clashes with a hidden note's is refused without naming the note it clashes with.
    const probe: ClientMessage = {
      type: "mutate",
      clientId: "agent",
      clientSeq: 3,
      changeId: "c3",
      ackedUpTo: 0,
      noteId: "01M6YYYYYYYYYYYYYYYYYYYYYY",
      baseRev: 0,
      change: {
        kind: "create",
        path: IELTS.toUpperCase(),
        raw: "---\nid: 01M6YYYYYYYYYYYYYYYYYYYYYY\ntype: Note\n---\nprobe\n",
        class: "normal",
      },
    };
    const clashed = serve(sql, probe, ctx, AGENT).replies;
    same(
      clashed.map((m) => (m.type === "result" ? m.ok : m.type)),
      [false],
    );
    ok(!JSON.stringify(clashed).includes(IELTS), JSON.stringify(clashed));

    // The person edits the sensitive note: the agent's push says only that something it doesn't hold is gone.
    const before = currentSeq(sql);
    const edit: ClientMessage = {
      type: "mutate",
      clientId: "person-tab",
      clientSeq: 1,
      changeId: "p1",
      ackedUpTo: 0,
      noteId: ielts,
      baseRev: 1,
      change: {
        kind: "put",
        // An unverified field, so it lands without a signature.
        raw: getNote(sql, ielts)?.raw.replace("expires: 2028-11-02", "expires: 2028-11-03") ?? "",
        base: getNote(sql, ielts)?.raw ?? "",
      },
    };
    const pushed = serve(sql, edit, { actor: "human", now: T0 }, PERSON).push?.(AGENT);
    same(pushed, {
      type: "changes",
      from: before,
      to: before + 1,
      items: [{ noteId: ielts, seq: before + 1, deleted: true, withheld: true }],
    });

    same(leaks([...outputs, refused, clashed, pushed, changesSince(sql, before, AGENT)], hidden), []);
  },

  "a note made sensitive leaves normal search and the feed at once, before any job runs": (sql, fixtures) => {
    const { ids } = record(sql, fixtures);
    const role = ids[ROLE];
    ok(role);
    same(hitIds(search(sql, AGENT, "telemetry")), [role]);
    const cursor = currentSeq(sql);

    const made = mutate(sql, { op: "classify", noteId: role, baseRev: 1, class: "sensitive" }, ctx);
    equal(made.status, "applied", JSON.stringify(made));
    // No job has run: the words are gone from the normal index itself, not only filtered out.
    same(search(sql, AGENT, "telemetry"), []);
    same(sql.all("SELECT rowid FROM chunks_fts_normal WHERE chunks_fts_normal MATCH 'telemetry'"), []);
    same(changesSince(sql, cursor, AGENT), {
      type: "changes",
      from: cursor,
      to: cursor + 1,
      items: [{ noteId: role, seq: cursor + 1, deleted: true, withheld: true }],
    });
    const forPerson = changesSince(sql, cursor, PERSON);
    ok(forPerson.type === "changes");
    same(
      forPerson.items.map((item) => (item.deleted ? item : item.class)),
      ["sensitive"],
    );

    // Re-indexed by its job, it is found again, in the sensitive family only.
    install(sql);
    same(hitIds(search(sql, PERSON, "telemetry")), [role]);
    same(search(sql, AGENT, "telemetry"), []);

    // Making it normal again loosens privacy: only a passkey signature over that exact change lets it land.
    const loosen = { op: "classify", noteId: role, baseRev: 2, class: "normal" } as const;
    const verdict = mutate(sql, loosen, ctx);
    ok(verdict.status === "needsApproval", JSON.stringify(verdict));
    same(
      verdict.items.map((item) => [item.noteId, item.class, item.patch.class]),
      [[role, "normal", { before: "sensitive", after: "normal" }]],
    );
    same([getNote(sql, role)?.class, getNote(sql, role)?.rev], ["sensitive", 2]);
    // A review session the person signed over the note doesn't cover it.
    const opened = openReview(
      sql,
      startReview(sql, [role], "human", T0),
      "human",
      signature(++signatures),
      T0,
    );
    ok("review" in opened, JSON.stringify(opened));
    const person = { actor: "human", now: T0 };
    equal(mutate(sql, loosen, { ...person, review: opened.review }).status, "needsApproval");
    // Undoing the run that made it sensitive is the same loosening.
    ok(made.status === "applied");
    equal(undoRun(sql, made.runId, person).status, "needsApproval");
    equal(getNote(sql, role)?.class, "sensitive");

    // Signed: it lands, and leaves the sensitive index in the same transaction.
    const approved = recordApproval(sql, verdict.items, signature(++signatures), T0);
    ok("approvalId" in approved, JSON.stringify(approved));
    equal(mutate(sql, loosen, { ...person, approvalId: approved.approvalId }).status, "applied");
    equal(getNote(sql, role)?.class, "normal");
    same(search(sql, PERSON, "telemetry"), []);
    install(sql);
    same(hitIds(search(sql, AGENT, "telemetry")), [role]);
  },

  "a token scoped to some types sees only notes of those types": (sql, fixtures) => {
    const { ids } = record(sql, fixtures);
    const roles: Principal = { sensitive: true, types: ["Role"] };
    const snapshot = changesSince(sql, null, roles);
    ok(snapshot.type === "snapshot");
    same(
      snapshot.notes.filter((note) => !note.deleted).map((note) => note.noteId),
      [ids[ROLE]],
    );
    ok(snapshot.notes.every((note) => !note.deleted || note.withheld));
    same(search(sql, roles, "okafor"), []);
    same(hitIds(search(sql, roles, "telemetry")), [ids[ROLE]]);
    equal(getNoteByPath(sql, OKAFOR)?.class, "sensitive");
  },

  "undoing a run that made a note and then made it sensitive deletes it, and it stays sensitive": (
    sql,
    fixtures,
  ) => {
    migrate(sql);
    const raw = fixtures.find((f) => f.path === ROLE)?.raw ?? "";
    const run = { ...ctx, runId: "01M6RUN0000000000000000002" };
    const made = mutate(sql, { op: "create", path: ROLE, raw, class: "normal" }, run);
    ok(made.status === "applied");
    equal(
      mutate(sql, { op: "classify", noteId: made.noteId, baseRev: 1, class: "sensitive" }, run).status,
      "applied",
    );
    const undone = undoRun(sql, run.runId, { actor: "human", now: T0 + 1 });
    ok(undone.status === "applied", JSON.stringify(undone));
    same([undone.undone, undone.conflicts], [[made.noteId], []]);
    // It is gone, still sensitive: brought back by a plain edit, it stays out of a scope-less reader's sight.
    same([getNote(sql, made.noteId)?.deletedAt, getNote(sql, made.noteId)?.class], [T0 + 1, "sensitive"]);
    const back = mutate(
      sql,
      { op: "put", noteId: made.noteId, baseRev: 3, raw },
      { actor: "human", now: T0 + 2 },
    );
    equal(back.status, "applied", JSON.stringify(back));
    same([getNote(sql, made.noteId)?.deletedAt, getNote(sql, made.noteId)?.class], [null, "sensitive"]);
    same(changesSince(sql, null, AGENT), {
      type: "snapshot",
      seq: currentSeq(sql),
      notes: [{ noteId: made.noteId, seq: currentSeq(sql), deleted: true, withheld: true }],
      attempt: null,
    });
  },

  // Held or applied, needsApproval or applied: either would say what the hidden note there is.
  "a supersedes a connection can't see past is refused the same whether a note is there or not": (
    sql,
    fixtures,
  ) => {
    migrate(sql);
    const text = (path: string) => fixtures.find((f) => f.path === path)?.raw ?? "";
    sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", text("okf-base.yaml"));
    const person = { actor: "human", now: T0 };
    const hidden = "facts/tests/ielts-2025-03.md";
    equal(
      mutate(sql, { op: "create", path: hidden, raw: text(hidden), class: "sensitive" }, person).status,
      "applied",
    );
    const shown = text(hidden).replace("01M6A9XNM0AR4BM0ESE4KX8KVB", "01M6A9XNM0AR4BM0ESE4KX8KVC");
    const seen = "facts/tests/ielts-2024-01.md";
    equal(mutate(sql, { op: "create", path: seen, raw: shown, class: "normal" }, person).status, "applied");

    // A write-level connection, without the sensitive scope.
    const floor = connect(sql, { kind: "cli" }, T0);
    const granted = grant(
      sql,
      { connectionId: floor.id, rev: floor.rev, level: "write", sensitive: false, holdDays: 3 },
      signature(++signatures),
    );
    ok("connection" in granted, JSON.stringify(granted));
    const agent = { actor: `connection:${floor.id}`, connection: granted.connection, now: T0 };
    let n = 0;
    const superseding = (target: string) =>
      mutate(
        sql,
        {
          op: "create",
          path: `facts/tests/new-${++n}.md`,
          raw: text(hidden)
            .replace(/^id: .*$/m, `id: ${ulid(T0 + n)}`)
            .replace("expires: 2027-03-15", `expires: 2027-03-15\nsupersedes: ${target}`),
          class: "normal",
        },
        agent,
      );
    const refused = {
      status: "invalid",
      issues: [{ field: "supersedes", message: "supersedes must name a note this connection can see." }],
    };
    same(superseding("ielts-2025-03.md"), refused);
    same(superseding("ielts-1999-01.md"), refused);
    // A note it can see still takes the edge (held, as it supersedes a held-type note).
    equal(superseding("ielts-2024-01.md").status, "proposed");
  },

  // A sync edit carries no connection, so the check reads the socket's principal: the same answer either way.
  "over sync too, a supersedes the reader can't see past answers the same whether a note is there": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    // A type scope that sees the IELTS score's class but not its type can't see it either.
    const scoped: Principal = { sensitive: true, types: ["Note"] };
    const seqs = new Map<Principal, number>();
    let n = 0;
    const superseding = (target: string, reader: Principal = AGENT) => {
      const clientId = reader === AGENT ? "agent" : "scoped";
      if (!seqs.has(reader)) serve(sql, hello(clientId, null), ctx, reader);
      const clientSeq = (seqs.get(reader) ?? 0) + 1;
      seqs.set(reader, clientSeq);
      const seq = ++n;
      const id = ulid(T0 + seq);
      const message: ClientMessage = {
        type: "mutate",
        clientId,
        clientSeq,
        changeId: `s${seq}`,
        ackedUpTo: 0,
        noteId: id,
        baseRev: 0,
        change: {
          kind: "create",
          path: `notes/n${seq}.md`,
          raw: `---\nid: ${id}\ntype: Note\nsupersedes: ${target}\n---\nmine\n`,
          class: "normal",
        },
      };
      return serve(sql, message, ctx, reader).replies.map((m) =>
        m.type === "result" ? { ok: m.ok, error: m.error, needsApproval: m.needsApproval } : m.type,
      );
    };
    // The verified IELTS score is hidden from this reader; nothing is at the other path.
    const hidden = superseding("../facts/tests/ielts-2026-11.md");
    same(hidden, superseding("../facts/tests/ielts-1999-01.md"));
    same(hidden, [
      { ok: false, error: "supersedes must name a note this connection can see.", needsApproval: undefined },
    ]);
    same(superseding("../facts/tests/ielts-2026-11.md", scoped), hidden);
    same(superseding("../facts/tests/ielts-1999-01.md", scoped), hidden);
  },

  // Held while the note moved on: a class change doesn't depend on its text, so it still lands.
  "a held change of class lands on the note as it is when it is accepted": (sql, fixtures) => {
    const { ids } = record(sql, fixtures);
    const role = ids[ROLE];
    ok(role);
    const floor = connect(sql, { kind: "cli" }, T0);
    const agent = { actor: `connection:${floor.id}`, connection: floor, now: T0 };
    const held = mutate(sql, { op: "classify", noteId: role, baseRev: 1, class: "sensitive" }, agent);
    ok(held.status === "proposed", JSON.stringify(held));
    const person = { actor: "human", now: T0 };
    const edit = {
      op: "patch",
      noteId: role,
      baseRev: 1,
      ops: [{ op: "set", path: ["kind"], value: "job" }],
    } as const;
    equal(mutate(sql, edit, person).status, "applied");
    equal(decide(sql, held.proposalId, "accept", person).status, "applied");
    same([getNote(sql, role)?.class, getNote(sql, role)?.rev], ["sensitive", 3]);
  },

  // Undo works newest first: it restores the note, then puts its class back, in one transaction that starts
  // from a deleted note.
  "undoing a run that made a note sensitive and then deleted it needs a signature": (sql, fixtures) => {
    migrate(sql);
    const raw = fixtures.find((f) => f.path === ROLE)?.raw ?? "";
    const person = { actor: "human", now: T0 };
    const made = mutate(sql, { op: "create", path: ROLE, raw, class: "normal" }, person);
    ok(made.status === "applied");
    const run = { ...ctx, runId: "01M6RUN0000000000000000003" };
    const noteId = made.noteId;
    equal(mutate(sql, { op: "classify", noteId, baseRev: 1, class: "sensitive" }, run).status, "applied");
    equal(mutate(sql, { op: "delete", noteId, baseRev: 2 }, run).status, "applied");

    const verdict = undoRun(sql, run.runId, person);
    ok(verdict.status === "needsApproval", JSON.stringify(verdict));
    const opened = openReview(
      sql,
      startReview(sql, [noteId], "human", T0),
      "human",
      signature(++signatures),
      T0,
    );
    ok("review" in opened, JSON.stringify(opened));
    equal(undoRun(sql, run.runId, { ...person, review: opened.review }).status, "needsApproval");
    same([getNote(sql, noteId)?.class, getNote(sql, noteId)?.deletedAt], ["sensitive", T0]);

    const approved = recordApproval(sql, verdict.items, signature(++signatures), T0);
    ok("approvalId" in approved, JSON.stringify(approved));
    equal(undoRun(sql, run.runId, { ...person, approvalId: approved.approvalId }).status, "applied");
    same([getNote(sql, noteId)?.class, getNote(sql, noteId)?.deletedAt], ["normal", null]);
  },

  // An answer stored while the note was normal can quote its text; it is replayed after the note turned sensitive.
  "a stored answer about a note that turned sensitive is replayed without its text": (sql, fixtures) => {
    const { ids } = record(sql, fixtures);
    const role = ids[ROLE];
    ok(role);
    const broken: ClientMessage = {
      type: "mutate",
      clientId: "agent",
      clientSeq: 1,
      changeId: "c-broken",
      ackedUpTo: 0,
      noteId: role,
      baseRev: 1,
      change: { kind: "put", raw: "---\nid: [CANARY-PRIVATE\n---\n", base: "" },
    };
    serve(sql, hello("agent", null), ctx, AGENT);
    const first = serve(sql, broken, ctx, AGENT).replies;
    // While the note is normal the answer says what is wrong, quoting the text: the suite would catch that.
    ok(JSON.stringify(first).includes("CANARY-PRIVATE"), JSON.stringify(first));
    equal(
      mutate(sql, { op: "classify", noteId: role, baseRev: 1, class: "sensitive" }, ctx).status,
      "applied",
    );

    const replays = [
      // Reconnecting before acknowledging it, resending it, and a repaired copy replaying its change.
      ...serve(sql, hello("agent", null), ctx, AGENT).replies.filter((m) => m.type === "result"),
      ...serve(sql, broken, ctx, AGENT).replies,
      ...serve(sql, hello("agent-repaired", null), ctx, AGENT).replies.filter((m) => m.type === "result"),
      ...serve(sql, { ...broken, clientId: "agent-repaired" }, ctx, AGENT).replies,
    ];
    same(
      replays.map((m) => (m.type === "result" ? [m.clientSeq, m.ok, m.error] : m.type)),
      Array.from({ length: 3 }, () => [1, false, `No note with id ${role}.`]),
    );
    ok(!JSON.stringify(replays).includes("CANARY"), JSON.stringify(replays));
    // The person still gets the whole answer.
    ok(JSON.stringify(serve(sql, broken, ctx, PERSON).replies).includes("CANARY-PRIVATE"));

    // The same change id on another change (here a note that doesn't exist) gets neither that answer nor an apply.
    const other = { ...broken, clientSeq: 2, noteId: "01M6ZZZZZZZZZZZZZZZZZZZZZZ" };
    same(
      serve(sql, other, ctx, AGENT).replies.map((m) => (m.type === "result" ? m.error : m.type)),
      ["This change id was already used for another change."],
    );

    // Deleted: a snapshot still names it as withheld, so a device holding it drops it with its history.
    const deleted = mutate(sql, { op: "delete", noteId: role, baseRev: 2 }, { actor: "human", now: T0 });
    equal(deleted.status, "applied");
    same(
      visible([changesSince(sql, null, AGENT)]).filter((note) => note.noteId === role),
      [{ noteId: role, seq: currentSeq(sql), deleted: true, withheld: true }],
    );
    // Then purged after 30 days: with no note left to check, the answer still says nothing of it.
    purge(sql, T0 + TOMBSTONE_MS + 1);
    equal(getNote(sql, role), undefined);
    const afterPurge = serve(sql, broken, ctx, AGENT).replies;
    same(
      afterPurge.map((m) => (m.type === "result" ? m.error : m.type)),
      [`No note with id ${role}.`],
    );
  },

  // Nothing changed in the record, so the feed after the cursor is empty: only a snapshot shows the difference.
  "a client whose principal changed since its cursor gets a snapshot": (sql, fixtures) => {
    const { ids } = record(sql, fixtures);
    const seq = currentSeq(sql);

    serve(sql, hello("laptop", null), ctx, AGENT);
    // The sensitive scope is granted: the same cursor now brings the notes it couldn't see.
    const granted = serve(sql, hello("laptop", seq), ctx, PERSON).replies;
    ok(granted.some((m) => m.type === "snapshot"));
    ok(live(granted).includes(ids[IELTS] ?? ""));
    // And narrowed again: the notes it holds come back withheld, so the device drops them.
    const narrowed = serve(sql, hello("laptop", seq), ctx, AGENT).replies;
    ok(narrowed.some((m) => m.type === "snapshot"));
    ok(!live(narrowed).includes(ids[IELTS] ?? ""));
    ok(visible(narrowed).some((note) => note.noteId === ids[IELTS] && note.deleted && note.withheld));
    // Under the same principal, the cursor still counts.
    same(
      serve(sql, hello("laptop", seq), ctx, AGENT).replies.map((m) => m.type),
      ["welcome", "changes"],
    );
  },
};
