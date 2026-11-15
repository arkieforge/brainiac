// Conformance cases for the ORCID connector's side of the record (orcid.ts): which of the person's works become
// proposed papers, and that each is proposed once. cases.ts runs them on both engines; apps/worker/test/orcid.test.ts
// covers ORCID itself, and papers-cases.ts the author position the linked iD gives.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  decide,
  getNote,
  linkedOrcid,
  linkOrcid,
  listNotes,
  migrate,
  mutate,
  ORCID_ACTOR,
  unlinkOrcid,
  type Sql,
  type Work,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const human = (now = T0) => ({ actor: "human", now });
// Outside the ranges ORCID issues, so nobody's.
const NADIA = "0000-0000-0000-0001";

// The fixture student's works on ORCID (fictional). The first is the paper her record already has.
const NER: Work = {
  putCode: "101",
  title: "Named Entity Recognition for Low-Resource Swahili News",
  doi: "10.5555/BRAINIAC.SWAHILI-NER.2026",
};
const SEATS: Work = {
  putCode: "102",
  title: "Finding Library Seats with Occupancy Sensors",
  doi: "https://doi.org/10.5555/brainiac.seats.2025",
};
const POSTER: Work = { putCode: "103", title: "Tokenizing Swahili Morphology" };

function withPaper(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const paper = fixtures.find((f) => f.path === "facts/papers/swahili-ner-2026.md");
  ok(paper);
  equal(
    mutate(sql, { op: "create", path: paper.path, raw: paper.raw, class: "normal" }, human()).status,
    "applied",
  );
}

const openProposals = (sql: Sql) =>
  sql.all<{ id: string; actor: string; patch: string }>(
    "SELECT id, actor, patch FROM proposals WHERE status = 'open' ORDER BY json_extract(patch, '$[0].path')",
  );

export const orcidCases: Record<string, Case> = {
  "each ORCID work the record doesn't have is proposed as a paper once, and one turned down never comes back":
    (sql, fixtures) => {
      // No manifest: the built-in Paper type and its folder apply.
      withPaper(sql, fixtures);
      same(linkOrcid(sql, NADIA, [NER, SEATS, POSTER], T0), { proposed: 2 });
      equal(linkedOrcid(sql), NADIA);
      // The paper she has (its DOI in another case) isn't proposed; the other two are, as the connector, unapplied.
      const proposals = openProposals(sql);
      same(
        proposals.map((p) => [p.actor, (JSON.parse(p.patch) as { path: string }[])[0]?.path]),
        [
          [ORCID_ACTOR, "facts/papers/finding-library-seats-with-occupancy-sensors.md"],
          [ORCID_ACTOR, "facts/papers/tokenizing-swahili-morphology.md"],
        ],
      );
      equal(listNotes(sql, { type: "Paper" }).length, 1);

      const [seats, poster] = proposals;
      ok(seats && poster);
      const accepted = decide(sql, seats.id, "accept", human(T0 + 1));
      ok(accepted.status === "applied", JSON.stringify(accepted));
      // Only what ORCID said: the title and the bare DOI, for the DOI connector to fill the rest.
      const note = listNotes(sql, { type: "Paper" }).find((n) => n.title?.startsWith("Finding"));
      ok(note);
      const data = parseNote(getNote(sql, note.id)?.raw ?? "").data;
      same(
        [data["type"], data["doi"], data["position"]],
        ["Paper", "10.5555/brainiac.seats.2025", undefined],
      );
      equal(decide(sql, poster.id, "reject", human(T0 + 1)).status, "rejected");

      // Linking again (to bring in new works) proposes nothing it proposed before: not the accepted one, not the
      // rejected one, not one whose paper was deleted since.
      equal(
        mutate(sql, { op: "delete", noteId: note.id, baseRev: note.rev }, human(T0 + 2)).status,
        "applied",
      );
      same(linkOrcid(sql, NADIA, [NER, SEATS, POSTER], T0 + 3), { proposed: 0 });
      // Nor the poster she turned down once ORCID gives it a DOI.
      const posterWithDoi = { ...POSTER, doi: "10.5555/brainiac.poster.2026" };
      same(linkOrcid(sql, NADIA, [posterWithDoi], T0 + 3), { proposed: 0 });
      // Nor when that DOI later turns up under another of ORCID's put-codes (another source added the same work).
      same(linkOrcid(sql, NADIA, [{ ...posterWithDoi, putCode: "203" }], T0 + 3), { proposed: 0 });
      same(openProposals(sql), []);

      // Unlinking forgets the iD; the papers stay.
      unlinkOrcid(sql, T0 + 4);
      equal(linkedOrcid(sql), undefined);
      equal(listNotes(sql, { type: "Paper" }).length, 1);
    },
};
