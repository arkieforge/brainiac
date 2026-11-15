// Conformance cases for imports (imports.ts, through the `import` tool): what `brainiac import` sends waits as
// proposals whatever the connection's level, what the record has is left out, and a vault's notes keep their bytes.
// cases.ts runs them on both engines; packages/core/src/imports.test.ts covers reading the files.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { fromLinkedIn, fromVault, parseNote } from "@brainiac/core";

import {
  callTool,
  connect,
  decide,
  getNoteByPath,
  getConnection,
  listNotes,
  migrate,
  mutate,
  type Connection,
  type NoteClass,
  type Sql,
  type ToolContext,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 11, 1);

// The fixture student's LinkedIn export (fixtures/imports/linkedin-export), the rows these cases need.
const EXPORT = new Map([
  [
    "Positions.csv",
    `Company Name,Title,Description,Location,Started On,Finished On
Northvale University,Teaching Assistant,"Runs the weekly Compilers labs, for 120 students.","Dhaka, Bangladesh",Sep 2025,
Acme Robotics,Software Engineering Intern,Built the fleet telemetry dashboard and cut alert noise by a third.,"Dhaka, Bangladesh",Jul 2025,Sep 2025
`,
  ],
  [
    "Education.csv",
    `School Name,Start Date,End Date,Notes,Degree Name,Activities
Northvale University,2021,2025,Thesis on low-resource named entity recognition.,BSc Computer Science,Programming club
`,
  ],
  ["Skills.csv", "Name\nPython\nTypeScript\n"],
]);

/** The fixture record with its manifest, as the person made it; test scores and people are sensitive. */
function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  for (const { path, raw } of fixtures) {
    if (path === "okf-base.yaml") sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", raw);
  }
  for (const { path, raw } of fixtures) {
    if (!path.endsWith(".md") || /verified:/.test(raw)) continue; // a verified one takes a passkey; not needed here
    const cls: NoteClass = /^(facts\/tests|people)\//.test(path) ? "sensitive" : "normal";
    const result = mutate(sql, { op: "create", path, raw, class: cls }, { actor: "human", now: T0 });
    ok(result.status === "applied", `${path}: ${JSON.stringify(result)}`);
  }
}

/** A CLI connection at `level`, as a passkey grant would leave it (the grant's own checks are connection-cases'). */
function connection(sql: Sql, level: Connection["level"], sensitive = false): Connection {
  const { id } = connect(sql, { kind: "cli" }, T0);
  sql.all("UPDATE connections SET level = ?, sensitive = ? WHERE id = ?", level, sensitive ? 1 : 0, id);
  const made = getConnection(sql, id);
  ok(made);
  return made;
}

const as = (made: Connection, extra: Partial<ToolContext> = {}): ToolContext => ({
  actor: `connection:${made.id}`,
  connection: made,
  now: T0,
  ...extra,
});

type Result = { status: string; path?: string; of?: string; proposal?: string; issues?: unknown };

function importing(sql: Sql, ctx: ToolContext, args: Record<string, unknown>): Result[] {
  const answer = callTool(sql, "import", args, ctx);
  ok(answer.ok, JSON.stringify(answer));
  const value = answer.value as { results?: Result[]; status?: string };
  ok(value.results, JSON.stringify(value));
  return value.results;
}

const plan = fromLinkedIn(EXPORT);
const args = { notes: plan.notes, inbox: plan.inbox.map(({ text }) => ({ text })) };

const openProposals = (sql: Sql) =>
  sql.all<{ id: string }>("SELECT id FROM proposals WHERE status = 'open' ORDER BY id").map((p) => p.id);

export const importCases: Record<string, Case> = {
  "a LinkedIn export is proposed for the person, even from a write-level connection, and the record's own roles and schools are left out":
    (sql, fixtures) => {
      record(sql, fixtures);
      const before = listNotes(sql).length;
      const results = importing(sql, as(connection(sql, "write")), args);
      same(
        results.map(({ status, path, of }) => [status, path, of]),
        [
          ["proposed", "facts/roles/teaching-assistant-northvale-university-2025.md", undefined],
          // The fixture's own internship and BSc, matched on their types' keys (org, title, start; institution, degree).
          [
            "duplicate",
            "facts/roles/software-engineering-intern-acme-robotics-2025.md",
            "facts/roles/acme-intern-2025.md",
          ],
          [
            "duplicate",
            "facts/education/bsc-computer-science-northvale-university.md",
            "facts/education/bsc-northvale.md",
          ],
          ["applied", results[3]?.path, undefined],
        ],
      );
      // The proposal waits for the person (no hold to run out), and nothing but the inbox item is written.
      const [proposal] = sql.all<{ autoApplyAt: number | null; actor: string }>(
        "SELECT autoApplyAt, actor FROM proposals WHERE status = 'open'",
      );
      equal(proposal?.autoApplyAt, null);
      equal(listNotes(sql).length, before + 1);
      equal(getNoteByPath(sql, results[3]?.path ?? "")?.type, "InboxItem");

      // The person accepts: the role is what LinkedIn said, with today as an open end.
      const accepted = decide(sql, results[0]?.proposal ?? "", "accept", { actor: "human", now: T0 + 1 });
      ok(accepted.status === "applied", JSON.stringify(accepted));
      const role = getNoteByPath(sql, "facts/roles/teaching-assistant-northvale-university-2025.md");
      ok(role);
      same(parseNote(role.raw).data, {
        type: "Role",
        title: "Teaching Assistant, Northvale University",
        org: "Northvale University",
        start: "2025-09-01",
        current: true,
        id: role.id,
      });
    },

  "importing the same export again changes nothing: open proposals and inbox items count as already there": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    const ctx = as(connection(sql, "propose"));
    importing(sql, ctx, args);
    const proposals = openProposals(sql);
    const notes = listNotes(sql).length;
    const again = importing(sql, ctx, args);
    same(
      again.map((r) => r.status),
      ["duplicate", "duplicate", "duplicate", "duplicate"],
    );
    same(openProposals(sql), proposals);
    equal(listNotes(sql).length, notes);
  },

  "an OKF vault's notes keep their ids, paths and bytes, and land sensitive in a sensitive area": (
    sql,
    fixtures,
  ) => {
    migrate(sql); // a new record: no notes, no manifest
    const vault = fromVault(new Map(fixtures.map(({ path, raw }) => [path, raw])));
    const results = importing(sql, as(connection(sql, "propose", true)), { notes: vault.notes });
    ok(results.length > 0 && results.every((r) => r.status === "proposed"), JSON.stringify(results));
    for (const result of results) {
      const accepted = decide(sql, result.proposal ?? "", "accept", { actor: "human", now: T0 + 1 });
      ok(accepted.status === "applied", `${result.path}: ${JSON.stringify(accepted)}`);
    }
    for (const draft of vault.notes) {
      const note = getNoteByPath(sql, draft.path);
      ok(note, draft.path);
      equal(note.raw, draft.raw, draft.path);
      equal(note.id, parseNote(draft.raw).data["id"]);
      equal(
        note.class,
        draft.path.startsWith("people/") || draft.path.startsWith("facts/tests/") ? "sensitive" : "normal",
      );
    }
    // Only the November score was marked verified; it arrives without the mark, every other byte the same.
    const ielts = fixtures.find((f) => f.path === "facts/tests/ielts-2026-11.md");
    equal(
      getNoteByPath(sql, "facts/tests/ielts-2026-11.md")?.raw,
      ielts?.raw.replace(/^verified: .*\n/m, ""),
    );
  },

  "a vault note without an id gets one, at the end of its front-matter, and every other byte stays": (
    sql,
  ) => {
    migrate(sql);
    const raw = "---\ntype: Award\ntitle: Dean's List   # spring\n---\n# Dean's List\n\nTop 5%.\n";
    const [result] = importing(sql, as(connection(sql, "propose")), {
      notes: [{ raw, path: "facts/awards/deans-list.md" }],
    });
    ok(result?.status === "proposed", JSON.stringify(result));
    ok(decide(sql, result.proposal ?? "", "accept", { actor: "human", now: T0 + 1 }).status === "applied");
    const note = getNoteByPath(sql, "facts/awards/deans-list.md");
    ok(note);
    equal(
      note.raw,
      `---\ntype: Award\ntitle: Dean's List   # spring\nid: ${note.id}\n---\n# Dean's List\n\nTop 5%.\n`,
    );
  },

  "a connection without the sensitive scope can't import a sensitive note, and is never told of a hidden one":
    (sql, fixtures) => {
      record(sql, fixtures);
      const okafor = fixtures.find((f) => f.path === "people/dr-okafor.md");
      ok(okafor);
      // The same person, as a vault would hold it.
      const raw = okafor.raw.replace(/^id: .*\n/m, "");
      const floor = as(connection(sql, "propose"));
      const [sensitive] = importing(sql, floor, {
        notes: [{ raw, path: "people/dr-okafor.md", sensitive: true }],
      });
      equal(sensitive?.status, "forbidden", JSON.stringify(sensitive));
      // Sensitive inbox text too: a second import couldn't tell it was there.
      const notes = listNotes(sql).length;
      const [text] = importing(sql, floor, {
        inbox: [{ text: "IELTS re-mark: writing 7.5", sensitive: true }],
      });
      equal(text?.status, "forbidden", JSON.stringify(text));
      equal(listNotes(sql).length, notes);
      // Sent as normal, it matches only a note the connection can't see: a new proposal, at a path that names nobody.
      const [normal] = importing(sql, floor, { notes: [{ raw, path: "people/dr-okafor.md" }] });
      equal(normal?.status, "proposed", JSON.stringify(normal));
      ok(normal.path !== "people/dr-okafor.md");
      // With the scope, the same note is the one the record has.
      const [seen] = importing(sql, as(connection(sql, "propose", true)), {
        notes: [{ raw, path: "people/dr-okafor.md", sensitive: true }],
      });
      same([seen?.status, seen?.of], ["duplicate", "people/dr-okafor.md"]);
    },

  "a note the record's types refuse comes back invalid, and a read-level or background connection imports nothing":
    (sql, fixtures) => {
      record(sql, fixtures);
      const [refused] = importing(sql, as(connection(sql, "write")), {
        notes: [
          {
            raw: "---\ntype: Role\ntitle: Founder, Example Labs\norg: Example Labs\n---\n",
            path: "facts/roles/founder.md",
          },
        ],
      });
      equal(refused?.status, "invalid", JSON.stringify(refused));
      const notes = listNotes(sql).length;
      for (const ctx of [as(connection(sql, "read")), as(connection(sql, "write"), { background: true })]) {
        const answer = callTool(sql, "import", args, ctx);
        ok(answer.ok && (answer.value as { status?: string }).status === "forbidden", JSON.stringify(answer));
      }
      equal(listNotes(sql).length, notes);
      same(openProposals(sql), []);
    },
};
