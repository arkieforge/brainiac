// What the daemon refuses to take from disk: files that aren't notes, other sync tools' conflict copies,
// and changes too big to be what the person meant.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Conflict copies other sync tools leave next to a note; never synced, so they can't spread as notes. */
const CONFLICT_COPY = [
  / \(conflicted copy[^)]*\)\.md$/i, // Dropbox, Obsidian Sync
  /\.sync-conflict-[^/]*\.md$/i, // Syncthing
];

/** Whether a path inside the vault is a note the daemon syncs. */
export function isNote(path: string, inICloud = false): boolean {
  if (!path.endsWith(".md")) return false;
  // .brainiac, .obsidian, .git, .trash, the daemon's own temp files and every other hidden folder or file.
  if (path.split(/[\\/]/).some((part) => part.startsWith("."))) return false;
  if (CONFLICT_COPY.some((pattern) => pattern.test(path))) return false;
  // iCloud's conflict copy adds " 2" to the name; only inside iCloud, where a real note rarely ends so.
  return !(inICloud && / \d+\.md$/.test(path));
}

/** Other tools syncing the same folder, with what to do about each. */
export function otherSyncTools(root: string): string[] {
  const vault = resolve(root);
  const found: string[] = [];
  if (/\/(GoogleDrive-[^/]+|Google Drive|My Drive)\//.test(`${vault}/`)) {
    found.push(
      'Google Drive syncs this folder; its conflict copies ("name (1).md") sync as notes of their own.',
    );
  }
  if (inICloud(vault))
    found.push('iCloud Drive syncs this folder; its conflict copies ("name 2.md") are ignored.');
  for (let dir = vault; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".dropbox")) || existsSync(join(dir, ".dropbox.cache"))) {
      found.push("Dropbox syncs this folder; its conflicted copies are ignored.");
      break;
    }
    if (dirname(dir) === dir) break;
  }
  try {
    const plugins: unknown = JSON.parse(readFileSync(join(vault, ".obsidian", "core-plugins.json"), "utf8"));
    const enabled = Array.isArray(plugins)
      ? plugins.includes("sync")
      : typeof plugins === "object" &&
        plugins !== null &&
        (plugins as Record<string, unknown>)["sync"] === true;
    if (enabled)
      found.push("Obsidian Sync is on for this vault; turn it off, Brainiac already syncs every device.");
  } catch {}
  return found;
}

export const inICloud = (root: string) =>
  resolve(root).startsWith(join(homedir(), "Library", "Mobile Documents") + sep);

/**
 * More than 50 notes, or more than 10% of the record, changing on disk at once: a bad checkout or a script
 * gone wrong, not an edit. The 10% counts only from 5 notes, so saving a few notes together in a small record
 * never pauses it. (A deleted vault folder pauses on its own.)
 */
export const isMassChange = (changed: number, total: number) =>
  changed > 50 || (changed >= 5 && changed * 10 > total);
