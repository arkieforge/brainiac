import { describe, expect, it } from "vite-plus/test";

import { parsePassport, scan } from "./checks.ts";

// The fixture student's passport, issued by ICAO's specimen state Utopia (UTO): nobody real.
const MRZ = ["P<UTOKARIM<<NADIA<<<<<<<<<<<<<<<<<<<<<<<<<<<", "XK12345679UTO0103141F3105043<<<<<<<<<<<<<<04"];
const NOW = Date.UTC(2026, 10, 15);

describe("scan", () => {
  it("finds a passport's MRZ however the text spaced it", () => {
    expect(scan(MRZ.join("\n"))).toEqual(["mrz"]);
    expect(scan(`Scan of page 2\n${MRZ[0]?.replaceAll("<<", "< <")}\n`)).toEqual(["mrz"]);
    // Inside a quote, a table row, after a label, or both lines on one: still an MRZ.
    for (const wrapped of [
      MRZ.map((line) => `> ${line}`).join("\n"),
      MRZ.map((line) => `| ${line} |`).join("\n"),
      `MRZ: ${MRZ.join(" ")}`,
      `MRZ ${MRZ[0]}\n${MRZ[1]}`,
    ]) {
      expect(scan(wrapped), wrapped).toEqual(["mrz"]);
      expect(parsePassport(wrapped, NOW)?.number, wrapped).toBe("XK1234567");
    }
    // An OCR's guillemets for fillers.
    const guillemets = MRZ.map((line) => line.replaceAll("<<", "\u00ab")).join("\n");
    expect(scan(guillemets)).toEqual(["mrz"]);
    expect(parsePassport(guillemets, NOW)?.number).toBe("XK1234567");
    // Spaced out by an OCR, with a label on each line.
    const spaced = MRZ.map((line, i) => `Line ${i + 1} ${line.replaceAll("<<", "< <")}`).join("\n");
    expect(scan(spaced)).toEqual(["mrz"]);
    // A label on each line still pairs them.
    expect(parsePassport(MRZ.map((line) => `MRZ: ${line}`).join("\n"), NOW)?.number).toBe("XK1234567");
    // Names that fill the top line and optional data that fills the bottom leave no filler pair.
    const full = [
      "P<UTOKARIMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "XK12345679UTO0103141F31050431234567890123454",
    ];
    expect(scan(full.join("\n"))).toEqual(["mrz"]);
    expect(scan(full[1] ?? "")).toEqual(["mrz"]);
    // A top line whose own bottom line was misread (a character lost) doesn't borrow a later bottom line.
    const later = "XK12345679UTO7503142F3105043<<<<<<<<<<<<<<<2";
    const misread = [MRZ[0], MRZ[1]?.slice(1), "", "Second page", later].join("\n");
    expect(parsePassport(misread, NOW)).toBeUndefined();
    expect(parsePassport([MRZ[0], "Second page", later].join("\n"), NOW)?.birthDate).toBe("1975-03-14");
    // An ID card's TD1 line, check digits or not: a misread MRZ still prints the number.
    expect(scan("I<UTOD231458907<<<<<<<<<<<<<<<")).toEqual(["mrz"]);
  });

  it("finds IBANs by their checksum, in groups or run together", () => {
    expect(scan("IBAN: DE89 3704 0044 0532 0130 00\nBIC: COBADEFFXXX")).toEqual(["iban"]);
    expect(scan("Pay to GB29NWBK60161331926819 by Friday")).toEqual(["iban"]);
    expect(scan("DE89  3704  0044  0532  0130  00")).toEqual(["iban"]);
    expect(scan("iban de89 3704 0044 0532 0130 00")).toEqual(["iban"]);
    expect(scan("IBAN DE89 3704 0044\n0532 0130 00")).toEqual(["iban"]);
    // A failed candidate just before the real IBAN doesn't hide it.
    expect(scan("Ref GB29NWBK60161331926818\nIBAN DE89 3704 0044 0532 0130 00")).toEqual(["iban"]);
    expect(scan("Customer AB12 IBAN GB29 NWBK 6016 1331 9268 19")).toEqual(["iban"]);
    expect(scan("Order NO12 and IBAN NL91 ABNA 0417 1643 00")).toEqual(["iban"]);
    expect(scan("IBAN: DE89-3704-0044-0532-0130-00")).toEqual(["iban"]);
    expect(scan("IBAN: DE89.3704.0044.0532.0130.00")).toEqual(["iban"]);
    // After the label, any grouping.
    expect(scan("IBAN: DE89 370400440532013000")).toEqual(["iban"]);
    expect(scan("IBAN: GB29 NWBK60161331926819")).toEqual(["iban"]);
    for (const labelled of [
      "IBAN No.: DE89 370400440532013000",
      "IBAN-Nr.: DE89 370400440532013000",
      "IBAN number: GB29 NWBK60161331926819",
      "My IBAN is DE89 370400440532013000",
      "IBAN/BIC: DE89 370400440532013000 / COBADEFFXXX",
      "IBAN-Nummer: DE89 370400440532013000",
      "IBAN Code: DE89 370400440532013000",
    ])
      expect(scan(labelled), labelled).toEqual(["iban"]);
    // One digit off fails mod 97: a reference number, not an account.
    expect(scan("Ref GB29NWBK60161331926818")).toEqual([]);
    // Unless OCR read it: one misread digit mustn't clear a photographed bank statement.
    expect(scan("Ref GB29NWBK60161331926818", "ocr")).toEqual(["iban"]);
    expect(scan("IBAN: DE89 3704 0044 0532 0130 01", "ocr")).toEqual(["iban"]);
    // The shape still has to hold: the country's length, or a course code is nothing.
    expect(scan("Course CSE2023 Data Structures, GB29 NWBK", "ocr")).toEqual([]);
  });

  it("finds labelled identity and account numbers", () => {
    expect(scan("Passport No.: XK1234567")).toEqual(["id-number"]);
    expect(scan("NID number 1990123456789")).toEqual(["id-number"]);
    expect(scan("My passport number is XK1234567")).toEqual(["id-number"]);
    for (const labelled of [
      "**Passport number:** XK1234567",
      '"Passport Number","XK1234567"',
      "passport's number: XK1234567",
      "Passport Number/No.: XK1234567",
      "Passport No = XK1234567",
      "Passport #: 123456789",
      "**Passport #**: XK1234567",
      "My passport\u2019s number is XK1234567",
      "Passport No \u2013 XK1234567",
      `Passport Number ${String.fromCodePoint(0x2014)} XK1234567`,
      "Passport Number: \u201cXK1234567\u201d",
      "Passport ID: XK1234567",
      "Passport Number: XK 1234567",
      "Passport no. 12 345 678",
      "Aadhaar No: 1234 5678 9012",
      "National ID Number: 1990 1234 56789",
      "SSN: 123 45 6789",
      "Passport (UK): 123456789",
      "Passport N\u00b0 XK1234567",
      "Passport Number: XK\u00a01234567",
      "National ID Number: 1990\t1234\t56789",
      "Passport Number: XK  1234567",
      "National ID Number: 1990  1234  56789",
      "Passport No./Passeport No. 123456789",
      "Passeport N\u00b0 XK1234567",
      "Passaporte n\u00ba XK1234567",
      "Pasaporte N.\u00ba: XK1234567",
      "Reisepassnummer: C01X00T47",
      "Passport number: `XK1234567`",
      "Visa No.: 12345678",
      "Visa number: XK1234567",
    ])
      expect(scan(labelled), labelled).toEqual(["id-number"]);
    expect(scan("SSN 123-45-6789")).toEqual(["id-number"]);
    expect(scan("Account Number: 0123 4567 8901")).toEqual(["account-number"]);
    expect(scan("Account Number: 0123\u00a04567\u00a08901")).toEqual(["account-number"]);
    expect(scan("Account Number: 0123\t4567\t8901")).toEqual(["account-number"]);
    expect(scan("Account number: `012345678901`")).toEqual(["account-number"]);
    expect(scan("Acct No. 0123456789")).toEqual(["account-number"]);
    expect(scan("A/C # 0123456789")).toEqual(["account-number"]);
    expect(scan("A/C: 0123456789")).toEqual(["account-number"]);
    expect(scan("A/C 0123456789")).toEqual(["account-number"]);
    expect(scan("Acct: 0123456789")).toEqual(["account-number"]);
    expect(scan("Account #0123456789")).toEqual(["account-number"]);
    expect(scan("Account Number: 123456")).toEqual(["account-number"]);
    expect(scan("Account Number: 1234567")).toEqual(["account-number"]);
    expect(scan("Account Number: 1234.56.78903")).toEqual(["account-number"]);
  });

  it("stays fast on long runs of column padding", () => {
    // Exponential backtracking would hang here past the test's timeout.
    expect(scan(`Account Number: 0123456789${" ".repeat(60)}Balance: 100.00`)).toEqual(["account-number"]);
    expect(scan(`Account 1${"\u00a0".repeat(60)}x`)).toEqual([]);
    expect(scan(`ACCT 2101${" ".repeat(60)}Financial Accounting   3.00   A`)).toEqual([]);
    for (const label of ["Passport", "Account", "IBAN"])
      expect(scan(`${label}${"#".repeat(4000)}!`)).toEqual([]);
    // Labels inside what a label would capture.
    expect(scan("ssn-".repeat(50_000))).toEqual([]);
    expect(scan("ssn 1-".repeat(50_000))).toEqual(["id-number"]);
    // A megabyte of ordinary words: the passport parse looks at each run once.
    const words = "CS2408 Programming Methodology A 4.0 4\n".repeat(26_000);
    expect(parsePassport(words, NOW)).toBeUndefined();
    expect(scan(words)).toEqual([]);
  });

  it("finds nothing in a transcript or a test report", () => {
    const transcript = [
      "Northvale University, Office of the Registrar",
      "Student ID: 2019331001",
      "CSE 101 Structured Programming A+ 4.00",
      "CGPA 3.82 on a scale of 4. Issued 2025-07-10.",
      "Bring a passport-size photo, dated 2026-11-02.",
      "Passport photo 2026 attached",
      "CS2408 Programming Methodology A- 4.5 4",
      "MA1521 Calculus for Computing B+ 4.0 4",
      "PH1012 Critical Thinking and Writing A 5.0 4",
      "Grading: A 80-100, B 65-79, F below 50 (marks <50 are a fail in every course)",
      "Note: a score <50 in any single module means the module must be repeated",
      "The results were significant at p < 0.05 for all conditions",
      "Compensatable fail 35 to <40 and outright fail <35 in any module",
      "Pass mark is 50 so a resit applies if the mark is <50 and failure if <40 overall",
      "C++: use cout << value << endl to print each result",
      "Title of qualification: \u00ab MASTER OF SCIENCE IN COMPUTER SCIENCE \u00bb",
      "Diplome: \u00abBACHELOR OF BUSINESS ADMINISTRATION\u00bb",
      "Grade: \u00bbBACHELOR OF ENGINEERING ELECTRICAL\u00ab",
      "ACCT 2101 001 3.0 A",
      "ACCT\t2101\t001\t3.0\tA",
      "ACCT 2101  3  12.00",
      "Software Engineer Intern, Visa, 2022-2024",
      "Visa, Jun 2023 - Aug 2023",
      "Visa (San Francisco) 2022-2024",
      "Mastercard / Visa, 2021-2023",
      "Student visa: 2023-2027",
      "Managed the Acme account 2019-20 growth by 30%",
      "Customer Account: 2021-22 renewals",
      "National ID 2019-20 drive volunteer",
      "Financial Account 101 3.00 A",
      "Marks: 78 81 92 66 74 88 90 71",
      "IELTS TRF 26GB001234KARN001A, overall 8.0",
    ].join("\n");
    expect(scan(transcript)).toEqual([]);
  });
});

describe("parsePassport", () => {
  it("reads a TD3 MRZ with every check digit verified", () => {
    expect(parsePassport(`Passport\n\n${MRZ.join("\n")}\n`, NOW)).toEqual({
      issuer: "UTO",
      number: "XK1234567",
      surname: "KARIM",
      givenNames: "NADIA",
      nationality: "UTO",
      birthDate: "2001-03-14",
      sex: "F",
      expires: "2031-05-04",
    });
  });

  it("refuses an MRZ with a misread digit rather than guessing", () => {
    // The number's last digit misread: its check digit no longer matches.
    expect(parsePassport([MRZ[0], `XK12345689${MRZ[1]?.slice(10)}`].join("\n"), NOW)).toBeUndefined();
    // The composite check catches a change the field checks don't cover.
    expect(parsePassport([MRZ[0], `${MRZ[1]?.slice(0, 43)}5`].join("\n"), NOW)).toBeUndefined();
    // No check digit covers the nationality: an OCR's `0` for `O` would pass them all.
    expect(parsePassport([MRZ[0], MRZ[1]?.replace("UTO", "UT0")].join("\n"), NOW)).toBeUndefined();
  });

  it("puts a two-digit birth year ahead of today in the last century, and takes an empty filler check", () => {
    // Born 1975; the optional data's check digit printed as a filler, as some states do.
    const bottom = "XK12345679UTO7503142F3105043<<<<<<<<<<<<<<<2";
    expect(parsePassport([MRZ[0], bottom].join("\n"), NOW)?.birthDate).toBe("1975-03-14");
  });

  it("reads an X for sex as printed", () => {
    const bottom = "XK12345679UTO0103141X3105043<<<<<<<<<<<<<<04";
    expect(parsePassport([MRZ[0], bottom].join("\n"), NOW)?.sex).toBe("X");
  });
});
