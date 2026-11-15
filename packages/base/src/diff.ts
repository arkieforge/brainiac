import { deepEqual, splitNote, type Diff } from "@brainiac/core";

import type { NoteClass, NoteRow } from "./notes.ts";

export interface State {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly live: boolean;
  /** Absent for a note that doesn't exist yet, so a create records no class change. */
  readonly class?: NoteClass;
  /** Absent for a note that doesn't exist yet, so a create records no move. */
  readonly path?: string;
}

const NOTHING: State = { data: {}, body: "", live: false };

export const stateOf = (
  note: Pick<NoteRow, "raw" | "fm" | "deletedAt" | "class" | "path"> | undefined,
): State =>
  note
    ? {
        data: JSON.parse(note.fm),
        body: splitNote(note.raw).body,
        live: note.deletedAt === null,
        class: note.class,
        path: note.path,
      }
    : NOTHING;

export const side = <K extends "before" | "after", T>(key: K, has: boolean, value: T) =>
  (has ? { [key]: value } : {}) as Partial<Record<K, T>>;

/**
 * What changed from one state of a note to another: each top-level field, the body, whether it is live, its class,
 * and its path.
 */
export function diff(before: State, after: State): Diff {
  const fields: Record<string, { before?: unknown; after?: unknown }> = {};
  for (const key of new Set([...Object.keys(before.data), ...Object.keys(after.data)])) {
    const had = Object.hasOwn(before.data, key);
    const has = Object.hasOwn(after.data, key);
    if (had === has && deepEqual(before.data[key], after.data[key])) continue;
    fields[key] = { ...side("before", had, before.data[key]), ...side("after", has, after.data[key]) };
  }
  return {
    fields,
    ...(before.body !== after.body && { body: { before: before.body, after: after.body } }),
    ...(before.live !== after.live && { live: { before: before.live, after: after.live } }),
    ...(before.class &&
      after.class &&
      before.class !== after.class && { class: { before: before.class, after: after.class } }),
    ...(before.path !== undefined &&
      after.path !== undefined &&
      before.path !== after.path && { path: { before: before.path, after: after.path } }),
  };
}
