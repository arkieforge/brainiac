#!/usr/bin/env node
// `vp run e2e --stage <stage|local>`: drives a deployed stage in a real browser with no person signing in, like
// T3 Code's scenarios. The dev sign-in link starts a fresh fixture account, and Chrome's virtual authenticator
// stands in for a phone or security key, so the passkey ceremonies are the real ones.
//   --headed           show the browser
//   --evidence <dir>   save a screenshot after each step (default: only on failure, to the system temp dir)
// CI runs it on every preview after the doctor (.github/actions/deploy). Never prod: it has no dev sign-in.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Page } from "playwright";

import { signInLink } from "./dev-auth.ts";

const STEP_MS = 15_000;

async function main() {
  const { values } = parseArgs({
    options: { stage: { type: "string" }, headed: { type: "boolean" }, evidence: { type: "string" } },
  });
  if (!values.stage) throw new Error("Pass --stage, e.g. --stage pr-12 or --stage local.");
  // A new account each run: a first passkey on a new, verified account can approve at once, with no wait.
  const tag = `e2e-${Date.now().toString(36)}`;
  const { url, token } = await signInLink(values.stage, { as: tag });
  // Playwright quotes the URL it was loading in errors, and CI logs are public; the link carries the token.
  const redact = (text: string) => text.replaceAll(token, "***");
  const email = `ada.okafor+${tag}@example.edu`;

  const browser = await chromium.launch({ headless: !values.headed });
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

  const evidence = values.evidence;
  if (evidence) mkdirSync(evidence, { recursive: true });
  let current = "";
  const step = async (name: string, run: (page: Page) => Promise<void>) => {
    current = name;
    await run(page);
    if (evidence) await page.screenshot({ path: join(evidence, `${name.replaceAll(/\W+/g, "-")}.png`) });
    console.log(`ok    ${name}`);
  };

  try {
    await step("dev sign-in lands on the account page", async (p) => {
      await p.goto(url);
      await p.waitForURL(/\/account$/);
      await p.getByText(`Signed in as ${email}`).waitFor();
    });
    await step("first passkey enrolls and can approve", async (p) => {
      await p.locator("#add").click();
      await p.getByText("Can approve", { exact: true }).waitFor();
    });
    await step("sign out returns to sign-in", async (p) => {
      await p.locator("#sign-out").click();
      await p.waitForURL(/\/sign-in$/);
    });
    await step("passkey signs back in", async (p) => {
      await p.locator("#passkey").click();
      await p.waitForURL(/\/account$/);
      await p.getByText(`Signed in as ${email}`).waitFor();
    });
  } catch (error) {
    const shot = join(evidence ?? tmpdir(), `e2e-failed-${tag}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const alert = await page
      .locator("#error")
      .textContent()
      .catch(() => "");
    throw new Error(
      redact(`FAIL  ${current}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`) +
        `${alert ? `\n      page says: ${alert}` : ""}\n      screenshot: ${shot}`,
      { cause: error },
    );
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
