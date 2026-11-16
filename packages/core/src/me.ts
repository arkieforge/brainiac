import { headline, resolver, type ReviewNote } from "./review.ts";
import { BUILT_IN_TYPES, type Manifest } from "./schema.ts";

/** The most items `aboutYou` lists for one type, newest first. */
const PER_TYPE = 10;

/** When an item happened, for newest first: its end, else its date, its start or its deadline. */
const whenOf = (data: Readonly<Record<string, unknown>>) =>
  ["end", "date", "start", "deadline"].map((key) => data[key]).find((v) => typeof v === "string") ?? "";

/**
 * The generated part of me.md: who the person is to whoever reads it, from the notes `notes` holds (the caller's
 * own view, so it never says what they can't see). One section per fact type (a held type) and the applications
 * still open, each item its headline linking to its note, the current item only when one supersedes another.
 * Values come from stored fields through the type's headline, never guessed; empty when there is nothing yet.
 * `notes` lists the ids it shows, for the reader's audit.
 */
export function aboutYou(
  notes: readonly ReviewNote[],
  manifest: Manifest | null,
): { readonly text: string; readonly notes: readonly string[] } {
  const types = { ...BUILT_IN_TYPES, ...manifest?.types };
  const resolve = resolver(notes);
  const superseded = new Set(notes.flatMap((note) => resolve(note, note.data["supersedes"])?.id ?? []));
  const sections: string[] = [];
  const shown: string[] = [];
  for (const [name, spec] of Object.entries(types)) {
    if (!spec.held && name !== "Application") continue;
    const items = notes
      .filter(
        (note) =>
          note.data["type"] === name &&
          !superseded.has(note.id) &&
          (name !== "Application" || note.data["status"] !== "decision"),
      )
      .toSorted((a, b) => (whenOf(a.data) < whenOf(b.data) ? 1 : whenOf(a.data) > whenOf(b.data) ? -1 : 0));
    if (items.length === 0) continue;
    const listed = items.slice(0, PER_TYPE);
    shown.push(...listed.map((note) => note.id));
    const lines = listed.map(
      (note) => `- [${headline(note, manifest).replaceAll(/[[\]]/g, "")}](<${note.path}>)`,
    );
    if (items.length > PER_TYPE) lines.push(`- and ${items.length - PER_TYPE} more`);
    sections.push(`## ${name === "Application" ? "Open applications" : name}\n\n${lines.join("\n")}`);
  }
  return { text: sections.join("\n\n"), notes: shown };
}
