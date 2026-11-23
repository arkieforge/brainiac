#!/usr/bin/env node
// `vp run doctor`: checks this machine can build, test and deploy Brainiac, and says how to fix what isn't.
// `vp run doctor --stage <stage>`: probes a deployed stage from outside, read-only and signed out, the way a
// person reaches it. CI runs it after every deploy; the doctor skill starts from it when a stage misbehaves.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { cloudflare, dopplerConfig, secret, workerName } from "./logs.ts";

const ROOT = join(import.meta.dirname, "..");

interface Check {
  name: string;
  run: () => string | true | Promise<string | true>; // true = ok, string = how to fix
  optional?: boolean;
}

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
const major = (v: string) => Number(v.replace(/^v/, "").split(".")[0]);

export const checks: Check[] = [
  {
    name: "Node 26 or newer",
    run: () => major(process.version) >= 26 || `Node ${process.version}; install Node 26 (mise use node@26).`,
  },
  {
    name: "Vite+ (vp)",
    run: () => sh("vp", ["--version"]).status === 0 || "Install Vite+: curl -fsSL https://vite.plus | bash",
  },
  {
    name: "Dependencies installed",
    run: () => existsSync(join(ROOT, "node_modules/.bin/vp")) || "Run `vp i` in the repo root.",
  },
  {
    name: "Git hooks installed",
    run: () => {
      const hooks = sh("git", ["config", "core.hooksPath"]).stdout.trim();
      return hooks.includes(".vite-hooks") || "Run `vp config --no-agent` (or `vp i`, which runs it).";
    },
  },
  {
    name: "GitHub CLI signed in",
    optional: true,
    run: () => sh("gh", ["auth", "token"]).status === 0 || "Run `gh auth login` to work with issues and PRs.",
  },
  {
    // Secrets (Cloudflare, Neon, treg) come from Doppler, scoped to this folder (see docs/operations/development.md).
    name: "Doppler set up for this folder",
    optional: true,
    run: () =>
      sh("doppler", ["configure", "get", "project", "--plain"]).stdout.trim() === "braniac" ||
      "Run `doppler login --scope <this folder>` with the LaunchPad account, then `doppler setup --no-interactive`.",
  },
  {
    name: "Reference repos synced",
    optional: true,
    run: () =>
      existsSync(join(ROOT, ".repos/effect")) || "Run `vp run repos:sync` so agents can read library source.",
  },
  {
    // A floating range could pull a beta that renames resources and plans deletes of stateful ones.
    name: "Pinned Alchemy version",
    run: () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      const version: unknown = pkg.devDependencies?.alchemy;
      return (
        (typeof version === "string" && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) ||
        `alchemy must be pinned to an exact version, not "${String(version)}".`
      );
    },
  },
];

// Cloudflare's always-pass Turnstile key, which only non-prod stages may use (alchemy.run.ts).
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA";

const get = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

/** What a signed-out visitor can see of a stage, each with the fix when it's wrong. */
export const stageChecks = (
  origin: string,
  prod: boolean,
  readLogs: () => Promise<unknown>,
  bindingNames: () => Promise<string[]>,
): Check[] => {
  const signIn = get(`${origin}/sign-in`).then(async (res) => ({
    status: res.status,
    html: await res.text(),
  }));
  return [
    {
      name: `Worker answers (${origin})`,
      run: async () =>
        (await get(`${origin}/health`)).ok || "The Worker isn't serving; check the deploy job.",
    },
    {
      name: "Web app served on a deep link",
      run: async () => {
        const res = await get(`${origin}/doctor/deep-link`, { headers: { accept: "text/html" } });
        return (
          (res.ok && (await res.text()).includes("<title>Brainiac</title>")) ||
          `A page answered ${res.status} without the web app's shell; check the web build in the deploy job.`
        );
      },
    },
    {
      // Auth over plain http used to 500 on every request (the MCP plugin refuses an http base URL).
      name: "Plain HTTP redirects to HTTPS",
      run: async () => {
        const res = await get(`${origin.replace("https:", "http:")}/sign-in`, { redirect: "manual" });
        const to = res.headers.get("location") ?? "";
        return (
          (res.status >= 300 && res.status < 400 && to.startsWith("https:")) ||
          `http:// answered ${res.status}${to ? ` to ${to}` : ""}; it must redirect to https.`
        );
      },
    },
    {
      name: "Database reachable through Hyperdrive",
      run: async () =>
        (await get(`${origin}/health/db`)).ok ||
        "/health/db failed: check the Neon branch and Hyperdrive (`vp run logs --stage <stage>`).",
    },
    {
      // Ending a rotation while this counts any record leaves that record's files and secrets unreadable until
      // the previous key is bound again.
      name: "No record waiting on the previous vault key",
      optional: true,
      run: async () => {
        const res = await get(`${origin}/health/vault`);
        if (!res.ok) return `/health/vault answered ${res.status}.`;
        const vault = (await res.json()) as { rotating: boolean; waiting?: number };
        return (
          !vault.rotating ||
          vault.waiting === 0 ||
          `A vault key rotation is running and ${vault.waiting} records haven't rewrapped yet; keep ` +
            "VAULT_KEY_PREVIOUS set until this passes (infra/README.md#rotating-the-vault-key)."
        );
      },
    },
    {
      name: prod ? "Sign-in page uses a real Turnstile key" : "Sign-in page has a Turnstile key",
      run: async () => {
        const { status, html } = await signIn;
        const key = /sitekey: "([^"]*)"/.exec(html)?.[1];
        if (status !== 200) return `/sign-in answered ${status}.`;
        return (
          (key && (!prod || key !== TURNSTILE_TEST_SITE_KEY)) ||
          "TURNSTILE_SITE_KEY is missing or the test key, so sign-up refuses (infra/README.md)."
        );
      },
    },
    {
      name: "Email codes on",
      optional: !prod,
      run: async () =>
        !/<form id="email" hidden/.test((await signIn).html) ||
        "EMAIL_FROM isn't set for this stage, so no email codes or recovery notices (infra/README.md).",
    },
    {
      name: "Sign-up refuses without Turnstile",
      run: async () => {
        const res = await get(`${origin}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email: "doctor@example.com", type: "sign-in" }),
        });
        return res.status === 400 || `Expected 400 without a captcha token, got ${res.status}.`;
      },
    },
    {
      name: "OAuth metadata for MCP clients",
      run: async () => {
        const res = await get(`${origin}/.well-known/oauth-authorization-server`);
        const issuer = res.ok ? ((await res.json()) as { issuer?: string }).issuer : undefined;
        return issuer === `${origin}/api/auth` || `Issuer is ${issuer ?? `missing (${res.status})`}.`;
      },
    },
    // Dev sign-in skips every check on who you are. Asking the route can't tell (a wrong token gets the same 404 as
    // no route), so on prod this reads the deployed Worker's bindings instead (apps/worker/src/dev.ts).
    ...(prod
      ? [
          {
            name: "No dev sign-in on prod",
            run: async () =>
              !(await bindingNames()).includes("DEV_SIGN_IN_TOKEN") ||
              "The prod Worker has DEV_SIGN_IN_TOKEN bound; remove it from Doppler prd and redeploy.",
          },
        ]
      : []),
    {
      name: "Stored logs readable (vp run logs)",
      optional: true,
      run: () => readLogs().then(() => true as const),
    },
  ];
};

/**
 * The stage's public origin: `local` is `vp run dev`, prod is its DOMAIN when it has one, and the rest are on
 * workers.dev.
 */
export async function stageOrigin(stage: string) {
  if (stage === "local") return "http://localhost:1337";
  const config = dopplerConfig(stage);
  const accountId = secret("CLOUDFLARE_ACCOUNT_ID", config);
  if (!accountId) throw new Error(`Couldn't read Doppler config ${config}; run \`vp run doctor\` first.`);
  const domain = stage === "prod" ? secret("DOMAIN", config) : undefined;
  if (domain) return `https://${domain}`;
  const token = secret("CLOUDFLARE_API_TOKEN", config) ?? "";
  const { subdomain } = (await cloudflare(`/accounts/${accountId}/workers/subdomain`, token)) as {
    subdomain: string;
  };
  return `https://${workerName(stage)}.${subdomain}.workers.dev`;
}

/**
 * A Worker deployed for the first time takes a few seconds before its workers.dev hostname answers, so the doctor
 * run right after a preview's first deploy failed every check that came early. Wait up to a minute for /health;
 * if it never answers, the checks run anyway and say so.
 */
export async function waitForWorker(origin: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await get(`${origin}/health`).catch(() => undefined);
    if (res?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function stageCheckList(stage: string): Promise<Check[]> {
  const config = dopplerConfig(stage);
  const accountId = secret("CLOUDFLARE_ACCOUNT_ID", config);
  if (!accountId) throw new Error(`Couldn't read Doppler config ${config}; run \`vp run doctor\` first.`);
  const logsToken = secret("CLOUDFLARE_LOGS_TOKEN", config) ?? secret("CLOUDFLARE_API_TOKEN", config) ?? "";
  const readLogs = () =>
    cloudflare(`/accounts/${accountId}/workers/observability/telemetry/query`, logsToken, {
      method: "POST",
      body: JSON.stringify({
        queryId: "brainiac-doctor",
        view: "events",
        timeframe: { from: Date.now() - 60_000, to: Date.now() },
        limit: 1,
        parameters: {
          filters: [
            { key: "$workers.scriptName", operation: "eq", type: "string", value: workerName(stage) },
          ],
        },
      }),
    });
  const origin = await stageOrigin(stage);
  await waitForWorker(origin);
  // Names only: the settings API never returns a secret's value.
  const bindingNames = async () => {
    const token = secret("CLOUDFLARE_API_TOKEN", config) ?? "";
    const settings = (await cloudflare(
      `/accounts/${accountId}/workers/scripts/${workerName(stage)}/settings`,
      token,
    )) as { bindings: { name: string }[] };
    return settings.bindings.map((b) => b.name);
  };
  return stageChecks(origin, stage === "prod", readLogs, bindingNames);
}

async function main() {
  const { values } = parseArgs({ options: { stage: { type: "string" } } });
  let failed = 0;
  for (const check of values.stage ? await stageCheckList(values.stage) : checks) {
    const result = await Promise.resolve()
      .then(check.run)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    const ok = result === true;
    if (!ok && !check.optional) failed++;
    console.log(
      `${ok ? "ok  " : check.optional ? "warn" : "FAIL"}  ${check.name}${ok ? "" : `\n      ${result}`}`,
    );
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
