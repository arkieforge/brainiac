import { deepEqual, splitNote, type Diff } from "@brainiac/core";

import type { NoteRow } from "./notes.ts";

export interface State {
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly live: boolean;
}

const NOTHING: State = { data: {}, body: "", live: false };

export const stateOf = (note: Pick<NoteRow, "raw" | "fm" | "deletedAt"> | undefined): State =>
  note
    ? { data: JSON.parse(note.fm), body: splitNote(note.raw).body, live: note.deletedAt === null }
    : NOTHING;

export const side = <K extends "before" | "after", T>(key: K, has: boolean, value: T) =>
  (has ? { [key]: value } : {}) as Partial<Record<K, T>>;

/** What changed from one state of a note to another: each top-level field, the body, and whether it is live. */
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
  };
}
