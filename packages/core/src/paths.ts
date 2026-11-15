// Note paths are relative to the record root, with `/` separators, on every platform.

export class PathError extends Error {
  override readonly name = "PathError";
}

/**
 * The canonical form of a record path: Unicode NFC, so `Résumé.md` typed on macOS (NFD) and on Windows (NFC)
 * is one name. Refuses absolute paths, backslashes, and `.` or `..` segments, which could step outside the record.
 */
export function normalizePath(path: string): string {
  const nfc = path.normalize("NFC");
  if (nfc.startsWith("/") || nfc.includes("\\")) throw new PathError(`Not a record path: ${path}`);
  const segments = nfc.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new PathError(`Not a record path: ${path}`);
  }
  return nfc;
}

/** Two paths clash when they differ only by case or Unicode form: one of them would overwrite the other on macOS and Windows. */
export const pathKey = (path: string): string => normalizePath(path).toLowerCase();

/** The existing path that `candidate` clashes with, if any (an exact match is a clash too). */
export function findClash(existing: Iterable<string>, candidate: string): string | undefined {
  const key = pathKey(candidate);
  for (const path of existing) if (pathKey(path) === key) return path;
  return undefined;
}

/** Whether a front-matter relation is a relative path to a note (`../people/dr-okafor.md`). */
export function isRelationPath(value: string): boolean {
  return value.endsWith(".md") && !value.startsWith("/") && !value.includes("\\") && !value.includes("://");
}

/**
 * The record path a relation in the note at `from` points to. Relations are written relative to the note,
 * like Obsidian links; one that climbs above the record root is refused.
 */
export function resolveRelation(from: string, relation: string): string {
  if (!isRelationPath(relation)) throw new PathError(`Not a relation: ${relation}`);
  return resolveFrom(from, relation);
}

/**
 * The record path of the file a sidecar note names (`file: files/transcript-bsc.pdf` in `documents/`), resolved
 * relative to the note like a relation. The cloud finds the stored file by this path and a laptop copy writes it
 * there, so both name the same file.
 */
export function resolveFile(from: string, file: string): string {
  if (file.startsWith("/") || file.includes("\\") || file.includes("://"))
    throw new PathError(`Not a file path: ${file}`);
  return resolveFrom(from, file);
}

function resolveFrom(from: string, relative: string): string {
  const parts = normalizePath(from).split("/").slice(0, -1);
  for (const segment of relative.normalize("NFC").split("/")) {
    if (segment === "..") {
      if (parts.pop() === undefined) throw new PathError(`${relative} from ${from} leaves the record.`);
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }
  return normalizePath(parts.join("/"));
}

/** The relation to write in the note at `from` so it points to `to`; the inverse of {@link resolveRelation}. */
export function relationTo(from: string, to: string): string {
  const fromDir = normalizePath(from).split("/").slice(0, -1);
  const target = normalizePath(to).split("/");
  let shared = 0;
  while (shared < fromDir.length && shared < target.length - 1 && fromDir[shared] === target[shared])
    shared++;
  return [...Array.from({ length: fromDir.length - shared }, () => ".."), ...target.slice(shared)].join("/");
}
