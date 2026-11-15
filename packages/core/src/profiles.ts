// Drift checks (docs/product/features/projects-profiles-links.md): a Profile note names one of the person's own
// public profiles (LinkedIn, X, Google Scholar) and keeps what it should say; the profiles connector fills its
// `synced:` block with what the site showed. These detectors compare the two, so the site, the record's tools and a
// laptop copy show the same drift: the exact field, what the site says, and the record's text to paste there.
// Nothing here guesses: a site that couldn't be read is unchecked, and a profile not shown to be the person's is
// never compared.
import type { Check, ReviewNote } from "./review.ts";

export const SITES = { linkedin: "LinkedIn", x: "X", scholar: "Google Scholar" } as const;
export type Site = keyof typeof SITES;

/** The fields a Profile note keeps that LinkedIn or X show, compared one by one. */
export const PROFILE_FIELDS = ["name", "headline", "about", "location"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** What each site's read brings back: X has no headline or location to compare. */
const SITE_FIELDS: Readonly<Record<Exclude<Site, "scholar">, readonly ProfileField[]>> = {
  linkedin: PROFILE_FIELDS,
  x: ["name", "about"],
};

/**
 * What the person puts anywhere in their LinkedIn or X bio to show the profile is theirs. Tied to the note, so
 * nobody can make someone else's profile count in their own record: its owner would have to post the code.
 */
export const ownershipCode = (noteId: string) => `brainiac-${noteId.slice(-8).toLowerCase()}`;

/** What Google Scholar showed for one paper's title: the year it lists, listed without a year, or not found. */
export type ScholarSays = number | "listed" | "missing" | "unchecked";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
export const isSite = (value: unknown): value is Site =>
  typeof value === "string" && Object.hasOwn(SITES, value);

/** Text as a profile shows it: the ownership code taken out, spacing collapsed. */
const plain = (text: string, code: string) => text.replaceAll(code, "").replaceAll(/\s+/g, " ").trim();
const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);
/** A title as two listings of one paper agree on it: letters and digits only. */
export const titleKey = (title: string) => title.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");

/**
 * Which title a paper was searched for, kept on the Profile instead of the title itself: a paper made sensitive
 * later must not leave its title readable on a note that isn't. FNV-1a over the title's key.
 */
export function titleHash(title: string): string {
  let hash = 0x811c9dc5;
  for (const char of titleKey(title)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The title Google Scholar is searched for: the person's own, else the one the paper's registry gave. */
export function paperTitle(data: Readonly<Record<string, unknown>>): string | undefined {
  const synced = data["synced"];
  return str(data["title"]) ?? (isRecord(synced) ? str(synced["title"]) : undefined);
}

/** Where the record keeps a paper's year, and the year: the registry's date first, then the person's. */
function yearOf(data: Readonly<Record<string, unknown>>): { field: string; year: number } | undefined {
  const synced = data["synced"];
  const candidates: [string, unknown][] = [
    ["synced.published", isRecord(synced) ? synced["published"] : undefined],
    ["published", data["published"]],
    ["year", data["year"]],
    ["date", data["date"]],
  ];
  for (const [field, value] of candidates) {
    const year = /^(\d{4})(?:-|$)/.exec(typeof value === "number" ? String(value) : (str(value) ?? ""))?.[1];
    if (year) return { field, year: Number(year) };
  }
  return undefined;
}

/** A paper as Google Scholar's "add an article" asks for it, from stored values only. */
function citation(data: Readonly<Record<string, unknown>>, title: string): string {
  const synced = isRecord(data["synced"]) ? data["synced"] : {};
  const authors = Array.isArray(synced["authors"])
    ? synced["authors"].filter((a) => typeof a === "string")
    : [];
  const venue = str(synced["venue"]);
  const year = yearOf(data)?.year;
  return [authors.join(", "), title, [venue, year].filter((part) => part !== undefined).join(", ")]
    .filter((part) => part !== "")
    .map((part) => (/[.?!]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

/** Every drift check: Profile notes against what their site showed, and papers against Google Scholar. */
export function driftChecks(notes: readonly ReviewNote[]): Check[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const checks: Check[] = [];
  for (const note of notes) {
    const { data } = note;
    const site = data["site"];
    const synced = data["synced"];
    // A block filled for another link says nothing about this one: it is checked again on its own.
    if (data["type"] !== "Profile" || !isSite(site) || !isRecord(synced) || synced["url"] !== data["url"])
      continue;
    const label = SITES[site];
    const unchecked = str(synced["unchecked"]);
    if (unchecked !== undefined) {
      checks.push({
        noteId: note.id,
        detector: "unchecked",
        evidence: `${label} couldn't be checked: ${unchecked}`,
        related: [],
      });
      continue;
    }
    if (site === "scholar") {
      checks.push(...scholar(note, synced, byId));
      continue;
    }
    const code = ownershipCode(note.id);
    if (synced["owned"] !== true) {
      checks.push({
        noteId: note.id,
        detector: "unchecked",
        evidence: `Not shown to be yours yet: add ${code} to your ${label} ${site === "x" ? "bio" : "about"}, then check again`,
        related: [],
        paste: code,
      });
      continue;
    }
    const says = isRecord(synced["says"]) ? synced["says"] : {};
    for (const field of SITE_FIELDS[site]) {
      const ours = str(data[field]);
      if (ours === undefined) continue;
      const theirs = str(says[field]);
      const shown = theirs === undefined ? "" : plain(theirs, code);
      if (shown === plain(ours, code)) continue;
      checks.push({
        noteId: note.id,
        detector: "drift",
        field,
        evidence: shown === "" ? `${label} shows no ${field}` : `${label} says "${clip(shown)}"`,
        related: [],
        paste: ours.trim(),
      });
    }
  }
  return checks;
}

/** Each paper Google Scholar was searched for, against the paper as the record has it now. */
function scholar(
  profile: ReviewNote,
  synced: Readonly<Record<string, unknown>>,
  byId: ReadonlyMap<string, ReviewNote>,
): Check[] {
  const papers = isRecord(synced["papers"]) ? synced["papers"] : {};
  return Object.entries(papers).flatMap(([id, found]): Check[] => {
    const paper = byId.get(id);
    const title = paper && paperTitle(paper.data);
    // A paper retitled since the search was a different search: its answer isn't this paper's.
    if (paper?.data["type"] !== "Paper" || title === undefined || !isRecord(found)) return [];
    if (found["for"] !== titleHash(title)) return [];
    const says = found["says"];
    const related = [profile.id];
    if (says === "unchecked")
      return [
        { noteId: id, detector: "unchecked", evidence: "Google Scholar couldn't be checked for it", related },
      ];
    if (says === "missing")
      return [
        {
          noteId: id,
          detector: "drift",
          evidence: "Google Scholar has no paper with this title",
          related,
          paste: citation(paper.data, title),
        },
      ];
    const ours = yearOf(paper.data);
    if (typeof says !== "number" || ours === undefined || ours.year === says) return [];
    return [
      {
        noteId: id,
        detector: "drift",
        field: ours.field,
        evidence: `Google Scholar says ${says}; the record says ${ours.year}`,
        related,
        paste: String(ours.year),
      },
    ];
  });
}
