// The ORCID connector's side of the record (docs/product/features/projects-profiles-links.md). The Worker proves
// the person's iD through ORCID's own sign-in and reads their public works (apps/worker/src/connectors/orcid.ts);
// this file keeps the iD and decides what the works do, with no I/O. Like every connector (contract §3), it only
// proposes: each work the record doesn't have yet becomes a proposed Paper, once. The iD itself only ever comes
// from ORCID's answer, so a paper's author position (papers.ts) is matched against an iD the person proved.
import { patch, ulid } from "@brainiac/core";

import type { Connection } from "./connections.ts";
import { mutate } from "./mutate.ts";
import { freePath } from "./notes.ts";
import type { Sql } from "./sql.ts";

/** Who the connector's proposals are recorded as. Not a connection: nothing can grant it more. */
export const ORCID_ACTOR = "connector:orcid";

/** Proposes at the floor. A paper is a normal note. */
const ORCID: Connection = {
  id: "orcid",
  kind: "connector",
  oauthClientId: null,
  level: "propose",
  sensitive: false,
  holdDays: 0,
  rev: 0,
  createdAt: 0,
};

/** One of the person's works, as their ORCID record lists it. */
export interface Work {
  /** ORCID's id for the work on that record. */
  readonly putCode: string;
  readonly title: string;
  readonly doi?: string;
}

/** A DOI as registries take it (`10.5555/12345678`), from a bare DOI, `doi:` or a doi.org link. */
export function bareDoi(text: string): string | undefined {
  const doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "");
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

/** An ORCID iD (`0000-0002-1825-0097`) from a bare iD or an orcid.org link, as registries write it. */
export function bareOrcid(text: string): string | undefined {
  return /(?:^|\/)(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i.exec(text.trim())?.[1]?.toUpperCase();
}

const meta = (sql: Sql, key: string) =>
  sql.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;

const setMeta = (sql: Sql, key: string, value: string) =>
  sql.all(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );

/** The ORCID iD the person linked, if any. */
export const linkedOrcid = (sql: Sql): string | undefined => meta(sql, "orcid");

/**
 * When the linked iD last changed (linked, replaced or unlinked), to the second, or 0 if never: a paper looked up
 * before then is looked up again, so its author position follows the iD (papers.ts).
 */
export const orcidChangedAt = (sql: Sql): number => Number(meta(sql, "orcidChangedAt") ?? 0);

function setOrcid(sql: Sql, orcid: string | undefined, now: number): void {
  if (orcid === linkedOrcid(sql)) return;
  if (orcid === undefined) sql.all("DELETE FROM meta WHERE key = 'orcid'");
  else setMeta(sql, "orcid", orcid);
  // Seconds, as a paper's `synced.checked` is written, so a lookup in the same second still counts as after.
  setMeta(sql, "orcidChangedAt", String(Math.floor(now / 1000) * 1000));
}

const plain = (text: string) => text.toLowerCase().replaceAll(/\s+/g, " ").trim();

/**
 * What a work is known by across reads: its put-code, and its DOI when it has one. Either one seen before means
 * proposed before, so a work that gains a DOI after the person turned it down stays turned down.
 */
const keysOf = (work: Work, doi: string | undefined) => [
  `put:${work.putCode}`,
  ...(doi === undefined ? [] : [`doi:${doi.toLowerCase()}`]),
];

/** Proposes a Paper for a work. Returns the proposal's id. */
function proposePaper(sql: Sql, work: Work, doi: string | undefined, now: number): string | undefined {
  const id = ulid(now);
  const raw = patch("", [
    { op: "set", path: ["id"], value: id },
    { op: "set", path: ["type"], value: "Paper" },
    { op: "set", path: ["title"], value: work.title },
    ...(doi === undefined ? [] : [{ op: "set" as const, path: ["doi"], value: doi }]),
  ]);
  const result = mutate(
    sql,
    { op: "create", path: freePath(sql, "Paper", work.title, id), raw, class: "normal" },
    { actor: ORCID_ACTOR, now, connection: ORCID },
  );
  return result.status === "proposed" ? result.proposalId : undefined;
}

/**
 * Links the iD ORCID proved, and proposes each of its works the record doesn't have yet: no live paper with its
 * DOI (or, for a work without one, its title), and never proposed before. A work the person turned down, or whose
 * paper they deleted, is left alone: they said no.
 */
export function linkOrcid(
  sql: Sql,
  orcid: string,
  works: readonly Work[],
  now: number,
): { readonly proposed: number } {
  setOrcid(sql, orcid, now);
  const papers = sql.all<{ doi: string | null; title: string | null }>(
    "SELECT fm ->> '$.doi' AS doi, title FROM notes WHERE type = 'Paper' AND deletedAt IS NULL",
  );
  const dois = new Set(papers.flatMap((paper) => [bareDoi(paper.doi ?? "")?.toLowerCase() ?? []].flat()));
  const titles = new Set(papers.map((paper) => plain(paper.title ?? "")));
  let proposed = 0;
  for (const work of works) {
    const doi = bareDoi(work.doi ?? "");
    const keys = keysOf(work, doi);
    if (doi === undefined ? titles.has(plain(work.title)) : dois.has(doi.toLowerCase())) continue;
    const remember = (proposalId: string) => {
      for (const key of keys)
        sql.all("INSERT OR IGNORE INTO orcid_works (key, proposalId) VALUES (?, ?)", key, proposalId);
    };
    const [seen] = keys.flatMap((key) =>
      sql.all<{ proposalId: string }>("SELECT proposalId FROM orcid_works WHERE key = ?", key),
    );
    // Seen under one of its keys: the others it has now are the same work too, wherever they turn up next.
    if (seen) {
      remember(seen.proposalId);
      continue;
    }
    sql.transaction(() => {
      const proposalId = proposePaper(sql, work, doi, now);
      if (proposalId === undefined) return;
      remember(proposalId);
      proposed++;
    });
  }
  return { proposed };
}

/** Forgets the iD. Every paper is looked up again at once, without it, so the positions it gave go; the papers stay. */
export function unlinkOrcid(sql: Sql, now: number): void {
  setOrcid(sql, undefined, now);
}
