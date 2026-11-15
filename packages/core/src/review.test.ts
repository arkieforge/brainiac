import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { ulid } from "./ids.ts";
import { parseNote } from "./note.ts";
import { patch } from "./patch.ts";
import {
  detect,
  headline,
  overview,
  reviewQueue,
  verifyOps,
  type Detector,
  type ReviewNote,
} from "./review.ts";
import { parseManifest } from "./schema.ts";

const ROOT = join(import.meta.dirname, "../../../fixtures/nadia");
const manifest = parseManifest(readFileSync(join(ROOT, "okf-base.yaml"), "utf8"));
const fixture: ReviewNote[] = readdirSync(ROOT, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".md"))
  .toSorted()
  .map((path) => {
    const { data } = parseNote(readFileSync(join(ROOT, path), "utf8"));
    return { id: String(data["id"]), path, data };
  });
const NOW = Date.UTC(2026, 10, 15);
const at = (path: string) => {
  const note = fixture.find((n) => n.path === path);
  if (!note) throw new Error(path);
  return note;
};
const BSC = at("facts/education/bsc-northvale.md");
const ROLE = at("facts/roles/acme-intern-2025.md");
const IELTS = at("facts/tests/ielts-2026-11.md");
const OLD_IELTS = at("facts/tests/ielts-2025-03.md");
const TUM = at("applications/tum-msc-informatics-2027/application.md");
const TRF = at("documents/ielts-trf-2026.md");
const PAPER = at("facts/papers/swahili-ner-2026.md");

/** A fictional note at `path`, of the fixture's types. */
const note = (path: string, data: Record<string, unknown>): ReviewNote => {
  const id = ulid();
  return { id, path, data: { id, ...data } };
};
/** A copy of a fixture note with some fields changed (undefined removes one). */
const edited = (base: ReviewNote, changes: Record<string, unknown>): ReviewNote => ({
  ...base,
  data: Object.fromEntries(Object.entries({ ...base.data, ...changes }).filter(([, v]) => v !== undefined)),
});
const replace = (notes: readonly ReviewNote[], next: ReviewNote) =>
  notes.map((n) => (n.id === next.id ? next : n));
const found = (notes: readonly ReviewNote[]) =>
  detect(notes, manifest, NOW).map((c) => `${c.noteId}:${c.detector}:${c.field ?? ""}`);

describe("headlines", () => {
  it("fill the type's template from stored fields and leave out parts with a missing value", () => {
    expect(headline(BSC, manifest)).toBe(
      "BSc Computer Science · Northvale University · 2021–2025 · CGPA 3.82",
    );
    expect(headline(IELTS, manifest)).toBe("ielts-academic · 8.0 · 2026-11-02 · expires 2028-11");
    expect(headline(edited(ROLE, { end: undefined }), manifest)).toBe(
      "Software Engineering Intern, Acme Robotics · Acme Robotics",
    );
    // No template: the title.
    expect(headline(BSC, null)).toBe("BSc Computer Science, Northvale University");
  });

  it("reach into a connector's block, and take the year of a date that has only a year", () => {
    const title = "Named Entity Recognition for Low-Resource Swahili News";
    // Nothing looked up yet: no venue or year to show.
    expect(headline(PAPER, manifest)).toBe(`${title} · author 1`);
    const synced = { venue: "Journal of Fictional Linguistics", published: "2026" };
    expect(headline(edited(PAPER, { synced }), manifest)).toBe(
      `${title} · Journal of Fictional Linguistics · 2026 · author 1`,
    );
  });
});

describe("the fixture record", () => {
  it("has no flags, only what is really true of it", () => {
    // The paper and the role have no source; the old IELTS score is superseded, so it isn't asked for proof.
    expect(found(fixture)).toEqual([`${PAPER.id}:proof:`, `${ROLE.id}:proof:`]);
    const { items, counts } = overview(fixture, manifest, NOW);
    const ielts = items.find((i) => i.noteId === IELTS.id);
    expect(ielts).toMatchObject({
      mark: "checked",
      usedBy: [TUM.id],
      aside: "proof: IELTS Test Report Form, November 2026 p1",
    });
    expect(items.find((i) => i.noteId === OLD_IELTS.id)).toMatchObject({
      superseded: true,
      aside: "superseded",
    });
    expect(counts).toMatchObject({ checked: 1, wrong: 0, conflict: 0 });
  });

  it("counts the record's items, not the work waiting on it: inbox items and questions", () => {
    const waiting = [
      note("inbox/a.md", { type: "InboxItem" }),
      note("questions/b.md", { type: "Question", title: "Which came first?", status: "open" }),
    ];
    const { items, counts } = overview([...fixture, ...waiting], manifest, NOW);
    expect(counts.items).toBe(overview(fixture, manifest, NOW).counts.items);
    expect(items.some((i) => i.type === "Question" || i.type === "InboxItem")).toBe(false);
  });
});

describe("detectors", () => {
  it("note vs its document: a cited field that differs from what the document says, with the document's value as the fix", () => {
    const notes = replace(fixture, edited(BSC, { cgpa: 3.71 }));
    const [check] = detect(notes, manifest, NOW).filter((c) => c.detector === "document");
    expect(check).toMatchObject({
      noteId: BSC.id,
      field: "cgpa",
      evidence: "Bachelor transcript, Northvale University p2 says 3.82",
      fix: { field: "cgpa", value: 3.82 },
    });
  });

  it("note vs note: one item with two values is a conflict on both, fixed only toward a verified value", () => {
    const copy = note("facts/tests/ielts-2026-11-copy.md", {
      ...IELTS.data,
      overall: 7.5,
      verified: undefined,
    });
    const checks = detect([...fixture, edited(copy, { verified: undefined })], manifest, NOW).filter(
      (c) => c.detector === "conflict",
    );
    // The verified note isn't flagged on its verified field; the copy is, toward it.
    expect(checks).toEqual([
      expect.objectContaining({ noteId: copy.id, field: "overall", fix: { field: "overall", value: 8 } }),
    ]);
  });

  it("flags a duplicate once, never the note it duplicates", () => {
    const copy = note("facts/roles/acme-intern-2025-2.md", { ...ROLE.data });
    expect(found([...fixture, copy]).filter((c) => c.includes(":duplicate:"))).toEqual([
      `${copy.id}:duplicate:`,
    ]);
  });

  it("superseded history is not a duplicate or conflict of what replaced it", () => {
    const retake = note("facts/tests/ielts-2026-11-b.md", {
      ...IELTS.data,
      overall: 8.5,
      sections: { listening: 9, reading: 8.5, writing: 8, speaking: 8 },
      supersedes: "ielts-2026-11.md",
      verified: undefined,
    });
    expect(found([...fixture, retake]).filter((c) => /conflict|duplicate/.test(c))).toEqual([]);
  });

  it("names spelled two ways, toward the spelling most notes use", () => {
    const masters = note("facts/education/msc-northvale.md", {
      type: "Education",
      title: "MSc, Northvale",
      institution: "Northvale University",
      degree: "MSc Computer Science",
      sources: [{ resource: "../../documents/transcript-bsc.md" }],
    });
    const typo = note("facts/roles/ta-2024.md", {
      type: "Role",
      title: "Teaching Assistant",
      org: "Northvale Univeristy",
      start: "2024-01-10",
      sources: [{ resource: "../../documents/transcript-bsc.md" }],
    });
    const [check, ...rest] = detect([...fixture, masters, typo], manifest, NOW).filter(
      (c) => c.detector === "spelling",
    );
    expect(rest).toEqual([]);
    expect(check).toMatchObject({
      noteId: typo.id,
      field: "org",
      fix: { field: "org", value: "Northvale University" },
    });
    // BSc and MSc are different degrees, not a typo.
    expect(found([...fixture, masters])).not.toContain(`${masters.id}:spelling:degree`);
  });

  it("an expired item an open application relies on, when nothing valid stands beside it", () => {
    // Without the November score, only the March one (expiring 2027-03-15) meets TUM's IELTS requirement.
    const notes = fixture.filter((n) => n.id !== IELTS.id && n.id !== TRF.id);
    const [check] = detect(notes, manifest, NOW).filter((c) => c.detector === "expired");
    expect(check).toMatchObject({
      noteId: OLD_IELTS.id,
      evidence: "Expires 2027-03-15, before TUM MSc Informatics, Winter 2027's deadline 2027-05-31",
      related: [TUM.id],
    });
    // A valid score below the requirement's 6.5 doesn't stand in for the expiring one.
    const low = note("facts/tests/ielts-low.md", {
      ...OLD_IELTS.data,
      overall: 5,
      date: "2026-06-01",
      expires: "2028-06-01",
    });
    expect(found([...notes, low]).filter((c) => c.includes(":expired:"))).toEqual([
      `${OLD_IELTS.id}:expired:expires`,
    ]);
    // A decided application relies on nothing.
    const decided = replace(notes, edited(TUM, { status: "decided" }));
    expect(found(decided).filter((c) => c.includes(":expired:"))).toEqual([]);
  });

  it("checked over a year ago is stale", () => {
    const old = edited(IELTS, { verified: { by: "human", at: "2025-10-01", rev: 2, fields: ["overall"] } });
    const { items } = overview(replace(fixture, old), manifest, NOW);
    expect(items.find((i) => i.noteId === IELTS.id)?.mark).toBe("stale");
  });
});

/** The seeded errors: each one changes the fixture, and names the one flag it should raise. */
interface Seed {
  readonly why: string;
  readonly notes: (base: readonly ReviewNote[]) => ReviewNote[];
  /** The flags it should raise: note, detector. Empty for a control, which should raise none. */
  readonly expect: (notes: readonly ReviewNote[]) => readonly string[];
}

const by = (notes: readonly ReviewNote[], path: string) => notes.find((n) => n.path === path)?.id ?? "";
const add =
  (...extra: ReviewNote[]) =>
  (base: readonly ReviewNote[]) => [...base, ...extra];
const swap = (next: ReviewNote) => (base: readonly ReviewNote[]) => replace(base, next);
const flag = (path: string, detector: Detector) => (notes: readonly ReviewNote[]) => [
  `${by(notes, path)}:${detector}`,
];
const none = () => [];
// A source that proves only the institution: the transcript says nothing else about a seeded note.
const PROOF = [{ resource: "../../documents/transcript-bsc.md", fields: ["institution"] }];
const role = (path: string, data: Record<string, unknown>) =>
  note(path, { type: "Role", kind: "job", sources: PROOF, ...data });
const score = (path: string, data: Record<string, unknown>) =>
  note(path, { type: "TestScore", sources: [{ resource: "../../documents/ielts-trf-2026.md" }], ...data });

const SEEDS: Seed[] = [
  // Note vs its document.
  { why: "CGPA mistyped", notes: swap(edited(BSC, { cgpa: 3.71 })), expect: flag(BSC.path, "document") },
  { why: "scale mistyped", notes: swap(edited(BSC, { scale: 5 })), expect: flag(BSC.path, "document") },
  {
    why: "expiry off by a year",
    notes: swap(edited(IELTS, { expires: "2029-11-02" })),
    expect: flag(IELTS.path, "document"),
  },
  { why: "CGPA rounded up", notes: swap(edited(BSC, { cgpa: 3.9 })), expect: flag(BSC.path, "document") },
  // Impossible values.
  {
    why: "ends before it starts",
    notes: swap(edited(ROLE, { end: "2024-09-30", sources: PROOF })),
    expect: flag(ROLE.path, "impossible"),
  },
  {
    why: "CGPA above the scale",
    notes: add(
      note("facts/education/hsc.md", {
        type: "Education",
        institution: "Lakeview College",
        degree: "HSC",
        cgpa: 5.4,
        scale: 5,
        sources: PROOF,
      }),
    ),
    expect: flag("facts/education/hsc.md", "impossible"),
  },
  {
    why: "IELTS above 9",
    notes: add(score("facts/tests/ielts-x.md", { test: "ielts-academic", overall: 9.5, date: "2024-01-10" })),
    expect: flag("facts/tests/ielts-x.md", "impossible"),
  },
  {
    why: "IELTS band not a half",
    notes: add(score("facts/tests/ielts-y.md", { test: "ielts-academic", overall: 7.3, date: "2024-02-10" })),
    expect: flag("facts/tests/ielts-y.md", "impossible"),
  },
  {
    why: "IELTS overall disagrees with its sections",
    notes: swap(edited(OLD_IELTS, { overall: 7.5 })),
    expect: flag(OLD_IELTS.path, "impossible"),
  },
  {
    why: "TOEFL above 120",
    notes: add(score("facts/tests/toefl.md", { test: "toefl-ibt", overall: 125, date: "2024-03-10" })),
    expect: flag("facts/tests/toefl.md", "impossible"),
  },
  {
    why: "GRE below 260",
    notes: add(score("facts/tests/gre.md", { test: "gre", overall: 250, date: "2024-04-10" })),
    expect: flag("facts/tests/gre.md", "impossible"),
  },
  {
    why: "issued after it expires",
    notes: swap(edited(TRF, { issued: "2029-01-01" })),
    expect: flag(TRF.path, "impossible"),
  },
  // Missing proof.
  {
    why: "a role with no source",
    notes: add(
      role("facts/roles/cafe.md", {
        org: "Corner Cafe",
        title: "Barista",
        start: "2023-01-01",
        sources: undefined,
      }),
    ),
    expect: flag("facts/roles/cafe.md", "proof"),
  },
  {
    why: "a source that isn't in the record",
    notes: add(
      role("facts/roles/lab.md", {
        org: "Vision Lab",
        title: "Research Assistant",
        start: "2024-05-01",
        sources: [{ resource: "../../documents/missing.md" }],
      }),
    ),
    expect: flag("facts/roles/lab.md", "proof"),
  },
  // Note vs note, and duplicates.
  {
    why: "two end dates for one degree",
    notes: add(note("facts/education/bsc-copy.md", { ...BSC.data, end: "2025-08-30" })),
    expect: (n) => [`${BSC.id}:conflict`, `${by(n, "facts/education/bsc-copy.md")}:conflict`],
  },
  {
    why: "a role filed twice",
    notes: add(note("facts/roles/acme-copy.md", { ...ROLE.data, sources: PROOF })),
    expect: flag("facts/roles/acme-copy.md", "duplicate"),
  },
  {
    why: "a score filed twice",
    notes: add(note("facts/tests/ielts-copy.md", { ...IELTS.data, verified: undefined })),
    expect: flag("facts/tests/ielts-copy.md", "duplicate"),
  },
  // Name spellings.
  {
    why: "employer misspelt",
    notes: add(
      role("facts/roles/acme-2026.md", { org: "Acme Robtics", title: "Engineer", start: "2026-01-05" }),
      role("facts/roles/acme-2024.md", { org: "Acme Robotics", title: "Intern", start: "2024-06-01" }),
    ),
    expect: flag("facts/roles/acme-2026.md", "spelling"),
  },
  {
    why: "institution cased differently",
    notes: add(
      note("facts/education/msc.md", {
        type: "Education",
        institution: "NorthVale University",
        degree: "MSc Data Science",
        sources: PROOF,
      }),
      role("facts/roles/ta.md", { org: "Northvale University", title: "TA", start: "2023-09-01" }),
    ),
    expect: flag("facts/education/msc.md", "spelling"),
  },
  {
    why: "issuer with a transposed letter",
    notes: add(
      note("documents/ielts-2.md", { type: "Document", kind: "test-report", issuer: "British Cuoncil" }),
      note("documents/ielts-3.md", { type: "Document", kind: "test-report", issuer: "British Council" }),
    ),
    expect: flag("documents/ielts-2.md", "spelling"),
  },
  // Expired but used.
  // Without the November score, the March one is current again, and nothing proves it.
  {
    why: "the only IELTS expires before the deadline",
    notes: (base) => base.filter((n) => n.id !== IELTS.id && n.id !== TRF.id),
    expect: (n) => [...flag(OLD_IELTS.path, "expired")(n), `${OLD_IELTS.id}:proof`],
  },
  {
    why: "a newer score that also runs out",
    notes: (base) =>
      replace(
        replace(base, edited(TRF, { expires: "2027-04-01" })),
        edited(IELTS, { expires: "2027-04-01" }),
      ),
    expect: flag(IELTS.path, "expired"),
  },
  // Controls: ordinary records that must raise nothing new.
  {
    why: "control: a second degree",
    notes: add(
      note("facts/education/msc-x.md", {
        type: "Education",
        institution: "Northvale University",
        degree: "MSc Computer Science",
        sources: PROOF,
      }),
    ),
    expect: none,
  },
  {
    why: "control: two employers a letter apart in a short name",
    notes: add(
      role("facts/roles/a.md", { org: "Acme Labs", title: "Intern", start: "2022-06-01" }),
      role("facts/roles/b.md", { org: "Acme Robotics", title: "Intern", start: "2022-07-01" }),
    ),
    expect: none,
  },
  {
    why: "control: a valid TOEFL",
    notes: add(
      score("facts/tests/toefl-ok.md", {
        test: "toefl-ibt",
        overall: 110,
        date: "2026-01-10",
        sections: { reading: 28, listening: 29, speaking: 26, writing: 27 },
      }),
    ),
    expect: none,
  },
  {
    why: "control: an ongoing role",
    notes: add(
      role("facts/roles/now.md", {
        org: "Northvale University",
        title: "Research Assistant",
        start: "2025-09-01",
      }),
    ),
    expect: none,
  },
  {
    why: "control: the same role twice, years apart",
    notes: add(
      role("facts/roles/acme-2023.md", {
        org: "Acme Robotics",
        title: "Software Engineering Intern",
        start: "2023-07-01",
        end: "2023-09-30",
      }),
    ),
    expect: none,
  },
  {
    why: "control: a retake that supersedes",
    notes: add(
      score("facts/tests/ielts-2027.md", {
        test: "ielts-academic",
        overall: 8.5,
        date: "2027-01-10",
        sections: { listening: 9, reading: 8.5, writing: 8, speaking: 8 },
        supersedes: "ielts-2026-11.md",
      }),
    ),
    expect: none,
  },
];

describe("seeded errors", () => {
  it("are found with precision and recall of at least 0.90", () => {
    // What the clean fixture already raises is true of it, not a seed: it doesn't count either way.
    const baseline = new Set(found(fixture).map((f) => f.split(":").slice(0, 2).join(":")));
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    const misses: string[] = [];
    for (const seed of SEEDS) {
      const notes = seed.notes(fixture);
      const raised = new Set(
        found(notes)
          .map((f) => f.split(":").slice(0, 2).join(":"))
          .filter((f) => !baseline.has(f)),
      );
      const wanted = new Set(seed.expect(notes));
      for (const want of wanted)
        if (raised.has(want)) truePositives++;
        else {
          falseNegatives++;
          misses.push(`missed ${seed.why}`);
        }
      for (const got of raised)
        if (!wanted.has(got)) {
          falsePositives++;
          misses.push(`extra on ${seed.why}: ${got}`);
        }
    }
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);
    console.info(
      `detectors on ${SEEDS.length} seeds: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`,
      misses,
    );
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe("review", () => {
  it("walks flags first, then what an open application uses, then the rest, and skips history", () => {
    const notes = replace(fixture, edited(BSC, { cgpa: 3.71 }));
    const queue = reviewQueue(overview(notes, manifest, NOW).items);
    expect(queue[0]?.noteId).toBe(BSC.id);
    expect(queue.findIndex((i) => i.noteId === IELTS.id)).toBeLessThan(
      queue.findIndex((i) => i.noteId === ROLE.id),
    );
    expect(queue.some((i) => i.noteId === OLD_IELTS.id)).toBe(false);
  });

  it("Correct verifies the type's own values at the revision shown, and nothing structural", () => {
    const raw = readFileSync(join(ROOT, ROLE.path), "utf8");
    const next = patch(raw, verifyOps(ROLE.data, manifest, 3, NOW));
    expect(parseNote(next).data["verified"]).toEqual({
      by: "human",
      at: "2026-11-15",
      rev: 3,
      fields: ["org", "kind", "start", "end"],
    });
    // Only the new line: every other byte stays.
    expect(next.replace(/\nverified: .*/, "")).toBe(raw);
  });
});
