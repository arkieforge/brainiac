// Questions (docs/product/features/questions.md): the gaps in a record, found before an application finds them,
// each as one short question with the smallest input that fits. Pure over parsed notes, like review.ts, so the
// site, the record's tools and a laptop copy find the same ones. An answer is an ordinary edit to the note it's
// about, so it spreads like any edit, and the question is gone everywhere once the gap is: nothing stores
// whether a found question is open.
import { deepEqual, type PatchOp, type YamlValue } from "./patch.ts";
import { resolver, show, usedBy, type ReviewNote } from "./review.ts";
import { BUILT_IN_TYPES, type Manifest } from "./schema.ts";

/** A note as questions read it: its front-matter, and whether it's sensitive. */
export interface QuestionNote extends ReviewNote {
  readonly class?: "normal" | "sensitive";
}

/** The smallest input that fits the answer: the field's own kind, or one of its values. */
export type Input =
  | { readonly kind: "date" | "number" | "text" | "boolean" }
  | { readonly kind: "choice"; readonly values: readonly string[] };

export interface Question {
  /** Stable while the gap lasts: `<note id>.<field>` for a found one, the Question note's id for an asked one. */
  readonly id: string;
  /** `found` from the record's schema, `asked` by an agent with `request_info`. */
  readonly kind: "found" | "asked";
  /** The note the answer goes to: the one it's about, or the Question note itself when it's about none. */
  readonly noteId: string;
  /** For an asked question, the note it's about, if it names one. */
  readonly about?: string;
  readonly field?: string;
  readonly text: string;
  /** Why it's asked: `For TUM MSc Informatics, due 2027-05-31`. */
  readonly why: string;
  readonly input: Input;
  /** "Still there": an end date the item doesn't have yet. */
  readonly ongoing?: boolean;
  /** For an asked question about a field: the value it holds now, as it did when asked. */
  readonly current?: YamlValue;
  /** A value the person can take with one tap; never applied without it. */
  readonly suggested?: YamlValue;
  /** The soonest deadline of an open application that relies on the note. */
  readonly deadline?: string;
  readonly sensitive: boolean;
  /** Asked by background filing: its words came from an inbox item nobody checked, so they're shown as untrusted. */
  readonly filer?: true;
}

/** What the person answered: a value, "still there", or "not applicable". */
export type Reply =
  | { readonly value: YamlValue }
  | { readonly ongoing: true }
  | { readonly notApplicable: true };

/** One note's part of an answer. */
export interface Edit {
  readonly noteId: string;
  readonly ops: readonly PatchOp[];
}

/** How many questions Brainiac puts in front of the person at once, unless one is due within `SOON_DAYS`. */
export const QUESTION_CAP = 5;
const SOON_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
/** The fields an answer of "not applicable" is remembered in, on the note itself. */
const NOT_APPLICABLE = "not_applicable";

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const empty = (value: unknown) => value === undefined || value === null || value === "";
const words = (field: string) => field.replaceAll("_", " ");
const labelOf = (note: ReviewNote) => str(note.data["title"]) ?? note.path;
/** A field's value; `sections.writing` reaches into a mapping. */
export const valueAt = (data: Readonly<Record<string, unknown>>, field: string): unknown =>
  field
    .split(".")
    .reduce<unknown>(
      (at, key) =>
        typeof at === "object" && at !== null && Object.hasOwn(at, key)
          ? (at as Readonly<Record<string, unknown>>)[key]
          : undefined,
      data,
    );

/** A field's `ask` text with `{field}` filled from the note; a blank part falls back to plain words. */
function fill(template: string, note: ReviewNote, field: string): string {
  let missing = false;
  const text = template.replaceAll(/\{([\w.]+)\}/g, (_, name: string) => {
    const value = name === "title" ? labelOf(note) : note.data[name];
    if (empty(value)) missing = true;
    return show(value);
  });
  return missing ? `What's the ${words(field)} for ${labelOf(note)}?` : text;
}

type Spec = Manifest["types"][string];
type FieldSpec = Spec["fields"][string];

function inputOf(spec: FieldSpec | undefined): Input | undefined {
  if (spec?.values) return { kind: "choice", values: spec.values };
  const kind = spec?.kind ?? "text";
  return kind === "date" || kind === "number" || kind === "text" || kind === "boolean" ? { kind } : undefined;
}

/** An asked field's input: its schema's, or for one inside a mapping (`sections.writing`), its value's kind. */
function askedInput(spec: Spec | undefined, field: string, value: unknown): Input {
  const declared = field.includes(".") ? undefined : inputOf(spec?.fields[field]);
  if (declared) return declared;
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "date" };
  return { kind: "text" };
}

const notApplicable = (note: ReviewNote): readonly unknown[] => {
  const value = note.data[NOT_APPLICABLE];
  return Array.isArray(value) ? value : [];
};

/**
 * Every open question on the record: a field its type asks for (`ask`, or `required`) that is empty, and each
 * question an agent asked that nobody answered and whose field hasn't changed since. A note marked
 * `current: true` has no end date to ask for; a field in its `not_applicable` list is never asked again.
 */
export function findQuestions(
  notes: readonly QuestionNote[],
  manifest: Manifest | null,
  now: number,
): Question[] {
  const resolve = resolver(notes);
  const byId = new Map(notes.map((note) => [note.id, note]));
  const superseded = new Set(notes.flatMap((n) => [resolve(n, n.data["supersedes"])?.id ?? []].flat()));
  const used = usedBy(notes, now);
  const types: Manifest["types"] = { ...BUILT_IN_TYPES, ...manifest?.types };
  const specOf = (note: ReviewNote): Spec | undefined => {
    const type = str(note.data["type"]);
    return type !== undefined && Object.hasOwn(types, type) ? types[type] : undefined;
  };
  /** The soonest open application relying on the note, as why it's asked now. */
  const reason = (note: ReviewNote): { why: string; deadline: string; from: QuestionNote } | undefined => {
    const apps = (used.get(note.id) ?? [])
      .flatMap((id) => [byId.get(id) ?? []].flat())
      .flatMap((app) => {
        const deadline = app.data["deadline"];
        return typeof deadline === "string" ? [{ app, deadline: deadline.slice(0, 10) }] : [];
      })
      .toSorted((a, b) => a.deadline.localeCompare(b.deadline));
    const [first] = apps;
    return (
      first && {
        why: `For ${labelOf(first.app)}, due ${first.deadline}`,
        deadline: first.deadline,
        // The why names the application, so it is as private as the application is.
        from: first.app,
      }
    );
  };
  const sensitive = (...from: readonly (QuestionNote | undefined)[]) =>
    from.some((note) => note?.class === "sensitive");

  const asked: Question[] = [];
  const covered = new Set<string>();
  for (const question of notes) {
    if (question.data["type"] !== "Question" || question.data["status"] !== "open") continue;
    const about = resolve(question, question.data["about"]);
    const field = about ? str(question.data["field"]) : undefined;
    // Answered some other way: the field it asks about changed since it was asked.
    if (about && field !== undefined && !sameValue(valueAt(about.data, field), question.data["was"]))
      continue;
    if (about && field !== undefined) covered.add(`${about.id}.${field}`);
    const suggested = question.data["suggested"];
    const why = str(question.data["why"]);
    const context = about && reason(about);
    asked.push({
      id: question.id,
      kind: "asked",
      noteId: about && field !== undefined ? about.id : question.id,
      ...(about && { about: about.id }),
      ...(field !== undefined && { field }),
      text: labelOf(question),
      why: why || context?.why || "Your agent asked",
      input:
        about && field !== undefined
          ? askedInput(specOf(about), field, valueAt(about.data, field) ?? suggested)
          : { kind: "text" },
      ...(!empty(question.data["was"]) && { current: question.data["was"] as YamlValue }),
      ...(!empty(suggested) && { suggested: suggested as YamlValue }),
      ...(context && { deadline: context.deadline }),
      sensitive: sensitive(question, about, why ? undefined : context?.from),
      ...(question.data["from"] === "filer" && { filer: true }),
    });
  }

  const found: Question[] = [];
  for (const note of notes) {
    const type = str(note.data["type"]);
    const spec = specOf(note);
    if (!spec || type === "Question" || type === "InboxItem" || superseded.has(note.id)) continue;
    const skipped = notApplicable(note);
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      if (!(fieldSpec.ask ?? fieldSpec.required) || !empty(note.data[field])) continue;
      if (skipped.includes(field) || covered.has(`${note.id}.${field}`)) continue;
      const input = inputOf(fieldSpec);
      if (!input) continue;
      const ongoing = field === "end" && Object.hasOwn(spec.fields, "current");
      if (ongoing && note.data["current"] === true) continue;
      const context = reason(note);
      found.push({
        id: `${note.id}.${field}`,
        kind: "found",
        noteId: note.id,
        field,
        text: fieldSpec.ask
          ? fill(fieldSpec.ask, note, field)
          : `What's the ${words(field)} for ${labelOf(note)}?`,
        why: context?.why ?? `Your ${type} has no ${words(field)} yet`,
        input,
        ...(ongoing && { ongoing }),
        ...(context && { deadline: context.deadline }),
        sensitive: sensitive(note, context?.from),
      });
    }
  }
  return rank([...asked, ...found]);
}

/** Exactly equal, absent and empty as one: a field empty when asked and still empty hasn't changed, a new case has. */
export const sameValue = (a: unknown, b: unknown) =>
  empty(a) || empty(b) ? empty(a) && empty(b) : deepEqual(a, b);

/** Soonest deadline first, then what an agent asked, then in the record's order. */
function rank(questions: readonly Question[]): Question[] {
  return questions
    .map((question, i) => ({ question, i }))
    .toSorted(
      (a, b) =>
        (a.question.deadline ?? "9999").localeCompare(b.question.deadline ?? "9999") ||
        (a.question.kind === "asked" ? 0 : 1) - (b.question.kind === "asked" ? 0 : 1) ||
        a.i - b.i,
    )
    .map(({ question }) => question);
}

/**
 * What Brainiac asks now: the first `cap` of the ranked questions, and every one due within a week beyond it.
 * The rest wait until these are answered, or until the person asks to see them all.
 */
export function askNow<T extends Pick<Question, "deadline">>(
  questions: readonly T[],
  now: number,
  cap = QUESTION_CAP,
): T[] {
  const soon = new Date(now + SOON_DAYS * DAY_MS).toISOString().slice(0, 10);
  return questions.filter((q, i) => i < cap || (q.deadline !== undefined && q.deadline <= soon));
}

/**
 * The edits an answer makes: the value goes to the field it's about, "still there" sets `current`, and "not
 * applicable" is remembered on the note. An asked question about a field closes itself once the field changes, so
 * a refused edit leaves it open; only a reply that keeps the value it holds closes it outright. One about nothing
 * records the answer on itself.
 */
export function answerEdits(question: Question, reply: Reply): Edit[] {
  const close = (status: "answered" | "not-applicable", answer?: YamlValue): Edit => ({
    noteId: question.id,
    ops: [
      { op: "set", path: ["status"], value: status },
      ...(answer === undefined ? [] : [{ op: "set", path: ["answer"], value: answer } as const]),
    ],
  });
  if ("notApplicable" in reply) {
    if (question.kind === "asked") return [close("not-applicable")];
    if (question.field === undefined) return [];
    return [
      { noteId: question.noteId, ops: [{ op: "append", path: [NOT_APPLICABLE], value: question.field }] },
    ];
  }
  if ("ongoing" in reply) {
    if (!question.ongoing) return [];
    return [{ noteId: question.noteId, ops: [{ op: "set", path: ["current"], value: true }] }];
  }
  if (question.field === undefined) return [close("answered", reply.value)];
  if (question.kind === "asked" && question.current !== undefined && deepEqual(question.current, reply.value))
    return [close("answered", reply.value)];
  return [
    { noteId: question.noteId, ops: [{ op: "set", path: question.field.split("."), value: reply.value }] },
  ];
}

/** A question as one line of an email or a list: what it asks and why. Never for a sensitive one in an email. */
export const questionLine = (question: Question) => `${question.text} (${question.why})`;
