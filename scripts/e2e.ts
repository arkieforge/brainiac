#!/usr/bin/env node
// `vp run e2e --stage <stage|local>`: runs the scenarios in scripts/scenarios against a stage in a real browser,
// with no person signing in, like T3 Code's scenarios. Each scenario gets a fresh fixture account from the dev
// sign-in link, its record seeded with the fixture student's notes unless it asks for an empty one, and Chrome's
// virtual authenticator for its passkeys, so the ceremonies are the real ones.
//   --scenario <name>  run only this one (repeatable); the names are in scripts/scenarios/index.ts
//   --headed           show the browser
//   --evidence <dir>   save a screenshot after each step (default: only on failure, to the system temp dir)
// CI runs it on every preview after the doctor (.github/actions/deploy). Never prod: it has no dev sign-in.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser } from "playwright";

import { seed, signInLink } from "./dev-auth.ts";
import { SCENARIOS } from "./scenarios/index.ts";
import type { Scenario } from "./scenarios/scenario.ts";

const STEP_MS = 15_000;

/** A scenario's name, as scripts/scenarios/index.ts lists it. */
export type ScenarioName = keyof typeof SCENARIOS;

export const isScenario = (name: string): name is ScenarioName => Object.hasOwn(SCENARIOS, name);

/** How a scenario run went. */
export interface Outcome {
  readonly name: string;
  /** Why it failed, with the token taken out; absent when it passed. */
  readonly failure?: string;
  /** The scenario's own step that failed; absent when it passed, or failed before its first step (seed, sign-in). */
  readonly step?: string;
}

/** Runs one scenario on `stage` in its own browser context, printing each step as it passes. */
async function runScenario(
  browser: Browser,
  stage: string,
  name: ScenarioName,
  evidence: string | undefined,
): Promise<Outcome> {
  const scenario: Scenario = SCENARIOS[name];
  // A new account each run: a first passkey on a new, verified account can approve at once, with no wait.
  // Tags are at most 40 characters (dev.ts); the time stays whole so no two runs share an account.
  const tag = `${name.slice(0, 30)}-${Date.now().toString(36)}`;
  const { origin, url, token } = await signInLink(stage, { as: tag, next: scenario.next });
  // Playwright quotes the URL it was loading in errors, and CI logs are public; the link carries the token.
  const redact = (text: string) => text.replaceAll(token, "***");
  const account = { tag };

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_MS);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (evidence) mkdirSync(join(evidence, name), { recursive: true });

  let current = "seed the record";
  let inSteps = false;
  try {
    if (!scenario.empty) await seed(origin, token, tag);
    current = "sign in with the dev link";
    await page.goto(url);
    // The link's page posts the token and then moves on; the steps start once the session works, so a sign-in that
    // landed signed out fails here, before the steps, and never reads as the bug a step shows.
    await page.waitForURL((at) => !at.pathname.startsWith("/dev/"));
    const session = await page.request.get(`${origin}/api/session`);
    if (!session.ok())
      throw new Error(`the dev sign-in left no session (/api/session answered ${session.status()})`);
    inSteps = true;
    for (const step of scenario.steps) {
      current = step.name;
      await step.run(page, account);
      // Evidence only: a screenshot that can't be saved never fails the scenario.
      if (evidence)
        await page
          .screenshot({ path: join(evidence, name, `${step.name.replaceAll(/\W+/g, "-")}.png`) })
          .catch((error: unknown) => console.warn(`      no screenshot of ${step.name}: ${String(error)}`));
      console.log(`ok    ${name} › ${step.name}`);
    }
    return { name };
  } catch (error) {
    const shot = join(evidence ?? tmpdir(), `${tag}-failed.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const alert = await page
      .locator("#error")
      .textContent({ timeout: 1_000 })
      .catch(() => "");
    const why = redact(error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));
    const failure = `${current}: ${why}${alert ? `\n      page says: ${alert}` : ""}\n      screenshot: ${shot}`;
    console.log(`FAIL  ${name} › ${failure}`);
    return { name, failure, ...(inSteps && { step: current }) };
  } finally {
    await context.close();
  }
}

/** Runs `names` (every scenario when empty) on `stage`, one browser for all, and returns how each went. */
export async function runScenarios(
  stage: string,
  names: readonly ScenarioName[],
  opts: { readonly headed?: boolean | undefined; readonly evidence?: string | undefined } = {},
): Promise<Outcome[]> {
  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    const outcomes: Outcome[] = [];
    for (const name of names.length > 0 ? names : Object.keys(SCENARIOS).filter(isScenario))
      outcomes.push(await runScenario(browser, stage, name, opts.evidence));
    return outcomes;
  } finally {
    await browser.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      stage: { type: "string" },
      scenario: { type: "string", multiple: true },
      headed: { type: "boolean" },
      evidence: { type: "string" },
    },
  });
  if (!values.stage) throw new Error("Pass --stage, e.g. --stage pr-12 or --stage local.");
  const names = values.scenario ?? [];
  const unknown = names.filter((name) => !isScenario(name));
  if (unknown.length > 0)
    throw new Error(`No scenario ${unknown.join(", ")}; there are ${Object.keys(SCENARIOS).join(", ")}.`);
  const outcomes = await runScenarios(values.stage, names.filter(isScenario), values);
  const failed = outcomes.filter((outcome) => outcome.failure);
  console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} scenarios passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
