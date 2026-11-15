// Conformance cases for drift checks, the record's half: a profile is read once when it's added and again only when
// the person asks, at most once a day; nothing from a profile not shown to be theirs is kept; a blocked read is
// unchecked; nothing loops. cases.ts runs them on both engines.
import { deepStrictEqual as same, equal, ok } from "node:assert/strict";

import { ownershipCode, parseNote, ulid } from "@brainiac/core";

import {
  CHECK_CACHE_MS,
  dueJobs,
  getNote,
  installProfile,
  jobInput,
  markDispatched,
  migrate,
  mutate,
  nextWake,
  profileWork,
  PROFILES_ACTOR,
  recordApproval,
  requestChecks,
  type Context,
  type Sql,
} from "../src/index.ts";
import type { Case, Fixture } from "./cases.ts";

const T0 = Date.UTC(2026, 10, 15);
const PROFILE = "profiles/linkedin.md";
const PAPER = "facts/papers/swahili-ner-2026.md";
const URL = "https://www.linkedin.com/in/brainiac-fixture-nadia";
const human = (now = T0): Context => ({ actor: "human", now });
const iso = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

function record(sql: Sql, fixtures: readonly Fixture[], paths = [PROFILE]) {
  migrate(sql);
  const manifest = fixtures.find((f) => f.path === "okf-base.yaml");
  ok(manifest);
  sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest.raw);
  return paths.map((path) => {
    const fixture = fixtures.find((f) => f.path === path);
    ok(fixture, path);
    const created = mutate(sql, { op: "create", path, raw: fixture.raw, class: "normal" }, human());
    ok(created.status === "applied", JSON.stringify(created));
    return { id: created.noteId, raw: fixture.raw };
  });
}

const drifts = (sql: Sql, now: number) => dueJobs(sql, now).filter((j) => j.kind === "drift");

/** The profile's read due at `now`, dispatched, as the consumer gets it. */
function read(sql: Sql, id: string, now: number) {
  const job = drifts(sql, now).find((j) => j.noteId === id);
  ok(job, "no drift job");
  markDispatched(sql, [job.id], now);
  const input = jobInput(sql, job.id);
  ok(input && "note" in input);
  return { id: job.id, work: profileWork(sql, input.note) };
}

const synced = (sql: Sql, id: string) => parseNote(getNote(sql, id)?.raw ?? "").data["synced"];
const lastActor = (sql: Sql, id: string) =>
  sql.all<{ actor: string }>("SELECT actor FROM revisions WHERE noteId = ? ORDER BY rev DESC LIMIT 1", id)[0]
    ?.actor;

const edit = (sql: Sql, id: string, path: string, value: string, now: number) => {
  const rev = getNote(sql, id)?.rev ?? 0;
  const result = mutate(
    sql,
    { op: "patch", noteId: id, baseRev: rev, ops: [{ op: "set", path: [path], value }] },
    human(now),
  );
  equal(result.status, "applied");
};

export const profilesCases: Record<string, Case> = {
  "a new profile is read once, keeps nothing until it shows its code, then keeps what it says": (
    sql,
    fixtures,
  ) => {
    const [profile] = record(sql, fixtures);
    ok(profile);
    const code = ownershipCode(profile.id);
    // Added: due now, and the record wakes for it.
    equal(nextWake(sql, T0 + 5), T0 + 5);
    const first = read(sql, profile.id, T0);
    // Only the link and the code leave the record.
    same(first.work, { site: "linkedin", url: URL, code });
    same(drifts(sql, T0), []);

    // The profile doesn't show the code: it may be someone else's, so nothing it says is kept.
    equal(
      installProfile(sql, first.id, { says: { name: "Someone", headline: "Their headline" } }, T0),
      "installed",
    );
    same(synced(sql, profile.id), { url: URL, code, owned: false, checked: iso(T0) });
    equal(lastActor(sql, profile.id), PROFILES_ACTOR);
    // Read once: nothing is due by itself again, and the person's fields and body are byte for byte as they were.
    same(drifts(sql, T0 + CHECK_CACHE_MS * 30), []);
    ok(getNote(sql, profile.id)?.raw.startsWith(profile.raw.slice(0, profile.raw.indexOf("---\n#"))));
    ok(getNote(sql, profile.id)?.raw.endsWith(profile.raw.slice(profile.raw.indexOf("---\n#"))));

    // The person adds the code to their about and asks again: proving it is never held back by the day's cache.
    same(requestChecks(sql, T0 + 60_000), { checking: 1, cached: 0 });
    const second = read(sql, profile.id, T0 + 60_000);
    const says = { name: "Nadia Karim", headline: "BSc student", about: `NLP for Swahili. ${code}` };
    equal(installProfile(sql, second.id, { says }, T0 + 60_000), "installed");
    same(synced(sql, profile.id), { url: URL, code, owned: true, says, checked: iso(T0 + 60_000) });
  },

  "asking again within a day keeps the answer; after a day, or for a new link, it reads again": (
    sql,
    fixtures,
  ) => {
    const [profile] = record(sql, fixtures);
    ok(profile);
    const code = ownershipCode(profile.id);
    equal(installProfile(sql, read(sql, profile.id, T0).id, { says: { about: code } }, T0), "installed");

    same(requestChecks(sql, T0 + CHECK_CACHE_MS - 1), { checking: 0, cached: 1 });
    same(drifts(sql, T0 + CHECK_CACHE_MS - 1), []);
    same(requestChecks(sql, T0 + CHECK_CACHE_MS), { checking: 1, cached: 0 });
    // Asked twice while the read is out: one read.
    same(requestChecks(sql, T0 + CHECK_CACHE_MS + 1), { checking: 1, cached: 0 });
    const again = read(sql, profile.id, T0 + CHECK_CACHE_MS);
    // Still owned without the code: once shown at this link, the profile stays the person's.
    equal(installProfile(sql, again.id, { says: { name: "Nadia Karim" } }, T0 + CHECK_CACHE_MS), "installed");
    equal((synced(sql, profile.id) as Record<string, unknown>)["owned"], true);

    // A new link is a new profile: read at once, and shown to be theirs again.
    edit(
      sql,
      profile.id,
      "url",
      "https://www.linkedin.com/in/brainiac-fixture-nadia-2",
      T0 + CHECK_CACHE_MS + 2,
    );
    const moved = read(sql, profile.id, T0 + CHECK_CACHE_MS + 3);
    equal(
      installProfile(sql, moved.id, { says: { name: "Nadia Karim" } }, T0 + CHECK_CACHE_MS + 3),
      "installed",
    );
    equal((synced(sql, profile.id) as Record<string, unknown>)["owned"], false);
  },

  "a blocked read is unchecked, keeps no old answer, and can be asked again at once": (sql, fixtures) => {
    const [profile] = record(sql, fixtures);
    ok(profile);
    const code = ownershipCode(profile.id);
    const says = { name: "Nadia Karim", about: code };
    equal(installProfile(sql, read(sql, profile.id, T0).id, { says }, T0), "installed");
    same(requestChecks(sql, T0 + CHECK_CACHE_MS), { checking: 1, cached: 0 });
    const blocked = read(sql, profile.id, T0 + CHECK_CACHE_MS);
    equal(installProfile(sql, blocked.id, { unchecked: "the read was refused (403)" }, T0 + 1), "installed");
    same(synced(sql, profile.id), {
      url: URL,
      code,
      owned: true,
      unchecked: "the read was refused (403)",
      checked: iso(T0 + 1),
    });
    same(requestChecks(sql, T0 + 2), { checking: 1, cached: 0 });
  },

  "an edit while a read is out drops its answer, and the profile is read again at its new revision": (
    sql,
    fixtures,
  ) => {
    const [profile] = record(sql, fixtures);
    ok(profile);
    const job = read(sql, profile.id, T0);
    edit(sql, profile.id, "headline", "MSc applicant", T0 + 1);
    equal(installProfile(sql, job.id, { says: { name: "Nadia Karim" } }, T0 + 2), "dropped");
    equal(synced(sql, profile.id), undefined);
    equal(drifts(sql, T0 + 3)[0]?.rev, 2);
  },

  "a read the record refuses (the person verified the block) fails, and waits for the person to ask": (
    sql,
    fixtures,
  ) => {
    const [profile] = record(sql, fixtures);
    ok(profile);
    const code = ownershipCode(profile.id);
    equal(installProfile(sql, read(sql, profile.id, T0).id, { says: { about: code } }, T0), "installed");
    const verify = {
      op: "patch",
      noteId: profile.id,
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
    const approved = recordApproval(
      sql,
      asked.items,
      { credentialId: "passkey-1", counter: 1, assertion: "{}" },
      T0,
    );
    ok("approvalId" in approved);
    equal(mutate(sql, verify, { ...human(), approvalId: approved.approvalId }).status, "applied");

    same(requestChecks(sql, T0 + CHECK_CACHE_MS), { checking: 1, cached: 0 });
    const job = read(sql, profile.id, T0 + CHECK_CACHE_MS);
    equal(
      installProfile(sql, job.id, { says: { about: `${code} changed` } }, T0 + CHECK_CACHE_MS),
      "dropped",
    );
    same(drifts(sql, T0 + CHECK_CACHE_MS * 9), []);
    // The person asks again: tried again.
    same(requestChecks(sql, T0 + CHECK_CACHE_MS * 9), { checking: 1, cached: 0 });
  },

  "Google Scholar is searched for the record's own papers, never a sensitive one, and cached until they change":
    (sql, fixtures) => {
      const [paper] = record(sql, fixtures, [PAPER]);
      ok(paper);
      const secret = mutate(
        sql,
        {
          op: "create",
          path: "facts/papers/under-review.md",
          raw: `---\nid: ${ulid()}\ntype: Paper\ntitle: A paper under double-blind review\n---\n`,
          class: "sensitive",
        },
        human(),
      );
      equal(secret.status, "applied");
      const url = "https://scholar.google.com/citations?user=fixture";
      const scholar = mutate(
        sql,
        {
          op: "create",
          path: "profiles/scholar.md",
          raw: `---\nid: ${ulid()}\ntype: Profile\nsite: scholar\nurl: ${url}\n---\n`,
          class: "normal",
        },
        human(),
      );
      ok(scholar.status === "applied");
      const job = read(sql, scholar.noteId, T0);
      const title = "Named Entity Recognition for Low-Resource Swahili News";
      same(job.work, { site: "scholar", url, papers: [{ id: paper.id, title }] });
      const papers = { [paper.id]: { title, says: 2025 } };
      equal(installProfile(sql, job.id, { papers }, T0), "installed");
      same(synced(sql, scholar.noteId), { url, papers, checked: iso(T0) });

      same(requestChecks(sql, T0 + 1), { checking: 0, cached: 1 });
      // A new paper hasn't been searched for: asking reads again.
      const added = mutate(
        sql,
        {
          op: "create",
          path: "facts/papers/second.md",
          raw: `---\nid: ${ulid()}\ntype: Paper\ntitle: A Second Paper\n---\n`,
          class: "normal",
        },
        human(T0 + 2),
      );
      equal(added.status, "applied");
      same(requestChecks(sql, T0 + 3), { checking: 1, cached: 0 });
    },
};
