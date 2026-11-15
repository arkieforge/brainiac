// `brainiac scan` and `brainiac import` (docs/product/onboarding.md): read a LinkedIn export, an OKF vault or a CV on
// this laptop, show what each becomes without sending anything, then send it to the record, which files every note
// as a proposal for the person (packages/base/src/imports.ts). What each file becomes is packages/core's.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

import { fromCv, fromLinkedIn, fromVault, isLinkedIn, parseNote, type Plan } from "@brainiac/core";
import { type } from "arktype";
import JSZip from "jszip";

/** One file or folder the person named, and what it becomes. */
export interface Source {
  readonly path: string;
  /** What it was read as: "a LinkedIn export", "an OKF vault", "a CV". */
  readonly as: string;
  readonly plan: Plan;
}

const WHAT_WE_READ =
  "Brainiac reads a LinkedIn export (its .zip or folder), an OKF vault folder, or a CV (.pdf, .txt or .md).";

/** Every file under `dir` by its path from `dir`, with `/`: no hidden files or folders, and no symlinks. */
function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => !path.split("/").some((part) => part.startsWith(".")))
    .filter((path) => lstatSync(join(dir, path)).isFile());
}

const TEXT = new Set([".md", ".csv", ".yaml", ".yml", ".txt"]);

/**
 * pdf.js, loaded the first time a PDF is read. Its worker runs in this process, imported here so the compiled binary
 * carries it. Loading, it warns that it can't polyfill the canvas APIs only rendering uses; text needs none.
 */
async function pdfjs() {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const [pdf, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      // @ts-expect-error pdf.js ships its worker without types; it is only handed back to pdf.js.
      import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ]);
    Object.assign(globalThis, { pdfjsWorker: worker });
    return pdf;
  } finally {
    console.warn = warn;
  }
}

/** A PDF's text, page by page. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: bytes, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      pages.push(items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join(""));
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

/**
 * Reads what `path` names, on this laptop only. `synced` is the folder the daemon syncs, which is the record
 * already and is refused. Throws with what Brainiac can read when it is none of them.
 */
export async function readSource(path: string, synced?: string): Promise<Source> {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    const real = realpathSync(path);
    // Another drive on Windows is an absolute path from here, not a `..` one.
    const fromSynced =
      synced !== undefined && existsSync(synced) ? relative(realpathSync(synced), real) : "..";
    if (!fromSynced.startsWith("..") && !isAbsolute(fromSynced))
      throw new Error(
        `${path} is the folder this computer syncs with your record: it's in your record already.`,
      );
    const files = walk(real);
    const text = (file: string) =>
      TEXT.has(extname(file).toLowerCase()) ? readFileSync(join(real, file), "utf8") : undefined;
    const csvs = new Map(
      files.filter((file) => file.toLowerCase().endsWith(".csv")).map((file) => [file, text(file) ?? ""]),
    );
    if (isLinkedIn(csvs)) return { path, as: "a LinkedIn export", plan: fromLinkedIn(csvs) };
    if (!files.some((file) => file.toLowerCase().endsWith(".md")))
      throw new Error(`${path} has no notes. ${WHAT_WE_READ}`);
    return { path, as: "an OKF vault", plan: fromVault(new Map(files.map((file) => [file, text(file)]))) };
  }
  if (!stat.isFile()) throw new Error(`${path} isn't a file or a folder. ${WHAT_WE_READ}`);
  const ext = extname(path).toLowerCase();
  const name = basename(path);
  if (ext === ".zip") {
    const zip = await JSZip.loadAsync(readFileSync(path));
    const csvs = new Map<string, string>();
    for (const entry of Object.values(zip.files))
      if (!entry.dir && entry.name.toLowerCase().endsWith(".csv"))
        csvs.set(entry.name, await entry.async("string"));
    if (!isLinkedIn(csvs)) throw new Error(`${path} isn't a LinkedIn export. ${WHAT_WE_READ}`);
    return { path, as: "a LinkedIn export", plan: fromLinkedIn(csvs) };
  }
  if (ext === ".pdf")
    return { path, as: "a CV", plan: fromCv(name, await pdfText(new Uint8Array(readFileSync(path)))) };
  if (ext === ".txt" || ext === ".md")
    return { path, as: "a CV", plan: fromCv(name, readFileSync(path, "utf8")) };
  throw new Error(`${path}: ${WHAT_WE_READ}`);
}

const pad = (text: string, width: number) => text.padEnd(width);

/** What `brainiac scan` prints for one source. */
export function scanReport(source: Source): string[] {
  const lines = [`${source.path}: ${source.as}`];
  const rows = source.plan.notes.map((note) => {
    const data = parseNote(note.raw).data;
    const title = typeof data["title"] === "string" ? data["title"] : "";
    return [String(data["type"]), title, note.path, note.sensitive ? " (sensitive)" : ""] as const;
  });
  const typeWidth = Math.max(9, ...rows.map(([kind]) => kind.length));
  const titleWidth = Math.max(0, ...rows.map(([, title]) => title.length));
  for (const [kind, title, path, sensitive] of rows)
    lines.push(`  ${pad(kind, typeWidth)}  ${pad(title, titleWidth)}  ${path}${sensitive}`);
  for (const item of source.plan.inbox)
    lines.push(
      `  ${pad("inbox", typeWidth)}  ${item.label}, for your Claude to file${item.sensitive ? " (sensitive)" : ""}`,
    );
  for (const left of source.plan.left)
    lines.push(`  ${pad("left out", typeWidth)}  ${left.what}: ${left.why}`);
  if (rows.length + source.plan.inbox.length + source.plan.left.length === 0)
    lines.push("  nothing to import");
  return lines;
}

/** One `import` answer, as the record's tool gives it. */
const Answer = type({
  results: type({
    status: "string",
    "path?": "string",
    "of?": "string",
    "message?": "string",
    "issues?": type({ field: "string", message: "string" }).array(),
  }).array(),
});
type Result = (typeof Answer.infer)["results"][number];

/** The most notes, and inbox texts, one call sends: as many as the tool takes at once. */
const NOTES_PER_CALL = 100;
const TEXTS_PER_CALL = 20;

const Refusal = type({ status: "string", message: "string" });

/**
 * Sends every source's notes and inbox text through the record's `import` tool (`call`: `callRecord` with this
 * device's token), a page at a time, and says what happened. Nothing is sent when there's nothing to send.
 */
export async function importSources(
  sources: readonly Source[],
  call: (args: unknown) => Promise<unknown>,
): Promise<{ readonly lines: string[]; readonly failed: boolean }> {
  const notes = sources.flatMap((source) => source.plan.notes);
  const inbox = sources
    .flatMap((source) => source.plan.inbox)
    .map(({ text, sensitive }) => ({ text, ...(sensitive && { sensitive }) }));
  const pages = Math.max(Math.ceil(notes.length / NOTES_PER_CALL), Math.ceil(inbox.length / TEXTS_PER_CALL));
  const results: Result[] = [];
  for (let page = 0; page < pages; page++) {
    const raw = await call({
      notes: notes.slice(page * NOTES_PER_CALL, (page + 1) * NOTES_PER_CALL),
      inbox: inbox.slice(page * TEXTS_PER_CALL, (page + 1) * TEXTS_PER_CALL),
    });
    const answer = Answer(raw);
    if (answer instanceof type.errors) {
      // A refusal of the whole call (a read-level connection) answers a status instead of results.
      const why = Refusal(raw);
      throw new Error(
        why instanceof type.errors ? "Brainiac's answer had no results. Try again." : why.message,
      );
    }
    results.push(...answer.results);
  }
  const of = (status: string) => results.filter((result) => result.status === status);
  const proposed = of("proposed");
  const added = of("applied");
  const duplicate = of("duplicate");
  const other = results.filter((result) => !["proposed", "applied", "duplicate"].includes(result.status));
  const lines: string[] = [];
  if (proposed.length > 0)
    lines.push(`Proposed ${count(proposed.length, "note")}: each waits for you to accept or reject it.`);
  if (added.length > 0)
    lines.push(
      `Added ${count(added.length, "inbox item")}: say "file my inbox" to your Claude, or run brainiac filing now.`,
    );
  if (duplicate.length > 0) {
    lines.push(`Already in your record: ${count(duplicate.length, "item")}.`);
    for (const twin of duplicate)
      lines.push(
        `  ${twin.path === undefined ? `inbox text, as ${twin.of}` : twin.path === twin.of ? twin.path : `${twin.path}, as ${twin.of}`}`,
      );
  }
  if (other.length > 0) {
    lines.push(`Not imported: ${count(other.length, "note")}.`);
    for (const result of other)
      lines.push(
        `  ${result.path ?? "a note"}: ${result.issues?.map((issue) => issue.message).join(" ") ?? result.message ?? result.status}`,
      );
  }
  if (results.length === 0) lines.push("Nothing to import.");
  return { lines, failed: other.length > 0 };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
