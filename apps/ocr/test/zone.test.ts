// Where a passport's printed zone ends, from the line boxes OCR's two passes read; the fixture student's specimen
// passport (ICAO's Utopia), nobody real.
import { describe, expect, it } from "vite-plus/test";

import { printedZone, type Line } from "../src/zone.ts";

const TOP = "P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<";
const BOTTOM = "XK12345679UTO0103141F3105043<<<<<<<<<<<<<<04";
const OTHER_TOP = "P<UTOOSEI<<KWAME<<<<<<<<<<<<<<<<<<<<<<<<<<<<";
const OTHER_BOTTOM = "ZZ76543210UTO9902285M3409308<<<<<<<<<<<<<<06";

/** Lines 40 px apart from the top, in order. */
const at = (...texts: string[]): Line[] =>
  texts.map((text, i) => ({ text, top: i * 40, bottom: i * 40 + 30 }));

// What the English pass reads: the printed zone, then its own reading of the MRZ, fillers as letters.
const PAGE = at(
  "UTOPIA PASSPORT",
  "Code UTO",
  "Surname KARIM",
  "Given names NADIA",
  "P c UTO KARIN cc NADIA cccc",
  "XK12345679 UTO 0103141 F 3105043 cccc",
);

describe("printedZone", () => {
  it("is the English pass's lines above the MRZ", () => {
    const mrz = [
      { text: TOP, top: 160, bottom: 190 },
      { text: BOTTOM, top: 200, bottom: 230 },
    ];
    expect(printedZone(PAGE, mrz)).toBe("UTOPIA PASSPORT\nCode UTO\nSurname KARIM\nGiven names NADIA");
    // A long label the MRZ model misread with fillers, above the MRZ, is no second passport.
    const stray = [{ text: "PLACE<OF<BIRTH<LIEU<DE<NAISSANCE<UTOPIA", top: 80, bottom: 110 }, ...mrz];
    expect(printedZone(PAGE, stray)).toBe("UTOPIA PASSPORT\nCode UTO\nSurname KARIM\nGiven names NADIA");
    // Nor is prose below it, a certified copy's line or the facing page.
    const below = [
      ...PAGE,
      { text: "This passport remains the property of the Government of Utopia", top: 240, bottom: 270 },
      { text: "Certified true copy of the original document", top: 280, bottom: 310 },
    ];
    expect(printedZone(below, mrz)).toBe("UTOPIA PASSPORT\nCode UTO\nSurname KARIM\nGiven names NADIA");
  });

  it("starts at the first line with a filler pair, however short, from either pass", () => {
    // The MRZ model broke the top line into short pieces: the English pass's echo beside them still isn't printed.
    const pieces = [
      { text: "P<UTOKARIN<<", top: 160, bottom: 190 },
      { text: "NADIA<<<<<<<<<<", top: 160, bottom: 190 },
      { text: BOTTOM, top: 200, bottom: 230 },
    ];
    expect(printedZone(PAGE, pieces)).not.toContain("KARIN");
    // And where the MRZ model missed the top line, the English pass's own filler pair marks it.
    const echo = at("UTOPIA PASSPORT", "Surname KARIM", "P<UTOKARIN<<NADIA", BOTTOM);
    expect(printedZone(echo, [{ text: BOTTOM, top: 120, bottom: 150 }])).toBe(
      "UTOPIA PASSPORT\nSurname KARIM",
    );
  });

  it("is nothing where there may be two passports, or no MRZ", () => {
    // Side by side, read across: one line as wide as two MRZs, a space or not.
    const across = [
      { text: `${TOP} ${OTHER_TOP.slice(0, 20)} ${OTHER_TOP.slice(20)}`, top: 160, bottom: 190 },
      { text: `${OTHER_BOTTOM} ${BOTTOM}`, top: 200, bottom: 230 },
    ];
    expect(printedZone(PAGE, across)).toBe("");
    // One above the other: more long MRZ lines than one passport has.
    expect(printedZone(PAGE, at(TOP, BOTTOM, OTHER_TOP, OTHER_BOTTOM))).toBe("");
    // The MRZ model broke both top lines into pieces, but the English pass read all four lines whole.
    const english = at("UTOPIA", "KARIM NADIA", "OSEI KWAME", TOP, OTHER_TOP, BOTTOM, OTHER_BOTTOM);
    const pieces = [
      { text: "P<UTOKARIM<<NADIA<<", top: 120, bottom: 150 },
      { text: "P<UTOOSEI<<KWAME<<", top: 160, bottom: 190 },
      { text: BOTTOM, top: 200, bottom: 230 },
      { text: OTHER_BOTTOM, top: 240, bottom: 270 },
    ];
    expect(printedZone(english, pieces)).toBe("");
    expect(printedZone(PAGE, [])).toBe("");
  });
});
