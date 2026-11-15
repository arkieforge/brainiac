// The GitHub connector against a stand-in GitHub and real Postgres (PGlite) with every migration deploys apply.
// What a repo does to a record is tested on both engines in packages/base/test/github-cases.ts.
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type { Repo } from "@brainiac/base";
import { importSPKI, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  installState,
  linked,
  setup,
  sweep,
  unlink,
  webhook,
  type Deps,
  type GithubApp,
  type GithubRecord,
} from "./github.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../../infra/migrations");
const T0 = Date.UTC(2026, 10, 15, 3);
const SECRET = "auth-secret-for-tests";
const NADIA = "user-nadia";
const BASE = "b".repeat(64);
const OTHER_BASE = "c".repeat(64);
const INSTALLATION = 4242;

// The App's key pair, as GitHub issues one (PKCS#8 once converted, as infra/README.md says).
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicKey = keys.publicKey;
const app: GithubApp = {
  slug: "brainiac-test",
  clientId: "Iv23liTestClient",
  clientSecret: "client-secret",
  privateKey: keys.privateKey,
  webhookSecret: "webhook-secret",
};

// The fixture student's repos (fictional), as GitHub's REST API describes them.
const apiRepo = (name: string, stars: number, extra: object = {}) => ({
  node_id: `R_kgDO${name}`,
  full_name: `nadia-karim/${name}`,
  html_url: `https://github.com/nadia-karim/${name}`,
  private: false,
  archived: false,
  stargazers_count: stars,
  language: "TypeScript",
  pushed_at: "2026-11-14T10:00:00Z",
  ...extra,
});

/** A stand-in for GitHub's API: the repo list with ETags, tokens, OAuth and the user's installations. */
class FakeGithub {
  repos: object[] = [apiRepo("library-seat-finder", 214)];
  /** Installations the signed-in GitHub user can reach. */
  reachable = [INSTALLATION];
  limited = new Set<number>();
  /** Installations on an organization rather than the user's own account. */
  organizations = new Set<number>();
  /** Repos on the installation that the signed-in GitHub user can't see. */
  hidden = new Set<string>();
  /** GitHub takes only `refresh-<this>` now; each sign-in or use issues the next. */
  refresh = 0;
  refreshes: string[] = [];
  requests: { url: string; headers: Headers }[] = [];
  jwts: string[] = [];

  etag = (page: number) =>
    `W/"${page}-${createHash("sha256").update(JSON.stringify(this.repos)).digest("hex").slice(0, 12)}"`;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    this.requests.push({ url: url.toString(), headers });
    const auth = headers.get("authorization") ?? "";
    const tokenFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (tokenFor) {
      this.jwts.push(auth.replace("Bearer ", ""));
      return Response.json({ token: `inst-${tokenFor[1]}` });
    }
    if (url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { code?: string; refresh_token?: string };
      if (body.refresh_token !== undefined) {
        this.refreshes.push(body.refresh_token);
        if (body.refresh_token !== `refresh-${this.refresh}`)
          return Response.json({ error: "bad_refresh_token" });
      } else if (body.code !== "good-code") return Response.json({ error: "bad_verification_code" });
      this.refresh++;
      return Response.json({ access_token: "user-token", refresh_token: `refresh-${this.refresh}` });
    }
    if (url.pathname === "/user") return Response.json({ id: 1001, login: "nadia-karim" });
    if (url.pathname === "/user/installations")
      return Response.json({
        total_count: this.reachable.length,
        installations: this.reachable.map((id) => ({
          id,
          account: this.organizations.has(id)
            ? { id: 2002, login: "seat-lab" }
            : { id: 1001, login: "nadia-karim" },
        })),
      });
    if (url.pathname === `/user/installations/${INSTALLATION}/repositories`) {
      if (auth !== "Bearer user-token" || !this.reachable.includes(INSTALLATION))
        return new Response("not found", { status: 404 });
      const visible = this.repos.filter((repo) => !this.hidden.has((repo as { node_id: string }).node_id));
      return Response.json({ total_count: visible.length, repositories: visible });
    }
    if (url.pathname === "/installation/repositories") {
      const installation = Number(auth.replace("Bearer inst-", ""));
      if (this.limited.has(installation))
        return new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      const page = Number(url.searchParams.get("page"));
      const per = Number(url.searchParams.get("per_page"));
      const etag = this.etag(page);
      if (headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
      return Response.json(
        { total_count: this.repos.length, repositories: this.repos.slice((page - 1) * per, page * per) },
        { headers: { etag } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  /** Requests for the repo list (each one counts against the rate limit unless it was a 304). */
  listings = () => this.requests.filter((r) => r.url.includes("/installation/repositories"));
}

/** Records as the connector sees them: what each one was told. */
class FakeRecords {
  readonly told = new Map<string, (Repo | { deleted: string })[]>();
  record = (baseId: string): GithubRecord => {
    const log = this.told.get(baseId) ?? [];
    this.told.set(baseId, log);
    return {
      githubRepos: async (repos) => void log.push(...repos),
      githubRepoDeleted: async (repoId) => void log.push({ deleted: repoId }),
    };
  };
}

let db: PGlite;
let gh: FakeGithub;
let records: FakeRecords;
let deps: Deps;

beforeEach(async () => {
  db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).toSorted())
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  await db.query(
    `insert into "user" ("id", "name", "email", "emailVerified") values ($1, 'Nadia Karim', 'nadia.karim@example.edu', true), ('user-other', 'Other', 'other@example.edu', true)`,
    [NADIA],
  );
  await db.query(`insert into "bases" ("id", "ownerId") values ($1, $2), ($3, 'user-other')`, [
    BASE,
    NADIA,
    OTHER_BASE,
  ]);
  gh = new FakeGithub();
  records = new FakeRecords();
  deps = { app, db, record: records.record, fetch: gh.fetch, now: () => T0, secret: SECRET };
});

async function link(installationId = INSTALLATION, baseId = BASE) {
  await db.query(
    `insert into "github_installations" ("id", "account") values ($1, 'nadia-karim') on conflict do nothing`,
    [installationId],
  );
  await db.query(`insert into "github_links" ("installationId", "baseId") values ($1, $2)`, [
    installationId,
    baseId,
  ]);
}

const setupUrl = async (params: Record<string, string>) => {
  const url = new URL("https://brainiac.test/connectors/github/setup");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
};

describe("linking an installation", () => {
  it("links only with the person's own state and a GitHub account that can reach the installation", async () => {
    const state = await installState(SECRET, NADIA);
    const person = { userId: NADIA, baseId: BASE };
    const go = async (params: Record<string, string>) =>
      (await setup(await setupUrl(params), person, deps)).headers.get("location");

    // Someone else's install link: its state is theirs.
    const theirs = await installState(SECRET, "user-other");
    expect(await go({ installation_id: `${INSTALLATION}`, code: "good-code", state: theirs })).toContain(
      "github=failed",
    );
    // A GitHub account that can't reach that installation.
    gh.reachable = [9999];
    expect(await go({ installation_id: `${INSTALLATION}`, code: "good-code", state })).toContain(
      "github=failed",
    );
    expect(await linked(db, BASE)).toEqual([]);
    expect(records.told.size).toBe(0);

    gh.reachable = [INSTALLATION];
    expect(await go({ installation_id: `${INSTALLATION}`, code: "good-code", state })).toContain(
      "github=connected",
    );
    expect(await linked(db, BASE)).toEqual([
      { id: INSTALLATION, account: "nadia-karim", checkedAt: null, suspended: false },
    ]);
    // Read in at once, into this record alone.
    expect(records.told.get(BASE)?.map((r) => ("name" in r ? r.name : r))).toEqual([
      "nadia-karim/library-seat-finder",
    ]);
    expect([...records.told.keys()]).toEqual([BASE]);
  });

  it("signs its App JWT with the App's key, as the App's client id, for under ten minutes", async () => {
    await link();
    await sweep(deps);
    const [jwt] = gh.jwts;
    if (!jwt) throw new Error("no JWT was sent");
    const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(publicKey, "RS256"), {
      currentDate: new Date(T0),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(app.clientId);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(600);
  });
});

describe("the daily sweep", () => {
  it("reads only pages that changed since the last sweep, by ETag", async () => {
    await link();
    expect(await sweep(deps)).toEqual({ swept: 1, failed: 0 });
    expect(records.told.get(BASE)).toHaveLength(1);

    // Nothing changed on GitHub: a 304, and the record isn't called.
    await sweep(deps);
    expect(gh.listings().at(-1)?.headers.get("if-none-match")).toBe(gh.etag(1));
    expect(records.told.get(BASE)).toHaveLength(1);

    // A star later, the page changed and comes back whole.
    gh.repos = [apiRepo("library-seat-finder", 215)];
    await sweep(deps);
    expect(records.told.get(BASE)?.at(-1)).toMatchObject({ stars: 215 });
    const { rows } = await db.query<{ checkedAt: Date }>(`select "checkedAt" from "github_installations"`);
    expect(rows[0]?.checkedAt?.getTime()).toBe(T0);
  });

  it("walks every page of a big installation, and asks again only for the ones it had", async () => {
    gh.repos = Array.from({ length: 150 }, (_, i) => apiRepo(`repo-${i}`, i));
    await link();
    await sweep(deps);
    expect(records.told.get(BASE)).toHaveLength(150);
    expect(gh.listings()).toHaveLength(2);
    await sweep(deps);
    // Both pages unchanged: two 304s, nothing told.
    expect(gh.listings()).toHaveLength(4);
    expect(records.told.get(BASE)).toHaveLength(150);
  });

  it("logs a rate-limited installation and carries on with the rest", async () => {
    await link(INSTALLATION);
    await link(7777, OTHER_BASE);
    gh.limited.add(INSTALLATION);
    expect(await sweep(deps)).toEqual({ swept: 1, failed: 1 });
    expect(records.told.get(OTHER_BASE)).toHaveLength(1);
    expect(records.told.get(BASE)).toBeUndefined();
  });

  it("skips suspended installations and ones no record links", async () => {
    await link();
    await db.query(`insert into "github_installations" ("id", "account") values (8888, 'nobody')`);
    await db.query(`update "github_installations" set "suspended" = true where "id" = $1`, [INSTALLATION]);
    expect(await sweep(deps)).toEqual({ swept: 0, failed: 0 });
    expect(gh.requests).toEqual([]);
  });
});

/** GitHub's `x-hub-signature-256` for a body. */
const sign = async (body: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(mac).toString("hex")}`;
};

/** One signed delivery, as GitHub sends it. */
const deliver = async (event: string, payload: object, secret = app.webhookSecret) => {
  const body = JSON.stringify(payload);
  return webhook(
    new Request("https://brainiac.test/connectors/github/webhook", {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": await sign(body, secret) },
      body,
    }),
    deps,
  );
};

describe("webhooks", () => {
  const installation = { id: INSTALLATION };

  it("refuses a delivery GitHub didn't sign", async () => {
    await link();
    const forged = await deliver(
      "star",
      { action: "created", installation, repository: apiRepo("x", 1) },
      "guess",
    );
    expect(forged.status).toBe(401);
    expect(records.told.size).toBe(0);
  });

  it("carries a star and a rename to every record linked to the installation, and no other", async () => {
    await link(INSTALLATION, BASE);
    await link(INSTALLATION, OTHER_BASE);
    await link(7777, "d".repeat(64)).catch(() => undefined);
    await deliver("star", {
      action: "created",
      installation,
      repository: apiRepo("library-seat-finder", 215),
    });
    await deliver("repository", {
      action: "renamed",
      installation,
      repository: apiRepo("seat-finder", 215, { node_id: "R_kgDOlibrary-seat-finder" }),
    });
    for (const base of [BASE, OTHER_BASE])
      expect(records.told.get(base)?.map((r) => ("id" in r ? [r.id, r.name, r.stars] : r))).toEqual([
        ["R_kgDOlibrary-seat-finder", "nadia-karim/library-seat-finder", 215],
        ["R_kgDOlibrary-seat-finder", "nadia-karim/seat-finder", 215],
      ]);
    // An installation nobody linked reaches nothing.
    await deliver("star", { action: "created", installation: { id: 5555 }, repository: apiRepo("x", 1) });
    expect([...records.told.keys()].toSorted()).toEqual([BASE, OTHER_BASE]);
  });

  it("marks a deleted repo, reads in added ones, and forgets an uninstalled installation", async () => {
    await link();
    await deliver("repository", {
      action: "deleted",
      installation,
      repository: apiRepo("library-seat-finder", 214),
    });
    expect(records.told.get(BASE)).toEqual([{ deleted: "R_kgDOlibrary-seat-finder" }]);

    gh.repos = [apiRepo("library-seat-finder", 214), apiRepo("thesis-notes", 0, { private: true })];
    await deliver("installation_repositories", {
      action: "added",
      installation,
      repositories_added: [{ node_id: "R_kgDOthesis-notes" }],
    });
    expect(
      records.told
        .get(BASE)
        ?.slice(1)
        .map((r) => ("private" in r ? r.private : r)),
    ).toEqual([false, true]);

    await deliver("installation", { action: "deleted", installation });
    expect(await linked(db, BASE)).toEqual([]);
  });

  it("stops and resumes with suspension", async () => {
    await link();
    await deliver("installation", { action: "suspend", installation });
    expect((await linked(db, BASE))[0]?.suspended).toBe(true);
    await deliver("installation", { action: "unsuspend", installation });
    expect((await linked(db, BASE))[0]?.suspended).toBe(false);
  });
});

/** What a record was told, by repo name. */
const names = (base = BASE) => records.told.get(base)?.map((r) => ("name" in r ? r.name : r)) ?? [];

describe("an organization's installation", () => {
  // The fixture student's lab group (fictional): one repo she works on, one she was never given.
  const team = apiRepo("seat-sensor-firmware", 12, {
    private: true,
    full_name: "seat-lab/seat-sensor-firmware",
  });
  const secret = apiRepo("grant-budget", 0, { private: true, full_name: "seat-lab/grant-budget" });
  const installation = { id: INSTALLATION };

  async function connect() {
    const url = await setupUrl({
      installation_id: `${INSTALLATION}`,
      code: "good-code",
      state: await installState(SECRET, NADIA),
    });
    return (await setup(url, { userId: NADIA, baseId: BASE }, deps)).headers.get("location");
  }

  beforeEach(() => {
    gh.organizations.add(INSTALLATION);
    gh.repos = [team, secret];
    gh.hidden.add(secret.node_id);
  });

  it("links, and reads in only the repos the person can see there, by sweep or webhook", async () => {
    expect(await connect()).toContain("github=connected");
    expect(names()).toEqual(["seat-lab/seat-sensor-firmware"]);
    expect(await linked(db, BASE)).toEqual([
      {
        id: INSTALLATION,
        account: "seat-lab",
        checkedAt: new Date(T0),
        suspended: false,
        member: { repos: ["seat-lab/seat-sensor-firmware"], lapsed: false },
      },
    ]);
    // Her sign-in is kept sealed, never as GitHub's token.
    const { rows } = await db.query<{ grant: string }>(`select "grant" from "github_links"`);
    expect(rows[0]?.grant).not.toContain("refresh-");

    // Webhooks and sweeps alike: the hidden repo never reaches her record.
    await deliver("star", {
      action: "created",
      installation,
      repository: { ...secret, stargazers_count: 3 },
    });
    await deliver("repository", { action: "deleted", installation, repository: secret });
    await deliver("installation_repositories", { action: "added", installation, repositories_added: [] });
    expect(await sweep(deps)).toEqual({ swept: 1, failed: 0 });
    expect(names()).toEqual(["seat-lab/seat-sensor-firmware"]);
    // Nothing changed for her, so the record wasn't called; the installation's own list wasn't asked for.
    expect(gh.listings()).toEqual([]);

    // A star on her repo reaches her.
    await deliver("star", { action: "created", installation, repository: { ...team, stargazers_count: 13 } });
    expect(records.told.get(BASE)?.at(-1)).toMatchObject({ stars: 13 });

    // Once she is given the other repo on GitHub, the next sweep reads it in, and only it.
    gh.hidden.clear();
    await sweep(deps);
    expect(names().at(-1)).toBe("seat-lab/grant-budget");
    expect((await linked(db, BASE))[0]?.member?.repos).toEqual([
      "seat-lab/grant-budget",
      "seat-lab/seat-sensor-firmware",
    ]);
  });

  it("stops reading a repo she lost access to", async () => {
    gh.hidden.clear();
    await connect();
    expect(names()).toHaveLength(2);
    gh.hidden.add(secret.node_id);
    await sweep(deps);
    await deliver("star", {
      action: "created",
      installation,
      repository: { ...secret, stargazers_count: 9 },
    });
    gh.repos = [team, { ...secret, stargazers_count: 10 }];
    await sweep(deps);
    expect(names()).toHaveLength(2);
    expect((await linked(db, BASE))[0]?.member?.repos).toEqual(["seat-lab/seat-sensor-firmware"]);
  });

  it("renews her sign-in each sweep, and reads nothing once GitHub refuses it, until she connects again", async () => {
    await connect();
    await sweep(deps);
    await sweep(deps);
    // Each refresh token is used once, and the next one kept.
    expect(gh.refreshes).toEqual(["refresh-1", "refresh-2"]);

    // She revoked the app on GitHub, or six months passed.
    gh.refresh = 99;
    expect(await sweep(deps)).toEqual({ swept: 1, failed: 0 });
    expect((await linked(db, BASE))[0]?.member).toEqual({ repos: [], lapsed: true });
    await deliver("star", { action: "created", installation, repository: { ...team, stargazers_count: 50 } });
    const before = gh.requests.length;
    expect(await sweep(deps)).toEqual({ swept: 0, failed: 0 });
    expect(gh.requests).toHaveLength(before);
    expect(records.told.get(BASE)?.some((r) => "stars" in r && r.stars === 50)).toBe(false);

    expect(await connect()).toContain("github=connected");
    expect((await linked(db, BASE))[0]?.member?.lapsed).toBe(false);
  });

  it("reads nothing once she can't reach the installation at all", async () => {
    await connect();
    gh.reachable = [];
    await sweep(deps);
    expect((await linked(db, BASE))[0]?.member?.repos).toEqual([]);
    await deliver("star", { action: "created", installation, repository: { ...team, stargazers_count: 40 } });
    expect(names()).toEqual(["seat-lab/seat-sensor-firmware"]);
  });

  it("keeps a member's link and the owner's whole link apart on one installation", async () => {
    await connect();
    await link(INSTALLATION, OTHER_BASE);
    await deliver("star", {
      action: "created",
      installation,
      repository: { ...secret, stargazers_count: 4 },
    });
    expect(names(OTHER_BASE)).toEqual(["seat-lab/grant-budget"]);
    expect(names()).toEqual(["seat-lab/seat-sensor-firmware"]);
  });
});

describe("disconnecting", () => {
  it("unlinks only this record; the installation keeps feeding the others", async () => {
    await link(INSTALLATION, BASE);
    await link(INSTALLATION, OTHER_BASE);
    await unlink(db, BASE, INSTALLATION);
    expect(await linked(db, BASE)).toEqual([]);
    expect(await linked(db, OTHER_BASE)).toHaveLength(1);
    await sweep(deps);
    expect(records.told.get(BASE)).toBeUndefined();
    expect(records.told.get(OTHER_BASE)).toHaveLength(1);
  });
});
