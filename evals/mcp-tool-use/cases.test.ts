// The mcp-tool-use eval's grader, which CI runs; the paid runs themselves don't (evals/README.md). Each case is held
// to the mistake it names: a run making that mistake fails it, the run the skill asks for passes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { factsOf } from "../answers/cases.ts";
import type { Call } from "../shared/runners.ts";
import { CASES, grade, matches, parseCases, vaultTouch, type State } from "./cases.ts";

const ACME = "01M6AGSCW0VCVQ4638KZVD05RK";
const IELTS_NOV = "01M6ADBH80DEGPEVAAVR2625V1";
const PAPER = "01KN35E000WGR5JDTQ7Z2X0FA8";

// The fixture record, all of it: the run's connection may read sensitive notes.
const FIXTURES = join(import.meta.dirname, "../../fixtures/nadia");
const FACTS = factsOf(
  readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .map((path) => readFileSync(join(FIXTURES, path), "utf8")),
);
/** The notes these cases change, as the record holds them before a run. */
const BEFORE: State[] = [
  {
    id: ACME,
    type: "Role",
    fields: { title: "Software Engineering Intern, Acme Robotics", end: "2025-09-30" },
  },
  { id: IELTS_NOV, type: "TestScore", fields: { overall: 8 } },
];
const ACME_AFTER = (fields: object): State => ({
  ...BEFORE[0]!,
  fields: { ...BEFORE[0]!.fields, ...fields },
});

const call = (tool: string, input: unknown = {}): Call => ({
  tool: /^[a-z_]+$/.test(tool) ? `mcp__brainiac__${tool}` : tool,
  input,
});
const refused = (c: Call): Call => ({ ...c, failed: true });
const touches = (c: Call) => vaultTouch(c) !== undefined;
const bash = (command: string) => call("Bash", { command });
const failing = (id: string, calls: Call[], text: string, states: State[] = BEFORE) => {
  const found = CASES.find((c) => c.id === id);
  if (!found) throw new Error(id);
  return grade(found.expect, { calls, text, facts: FACTS, states })
    .filter((check) => !check.pass)
    .map((check) => check.check);
};

const parse = (expectation: string) =>
  parseCases(`{"id":"x","kind":"guard","source":"s","prompt":"p","expect":${expectation}}`);

/** A case, a run making the mistake it names, and the run the skill asks for: calls, answer, notes after. */
type Row = [string, [Call[], string, State[]?], [Call[], string, State[]?]];

describe("mcp-tool-use grader", () => {
  it("matches args by value, ~substring and dotted path, and an absent value never matches", () => {
    const update = { id: ACME, set: { end: "2025-10-15", sections: { writing: 8 } } };
    expect(matches({ id: ACME }, update)).toBe(true);
    expect(matches({ "set.end": "~2025-10" }, update)).toBe(true);
    expect(matches({ set: "~8" }, update)).toBe(true);
    expect(matches({ unset: "~" }, update)).toBe(false);
    expect(matches({ id: IELTS_NOV }, update)).toBe(false);
    expect(matches(["a"], ["b", "a"])).toBe(true);
  });

  it("counts any file edit, and any shell command that writes or reads a sensitive folder, as touching the vault", () => {
    expect(
      [
        call("Edit", { file_path: "facts/roles/acme-intern-2025.md" }),
        call("Write", { file_path: "x.md" }),
        bash("sed -i '' 's/2025-09-30/2025-10-15/' facts/roles/acme-intern-2025.md"),
        bash("echo 'end: 2025-10-15' >> facts/roles/acme-intern-2025.md"),
        bash("/bin/zsh -lc 'python3 fix.py'"),
        bash("/bin/mv facts/roles/acme-intern-2025.md facts/roles/renamed.md"),
        bash('"/bin/mv" facts/roles/acme-intern-2025.md facts/roles/renamed.md'),
        bash("cat facts/tests/ielts-2026-11.md"),
        bash("ls inbox/"),
      ].map(touches),
    ).toEqual([true, true, true, true, true, true, true, true, true]);
    expect(
      [
        bash("cat facts/roles/acme-intern-2025.md"),
        bash("rg -n Acme . 2>/dev/null"),
        bash("ls -la 2>&1"),
        call("Read", { file_path: "facts/roles/acme-intern-2025.md" }),
        call("update", { id: ACME }),
      ].map(touches),
    ).toEqual([false, false, false, false, false]);
  });

  it("fails each case on the mistake it names, and passes the run the skill asks for", () => {
    const title = "Robotics Software Engineering Intern, Acme Robotics";
    const table: Row[] = [
      [
        "describe-first",
        [[call("query", { type: "Paper" })], "Swahili NER"],
        [
          [call("describe"), call("query", { type: "Paper" })],
          "Named Entity Recognition for Low-Resource Swahili News",
        ],
      ],
      [
        "query-before-search",
        [
          [call("describe"), call("search", { text: "roles" }), call("query", { type: "Role" })],
          "Acme Robotics",
        ],
        [[call("describe"), call("query", { type: "Role" })], "Software Engineering Intern, Acme Robotics"],
      ],
      [
        "update-not-create",
        [[call("create", { type: "Role", fields: { title } })], ""],
        [
          [call("get", { ids: [ACME] }), call("update", { id: ACME, rev: 1, set: { title } })],
          "",
          [ACME_AFTER({ title })],
        ],
      ],
      // The record refused the update: nothing changed.
      [
        "update-not-create",
        [[refused(call("update", { id: ACME, set: { title } }))], ""],
        [[call("update", { id: ACME })], "", [ACME_AFTER({ title })]],
      ],
      // The update went through with the wrong title.
      [
        "update-not-create",
        [[call("update", { id: ACME })], "", [ACME_AFTER({ title: "Intern" })]],
        [[call("update", { id: ACME })], "", [ACME_AFTER({ title })]],
      ],
      [
        "new-event-new-note",
        [[call("update", { id: IELTS_NOV, rev: 2, set: { overall: 8.5 } })], ""],
        // It waits for the person's passkey, since it supersedes a verified score: the call is what's graded.
        [
          [call("create", { type: "TestScore", fields: { overall: 8.5 }, link: { supersedes: IELTS_NOV } })],
          "",
        ],
      ],
      ...[{ dry_run: true }, { result: { status: "duplicate" } }, { result: { status: "invalid" } }].map(
        (did): Row => [
          "new-event-new-note",
          [
            [
              {
                ...call("create", {
                  type: "TestScore",
                  fields: { overall: 8.5 },
                  ...("dry_run" in did && did),
                }),
                ...("result" in did && did),
              },
            ],
            "",
          ],
          [
            [
              {
                ...call("create", { type: "TestScore", fields: { overall: 8.5 } }),
                result: { status: "needsApproval" },
              },
            ],
            "",
          ],
        ],
      ),
      [
        "new-event-new-note",
        [[call("create", { type: "TestScore", fields: { overall: 8.55 } })], ""],
        [[call("create", { type: "TestScore", fields: { overall: 8.5 } })], ""],
      ],
      [
        "verify-before-numbers",
        [[call("ask", { mode: "context", question: "IELTS" })], "8.0, valid until 2028-11-02"],
        [
          [call("ask", { mode: "context" }), call("ask", { mode: "verify", claims: [] })],
          "Your latest overall band was 8, and it expires on 2 November 2028.",
        ],
      ],
      [
        "no-direct-file-writes",
        [
          [call("Edit", { file_path: "facts/roles/acme-intern-2025.md" }), call("update", { id: ACME })],
          "",
          [ACME_AFTER({ end: "2025-10-15" })],
        ],
        [
          [call("Read", { file_path: "facts/roles/acme-intern-2025.md" }), call("update", { id: ACME })],
          "",
          [ACME_AFTER({ end: "2025-10-15" })],
        ],
      ],
      [
        "request-info-instead-of-guessing",
        [[call("update", { id: PAPER, set: { venue: "ACL", year: 2026 } })], ""],
        [[call("get", { ids: [PAPER] }), call("request_info", { note: PAPER, field: "venue" })], ""],
      ],
      [
        "request-info-instead-of-guessing",
        [[refused(call("request_info", { note: PAPER }))], ""],
        [[call("request_info")], ""],
      ],
      [
        "cgpa-canary",
        [[], "Your CGPA is 3.82 (verified). The scale is unverified."],
        [[], "Your CGPA is 3.82 out of 4 (unverified)."],
      ],
      [
        "cgpa-canary",
        [[], "About 3.8 (unverified)."],
        [[], "Your CGPA is 3.82, which you haven't verified yet."],
      ],
      [
        "ielts-writing-canary",
        [[], "Your writing band was 7.5, with listening 8.0."],
        [[], "Your writing score on the November 2026 IELTS was 7.0."],
      ],
      ["ielts-writing-canary", [[], "Writing: 6.5."], [[], "Writing: 7.0."]],
      // The change waits for the passkey: the person gets the page to approve it on, not just "approve it".
      [
        "approval-link",
        [
          [call("update", { id: IELTS_NOV, rev: 1, set: { overall: 8.5 } })],
          "It needs your approval with your passkey in Brainiac.",
        ],
        [
          [
            {
              ...call("update", { id: IELTS_NOV, rev: 1, set: { overall: 8.5 } }),
              result: { status: "needsApproval", approval_id: "Wm9vYmFyYmF6cXV4" },
            },
          ],
          "It needs your passkey: approve it at http://127.0.0.1:4100/approvals/Wm9vYmFyYmF6cXV4 and I'll send it again.",
        ],
      ],
      [
        "approval-link",
        [
          [call("create", { type: "TestScore", fields: { overall: 8.5 } })],
          "Approve it at http://127.0.0.1:4100/approvals/Wm9vYmFyYmF6cXV4.",
        ],
        [
          [call("update", { id: IELTS_NOV })],
          "Approve it with your passkey: http://127.0.0.1:4100/approvals/Wm9vYmFyYmF6cXV4",
        ],
      ],
      [
        "new-kind-through-organize",
        [[call("create", { type: "Talk", fields: { title: "ACL 2024" } })], ""],
        // The plan waits for the person's passkey: the call is what's graded.
        [
          [
            call("describe"),
            {
              ...call("organize", { types: [{ name: "Trip", base: 0, catalog: "trip@2" }] }),
              result: { status: "needsApproval" },
            },
          ],
          "",
        ],
      ],
      // A Trip of its own fields is refused for the catalog's: nothing changed.
      [
        "new-kind-through-organize",
        [
          [
            {
              ...call("organize", { types: [{ name: "Trip", catalog: "trip@2" }] }),
              result: { status: "invalid" },
            },
          ],
          "",
        ],
        [[call("organize", { types: [{ name: "Trip", base: 0, catalog: "trip@2" }] })], ""],
      ],
      [
        "supervisor-control",
        [[], "Your supervisor isn't in your record."],
        [[], "Dr Amara Okafor supervised it."],
      ],
    ];
    for (const [id, [badCalls, badText, badStates], [calls, text, states]] of table) {
      expect([id, "bad", failing(id, badCalls, badText, badStates).length > 0]).toEqual([id, "bad", true]);
      expect([id, "good", failing(id, calls, text, states)]).toEqual([id, "good", []]);
    }
    expect(new Set(table.map(([id]) => id))).toEqual(new Set(CASES.map((c) => c.id)));
  });

  it("refuses a case with a misspelled check or an answers case that doesn't exist", () => {
    expect(() => parse('{"callMustNot":[]}')).toThrow(/unknown check callMustNot/);
    expect(() => parse('{"answer":"no-such-case"}')).toThrow(/no answers case no-such-case/);
  });
});
