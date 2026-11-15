// `brainiac hook`: the Claude Code PreToolUse hook the plugin installs (apps/cli/plugin). Agents change the record
// through the MCP tools, where every change is attributed, held and checked, so this refuses file edits and shell
// commands on the vault folder, and file reads of the folders that hold sensitive notes, vault documents and raw
// inbox input. It is advisory (docs/internals/contract.md): other programs can still read and write the folder.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { type } from "arktype";

/** Folders file reads stay out of: the sensitive areas (docs/internals/record-format.md), vault documents, the inbox. */
const PRIVATE = [
  "facts/tests",
  "history",
  "identity",
  "health",
  "finance",
  "people",
  "documents/files",
  "inbox",
];

const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READS = new Set(["Read", "Grep", "Glob"]);

/** The part of Claude Code's PreToolUse input the check reads. */
export const ToolCall = type({ tool_name: "string", tool_input: "Record<string, unknown>", cwd: "string" });
export type ToolCall = typeof ToolCall.infer;

/**
 * `path` as the OS opens it: symlinks followed before any `..` applies, in the case stored on disk (a
 * case-insensitive disk opens `Identity/` as `identity/`), also when it doesn't exist yet (a file Write would make).
 */
function real(path: string): string {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}

/** Whether `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Why Claude Code should refuse this call (the agent reads it), or undefined to let it run. `configured` is
 * the vault folder from the CLI's config.
 */
export function refusal(call: ToolCall, configured: string, home = homedir()): string | undefined {
  const input = call.tool_input;
  const vault = real(configured);
  // Joined without normalizing, so `real` sees `link/..` as the OS does.
  const at = (...parts: string[]) =>
    real(
      parts.reduce((path, part) => {
        const expanded = part.replace(/^~(?=$|[\\/])/, home);
        return isAbsolute(expanded) ? expanded : `${path}${sep}${expanded}`;
      }, call.cwd),
    );
  const tools = "Use the brainiac MCP tools instead (describe, query, get, create, update)";

  const file = text(input["file_path"]) ?? text(input["notebook_path"]);
  if (EDITS.has(call.tool_name) && file !== undefined && within(at(file), vault))
    return `${at(file)} is in the person's Brainiac record, which changes only through Brainiac. ${tools}, so the change is attributed and checked.`;

  if (call.tool_name === "Bash") {
    // Every word read as a path from the working folder. Best effort: a variable or glob can still reach the vault.
    const words = (text(input["command"]) ?? "")
      .replaceAll(/\$\{?HOME\}?(?=$|[\\/\s])/g, home)
      .split(/[\s'"`;|&<>()=]+/)
      .filter((word) => word !== "");
    if ([".", ...words].some((word) => within(at(word), vault)))
      return `This command touches ${vault}, the person's Brainiac record. Don't read or change it from the shell. ${tools}.`;
  }

  if (READS.has(call.tool_name)) {
    // A Glob pattern's folders before its first wildcard are where it looks: `identity/*.md` reads identity/.
    const parts = call.tool_name === "Glob" ? (text(input["pattern"])?.split("/") ?? []) : [];
    const wild = parts.findIndex((part) => /[*?[{]/.test(part));
    const fixed = (wild < 0 ? parts : parts.slice(0, wild)).join("/") || "."; // absolute stays absolute
    const target = at(text(input["file_path"]) ?? text(input["path"]) ?? ".", fixed);
    // Either way round: a search over the vault root reaches every private folder in it.
    const blocked = PRIVATE.map((folder) => join(vault, folder)).find(
      (folder) => within(target, folder) || within(folder, target),
    );
    if (blocked)
      return `${blocked} holds sensitive notes, vault documents or raw inbox input, so it isn't read from disk. ${tools}, which apply this connection's permissions.`;
  }
  return undefined;
}
