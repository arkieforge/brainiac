// Imports (docs/product/onboarding.md): what `brainiac scan` previews and `brainiac import` sends, from files on the
// person's laptop. Pure: the CLI reads the files, and the record proposes the notes (packages/base/src/imports.ts).
// Only formats with a fixed structure become notes here, a LinkedIn export and an OKF vault, and never with a value
// they don't hold. A CV says what it says in prose, so its text goes to the inbox for the person's own Claude to
// file: Brainiac runs no model. Text that prints an ID or account number is never sent; it goes through the site's
// vault instead (contract §5).
import { scan } from "./checks.ts";
import { NoteParseError, parseNote } from "./note.ts";
import { patch, type PatchOp, type YamlValue } from "./patch.ts";

/** A note to propose: its whole markdown, and where it goes. The record gives it an id when it has none. */
export interface Draft {
  readonly raw: string;
  readonly path: string;
  readonly sensitive?: boolean;
}

/** Text for the inbox, for the person's Claude to file. */
export interface InboxText {
  /** What it is, for the preview; never sent. */
  readonly label: string;
  readonly text: string;
  readonly sensitive?: boolean;
}

/** What one source becomes, and what it leaves out and why. */
export interface Plan {
  readonly notes: readonly Draft[];
  readonly inbox: readonly InboxText[];
  readonly left: readonly { readonly what: string; readonly why: string }[];
}

const SECRET = "it prints an ID or account number, so it goes through the site, where it's kept in the vault";

/** Rows of a CSV with a header row, as `{header: cell}`, cells trimmed. Quoted cells may hold commas and newlines. */
export function csvRows(text: string): Record<string, string>[] {
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  const end = () => {
    rows.at(-1)?.push(cell);
    cell = "";
  };
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") end();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      end();
      rows.push([]);
    } else cell += char;
  }
  end();
  const [header = [], ...body] = rows.filter((row) => row.some((c) => c.trim() !== ""));
  return body.map((row) => Object.fromEntries(header.map((name, i) => [name.trim(), (row[i] ?? "").trim()])));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A LinkedIn date as the first day of what it names (a start) or the last (an end): `Jul 2025` is 2025-07-01 or
 * 2025-07-31. A year alone is too coarse to be a date, so it gives none, and the year stays in the note's text.
 */
export function linkedInDate(text: string, end: boolean): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^([a-z]{3})[a-z]*\.? (\d{4})$/i.exec(text);
  const month = MONTHS.indexOf(match?.[1]?.toLowerCase() ?? "");
  if (!match || month < 0) return undefined;
  const year = Number(match[2]);
  const day = end ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate() : 1;
  return `${match[2]}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Split, not trimmed with `-+$`, which runs in quadratic time on a name of many dashes.
const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-")
    .slice(0, 60)
    .replace(/-$/, "");

/** A new note's markdown: `type`, then each field that has a value, in order, then the body. */
function draft(type: string, fields: Readonly<Record<string, YamlValue | undefined>>, body: string) {
  const ops: PatchOp[] = [{ op: "set", path: ["type"], value: type }];
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined && value !== "") ops.push({ op: "set", path: [key], value });
  return patch("", ops) + body;
}

const whole = (text: string) => text === "" || /^\d{4}-\d{2}-\d{2}$/.test(text);

/**
 * The period as LinkedIn wrote it ("LinkedIn says Sep 2025 to now."), whenever it gave less than a whole date, so
 * the person sees what a month widened to a day came from, and a year that became no date isn't lost.
 */
function periodSaid(start: string, end: string): string {
  return whole(start) && whole(end) ? "" : `LinkedIn says ${start || "?"} to ${end || "now"}.\n`;
}

// The files in a LinkedIn export that are about the person, in words a model files: everything else in the
// export (connections, messages, invitations, ads) is about other people or LinkedIn itself, and stays out.
const FILED_BY_CLAUDE: Readonly<Record<string, { readonly sensitive?: boolean }>> = {
  "skills.csv": {},
  "certifications.csv": {},
  "projects.csv": {},
  "publications.csv": {},
  "honors.csv": {},
  "languages.csv": {},
  "courses.csv": {},
  "volunteering.csv": {},
  "test scores.csv": { sensitive: true },
};

/** Whether `files` (name to text, as in the export) look like a LinkedIn export. */
export const isLinkedIn = (files: ReadonlyMap<string, string>): boolean =>
  [...files.keys()].some((name) => /^(positions|education)\.csv$/i.test(baseName(name)));

const baseName = (path: string) => path.split("/").at(-1) ?? path;

/**
 * A LinkedIn data export (its CSVs, by name): each position is a Role and each school an Education, named the way
 * the record names them (`Software Engineering Intern, Acme Robotics`). The files about the person that have no
 * type of their own here (skills, certifications...) go to the inbox as text for the person's Claude.
 */
export function fromLinkedIn(files: ReadonlyMap<string, string>): Plan {
  const notes: Draft[] = [];
  const inbox: InboxText[] = [];
  const left: { what: string; why: string }[] = [];
  let other = 0;
  for (const [path, text] of files) {
    const name = baseName(path).toLowerCase();
    const rows = csvRows(text);
    if (name === "positions.csv") {
      for (const row of rows) {
        const org = row["Company Name"] ?? "";
        const role = row["Title"] ?? "";
        const [started, finished] = [row["Started On"] ?? "", row["Finished On"] ?? ""];
        if (!org || !role) {
          left.push({
            what: `Positions.csv: ${org || role || "a row"}`,
            why: "it has no company or no title",
          });
          continue;
        }
        const start = linkedInDate(started, false);
        const end = linkedInDate(finished, true);
        const title = `${role}, ${org}`;
        const body = periodSaid(started, finished) + (row["Description"] ?? "");
        notes.push({
          path: `facts/roles/${slug(`${title} ${(start ?? started).slice(0, 4)}`)}.md`,
          // An empty "Finished On" is how LinkedIn says the person works there now.
          raw: draft("Role", { title, org, start, end, current: finished === "" || undefined }, body),
        });
      }
    } else if (name === "education.csv") {
      for (const row of rows) {
        const institution = row["School Name"] ?? "";
        const degree = row["Degree Name"] ?? "";
        if (!institution) {
          left.push({ what: "Education.csv: a row", why: "it has no school" });
          continue;
        }
        const [started, finished] = [row["Start Date"] ?? "", row["End Date"] ?? ""];
        const start = linkedInDate(started, false);
        const end = linkedInDate(finished, true);
        const title = degree ? `${degree}, ${institution}` : institution;
        const notesText = [row["Notes"], row["Activities"]].filter(Boolean).join("\n\n");
        notes.push({
          path: `facts/education/${slug(title)}.md`,
          raw: draft(
            "Education",
            { title, institution, degree, start, end },
            periodSaid(started, finished) + notesText,
          ),
        });
      }
    } else if (Object.hasOwn(FILED_BY_CLAUDE, name) && rows.length > 0) {
      const lines = rows.map(
        (row) =>
          `- ${Object.entries(row)
            .filter(([, value]) => value !== "")
            .map(([key, value]) => `${key}: ${value}`)
            .join("; ")}`,
      );
      const said = `From the person's LinkedIn export (${baseName(path)}), sent by brainiac import.\n\n${lines.join("\n")}\n`;
      const what = `${baseName(path)}, ${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
      if (scan(said).length > 0) left.push({ what, why: SECRET });
      else inbox.push({ label: what, text: said, ...FILED_BY_CLAUDE[name] });
    } else other++;
  }
  if (other > 0)
    left.push({
      what: `${other} other ${other === 1 ? "file" : "files"}`,
      why: "about other people or LinkedIn itself, not your record",
    });
  return { notes, inbox, left };
}

/** Areas whose notes hold ID or account numbers, which only the site's vault keeps: never sent as note text. */
const VAULT_AREAS = ["identity/", "finance/"];
/** Areas whose notes are sensitive (docs/internals/record-format.md, "Structure that grows"). */
const SENSITIVE_AREAS = ["facts/tests/", "history/", "health/", "people/"];

const inArea = (path: string, areas: readonly string[]) =>
  areas.some((area) => path.toLowerCase().startsWith(area));

/**
 * An OKF vault's files (bundle-relative path to text; `undefined` for a file that isn't text): each note with a
 * `type` is imported as it is, byte for byte but for a `verified` mark, at its own path, and the record checks its
 * type. Nothing on disk changes. Files that aren't notes stay on disk: uploads go through the site.
 */
export function fromVault(files: ReadonlyMap<string, string | undefined>): Plan {
  const notes: Draft[] = [];
  const left: { what: string; why: string }[] = [];
  let attachments = 0;
  for (const [path, raw] of files) {
    if (path === "okf-base.yaml") continue; // the record keeps its own types; each note is checked against them
    if (raw === undefined || !path.toLowerCase().endsWith(".md")) {
      attachments++;
      continue;
    }
    let data: Readonly<Record<string, unknown>>;
    try {
      data = parseNote(raw).data;
    } catch (error) {
      if (!(error instanceof NoteParseError)) throw error;
      left.push({ what: path, why: "its front-matter isn't valid YAML" });
      continue;
    }
    const type = data["type"];
    if (typeof type !== "string" || type === "") {
      left.push({ what: path, why: "it has no type" });
      continue;
    }
    if (inArea(path, VAULT_AREAS) || scan(raw).length > 0) {
      left.push({ what: path, why: SECRET });
      continue;
    }
    // A `verified` mark from elsewhere isn't the person checking it in Brainiac, so the note arrives unverified.
    const kept = "verified" in data ? patch(raw, [{ op: "unset", path: ["verified"] }]) : raw;
    notes.push({ raw: kept, path, ...(inArea(path, SENSITIVE_AREAS) && { sensitive: true }) });
  }
  if (attachments > 0)
    left.push({
      what: `${attachments} other ${attachments === 1 ? "file" : "files"}`,
      why: "not notes, so left on disk: upload files on the site",
    });
  return { notes, inbox: [], left };
}

/** A CV's text (`label` says what it was), for the person's Claude to file into notes. */
export function fromCv(label: string, text: string): Plan {
  const trimmed = text.trim();
  if (trimmed === "") return { notes: [], inbox: [], left: [{ what: label, why: "it has no text to read" }] };
  if (scan(trimmed).length > 0) return { notes: [], inbox: [], left: [{ what: label, why: SECRET }] };
  return {
    notes: [],
    inbox: [{ label, text: `A CV the person sent with brainiac import.\n\n${trimmed}\n` }],
    left: [],
  };
}
