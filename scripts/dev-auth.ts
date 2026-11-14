#!/usr/bin/env node
// Signs people and agents in to a dev stage as the fictional fixture student, like T3 Code's `t3 auth pairing
// create` and `t3 auth session issue` (apps/worker/src/dev.ts serves the other end):
//   vp run dev:sign-in --stage pr-12 [--as <tag>] [--next /path]   a link that signs a browser in; open it once
//   vp run dev:token --stage pr-12 [--as <tag>]                     an access token for that stage's /mcp
// `--stage local` is `vp run dev`. `--as` picks a separate fixture account (ada.okafor+<tag>@example.edu).
// Prod has no dev sign-in, so this refuses it.
import { parseArgs } from "node:util";

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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { stage: { type: "string" }, as: { type: "string" }, next: { type: "string" } },
  });
  const [command] = positionals;
  if (!values.stage || (command !== "sign-in" && command !== "token")) {
    throw new Error(
      "Usage: vp run dev:sign-in --stage <stage|local> [--as tag] [--next /path], or dev:token.",
    );
  }
  const { origin, token, url } = await signInLink(values.stage, values);
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
