// This tab's view of the person's record: one sync client over one WebSocket (`/sync`, the session cookie), kept
// in this tab's IndexedDB slot so a returning visit shows the record before the socket is up. Every edit goes
// through the client's mutate path; nothing here names a record, the session does. The store is keyed by the
// signed-in account, so two people sharing a browser never share a copy.
import type { Manifest, ServerMessage } from "@brainiac/core";
import { SyncClient } from "@brainiac/sync";
import { openTabStore } from "@brainiac/sync/browser";
import { useSyncExternalStore } from "react";

import type { SaveOnline } from "./fields.ts";

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

async function openStore(user: string) {
  await release?.();
  socket?.close();
  const slot = await openTabStore(`${STORE_PREFIX}${user}`);
  release = slot.release;
  client = await SyncClient.open({
    store: slot.store,
    send: (message) => socket?.send(JSON.stringify(message)),
    newClientId: () => crypto.randomUUID(),
    // The site keeps no SQL of its own, so it speaks no SQL schema version.
    schemaVersion: 0,
    appVersion: "web",
  });
  client.subscribe(changed);
  changed();
}

function connect() {
  if (!client || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/sync`);
  socket = ws;
  setStatus("connecting");
  ws.addEventListener("open", () => {
    retry = 0;
    setStatus("live");
    client?.connect();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message: ServerMessage = JSON.parse(event.data);
    client?.receive(message);
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

/** The latest text and revision the record accepted from this tab's online saves, per sensitive note. */
const accepted = new Map<string, { readonly rev: number; readonly raw: string }>();
/** Each sensitive note's online saves, in order: the next builds on what the last one wrote. */
const saving = new Map<string, Promise<unknown>>();
const queued = new Map<string, number>();

/** The latest text of a sensitive note: what an online save wrote, until the sync push brings it. */
const latest = (noteId: string) => {
  const remote = client?.state.remote.get(noteId);
  const mine = accepted.get(noteId);
  return mine && (!remote || mine.rev > remote.rev) ? mine : remote;
};

/** True while a sensitive note has an online save on its way, or one the sync push hasn't brought back yet. */
export const savingOnline = (noteId: string): boolean =>
  (queued.get(noteId) ?? 0) > 0 || latest(noteId) !== client?.state.remote.get(noteId);

/** Saves a sensitive note's edit straight to the record, as the person; never through the client's queue. */
export const saveOnline: SaveOnline = (noteId, edit) => {
  const run = async (): Promise<string | undefined> => {
    if (status !== "live") return OFFLINE_SENSITIVE;
    const base = latest(noteId);
    if (!base) return "This note is gone.";
    const raw = edit(base.raw);
    if (raw === base.raw) return undefined;
    const res = await api(`/api/notes/${noteId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw, baseRev: base.rev }),
    }).catch(() => undefined);
    if (!res) return "You're offline, so this edit wasn't saved.";
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return body.error ?? "This edit wasn't saved.";
    accepted.set(noteId, { rev: body.rev, raw });
    return undefined;
  };
  queued.set(noteId, (queued.get(noteId) ?? 0) + 1);
  const next = (saving.get(noteId) ?? Promise.resolve()).then(run).finally(() => {
    queued.set(noteId, (queued.get(noteId) ?? 1) - 1);
    changed();
  });
  saving.set(noteId, next);
  return next;
};

/** Loads the manifest and the file list; both come from the record over HTTP, not the sync socket. */
export async function refresh() {
  const [schema, list] = await Promise.all([api("/api/schema"), api("/api/files")]);
  if (schema.ok) manifest = (await schema.json()).manifest;
  if (list.ok) files = (await list.json()).files;
  changed();
}

/** Same-origin JSON calls to the Worker's site routes (apps/worker/src/site.ts). */
export const api = (path: string, init: RequestInit = {}) =>
  fetch(path, { ...init, credentials: "same-origin" });

/** Starts this tab's client once: the stored copy at once, then the session, then the socket. */
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
  await release?.();
  release = undefined;
  status = "signed-out";
  changed();
}

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
  if (!user) return setStatus("signed-out");
  if (user !== last) {
    try {
      localStorage.setItem(LAST_USER, user);
    } catch {
      // Private windows: the copy just isn't found again next visit.
    }
    await openStore(user);
  }
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
  return { status, client, manifest, files };
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
