// The MCP tools (docs/internals/agent-interface.md): their text, their input schemas and their logic, in one
// module that both transports serve (`/mcp` through the Base DO, and `brainiac mcp serve`, which forwards to it).
// Every read goes through `project`; every change goes through the mutation path, as the calling connection.
import {
  BUILT_IN_TYPES,
  findClash,
  normalizePath,
  parseNote,
  patch,
  PathError,
  relationTo,
  resolveRelation,
  splitNote,
  ulid,
  type PatchOp,
  type PlanItem,
  type YamlValue,
} from "@brainiac/core";
import { type, type Type } from "arktype";

import type { NeedsApproval } from "./approvals.ts";
import { recordAudit } from "./audit.ts";
import { principalOf } from "./connections.ts";
import { diff, stateOf } from "./diff.ts";
import { checkFilter, matches, paginate, Where, type Row } from "./filter.ts";
import { manifestOf, type Proposed } from "./hold.ts";
import {
  mutate,
  mutateAll,
  undoRun,
  type BatchResult,
  type Context,
  type Mutation,
  type MutationResult,
  type UndoResult,
} from "./mutate.ts";
import { getNote, getNoteByPath, listNotes, type NoteRow } from "./notes.ts";
import { project, type Principal } from "./project.ts";
import { withdraw, type Decided } from "./proposals.ts";
import type { Sql } from "./sql.ts";
import { currentSeq } from "./sync.ts";

/** What a tool call answers: a JSON value for the agent, or why the call itself was wrong. */
export type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** A query without a type reads every live note; past this many it is refused and asks for a type. */
export const SCAN_LIMIT = 10_000;
/** The most notes one update may change; a wider one should be narrowed. */
const BULK_LIMIT = 100;

// Optional arguments accept null as omitted, since models often send null for what they leave out.
type Present<T> = { [K in keyof T]: Exclude<T[K], null> };
const present = <T extends object>(args: T): Present<T> =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null)) as Present<T>;

const fail = (error: string): Answer => ({ ok: false, error });
const ok = (value: unknown): Answer => ({ ok: true, value });

/** One tool call as its connection, collecting the notes its answer shows for the call's audit row. */
interface Call extends Context {
  readonly shown: Set<string>;
}

/** A tool: its description, its input schema, and its logic over the record as `ctx`'s connection. */
function tool<const T extends object>(
  description: string,
  input: Type<T>,
  run: (sql: Sql, args: Present<T>, ctx: Call) => Answer,
) {
  return {
    description,
    input,
    call(sql: Sql, args: unknown, ctx: Call): Answer {
      const parsed = input(args ?? {});
      if (parsed instanceof type.errors) return fail(parsed.summary);
      // These schemas have no morphs, so what passes is T; arktype can't show that for a generic T.
      return run(sql, present(parsed as T), ctx);
    },
  };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

const principal = (ctx: Context): Principal => principalOf(ctx.connection);

/** The live note with this id, as the caller may see it: hidden and missing read the same. */
const visible = (sql: Sql, ctx: Call, id: string) => {
  const note = getNote(sql, id);
  const seen = note && note.deletedAt === null ? project(note, principal(ctx)) : undefined;
  if (seen) ctx.shown.add(seen.id);
  return seen;
};

const fieldsOf = (note: NoteRow): Record<string, unknown> => JSON.parse(note.fm);

/** The fields a note's `verified` block names, or every field when it doesn't list them. */
function verifiedOf(data: Readonly<Record<string, unknown>>): string[] {
  const block = data["verified"];
  if (block === undefined) return [];
  const fields = typeof block === "object" && block !== null && "fields" in block ? block.fields : undefined;
  return Array.isArray(fields) && fields.every((f) => typeof f === "string")
    ? fields
    : Object.keys(data).filter((key) => key !== "verified");
}

/** Whether a JSON value from a request can go into front-matter as it is. */
function isYaml(value: unknown): value is YamlValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return typeof value !== "number" || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isYaml);
  return typeof value === "object" && Object.values(value).every(isYaml);
}

/** `sections.writing` as a patch path; numeric segments index lists (`sources.0.page`). */
const pathOf = (field: string) => field.split(".").map((key) => (/^\d+$/.test(key) ? Number(key) : key));

/** What a mutation's outcome tells the agent, with the next step for anything that didn't apply. */
function outcome(result: MutationResult | BatchResult | UndoResult | Decided): Record<string, unknown> {
  switch (result.status) {
    case "applied":
      return "noteId" in result
        ? { status: "applied", id: result.noteId, rev: result.rev, run: result.runId }
        : "notes" in result
          ? {
              status: "applied",
              run: result.runId,
              notes: result.notes.map((n) => ({ id: n.noteId, rev: n.rev })),
            }
          : { status: "applied", run: result.runId, undone: result.undone, conflicts: result.conflicts };
    case "conflict":
      return {
        status: "conflict",
        id: result.noteId,
        rev: result.rev,
        message: `The note is at rev ${result.rev} now. Get it again and send your change with that rev.`,
      };
    case "needsApproval":
      return approval(result);
    case "proposed":
      return proposed(result);
    case "forbidden":
      return { status: "forbidden", message: result.reason };
    case "invalid":
      return { status: "invalid", issues: result.issues };
    case "rejected":
    case "withdrawn":
      return { status: result.status };
  }
}

const approval = (result: NeedsApproval) => ({
  status: "needsApproval",
  planHash: result.planHash,
  items: result.items,
  message:
    "Nothing changed: this needs the person's passkey. Ask them to approve it in Brainiac, then send the same call with approval_id.",
});

const proposed = (result: Proposed) => ({
  status: "proposed",
  proposal: result.proposalId,
  autoApplyAt: iso(result.autoApplyAt),
  message:
    result.autoApplyAt === null
      ? "Waiting for the person to accept it. You can withdraw it with update {withdraw}."
      : "Held: it applies on its own at autoApplyAt unless the person rejects it first. You can withdraw it with update {withdraw}.",
});

/** Runs `fn` and rolls back everything it wrote, for a dry run. */
function rolledBack<T>(sql: Sql, fn: () => T): T {
  const rollback = new Error("dry run");
  let out: { readonly value: T } | undefined;
  try {
    sql.transaction(() => {
      out = { value: fn() };
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!out) throw new Error("a dry run returned nothing");
  return out.value;
}

/** A dry run's outcome: what would happen, without the ids of a proposal or run that was never kept. */
function wouldBe(result: MutationResult | BatchResult | UndoResult): Record<string, unknown> {
  const { proposal: _proposal, run: _run, ...rest } = outcome(result);
  return { dryRun: true, ...rest };
}

/** Each note's change, from its text before to its text after, for a dry run to show. */
function changeOf(before: NoteRow, raw: string | null) {
  if (raw === null)
    return { id: before.id, path: before.path, fields: {}, live: { before: true, after: false } };
  const d = diff(stateOf(before), { data: parseNote(raw).data, body: splitNote(raw).body, live: true });
  return { id: before.id, path: before.path, ...d };
}

// Read surfaces. Notes the caller can't see are left out before anything else looks at them.

function liveVisible(sql: Sql, ctx: Context, noteType?: string): NoteRow[] | string {
  const rows =
    noteType === undefined
      ? sql.all<NoteRow>(
          `SELECT id, path, raw, fm, rev, hash, seq, class, deletedAt, type, title, kind, status, date, deadline,
             expires FROM notes WHERE deletedAt IS NULL LIMIT ?`,
          SCAN_LIMIT + 1,
        )
      : listNotes(sql, { type: noteType });
  if (noteType === undefined && rows.length > SCAN_LIMIT)
    return `This query would read more than ${SCAN_LIMIT} notes. Add a type, like {"type": "Project"}.`;
  return rows.filter((note) => project(note, principal(ctx)) !== undefined);
}

/** A row `query` pages through; a note's carries the note, for its path and rev. */
type QueryRow = Row & { readonly note?: NoteRow };

const noteRow = (note: NoteRow): QueryRow => ({ id: note.id, data: fieldsOf(note), text: note.raw, note });

interface ProposalRow {
  readonly id: string;
  readonly noteId: string | null;
  readonly patch: string;
  readonly actor: string;
  readonly autoApplyAt: number | null;
  readonly status: string;
  readonly kind: string;
}

/** Proposals as rows, each only if the caller may see every note it would change. */
function proposalRows(sql: Sql, ctx: Context): Row[] {
  const reader = principal(ctx);
  return sql
    .all<ProposalRow>("SELECT id, noteId, patch, actor, autoApplyAt, status, kind FROM proposals")
    .flatMap((proposal) => {
      let notes: string[];
      if (proposal.kind === "change") {
        const items: PlanItem[] = JSON.parse(proposal.patch);
        const seen = items.every((item) => {
          const note = getNote(sql, item.noteId);
          const after = item.patch.fields["type"]?.after ?? note?.type ?? null;
          // Seen as it was proposed and as it is now: a note made sensitive since hides its proposals too.
          return (
            project({ class: item.class, type: typeof after === "string" ? after : null }, reader) &&
            (note === undefined || project(note, reader))
          );
        });
        if (!seen) return [];
        notes = items.map((item) => item.noteId);
      } else if (proposal.kind === "conflict" && proposal.noteId !== null) {
        if (!project(getNote(sql, proposal.noteId), reader)) return [];
        notes = [proposal.noteId];
      } else return [];
      const data = {
        type: "Proposal",
        kind: proposal.kind,
        status: proposal.status,
        notes,
        yours: proposal.actor === ctx.actor,
        autoApplyAt: iso(proposal.autoApplyAt),
      };
      return [{ id: proposal.id, data, text: JSON.stringify(data) }];
    });
}

interface QuestionRow {
  readonly id: string;
  readonly noteId: string | null;
  readonly field: string | null;
  readonly input: string;
  readonly suggested: string | null;
  readonly why: string;
  readonly priority: number;
  readonly status: string;
  readonly class: NoteRow["class"];
}

function questionRows(sql: Sql, ctx: Context): Row[] {
  return sql.all<QuestionRow>("SELECT * FROM questions").flatMap((question) => {
    const reader = principal(ctx);
    if (!project({ class: question.class, type: null }, { sensitive: reader.sensitive })) return [];
    if (question.noteId !== null && !project(getNote(sql, question.noteId), reader)) return [];
    const input: { readonly question: string } = JSON.parse(question.input);
    const data = {
      type: "Question",
      question: input.question,
      why: question.why,
      ...(question.noteId !== null && { note: question.noteId }),
      ...(question.field !== null && { field: question.field }),
      ...(question.suggested !== null && { suggested: JSON.parse(question.suggested) }),
      priority: question.priority,
      status: question.status,
    };
    return [{ id: question.id, data, text: JSON.stringify(data) }];
  });
}

const pick = (data: Readonly<Record<string, unknown>>, fields: readonly string[]) =>
  Object.fromEntries(
    fields.flatMap((field) => {
      const value = field
        .split(".")
        .reduce<unknown>(
          (at, key) =>
            typeof at === "object" && at !== null && Object.hasOwn(at, key)
              ? (at as Record<string, unknown>)[key]
              : undefined,
          data,
        );
      return value === undefined ? [] : [[field, value]];
    }),
  );

const FilterArgs = {
  "type?": "string | null",
  "where?": Where.or("null"),
  "text?": "string | null",
} as const;

const query = tool(
  `Exact lookup over the record's notes by type and fields. Use it before anything else to find notes.
where: {"<field>": {<operator>: <value>}}, dotted paths for nested fields ("sections.writing"). Operators: eq, in, gte, lte, exists, has, text; several in one condition must all hold.
- A missing or null field matches only {"exists": false}.
- eq on a list means the list contains it; has: a list contains it, or a mapping has that key.
- Dates compare as dates in UTC; text compares ignoring case. text finds words in a field; the top-level text finds words anywhere in the note.
sort: fields, "-" for newest or largest first (default ["-date"]). fields: which fields each row returns (default type and title).
Pages hold up to limit rows (default 20, at most 100); pass next as cursor for the next page.
type "Proposal" lists proposals (yours: true for this connection's), type "Question" the questions waiting for the person.`,
  type({
    "+": "reject",
    ...FilterArgs,
    "sort?": "string[] | null",
    "fields?": "string[] | null",
    "limit?": "1 <= number.integer <= 100 | null",
    "cursor?": "string | null",
  }),
  (sql, args, ctx) => {
    const invalid = checkFilter(args);
    if (invalid) return fail(invalid);
    const virtual = args.type === "Proposal" || args.type === "Question";
    const notes = virtual ? [] : liveVisible(sql, ctx, args.type);
    if (typeof notes === "string") return fail(notes);
    const rows: QueryRow[] = virtual
      ? (args.type === "Proposal" ? proposalRows : questionRows)(sql, ctx)
      : notes.map(noteRow);
    const page = paginate(rows, args);
    if ("error" in page) return fail(page.error);
    // A proposal or question row names the notes it is about, which the caller may see (checked above).
    for (const { id, data, note } of page.rows) {
      if (note) ctx.shown.add(id);
      else
        for (const ref of [data["note"], data["notes"]].flat())
          if (typeof ref === "string") ctx.shown.add(ref);
    }
    return ok({
      rows: page.rows.map(({ id, data, note }) => ({
        id,
        ...(note && { path: note.path, rev: note.rev }),
        fields: pick(data, args.fields ?? (virtual ? Object.keys(data) : ["type", "title"])),
      })),
      next: page.next,
    });
  },
);

const describe = tool(
  `Call this first in a session. Returns who you are to this record (your level and whether you may see sensitive notes), me.md, the schema (every type with its folder, fields, allowed values and which types are held facts), note counts by type and folder, and how many questions and proposals are open.`,
  type({ "+": "reject" }),
  (sql, _args, ctx) => {
    const notes = liveVisible(sql, ctx);
    if (typeof notes === "string") return fail(notes);
    const count = (key: (note: NoteRow) => string) =>
      notes.reduce<Record<string, number>>((counts, note) => {
        counts[key(note)] = (counts[key(note)] ?? 0) + 1;
        return counts;
      }, {});
    const me = notes.find((note) => note.path === "me.md");
    if (me) ctx.shown.add(me.id);
    const proposals = proposalRows(sql, ctx).filter((row) => row.data["status"] === "open");
    const { connection } = ctx;
    return ok({
      you: connection
        ? { level: connection.level, sensitive: connection.sensitive, holdDays: connection.holdDays }
        : { level: "person" },
      me: me ? splitNote(me.raw).body : null,
      types: typesOf(sql),
      counts: {
        notes: notes.length,
        byType: count((note) => note.type ?? "(none)"),
        byFolder: count((note) => (note.path.includes("/") ? (note.path.split("/")[0] ?? "") : "(root)")),
      },
      openQuestions: questionRows(sql, ctx).filter((row) => row.data["status"] === "open").length,
      openProposals: {
        yours: proposals.filter((row) => row.data["yours"]).length,
        conflicts: proposals.filter((row) => row.data["kind"] === "conflict").length,
      },
    });
  },
);

const get = tool(
  `One or more notes by id or path, with their fields, body and rev (send rev back with update). verified lists the fields the person checked; treat every other value as unverified and say so when you quote it. history: the last 20 revisions. Notes you can't see are listed in missing, like notes that don't exist.`,
  type({
    "+": "reject",
    "ids?": "string[] | null",
    "paths?": "string[] | null",
    "body?": "boolean | null",
    "history?": "boolean | null",
  }),
  (sql, args, ctx) => {
    const refs = [...(args.ids ?? []).map((id) => ({ id })), ...(args.paths ?? []).map((path) => ({ path }))];
    if (refs.length === 0) return fail("Name the notes to get with ids or paths.");
    if (refs.length > 100) return fail("Get at most 100 notes at a time.");
    const live = sql
      .all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL")
      .map((r) => r.path);
    const found: Record<string, unknown>[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      let note: NoteRow | undefined;
      if ("id" in ref) note = visible(sql, ctx, ref.id);
      else {
        let path: string | undefined;
        try {
          path = findClash(live, normalizePath(ref.path));
        } catch (error) {
          if (!(error instanceof PathError)) throw error;
        }
        note = path === undefined ? undefined : project(getNoteByPath(sql, path), principal(ctx));
      }
      if (!note) {
        missing.push("id" in ref ? ref.id : ref.path);
        continue;
      }
      ctx.shown.add(note.id);
      const fields = fieldsOf(note);
      found.push({
        id: note.id,
        path: note.path,
        rev: note.rev,
        class: note.class,
        fields,
        verified: verifiedOf(fields),
        ...(args.body !== false && { body: splitNote(note.raw).body }),
        ...(args.history && {
          history: sql
            .all<{ rev: number; actor: string; at: number }>(
              "SELECT rev, actor, at FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 20",
              note.id,
            )
            .map((r) => ({
              rev: r.rev,
              at: iso(r.at),
              by:
                r.actor === ctx.actor
                  ? "you"
                  : r.actor.startsWith("connection:")
                    ? "another connection"
                    : "the person",
            })),
        }),
      });
    }
    return ok({ notes: found, missing });
  },
);

const readOnly = (ctx: Context) => ctx.connection?.level === "read";
const READ_ONLY = { status: "forbidden", message: "This connection can only read." };

/** Every type the record knows: the built-in ones and its manifest's. */
const typesOf = (sql: Sql) => ({ ...BUILT_IN_TYPES, ...manifestOf(sql)?.types });

/** A relation from the note at `from` to the visible live note `id`, or why there can't be one. */
function relation(sql: Sql, ctx: Call, from: string, id: string): string | { error: string } {
  const target = visible(sql, ctx, id);
  return target ? relationTo(from, target.path) : { error: `No note with id ${id}.` };
}

/** The ops that point `field` at each note in `ids`: a list gains them, a single relation is set. */
function linkOps(
  sql: Sql,
  ctx: Call,
  note: { path: string; type: string | null; data: Readonly<Record<string, unknown>> },
  links: Readonly<Record<string, string | readonly string[]>>,
): PatchOp[] | { error: string } {
  const fields = note.type === null ? undefined : typesOf(sql)[note.type]?.fields;
  const ops: PatchOp[] = [];
  for (const [field, to] of Object.entries(links)) {
    const current = note.data[field];
    const many = Array.isArray(to) || Array.isArray(current) || fields?.[field]?.kind === "list";
    for (const id of Array.isArray(to) ? to : [to]) {
      const rel = relation(sql, ctx, note.path, id);
      if (typeof rel !== "string") return rel;
      if (!many) ops.push({ op: "set", path: [field], value: rel });
      else if (!(Array.isArray(current) && current.some((item) => sameNote(sql, note.path, item, id))))
        ops.push({ op: "append", path: [field], value: rel });
    }
  }
  return ops;
}

/** Whether a relation written in the note at `from` names the note `id`. */
function sameNote(sql: Sql, from: string, written: unknown, id: string): boolean {
  if (written === id) return true;
  if (typeof written !== "string") return false;
  try {
    const target = getNoteByPath(sql, resolveRelation(from, written));
    return target?.id === id;
  } catch (error) {
    if (error instanceof PathError) return false;
    throw error;
  }
}

const Links = type({ "[string]": "string | string[]" });

const add = tool(
  `Capture something into the inbox for filing later: text the person told you, or a URL. attach_to names the note it belongs with. Allowed at propose level without becoming a proposal, since it only adds an inbox item. Set sensitive for grades, scores, IDs, health or money.`,
  type({
    "+": "reject",
    "text?": "string | null",
    "url?": "string | null",
    "attach_to?": "string | null",
    "sensitive?": "boolean | null",
  }),
  (sql, args, ctx) => {
    if (readOnly(ctx)) return ok(READ_ONLY);
    if (args.text === undefined && args.url === undefined) return fail("Give text, a url, or both.");
    if (args.url !== undefined && !/^https?:\/\/\S+$/i.test(args.url))
      return fail("url must start with https://.");
    const id = ulid(ctx.now);
    const path = `inbox/${id.toLowerCase()}.md`;
    const ops: PatchOp[] = [
      { op: "set", path: ["id"], value: id },
      { op: "set", path: ["type"], value: "InboxItem" },
    ];
    if (args.url !== undefined) ops.push({ op: "set", path: ["url"], value: args.url });
    if (args.attach_to !== undefined) {
      const rel = relation(sql, ctx, path, args.attach_to);
      if (typeof rel !== "string") return fail(rel.error);
      ops.push({ op: "set", path: ["attached_to"], value: rel });
    }
    const raw = patch("", ops) + (args.text ?? "");
    // Not as the connection: adding to the inbox is allowed at propose level, so it never waits as a proposal.
    // The actor still says who added it, and the approval list still applies.
    const result = mutate(
      sql,
      { op: "create", path, raw, class: args.sensitive ? "sensitive" : "normal" },
      { actor: ctx.actor, now: ctx.now, reader: principal(ctx) },
    );
    return ok({ ...outcome(result), ...(result.status === "applied" && { path }) });
  },
);

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");

const fold = (text: string) => text.normalize("NFKC").toLowerCase().trim();

/**
 * The note an unused approval signed into being, if it signed exactly one of this type that the caller may see:
 * a create sent again with the approval makes that note, so its plan matches what the person signed. Taken from
 * the approval, never from the caller, and only when every answer it leads to is about notes the caller may see;
 * otherwise the call gets a new id, as if it cited no approval.
 */
function approvedCreate(sql: Sql, ctx: Context, approvalId: string, noteType: string): string | undefined {
  const [signed] = sql.all<{ items: string }>(
    "SELECT items FROM approvals WHERE id = ? AND usedAt IS NULL",
    approvalId,
  );
  const items: PlanItem[] = signed ? JSON.parse(signed.items) : [];
  const created = items.filter((item) => item.baseRev === 0 && item.patch.live?.after === true);
  const [item] = created;
  if (created.length !== 1 || !item || item.patch.fields["type"]?.after !== noteType) return undefined;
  if (!project({ class: item.class, type: noteType }, principal(ctx))) return undefined;
  // A note made at that id since and hidden from the caller must answer as if there were none.
  const existing = getNote(sql, item.noteId);
  return existing && !project(existing, principal(ctx)) ? undefined : item.noteId;
}

const create = tool(
  `Create a new note: a new event is a new note (a new test attempt, a new role), while a change to something already recorded is an update. fields are the front-matter (top-level keys; see describe for each type's fields). link sets relation fields by note id, like {"supersedes": "<id>"}. Returns duplicate, creating nothing, when a note of the same type and title exists; update that one, or pass duplicate_ok if this really is another. Run with dry_run first to see the note. After needsApproval, send the same call again with approval_id. sensitive: grades, scores, IDs, health or money.`,
  type({
    "+": "reject",
    type: "string",
    "fields?": "Record<string, unknown> | null",
    "link?": Links.or("null"),
    "body?": "string | null",
    "path?": "string | null",
    "sensitive?": "boolean | null",
    "duplicate_ok?": "boolean | null",
    "dry_run?": "boolean | null",
    "approval_id?": "string | null",
  }),
  (sql, args, ctx) => {
    if (readOnly(ctx)) return ok(READ_ONLY);
    const fields = args.fields ?? {};
    const fieldOps: PatchOp[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || key === "type") return fail(`${key} is set for you; leave it out of fields.`);
      if (!isYaml(value)) return fail(`fields.${key} isn't a value front-matter can hold.`);
      fieldOps.push({ op: "set", path: [key], value });
    }
    const id =
      (args.approval_id !== undefined && approvedCreate(sql, ctx, args.approval_id, args.type)) ||
      ulid(ctx.now);
    const title = typeof fields["title"] === "string" ? fields["title"] : undefined;
    const spec = typesOf(sql)[args.type];
    const live = sql
      .all<{ path: string }>("SELECT path FROM notes WHERE deletedAt IS NULL")
      .map((r) => r.path);
    let path: string;
    try {
      if (args.path !== undefined) path = normalizePath(args.path);
      else {
        const base = `${spec?.folder ?? slug(args.type)}/${slug(title ?? "") || id.toLowerCase()}`;
        path =
          findClash(live, `${base}.md`) === undefined
            ? `${base}.md`
            : `${base}-${id.slice(-6).toLowerCase()}.md`;
      }
    } catch (error) {
      if (error instanceof PathError) return fail(error.message);
      throw error;
    }
    const linked = linkOps(sql, ctx, { path, type: args.type, data: {} }, args.link ?? {});
    if ("error" in linked) return fail(linked.error);
    if (title !== undefined && !args.duplicate_ok) {
      const others = new Set(Object.values(args.link ?? {}).flat());
      const twin = listNotes(sql, { type: args.type }).find(
        (note) =>
          !others.has(note.id) &&
          note.title !== null &&
          fold(note.title) === fold(title) &&
          project(note, principal(ctx)),
      );
      if (twin) {
        ctx.shown.add(twin.id);
        return ok({
          status: "duplicate",
          duplicate: { id: twin.id, path: twin.path, title: twin.title, rev: twin.rev },
          message:
            "A note of this type with this title exists. Update it instead, or send duplicate_ok: true if this is a different one.",
        });
      }
    }
    const raw =
      patch("", [
        { op: "set", path: ["id"], value: id },
        { op: "set", path: ["type"], value: args.type },
        ...fieldOps,
        ...linked,
      ]) + (args.body ?? "");
    const mutation: Mutation = { op: "create", path, raw, class: args.sensitive ? "sensitive" : "normal" };
    const run = () =>
      mutate(sql, mutation, {
        ...ctx,
        ...(args.approval_id !== undefined && { approvalId: args.approval_id }),
      });
    if (args.dry_run)
      return ok({
        ...wouldBe(rolledBack(sql, run)),
        note: { id, path, fields: parseNote(raw).data, body: args.body ?? "" },
      });
    // Every answer names the note, so a retry after an approval can make exactly it.
    return ok({ ...outcome(run()), id, path });
  },
);

const Section = type({
  "+": "reject",
  heading: "string",
  content: "string",
  "level?": "1 <= number.integer <= 6",
});

const update = tool(
  `Change one note (id and its rev from get) or every note a filter matches (type, where, text, as in query). In one call: set and append take {"<field>": value} with dotted paths; unset takes field names; section replaces the body under a heading (added at the end if missing); link and unlink take {"<field>": "<note id>" or [ids]}. Or delete, or restore a deleted note by id. withdraw takes the id of one of your own proposals.
Changes to many notes: run with dry_run first, then again with expect set to the number of notes it matched; without it nothing changes. A change to more than 20 notes, or more than 5 deletes, needs the person's passkey. Changes to held facts (scores, grades, roles...) may wait as proposals. Only the person decides proposals and conflicts.`,
  type({
    "+": "reject",
    "id?": "string | null",
    "rev?": "number.integer >= 0 | null",
    ...FilterArgs,
    "expect?": "number.integer >= 0 | null",
    "set?": "Record<string, unknown> | null",
    "unset?": "string[] | null",
    "append?": "Record<string, unknown> | null",
    "section?": Section.array().or("null"),
    "link?": Links.or("null"),
    "unlink?": Links.or("null"),
    "delete?": "boolean | null",
    "restore?": "boolean | null",
    "withdraw?": "string | null",
    "dry_run?": "boolean | null",
    "approval_id?": "string | null",
  }),
  (sql, args, ctx) => {
    const many = args.type !== undefined || args.where !== undefined || args.text !== undefined;
    const editing = ["set", "unset", "append", "section", "link", "unlink"].some((key) =>
      Object.hasOwn(args, key),
    );
    if (args.withdraw !== undefined) {
      if (many || editing || args.id !== undefined || args.delete || args.restore)
        return fail("withdraw goes alone: send it in its own call.");
      return ok(outcome(withdraw(sql, args.withdraw, ctx)));
    }
    if (readOnly(ctx)) return ok(READ_ONLY);
    if (many === (args.id !== undefined))
      return fail("Name one note with id and rev, or many with type, where or text.");
    if ([editing, args.delete, args.restore].filter(Boolean).length !== 1)
      return fail(
        "Send one kind of change: edits (set, unset, append, section, link, unlink), delete, or restore.",
      );
    // The edits that are the same on every note; links resolve per note, since relations are relative to it.
    const edits: PatchOp[] = [];
    for (const [op, values] of [
      ["set", args.set],
      ["append", args.append],
    ] as const)
      for (const [field, value] of Object.entries(values ?? {})) {
        if (!isYaml(value)) return fail(`${op}.${field} isn't a value front-matter can hold.`);
        edits.push({ op, path: pathOf(field), value });
      }
    edits.push(
      ...(args.unset ?? []).map((field): PatchOp => ({ op: "unset", path: pathOf(field) })),
      ...(args.section ?? []).map((s): PatchOp => ({ op: "section", ...s })),
    );

    const mutationOf = (
      note: NoteRow,
      baseRev: number,
    ): { mutation: Mutation; raw: string | null } | { error: string } => {
      if (args.delete) return { mutation: { op: "delete", noteId: note.id, baseRev }, raw: null };
      if (args.restore)
        return { mutation: { op: "put", noteId: note.id, baseRev, raw: note.raw }, raw: note.raw };
      const data = fieldsOf(note);
      const linked = linkOps(sql, ctx, { path: note.path, type: note.type, data }, args.link ?? {});
      if ("error" in linked) return linked;
      const unlinked = Object.entries(args.unlink ?? {}).flatMap(([field, to]): PatchOp[] => {
        const ids = Array.isArray(to) ? to : [to];
        const current = data[field];
        if (!Array.isArray(current))
          return ids.some((id) => sameNote(sql, note.path, current, id))
            ? [{ op: "unset", path: [field] }]
            : [];
        // From the end, so each index still points where it did.
        return current
          .flatMap((item, i) => (ids.some((id) => sameNote(sql, note.path, item, id)) ? [i] : []))
          .toReversed()
          .map((i) => ({ op: "unset", path: [field, i] }));
      });
      const ops = [...edits, ...linked, ...unlinked];
      let raw: string;
      try {
        raw = patch(note.raw, ops);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      return { mutation: { op: "patch", noteId: note.id, baseRev, ops }, raw };
    };

    const withApproval = { ...ctx, ...(args.approval_id !== undefined && { approvalId: args.approval_id }) };
    if (!many) {
      const note = getNote(sql, args.id ?? "");
      const seen =
        note &&
        (args.restore ? note.deletedAt !== null : note.deletedAt === null) &&
        project(note, principal(ctx));
      if (!seen)
        return ok({
          status: "invalid",
          issues: [{ field: "id", message: `No ${args.restore ? "deleted " : ""}note with id ${args.id}.` }],
        });
      ctx.shown.add(note.id);
      if (args.rev === undefined)
        return fail("rev is required: get the note and send its rev, so you change what you read.");
      const built = mutationOf(note, args.rev);
      if ("error" in built) return fail(built.error);
      const run = () => mutate(sql, built.mutation, withApproval);
      if (args.dry_run) return ok({ ...wouldBe(rolledBack(sql, run)), changes: [changeOf(note, built.raw)] });
      return ok(outcome(run()));
    }

    if (args.restore) return fail("restore takes one deleted note's id.");
    if (args.rev !== undefined)
      return fail("rev goes with id. A change to many notes uses each note's current rev.");
    const invalid = checkFilter(args);
    if (invalid) return fail(invalid);
    if (args.type === "Proposal" || args.type === "Question")
      return fail(`update changes notes, not ${args.type}s.`);
    const rows = liveVisible(sql, ctx, args.type);
    if (typeof rows === "string") return fail(rows);
    const matched = rows.map(noteRow).filter((row) => matches(row, args));
    for (const row of matched) ctx.shown.add(row.id);
    if (matched.length > BULK_LIMIT)
      return fail(
        `This matches ${matched.length} notes; one update changes at most ${BULK_LIMIT}. Narrow the filter.`,
      );
    const built = matched.flatMap(({ note }) => (note ? [{ note, built: mutationOf(note, note.rev) }] : []));
    const broken = built.find((b) => "error" in b.built);
    if (broken && "error" in broken.built) return fail(`${broken.note.path}: ${broken.built.error}`);
    const mutations = built.flatMap((b) => ("mutation" in b.built ? [b.built.mutation] : []));
    const changes = built
      .flatMap((b) => ("mutation" in b.built ? [changeOf(b.note, b.built.raw)] : []))
      .filter((c) => Object.keys(c.fields).length > 0 || c.body || c.live);
    const run = () => mutateAll(sql, mutations, withApproval);
    if (args.dry_run) return ok({ ...wouldBe(rolledBack(sql, run)), matched: matched.length, changes });
    if (args.expect !== matched.length)
      return ok({
        status: "unconfirmed",
        matched: matched.length,
        message: `Nothing changed. This matches ${matched.length} notes now: check them with dry_run, then send expect: ${matched.length}.`,
      });
    if (mutations.length === 0) return ok({ status: "applied", notes: [] });
    return ok(outcome(run()));
  },
);

const undo = tool(
  `Undo a run: every change one of your calls made (each change's answer names its run). Values go back unless someone changed them since; those come back as conflicts for the person to pick. dry_run shows what it would do.`,
  type({ "+": "reject", run: "string", "dry_run?": "boolean | null", "approval_id?": "string | null" }),
  (sql, args, ctx) => {
    if (readOnly(ctx)) return ok(READ_ONLY);
    const known = sql.all("SELECT 1 FROM revisions WHERE runId = ? LIMIT 1", args.run).length > 0;
    if (!known)
      return ok({ status: "invalid", issues: [{ field: "run", message: `No run ${args.run} to undo.` }] });
    // Its answer can show any note the run touched (a conflict's values, a dry run's), deleted ones too.
    for (const { noteId } of sql.all<{ noteId: string }>(
      "SELECT DISTINCT noteId FROM revisions WHERE runId = ?",
      args.run,
    ))
      if (project(getNote(sql, noteId), principal(ctx))) ctx.shown.add(noteId);
    const run = () =>
      undoRun(sql, args.run, {
        ...ctx,
        ...(args.approval_id !== undefined && { approvalId: args.approval_id }),
      });
    return ok(args.dry_run ? wouldBe(rolledBack(sql, run)) : outcome(run()));
  },
);

const requestInfo = tool(
  `Ask the person something instead of guessing: a missing date, which of two values is right, whether a document is the final one. It waits in their review list; their answer lands in the record, not in this chat. note and field say what it's about; suggested is your best guess, if you have one.`,
  type({
    "+": "reject",
    question: "string",
    "why?": "string | null",
    "note?": "string | null",
    "field?": "string | null",
    "suggested?": "unknown",
  }),
  (sql, args, ctx) => {
    if (readOnly(ctx)) return ok(READ_ONLY);
    if (args.question.trim() === "") return fail("question is empty.");
    const note = args.note === undefined ? undefined : visible(sql, ctx, args.note);
    if (args.note !== undefined && !note) return fail(`No note with id ${args.note}.`);
    if (args.suggested !== undefined && !isYaml(args.suggested))
      return fail("suggested isn't a value front-matter can hold.");
    const id = ulid(ctx.now);
    sql.all(
      `INSERT INTO questions (id, noteId, field, input, suggested, why, priority, status, class)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'open', ?)`,
      id,
      note?.id ?? null,
      args.field ?? null,
      JSON.stringify({ question: args.question }),
      args.suggested === undefined ? null : JSON.stringify(args.suggested),
      args.why ?? "",
      note?.class ?? "normal",
    );
    return ok({ status: "queued", question: id });
  },
);

/** Every tool, by the name agents call it. */
export const TOOLS = { describe, query, get, add, create, update, undo, request_info: requestInfo };

export type ToolName = keyof typeof TOOLS;

/** The approval a call cites, if this record has one by that id: an id it never issued isn't one. */
function citedApproval(sql: Sql, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || !("approval_id" in args)) return undefined;
  const id = args.approval_id;
  if (typeof id !== "string") return undefined;
  return sql.all("SELECT 1 FROM approvals WHERE id = ?", id).length > 0 ? id : undefined;
}

/**
 * Runs one tool call as `ctx` (the record loads the connection from its own table), and writes its audit row in
 * the same transaction: the notes the answer showed and every note the call changed, so a change and its row
 * land together or not at all.
 */
export function callTool(sql: Sql, name: string, args: unknown, ctx: Context): Answer {
  return sql.transaction(() => {
    const before = currentSeq(sql);
    const call: Call = { ...ctx, shown: new Set() };
    const answer = Object.hasOwn(TOOLS, name)
      ? TOOLS[name as ToolName].call(sql, args, call)
      : fail(`No tool named ${name}.`);
    for (const { noteId } of sql.all<{ noteId: string }>(
      "SELECT DISTINCT noteId FROM changes WHERE seq > ?",
      before,
    ))
      call.shown.add(noteId);
    const approvalId = citedApproval(sql, args);
    recordAudit(sql, {
      actor: ctx.actor,
      tool: name,
      noteIds: [...call.shown],
      ...(approvalId !== undefined && { approvalId }),
      at: ctx.now,
    });
    return answer;
  });
}
