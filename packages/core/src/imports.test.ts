import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { csvRows, fromCv, fromLinkedIn, fromVault, isLinkedIn, linkedInDate } from "./imports.ts";
import { parseNote } from "./note.ts";

const EXPORT = join(import.meta.dirname, "../../../fixtures/imports/linkedin-export");
const exported = new Map(readdirSync(EXPORT).map((name) => [name, readFileSync(join(EXPORT, name), "utf8")]));

describe("reading a LinkedIn export", () => {
  it("reads quoted cells with commas, quotes and line breaks, and a byte-order mark", () => {
    expect(csvRows('﻿Name,Note\r\n"Acme, Inc.","said ""hi""\nthen left"\r\n\r\nSolo,\n')).toEqual([
      { Name: "Acme, Inc.", Note: 'said "hi"\nthen left' },
      { Name: "Solo", Note: "" },
    ]);
  });

  it("turns a month into its first or last day, and never makes a date from a year alone", () => {
    expect(linkedInDate("Jul 2025", false)).toBe("2025-07-01");
    expect(linkedInDate("Sep 2025", true)).toBe("2025-09-30");
    expect(linkedInDate("Feb 2028", true)).toBe("2028-02-29");
    expect(linkedInDate("2025-03-14", true)).toBe("2025-03-14");
    expect(linkedInDate("2021", false)).toBeUndefined();
    expect(linkedInDate("", true)).toBeUndefined();
  });

  it("makes each position a Role and each school an Education, and sends the rest about the person to the inbox", () => {
    expect(isLinkedIn(exported)).toBe(true);
    const plan = fromLinkedIn(exported);
    expect(plan.notes.map((note) => [note.path, parseNote(note.raw).data])).toEqual([
      [
        "facts/education/bsc-computer-science-northvale-university.md",
        {
          type: "Education",
          title: "BSc Computer Science, Northvale University",
          institution: "Northvale University",
          degree: "BSc Computer Science",
        },
      ],
      [
        "facts/roles/teaching-assistant-northvale-university-2025.md",
        {
          type: "Role",
          title: "Teaching Assistant, Northvale University",
          org: "Northvale University",
          start: "2025-09-01",
          current: true,
        },
      ],
      [
        "facts/roles/software-engineering-intern-acme-robotics-2025.md",
        {
          type: "Role",
          title: "Software Engineering Intern, Acme Robotics",
          org: "Acme Robotics",
          start: "2025-07-01",
          end: "2025-09-30",
        },
      ],
    ]);
    // Years alone stay in words, with what the person wrote.
    expect(plan.notes[0]?.raw).toMatch(
      /---\nLinkedIn says 2021 to 2025\.\nThesis on low-resource named entity recognition\.\n\nProgramming club$/,
    );
    // A month widened to a day says so, in LinkedIn's words.
    expect(plan.notes[1]?.raw).toMatch(
      /---\nLinkedIn says Sep 2025 to now\.\nRuns the weekly Compilers labs, for 120 students\.$/,
    );
    expect(plan.inbox.map((item) => item.label)).toEqual(["Certifications.csv, 1 row", "Skills.csv, 4 rows"]);
    expect(plan.inbox[1]?.text).toContain("- Name: Python\n- Name: TypeScript\n");
    // Connections are other people: never sent, never shown.
    expect(JSON.stringify(plan)).not.toContain("Okafor");
    expect(plan.left).toEqual([
      { what: "1 other file", why: "about other people or LinkedIn itself, not your record" },
    ]);
  });

  it("keeps out a file that prints an ID number, and a position it can't name", () => {
    const plan = fromLinkedIn(
      new Map([
        ["Positions.csv", "Company Name,Title,Started On\n,Volunteer,Jan 2024\n"],
        ["Certifications.csv", "Name,License Number\nDriving,Driver's license number: DL 12345678\n"],
      ]),
    );
    expect(plan.notes).toEqual([]);
    expect(plan.inbox).toEqual([]);
    expect(plan.left.map((left) => left.what)).toEqual([
      "Positions.csv: Volunteer",
      "Certifications.csv, 1 row",
    ]);
  });
});

describe("reading an OKF vault", () => {
  const NADIA = join(import.meta.dirname, "../../../fixtures/nadia");
  const vault = new Map<string, string | undefined>(
    readdirSync(NADIA, { recursive: true, encoding: "utf8" })
      .filter((path) => path.includes("."))
      .map((path) => [path, readFileSync(join(NADIA, path), "utf8")]),
  );

  it("keeps each typed note as it is, at its path, sensitive in a sensitive area, without a verified mark", () => {
    const plan = fromVault(vault);
    expect(plan.notes.length).toBe([...vault.keys()].filter((path) => path.endsWith(".md")).length);
    for (const note of plan.notes) {
      const raw = vault.get(note.path) ?? "";
      expect(note.raw).toBe(raw.replace(/^verified: .*\n/m, ""));
      expect(note.sensitive ?? false).toBe(/^(facts\/tests|people)\//.test(note.path));
    }
    expect(plan.left).toEqual([]);
  });

  it("leaves out untyped notes, ID and finance notes and files, and never changes what it read", () => {
    const files = new Map<string, string | undefined>([
      ["journal/monday.md", "# Monday\n\nNo front-matter here.\n"],
      ["identity/passport.md", "---\ntype: IdDocument\nkind: passport\n---\n"],
      ["documents/files/transcript.pdf", undefined],
      ["broken.md", "---\ntype: [Role\n---\n"],
    ]);
    const before = JSON.stringify([...files]);
    expect(fromVault(files)).toEqual({
      notes: [],
      inbox: [],
      left: [
        { what: "journal/monday.md", why: "it has no type" },
        { what: "identity/passport.md", why: expect.stringMatching(/vault/) },
        { what: "broken.md", why: "its front-matter isn't valid YAML" },
        { what: "1 other file", why: "not notes, so left on disk: upload files on the site" },
      ],
    });
    expect(JSON.stringify([...files])).toBe(before);
  });
});

describe("reading a CV", () => {
  it("sends its text to the inbox, and never one that prints an ID number", () => {
    expect(fromCv("cv.pdf", "  Nadia Karim\nBSc Computer Science\n").inbox).toEqual([
      {
        label: "cv.pdf",
        text: "A CV the person sent with brainiac import.\n\nNadia Karim\nBSc Computer Science\n",
      },
    ]);
    const secret = fromCv("cv.pdf", "Nadia Karim\nPassport No. XK1234567\n");
    expect(secret.inbox).toEqual([]);
    expect(secret.left[0]?.why).toMatch(/vault/);
    expect(fromCv("scan.pdf", "  \n").left).toEqual([{ what: "scan.pdf", why: "it has no text to read" }]);
  });
});
