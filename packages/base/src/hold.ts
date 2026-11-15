// The hold window (contract §3): a write-level connection's change to an existing value on a note of a held type
// (the manifest's `held: true`, the fact types) waits as a proposal that applies on its own after the
// connection's hold days. It's keyed on the note's type as the change found it, so changing the type or moving
// the note can't escape it, and moving any note out of a held type's folder is held too. A new note is never
// held, since it starts unverified, unless it supersedes a held-type note.
import {
  BUILT_IN_TYPES,
  deepEqual,
  parseManifest,
  pathKey,
  PathError,
  splitNote,
  type Manifest,
  type PlanItem,
} from "@brainiac/core";

import { relationTarget, type Effect } from "./approvals.ts";
import type { Mutation } from "./mutate.ts";
import type { NoteRow } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** What a held proposal runs when it's released: one mutation, or an undo of a run. */
export type Action =
  | Mutation
  /** A bulk update's mutations, applied together or not at all. */
  | { readonly op: "batch"; readonly mutations: readonly Mutation[] }
  /** `upTo`: the last `seq` when it was held, so a release undoes only what was held, not what the run did since. */
  | { readonly op: "undo"; readonly runId: string; readonly upTo: number };

export interface Proposed {
  readonly status: "proposed";
  readonly proposalId: string;
  /** When it applies on its own; null when it waits for the person (a propose-level connection). */
  readonly autoApplyAt: number | null;
}

export const DAY_MS = 24 * 60 * 60_000;

/** The record's manifest, or undefined before it has one (then only built-in types can be held). */
export function manifestOf(sql: Sql): Manifest | undefined {
  const [schema] = sql.all<{ manifest: string }>("SELECT manifest FROM schema ORDER BY version DESC LIMIT 1");
  return schema && parseManifest(schema.manifest);
}

const liveData = (note: NoteRow | undefined): Readonly<Record<string, unknown>> | undefined =>
  note && note.deletedAt === null ? JSON.parse(note.fm) : undefined;

const keyOf = (path: string) => {
  try {
    return pathKey(path.replace(/\/+$/, ""));
  } catch (error) {
    if (error instanceof PathError) return undefined;
    throw error;
  }
};

/** The held types, and the folders they live in (the held areas), compared as the record compares paths. */
function heldOf(manifest: Manifest | undefined) {
  const types = new Set<string>();
  const areas: string[] = [];
  // Built-in types count too (a Project is a fact type); a manifest type of the same name wins.
  for (const [name, spec] of Object.entries({ ...BUILT_IN_TYPES, ...manifest?.types })) {
    if (!spec.held) continue;
    types.add(name);
    const area = spec.folder === undefined ? undefined : keyOf(spec.folder);
    if (area !== undefined) areas.push(area);
  }
  return {
    type: (data: Readonly<Record<string, unknown>> | undefined) =>
      typeof data?.["type"] === "string" && types.has(data["type"]),
    area: (path: string) => {
      const key = keyOf(path);
      return key !== undefined && areas.some((area) => key.startsWith(`${area}/`));
    },
  };
}

const body = (note: NoteRow) => splitNote(note.raw).body;

const newlines = (text: string | undefined) => (text ?? "").split("\n").length - 1;

/**
 * Whether `is` only adds new blocks after `was`: a blank line where they meet, or a heading on a line of its own.
 * Text on the next line without a blank one continues the last paragraph, so it changes what that says.
 */
function appended(was: string, is: string): boolean {
  if (!is.startsWith(was)) return false;
  const added = is.slice(was.length);
  if (added === "" || was.trim() === "") return true;
  const breaks = newlines(/(?:\r?\n)*$/.exec(was)?.[0]) + newlines(/^(?:\r?\n)*/.exec(added)?.[0]);
  // An ATX heading: one to six `#` and then a space or the line's end. `#tag` continues the paragraph.
  return breaks >= 2 || (breaks === 1 && /^#{1,6}(?:[ \t]|\r?\n|$)/.test(added.replace(/^\r?\n/, "")));
}

/** Whether a write-level change with this effect waits out the hold. */
export function holds(sql: Sql, manifest: Manifest | undefined, { before, after }: Effect): boolean {
  const held = heldOf(manifest);
  const was = liveData(before);
  const is = liveData(after);
  // Pointing `supersedes` at a held-type note changes which of its values is current: a superseding create, or an
  // edit that adds or redirects the edge.
  const supersedes = is?.["supersedes"];
  const edge =
    supersedes !== undefined &&
    (!deepEqual(was?.["supersedes"], supersedes) || before?.path !== after.path) &&
    held.type(liveData(relationTarget(sql, after, supersedes)));
  if (edge) return true;
  if (!before) return false;
  // What the note held, even as a tombstone: bringing a held-type note back with other values is an edit to it.
  const prior: Readonly<Record<string, unknown>> = JSON.parse(before.fm);
  // Moved: out of a held area, or a held-type note anywhere.
  if (before.path !== after.path && (held.area(before.path) || held.type(prior))) return true;
  if (!held.type(prior)) return false;
  if (!is) return was !== undefined;
  // An existing value changed or removed, or existing text in the body rewritten. A new field, or new lines after
  // the body, is a new value, not a change to one; text run onto the last line ("a team of 5" to "50") isn't.
  return (
    !appended(body(before), body(after)) ||
    Object.keys(prior).some((key) => !Object.hasOwn(is, key) || !deepEqual(prior[key], is[key]))
  );
}

/** Records a held change, after its transaction rolled back: the plan it would apply, and how to apply it. */
export function recordHeld(
  sql: Sql,
  action: Action,
  items: readonly PlanItem[],
  ctx: { readonly actor: string; readonly runId?: string },
  autoApplyAt: number | null,
  id: string,
): Proposed {
  sql.all(
    `INSERT INTO proposals (id, noteId, patch, actor, autoApplyAt, status, kind, action, runId)
     VALUES (?, ?, ?, ?, ?, 'open', 'change', ?, ?)`,
    id,
    items.length === 1 ? (items[0]?.noteId ?? null) : null,
    JSON.stringify(items),
    ctx.actor,
    autoApplyAt,
    JSON.stringify(action),
    ctx.runId ?? null,
  );
  return { status: "proposed", proposalId: id, autoApplyAt };
}
