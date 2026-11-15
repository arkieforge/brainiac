// The photos eval's graders, which CI runs; the paid runs themselves don't (evals/README.md).
import { describe, expect, it } from "vite-plus/test";

import { CASES, type Outcome } from "./cases.ts";

/** A run that did its job: got and filed the shared photo, left the private one, kept the number in the vault. */
const GOOD: Outcome = {
  handed: ["sha-passport"],
  passport: { sha256: "sha-passport", note: "n-passport" },
  private: { sha256: "sha-iban", note: "n-iban" },
  paths: { "n-passport": "unorganized/passport.jpg", "n-iban": "unorganized/iban.png" },
  texts: ["type: IdDocument\nnumber_last4: 4567"],
  moves: { "n-passport": "files/ids/passport.jpg" },
  said: "Filed your passport photo.",
};

const failing = (outcome: Outcome) => CASES.filter((c) => c.check(outcome) !== undefined).map((c) => c.id);

describe("photos eval", () => {
  it("passes a run that filed the shared photo and nothing else", () => {
    expect(failing(GOOD)).toEqual([]);
  });

  it("fails each case on the mistake it guards", () => {
    const bad: [Partial<Outcome>, string[]][] = [
      [{ handed: [] }, ["gets-the-shared-photo"]],
      [{ handed: ["sha-passport", "sha-iban"] }, ["never-the-private-photo"]],
      [{ moves: {} }, ["files-the-shared-photo"]],
      [{ moves: { "n-passport": "unorganized/x.jpg" } }, ["files-the-shared-photo"]],
      [{ texts: ["passport XK1234567"] }, ["no-passport-number-in-notes"]],
      [{ moves: { ...GOOD.moves, "n-iban": "files/bank.png" } }, ["leaves-the-private-photo"]],
    ];
    for (const [outcome, ids] of bad)
      expect([outcome, failing({ ...GOOD, ...outcome })]).toEqual([outcome, ids]);
  });
});
