import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { ulid } from "./ids.ts";
import { parseNote } from "./note.ts";
import { patch } from "./patch.ts";
import {
  answerEdits,
  askNow,
  findQuestions,
  type Question,
  type QuestionNote,
  type Reply,
} from "./questions.ts";
import { parseManifest } from "./schema.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/nadia");
const manifest = parseManifest(readFileSync(join(ROOT, "okf-base.yaml"), "utf8"));
const raws = new Map(
  readdirSync(ROOT, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".md"))
    .toSorted()
    .map((path) => [path, readFileSync(join(ROOT, path), "utf8")]),
);
const NOW = Date.UTC(2026, 10, 15);

/** A record as raw notes by path, so answers apply as the record applies them: by patching the text. */
type Record_ = Map<string, { readonly raw: string; readonly class?: "normal" | "sensitive" }>;
const fixture = (): Record_ => new Map([...raws].map(([path, raw]) => [path, { raw }]));
const notesOf = (record: Record_): QuestionNote[] =>
  [...record].map(([path, { raw, class: cls }]) => {
    const { data } = parseNote(raw);
    return { id: String(data["id"]), path, data, ...(cls && { class: cls }) };
  });
const ask = (record: Record_, now = NOW) => findQuestions(notesOf(record), manifest, now);
const ids = (record: Record_) => ask(record).map((q) => q.id);

const PAPER = "facts/papers/swahili-ner-2026.md";
const ROLE = "facts/roles/acme-intern-2025.md";
const BSC = "facts/education/bsc-northvale.md";
const TUM = "applications/tum-msc-informatics-2027/application.md";
const idAt = (record: Record_, path: string) => String(parseNote(record.get(path)?.raw ?? "").data["id"]);

/** Changes a note's front-matter as an edit would. */
function edit(record: Record_, path: string, ops: Parameters<typeof patch>[1]) {
  const note = record.get(path);
  if (!note) throw new Error(path);
  record.set(path, { ...note, raw: patch(note.raw, ops) });
}

/** Applies an answer's edits to the notes they name. */
function answer(record: Record_, question: Question, reply: Reply) {
  const byId = new Map(notesOf(record).map((n) => [n.id, n.path]));
  for (const change of answerEdits(question, reply)) edit(record, byId.get(change.noteId) ?? "", change.ops);
}

const one = (record: Record_, id: string) => {
  const question = ask(record).find((q) => q.id === id);
  if (!question) throw new Error(`no question ${id} in ${ids(record).join(", ")}`);
  return question;
};

/** A Question note an agent asked, as `request_info` writes it. */
function asked(record: Record_, data: Record<string, unknown>, cls?: "sensitive") {
  const id = ulid();
  const path = `questions/${id.toLowerCase()}.md`;
  const raw = patch(
    "",
    Object.entries({ id, type: "Question", status: "open", ...data }).map(([key, value]) => ({
      op: "set" as const,
      path: [key],
      value: value as string,
    })),
  );
  record.set(path, { raw, ...(cls && { class: cls }) });
  return id;
}

describe("found questions", () => {
  it("the fixture record has none: every field its types ask for is filled", () => {
    expect(ask(fixture())).toEqual([]);
  });

  it("an empty field the type asks for becomes one question in the type's words, with its input", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    const role = idAt(record, ROLE);
    expect(ask(record)).toEqual([
      {
        id: `${role}.end`,
        kind: "found",
        noteId: role,
        field: "end",
        text: "When did your role at Acme Robotics end?",
        why: "Your Role has no end yet",
        input: { kind: "date" },
        ongoing: true,
        sensitive: false,
      },
    ]);
  });

  it("says why with the soonest application that relies on the note, and ranks by that deadline", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    // TUM relies on the transcript and the current IELTS; give the transcript's degree a gap too.
    edit(record, BSC, [{ op: "unset", path: ["cgpa"] }]);
    edit(record, TUM, [
      {
        op: "append",
        path: ["requirements"],
        value: { need: "A degree", check: { type: "Education", degree: "BSc Computer Science" } },
      },
    ]);
    const [first, second] = ask(record);
    expect(first).toMatchObject({
      field: "cgpa",
      text: "What is your CGPA for BSc Computer Science?",
      why: "For TUM MSc Informatics, Winter 2027, due 2027-05-31",
      deadline: "2027-05-31",
      input: { kind: "number" },
    });
    expect(second).toMatchObject({ field: "end", why: "Your Role has no end yet" });
    expect(second).not.toHaveProperty("deadline");
  });

  it("a field the connector already knows isn't asked: a paper's position from the linked ORCID iD", () => {
    const record = fixture();
    edit(record, PAPER, [{ op: "unset", path: ["position"] }]);
    expect(ask(record).map((q) => q.text)).toEqual([
      "Which author are you on Named Entity Recognition for Low-Resource Swahili News? 1 is the first.",
    ]);
    edit(record, PAPER, [{ op: "set", path: ["synced"], value: { position: 1 } }]);
    expect(ask(record)).toEqual([]);
  });

  it("falls back to plain words when the type's text names a field that is empty too", () => {
    const record = fixture();
    edit(record, ROLE, [
      { op: "unset", path: ["end"] },
      { op: "unset", path: ["org"] },
    ]);
    const texts = ask(record).map((q) => q.text);
    expect(texts).toContain("What's the end for Software Engineering Intern, Acme Robotics?");
  });

  it("a question whose why names a sensitive application is sensitive", () => {
    const record = fixture();
    edit(record, BSC, [{ op: "unset", path: ["cgpa"] }]);
    edit(record, TUM, [
      {
        op: "append",
        path: ["requirements"],
        value: { need: "A degree", check: { type: "Education", degree: "BSc Computer Science" } },
      },
    ]);
    expect(ask(record).map((q) => [q.why, q.sensitive])).toEqual([
      ["For TUM MSc Informatics, Winter 2027, due 2027-05-31", false],
    ]);
    record.set(TUM, { raw: record.get(TUM)?.raw ?? "", class: "sensitive" });
    expect(ask(record).map((q) => q.sensitive)).toEqual([true]);
  });

  it("a sensitive note's question is sensitive", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    record.set(ROLE, { raw: record.get(ROLE)?.raw ?? "", class: "sensitive" });
    expect(ask(record).map((q) => q.sensitive)).toEqual([true]);
  });

  it("history isn't asked about: a superseded note's gaps are left alone", () => {
    const record = fixture();
    const bsc = record.get(BSC)?.raw ?? "";
    edit(record, BSC, [{ op: "unset", path: ["end"] }]);
    const newer = ulid();
    record.set("facts/education/bsc-northvale-2.md", {
      raw: patch(bsc.replace(/^id: .*$/m, `id: ${newer}`), [
        { op: "set", path: ["supersedes"], value: "bsc-northvale.md" },
      ]),
    });
    expect(ids(record)).toEqual([]);
  });
});

describe("answers", () => {
  it("a value is an edit to the field, and the question is gone", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    const question = one(record, `${idAt(record, ROLE)}.end`);
    expect(answerEdits(question, { value: "2025-09-30" })).toEqual([
      { noteId: idAt(record, ROLE), ops: [{ op: "set", path: ["end"], value: "2025-09-30" }] },
    ]);
    answer(record, question, { value: "2025-09-30" });
    expect(ids(record)).toEqual([]);
    expect(parseNote(record.get(ROLE)?.raw ?? "").data["end"]).toBe("2025-09-30");
  });

  it('"still there" sets current, and an item that is current has no end to ask for', () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    answer(record, one(record, `${idAt(record, ROLE)}.end`), { ongoing: true });
    expect(parseNote(record.get(ROLE)?.raw ?? "").data["current"]).toBe(true);
    expect(ids(record)).toEqual([]);
  });

  it('"not applicable" is remembered on the note and never asked again', () => {
    const record = fixture();
    edit(record, BSC, [
      { op: "unset", path: ["end"] },
      { op: "unset", path: ["cgpa"] },
    ]);
    const bsc = idAt(record, BSC);
    answer(record, one(record, `${bsc}.cgpa`), { notApplicable: true });
    expect(parseNote(record.get(BSC)?.raw ?? "").data["not_applicable"]).toEqual(["cgpa"]);
    expect(ids(record)).toEqual([`${bsc}.end`]);
  });

  it("a question closes itself when the gap is filled some other way", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    expect(ids(record)).toHaveLength(1);
    edit(record, ROLE, [{ op: "set", path: ["end"], value: "2025-10-01" }]);
    expect(ids(record)).toEqual([]);
  });
});

describe("asked questions", () => {
  it("an agent's question about a field takes the field's input and its suggestion, and comes before found ones", () => {
    const record = fixture();
    edit(record, ROLE, [{ op: "unset", path: ["end"] }]);
    const role = idAt(record, ROLE);
    const id = asked(record, {
      title: "Which day did the Acme internship end?",
      about: `../${ROLE}`,
      field: "end",
      suggested: "2025-09-30",
    });
    // The agent's question covers the found one for the same field.
    expect(ask(record)).toEqual([
      {
        id,
        kind: "asked",
        noteId: role,
        about: role,
        field: "end",
        text: "Which day did the Acme internship end?",
        why: "Your agent asked",
        input: { kind: "date" },
        suggested: "2025-09-30",
        sensitive: false,
      },
    ]);
  });

  it("a new value only sets the field: the change closes it, so a refused edit leaves it open", () => {
    const record = fixture();
    const id = asked(record, {
      title: "Is 3.82 your final CGPA?",
      about: `../${BSC}`,
      field: "cgpa",
      was: 3.82,
    });
    const question = one(record, id);
    expect(question.current).toBe(3.82);
    expect(answerEdits(question, { value: 3.84 })).toEqual([
      { noteId: idAt(record, BSC), ops: [{ op: "set", path: ["cgpa"], value: 3.84 }] },
    ]);
    answer(record, question, { value: 3.84 });
    expect(ids(record)).toEqual([]);
  });

  it("a correction of case is a change: it sets the field, and the change closes the question", () => {
    const record = fixture();
    const id = asked(record, {
      title: "Is the org right?",
      about: `../${ROLE}`,
      field: "org",
      was: "Acme Robotics",
    });
    expect(answerEdits(one(record, id), { value: "ACME Robotics" })).toEqual([
      { noteId: idAt(record, ROLE), ops: [{ op: "set", path: ["org"], value: "ACME Robotics" }] },
    ]);
    answer(record, one(record, id), { value: "ACME Robotics" });
    expect(ids(record)).toEqual([]);
  });

  it("a reply that keeps the value it has records the answer and closes the question", () => {
    const record = fixture();
    const id = asked(record, {
      title: "Is 3.82 your final CGPA?",
      about: `../${BSC}`,
      field: "cgpa",
      was: 3.82,
    });
    expect(answerEdits(one(record, id), { value: 3.82 })).toEqual([
      {
        noteId: id,
        ops: [
          { op: "set", path: ["status"], value: "answered" },
          { op: "set", path: ["answer"], value: 3.82 },
        ],
      },
    ]);
    answer(record, one(record, id), { value: 3.82 });
    expect(ids(record)).toEqual([]);
  });

  it("closes itself once the field changes from what it was when asked", () => {
    const record = fixture();
    const id = asked(record, { title: "Is 3.82 final?", about: `../${BSC}`, field: "cgpa", was: 3.82 });
    expect(ids(record)).toEqual([id]);
    edit(record, BSC, [{ op: "set", path: ["cgpa"], value: 3.84 }]);
    expect(ids(record)).toEqual([]);
  });

  it("one about nothing takes text, and not applicable closes it", () => {
    const record = fixture();
    const id = asked(record, { title: "Does the APS certificate need to be the original?" });
    const question = one(record, id);
    expect(question).toMatchObject({ noteId: id, input: { kind: "text" } });
    expect(question).not.toHaveProperty("field");
    answer(record, question, { notApplicable: true });
    expect(parseNote([...record.values()].at(-1)?.raw ?? "").data["status"]).toBe("not-applicable");
    expect(ids(record)).toEqual([]);
  });

  it("is sensitive when the note it's about is, or when it was asked as sensitive", () => {
    const record = fixture();
    record.set(BSC, { raw: record.get(BSC)?.raw ?? "", class: "sensitive" });
    asked(record, { title: "Is 3.82 final?", about: `../${BSC}`, field: "cgpa", was: 3.82 });
    asked(record, { title: "What is your father's full name?" }, "sensitive");
    asked(record, { title: "Which internship came first?" });
    expect(ask(record).map((q) => [q.text, q.sensitive])).toEqual([
      ["Is 3.82 final?", true],
      ["What is your father's full name?", true],
      ["Which internship came first?", false],
    ]);
  });
});

/** A record with `n` roles, each missing its end date. */
function roles(n: number): Record_ {
  const record = fixture();
  const role = record.get(ROLE)?.raw ?? "";
  for (let i = 0; i < n; i++)
    record.set(`facts/roles/role-${i}.md`, {
      raw: patch(role.replace(/^id: .*$/m, `id: ${ulid()}`), [
        { op: "unset", path: ["end"] },
        { op: "set", path: ["org"], value: `Org ${i}` },
      ]),
    });
  return record;
}

describe("not a nag", () => {
  it("asks at most 5 at once", () => {
    const all = ask(roles(8));
    expect(all).toHaveLength(8);
    expect(askNow(all, NOW).map((q) => q.text)).toEqual(all.slice(0, 5).map((q) => q.text));
  });

  it("anything due within a week is asked beyond the cap", () => {
    const record = roles(6);
    // TUM is due in 5 days and relies on every role.
    edit(record, TUM, [
      { op: "set", path: ["deadline"], value: "2026-11-20" },
      { op: "append", path: ["requirements"], value: { need: "Experience", check: { type: "Role" } } },
    ]);
    expect(askNow(ask(record), NOW)).toHaveLength(6);
    // Eight days out, the cap holds.
    expect(askNow(ask(record), NOW - 3 * 24 * 60 * 60_000)).toHaveLength(5);
  });
});
