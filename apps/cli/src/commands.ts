// The CLI commands that work on a vault with or without the daemon running: doctor and restore. The ones
// that change what a running daemon does (resume, repair) are request files it watches for. The daemon's
// lock, pid and request files live in the user's config folder, never in the vault: a deleted vault can't take
// them with it, and nobody who can only write the vault can plant them.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SyncClient } from "@brainiac/sync";
import { parseNote } from "@brainiac/core";

import { inVault, place, readNote, walkVault } from "./disk.ts";
import { inICloud, isNote, otherSyncTools } from "./guards.ts";
import { openState } from "./state.ts";
import { exchange } from "./swap.ts";

/** What a running daemon is asked to do; it takes the request when its file appears. */
export type Request = "resume" | "undo" | "repair";

/** One of this vault's control files in the config folder. */
function control(config: string, vault: string, kind: "lock" | "pid" | "request"): string {
  // The vault's real path, so an alias (a symlink to it) is the same vault; once it is deleted, the path the
  // config holds, which `brainiac daemon run` stores already resolved.
  const real = existsSync(vault) ? realpathSync(vault) : resolve(vault);
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  mkdirSync(join(config, "run"), { recursive: true });
  return join(config, "run", `${key}.${kind}`);
}

/**
 * Takes this vault's daemon lock, held for as long as the process lives: SQLite's exclusive lock on a file,
 * which the OS releases when the process ends, however it ends. Throws if another daemon holds it.
 */
export function lockVault(config: string, vault: string): () => void {
  const db = new Database(control(config, vault, "lock"), { create: true });
  try {
    // Waits out a doctor or resume that is only checking the lock.
    db.run("PRAGMA busy_timeout = 2000");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new Error("Another brainiac daemon is already syncing this vault.");
  }
  // One left by a daemon that died before taking it isn't for this one: only requests made from now on are.
  rmSync(control(config, vault, "request"), { force: true });
  writeFileSync(control(config, vault, "pid"), String(process.pid));
  return () => {
    rmSync(control(config, vault, "pid"), { force: true });
    db.close();
  };
}

/** The pid of the daemon syncing this vault, if one is. The lock says whether it runs; a pid alone can be reused. */
function runningDaemon(config: string, vault: string): number | undefined {
  const db = new Database(control(config, vault, "lock"), { create: true });
  try {
    db.run("BEGIN EXCLUSIVE");
    db.run("ROLLBACK");
    return undefined;
  } catch {
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(control(config, vault, "pid"), "utf8"));
    } catch {} // locked but not written yet: a daemon starting
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } finally {
    db.close();
  }
}

/** Asks the running daemon to act; false if none runs. */
export function request(config: string, vault: string, what: Request): boolean {
  if (runningDaemon(config, vault) === undefined) return false;
  const file = control(config, vault, "request");
  // Renamed into place, so the daemon never reads half a request.
  writeFileSync(`${file}.tmp`, what);
  renameSync(`${file}.tmp`, file);
  return true;
}

/**
 * Calls `on` with each request made to this vault's daemon (after `lockVault`), until the returned function
 * stops watching. A file watch rather than a signal, so it works the same on Windows.
 */
export function watchRequests(config: string, vault: string, on: (what: Request) => void): () => void {
  const take = () => {
    const what = takeRequest(config, vault);
    if (what) on(what);
  };
  // Any event in the folder: some platforms don't name the file, and reading a missing one costs nothing.
  const watcher = watch(dirname(control(config, vault, "request")), take);
  take(); // one made while the daemon was starting
  return () => watcher.close();
}

/** The request waiting for this daemon, taken so it runs once. */
function takeRequest(config: string, vault: string): Request | undefined {
  const file = control(config, vault, "request");
  try {
    const what = readFileSync(file, "utf8").trim();
    rmSync(file, { force: true });
    return what === "resume" || what === "undo" || what === "repair" ? what : undefined;
  } catch {
    return undefined;
  }
}

export interface Check {
  readonly ok: boolean;
  readonly text: string;
}

/** Whether this folder's filesystem can swap two files in one step (without it, files are never replaced). */
function canSwap(vault: string): boolean {
  const [a, b] = ["a", "b"].map((x) => join(vault, ".brainiac", `.~brainiac-probe-${process.pid}-${x}`)) as [
    string,
    string,
  ];
  // Made new, never written through whatever might already sit at the name.
  for (const [path, text] of [
    [a, "a"],
    [b, "b"],
  ] as const) {
    rmSync(path, { force: true });
    writeFileSync(path, text, { flag: "wx" });
  }
  try {
    return exchange(a, b) === "done";
  } finally {
    rmSync(a, { force: true });
    rmSync(b, { force: true });
  }
}

/** `brainiac doctor`: everything that keeps this vault from syncing, and what to do about it. */
export async function doctor(config: string, vault: string, service?: string): Promise<Check[]> {
  if (!existsSync(vault)) {
    return [{ ok: false, text: `The vault folder ${vault} is gone. \`brainiac repair\` brings it back.` }];
  }
  if (!existsSync(join(vault, ".brainiac", "state.db"))) {
    return [{ ok: false, text: "This folder isn't a vault yet. `brainiac daemon run` sets it up." }];
  }
  if (lstatSync(join(vault, ".brainiac")).isSymbolicLink()) {
    return [
      { ok: false, text: "The vault's .brainiac folder is a symlink; Brainiac won't write through it." },
    ];
  }
  const checks: Check[] = [];
  const pid = runningDaemon(config, vault);
  checks.push(
    pid === undefined
      ? { ok: false, text: "The daemon isn't running. `brainiac daemon install` keeps it running." }
      : { ok: true, text: `The daemon is running (pid ${pid}).` },
  );
  if (service !== undefined && !existsSync(service)) {
    checks.push({
      ok: false,
      text: "No login service: after a restart nothing syncs until `brainiac daemon run`.",
    });
  }
  const swaps = canSwap(vault);
  checks.push(
    swaps
      ? { ok: true, text: "This filesystem swaps files atomically, so a save is never overwritten." }
      : {
          ok: false,
          text: "This filesystem can't swap files atomically, so remote changes to a file wait until you accept them.",
        },
  );
  for (const text of otherSyncTools(vault)) checks.push({ ok: false, text });

  const state = openState(join(vault, ".brainiac", "state.db"));
  try {
    const pause = state.pause();
    if (pause) checks.push({ ok: false, text: `Paused: ${pause.reason}` });
    const client = await SyncClient.open({
      store: state.store,
      send: () => {},
      // Never sent, but per run: a fixed id would be every vault's, and an id belongs to whoever used it first.
      newClientId: () => crypto.randomUUID(),
      keepSensitive: true, // read-only: never rewrites the stored remote layer
      schemaVersion: 0,
      appVersion: "doctor",
    });
    for (const [noteId, blocked] of client.state.blocked) {
      const at = state.pathOf(noteId) ?? noteId;
      for (const b of blocked) checks.push({ ok: false, text: `${at}: not synced: ${b.reason}` });
    }
    if (client.state.pending.length > 0) {
      checks.push({ ok: true, text: `${client.state.pending.length} changes waiting to reach the record.` });
    }
    for (const known of state.allKnown()) {
      const working = client.working(known.noteId);
      if (!swaps && working !== undefined && working !== known.text) {
        checks.push({ ok: false, text: `${known.path}: a newer version from the record waits for you.` });
      }
    }
    // Files the daemon can't take: symlinks, front-matter that doesn't parse, and, where it can't add one
    // safely, a missing id.
    const icloud = inICloud(vault);
    for (const path of walkVault(vault)) {
      if (!isNote(path, icloud) || state.known(path)) continue;
      let why: string | undefined;
      try {
        const text = readNote({ root: vault }, path);
        if (text === null) why = "symlinks and folders named like notes aren't synced";
        else if (text !== undefined && !swaps && parseNote(text).data["id"] === undefined) {
          why = 'this filesystem can\'t add an id safely; add "id:" with a ULID to its front-matter';
        } else if (text !== undefined) parseNote(text);
      } catch (error) {
        why = error instanceof Error ? error.message : String(error);
      }
      if (why) checks.push({ ok: false, text: `${path}: not synced: ${why}` });
    }
  } finally {
    state.close();
  }
  return checks;
}

/**
 * `brainiac restore <file>`: the versions sync writes took off disk in the last 7 days, newest first; with
 * `pick` (1 is the newest) that version goes back in the file, as if you saved it. What it replaces is kept
 * the same way, so a restore can be undone.
 */
export function restore(vault: string, path: string, now: number, pick?: number): string[] {
  // The daemon's own checks: its folder must be real, and the path a note inside the vault.
  if (lstatSync(join(vault, ".brainiac")).isSymbolicLink()) {
    throw new Error("The vault's .brainiac folder is a symlink; Brainiac won't write through it.");
  }
  if (!isNote(path, inICloud(vault)) || !inVault({ root: vault }, path)) {
    throw new Error(`${path} isn't a note inside the vault.`);
  }
  const state = openState(
    join(vault, ".brainiac", "state.db"),
    (p) => isNote(p, inICloud(vault)) && inVault({ root: vault }, p),
  );
  try {
    const versions = state.displaced(path, now, state.known(path)?.noteId);
    if (pick === undefined) {
      return versions.map(
        (v, i) => `${i + 1}  ${new Date(v.at).toISOString()}  ${v.text.split("\n").length} lines`,
      );
    }
    const version = versions[pick - 1];
    if (!version) throw new Error(`${path} has no version ${pick}; \`brainiac restore ${path}\` lists them.`);
    const current = readNote({ root: vault }, path);
    if (current === null) throw new Error(`${path} isn't a plain file; Brainiac won't write through it.`);
    const noteId = state.known(path)?.noteId;
    // What it replaces is kept aside like any sync write's, so the daemon catches an editor still writing into it.
    const disk = { root: vault, aside: join(vault, ".brainiac", "displaced") };
    const placed = place(disk, path, version.text, current, noteId);
    if (placed.taken) throw new Error(`${path} isn't a plain file; Brainiac won't write through it.`);
    if (placed.displaced !== undefined) state.displace(path, placed.displaced, now, noteId, placed.aside);
    if (placed.unseen !== undefined) {
      throw new Error(
        `${path} changed while restoring. The restored version is in the file; the save made meanwhile is version 1 of \`brainiac restore ${path}\`.`,
      );
    }
    if (placed.waiting)
      throw new Error(`This filesystem can't replace ${path} safely; copy the version in yourself.`);
    return [`Restored ${path} to the version from ${new Date(version.at).toISOString()}.`];
  } finally {
    state.close();
  }
}
