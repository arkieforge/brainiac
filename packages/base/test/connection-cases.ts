// Conformance cases for connections (contract §3): levels, the sensitive scope, the hold window and who decides
// proposals. cases.ts runs them on both engines. A `Signature` stands for a passkey assertion the DO has checked
// (apps/worker/test/connections.test.ts checks real ones).
import { deepStrictEqual as same, equal, match, ok } from "node:assert/strict";

import { parseNote, splitNote, ulid, type ClientMessage, type PatchOp, type YamlValue } from "@brainiac/core";

import {
  authenticate,
  connect,
  principalOf,
  serve,
  currentSeq,
  DAY_MS,
  decide,
  disconnect,
  getConnection,
  getNote,
  grant,
  grantHash,
  migrate,
  mintToken,
  openReview,
  mutate,
  nextWake,
  planHash,
  recordApproval,
  releaseDue,
  restrict,
  startReview,
  tokenBase,
  undoRun,
  withdraw,
  type Connection,
  type Context,
  type Mutation,
  type MutationResult,
  type NoteClass,
  type Signature,
  type Sql,
} from "../src/index.ts";
import { holds, manifestOf } from "../src/hold.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const BASE_ID = "a".repeat(64);
const ROLE = "facts/roles/acme-intern-2025.md";
const IELTS_OLD = "facts/tests/ielts-2025-03.md";
const IELTS_NEW = "facts/tests/ielts-2026-11.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";

const raw = (fixtures: readonly Fixture[], path: string) => {
  const found = fixtures.find((f) => f.path === path);
  ok(found, path);
  return found.raw;
};

let signatures = 0;
const signed = (): Signature => ({
  credentialId: "passkey-1",
  counter: ++signatures,
  assertion: `{"n":${signatures}}`,
});

const human = (now = T0): Context => ({ actor: "human", now });
const via = (connection: Connection, now = T0): Context => ({
  actor: `connection:${connection.id}`,
  connection,
  now,
});

const applied = (result: { readonly status: string }) => {
  equal(result.status, "applied", JSON.stringify(result));
};

/** The fixture record with its manifest: the Role and the March IELTS unverified, test scores sensitive. */
function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", raw(fixtures, "okf-base.yaml"));
  const put = (path: string, cls: NoteClass) => {
    const result = mutate(sql, { op: "create", path, raw: raw(fixtures, path), class: cls }, human());
    ok(result.status === "applied", JSON.stringify(result));
    return result.noteId;
  };
  return { role: put(ROLE, "normal"), ielts: put(IELTS_OLD, "sensitive"), tum: put(TUM, "normal") };
}

/** A connection loosened with the person's signature, as the site does. */
function granted(sql: Sql, change: Partial<Pick<Connection, "level" | "sensitive" | "holdDays">>) {
  const connection = connect(sql, { kind: "cli" }, T0);
  const result = grant(sql, { ...connection, connectionId: connection.id, ...change }, signed());
  ok("connection" in result, JSON.stringify(result));
  return result.connection;
}

const set = (field: string, value: YamlValue): PatchOp => ({ op: "set", path: [field], value });
const section = (heading: string, content: string): PatchOp => ({ op: "section", heading, content });
const patchOf = (sql: Sql, noteId: string, ops: readonly PatchOp[]): Mutation => ({
  op: "patch",
  noteId,
  baseRev: getNote(sql, noteId)?.rev ?? 0,
  ops,
});
const field = (sql: Sql, noteId: string, key: string) => parseNote(getNote(sql, noteId)?.raw ?? "").data[key];

function proposed(result: MutationResult | ReturnType<typeof undoRun>) {
  equal(result.status, "proposed", JSON.stringify(result));
  ok(result.status === "proposed");
  return result;
}

const proposal = (sql: Sql, id: string) =>
  sql.all<{ status: string; kind: string; autoApplyAt: number | null }>(
    "SELECT status, kind, autoApplyAt FROM proposals WHERE id = ?",
    id,
  )[0];

export const connectionCases: Record<string, Case> = {
  "a new connection starts at propose, without the sensitive scope, with a 3-day hold": (sql) => {
    migrate(sql);
    const cli = connect(sql, { kind: "cli" }, T0);
    same([cli.level, cli.sensitive, cli.holdDays], ["propose", false, 3]);
    // An MCP client that connects again keeps its connection, and whatever was granted to it.
    const app = connect(sql, { kind: "oauth", oauthClientId: "https://claude.ai/oauth/mcp-client" }, T0);
    ok("connection" in restrict(sql, app.id, { level: "read" }));
    same(connect(sql, { kind: "oauth", oauthClientId: "https://claude.ai/oauth/mcp-client" }, T0 + 1), {
      ...app,
      level: "read",
      rev: 1,
    });
  },

  "a CLI token names its record, is stored only as a hash, and dies with its connection": (sql) => {
    migrate(sql);
    const cli = connect(sql, { kind: "cli" }, T0);
    const token = mintToken(sql, BASE_ID, cli.id, T0);
    equal(tokenBase(token), BASE_ID);
    same(authenticate(sql, token, T0)?.id, cli.id);
    same(sql.all("SELECT hash FROM tokens WHERE hash = ?", token), []);
    // The same secret under another record's id is another token, which this record never issued.
    const elsewhere = token.replace(BASE_ID, "b".repeat(64));
    equal(tokenBase(elsewhere), "b".repeat(64));
    equal(authenticate(sql, elsewhere, T0), undefined);
    equal(authenticate(sql, `${token}x`, T0), undefined);
    disconnect(sql, cli.id);
    equal(authenticate(sql, token, T0), undefined);
    equal(getConnection(sql, cli.id), undefined);
  },

  "loosening a connection needs a signature over its exact grants at its current rev; tightening doesn't": (
    sql,
  ) => {
    migrate(sql);
    const cli = connect(sql, { kind: "cli" }, T0);
    match(JSON.stringify(restrict(sql, cli.id, { level: "write" })), /passkey/);
    match(JSON.stringify(restrict(sql, cli.id, { sensitive: true })), /passkey/);
    match(JSON.stringify(restrict(sql, cli.id, { holdDays: 1 })), /passkey/);
    const plan = {
      connectionId: cli.id,
      rev: cli.rev,
      level: "write",
      sensitive: true,
      holdDays: 3,
    } as const;
    ok("error" in grant(sql, { ...plan, sensitive: "yes" as unknown as boolean }, signed()));
    const signature = signed();
    const raised = grant(sql, plan, signature);
    ok("connection" in raised, JSON.stringify(raised));
    same([raised.connection.level, raised.connection.sensitive], ["write", true]);
    // Lowered afterwards: the old signature can't raise it again, nor can a fresh one over the old plan.
    ok("connection" in restrict(sql, cli.id, { level: "read", sensitive: false }));
    ok("error" in grant(sql, plan, signature));
    ok("error" in grant(sql, plan, signed()));
    equal(getConnection(sql, cli.id)?.level, "read");
    // A grant's hash can never be a note plan's.
    ok(grantHash({ ...plan, rev: 2 }) !== planHash([]));
  },

  "canary: a connection sees and changes no sensitive note until the scope is granted": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    // Its values and text: none may reach the connection, in any answer.
    const canaries = ["Writing held", "listening", "2025-03-15"];
    const writer = granted(sql, { level: "write" });
    const results: unknown[] = [
      mutate(sql, patchOf(sql, ielts, [set("overall", 9)]), via(writer)),
      mutate(sql, { op: "put", noteId: ielts, baseRev: 1, raw: "---\nid: x\n---\n" }, via(writer)),
      mutate(sql, { op: "delete", noteId: ielts, baseRev: 1 }, via(writer)),
      // A stale revision would say what the current one is.
      mutate(sql, { op: "delete", noteId: ielts, baseRev: 7 }, via(writer)),
    ];
    for (const result of results)
      same(result, {
        status: "invalid",
        issues: [{ field: "noteId", message: `No note with id ${ielts}.` }],
      });
    // Taking its path doesn't say what is there.
    const taken = mutate(
      sql,
      {
        op: "create",
        path: IELTS_OLD.toUpperCase(),
        raw: raw(fixtures, ROLE).replace(/^id: .*$/m, `id: ${ulid(T0)}`),
        class: "normal",
      },
      via(writer),
    );
    // Nor does bringing back a deleted note whose path a sensitive note took since.
    const tum = getNote(sql, String(parseNote(raw(fixtures, TUM)).data["id"]));
    ok(tum);
    applied(mutate(sql, { op: "delete", noteId: tum.id, baseRev: tum.rev }, human()));
    const squatter = raw(fixtures, ROLE).replace(/^id: .*$/m, `id: ${ulid(T0 + 1)}`);
    applied(
      mutate(sql, { op: "create", path: TUM.toUpperCase(), raw: squatter, class: "sensitive" }, human()),
    );
    same(mutate(sql, { op: "put", noteId: tum.id, baseRev: tum.rev + 1, raw: tum.raw }, via(writer)), {
      status: "invalid",
      issues: [{ field: "path", message: `${TUM} is taken since this note was deleted.` }],
    });
    same(taken, {
      status: "invalid",
      issues: [{ field: "path", message: `${IELTS_OLD.toUpperCase()} is taken.` }],
    });
    // Undoing a run that touched it would show its values in the conflicts.
    const run = mutate(sql, patchOf(sql, ielts, [set("note", "x")]), { ...human(), runId: "run-1" });
    applied(run);
    equal(undoRun(sql, "run-1", via(writer)).status, "forbidden");
    for (const text of [JSON.stringify(results), JSON.stringify(taken)])
      for (const canary of canaries) ok(!text.includes(canary), `${canary} leaked: ${text}`);
    equal(field(sql, ielts, "overall"), 7);

    const trusted = granted(sql, { level: "write", sensitive: true });
    // With the scope it reaches the note, and the hold still applies to the score.
    proposed(mutate(sql, patchOf(sql, ielts, [set("overall", 9)]), via(trusted)));
  },

  "a write connection's change to an existing held value waits out its hold, then applies on its own": (
    sql,
    fixtures,
  ) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    // A new value isn't a change to an existing one.
    applied(mutate(sql, patchOf(sql, role, [set("team", "fleet")]), via(writer)));
    const seq = currentSeq(sql);
    const held = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(writer)));
    equal(held.autoApplyAt, T0 + 3 * DAY_MS);
    equal(currentSeq(sql), seq);
    equal(field(sql, role, "end"), "2025-09-30");
    // With no jobs due, the record next wakes for the hold.
    sql.all("DELETE FROM jobs");
    equal(nextWake(sql, T0), held.autoApplyAt);

    releaseDue(sql, T0 + 3 * DAY_MS - 1);
    equal(field(sql, role, "end"), "2025-09-30");
    releaseDue(sql, T0 + 3 * DAY_MS);
    equal(field(sql, role, "end"), "2025-10-31");
    equal(proposal(sql, held.proposalId)?.status, "applied");
    same(sql.all("SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1", role), [
      { actor: `connection:${writer.id}` },
    ]);
    // Deleting a held-type note changes all its values.
    proposed(mutate(sql, { op: "delete", noteId: role, baseRev: getNote(sql, role)?.rev ?? 0 }, via(writer)));
  },

  "notes of types that aren't held change at once, and a 0-day hold holds nothing": (sql, fixtures) => {
    const { role, tum } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    applied(mutate(sql, patchOf(sql, tum, [set("status", "submitted")]), via(writer)));
    const instant = granted(sql, { level: "write", holdDays: 0 });
    applied(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(instant)));
    // The person and unattributed sync edits never wait.
    applied(mutate(sql, patchOf(sql, role, [set("end", "2025-11-30")]), human()));
  },

  "moving a note can't escape the hold": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    // Changing the type away from a held one changes an existing value of a held-type note.
    proposed(mutate(sql, patchOf(sql, role, [set("type", "Person"), set("role", "advisor")]), via(writer)));
    // Moves arrive with #38; the hold judges their effect today. Any note leaving a held area is held, and a
    // held-type note is held wherever it goes.
    const manifest = manifestOf(sql);
    const note = getNote(sql, role);
    ok(note);
    const moved = (path: string, fm = note.fm) =>
      holds(sql, manifest, { before: note, after: { ...note, path, fm } });
    ok(moved("archive/acme-intern-2025.md"));
    ok(moved("facts/education/acme-intern-2025.md"));
    const untyped = JSON.stringify({ ...JSON.parse(note.fm), type: "Note" });
    ok(
      holds(sql, manifest, {
        before: { ...note, fm: untyped },
        after: { ...note, fm: untyped, path: "archive/a.md" },
      }),
    );
    ok(
      holds(sql, manifest, {
        before: { ...note, fm: untyped },
        after: { ...note, fm: untyped, path: "FACTS/ROLES/b.md" },
      }),
    );
    ok(
      !holds(sql, manifest, {
        before: { ...note, fm: untyped, path: "notes/a.md" },
        after: { ...note, fm: untyped, path: "archive/a.md" },
      }),
    );
  },

  "a new note is never held, unless it supersedes a held-type note": (sql, fixtures) => {
    record(sql, fixtures);
    const writer = granted(sql, { level: "write", sensitive: true });
    const plain = raw(fixtures, IELTS_NEW)
      .replace(/^supersedes:.*\n/m, "")
      .replace(/^verified:.*\n/m, "");
    applied(
      mutate(
        sql,
        {
          op: "create",
          path: "facts/tests/ielts-2026-12.md",
          raw: plain.replace(/^id: .*$/m, `id: ${ulid(T0)}`),
          class: "sensitive",
        },
        via(writer),
      ),
    );
    const superseding = raw(fixtures, IELTS_NEW).replace(/^verified:.*\n/m, "");
    const held = proposed(
      mutate(sql, { op: "create", path: IELTS_NEW, raw: superseding, class: "sensitive" }, via(writer)),
    );
    equal(getNote(sql, String(parseNote(superseding).data["id"])), undefined);
    releaseDue(sql, held.autoApplyAt ?? 0);
    equal(proposal(sql, held.proposalId)?.status, "applied");
    ok(getNote(sql, String(parseNote(superseding).data["id"])));
  },

  "a change on the approval list needs the passkey first, and the signature releases it from the hold": (
    sql,
    fixtures,
  ) => {
    const { ielts } = record(sql, fixtures);
    const writer = granted(sql, { level: "write", sensitive: true });
    const verify = patchOf(sql, ielts, [set("verified", { by: "human", fields: ["overall"] })]);
    const verdict = mutate(sql, verify, via(writer));
    ok(verdict.status === "needsApproval", JSON.stringify(verdict));
    const approved = recordApproval(sql, verdict.items, signed(), T0);
    ok("approvalId" in approved);
    applied(mutate(sql, verify, { ...via(writer), approvalId: approved.approvalId }));
    ok(field(sql, ielts, "verified"));
  },

  "a propose connection's every change waits for the person; a read connection changes nothing": (
    sql,
    fixtures,
  ) => {
    const { tum } = record(sql, fixtures);
    const proposer = connect(sql, { kind: "cli" }, T0);
    const waiting = proposed(mutate(sql, patchOf(sql, tum, [set("status", "submitted")]), via(proposer)));
    equal(waiting.autoApplyAt, null);
    releaseDue(sql, T0 + 365 * DAY_MS);
    equal(field(sql, tum, "status"), "preparing");
    applied(decide(sql, waiting.proposalId, "accept", human()));
    equal(field(sql, tum, "status"), "submitted");

    ok("connection" in restrict(sql, proposer.id, { level: "read" }));
    const reader = getConnection(sql, proposer.id);
    ok(reader);
    equal(mutate(sql, patchOf(sql, tum, [set("status", "decided")]), via(reader)).status, "forbidden");
    equal(undoRun(sql, "anything", via(reader)).status, "forbidden");
    equal(field(sql, tum, "status"), "submitted");
  },

  "over sync, a read connection's file edit is refused and uses up its number; a propose one's lands unheld":
    (sql, fixtures) => {
      const { role } = record(sql, fixtures);
      const before = getNote(sql, role)?.raw ?? "";
      const ENDS = ["", "2025-10-31", "2025-11-30"];
      const edit = (clientId: string, clientSeq: number): ClientMessage => ({
        type: "mutate",
        clientId,
        clientSeq,
        changeId: `${clientId}-${clientSeq}`,
        ackedUpTo: 0,
        noteId: role,
        baseRev: 1,
        change: { kind: "put", raw: before.replace(/^end: .*$/m, `end: ${ENDS[clientSeq]}`), base: before },
      });
      const sent = (connection: Connection, message: ClientMessage) => {
        const actor = `connection:${connection.id}`;
        const ctx = { actor, now: T0, readOnly: connection.level === "read" };
        return serve(sql, message, ctx, principalOf(connection)).replies;
      };

      const reader = connect(sql, { kind: "cli" }, T0);
      ok("connection" in restrict(sql, reader.id, { level: "read" }));
      const readOnly = getConnection(sql, reader.id);
      ok(readOnly);
      same(
        sent(readOnly, edit("reader", 1)).map((m) => (m.type === "result" ? [m.ok, m.error] : m.type)),
        [[false, "This connection can only read."]],
      );
      // Its number is used up, so the next one is taken in order rather than stuck behind a resend.
      same(
        sent(readOnly, edit("reader", 2)).map((m) => (m.type === "result" ? m.clientSeq : m.type)),
        [2],
      );
      equal(getNote(sql, role)?.raw, before);

      // The Role is a held type, which a propose connection's tool call could only propose: a file edit lands.
      const proposer = connect(sql, { kind: "cli" }, T0);
      same(
        sent(proposer, edit("proposer", 1)).map((m) => (m.type === "result" ? [m.ok, m.rev] : m.type)),
        [[true, 2]],
      );
      equal(field(sql, role, "end"), ENDS[1]);
      same(sql.all("SELECT id FROM proposals"), []);
    },

  "only the person decides a proposal; a connection withdraws only its own": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const other = granted(sql, { level: "write" });
    const held = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(writer)));
    equal(decide(sql, held.proposalId, "accept", via(writer)).status, "forbidden");
    equal(decide(sql, held.proposalId, "reject", via(writer)).status, "forbidden");
    equal(withdraw(sql, held.proposalId, via(other)).status, "invalid");
    equal(withdraw(sql, held.proposalId, human()).status, "invalid");
    equal(withdraw(sql, held.proposalId, via(writer)).status, "withdrawn");
    releaseDue(sql, T0 + 30 * DAY_MS);
    equal(field(sql, role, "end"), "2025-09-30");
    equal(decide(sql, held.proposalId, "accept", human()).status, "invalid");

    // The person decides early either way: reject drops it, accept applies it now.
    const rejected = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-11-30")]), via(writer)));
    same(decide(sql, rejected.proposalId, "reject", human()), { status: "rejected" });
    const accepted = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-12-31")]), via(writer)));
    applied(decide(sql, accepted.proposalId, "accept", human()));
    equal(field(sql, role, "end"), "2025-12-31");
    releaseDue(sql, T0 + 30 * DAY_MS);
    equal(field(sql, role, "end"), "2025-12-31");
  },

  "a held change meets newer edits: other fields let it apply, its own field makes it a conflict to pick": (
    sql,
    fixtures,
  ) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const first = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(writer)));
    applied(mutate(sql, patchOf(sql, role, [set("org", "Acme Robotics GmbH")]), human()));
    releaseDue(sql, first.autoApplyAt ?? 0);
    same([field(sql, role, "end"), field(sql, role, "org")], ["2025-10-31", "Acme Robotics GmbH"]);

    const second = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-11-30")]), via(writer)));
    applied(mutate(sql, patchOf(sql, role, [set("end", "2025-12-15")]), human()));
    releaseDue(sql, second.autoApplyAt ?? 0);
    equal(field(sql, role, "end"), "2025-12-15");
    same(proposal(sql, second.proposalId), { status: "open", kind: "conflict", autoApplyAt: null });
    // The person picks the held side.
    applied(decide(sql, second.proposalId, "accept", human()));
    equal(field(sql, role, "end"), "2025-11-30");

    // An op that did nothing when it was held (org set to the value it had) would undo the person's edit now.
    const third = proposed(
      mutate(
        sql,
        patchOf(sql, role, [set("end", "2026-01-31"), set("org", "Acme Robotics GmbH")]),
        via(writer),
      ),
    );
    applied(mutate(sql, patchOf(sql, role, [set("org", "Acme Robotics AG")]), human()));
    releaseDue(sql, third.autoApplyAt ?? 0);
    same([field(sql, role, "end"), field(sql, role, "org")], ["2025-11-30", "Acme Robotics AG"]);
    equal(proposal(sql, third.proposalId)?.kind, "conflict");
  },

  "bringing back a deleted held-type note with other values is held, and so is rewriting its body": (
    sql,
    fixtures,
  ) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const text = getNote(sql, role)?.raw ?? "";
    applied(mutate(sql, { op: "delete", noteId: role, baseRev: 1 }, human()));
    const changed = text.replace("end: 2025-09-30", "end: 2025-12-31");
    proposed(mutate(sql, { op: "put", noteId: role, baseRev: 2, raw: changed }, via(writer)));
    equal(getNote(sql, role)?.deletedAt, T0);
    // Brought back as it was: nothing existing changes.
    applied(mutate(sql, { op: "put", noteId: role, baseRev: 2, raw: text }, via(writer)));

    proposed(
      mutate(
        sql,
        patchOf(sql, role, [section("What I did", "Ran the whole robotics division.\n")]),
        via(writer),
      ),
    );
    // Text added after the body is a new value.
    applied(mutate(sql, patchOf(sql, role, [section("Next", "A second internship.\n")]), via(writer)));

    // Run onto a last line with no newline, it changes what that line says.
    const withBody = (body: string): Mutation => {
      const note = getNote(sql, role);
      ok(note);
      return {
        op: "put",
        noteId: role,
        baseRev: note.rev,
        raw: note.raw.slice(0, splitNote(note.raw).bodyStart) + body,
      };
    };
    applied(mutate(sql, withBody("Led a team of 5"), human()));
    // So is the next line without a blank one: markdown reads it as the same paragraph.
    for (const body of [
      "Led a team of 50",
      "Led a team of 5 (declined)",
      "Led a team of 5\n(declined)",
      // Not a heading without the space: the same paragraph.
      "Led a team of 5\n#1 of 3 teams, declined",
    ])
      proposed(mutate(sql, withBody(body), via(writer)));
    // A new field leaves that body as it is.
    applied(mutate(sql, patchOf(sql, role, [set("floor", 3)]), via(writer)));
    // A new paragraph or heading is new text.
    applied(mutate(sql, withBody("Led a team of 5\n\nThen more."), via(writer)));
    applied(mutate(sql, withBody("Led a team of 5\n\nThen more.\n## Later\n"), via(writer)));
    applied(
      mutate(
        sql,
        withBody("Led a team of 5\n\nThen more.\n## Later\n\r\n\r\nWindows paragraph."),
        via(writer),
      ),
    );
  },

  "a released change applies only as it was held": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const run = { ...human(), runId: "run-2" };
    applied(mutate(sql, patchOf(sql, role, [set("title_short", "SWE"), set("team", "fleet")]), run));
    applied(mutate(sql, patchOf(sql, role, [set("title_short", "Intern")]), human()));
    // Held: removing `team` (title_short was edited since, so undoing it would be a conflict).
    const held = proposed(undoRun(sql, "run-2", via(writer)));
    // Back where the run left it: undoing now would also revert title_short, which the hold never showed.
    applied(mutate(sql, patchOf(sql, role, [set("title_short", "SWE")]), human()));
    releaseDue(sql, held.autoApplyAt ?? 0);
    same([field(sql, role, "title_short"), field(sql, role, "team")], ["SWE", "fleet"]);
    same(proposal(sql, held.proposalId), { status: "open", kind: "change", autoApplyAt: null });
    equal(decide(sql, held.proposalId, "accept", human()).status, "invalid");
  },

  "a longer hold pushes back what is already waiting": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const held = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(writer)));
    ok("connection" in restrict(sql, writer.id, { holdDays: 10 }));
    releaseDue(sql, held.autoApplyAt ?? 0);
    equal(field(sql, role, "end"), "2025-09-30");
    equal(proposal(sql, held.proposalId)?.autoApplyAt, T0 + 10 * DAY_MS);
    // A longer hold signed with other grants does the same.
    const now = getConnection(sql, writer.id);
    ok(now);
    ok("connection" in grant(sql, { ...now, connectionId: now.id, sensitive: true, holdDays: 12 }, signed()));
    equal(proposal(sql, held.proposalId)?.autoApplyAt, T0 + 12 * DAY_MS);
  },

  "a held undo undoes only what the run had done when it was held": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const run = { ...via(writer), runId: "run-1" };
    applied(mutate(sql, patchOf(sql, role, [set("team", "fleet")]), run));
    // Undoing removes a value the Role now has: held like any other change to it.
    const held = proposed(undoRun(sql, "run-1", via(writer)));
    applied(mutate(sql, patchOf(sql, role, [set("floor", 3)]), run));
    releaseDue(sql, held.autoApplyAt ?? 0);
    same([field(sql, role, "team"), field(sql, role, "floor")], [undefined, 3]);
  },

  "the person's review session covers accepting a proposal, as it covers their own edit": (sql, fixtures) => {
    const { ielts } = record(sql, fixtures);
    const verify = patchOf(sql, ielts, [set("verified", { by: "human", fields: ["overall"] })]);
    const verdict = mutate(sql, verify, human());
    ok(verdict.status === "needsApproval");
    const approved = recordApproval(sql, verdict.items, signed(), T0);
    ok("approvalId" in approved);
    applied(mutate(sql, verify, { ...human(), approvalId: approved.approvalId }));

    const proposer = granted(sql, { level: "propose", sensitive: true });
    const waiting = proposed(mutate(sql, patchOf(sql, ielts, [set("overall", 7.5)]), via(proposer)));
    equal(decide(sql, waiting.proposalId, "accept", human()).status, "needsApproval");
    const nonce = startReview(sql, [ielts], "human", T0);
    ok("review" in openReview(sql, nonce, "human", signed(), T0));
    applied(decide(sql, waiting.proposalId, "accept", { ...human(), review: nonce }));
    equal(field(sql, ielts, "overall"), 7.5);
  },

  "a held change whose connection is lowered or gone waits for the person": (sql, fixtures) => {
    const { role } = record(sql, fixtures);
    const writer = granted(sql, { level: "write" });
    const lowered = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-10-31")]), via(writer)));
    ok("connection" in restrict(sql, writer.id, { level: "propose" }));
    // It shows no release time it won't keep.
    equal(proposal(sql, lowered.proposalId)?.autoApplyAt, null);
    releaseDue(sql, lowered.autoApplyAt ?? 0);
    equal(field(sql, role, "end"), "2025-09-30");
    same(proposal(sql, lowered.proposalId), { status: "open", kind: "change", autoApplyAt: null });

    const gone = granted(sql, { level: "write" });
    const orphan = proposed(mutate(sql, patchOf(sql, role, [set("end", "2025-11-30")]), via(gone)));
    disconnect(sql, gone.id);
    releaseDue(sql, orphan.autoApplyAt ?? 0);
    equal(field(sql, role, "end"), "2025-09-30");
    applied(decide(sql, orphan.proposalId, "accept", human()));
    equal(field(sql, role, "end"), "2025-11-30");
  },
};
