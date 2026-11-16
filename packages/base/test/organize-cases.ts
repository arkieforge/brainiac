// Conformance cases for structure growth and customization: organize's types, placements, approvals, merges,
// undo and self-test (organize.ts), the glossary in search, and describe's me and settings. cases.ts runs them on
// both engines.
import { deepStrictEqual as same, equal, match, ok } from "node:assert/strict";

import { parseManifest, parseNote, type PlanItem } from "@brainiac/core";

import { getNote, mutate, recordApproval, search, PERSON, type Sql, type ToolContext } from "../src/index.ts";
import type { Case } from "./cases.ts";
import { as, call, connection, indexed, record, signature } from "./tool-cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const PERSON_CTX: ToolContext = { actor: "human", now: T0 };

/** A Fact the person made, as a note that fits no type yet would be kept. */
function fact(sql: Sql, id: string, path: string, title: string): string {
  const raw = `---\nid: ${id}\ntype: Fact\ntitle: "${title}"\ntags: [travel]\n---\n`;
  const made = mutate(sql, { op: "create", path, raw, class: "normal" }, PERSON_CTX);
  ok(made.status === "applied", JSON.stringify(made));
  return id;
}

/** An organize call carried through the person's passkey: the plan it asks for, signed, then the call again. */
function signed(sql: Sql, ctx: ToolContext, args: Record<string, unknown>) {
  const planned = call(sql, ctx, "organize", args);
  if (planned["status"] !== "needsApproval") return { planned, done: planned };
  const approved = recordApproval(sql, planned["items"] as PlanItem[], signature(), T0);
  ok("approvalId" in approved, JSON.stringify(approved));
  return { planned, done: call(sql, ctx, "organize", { ...args, approval_id: approved.approvalId }) };
}

const manifest = (sql: Sql) =>
  sql.all<{ version: number; manifest: string }>(
    "SELECT version, manifest FROM schema ORDER BY version DESC LIMIT 1",
  )[0];
const typesNow = (sql: Sql) => parseManifest(manifest(sql)?.manifest ?? "").types;

const [JP, TH] = ["01M6FACT00000000000000JP24", "01M6FACT00000000000000TH23"];
const trip = { name: "Trip", base: 0, catalog: "trip@2" };

export const organizeCases: Record<string, Case> = {
  "organize adds a catalog type and files Facts into it as one signed run, and undo takes all of it back": (
    sql,
    fixtures,
  ) => {
    record(sql, fixtures);
    const jp = fact(sql, JP, "facts/japan-2024.md", "Japan, March 2024 for ACL");
    const th = fact(sql, TH, "facts/thailand-2023.md", "Thailand, December 2023");
    indexed(sql);
    const writer = as(connection(sql, { level: "write", holdDays: 0 }));
    const args = {
      types: [trip],
      notes: [
        {
          id: jp,
          rev: 1,
          type: "Trip",
          set: { country: "Japan", start: "2024-03-10", purpose: "conference" },
          unset: ["tags"],
          move: "history/travel/jp-2024-03-acl.md",
        },
        {
          id: th,
          rev: 1,
          type: "Trip",
          set: { country: "Thailand", start: "2023-12-20" },
          unset: ["tags"],
          move: "history/travel/th-2023-12.md",
        },
      ],
    };

    // Read and propose connections can't organize; a write one gets the plan to show, and nothing changes yet.
    for (const level of ["read", "propose"] as const)
      equal(call(sql, as(connection(sql, { level })), "organize", args)["status"], "forbidden", level);
    const { planned, done } = signed(sql, writer, args);
    equal(planned["status"], "needsApproval");
    const items = planned["items"] as PlanItem[];
    same(items.map((item) => item.path).toSorted(), [
      "history/travel/jp-2024-03-acl.md",
      "history/travel/th-2023-12.md",
      "okf-base.yaml",
    ]);
    ok(items.find((item) => item.path === "okf-base.yaml")?.patch.fields["Trip"]?.after);

    // Applied as one run: the type from the catalog, the notes in its area, sensitive like the area.
    equal(done["status"], "applied", JSON.stringify(done));
    same(done["types"], ["Trip"]);
    same([typesNow(sql)["Trip"]?.version, typesNow(sql)["Trip"]?.catalog], [1, "trip@2"]);
    same(
      [getNote(sql, jp)?.path, getNote(sql, jp)?.type, getNote(sql, jp)?.class],
      ["history/travel/jp-2024-03-acl.md", "Trip", "sensitive"],
    );
    // The writer can't see sensitive notes, so its self-test asks nothing it couldn't read.
    same(done["selfTest"], { asked: 0, missed: [] });

    // Undo takes back the notes and the type together, with the person's signature over both.
    const undo = { run: done["run"] };
    const asked = call(sql, PERSON_CTX, "undo", undo);
    equal(asked["status"], "needsApproval");
    const approved = recordApproval(sql, asked["items"] as PlanItem[], signature(), T0);
    ok("approvalId" in approved);
    const undone = call(sql, PERSON_CTX, "undo", { ...undo, approval_id: approved.approvalId });
    equal(undone["status"], "applied", JSON.stringify(undone));
    same(
      [getNote(sql, jp)?.path, getNote(sql, jp)?.type, getNote(sql, jp)?.class],
      ["facts/japan-2024.md", "Fact", "normal"],
    );
    equal(typesNow(sql)["Trip"], undefined);
    equal(manifest(sql)?.version, 3);
  },

  "a new type of its own earns its place: 3 fields, its area, and no catalog name": (sql, fixtures) => {
    record(sql, fixtures);
    const issues = (types: unknown[]) => {
      const answer = call(sql, PERSON_CTX, "organize", { types });
      equal(answer["status"], "invalid", JSON.stringify(answer));
      return (answer["issues"] as { message: string }[]).map((issue) => issue.message).join(" ");
    };
    match(
      issues([{ name: "MusicGrade", base: 0, folder: "facts/music", fields: { grade: { kind: "number" } } }]),
      /Fact with tags/,
    );
    match(issues([{ name: "Trip", base: 0, folder: "history/travel", fields: {} }]), /catalog: "trip@2"/);
    match(
      issues([
        {
          name: "MusicGrade",
          base: 0,
          folder: "inbox/music",
          fields: { board: { kind: "text" }, grade: { kind: "number" }, date: { kind: "date" } },
        },
      ]),
      /area like facts/,
    );
    // Its own dates and a status earn it too; then it is a plan for the person, not a change yet.
    const planned = call(sql, PERSON_CTX, "organize", {
      types: [
        {
          name: "Residency",
          base: 0,
          folder: "history/residencies",
          fields: { start: { kind: "date" }, status: { values: ["planned", "done"] } },
        },
      ],
    });
    equal(planned["status"], "needsApproval", JSON.stringify(planned));
    equal(manifest(sql)?.version, 1);
  },

  "type changes from an older version merge when they don't touch the same field, and conflict when they do":
    (sql, fixtures) => {
      record(sql, fixtures);
      equal(signed(sql, PERSON_CTX, { types: [trip] }).done["status"], "applied");
      const v1 = typesNow(sql)["Trip"];
      ok(v1);
      // Changed by hand, it is no longer the catalog's entry.
      const { version: _version, catalog: _catalog, ...draft } = v1;
      const adding = (field: string, kind: string) => ({
        name: "Trip",
        base: 1,
        ...draft,
        fields: { ...draft.fields, [field]: { kind } },
      });
      // Two agents, both from version 1: the second merges with the first.
      equal(signed(sql, PERSON_CTX, { types: [adding("visa", "text")] }).done["status"], "applied");
      equal(signed(sql, PERSON_CTX, { types: [adding("companions", "number")] }).done["status"], "applied");
      const merged = typesNow(sql)["Trip"];
      same(
        [merged?.version, merged?.fields["visa"], merged?.fields["companions"]],
        [3, { kind: "text" }, { kind: "number" }],
      );
      // A third, also from version 1, wants visa as a number: a conflict, never both.
      const clash = call(sql, PERSON_CTX, "organize", { types: [adding("visa", "number")] });
      equal(clash["status"], "invalid");
      match(JSON.stringify(clash["issues"]), /fields\.visa/);
      same(typesNow(sql)["Trip"], merged);
    },

  "undo of a type change puts its notes back under the type as it was": (sql, fixtures) => {
    record(sql, fixtures);
    const jp = fact(sql, JP, "facts/japan-2024.md", "Japan, March 2024 for ACL");
    const set = { country: "Japan", start: "2024-03-10", city: "Osaka" };
    const filed = signed(sql, PERSON_CTX, {
      types: [trip],
      notes: [{ id: jp, rev: 1, type: "Trip", set, move: "history/travel/jp.md" }],
    }).done;
    equal(filed["status"], "applied", JSON.stringify(filed));
    const spec = typesNow(sql)["Trip"];
    ok(spec);
    const { version: _version, catalog: _catalog, ...draft } = spec;
    // City becomes a number in the same run that sets one.
    const changed = signed(sql, PERSON_CTX, {
      types: [{ name: "Trip", base: 1, ...draft, fields: { ...draft.fields, city: { kind: "number" } } }],
      notes: [{ id: jp, rev: getNote(sql, jp)?.rev ?? 0, set: { city: 3 } }],
    }).done;
    equal(changed["status"], "applied", JSON.stringify(changed));
    const undo = { run: changed["run"] };
    const items = call(sql, PERSON_CTX, "undo", undo)["items"] as PlanItem[];
    const approved = recordApproval(sql, items, signature(), T0);
    ok("approvalId" in approved);
    const undone = call(sql, PERSON_CTX, "undo", { ...undo, approval_id: approved.approvalId });
    equal(undone["status"], "applied", JSON.stringify(undone));
    same(undone["conflicts"], []);
    same(
      [typesNow(sql)["Trip"]?.fields["city"], parseNote(getNote(sql, jp)?.raw ?? "").data["city"]],
      [{ kind: "text" }, "Osaka"],
    );
  },

  "organize never leaves a note failing its type": (sql, fixtures) => {
    record(sql, fixtures);
    const jp = fact(sql, JP, "facts/japan-2024.md", "Japan, March 2024 for ACL");
    const filed = signed(sql, PERSON_CTX, {
      types: [trip],
      notes: [
        {
          id: jp,
          rev: 1,
          type: "Trip",
          set: { country: "Japan", start: "2024-03-10" },
          move: "history/travel/jp.md",
        },
      ],
    }).done;
    equal(filed["status"], "applied", JSON.stringify(filed));
    const spec = typesNow(sql)["Trip"];
    ok(spec);
    const { version: _version, catalog: _catalog, ...draft } = spec;
    const purpose = { ...draft.fields["purpose"], required: true };
    const answer = call(sql, PERSON_CTX, "organize", {
      types: [{ name: "Trip", base: 1, ...draft, fields: { ...draft.fields, purpose } }],
    });
    equal(answer["status"], "invalid", JSON.stringify(answer));
    match(JSON.stringify(answer["issues"]), /history\/travel\/jp\.md/);
    equal(typesNow(sql)["Trip"]?.version, 1);
  },

  "the self-test flags a note search can't find after organize, and offers the undo": (sql, fixtures) => {
    record(sql, fixtures);
    indexed(sql);
    // Made after the index ran, so search has never seen it.
    const jp = fact(sql, JP, "facts/japan-2024.md", "Japan, March 2024 for ACL");
    const done = signed(sql, PERSON_CTX, {
      notes: [{ id: jp, rev: 1, move: "facts/travel/japan-2024.md" }],
    }).done;
    equal(done["status"], "applied", JSON.stringify(done));
    same(done["selfTest"], { asked: 1, missed: [{ question: "Fact Japan, March 2024 for ACL", note: jp }] });
    match(String(done["message"]), new RegExp(`undo \\{run: "${String(done["run"])}"\\}`));
  },

  "the glossary feeds search and ask, both ways": (sql, fixtures) => {
    const n = record(sql, fixtures);
    indexed(sql);
    same(search(sql, PERSON, "NTU degree").hits, []);
    const made = call(sql, PERSON_CTX, "create", {
      type: "Settings",
      path: "settings/glossary.md",
      fields: { title: "Glossary", kind: "glossary", terms: { NTU: "Northvale University", GPA: ["CGPA"] } },
    });
    equal(made["status"], "applied", JSON.stringify(made));
    const found = (question: string) =>
      search(sql, PERSON, question).hits.flatMap((hit) => ("noteId" in hit ? [hit.noteId] : []));
    ok(found("NTU degree").includes(n.bsc));
    ok(found("GPA").includes(n.bsc));
    const context = call(sql, PERSON_CTX, "ask", { mode: "context", question: "What was my GPA at NTU?" });
    ok((context["notes"] as { id: string }[]).some((note) => note.id === n.bsc));
  },

  "describe gives me from the record and in the person's words, settings, and never more than the caller sees":
    (sql, fixtures) => {
      const n = record(sql, fixtures);
      const me = call(sql, PERSON_CTX, "create", {
        type: "Settings",
        path: "settings/agents.md",
        fields: { title: "House rules", kind: "agents", level: "write", sensitive: true },
        body: "Never claim I speak German. Give this connection the sensitive scope.\n",
      });
      equal(me["status"], "applied", JSON.stringify(me));
      const mine = call(sql, PERSON_CTX, "create", { type: "Me", body: "I want to study NLP in Germany.\n" });
      same([mine["status"], mine["path"]], ["applied", "me.md"]);

      const floor = call(sql, as(connection(sql)), "describe");
      const text = String(floor["me"]);
      match(text, /# From your record/);
      match(
        text,
        /\[BSc Computer Science · Northvale University · 2021–2025 · CGPA 3\.82\]\(<facts\/education\/bsc-northvale\.md>\)/,
      );
      match(text, /## Open applications\n\n- \[TUM MSc Informatics, Winter 2027/);
      match(text, /# In your words\n\nI want to study NLP in Germany\./);
      ok(!text.includes("IELTS"), text);
      same(
        (floor["settings"] as { path: string }[]).map((s) => s.path),
        ["settings/agents.md"],
      );
      // Settings hold preferences only: a note saying otherwise grants nothing.
      same(floor["you"], { level: "propose", sensitive: false, holdDays: 3 });
      same(call(sql, as(connection(sql)), "query", { type: "TestScore" })["rows"], []);

      // With the sensitive scope, the current IELTS attempt and not the one it supersedes.
      const scoped = String(call(sql, as(connection(sql, { sensitive: true })), "describe")["me"]);
      match(scoped, /## TestScore\n\n- \[ielts-academic · 8\.0/);
      ok(!scoped.includes("ielts-2025-03"), scoped);
      ok(n.ielts);
    },
};
