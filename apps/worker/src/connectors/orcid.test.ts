// The ORCID connector against a stand-in ORCID (sandbox URLs, as every non-prod stage uses). What the iD and the
// works do to a record is tested on both engines in packages/base/test/orcid-cases.ts and papers-cases.ts.
import type { Work } from "@brainiac/base";
import { SignJWT } from "jose";
import { expect, it } from "vite-plus/test";

import { callback, linkUrl, type Deps, type OrcidApp } from "./orcid.ts";

const T0 = Date.UTC(2026, 10, 15, 3);
const SECRET = "auth-secret-for-tests";
const NADIA = "user-nadia";
// The fixture student's iD: outside the ranges ORCID issues, so nobody's.
const ORCID = "0000-0000-0000-0001";
const SITE = new URL("https://brainiac.test/account");
const ISSUER = "https://sandbox.orcid.org";

const app: OrcidApp = {
  clientId: "APP-TESTCLIENT0001",
  clientSecret: "client-secret",
  issuer: ISSUER,
  api: "https://pub.sandbox.orcid.org/v3.0",
};

const idToken = (claims: { iss?: string; aud?: string; sub?: string } = {}) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? app.clientId)
    .setSubject(claims.sub ?? ORCID)
    .sign(new TextEncoder().encode("orcid-signs-with-its-own-key"));

const doi = (value: string, relationship = "self") => ({
  "external-id-type": "doi",
  "external-id-value": value,
  "external-id-relationship": relationship,
});

// Her works as ORCID's public API lists them (fictional): one group per work.
const WORKS = {
  group: [
    {
      "external-ids": { "external-id": [doi("10.5555/brainiac.swahili-ner.2026")] },
      "work-summary": [
        {
          "put-code": 101,
          title: { title: { value: "Named Entity Recognition for Low-Resource Swahili News" } },
          type: "journal-article",
        },
      ],
    },
    {
      // A dataset isn't a paper.
      "external-ids": { "external-id": [doi("10.5555/brainiac.swahili-corpus")] },
      "work-summary": [
        { "put-code": 102, title: { title: { value: "Swahili News Corpus" } }, type: "data-set" },
      ],
    },
    {
      // The DOI of the proceedings it is part of isn't the poster's own.
      "external-ids": { "external-id": [doi("10.5555/brainiac.proceedings", "part-of")] },
      "work-summary": [
        {
          "put-code": 103,
          title: { title: { value: " Tokenizing Swahili Morphology " } },
          type: "conference-poster",
        },
      ],
    },
  ],
};

/** A stand-in for ORCID's token endpoint and public API; every request it got is in `asked`. */
function orcid(answers: { token?: object | number; works?: object | number } = {}) {
  const asked: { url: string; body?: string; authorization?: string | null }[] = [];
  const fetch: Deps["fetch"] = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    asked.push({
      url,
      ...(init?.body && { body: String(init.body) }),
      authorization: headers.get("authorization"),
    });
    const answer =
      url === `${ISSUER}/oauth/token`
        ? (answers.token ?? {
            access_token: "access",
            id_token: await idToken(),
            orcid: ORCID,
            name: "Nadia",
          })
        : url === `${app.api}/${ORCID}/works`
          ? (answers.works ?? WORKS)
          : 404;
    return typeof answer === "number" ? new Response(null, { status: answer }) : Response.json(answer);
  };
  return { deps: { app, fetch, now: () => T0 + 60_000 }, asked };
}

/** A record that keeps what it was asked to link. */
function record() {
  const links: { orcid: string; works: readonly Work[] }[] = [];
  return {
    links,
    record: {
      linkOrcid: async (id: string, works: readonly Work[]) => {
        links.push({ orcid: id, works });
        return { proposed: works.length };
      },
    },
  };
}

/** The sign-in link for `userId`, and ORCID sending the person back with `code`. */
async function signIn(userId = NADIA, at = T0) {
  const link = new URL(await linkUrl(app, SITE, SECRET, userId, at));
  const back = new URL("/connectors/orcid/callback", SITE);
  back.searchParams.set("code", "one-time-code");
  back.searchParams.set("state", link.searchParams.get("state") ?? "");
  return { link, back };
}

const outcome = (response: Response) =>
  new URL(response.headers.get("location") ?? "").searchParams.get("orcid");

it("links the iD ORCID's own answer names, and brings the person's papers as works, each with its own DOI", async () => {
  const { link, back } = await signIn();
  expect(`${link.origin}${link.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
  // Only who the person is: nothing on their ORCID record can be changed through this client.
  expect(Object.fromEntries(link.searchParams)).toMatchObject({
    client_id: app.clientId,
    response_type: "code",
    scope: "openid",
    redirect_uri: "https://brainiac.test/connectors/orcid/callback",
  });

  const { deps, asked } = orcid();
  const { links, record: base } = record();
  const response = await callback(back, { userId: NADIA, record: base }, SECRET, deps);
  expect(response.status).toBe(303);
  expect(outcome(response)).toBe("linked");
  expect(links).toEqual([
    {
      orcid: ORCID,
      works: [
        {
          putCode: "101",
          title: "Named Entity Recognition for Low-Resource Swahili News",
          doi: "10.5555/brainiac.swahili-ner.2026",
        },
        { putCode: "103", title: "Tokenizing Swahili Morphology" },
      ],
    },
  ]);
  const [token, works] = asked;
  expect(Object.fromEntries(new URLSearchParams(token?.body))).toEqual({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: "authorization_code",
    code: "one-time-code",
    redirect_uri: "https://brainiac.test/connectors/orcid/callback",
  });
  expect(works).toMatchObject({ url: `${app.api}/${ORCID}/works`, authorization: "Bearer access" });
});

it("links nothing for a sign-in someone else started, one that ran out, or an ID token that isn't ORCID's for us", async () => {
  const { deps, asked } = orcid();
  const { links, record: base } = record();
  const person = { userId: NADIA, record: base };
  // Started by another account: ORCID is never even asked.
  expect(outcome(await callback((await signIn("user-mallory")).back, person, SECRET, deps))).toBe("failed");
  // Started more than ten minutes ago.
  expect(outcome(await callback((await signIn(NADIA, T0 - 10 * 60_000)).back, person, SECRET, deps))).toBe(
    "failed",
  );
  const forged = new URL((await signIn()).back);
  forged.searchParams.set("state", `${T0}.${"0".repeat(64)}`);
  expect(outcome(await callback(forged, person, SECRET, deps))).toBe("failed");
  expect(asked).toEqual([]);

  // The person said no on ORCID.
  const denied = new URL("/connectors/orcid/callback?error=access_denied", SITE);
  expect(outcome(await callback(denied, person, SECRET, deps))).toBe("denied");

  // An ID token for another client, or from another issuer, names nobody here.
  for (const claims of [{ aud: "APP-SOMEONEELSE" }, { iss: "https://orcid.example" }]) {
    const token = { access_token: "access", id_token: await idToken(claims), orcid: ORCID };
    const response = await callback((await signIn()).back, person, SECRET, orcid({ token }).deps);
    expect(outcome(response)).toBe("failed");
  }
  // A code ORCID refuses.
  expect(outcome(await callback((await signIn()).back, person, SECRET, orcid({ token: 400 }).deps))).toBe(
    "failed",
  );
  expect(links).toEqual([]);
});

it("links the iD even when the works can't be read, so linking again brings them", async () => {
  const { links, record: base } = record();
  const response = await callback(
    (await signIn()).back,
    { userId: NADIA, record: base },
    SECRET,
    orcid({ works: 503 }).deps,
  );
  expect(outcome(response)).toBe("linked");
  expect(links).toEqual([{ orcid: ORCID, works: [] }]);
});
