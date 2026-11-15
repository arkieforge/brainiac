// Writing notes into a folder people also edit. A save is never overwritten: a new file is linked in only if
// nothing is there, and an existing one is swapped out in one step, so whatever it displaced is read back and
// checked against what the daemon expected to find. The displaced file itself is kept aside, not deleted, so an
// editor still writing into it is caught too. On a filesystem with no swap call, files are never replaced.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, posix, sep } from "node:path";

import { isUlid, normalizePath } from "@brainiac/core";

import { exchange } from "./swap.ts";

/** The moments a write can be interrupted by a save, for the tests that interleave one at each. */
export type Step = "temp" | "swapped" | "read";

/** What a write left: the text now on disk (undefined: no file), what it took off disk, and any unseen save. */
export interface Placed {
  readonly disk: string | undefined;
  /** The text the write took off disk, kept for `brainiac restore`. */
  readonly displaced?: string;
  /** The name, in `Disk.aside`, of the file holding `displaced`, kept so a late write into it is seen. */
  readonly aside?: string;
  /** A save the daemon hadn't seen yet: displaced by the write, or found in place. It is the person's change. */
  readonly unseen?: string;
  /** The filesystem can't swap, so an existing file was left alone and the new text waits. */
  readonly waiting?: true;
  /** A new note's name was taken by a file the daemon doesn't know yet; nothing was written. */
  readonly taken?: true;
}

export interface Disk {
  readonly root: string;
  /** Where displaced files are kept aside (`.brainiac/displaced`). */
  readonly aside?: string;
  /** A displaced file that can't be kept aside is deleted, not left beside the note (a sensitive note's). */
  readonly discardUnkept?: boolean;
  /** Called at each step of a write; tests save a file there. */
  readonly step?: (step: Step, path: string) => void;
  /** Swaps two paths; tests pass one that can't, as on a filesystem without the call. */
  readonly exchange?: typeof exchange;
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/**
 * Whether the daemon may write `path` (from the record, so not trusted to stay in the vault): a relative path
 * with no `.` or `..` parts, no control characters, names the OS takes, and whose nearest existing folder is
 * still inside the vault once symlinks are followed.
 */
export function inVault(disk: Disk, path: string): boolean {
  try {
    normalizePath(path);
  } catch {
    return false;
  }
  // NUL and control characters make the filesystem calls throw; longer names than the OS allows do too.
  if ([...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return false;
  if (path.split("/").some((part) => Buffer.byteLength(part) > 255)) return false;
  const root = realpathSync(disk.root);
  let dir = dirname(join(disk.root, path));
  while (!existsSync(dir)) dir = dirname(dir);
  const real = realpathSync(dir);
  return real === root || real.startsWith(root + sep);
}

/**
 * Reads a note's file: undefined if there is none, `null` if the name holds something that isn't a plain file
 * (a symlink, which could lead out of the vault, or a folder), which the daemon leaves alone.
 */
export function readNote(disk: Disk, path: string): string | undefined | null {
  const full = join(disk.root, path);
  try {
    if (!lstatSync(full).isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return read(full);
}

/**
 * Every file in the vault, relative to it. Never follows a symlinked folder (it could loop or lead out of the
 * vault) and never enters a hidden one (.brainiac, .git, .obsidian); a folder it can't read is skipped.
 */
export function walkVault(root: string, dir = ""): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : walkVault(root, path);
    return [path];
  });
}

/** A file's text if it is a plain file; never follows a symlink, which could lead out of the vault. */
export function readPlain(file: string): string | undefined {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Temp files carry the name they stand in for, so one left by a crash can be traced back to its note. */
const TEMP = ".~brainiac-";

/** The note path (relative to the same folder) a leftover temp file was standing in for, if its name says. */
export function tempTarget(path: string): string | undefined {
  const name = basename(path);
  if (!name.startsWith(TEMP)) return undefined;
  const target = name.slice(TEMP.length + 9); // 8 hex digits and a dash
  // Vault paths use "/" on every OS, so a match against the known path holds on Windows too.
  return target ? posix.join(posix.dirname(path), target) : undefined;
}

function tempName(full: string): string {
  const name = `${TEMP}${randomBytes(4).toString("hex")}-${basename(full)}`;
  // A name too long to carry the note's name just can't be traced after a crash.
  return join(dirname(full), Buffer.byteLength(name) > 255 ? name.slice(0, TEMP.length + 8) : name);
}

/** A temp file in the note's own folder (so the swap stays on one filesystem), written through to disk. */
function temp(full: string, text: string): string {
  mkdirSync(dirname(full), { recursive: true });
  const path = tempName(full);
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}

/** The names kept-aside files get (time, random, note id); any other name (in the folder or in state.db) is never read. */
export const ASIDE_NAME = /^\d+-[0-9a-f]{8}-([0-9A-Z]{26})$/;

/** A folder of its own: not a symlink, not a file. */
function realFolder(dir: string): boolean {
  const stat = lstatSync(dir);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

/** The kept-aside folder, if it is a real folder of its own: never a symlink someone put in its place. */
export function asideFolder(disk: Disk): string | undefined {
  if (!disk.aside) return undefined;
  try {
    // Its parent (.brainiac) too: one swapped for a symlink after startup would lead the files out of the vault.
    const meta = dirname(disk.aside);
    if (!realFolder(meta) || realpathSync(meta) !== join(realpathSync(disk.root), basename(meta)))
      return undefined;
    try {
      mkdirSync(disk.aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return realFolder(disk.aside) ? disk.aside : undefined;
  } catch {
    return undefined;
  }
}

/** A plain file, nothing, or something else (a symlink, a folder) that the daemon never reads or replaces. */
function kind(path: string): "file" | "none" | "other" {
  try {
    return lstatSync(path).isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }
}

/**
 * Moves a displaced file aside (same inode, so late writes still land in it) under a name that says whose it
 * is, so one left by a crash is still traced to its note. Deleted when there's nowhere to keep it.
 */
function keep(disk: Disk, file: string, noteId: string | undefined): string | undefined {
  // The id goes in a file name, so only a real one (state.db, where ids can come from, sits in the vault).
  const folder = noteId !== undefined && isUlid(noteId) ? asideFolder(disk) : undefined;
  if (folder) {
    const name = `${Date.now()}-${randomBytes(4).toString("hex")}-${noteId}`;
    try {
      renameSync(file, join(folder, name));
      return name;
    } catch {}
  }
  // Nowhere to keep it (no folder, another filesystem): it stays beside the note under its temp name, never
  // deleted while an editor may still be writing into it; the next start recovers it like a crash's leftover.
  // A sensitive note's text must not stay on the device that long, so that one goes now.
  if (disk.discardUnkept) rmSync(file, { force: true });
  return undefined;
}

/** Nothing written: the name holds something the daemon doesn't take, and the watcher reports any save. */
const TAKEN: Placed = { disk: undefined, taken: true };

/**
 * Puts `text` at `path` (the file of note `noteId`), where the daemon expects to find `expected` (undefined: no
 * file). Never loses what was there: a different file than expected is returned as `unseen`, and stays on disk
 * unless it was displaced. Never reads or replaces anything but a plain file.
 */
export function place(
  disk: Disk,
  path: string,
  text: string,
  expected: string | undefined,
  noteId?: string,
): Placed {
  const full = join(disk.root, path);
  if (kind(full) === "other") return TAKEN;
  mkdirSync(dirname(full), { recursive: true });
  // Checked again right before writing, so a folder swapped for a symlink since the caller's check is refused.
  // shortcut: a swap in the microseconds left still wins; open folders by handle (openat) if that matters.
  if (!inVault(disk, path)) return TAKEN;
  const staged = temp(full, text);
  disk.step?.("temp", path);
  let kept: string | undefined;
  let retained = false;
  try {
    if (expected === undefined) {
      // A link fails if a file is already there: someone made it meanwhile, and it stays.
      try {
        linkSync(staged, full);
        return { disk: text };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Not a save of this note's file: a file the watcher hasn't reported yet, which it will.
        return kind(full) === "none" ? place(disk, path, text, undefined, noteId) : TAKEN;
      }
    }
    const swap = disk.exchange ?? exchange;
    // A spare temp name for Windows, so a crash mid-swap leaves the displaced file where a start recovers it.
    const outcome = swap(staged, full, tempName(full));
    // Nothing replaced: the new text waits, and any save in the file is the watcher's to report.
    if (outcome === "unsupported") return { disk: readPlainFile(full), waiting: true };
    // Deleted meanwhile: that is the person's change, which the watcher reports; nothing is written back.
    if (outcome === "missing") return { disk: undefined };
    // Replaced by a symlink in the instant before the swap: it goes back, unread.
    if (kind(staged) !== "file") {
      swap(staged, full, tempName(full));
      return TAKEN;
    }
    // From here the temp file holds what the swap displaced: on any error it stays, for the next start.
    retained = true;
    disk.step?.("swapped", path);
    const displaced = readFileSync(staged, "utf8");
    disk.step?.("read", path);
    kept = keep(disk, staged, noteId);
    const aside = kept === undefined ? {} : { aside: kept };
    // Empty: an editor caught between truncating the file and writing it. Its write lands in the kept file,
    // made on what the file held, so that is the version recorded, and nothing is sent yet.
    if (displaced === "") return { disk: text, displaced: expected, ...aside };
    return displaced === expected
      ? { disk: text, displaced, ...aside }
      : { disk: text, displaced, unseen: displaced, ...aside };
  } finally {
    if (!retained) rmSync(staged, { force: true });
  }
}

const readPlainFile = (path: string) => (kind(path) === "file" ? read(path) : undefined);

/**
 * Removes the file of note `noteId`, where the daemon expects `expected`. A save it hadn't seen (the file it
 * moved, or one made at the name since) is the person's change: returned as `unseen`, and left on disk.
 */
export function remove(disk: Disk, path: string, expected: string, noteId?: string): Placed {
  const full = join(disk.root, path);
  const there = kind(full);
  if (there === "none") return { disk: undefined };
  if (there === "other") return TAKEN;
  const moved = tempName(full);
  try {
    renameSync(full, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disk: undefined };
    throw error;
  }
  if (kind(moved) !== "file") {
    renameSync(moved, full); // replaced by a symlink in between: it goes back, unread
    return TAKEN;
  }
  disk.step?.("swapped", path);
  const text = readFileSync(moved, "utf8");
  disk.step?.("read", path);
  // Not the file it meant to delete: it goes back (the moved name was only a second link to it), unless a
  // newer save already took the name. Otherwise the moved file is displaced, and kept aside.
  let back = false;
  if (text !== expected) {
    try {
      linkSync(moved, full);
      back = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let kept: string | undefined;
  if (back) rmSync(moved, { force: true });
  else kept = keep(disk, moved, noteId);
  const found = readPlainFile(full);
  const unseen = found ?? (text === expected ? undefined : text);
  return {
    disk: found,
    displaced: text,
    ...(kept !== undefined && { aside: kept }),
    ...(unseen !== undefined && { unseen }),
  };
}
