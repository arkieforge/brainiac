// The pure half of ingest: how notes and pages are cut into chunks, which pages the checks can't trust, and the
// int8 vectors. The record's half (installs, families, stale results) runs on both engines in ingest-cases.ts.
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import {
  chunkFile,
  chunkNote,
  dequantize,
  LONG_BODY,
  needsReading,
  pdfHidesText,
  quantize,
  splitPages,
} from "../src/index.ts";

// What Workers AI's `toMarkdown` returned for a 3-page text-layer PDF of the fixture student's transcript, with
// metadata off: page 2 has no text layer.
const MARKDOWN =
  "# t3.pdf\n## Contents\n### Page 1\nNorthvale University transcript, page 1 of 3\nStudent: Nadia Karim (fictional fixture)\nCourse CSE101 Data Structures 1: grade A, 3.0 credits\nCourse MAT201 Linear Algebra 1: grade B+, 3.0 credits\nSemester 1 GPA 3.1\n\n\n\n### Page 2\n\n\n\n\n### Page 3\nNorthvale University transcript, page 3 of 3\nStudent: Nadia Karim (fictional fixture)\nCourse CSE103 Data Structures 3: grade A, 3.0 credits\nCourse MAT203 Linear Algebra 3: grade B+, 3.0 credits\nSemester 3 GPA 3.3\n\n";

const IELTS = `---
id: 01M6ADBH80DEGPEVAAVR2625V1
type: TestScore
title: "IELTS Academic, November 2026"
overall: 8.0
sections: {listening: 8.5, writing: 7.0}
trf_number: "26GB001234KARN001A"
portal_login: secret:portal.ielts
verified: {by: human, at: 2026-11-03, rev: 2, fields: [overall]}
---
## Notes

Took the computer-delivered test.
`;

const note = (raw: string) =>
  ({
    raw,
    class: "sensitive",
    type: "TestScore",
    title: "IELTS Academic, November 2026",
    path: "x.md",
  }) as const;

describe("splitPages", () => {
  it("cuts toMarkdown's output into its pages, keeping an empty one in its place", () => {
    const pages = splitPages(MARKDOWN);
    expect(pages?.map((page) => page.trim().split("\n")[0] ?? "")).toEqual([
      "Northvale University transcript, page 1 of 3",
      "",
      "Northvale University transcript, page 3 of 3",
    ]);
    // Every byte of the pages reaches the checks.
    for (const line of MARKDOWN.split("\n").filter((l) => l && !l.startsWith("#")))
      expect(pages?.join("\n")).toContain(line);
  });

  it("refuses output in any other shape, so the checks treat it as unread", () => {
    expect(splitPages("# t.pdf\n\nsome text")).toBeUndefined();
    expect(splitPages("# t.pdf\n## Contents\n### Page 2\nskipped page one")).toBeUndefined();
    expect(splitPages("# t.pdf\n## Contents\n")).toBeUndefined();
  });

  it("a page that prints a page marker only moves text, never hides it", () => {
    const sneaky = "# t.pdf\n## Contents\n### Page 1\nIBAN\n### Page 3\nDE89\n### Page 2\nrest\n";
    expect(splitPages(sneaky)?.join("\n")).toContain("IBAN\n### Page 3\nDE89");
  });
});

describe("needsReading", () => {
  it("flags pages whose text can't be all they say", () => {
    // A blank page is read: a scan on it is an image, which `pdfHidesText` finds.
    expect(needsReading("\n\n\n")).toBe(false);
    expect(needsReading("Semester 1 GPA 3.1 ��")).toBe(true);
    expect(needsReading("%$#@!*&^%$#@!*&^ ~~ ##")).toBe(true);
    expect(needsReading("| Course | Grade |\n| --- | --- |\n| Data Structures | |\n")).toBe(true);
    expect(needsReading("| Course | Grade |\n| --- | --- |\n| CSE101 | 3.7 |\n")).toBe(false);
    expect(needsReading("Northvale University transcript\nSemester 1 GPA 3.1")).toBe(false);
    // Text in any script reads as text.
    expect(needsReading("নর্থভেল বিশ্ববিদ্যালয়, সিজিপিএ ৩.৮২")).toBe(false);
    expect(needsReading("| বিষয় | গ্রেড |\n| কম্পিউটার বিজ্ঞান | ৩.৭ |\nমোট ক্রেডিট: ১২০")).toBe(false);
    expect(needsReading("नॉर्थवेल विश्वविद्यालय, कुल क्रेडिट: १२०, सीजीपीए ३.८२")).toBe(false);
  });
});

/** A PDF of these objects (dictionaries, and streams as `[dictionary, bytes]`); no xref, which nothing here reads. */
function pdf(...objects: (string | readonly [string, Uint8Array])[]): Uint8Array {
  const parts = objects.flatMap((object, i) =>
    typeof object === "string"
      ? [Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`)]
      : [
          Buffer.from(`${i + 1} 0 obj\n${object[0]}\nstream\n`),
          Buffer.from(object[1]),
          Buffer.from("\nendstream\nendobj\n"),
        ],
  );
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), ...parts, Buffer.from("%%EOF\n")]);
}
const text = (content: string) => ["<< /Filter /FlateDecode >>", deflateSync(content)] as const;
const PAGE = "<< /Type /Page /Resources << /Font << /F1 3 0 R >> /ProcSet [/PDF /Text /ImageB] >> >>";
const TEXT = text("BT /F1 12 Tf 72 720 Td (Semester 1 GPA 3.1) Tj ET");

describe("pdfHidesText", () => {
  it("passes a PDF that only draws text, compressed or not", () => {
    expect(pdfHidesText(pdf(PAGE, TEXT, "<< /Type /Font /Subtype /Type1 >>"))).toBe(false);
    expect(pdfHidesText(pdf(PAGE, ["<< /Length 11 >>", Buffer.from("BT (x) Tj ET")]))).toBe(false);
    // A link is not text of its own, and XMP metadata is XML.
    const link = "<< /Type /Annot /Subtype /Link /A << /URI (https://example.edu) >> >>";
    expect(pdfHidesText(pdf(PAGE, TEXT, link, "<< /Type /Metadata /Subtype /XML >>"))).toBe(false);
    // Compressed twice is still opened.
    expect(pdfHidesText(pdf(PAGE, ["<< /Filter [/FlateDecode /FlateDecode] >>", deflateSync(TEXT[1])]))).toBe(
      false,
    );
  });

  it("flags anything that can print text the text layer doesn't hold", () => {
    const image = [
      "<< /Type /XObject /Subtype /Image /Filter /DCTDecode >>",
      Buffer.from([0xff, 0xd8]),
    ] as const;
    const flagged = [
      pdf(PAGE, TEXT, image),
      // A name spelled with escapes is the same name.
      pdf(PAGE, "<< /Type /XObject /Subtype /Im#61ge >>"),
      // An image inline in a content stream, compressed once or twice.
      pdf(PAGE, text("q BI /W 8 /H 8 /CS /G /BPC 8 ID \x00\x01 EI Q")),
      pdf(PAGE, [
        "<< /Filter [/FlateDecode /FlateDecode] >>",
        deflateSync(text("q BI /W 8 ID \x00 EI Q")[1]),
      ]),
      // However it is spelled: no space before the first key, a comment after the operator, no keys at all.
      pdf(PAGE, text("q\nBI/W 8/H 8/BPC 8 ID \x00 EI Q")),
      pdf(PAGE, text("q BI % inline\n/W 8 ID \x00 EI Q")),
      pdf(PAGE, text("q BI\nID \x00 EI Q")),
      pdf(PAGE, text("q BI\x00/W 8 ID \x00 EI Q")),
      pdf(PAGE, text("q 8BI/W 8/H 8 8ID\xff\xd8 EI Q")),
      pdf(PAGE, "<< /Type /XObject /Subtype /Image\x00/Width 8 >>"),
      pdf(PAGE, "<< /Type /XObject /Subtype\x00/Image >>"),
      // Dictionaries packed into a compressed object stream.
      pdf(PAGE, ["<< /Type /ObjStm /N 1 /Filter /FlateDecode >>", deflateSync("4 0 << /AcroForm 5 0 R >>")]),
      pdf(PAGE, TEXT, "<< /Type /EmbeddedFile >>"),
      // Every annotation but a link: comments, ink, highlights; and a link with an appearance of its own.
      pdf(PAGE, TEXT, "<< /Type /Annot /Subtype /FreeText /Contents (IBAN DE89) >>"),
      pdf(PAGE, TEXT, "<< /Type /Annot /Subtype /Ink /InkList [[1 2 3 4]] >>"),
      pdf(PAGE, TEXT, "<< /Type /Annot /Subtype /Highlight /Contents (IBAN DE89) >>"),
      pdf(PAGE, TEXT, "<< /Type /Annot /Subtype /Link /AP << /N 9 0 R >> >>"),
      // Glyphs drawn by the font's own code, and a subtype that isn't a plain name.
      pdf(PAGE, TEXT, "<< /Type /Font /Subtype /Type3 >>"),
      pdf(PAGE, TEXT, "<< /Type /XObject /Subtype % a comment\n/Image >>"),
      pdf(PAGE, TEXT, "<< /Type /XObject /Subtype 9 0 R >>"),
      // Any filter but Flate, wherever it is named, and encryption.
      pdf(PAGE, ["<< /Filter /ASCII85Decode >>", Buffer.from('87cURD]i,"Ebo80~>')]),
      pdf(PAGE, ["<< /Filter 9 0 R >>", Buffer.from("BT (x) Tj ET")], "[/FlateDecode /LZWDecode]"),
      pdf(PAGE, TEXT, "<< /Filter /Standard /V 2 >>", "<< /Encrypt 4 0 R >>"),
      // Binary data that doesn't inflate.
      pdf(PAGE, ["<< >>", Uint8Array.of(0x00, 0xff, 0x13, 0x88)]),
    ];
    for (const [i, bytes] of flagged.entries()) expect(pdfHidesText(bytes), `case ${i}`).toBe(true);
  });

  it("doesn't let the dictionary say what a compressed stream holds", () => {
    const inline = deflateSync("q BI /W 8 /H 8 /CS /G /BPC 8 ID \x00\x01 EI Q");
    for (const dictionary of [
      "<< /Filt#65r /FlateDecode >>",
      "<< /Filter % comment\n/FlateDecode >>",
      "<< /Filter /FlateDecode /Xobj 1 >>",
      "<< /Filter 9 0 R >>",
    ])
      expect(pdfHidesText(pdf(PAGE, [dictionary, inline])), dictionary).toBe(true);
    // A stream keyword with a bare CR: where its data starts is unknown.
    const bare = Buffer.concat([
      Buffer.from("%PDF-1.7\n1 0 obj\n<< >>\nstream\r"),
      inline,
      Buffer.from("\nendstream"),
    ]);
    expect(pdfHidesText(bare)).toBe(true);
  });

  it("passes an xref stream packed with a predictor, as writers make them", () => {
    const xref =
      "<< /Type /XRef /W [1 2 1] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >> >>";
    expect(pdfHidesText(pdf(PAGE, TEXT, [xref, deflateSync(Uint8Array.of(2, 1, 0, 16, 0))]))).toBe(false);
  });

  it("doesn't take what a page prints for PDF syntax", () => {
    const transcript = "BT (SAT/AP courses) Tj (Business Intelligence BI 101, Student ID: N2026001) Tj ET";
    expect(pdfHidesText(pdf(PAGE, text(transcript)))).toBe(false);
    // Nor a string or comment outside streams.
    expect(pdfHidesText(pdf(PAGE, TEXT, "<< /Title (My /Image and /AP notes) >> % /AcroForm"))).toBe(false);
    expect(pdfHidesText(pdf(PAGE, TEXT, "<< /Title (nested (parens) and \\) escaped /Image) >>"))).toBe(
      false,
    );
  });

  it("doesn't take metadata for structure", () => {
    for (const title of ["Data stream processing", "Ends with %%EOF", "Linearized /Linearized 1"])
      expect(pdfHidesText(pdf(PAGE, TEXT, `<< /Title (${title}) >>`)), title).toBe(false);
    // An XMP packet left uncompressed opens with a byte order mark.
    const xmp = Buffer.from(
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><dc:title>SAT/AP Scores :(</dc:title>',
    );
    expect(pdfHidesText(pdf(PAGE, TEXT, ["<< /Type /Metadata /Subtype /XML >>", xmp]))).toBe(false);
    expect(
      pdfHidesText(
        pdf(PAGE, TEXT, ["<< /Type /Metadata /Subtype /XML /Filter /FlateDecode >>", deflateSync(xmp)]),
      ),
    ).toBe(false);
  });

  it("doesn't lose the streams after a string a writer left unclosed", () => {
    const image = [
      "<< /Type /XObject /Subtype /Image /Filter /DCTDecode >>",
      Buffer.from([0xff, 0xd8]),
    ] as const;
    // A Windows path's last backslash escapes the closing parenthesis, so the string runs on.
    expect(pdfHidesText(pdf("<< /Author (C:\\Users\\Registrar\\) >>", PAGE, TEXT, image))).toBe(true);
    expect(
      pdfHidesText(pdf("<< /Title (unclosed >>", PAGE, TEXT, ["<< >>", deflateSync("BT (x) Tj ET")])),
    ).toBe(true);
  });

  it("doesn't lose what comes after a string left open at the end", () => {
    const stray = "<< /Author (C:\\Users\\Registrar\\) >>";
    expect(pdfHidesText(pdf(PAGE, TEXT, stray, "<< /Type /Annot /Subtype /Widget /V (DE89) >>"))).toBe(true);
    // In an object stream too.
    const packed = deflateSync(`4 0 5 30 << /Author (C:\\x\\) >> << /Subtype /Widget >>`);
    expect(pdfHidesText(pdf(PAGE, TEXT, ["<< /Type /ObjStm /N 2 /Filter /FlateDecode >>", packed]))).toBe(
      true,
    );
  });

  it("flags an incrementally saved PDF, whose older revisions it never read", () => {
    const twice = Buffer.concat([pdf(PAGE, TEXT), Buffer.from("4 0 obj\n<< >>\nendobj\n%%EOF\n")]);
    expect(pdfHidesText(twice)).toBe(true);
    // A linearized file writes two cross-references in one revision.
    const linearized = Buffer.concat([pdf("<< /Linearized 1 >>", PAGE, TEXT), Buffer.from("%%EOF\n")]);
    expect(pdfHidesText(linearized)).toBe(false);
    // Only the first object can say so.
    const later = Buffer.concat([pdf(PAGE, "<< /Linearized 1 >>", TEXT), Buffer.from("%%EOF\n")]);
    expect(pdfHidesText(later)).toBe(true);
  });

  // Patterns that could backtrack would hang here.
  it("judges a long run of comment marks after BI", () => {
    expect(pdfHidesText(pdf(PAGE, text(`q BI${"%".repeat(50_000)}`)))).toBe(false);
  });

  it("stops inflating at a limit, and counts that as hiding text", () => {
    const bomb = deflateSync(Buffer.alloc(17 * 1024 * 1024));
    expect(pdfHidesText(pdf(PAGE, ["<< /Filter /FlateDecode >>", bomb]))).toBe(true);
  });
});

/** The header of a long note's last section, under an H2 line. */
const lastHeader = (line: string) =>
  chunkNote(note(`${IELTS}\n${"Detail. ".repeat(LONG_BODY / 8)}\n${line}\n\nText.\n`)).at(-1)?.header;

describe("chunkNote", () => {
  it("a short note is one chunk: its fields as written, then its body, under a header", () => {
    const [chunk, ...rest] = chunkNote(note(IELTS));
    expect(rest).toEqual([]);
    expect(chunk).toEqual({
      family: "sensitive",
      header: "[TestScore · IELTS Academic, November 2026]",
      text: "overall 8.0, sections: listening 8.5, writing 7.0, trf number 26GB001234KARN001A\n\n## Notes\n\nTook the computer-delivered test.",
    });
  });

  it("reads H2 headings as CommonMark does, in time linear in the line", () => {
    expect(lastHeader("## Plan ##")).toBe("[TestScore · IELTS Academic, November 2026 › Plan]");
    expect(lastHeader("## C#")).toBe("[TestScore · IELTS Academic, November 2026 › C#]");
    expect(lastHeader(`## ${" ".repeat(50_000)}x`)).toBe("[TestScore · IELTS Academic, November 2026 › x]");
  });

  it("reads a value an alias repeats", () => {
    const raw =
      "---\ntype: TestScore\noverall: &band 8.0\nsections: {writing: *band, listening: 8.5}\nlater: *band\n---\n";
    expect(chunkNote(note(raw))[0]?.text).toBe(
      "overall 8.0, sections: writing 8.0, listening 8.5, later 8.0",
    );
  });

  it("a long note is cut at its H2 headings, but not at one inside a code fence", () => {
    const filler = "Detail. ".repeat(LONG_BODY / 8);
    const raw = `${IELTS}\nEarlier lines.\n\n## Plan\n\n${filler}\n\n\`\`\`\n## not a heading\n\`\`\`\n## Questions\n\nAPS original?\n`;
    expect(chunkNote(note(raw)).map((c) => [c.header, c.text.slice(0, 20)])).toEqual([
      ["[TestScore · IELTS Academic, November 2026]", "overall 8.0, section"],
      ["[TestScore · IELTS Academic, November 2026 › Notes]", "Took the computer-de"],
      ["[TestScore · IELTS Academic, November 2026 › Plan]", "Detail. Detail. Deta"],
      ["[TestScore · IELTS Academic, November 2026 › Questions]", "APS original?"],
    ]);
    expect(chunkNote(note(raw))[2]?.text).toContain("## not a heading");
  });
});

describe("chunkFile", () => {
  it("one chunk per page with text, named by kind and page", () => {
    const pages = splitPages(MARKDOWN) ?? [];
    expect(chunkFile({ sha256: "ab", kind: "transcript" }, pages).map((c) => [c.header, c.page])).toEqual([
      ["[transcript · page 1]", 1],
      ["[transcript · page 3]", 3],
    ]);
  });
});

describe("quantize", () => {
  it("keeps a unit vector's direction in int8, one byte per component", () => {
    const raw = Array.from({ length: 1024 }, (_, i) => Math.sin(i * 12.9898) * 0.05);
    const norm = Math.hypot(...raw);
    const unit = raw.map((x) => x / norm);
    const q = quantize(unit);
    expect(q.byteLength).toBe(1024);
    const back = Array.from(dequantize(q));
    const cosine = back.reduce((sum, x, i) => sum + x * (unit[i] ?? 0), 0) / Math.hypot(...back);
    expect(cosine).toBeGreaterThan(0.999);
    expect(Math.max(...back.map(Math.abs))).toBe(127);
  });
});
