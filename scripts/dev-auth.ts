#!/usr/bin/env node
// Signs people and agents in to a dev stage as the fictional fixture student, like T3 Code's `t3 auth pairing
// create` and `t3 auth session issue` (apps/worker/src/dev.ts serves the other end):
//   vp run dev:sign-in --stage pr-12 [--as <tag>] [--next /path]   a link that signs a browser in; open it once
//   vp run dev:token --stage pr-12 [--as <tag>]                     an access token for that stage's /mcp
// Both first fill a new account's empty record with the fixture student's notes (fixtures/nadia), so whoever
// signs in tests against a real record, not an empty one; `--empty` skips that. `--stage local` is `vp run dev`.
// `--as` picks a separate fixture account (nadia.karim+<tag>@example.edu). Prod has no dev sign-in, so this
// refuses it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Seeded } from "../apps/worker/src/dev.ts";
import { stageOrigin } from "./doctor.ts";
import { secret } from "./logs.ts";

/** The dev sign-in link for a stage, token included. Treat it like a password. */
export async function signInLink(
  stage: string,
  opts: { as?: string | undefined; next?: string | undefined } = {},
) {
  if (stage === "prod") throw new Error("Prod has no dev sign-in. Sign in the normal way.");
  const token = secret("DEV_SIGN_IN_TOKEN", "dev");
  if (!token) throw new Error("DEV_SIGN_IN_TOKEN isn't in Doppler dev; see infra/README.md.");
  const origin = await stageOrigin(stage);
  const query = new URLSearchParams({
    ...(opts.as && { as: opts.as }),
    ...(opts.next && { next: opts.next }),
  });
  // The token goes in the fragment, which the browser never sends: the page posts it in a header (dev.ts).
  return { origin, token, url: `${origin}/dev/sign-in?${query}#${new URLSearchParams({ token })}` };
}

const FIXTURES = join(import.meta.dirname, "../fixtures/nadia");

/**
 * The fixture student's notes as /dev/seed takes them: test scores sensitive, as in the evals' world
 * (evals/shared/world.ts). A `verified:` mark is left out, since verifying takes the person's own passkey; the note
 * arrives unverified, and whoever tests can verify it on the site.
 */
export function fixtureNotes() {
  return readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .toSorted()
    .map((path) => ({
      path,
      raw: readFileSync(join(FIXTURES, path), "utf8").replace(/^verified:.*\n/m, ""),
      class: path.startsWith("facts/tests/") ? ("sensitive" as const) : ("normal" as const),
    }));
}

/**
 * Fills the fixture account's record on `origin` (the `as` one, if given) with fixtureNotes(), all or none, if it
 * is empty. Throws with the record's reason when it refuses the seed.
 */
export async function seed(origin: string, token: string, as: string | undefined): Promise<Seeded> {
  const res = await fetch(`${origin}/dev/seed${as ? `?as=${encodeURIComponent(as)}` : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ notes: fixtureNotes() }),
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (res.status === 404)
    throw new Error("/dev/seed answered 404: this stage runs code from before seeding.");
  if (!res.ok) throw new Error(`/dev/seed answered ${res.status}: ${JSON.stringify(body)}`);
  if (
    !body ||
    typeof body !== "object" ||
    !("seeded" in body && "existing" in body) ||
    typeof body.seeded !== "number" ||
    typeof body.existing !== "number"
  )
    throw new Error(`/dev/seed answered ${JSON.stringify(body)}, not a seed result.`);
  return { seeded: body.seeded, existing: body.existing };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      as: { type: "string" },
      next: { type: "string" },
      empty: { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (!values.stage || (command !== "sign-in" && command !== "token")) {
    throw new Error(
      "Usage: vp run dev:sign-in --stage <stage|local> [--as tag] [--next /path] [--empty], or dev:token.",
    );
  }
  const { origin, token, url } = await signInLink(values.stage, values);
  if (!values.empty) {
    const seeded = await seed(origin, token, values.as);
    if (seeded.existing > 0)
      console.error(`The record already holds ${seeded.existing} notes; left as it is.`);
    else console.error(`Seeded ${seeded.seeded} fixture notes.`);
  }
  if (command === "sign-in") {
    console.log(url);
    return;
  }
  const res = await fetch(`${origin}/dev/token${values.as ? `?as=${encodeURIComponent(values.as)}` : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok)
    throw new Error(`/dev/token answered ${res.status}. Is the stage deployed with DEV_SIGN_IN_TOKEN?`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
