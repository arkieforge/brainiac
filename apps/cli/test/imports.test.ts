// `brainiac scan` and `brainiac import` on the fixture student's files, sent to the fixture record through the real
// `import` tool: what each file becomes, and what importing it does to the record. packages/core covers the mapping
// and packages/base the record's side; this is the CLI between them.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { callTool, connect, listNotes, migrate, mutate } from "@brainiac/base";
import { nodeSql } from "@brainiac/base/node";
import JSZip from "jszip";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { importSources, readSource, scanReport } from "../src/imports.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures");
const EXPORT = join(FIXTURES, "imports/linkedin-export");
const CV = join(FIXTURES, "imports/cv.pdf");
const NADIA = join(FIXTURES, "nadia");

const scratch = mkdtempSync(join(tmpdir(), "brainiac-import-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The export as LinkedIn sends it: a zip of its CSVs. */
async function zipped(): Promise<string> {
  const zip = new JSZip();
  for (const name of readdirSync(EXPORT)) zip.file(name, readFileSync(join(EXPORT, name)));
  const path = join(scratch, "linkedin-export.zip");
  writeFileSync(path, await zip.generateAsync({ type: "uint8array" }));
  return path;
}

/** The fixture record with its manifest, as the person made it, and a CLI connection's `import` calls. */
function record() {
  const sql = nodeSql(new DatabaseSync(":memory:"));
  migrate(sql);
  sql.all(
    "INSERT INTO schema (version, manifest) VALUES (1, ?)",
    readFileSync(join(NADIA, "okf-base.yaml"), "utf8"),
  );
  for (const path of ["facts/roles/acme-intern-2025.md", "facts/education/bsc-northvale.md"]) {
    const raw = readFileSync(join(NADIA, path), "utf8");
    mutate(sql, { op: "create", path, raw, class: "normal" }, { actor: "human", now: Date.UTC(2026, 10, 1) });
  }
  const connection = connect(sql, { kind: "cli" }, Date.UTC(2026, 10, 1));
  const call = async (args: unknown) => {
    const answer = callTool(sql, "import", args, {
      actor: `connection:${connection.id}`,
      connection,
      now: Date.UTC(2026, 11, 1),
    });
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  };
  return { sql, call };
}

describe("brainiac scan", () => {
  it("reads the export as a zip or a folder alike, and the CV's text from its PDF", async () => {
    const zip = await readSource(await zipped());
    const folder = await readSource(EXPORT);
    expect(zip.plan).toEqual(folder.plan);
    const cv = await readSource(CV);
    expect(cv.as).toBe("a CV");
    expect(cv.plan.inbox[0]?.text).toContain(
      "Experience\nTeaching Assistant, Compilers, Northvale University, Sep 2025 to present\n",
    );
    expect(scanReport(zip).slice(0, 4)).toEqual([
      `${scratch}/linkedin-export.zip: a LinkedIn export`,
      "  Education  BSc Computer Science, Northvale University  facts/education/bsc-computer-science-northvale-university.md",
      "  Role       Teaching Assistant, Northvale University    facts/roles/teaching-assistant-northvale-university-2025.md",
      "  Role       Software Engineering Intern, Acme Robotics  facts/roles/software-engineering-intern-acme-robotics-2025.md",
    ]);
  });

  it("refuses the folder this computer syncs, and files it can't read", async () => {
    await expect(readSource(NADIA, NADIA)).rejects.toThrow(/in your record already/);
    const docx = join(scratch, "cv.docx");
    writeFileSync(docx, "");
    await expect(readSource(docx)).rejects.toThrow(/a CV \(\.pdf, \.txt or \.md\)/);
  });
});

describe("brainiac import", () => {
  it("proposes the export's new role, leaves out what the record has, and puts the CV in the inbox; again, it does nothing", async () => {
    const { sql, call } = record();
    const sources = [await readSource(await zipped()), await readSource(CV)];
    expect((await importSources(sources, call)).lines).toEqual([
      "Proposed 1 note: each waits for you to accept or reject it.",
      'Added 3 inbox items: say "file my inbox" to your Claude, or run brainiac filing now.',
      "Already in your record: 2 items.",
      "  facts/education/bsc-computer-science-northvale-university.md, as facts/education/bsc-northvale.md",
      "  facts/roles/software-engineering-intern-acme-robotics-2025.md, as facts/roles/acme-intern-2025.md",
    ]);
    const [proposal] = sql.all<{ patch: string }>("SELECT patch FROM proposals WHERE status = 'open'");
    expect(JSON.parse(proposal?.patch ?? "[]")[0].path).toBe(
      "facts/roles/teaching-assistant-northvale-university-2025.md",
    );
    expect(listNotes(sql, { type: "InboxItem" }).length).toBe(3);

    const again = await importSources(sources, call);
    expect(again.lines[0]).toBe("Already in your record: 6 items.");
    expect(listNotes(sql, { type: "InboxItem" }).length).toBe(3);
  });
});
