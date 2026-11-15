// This tab's view of the person's record: one sync client over one WebSocket (`/sync`, the session cookie), kept
// in this tab's IndexedDB slot so a returning visit shows the record before the socket is up. Every edit goes
// through the client's mutate path; nothing here names a record, the session does. The store is keyed by the
// signed-in account, so two people sharing a browser never share a copy.
import type { Manifest, ServerMessage } from "@brainiac/core";
import { SyncClient } from "@brainiac/sync";
import { openTabStore } from "@brainiac/sync/browser";
import { useSyncExternalStore } from "react";

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
    setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  });
}

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
export async function start() {
  if (started) return;
  started = true;
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
