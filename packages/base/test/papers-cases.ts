// Conformance cases for the DOI connector's half in the record: a paper with a DOI is looked up once, its
// `synced:` block is written through the mutation path as the connector, a week later it is looked up again, and
// nothing loops: not a stale result, nor a write the person must approve. cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { parseNote } from "@brainiac/core";

import {
  DOI_ACTOR,
  dueJobs,
  getNote,
  installLookup,
  jobInput,
  linkOrcid,
  LOOKUP_MS,
  markDispatched,
  migrate,
  mutate,
  nextWake,
  recordApproval,
  type Context,
  type Found,
  type Sql,
  unlinkOrcid,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const PAPER = "facts/papers/swahili-ner-2026.md";
const human = (now = T0): Context => ({ actor: "human", now });

// What Crossref and OpenAlex say about the fixture paper (fictional, like its DOI).
const FOUND = {
  title: "Named Entity Recognition for Low-Resource Swahili News",
  venue: "Journal of Fictional Linguistics",
  published: "2026-03-14",
  authors: ["Nadia Karim", "Amara Okafor"],
  citations: 3,
} satisfies Found;

// The fixture student's ORCID iD and her co-author's: outside the ranges ORCID issues, so nobody's. Crossref writes
// them as links, with either scheme.
const NADIA = "0000-0000-0000-0001";
const AMARA = "0000-0000-0000-0002";
const IDS = [`https://orcid.org/${NADIA}`, `http://orcid.org/${AMARA}`];

// A new mapping is written on one line, in flow style, as every new value is (record-format.md).
const BLOCK =
  "synced: {doi: 10.5555/brainiac.swahili-ner.2026, title: Named Entity Recognition for Low-Resource Swahili News, " +
  "venue: Journal of Fictional Linguistics, published: 2026-03-14, authors: [Nadia Karim, Amara Okafor], " +
  "citations: 3, checked: 2026-11-15T00:00:01Z}\n";

function record(sql: Sql, fixtures: readonly Fixture[]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  const paper = fixtures.find((f) => f.path === PAPER);
  ok(manifest && paper);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  const created = mutate(sql, { op: "create", path: PAPER, raw: paper.raw, class: "normal" }, human());
  ok(created.status === "applied", JSON.stringify(created));
  return { id: created.noteId, raw: paper.raw };
}

/** The paper's lookup due at `now`, dispatched, as the consumer gets it. */
function lookup(sql: Sql, id: string, now: number) {
  const job = dueJobs(sql, now).find((j) => j.kind === "doi" && j.noteId === id);
  ok(job, "no doi job");
  markDispatched(sql, [job.id], now);
  const input = jobInput(sql, job.id);
  ok(input && "note" in input);
  equal(input.note.rev, job.rev);
  return job.id;
}

const dois = (sql: Sql, now: number) => dueJobs(sql, now).filter((j) => j.kind === "doi");
const synced = (sql: Sql, id: string) => parseNote(getNote(sql, id)?.raw ?? "").data["synced"];
const lastActor = (sql: Sql, id: string) =>
  sql.all<{ actor: string }>("SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1", id)[0]
    ?.actor;

export const papersCases: Record<string, Case> = {
  "a paper fills from its DOI as the connector, keeps every other byte, and is looked up again a week later":
    (sql, fixtures) => {
      const paper = record(sql, fixtures);
      // A paper nobody looked up wakes the record now, never at a time already past (that alarm never fires).
      sql.all("DELETE FROM jobs");
      equal(nextWake(sql, T0 + 5), T0 + 5);
      const job = lookup(sql, paper.id, T0);
      // One lookup at a time: none is due while this one is out.
      same(dois(sql, T0), []);

      equal(installLookup(sql, job, FOUND, T0 + 1_000), "installed");
      const note = getNote(sql, paper.id);
      same(synced(sql, paper.id), {
        doi: "10.5555/brainiac.swahili-ner.2026",
        ...FOUND,
        checked: "2026-11-15T00:00:01Z",
      });
      // Only the block is new: the person's fields, their comment and the body are byte for byte as they were.
      equal(note?.raw, paper.raw.replace("position: 1\n", `position: 1\n${BLOCK}`));
      equal(lastActor(sql, paper.id), DOI_ACTOR);

      // Filled: nothing due until a week after the lookup, and the record wakes for it then.
      same(dois(sql, T0 + 1_000 + LOOKUP_MS - 1), []);
      ok((nextWake(sql, T0 + 2_000) ?? 0) <= T0 + 1_000 + LOOKUP_MS);
      const week = T0 + 1_000 + LOOKUP_MS;
      const again = lookup(sql, paper.id, week);
      // The registry dropped the venue and the paper was cited twice more: the block follows, and only it.
      const { venue: _, ...rest } = FOUND;
      equal(installLookup(sql, again, { ...rest, citations: 5 }, week), "installed");
      same(synced(sql, paper.id), {
        doi: "10.5555/brainiac.swahili-ner.2026",
        ...rest,
        citations: 5,
        checked: new Date(week).toISOString().replace(".000Z", "Z"),
      });
    },

  "the linked ORCID iD gives the paper its author position, by iD alone, and linking or unlinking looks it up again":
    (sql, fixtures) => {
      const paper = record(sql, fixtures);
      const position = () => (synced(sql, paper.id) as { position?: number }).position;
      // No iD linked: the registry's iDs are never kept, and no position is guessed.
      equal(installLookup(sql, lookup(sql, paper.id, T0), { ...FOUND, orcids: IDS }, T0), "installed");
      same(Object.keys(synced(sql, paper.id) as object), [
        "doi",
        "title",
        "venue",
        "published",
        "authors",
        "citations",
        "checked",
      ]);

      // Linking the iD looks the paper up again at once, a week early, and the block says which author she is.
      const linked = T0 + 60_000;
      same(linkOrcid(sql, NADIA, [], linked), { proposed: 0 });
      const job = lookup(sql, paper.id, linked);
      equal(installLookup(sql, job, { ...FOUND, orcids: IDS }, linked + 500), "installed");
      equal(position(), 1);
      equal(lastActor(sql, paper.id), DOI_ACTOR);
      // The same iD again changes nothing, so nothing is looked up before the week is out.
      linkOrcid(sql, NADIA, [], linked + 1_000);
      same(dois(sql, linked + 1_000), []);

      // Unlinking looks it up again at once, without the iD: the position goes.
      unlinkOrcid(sql, linked + 2_000);
      equal(
        installLookup(sql, lookup(sql, paper.id, linked + 2_000), { ...FOUND, orcids: IDS }, linked + 2_000),
        "installed",
      );
      equal(position(), undefined);

      // Linked again. A week on, her name is still first but the registry no longer names her iD: a name never
      // stands in for it.
      linkOrcid(sql, NADIA, [], linked + 3_000);
      const install = (at: number, orcids: readonly (string | null)[]) =>
        equal(installLookup(sql, lookup(sql, paper.id, at), { ...FOUND, orcids }, at), "installed");
      install(linked + 3_000, IDS);
      equal(position(), 1);
      const week = (n: number) => linked + 3_000 + n * LOOKUP_MS;
      install(week(1), [null, AMARA]);
      equal(position(), undefined);
      install(week(2), IDS);
      equal(position(), 1);
      // Two authors with her iD is a registry's mistake: no position rather than a guess.
      install(week(3), [NADIA, NADIA]);
      equal(position(), undefined);
    },

  "a DOI nobody knows says so, and changing the DOI looks the new one up at once": (sql, fixtures) => {
    const paper = record(sql, fixtures);
    equal(installLookup(sql, lookup(sql, paper.id, T0), "missing", T0), "installed");
    same(synced(sql, paper.id), {
      doi: "10.5555/brainiac.swahili-ner.2026",
      missing: true,
      checked: "2026-11-15T00:00:00Z",
    });

    // The person fixes the typo: the block is for another DOI now, so it is due at once.
    const rev = getNote(sql, paper.id)?.rev ?? 0;
    const fixed = mutate(
      sql,
      {
        op: "patch",
        noteId: paper.id,
        baseRev: rev,
        ops: [{ op: "set", path: ["doi"], value: "10.5555/fixed" }],
      },
      human(T0 + 1),
    );
    equal(fixed.status, "applied");
    equal(installLookup(sql, lookup(sql, paper.id, T0 + 2), FOUND, T0 + 2), "installed");
    same(synced(sql, paper.id), { doi: "10.5555/fixed", ...FOUND, checked: "2026-11-15T00:00:00Z" });
  },

  "an edit while a lookup is out drops its result, and the paper is looked up again at its new revision": (
    sql,
    fixtures,
  ) => {
    const paper = record(sql, fixtures);
    const job = lookup(sql, paper.id, T0);
    const edit = mutate(
      sql,
      {
        op: "patch",
        noteId: paper.id,
        baseRev: 1,
        ops: [{ op: "section", heading: "Paper", content: "Accepted at the workshop.\n", level: 1 }],
      },
      human(T0 + 1),
    );
    equal(edit.status, "applied");
    equal(installLookup(sql, job, FOUND, T0 + 2), "dropped");
    equal(synced(sql, paper.id), undefined);
    const [next] = dois(sql, T0 + 3);
    equal(next?.rev, 2);
  },

  "a lookup that would change a block the person verified waits for them, and is tried again a week later": (
    sql,
    fixtures,
  ) => {
    const paper = record(sql, fixtures);
    equal(installLookup(sql, lookup(sql, paper.id, T0), FOUND, T0), "installed");
    // The person verifies the block, with their passkey.
    const verify = {
      op: "patch",
      noteId: paper.id,
      baseRev: 2,
      ops: [
        {
          op: "set",
          path: ["verified"],
          value: { by: "human", at: "2026-11-15", rev: 3, fields: ["synced"] },
        },
      ],
    } as const;
    const asked = mutate(sql, verify, human());
    ok(asked.status === "needsApproval", JSON.stringify(asked));
    const signature = { credentialId: "passkey-1", counter: 1, assertion: "{}" };
    const approved = recordApproval(sql, asked.items, signature, T0);
    ok("approvalId" in approved);
    equal(mutate(sql, verify, { ...human(), approvalId: approved.approvalId }).status, "applied");

    const week = T0 + LOOKUP_MS;
    const job = lookup(sql, paper.id, week);
    // More citations would change a verified value: refused, and the lookup is failed rather than repeated.
    equal(installLookup(sql, job, { ...FOUND, citations: 9 }, week), "dropped");
    same(synced(sql, paper.id), {
      doi: "10.5555/brainiac.swahili-ner.2026",
      ...FOUND,
      checked: "2026-11-15T00:00:00Z",
    });
    same(dois(sql, week + 1), []);
    same(
      dois(sql, week + LOOKUP_MS).map((j) => j.status),
      ["pending"],
    );
  },
};
