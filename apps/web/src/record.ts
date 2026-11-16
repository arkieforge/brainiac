// This tab's view of the person's record: one sync client over one WebSocket (`/sync`, the session cookie), kept
// in this tab's IndexedDB slot so a returning visit shows the record before the socket is up. Every edit goes
// through the client's mutate path; nothing here names a record, the session does. The store is keyed by the
// signed-in account, so two people sharing a browser never share a copy.
import type { Manifest, ServerMessage } from "@brainiac/core";
import { SyncClient } from "@brainiac/sync";
import { openTabStore } from "@brainiac/sync/browser";
import { useSyncExternalStore } from "react";

import type { Saved, SaveOnline } from "./fields.ts";

export type Status = "loading" | "connecting" | "live" | "offline" | "signed-out";

export interface NoteView {
  readonly id: string;
  readonly path: string;
  readonly raw: string;
  readonly class: "normal" | "sensitive";
}

/** A file as the person sees it (the record's `viewFile` for the person). */
export interface FileItem {
  readonly sha256: string;
  readonly class: "unclassified" | "vault" | "normal" | "sensitive";
  readonly kind: string | null;
  readonly mime: string;
  readonly bytes: number;
  readonly checks: "clean" | "found" | "unreadable";
  readonly findings: readonly string[];
  readonly confirmed: boolean;
  /** Where it sits in the record, which its sidecar note's `file:` resolves to; null for an upload from before. */
  readonly path: string | null;
  /** The person's own name for it. */
  readonly name: string | null;
  /** The person lets their agents see this photo itself. */
  readonly shared: boolean;
}

const LAST_USER = "brainiac:user";
/** IndexedDB names start with this, so signing out can clear them all (apps/worker/src/auth/pages.ts). */
const STORE_PREFIX = "brainiac:";
/**
 * Where the account page says the person signed out (apps/worker/src/auth/pages.ts): every open tab lets go of
 * its copy, so the page can delete it.
 */
const SIGN_OUT_CHANNEL = "brainiac:session";

const listeners = new Set<() => void>();
let version = 0;
let status: Status = "loading";
let client: SyncClient | undefined;
let manifest: Manifest | null = null;
let files: readonly FileItem[] = [];
/** The record has answered with its manifest this visit: until then, checks that need the schema can't run. */
let schemaLoaded = false;
let release: (() => Promise<void>) | undefined;
let socket: WebSocket | undefined;
let retry = 0;
let started = false;
/** Signed out in some tab: this one holds no copy and never reconnects. */
let stopped = false;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

const setStatus = (next: Status) => {
  if (status === next) return;
  status = next;
  changed();
};

const remembered = () => {
  try {
    return localStorage.getItem(LAST_USER) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Opens the signed-in account's copy. Sign-out can land during any await here, so each one is followed by a check:
 * a copy opened after it is let go again at once, never kept or connected.
 */
async function openStore(user: string) {
  await release?.();
  release = undefined;
  socket?.close();
  if (stopped) return;
  const slot = await openTabStore(`${STORE_PREFIX}${user}`);
  if (stopped) return slot.release();
  const opened = await SyncClient.open({
    store: slot.store,
    send: (message) => socket?.send(JSON.stringify(message)),
    newClientId: () => crypto.randomUUID(),
    // The site keeps no SQL of its own, so it speaks no SQL schema version.
    schemaVersion: 0,
    appVersion: "web",
  });
  if (stopped) return slot.release();
  release = slot.release;
  client = opened;
  client.subscribe(changed);
  changed();
}

function connect() {
  if (
    stopped ||
    !client ||
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  )
    return;
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/sync`);
  socket = ws;
  setStatus("connecting");
  ws.addEventListener("open", () => {
    retry = 0;
    client?.connect();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message: ServerMessage = JSON.parse(event.data);
    client?.receive(message);
    // Live once the client took the record's answer to its hello (what changed, or all of it): before that, this
    // tab holds only its stored copy, without the sensitive notes it never keeps. An answer it set aside (one an
    // earlier hello was overtaken by) leaves its cursor where it was.
    const cursor = client?.state.cursor;
    if (
      (message.type === "snapshot" && cursor === message.seq) ||
      (message.type === "changes" && cursor === message.to)
    )
      setStatus("live");
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = undefined;
    client?.disconnect();
    setStatus("offline");
    // Backs off to 30 s; coming back online or to the tab tries at once.
    if (!stopped) setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  });
}

/** What a sensitive note's online save says when the tab is offline. */
export const OFFLINE_SENSITIVE = "Sensitive notes save only while you're online on this device.";

/** The latest text and revision the record accepted from this tab's online saves, per note. */
const accepted = new Map<string, { readonly rev: number; readonly raw: string }>();
/** Each note's online saves, in order: the next builds on what the last one wrote. */
const saving = new Map<string, Promise<unknown>>();

/** The latest text of a note saved online: what the save wrote, until the sync push brings it. */
const latest = (noteId: string) => {
  const remote = client?.state.remote.get(noteId);
  const mine = accepted.get(noteId);
  return mine && (!remote || mine.rev > remote.rev) ? mine : remote;
};

/** Saves a sensitive note's edit straight to the record, as the person; never through the client's queue. */
export const saveOnline: SaveOnline = (noteId, edit, from) => post(noteId, edit, from);

/** What a review edit came to; `ended` when the record says the review session no longer covers it. */
export type Reviewed = Saved | { readonly error: string; readonly ended: true };

/**
 * A review mode edit, straight to the record inside the review session the person signed (`review`), whatever the
 * note's class: the session is an online thing, and its edits never wait in this device's queue. Made on `from`,
 * the text the person saw, so a note changed meanwhile is a conflict, never an edit to values nobody looked at.
 */
export const saveReviewed = (
  noteId: string,
  edit: (raw: string) => string,
  review: string,
  from: { readonly rev: number; readonly raw: string },
): Promise<Reviewed> => post(noteId, edit, from, review);

/**
 * The text and revision a review card shows: the latest the record accepted. `undefined` while this tab has an
 * edit to the note still on its way, since a review must judge what the record holds.
 */
export function reviewBase(noteId: string): { readonly rev: number; readonly raw: string } | undefined {
  const base = latest(noteId);
  const pending = client?.state.pending.some((p) => p.noteId === noteId) ?? false;
  return base && !pending && !client?.state.blocked.get(noteId)?.length ? base : undefined;
}

function post(
  noteId: string,
  edit: (raw: string) => string,
  from?: { readonly rev: number; readonly raw: string },
  review?: string,
  approvalId?: string,
): Promise<Reviewed> {
  const run = async (): Promise<Reviewed> => {
    if (status !== "live")
      return { error: review ? "You're offline: review needs the record." : OFFLINE_SENSITIVE };
    const base = from ?? latest(noteId);
    if (!base) return { error: "This note is gone." };
    const raw = edit(base.raw);
    if (raw === base.raw) return undefined;
    const res = await api(`/api/notes/${noteId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        raw,
        baseRev: base.rev,
        ...(review !== undefined && { review }),
        ...(approvalId !== undefined && { approvalId }),
      }),
    }).catch(() => undefined);
    if (!res) return { error: "You're offline, so this edit wasn't saved." };
    const body = await res.json().catch(() => ({}));
    if (review !== undefined && body.needsApproval) return { error: body.error, ended: true };
    // The plan exactly as the record sent it: it is what the person sees, signs and the record checks.
    if (body.needsApproval && typeof body.planHash === "string" && Array.isArray(body.items))
      return {
        error: body.error,
        approval: {
          planHash: body.planHash,
          items: body.items,
          resend: (id: string) => post(noteId, () => raw, base, undefined, id),
        },
      };
    if (!res.ok) return { error: body.error ?? "This edit wasn't saved." };
    accepted.set(noteId, { rev: body.rev, raw });
    return { rev: body.rev, raw };
  };
  const next = (saving.get(noteId) ?? Promise.resolve()).then(run).finally(changed);
  saving.set(noteId, next);
  return next;
}

/** Loads the manifest and the file list; both come from the record over HTTP, not the sync socket. */
export async function refresh() {
  const [schema, list] = await Promise.all([api("/api/schema"), api("/api/files")]);
  const next = {
    manifest: schema.ok ? (await schema.json()).manifest : manifest,
    schemaLoaded: schema.ok || schemaLoaded,
    files: list.ok ? (await list.json()).files : files,
  };
  if (stopped) return;
  ({ manifest, files, schemaLoaded } = next);
  changed();
}

/** Same-origin JSON calls to the Worker's site routes (apps/worker/src/site.ts). */
export const api = (path: string, init: RequestInit = {}) =>
  fetch(path, { ...init, credentials: "same-origin" });

/** Lets go of this tab's copy: the socket, the client and its IndexedDB connection and slot. */
async function stop() {
  stopped = true;
  const closing = socket;
  socket = undefined;
  closing?.close();
  client = undefined;
  accepted.clear();
  files = [];
  manifest = null;
  schemaLoaded = false;
  await release?.();
  release = undefined;
  status = "signed-out";
  changed();
}

/** Starts this tab's client once: the stored copy at once, then the session, then the socket. */
export async function start() {
  if (started) return;
  started = true;
  try {
    const channel = new BroadcastChannel(SIGN_OUT_CHANNEL);
    channel.addEventListener("message", (event) => {
      if (event.data === "signed-out") void stop();
    });
  } catch {
    // No BroadcastChannel: sign-out still deletes the copy once this tab closes.
  }
  const last = remembered();
  if (last) await openStore(last);
  let user: string | undefined;
  try {
    const res = await api("/api/session");
    if (res.status === 401) {
      await release?.();
      client = undefined;
      return setStatus("signed-out");
    }
    user = (await res.json()).user;
  } catch {
    return setStatus(client ? "offline" : "signed-out");
  }
  // Signed out while the session answered: stop() let the copy go, and nothing opens or connects again.
  if (stopped) return;
  if (!user) return setStatus("signed-out");
  if (user !== last) {
    try {
      localStorage.setItem(LAST_USER, user);
    } catch {
      // Private windows: the copy just isn't found again next visit.
    }
    await openStore(user);
  }
  if (stopped) return;
  connect();
  addEventListener("online", connect);
  // A socket can sit open for a while after the network goes; offline is offline now (sensitive notes go read-only).
  addEventListener("offline", () => socket?.close());
  addEventListener("visibilitychange", () => document.visibilityState === "visible" && connect());
  await refresh();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Re-renders whenever anything in this tab's record changes. */
export function useRecord() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return { status, client, manifest, files, schemaLoaded };
}

/** Every note this tab can show, as the person sees it (remote + pending). */
export function notesOf(sync: SyncClient | undefined): NoteView[] {
  if (!sync) return [];
  const notes: NoteView[] = [];
  for (const [id, remote] of sync.state.remote) {
    const raw = sync.working(id);
    if (raw !== undefined) notes.push({ id, path: remote.path, raw, class: remote.class });
  }
  return notes.toSorted((a, b) => a.path.localeCompare(b.path));
}
