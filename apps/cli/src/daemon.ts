// The daemon keeps a vault folder and the record in step. Remote changes are written to disk with an atomic
// swap, so a save racing the write is displaced, never lost, and becomes the person's pending change. Saves on
// disk go out as pending changes, merged by the record from the text they were made on. It pauses, instead of
// syncing, when the vault folder disappears or too many notes change at once.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { SCHEMA_VERSION } from "@brainiac/base";
import {
  isUlid,
  normalizePath,
  parseNote,
  patch,
  ulid,
  type ClientMessage,
  type ServerMessage,
} from "@brainiac/core";
import { SyncClient } from "@brainiac/sync";

import {
  ASIDE_NAME,
  asideFolder,
  inVault,
  place,
  readNote,
  readPlain,
  remove,
  tempTarget,
  walkVault,
  type Disk,
  type Placed,
} from "./disk.ts";
import { inICloud, isMassChange, isNote } from "./guards.ts";
import { openIndex, type Index } from "./index-db.ts";
import { openState, type Known, type State } from "./state.ts";

/** One socket to the record. */
export interface Link {
  send(message: ClientMessage): void;
  close(): void;
}

/** Opens a socket that reports `open` on each (re)connect and `close` when it drops. */
export type Connect = (on: { open(): void; message(message: ServerMessage): void; close(): void }) => Link;

export interface DaemonOptions {
  /** The vault folder. */
  readonly root: string;
  /** This machine, from the OS config folder: a vault copied from another machine has another owner. */
  readonly deviceId: string;
  readonly connect: Connect;
  /** The person chose "keep sensitive notes on this laptop" for a device they marked as theirs. */
  readonly keepSensitive?: boolean;
  /**
   * `tokenKey` of the token `connect` syncs with. The record's grants for it are kept with the copy, so
   * `brainiac mcp serve` with the same token can answer reads offline as that connection, never more.
   */
  readonly tokenKey?: string;
  /** Bring the vault back from the record: files are diffed against it, nothing local is assumed. */
  readonly repair?: boolean;
  readonly now?: () => number;
  /** Saves are collected this long after the last one, then synced together (300 ms). */
  readonly debounceMs?: number;
  /** A displaced file is watched this long for an editor still writing into it (2 s). */
  readonly graceMs?: number;
  readonly appVersion?: string;
  /** For the tests: run at each step of a write, and a swap that may be missing. */
  readonly disk?: Pick<Disk, "step" | "exchange">;
}

const DEBOUNCE_MS = 300;
/** A folder that never stops changing is still synced this often. */
const MAX_WAIT_MS = 2_000;
const GRACE_MS = 2_000;
/**
 * A displaced file is watched this long for a late write, then removed (its text stays in the history).
 * shortcut: an editor that keeps a file open longer than this and saves into it is missed; extend if seen.
 */
const ASIDE_MS = 10 * 60_000;

/** The note id in a file's front-matter, undefined if it has none, or an Error if it doesn't parse. */
function idOf(text: string): string | undefined | Error {
  try {
    const id = parseNote(text).data["id"];
    return typeof id === "string" && isUlid(id) ? id : undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const withId = (text: string, id: string) => patch(text, [{ op: "set", path: ["id"], value: id }]);

export class Daemon {
  readonly root: string;
  readonly #options: DaemonOptions;
  #state: State;
  #index: Index;
  #client!: SyncClient;
  #link: Link | undefined;
  #watcher: FSWatcher | undefined;
  readonly #dirty = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #grace: ReturnType<typeof setTimeout> | undefined;
  #firstDirty = 0;
  /** Waiting for the record's notes before comparing files with them. */
  #repairing: boolean;
  /** The vault folder is gone, and state.db with it: nothing is read or written until repair. */
  #gone = false;
  readonly #withholding = new Set<string>();
  #purged = false;
  /**
   * Where the record had each note when its file was last written for it: a file still there is one the record
   * moves (a move on the site or by an agent), while one the person moved on disk stays where they put it.
   */
  readonly #recordPaths = new Map<string, string>();

  /** After a sensitive note's history was purged, its text is cleared out of the write-ahead log too. */
  #truncateLog(): void {
    if (!this.#purged) return;
    try {
      const [result] = this.#state.sql.all<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
      if (result?.busy === 0) this.#purged = false;
    } catch {} // another reader holds it: retried after the next transaction, and on stop
  }
  /** The first catch-up since start has arrived, so the remote layer is current enough to write from. */
  #caughtUp = false;
  /** Files the daemon can't take yet (front-matter that doesn't parse, a symlink), with the reason. */
  readonly held = new Map<string, string>();
  readonly #batches = new Set<() => void>();
  readonly #disk: Disk;
  readonly #inICloud: boolean;

  private constructor(options: DaemonOptions, state: State, index: Index, repairing: boolean) {
    this.root = options.root;
    this.#options = options;
    this.#state = state;
    this.#index = index;
    this.#repairing = repairing;
    this.#disk = { root: options.root, aside: join(options.root, ".brainiac", "displaced"), ...options.disk };
    this.#inICloud = inICloud(options.root);
    this.#rememberFolder();
  }

  static async start(options: DaemonOptions): Promise<Daemon> {
    if (!existsSync(options.root)) {
      if (!options.repair) {
        throw new Error(
          `The vault folder ${options.root} is gone. Run \`brainiac repair\` to bring it back.`,
        );
      }
      mkdirSync(options.root, { recursive: true });
    }
    mkdirSync(join(options.root, ".brainiac"), { recursive: true });
    // Its files are written without further checks, so it must be the vault's own folder.
    if (lstatSync(join(options.root, ".brainiac")).isSymbolicLink()) {
      throw new Error(`${join(options.root, ".brainiac")} is a symlink; Brainiac won't write through it.`);
    }
    const icloud = inICloud(options.root);
    // state.db sits in the vault: a path in it is used only if it is one the daemon could have written.
    const state = openState(
      join(options.root, ".brainiac", "state.db"),
      (path) => isNote(path, icloud) && inVault({ root: options.root }, path),
    );
    const owner = state.owner();
    // Another machine's queue (a copied vault) must never replay here: start over and diff the files.
    // No owner on a state.db that holds anything: the daemon always writes one, so it came from elsewhere.
    const used = state.knownCount() > 0 || state.sql.all("SELECT 1 FROM sync_client").length > 0;
    const copied = owner !== options.deviceId && (owner !== undefined || used);
    if (copied) state.reset();
    state.setOwner(options.deviceId);
    // `brainiac repair` with no daemon running starts one this way: it ends a pause, and rebuilds the index
    // (deleted before it is opened: SQLite can't write to a database whose files went while it was open).
    if (options.repair) {
      state.setPause(undefined);
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(options.root, ".brainiac", `index.db${suffix}`), { force: true });
    }
    const { index, fresh } = openIndex(join(options.root, ".brainiac", "index.db"));
    const repairing = Boolean(options.repair) || copied || state.allKnown().length === 0;
    const daemon = new Daemon(options, state, index, repairing);
    // The other machine's kept files: their text is in the history rows already, and they must not replay here.
    if (copied) daemon.#dropKept();
    await daemon.#attach();
    if (fresh) {
      daemon.#reindex();
      index.built();
    }
    daemon.#watch();
    if (!repairing) {
      daemon.#salvage();
      daemon.#local(daemon.#scan(), true);
    }
    daemon.#connect();
    return daemon;
  }

  get client(): SyncClient {
    return this.#client;
  }

  readonly #listeners = new Set<(noteIds: ReadonlySet<string>) => void>();

  /** Calls `listener` with the notes that changed, on this sync client and on any a vanished folder replaces it with. */
  subscribe(listener: (noteIds: ReadonlySet<string>) => void): void {
    this.#listeners.add(listener);
    this.#client.subscribe(listener);
  }

  get state(): State {
    return this.#state;
  }

  /**
   * The vault folder is gone, or is another folder now (deleted and made again faster than a batch): either
   * way the state.db this process has open isn't the vault's any more.
   */
  #isGone(): boolean {
    if (!this.#gone && !this.#sameFolder()) this.#gone = true;
    return this.#gone;
  }

  #folder = { dev: 0, ino: 0 };

  #sameFolder(): boolean {
    try {
      const { dev, ino } = statSync(this.root);
      return dev === this.#folder.dev && ino === this.#folder.ino;
    } catch {
      return false;
    }
  }

  #rememberFolder(): void {
    const { dev, ino } = statSync(this.root);
    this.#folder = { dev, ino };
  }

  /** Why the daemon isn't taking changes from disk, if it isn't. */
  paused(): string | undefined {
    if (this.#isGone())
      return "The vault folder is gone. Nothing was deleted from your record; `brainiac repair` brings it back.";
    return this.#state.pause()?.reason;
  }

  /** Resolves after the next batch of saves has been synced (or paused). */
  nextBatch(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.#batches.delete(done);
        resolve();
      };
      this.#batches.add(done);
    });
  }

  #clientOptions() {
    return {
      store: this.#state.store,
      send: (message: ClientMessage) => this.#link?.send(message),
      newClientId: ulid,
      schemaVersion: SCHEMA_VERSION,
      appVersion: this.#options.appVersion ?? "dev",
      ...(this.#options.keepSensitive && { keepSensitive: true }),
    };
  }

  async #attach(): Promise<void> {
    this.#client = await SyncClient.open(this.#clientOptions());
    // As the last session left the remote layer: a move that arrives while catching up is still one.
    for (const [id, remote] of this.#client.state.remote) this.#recordPaths.set(id, remote.path);
    this.#client.subscribe((ids) => this.#reflect(ids));
  }

  #connect(): void {
    this.#link = this.#options.connect({
      open: () => this.#client.connect(),
      close: () => this.#client.disconnect(),
      message: (message) => {
        const { tokenKey } = this.#options;
        // Grants changed online close the socket, so every connect brings the current ones.
        if (message.type === "welcome" && !this.#gone)
          this.#state.setAccess(
            message.connection && tokenKey !== undefined
              ? { token: tokenKey, grants: message.connection, manifest: message.manifest ?? null }
              : undefined,
          );
        // The manifest changed online (organize): a hello on the same socket brings it in the next welcome, so the
        // copy answers offline with the new types.
        if (message.type === "manifest") return this.#client.connect();
        this.#client.receive(message);
        if (message.type !== "snapshot" && message.type !== "changes") return;
        if (this.#client.state.cursor === null) return;
        // Only what arrived counts: a socket that died unnoticed must not make the copy look fresher.
        if (!this.#gone) this.#state.synced(this.#now());
        // The first catch-up after a repair starts: now there is something to compare the files with.
        const first = !this.#caughtUp;
        this.#caughtUp = true; // before writing: writes wait for this
        if (this.#repairing) this.#reconcile();
        // The first since start: notes stored before a crash or a failed write, but never written, go to disk.
        else if (first) this.#reflect(this.#everyNote());
      },
    });
  }

  /** Stops watching and syncing; the state stays as it is on disk. */
  stop(): void {
    this.#truncateLog();
    clearTimeout(this.#timer);
    clearTimeout(this.#grace);
    this.#watcher?.close();
    this.#link?.close();
    this.#index.close();
    this.#state.close();
  }

  #now = () => (this.#options.now ?? Date.now)();

  /** State changes that must land together (a file's new base and the change queued from it) or not at all. */
  #atomically(fn: () => void): void {
    this.#depth++;
    try {
      this.#state.sql.transaction(fn);
    } finally {
      this.#depth--;
    }
    if (this.#depth === 0) this.#truncateLog(); // a checkpoint can't run inside a transaction
  }

  #depth = 0;

  #watch(): void {
    this.#watcher = watch(this.root, { recursive: true }, (_event, name) => {
      // Windows names the file with backslashes; the vault's paths use "/" everywhere.
      if (name) this.#dirty.add(sep === "/" ? name : name.replaceAll(sep, "/"));
      this.#schedule();
    });
    // The folder itself was removed: the batch sees it and pauses.
    this.#watcher.on("error", () => this.#schedule());
  }

  #schedule(): void {
    const now = Date.now();
    if (this.#timer === undefined) this.#firstDirty = now;
    clearTimeout(this.#timer);
    const wait = Math.max(
      0,
      Math.min(this.#options.debounceMs ?? DEBOUNCE_MS, this.#firstDirty + MAX_WAIT_MS - now),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const names = [...this.#dirty];
      this.#dirty.clear();
      // Gone (or replaced): nothing here may touch state.db, which went with it.
      if (!this.#isGone()) this.#local(this.#expand(names), true);
      if (!this.#isGone()) this.#checkAsides();
      for (const done of this.#batches) done();
    }, wait);
  }

  /** Every note path under the changed names: a removed folder reports only itself. */
  #expand(names: readonly string[]): string[] {
    const paths = new Set<string>();
    for (const name of names) {
      if (isNote(name, this.#inICloud)) paths.add(name);
      else if (!name.split("/").some((part) => part.startsWith("."))) {
        for (const known of this.#state.allKnown())
          if (known.path.startsWith(`${name}/`)) paths.add(known.path);
        for (const path of this.#walk(name)) paths.add(path);
      }
    }
    return [...paths];
  }

  /** The files under `dir` (relative to the vault): never through a symlinked folder, never in a hidden one. */
  #files(dir = ""): string[] {
    return walkVault(this.root, dir);
  }

  /** The note files under `dir` (relative to the vault). */
  #walk(dir = ""): string[] {
    return this.#files(dir).filter((path) => isNote(path, this.#inICloud));
  }

  /** Every note file on disk, and every file the daemon knew (so deletions are seen). */
  #scan(): string[] {
    return [...new Set([...this.#walk(), ...this.#state.allKnown().map((known) => known.path)])];
  }

  #pause(reason: string): void {
    if (!this.#state.pause()) this.#state.setPause({ reason, at: this.#now() });
  }

  /** Takes saves from disk: each changed file becomes a pending change, merged from the text it was made on. */
  #local(paths: readonly string[], guard: boolean): void {
    if (this.#isGone()) return;
    if (this.#state.pause() || this.#repairing) return;
    const changes = paths.flatMap((path) => {
      // Inside the vault even with symlinks followed: a symlinked folder could lead anywhere.
      if (!inVault(this.#disk, path)) {
        this.held.set(
          path,
          "It is reached through a symlink that leads out of the vault, so it isn't synced.",
        );
        return [];
      }
      let text: string | undefined | null;
      try {
        text = readNote(this.#disk, path);
      } catch (error) {
        // Unreadable (permissions): held, and the rest keep syncing.
        this.held.set(path, error instanceof Error ? error.message : String(error));
        return [];
      }
      if (text === null) {
        this.held.set(path, "Symlinks and folders named like notes aren't synced.");
        return [];
      }
      const known = this.#state.known(path);
      return text === known?.text ? [] : [{ path, text, known }];
    });
    // A move's two halves can arrive in separate batches: a deleted note's id in a file the daemon hasn't
    // seen yet makes it a move, not a delete.
    const deleting = new Set(
      changes.flatMap((c) => (c.text === undefined && c.known ? [c.known.noteId] : [])),
    );
    if (deleting.size > 0) {
      const seen = new Set(changes.map((c) => c.path));
      for (const path of this.#walk()) {
        if (seen.has(path) || this.#state.known(path)) continue;
        const text = readPlain(join(this.root, path));
        const id = text === undefined ? undefined : idOf(text);
        if (typeof id === "string" && deleting.has(id)) changes.push({ path, text: text!, known: undefined });
      }
    }
    // Notes, not files: a move is a save at one path and a delete at another, of one note, and a move that
    // changes no text changes nothing in the record, so it doesn't count at all.
    const gone = new Map(
      changes.flatMap((c) => (c.text === undefined && c.known ? [[c.known.noteId, c.known.text]] : [])),
    );
    const moves = new Set(
      changes.flatMap((c) => {
        const id = c.text && !c.known ? idOf(c.text) : undefined;
        return typeof id === "string" && gone.get(id) === c.text ? [id] : [];
      }),
    );
    const notes = new Set(
      changes
        .map((c) => c.known?.noteId ?? (c.text && idOf(c.text)) ?? c.path)
        .filter((note) => typeof note !== "string" || !moves.has(note)),
    );
    const total = Math.max(this.#client.state.remote.size, this.#state.knownCount());
    if (guard && isMassChange(notes.size, total)) {
      return this.#pause(
        `${notes.size} notes changed on disk at once, which looks like a bad checkout or a script gone wrong. ` +
          "Nothing was synced. `brainiac resume` syncs them; `brainiac resume --undo` puts the record's versions back.",
      );
    }
    // Saves before deletes, so a note moved to another path is seen at its new path before its old one is gone.
    for (const { path, text, known } of changes) {
      if (text !== undefined) this.#each(path, () => this.#save(path, text, known));
    }
    for (const { path, text, known } of changes) {
      if (text === undefined && known) this.#each(path, () => this.#deleted(known));
    }
  }

  /** One file's change, in one transaction; a file the disk refuses (locked, read-only) is held, not fatal. */
  #each(path: string, fn: () => void): void {
    try {
      this.#atomically(fn);
    } catch (error) {
      this.held.set(path, error instanceof Error ? error.message : String(error));
    }
  }

  /** Every note the record or this disk has: a remote delete must reach a file too. */
  #everyNote(): Set<string> {
    return new Set([
      ...this.#client.state.remote.keys(),
      ...this.#state.allKnown().map((known) => known.noteId),
    ]);
  }

  #save(path: string, text: string, known: Known | undefined): void {
    this.held.delete(path);
    if (known) {
      const id = known.noteId;
      // An editor still holding the file from before the daemon gave it an id saves it without one.
      const raw = idOf(text) === undefined ? withId(text, id) : text;
      this.#state.setKnown({ ...known, text });
      const { state } = this.#client;
      const refused = state.blocked.get(id)?.some((b) => b.change.kind === "create") && !state.remote.has(id);
      // A create the record refused, fixed in the file: it is sent again as a create, since the note never was.
      if (refused) this.#client.create(id, normalizePath(path), raw, "normal");
      // A refused edit undone in the file: sent anyway, so the record's no-op answer clears the block.
      else if (raw !== this.#client.working(id) || state.blocked.get(id)?.some((b) => !b.proposalId)) {
        this.#client.edit(id, raw, known.text);
      }
      if (this.#withheld(id)) return this.#withhold(id); // the save is sent; the file still leaves the device
      this.#indexFile(path, id, raw);
      // A move the record made waited for this save (`#follow`): it follows now, since a save that matches the
      // record sends nothing, and no answer would come back to bring it.
      const remote = state.remote.get(id);
      if (remote && remote.path !== path && this.#recordPaths.get(id) === path) this.#reflect([id]);
      return;
    }
    let id = idOf(text);
    if (id instanceof Error) return void this.held.set(path, id.message);
    const elsewhere = id ? this.#state.pathOf(id) : undefined;
    const moved = elsewhere === undefined ? undefined : this.#state.known(elsewhere);
    // A copy of another note's file: it becomes a note of its own. The same file under a name differing only in
    // case (a rename on a case-insensitive disk) is a move, not a copy.
    if (elsewhere && readNote(this.#disk, elsewhere) !== undefined && !this.#sameFile(elsewhere, path))
      id = undefined;
    if (!id) {
      id = ulid();
      const named = withId(text, id);
      let placed = place(this.#disk, path, named, text, id);
      this.#keep(path, placed, id);
      if (placed.waiting) {
        return void this.held.set(
          path,
          `This filesystem can't add an id to the file safely. Add "id: ${id}" to its front-matter to sync it.`,
        );
      }
      if (placed.disk === undefined) return; // deleted meanwhile; the next batch sees it gone
      if (placed.unseen !== undefined) {
        // Saved again while the id went in: that newer save goes back on disk, and so does any saved while it
        // went back, so the newest ends on disk; the next batch takes it. (Each one replaced is in the history.)
        for (let onDisk = named, tries = 0; placed.unseen !== undefined && tries < 5; tries++) {
          const back: string = placed.unseen;
          placed = place(this.#disk, path, back, onDisk, id);
          this.#keep(path, placed, id);
          onDisk = back;
        }
        return;
      }
      text = named;
    }
    // Moved on disk: it keeps its path in the record, since the protocol has no move yet (#38).
    if (moved && id === moved.noteId) this.#state.forget(moved.path);
    this.#state.setKnown({ path, noteId: id, text });
    if (this.#client.state.remote.has(id) || this.#client.working(id) !== undefined) {
      // Made on the moved file's text; a note seen here for the first time has no base, so every difference
      // is a conflict, never an overwrite.
      const base = moved && id === moved.noteId ? moved.text : "";
      if (text !== this.#client.working(id)) this.#client.edit(id, text, base);
    } else this.#client.create(id, normalizePath(path), text, "normal");
    // A file brought back for a note this device doesn't keep (an editor saving it again, unchanged or not).
    if (this.#withheld(id)) return this.#withhold(id);
    this.#indexFile(path, id, text);
  }

  #sameFile(a: string, b: string): boolean {
    try {
      const [x, y] = [statSync(join(this.root, a)), statSync(join(this.root, b))];
      return x.dev === y.dev && x.ino === y.ino;
    } catch {
      return false;
    }
  }

  #withheld(id: string): boolean {
    // The record withholding it (this connection lacks the sensitive scope) leaves the device the same way.
    if (this.#client.withheld(id)) return true;
    return this.#client.state.remote.get(id)?.class === "sensitive" && !this.#options.keepSensitive;
  }

  #deleted(known: Known): void {
    this.#state.forget(known.path);
    if (this.#state.pathOf(known.noteId) !== undefined) return; // moved, not deleted
    this.#index.drop(known.noteId);
    if (this.#client.working(known.noteId) !== undefined) this.#client.delete(known.noteId, known.text);
  }

  /** Writes the notes that changed in the record to their files. */
  #reflect(ids: Iterable<string>): void {
    if (this.#isGone()) return;
    // Writes wait for resume or repair, and for the first catch-up (the remote layer may be stale until then).
    const waiting = this.#repairing || !this.#caughtUp || this.#state.pause() !== undefined;
    for (const id of ids) {
      try {
        // Privacy before anything else, pause and blocked edits included.
        if (this.#withheld(id)) this.#atomically(() => this.#withhold(id));
        else if (!waiting) this.#atomically(() => this.#write(id));
      } catch (error) {
        // One note the disk refuses (a name the filesystem won't take) never stops the others.
        console.error(`Couldn't write note ${id}:`, error);
      }
    }
  }

  #write(id: string): void {
    const { state } = this.#client;
    // A note with an edit the record refused keeps the person's text until they resolve it.
    if (state.blocked.has(id)) return;
    const remote = state.remote.get(id);
    const created = state.pending.find((p) => p.noteId === id && p.change.kind === "create")?.change;
    const onDisk = this.#state.pathOf(id);
    if (remote && onDisk !== undefined && remote.path !== onDisk && this.#recordPaths.get(id) === onDisk) {
      if (!this.#follow(id, onDisk, remote.path)) return;
    }
    if (remote && (this.#state.pathOf(id) ?? remote.path) === remote.path)
      this.#recordPaths.set(id, remote.path);
    const path =
      this.#state.pathOf(id) ?? remote?.path ?? (created?.kind === "create" ? created.path : undefined);
    // The record's paths are checked like any input: never outside the vault, never a hidden or non-note file.
    if (path === undefined || !isNote(path, this.#inICloud) || !inVault(this.#disk, path)) return;
    const known = this.#state.known(path);
    if (known && known.noteId !== id) {
      const why = `Another note has this file here, so the record's note ${id} isn't written to it.`;
      return void this.held.set(path, why);
    }
    const desired = this.#client.working(id);
    if (desired === known?.text) return;
    let placed: Placed;
    if (desired !== undefined) placed = place(this.#disk, path, desired, known?.text, id);
    else if (known) placed = remove(this.#disk, path, known.text, id);
    else return;
    this.#keep(path, placed, id);
    if (placed.taken)
      this.held.set(path, `Something else has this name, so the record's note ${id} isn't written.`);
    if (placed.waiting || placed.taken) return; // the file stays as it is; the watcher reports any save in it
    // The file went while it was being written (a local delete): the batch sends that delete, from the known text.
    if (placed.disk === undefined && desired !== undefined) return;
    if (placed.disk === undefined) {
      this.#state.forget(path);
      this.#index.drop(id);
    } else {
      this.#state.setKnown({ path, noteId: id, text: placed.disk });
      this.#indexFile(path, id, placed.disk);
    }
    // A save the write displaced, or one found after a delete: the person's change, made on the file they had.
    // An empty one is an editor caught between truncating and writing; its write lands in the kept file.
    if (placed.unseen) this.#client.edit(id, placed.unseen, known?.text ?? "");
  }

  /**
   * Moves a note's file where the record moved it: written there first, then gone from where it was, so the note
   * is never missing from disk. A path the disk can't take, or another file there, holds it where it is.
   */
  #follow(id: string, from: string, to: string): boolean {
    const known = this.#state.known(from);
    if (!known) return true;
    if (!isNote(to, this.#inICloud) || !inVault(this.#disk, to)) return false;
    // A save there the daemon hasn't taken yet: the watcher sends it first, and the move follows its answer.
    if (readNote(this.#disk, from) !== known.text) return false;
    const there = this.#state.known(to);
    const why = `Something else has this name, so the record's move of note ${id} isn't written here.`;
    const placed =
      there && there.noteId !== id ? undefined : place(this.#disk, to, known.text, undefined, id);
    if (placed) this.#keep(to, placed, id);
    if (!placed || placed.taken || placed.waiting || placed.disk === undefined) {
      this.held.set(to, why);
      return false;
    }
    this.#state.setKnown({ path: to, noteId: id, text: placed.disk });
    let gone = remove(this.#disk, from, known.text, id);
    this.#keep(from, gone, id);
    // Saved into the old file as it went: the person's change, made on what the daemon knew. The file it put
    // back goes too, its text sent, so no second copy of the note stays behind to be taken for a new one.
    if (gone.unseen) this.#client.edit(id, gone.unseen, known.text);
    if (gone.disk !== undefined) {
      gone = remove(this.#disk, from, gone.disk, id);
      this.#keep(from, gone, id);
    }
    // shortcut: saved again in the instant between: that file stays, known as the note's, beside the moved one.
    if (gone.disk === undefined) this.#state.forget(from);
    this.#indexFile(to, id, placed.disk);
    return true;
  }

  /** Records what a write took off disk, and watches its file a while for a late write. */
  #keep(path: string, placed: Placed, noteId: string): void {
    if (placed.displaced === undefined) return;
    this.#state.displace(path, placed.displaced, this.#now(), noteId, placed.aside);
    if (placed.aside === undefined) return;
    clearTimeout(this.#grace);
    this.#grace = setTimeout(() => {
      this.#grace = undefined;
      if (!this.#isGone()) this.#checkAsides();
    }, this.#options.graceMs ?? GRACE_MS);
  }

  /** A save found late (in a displaced file, or one a crash left): the person's change to the note. */
  #late(noteId: string, text: string, base: string): void {
    if (text !== "" && text !== this.#client.working(noteId)) this.#client.edit(noteId, text, base);
  }

  /**
   * An editor that had a file open across the swap writes into the displaced file. Kept files are read again
   * soon after the write, on every batch and at startup: what changed in one is a save, sent as the person's
   * change to its note (even one deleted since), and watching goes on from it. After `ASIDE_MS` it is removed.
   */
  #checkAsides(only?: string): void {
    const folder = asideFolder(this.#disk);
    const now = this.#now();
    for (const aside of this.#state.asides()) {
      if (only !== undefined && aside.noteId !== only) continue;
      // Only a name the daemon made, inside its own folder: state.db sits in the vault, so it isn't trusted.
      const name = aside.file!;
      const noteId = folder ? ASIDE_NAME.exec(name)?.[1] : undefined;
      const file = noteId === undefined ? undefined : join(folder!, name);
      const text = file === undefined ? undefined : readPlain(file);
      // There but unreadable (permissions): kept, with its row, until it can be read; never taken as gone.
      if (file !== undefined && text === undefined && existsSync(file)) continue;
      // A sensitive note's file is watched only for the grace period, and leaves no history behind.
      const withheld = noteId !== undefined && this.#withheld(noteId);
      // Checked for a note being withheld (`only`), its kept files are finished now: they are about to go.
      const old =
        only !== undefined || now - aside.at >= (withheld ? (this.#options.graceMs ?? GRACE_MS) : ASIDE_MS);
      const changed = noteId !== undefined && text !== undefined && text !== aside.text && text !== "";
      // Still empty at the end of its watch: a save that emptied the file, not an editor mid-write.
      const emptied = old && text === "" && aside.text !== "";
      const done = old || text === undefined || (withheld && changed);
      this.#atomically(() => {
        // The row is settled before the save is sent: sending reflects the note, which may check again.
        if (changed && !withheld) this.#state.displace(aside.path, text, now, noteId, old ? undefined : name);
        if (emptied && !withheld) this.#state.displace(aside.path, "", now, noteId);
        if (withheld && (changed || old || text === undefined)) {
          this.#state.drop(aside.id);
          this.#purged = true; // its text goes out of the write-ahead log too
        } else if (changed || old || text === undefined) this.#state.checked(aside.id);
        if (changed) this.#late(noteId, text, aside.text);
      });
      // Removed once the version and the change are committed. A crash in between leaves an orphan whose text
      // is in the history, which recovery then knows is no save.
      if (file !== undefined && done) rmSync(file, { force: true });
      if (emptied)
        this.held.set(aside.path, "An empty save was replaced by a sync write; `brainiac restore` has it.");
    }
  }

  /**
   * A file a crash or a failed keep left, holding `text`. Text the note has, shows, or already has in its
   * history is no save (a swap's displaced version, or what the daemon meant to write). Anything else is the
   * person's: kept as a version and sent, made on the version it was displaced from; an empty one is held.
   */
  #leftover(noteId: string | undefined, path: string | undefined, text: string): void {
    const known = path === undefined ? undefined : this.#state.known(path);
    if (text === known?.text || (noteId !== undefined && text === this.#client.working(noteId))) return;
    const history = this.#state.displaced(path ?? "", this.#now(), noteId);
    if (history.some((version) => version.text === text)) return;
    // shortcut: made on the newest version; a leftover older than that (several failed keeps) merges from it.
    const base = history[0]?.text ?? known?.text ?? "";
    this.#atomically(() => {
      // A note this device doesn't keep: its save is still sent, but none of it stays as history here.
      if (noteId === undefined || !this.#withheld(noteId))
        this.#state.displace(path ?? "", text, this.#now(), noteId);
      if (text === "") {
        if (path !== undefined)
          this.held.set(path, "An empty save was replaced by a sync write; `brainiac restore` has it.");
      } else if (noteId !== undefined) this.#late(noteId, text, base);
    });
  }

  /**
   * Kept files with no record: a crash between keeping one and committing its row. The name says whose it is,
   * so one holding something the note never had is still the person's change.
   */
  #orphans(): void {
    const folder = asideFolder(this.#disk);
    if (!folder) return;
    const watched = new Set(this.#state.asides().map((aside) => aside.file));
    for (const name of readdirSync(folder)) {
      if (watched.has(name)) continue;
      const noteId = ASIDE_NAME.exec(name)?.[1];
      const text = noteId === undefined ? undefined : readPlain(join(folder, name));
      if (noteId !== undefined && text !== undefined)
        this.#leftover(noteId, this.#state.pathOf(noteId), text);
      // Only plain files with the daemon's own names, never recursively: nothing else there is its to delete.
      if (noteId !== undefined && text !== undefined) rmSync(join(folder, name), { force: true });
    }
  }

  /**
   * Temp files a crash left next to notes. One holding something other than what the daemon knew or meant to
   * write is a save it never saw: kept as a displaced version and sent as the person's change.
   */
  #recover(): void {
    for (const name of this.#files()) {
      if (name.startsWith(".brainiac/")) continue;
      const target = tempTarget(name);
      if (target === undefined && !name.split("/").at(-1)!.startsWith(".~brainiac-")) continue;
      const file = join(this.root, name);
      const text = readPlain(file);
      if (text === undefined) continue;
      const known = target === undefined ? undefined : this.#state.known(target);
      const id = known?.noteId ?? idOf(text);
      this.#leftover(typeof id === "string" ? id : undefined, target, text);
      rmSync(file, { force: true });
    }
  }

  /**
   * A note that is (or became) sensitive on a device that doesn't keep them: its file, index entry and every
   * displaced version (by note, so ones from before a move go too) leave the device. A save found as the file
   * goes is sent as the person's change first. The file it removes is kept for the grace period only (2 s) so
   * an editor still writing into it is caught, then deleted with its row; none of it becomes history.
   */
  #withhold(id: string): void {
    // Sending a save found here reflects the note again, which would withhold it again from inside.
    if (this.#withholding.has(id)) return;
    this.#withholding.add(id);
    try {
      this.#withholdNow(id);
    } finally {
      this.#withholding.delete(id);
    }
  }

  #withholdNow(id: string): void {
    this.#index.drop(id);
    // Saves already in its kept files are sent before those files go; then all its history goes, by note id,
    // whether or not it still has a file here.
    this.#checkAsides(id);
    const path = this.#state.pathOf(id);
    // Files left beside it by an earlier write that had nowhere to keep them, judged while its history still
    // says which versions are no saves: a save in one is still sent.
    if (path !== undefined) {
      for (const name of this.#files(dirname(path))) {
        if (tempTarget(name) !== path) continue;
        const text = readPlain(join(this.root, name));
        if (text !== undefined) this.#leftover(id, path, text);
        rmSync(join(this.root, name), { force: true });
      }
    }
    const folder = asideFolder(this.#disk);
    // Kept files that are there but can't be read yet stay, rows and all: one may hold the only copy of a save,
    // which the next check sends once it can be read (and then drops, the note being withheld).
    const unreadable = this.#state
      .asides()
      .filter((aside) => aside.noteId === id && folder !== undefined && existsSync(join(folder, aside.file!)))
      .filter((aside) => readPlain(join(folder!, aside.file!)) === undefined)
      .map((aside) => aside.id);
    for (const name of this.#state.purgeDisplaced(path ?? "", id, unreadable)) {
      if (folder && ASIDE_NAME.test(name)) rmSync(join(folder, name), { force: true });
    }
    this.#purged = true; // and out of the write-ahead log, once this transaction commits
    if (path === undefined) return;
    // The file removed now is watched only briefly for an editor still writing into it.
    let expected = this.#state.known(path)?.text;
    for (let tries = 0; expected !== undefined && tries < 5; tries++) {
      const placed = remove({ ...this.#disk, discardUnkept: true }, path, expected, id);
      // Only a version kept aside is recorded (its row goes when the brief watch ends); none becomes history.
      if (placed.aside !== undefined) this.#keep(path, placed, id);
      if (placed.unseen === undefined || placed.taken) break;
      this.#late(id, placed.unseen, expected);
      expected = placed.unseen;
    }
    this.#state.forget(path);
  }

  #dropKept(): void {
    const folder = asideFolder(this.#disk);
    if (!folder) return;
    for (const name of readdirSync(folder)) {
      const noteId = ASIDE_NAME.exec(name)?.[1];
      const text = noteId === undefined ? undefined : readPlain(join(folder, name));
      if (noteId === undefined || text === undefined) continue;
      // A late save in one is kept as a version (restore has it), but never sent: it is the other machine's.
      const history = this.#state.displaced("", this.#now(), noteId);
      if (!history.some((version) => version.text === text))
        this.#state.displace("", text, this.#now(), noteId);
      rmSync(join(folder, name), { force: true });
    }
  }

  /** What a crash or a late write left: saves in leftover temp files and in displaced files. */
  #salvage(): void {
    this.#recover();
    this.#checkAsides();
    this.#orphans();
  }

  /** After a repair: every file is compared with the record, and every note the disk lacks is written. */
  #reconcile(): void {
    this.#repairing = false;
    this.#salvage(); // before the known files are forgotten, so leftovers still find their notes
    for (const known of this.#state.allKnown()) this.#state.forget(known.path);
    this.#local(this.#walk(), false);
    this.#reflect(this.#everyNote());
  }

  #indexFile(path: string, id: string, raw: string): void {
    const cls = this.#client.state.remote.get(id)?.class ?? "normal";
    if (cls === "sensitive" && !this.#options.keepSensitive) return;
    this.#index.put({ id, path, raw, class: cls });
  }

  #reindex(): void {
    for (const { path, noteId, text } of this.#state.allKnown()) this.#indexFile(path, noteId, text);
  }

  /**
   * Ends a pause. The changes found on disk are synced, or with `undo` the record's versions are written back
   * over them (each version taken off disk is kept for `brainiac restore`). A vault folder that is gone is
   * made again first, from the state still in this process.
   */
  async resume(options: { readonly undo?: boolean } = {}): Promise<void> {
    if (this.#isGone()) this.#recreate();
    this.#state.setPause(undefined);
    if (options.undo) {
      // What is on disk now is what the record's versions replace (and what restore can bring back).
      for (const known of this.#state.allKnown()) {
        const disk = readNote(this.#disk, known.path);
        if (disk !== known.text && this.#client.state.blocked.has(known.noteId)) {
          // Its own edit is still blocked, so the record's version can't go back over the file yet.
          this.held.set(known.path, "Not put back: it has an edit the record refused; resolve that first.");
        }
        if (disk === undefined) this.#state.forget(known.path);
        else if (typeof disk === "string" && disk !== known.text)
          this.#state.setKnown({ ...known, text: disk });
      }
      // New files from the same change aren't the record's to put back: they sync as made.
      this.#local(
        this.#walk().filter((path) => !this.#state.known(path)),
        false,
      );
    } else this.#local(this.#scan(), false);
    this.#reflect(this.#everyNote());
  }

  /**
   * `brainiac repair`: rebuilds index.db, makes a deleted vault folder again, and compares every file with
   * the record once it has caught up. Pending changes are kept; differences with no known base become
   * conflicts, never overwrites.
   */
  /** The vault's own .brainiac folder, never a symlink put in its place after start. */
  #checkMeta(): void {
    const meta = join(this.root, ".brainiac");
    const stat = lstatSync(meta);
    const own = realpathSync(meta) === join(realpathSync(this.root), ".brainiac");
    if (!stat.isDirectory() || stat.isSymbolicLink() || !own) {
      throw new Error(`${meta} isn't the vault's own folder (a symlink?); Brainiac won't write through it.`);
    }
  }

  async repair(): Promise<void> {
    if (this.#isGone()) this.#recreate();
    this.#checkMeta();
    this.#state.setPause(undefined);
    this.#index.close();
    const path = join(this.root, ".brainiac", "index.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    this.#index = openIndex(path).index;
    this.#repairing = true;
    this.#client.connect(); // its catch-up starts the comparison
  }

  /**
   * The vault folder was deleted under a running daemon, state.db with it. The sync state is still in memory,
   * pending changes included, so it goes into a new state.db; the files are written again from the record.
   */
  #recreate(): void {
    mkdirSync(join(this.root, ".brainiac"), { recursive: true });
    this.#checkMeta();
    this.#index.close();
    this.#state.close();
    this.#state = openState(
      join(this.root, ".brainiac", "state.db"),
      (path) => isNote(path, this.#inICloud) && inVault(this.#disk, path),
    );
    this.#state.setOwner(this.#options.deviceId);
    this.#index = openIndex(join(this.root, ".brainiac", "index.db")).index;
    this.#client = new SyncClient(this.#client.state, this.#clientOptions());
    this.#client.subscribe((ids) => this.#reflect(ids));
    for (const listener of this.#listeners) this.#client.subscribe(listener);
    this.#client.saveAll();
    this.#watcher?.close();
    this.#watch();
    this.#rememberFolder();
    this.#gone = false;
    this.#client.connect(); // the new client starts unwelcomed: a hello lets its pending changes go out
  }
}
