// A packet's zip, read back by Python's zipfile (which honours the UTF-8 name flag, as Windows and macOS Finder
// do; macOS's command-line unzip doesn't).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vite-plus/test";

import { zip } from "./zip.ts";

const READ = `import json, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "files": {n: list(z.read(n)) for n in z.namelist()}}))`;

it("holds each file under its name, byte for byte, with a CRC zipfile accepts", () => {
  const dir = mkdtempSync(join(tmpdir(), "brainiac-zip-"));
  const cv = new TextEncoder().encode("%PDF-1.7 the CV");
  const transcript = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 251));
  const file = join(dir, "packet.zip");
  writeFileSync(
    file,
    zip([
      { name: "Karim_Nadia_CV.pdf", bytes: cv },
      { name: "Karim_Nadia_Zeugnis_Übersetzung.pdf", bytes: transcript },
    ]),
  );
  const read = JSON.parse(execFileSync("python3", ["-c", READ, file], { encoding: "utf8" }));
  expect(read.bad).toBeNull();
  expect(Object.keys(read.files)).toEqual(["Karim_Nadia_CV.pdf", "Karim_Nadia_Zeugnis_Übersetzung.pdf"]);
  expect(read.files["Karim_Nadia_CV.pdf"]).toEqual([...cv]);
  expect(read.files["Karim_Nadia_Zeugnis_Übersetzung.pdf"]).toEqual([...transcript]);
});
