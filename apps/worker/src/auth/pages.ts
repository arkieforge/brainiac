// The pages auth needs before the web app exists (#50): sign in or up, enroll passkeys, and let an MCP client
// in. Plain HTML with a little inline script; the WebAuthn ceremonies use the browser's own JSON helpers.
import type { AuditCall, Connection, PlanView } from "@brainiac/base";

import type { ConnectedApp } from "./connected-apps.ts";
import { canApprove, type ApprovingPasskey } from "./approving.ts";

/** What the account page asks for next: a first passkey is required, a second strongly suggested. */
export const nextPasskeyStep = (passkeys: readonly unknown[]) =>
  passkeys.length === 0 ? "enroll" : passkeys.length === 1 ? "second" : "none";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Where to land after signing in: only somewhere on this origin, as an absolute URL. Browsers read `/\\host` as
 * `//host`, and `/.//host` normalizes to a path of `//host`, so neither a prefix check nor a bare path is safe.
 */
export const landing = (next: string | null, origin: string) => {
  const target = next ? URL.parse(next, origin) : null;
  return target?.origin === origin ? target.href : `${origin}/account`;
};

// The public site's ink mark (apps/marketing/public/mark-ink.svg), inline so these pages load nothing extra.
const MARK = `<svg viewBox="0 0 100 100" aria-hidden="true"><path fill-rule="evenodd" fill="#1c1a16" d="M16 50a34 34 0 1 0 68 0a34 34 0 1 0 -68 0zM32.5 37a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM45.5 37a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM58.5 37a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM32.5 50a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM45.5 50a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM32.5 63a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0zM56.5 63a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0 -13 0z"/><circle cx="63" cy="63" r="3.8" fill="#ffb000"/></svg>`;

/** `heading` is HTML, for a two-tone title; `title` goes in the tab as plain text. */
const page = (title: string, body: string, script: string, head = "", heading = title) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Brainiac</title>${head}
<style>
:root{--bg:#f5f1e8;--raised:#fbf9f3;--hover:#ebe4d5;--line:#e0d8c7;--line-2:#d2c8b3;--fg:#1c1a16;--muted:#57514a;--faint:#6a6357;--accent:#ad411b;--danger:#b42318;--ink:#16140f;--ease:cubic-bezier(.23,1,.32,1);--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;color-scheme:light}
*{box-sizing:border-box}[hidden],input[type=hidden]{display:none!important}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;font:14px/1.5 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",system-ui,sans-serif;color:var(--fg);background:var(--bg);-webkit-font-smoothing:antialiased}
header,footer{display:flex;align-items:center;padding:22px 28px}
header a{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;letter-spacing:-.01em;color:inherit;text-decoration:none}header svg{width:22px;height:22px}
main{width:100%;max-width:calc(24rem + 32px);margin:4.5rem auto 3rem;padding:0 16px}
footer{margin-top:auto;justify-content:flex-end;font:500 11px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase}footer a{color:var(--faint);text-decoration:none}
h1{font-size:26px;line-height:1.15;font-weight:600;letter-spacing:-.025em;margin:0 0 26px}h1 span{display:block;color:var(--faint)}
h2{font-size:15px;font-weight:600;margin:0 0 8px}a{color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
form,section{margin:0 0 1.5rem}label{display:block;font-size:12px;font-weight:500;color:var(--muted)}
input{display:block;width:100%;height:44px;margin:6px 0 10px;padding:0 14px;font:inherit;font-size:15px;color:inherit;background:var(--raised);border:1px solid var(--line-2);border-radius:12px}
input[name=otp]{font:500 20px var(--mono);letter-spacing:.4em}
button{display:inline-flex;align-items:center;justify-content:center;gap:9px;height:40px;padding:0 16px;font:inherit;font-weight:500;color:var(--raised);background:var(--ink);border:1px solid var(--ink);border-radius:999px;cursor:pointer;transition:background .12s var(--ease),transform .12s var(--ease)}
button:hover{background:#2b2822}button:active{transform:scale(.97)}button svg{width:16px;height:16px}
button.quiet{color:var(--fg);background:none;border-color:var(--line-2)}button.quiet:hover{background:var(--hover)}
button.link{height:auto;padding:0;color:var(--muted);background:none;border:0;font-size:13px;font-weight:400;text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px}
.wide{width:100%;height:44px}.pair{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px}.links{display:flex;justify-content:space-between}
.or{display:flex;align-items:center;gap:12px;margin:22px 0 18px;font:500 11px/1 var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--faint)}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
.note{color:var(--faint);font-size:12.5px}#error{color:var(--danger)}code{font:12.5px var(--mono)}
ul{padding:0;margin:0 0 12px;list-style:none}li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.6rem 0;border-bottom:1px solid var(--line)}
details{padding:.5rem 0;border-bottom:1px solid var(--line)}summary{cursor:pointer}
@media (max-width:600px){header,footer{padding:16px}main{margin-top:2.25rem}}@media (prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body><header><a href="/">${MARK}Brainiac</a></header>
<main><h1>${heading}</h1>${body}<p id="error" role="alert"></p></main>
<footer><a href="https://github.com/arkieforge/brainiac">GitHub</a></footer>
<script>
const api = async (path, init = {}) => {
  const res = await fetch("/api/auth" + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await res.json().catch(() => null);
  // The ref is the request's Cloudflare ray id, which finds its log lines: \`vp run logs --stage <stage> --ray <ref>\`.
  const ref = res.headers.get("cf-ray")?.split("-")[0];
  if (!res.ok) throw new Error(body?.message ?? "Something went wrong. Try again." + (ref ? " If it keeps happening, send us ref " + ref + "." : ""));
  return body;
};
const run = (fn) => async (event) => {
  event.preventDefault();
  document.getElementById("error").textContent = "";
  try { await fn(event); } catch (error) { document.getElementById("error").textContent = error.message; }
};
// An MCP client's sign-in arrives with the authorize request, signed by the server. Sent back with the sign-in,
// it makes the server carry on to consent, so the page goes where the reply says instead of the account page.
const oauthQuery = new URLSearchParams(location.search).has("sig") ? location.search.slice(1) : undefined;
const next = (reply, fallback) => { location.href = reply?.redirect && reply.url ? reply.url : fallback; };
const passkeySignIn = async () => {
  const options = await api("/passkey/generate-authenticate-options");
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  return api("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: credential.toJSON(), oauth_query: oauthQuery }) });
};
${script}
</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // No framing, so another site can't overlay these buttons and trick a click on Remove.
        "content-security-policy": "frame-ancestors 'none'",
      },
    },
  );

export interface SignInPageOptions {
  /** Where signing in lands, from `landing`: the account page, or the page that sent the person here. */
  next: string;
  turnstileSiteKey: string;
  providers: readonly ("google" | "github")[];
  /** Whether this stage can send email. Better Auth reports a code as sent even when sending failed. */
  emailCodes: boolean;
}

export function signInPage({
  next: landsOn,
  turnstileSiteKey,
  providers,
  emailCodes,
}: SignInPageOptions): Response {
  const social = providers
    .map(
      (p) =>
        `<button type="button" class="quiet wide" data-provider="${p}" aria-label="Continue with ${LOGINS[p].name}">${LOGINS[p].logo}${LOGINS[p].name}</button>`,
    )
    .join("");
  // `data-start` marks what the code step hides, so the person sees only the code box until they back out.
  return page(
    "Sign in",
    `<section data-start><button type="button" id="passkey" class="wide">${KEY}Sign in with a passkey</button></section>
${emailCodes ? "" : '<p class="note" data-start>Email codes aren\'t set up on this server yet.</p>'}
<div${emailCodes ? "" : " hidden"}><p class="or" data-start>or a code by email</p>
<form id="email" data-start><label>Email<input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>
<button class="quiet wide">Email me a code</button><p class="note">New here? The code makes your account.</p></form>
<form id="code" hidden><p>We sent a code to <b id="sent-to"></b>.</p><label>Code
<input name="otp" required inputmode="numeric" autocomplete="one-time-code"></label><button class="wide">Continue</button>
<p class="links"><button type="button" class="link" id="other-email">Use another email</button><button type="button" class="link" id="resend">Send again</button></p></form></div>
<div id="turnstile"></div>
${social ? `<p class="or" data-start>or</p><section class="pair" data-start>${social}</section>` : ""}`,
    `const landsOn = ${JSON.stringify(landsOn).replace(/</g, "\\u003c")};
let widget;
// Shown only when Cloudflare needs a click; it passes silently otherwise.
window.onTurnstileLoad = () => { widget = turnstile.render("#turnstile", { sitekey: ${JSON.stringify(turnstileSiteKey)}, theme: "light", appearance: "interaction-only", size: "flexible" }); };
const captcha = () => {
  const token = turnstile.getResponse(widget);
  turnstile.reset(widget);
  if (!token) throw new Error("Wait a moment for the security check, then try again.");
  return { "x-captcha-response": token };
};
const heading = document.querySelector("h1");
const startHeading = heading.innerHTML;
const codeStep = (on) => {
  for (const el of document.querySelectorAll("[data-start]")) el.hidden = on;
  document.getElementById("code").hidden = !on;
  heading.innerHTML = on ? "Check your email" : startHeading;
};
let email;
const sendCode = () => api("/email-otp/send-verification-otp", { method: "POST", headers: captcha(), body: JSON.stringify({ email, type: "sign-in" }) });
document.getElementById("passkey").onclick = run(async () => next(await passkeySignIn(), landsOn));
document.getElementById("email").onsubmit = run(async (event) => {
  email = new FormData(event.target).get("email");
  await sendCode();
  document.getElementById("sent-to").textContent = email;
  codeStep(true);
  document.querySelector("#code input").focus();
});
document.getElementById("other-email").onclick = () => codeStep(false);
document.getElementById("resend").onclick = run(async (event) => {
  await sendCode();
  event.target.textContent = "Sent again";
});
document.getElementById("code").onsubmit = run(async (event) => {
  const otp = new FormData(event.target).get("otp");
  next(await api("/sign-in/email-otp", { method: "POST", body: JSON.stringify({ email, otp, oauth_query: oauthQuery }) }), landsOn);
});
for (const button of document.querySelectorAll("[data-provider]")) {
  button.onclick = run(async () => {
    const { url } = await api("/sign-in/social", { method: "POST", headers: captcha(), body: JSON.stringify({ provider: button.dataset.provider, callbackURL: landsOn, oauth_query: oauthQuery }) });
    location.href = url;
  });
}`,
    `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit" async defer></script>`,
    "Sign in <span>to your record.</span>",
  );
}

// Phosphor's key (fill), as in the app.
const KEY = `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M216.57 39.43a80 80 0 0 0-132.66 81.35L28.69 176A15.86 15.86 0 0 0 24 187.31V216a16 16 0 0 0 16 16h32a8 8 0 0 0 8-8v-16h16a8 8 0 0 0 8-8v-16h16a8 8 0 0 0 5.66-2.34l9.56-9.57A79.73 79.73 0 0 0 160 176h.1a80 80 0 0 0 56.47-136.57ZM180 92a16 16 0 1 1 16-16 16 16 0 0 1-16 16Z"/></svg>`;

const LOGINS = {
  google: {
    name: "Google",
    logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>`,
  },
  github: {
    name: "GitHub",
    logo: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>`,
  },
};

const PROMPTS = {
  enroll:
    "Add a passkey to finish signing up. It signs you in and approves important changes to your record, so nobody else can.",
  second:
    "Add a second passkey on another device or a security key. If you lose every passkey, getting approvals back takes a 72-hour wait.",
  none: "",
};

/** `vouchedUntil`: when this session's passkey proof runs out (see `vouchedUntil` in recovery.ts). */
export function accountPage(
  email: string,
  passkeys: readonly ApprovingPasskey[],
  vouchedUntil: number,
  apps: readonly ConnectedApp[],
  connections: readonly Activity[] = [],
  github?: GithubSection,
  orcid?: OrcidSection,
  plan?: PlanSection,
  now = new Date(),
): Response {
  const step = nextPasskeyStep(passkeys);
  const approving = passkeys.filter((p) => canApprove(p, now)).length;
  const hasApproving = approving > 0;
  // Sent as time left rather than a timestamp, so a wrong clock on the device doesn't matter.
  const vouchLeftMs = Math.max(0, vouchedUntil - now.getTime());
  const rows = passkeys
    .map((p) => {
      const status = canApprove(p, now)
        ? "Can approve"
        : p.approvesAt
          ? `Can approve from ${p.approvesAt.toUTCString()}`
          : "Can't approve";
      return `<li><span>${escape(p.name ?? "Passkey")}<br><span class="note">${status}</span></span>
<button type="button" class="quiet" data-remove="${escape(p.id)}" data-approves="${canApprove(p, now)}" data-last="${canApprove(p, now) && approving === 1}">Remove</button></li>`;
    })
    .join("");
  const appRows = apps
    .map((a) => {
      const from = URL.canParse(a.clientId) ? new URL(a.clientId).host : a.clientId;
      return `<li><span>${escape(a.name ?? from)}<br><span class="note">${escape(from)}, connected ${a.connectedAt.toUTCString()}</span></span>
<button type="button" class="quiet" data-disconnect="${escape(a.clientId)}" data-name="${escape(a.name ?? from)}">Disconnect</button></li>`;
    })
    .join("");
  const activityRows = connections
    .map(({ connection, calls }) => {
      const app = apps.find((a) => a.clientId === connection.oauthClientId);
      const id = connection.oauthClientId;
      const name =
        connection.kind === "cli"
          ? "Brainiac CLI"
          : (app?.name ?? (id && URL.canParse(id) ? new URL(id).host : id));
      const grants = `${connection.level}${connection.sensitive ? ", sees sensitive notes" : ""}`;
      const items = calls.map(
        (call) =>
          `<li><span>${escape(call.tool)}${describeNotes(call)}</span><span class="note">${new Date(call.at).toUTCString()}</span></li>`,
      );
      return `<details><summary>${escape(name ?? "An app")} <span class="note">${escape(grants)}</span></summary>${items.length ? `<ul>${items.join("")}</ul>` : '<p class="note">No calls yet.</p>'}</details>`;
    })
    .join("");
  const githubRows = (github?.installations ?? [])
    .map((i) => {
      const state = i.suspended
        ? "Suspended on GitHub"
        : i.member?.lapsed
          ? 'Your GitHub sign-in ran out, so nothing is read. <a href="/connectors/github/install">Connect again</a>'
          : i.checkedAt
            ? `Checked ${i.checkedAt.toUTCString()}`
            : "Waiting for its first daily check";
      // An organization's installation reads only what the person can see there, so say which.
      const repos = i.member?.lapsed
        ? ""
        : i.member?.repos.length
          ? `<br><span class="note">Reads the repos you can see: ${i.member.repos.map(escape).join(", ")}</span>`
          : i.member
            ? '<br><span class="note">You can see none of its repos on GitHub, so nothing is read.</span>'
            : "";
      return `<li><span>${escape(i.account || `Installation ${i.id}`)}<br><span class="note">${state} · <a href="https://github.com/apps/${escape(github?.slug ?? "")}/installations/new">Pick repos on GitHub</a></span>${repos}</span>
<button type="button" class="quiet" data-github="${i.id}" data-name="${escape(i.account)}">Disconnect</button></li>`;
    })
    .join("");
  const outcome = github?.outcome ? GITHUB_OUTCOMES[github.outcome] : undefined;
  const githubSection = github
    ? `<section><h2>GitHub</h2>${outcome ? `<p role="status">${outcome}</p>` : ""}${githubRows ? `<ul>${githubRows}</ul>` : ""}<a href="/connectors/github/install">${githubRows ? "Connect more repos" : "Connect GitHub repos"}</a>
<p class="note">You pick the repos on GitHub. Each one becomes a project for you to accept, private repos as sensitive notes. Stars, language and archived status stay up to date; everything else on a project is yours. On an organization, only the repos you can see there are read, checked again each day.</p></section>`
    : "";
  const orcidOutcome = orcid?.outcome ? ORCID_OUTCOMES[orcid.outcome] : undefined;
  const orcidSection = orcid
    ? `<section><h2>ORCID</h2>${orcidOutcome ? `<p role="status">${orcidOutcome}</p>` : ""}${
        orcid.linked
          ? `<ul><li><span><a href="${escape(orcid.profile)}">${escape(orcid.linked)}</a><br><span class="note">Your verified iD</span></span>
<button type="button" class="quiet" id="orcid-unlink">Unlink</button></li></ul><a href="/connectors/orcid/link">Link again to bring in new works</a>`
          : `<a href="/connectors/orcid/link">Link your ORCID iD</a>`
      }
<p class="note">You sign in to ORCID to prove the iD is yours. Each of your works that isn't in your record yet becomes a paper for you to accept, and a paper whose registry names your iD shows which author you are.</p></section>`
    : "";
  const limits = plan?.view.limits;
  const planSection =
    plan && limits
      ? `<section><h2>Plan</h2>${plan.paid && plan.view.plan === "free" ? '<p role="status">Thanks. Pro turns on as soon as Polar confirms the payment, usually within a minute. Reload to see it.</p>' : ""}
<p>${plan.view.plan === "pro" ? "Pro" : "Free"}: ${plan.view.notes}${Number.isFinite(limits.notes) ? ` of ${limits.notes}` : ""} notes, ${megabytes(plan.view.bytes)} of ${megabytes(limits.bytes)} of files.</p>
${
  plan.view.plan === "pro"
    ? '<button type="button" class="quiet" id="billing-portal">Manage billing</button><p class="note">Invoices, your card, and cancelling, on Polar.</p>'
    : '<button type="button" id="billing-checkout">Upgrade to Pro, $6 a month</button><p class="note">Pro has no note limit and holds 10 GB of files. Polar takes the payment and handles tax. Every file you have uploaded counts, deleted ones too.</p>'
}</section>`
      : "";
  return page(
    "Your account",
    `<p>Signed in as ${escape(email)}.</p>
<p id="signed-out" role="status" hidden>Passkey removed. Every other device and browser was signed out, including whoever added it. Sign in again on your own devices.</p>
${step === "none" ? "" : `<section><p>${PROMPTS[step]}</p><button type="button" id="add">Add a passkey</button></section>`}
${rows ? `<section><h2>Passkeys</h2><ul>${rows}</ul>${step === "none" ? '<button type="button" class="quiet" id="add">Add another passkey</button>' : ""}</section>` : ""}
${appRows ? `<section><h2>Connected apps</h2><ul>${appRows}</ul><p class="note">A disconnected app can't renew its access, and loses it within an hour. Connecting it again asks you again.</p></section>` : ""}
${githubSection}
${orcidSection}
${planSection}
${activityRows ? `<section><h2>What your connections did</h2>${activityRows}<p class="note">Each connection's last 50 calls: the notes it read or changed, when it used your approval, and which calls background filing made with nobody there.</p></section>` : ""}
<button type="button" class="quiet" id="sign-out">Sign out</button>`,
    `if (new URLSearchParams(location.search).has("signed-out")) {
  document.getElementById("signed-out").hidden = false;
  history.replaceState(null, "", location.pathname);
}
// Changing passkeys asks for one that can approve first (the proof lasts 10 minutes, and a security key can
// take a while to find), so a new one needn't wait 72 hours. Someone who lost theirs can carry on when adding,
// and the server applies the wait.
const proofEnds = Date.now() + ${vouchLeftMs} - 120_000;
const confirmPasskey = async (lostMessage) => {
  if (!${hasApproving} || Date.now() < proofEnds) return;
  try {
    await passkeySignIn();
  } catch (error) {
    if (!lostMessage || !confirm(lostMessage)) throw error;
  }
};
document.getElementById("add").onclick = run(async () => {
  await confirmPasskey("Couldn't confirm with one of your passkeys. Lost them? Carry on, and the new passkey waits 72 hours before it can approve.");
  const options = await api("/passkey/generate-register-options");
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
  await api("/passkey/verify-registration", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
  location.reload();
});
for (const button of document.querySelectorAll("[data-remove]")) {
  button.onclick = run(async () => {
    if (button.dataset.last === "true" && !confirm("This is your last passkey that can approve. Without one you can't approve changes, and a new passkey waits 72 hours first. Remove it?")) return;
    // A passkey that can't approve yet can go without proof; that's how you remove one you didn't add. With
    // proof, removing one also signs out whoever added it.
    await confirmPasskey(button.dataset.approves === "true" ? undefined : "Couldn't confirm with a passkey that can approve. Remove this one anyway? Whoever added it stays signed in.");
    const reply = await api("/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id: button.dataset.remove }) });
    if (reply?.signedOut) location.search = "?signed-out";
    else location.reload();
  });
}
for (const button of document.querySelectorAll("[data-disconnect]")) {
  button.onclick = run(async () => {
    if (!confirm("Disconnect " + button.dataset.name + "? It can't renew its access on any device, and loses it within an hour.")) return;
    await api("/connected-apps/disconnect", { method: "POST", body: JSON.stringify({ clientId: button.dataset.disconnect }) });
    location.reload();
  });
}
for (const button of document.querySelectorAll("[data-github]")) {
  button.onclick = run(async () => {
    if (!confirm("Stop reading " + button.dataset.name + "'s repos? Your projects stay as they are. To remove the app from GitHub too, do it on GitHub.")) return;
    const res = await fetch("/connectors/github/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId: Number(button.dataset.github) }) });
    if (!res.ok) throw new Error("Couldn't disconnect. Try again.");
    location.reload();
  });
}
for (const [id, path] of [["billing-checkout", "/billing/checkout"], ["billing-portal", "/billing/portal"]]) {
  const button = document.getElementById(id);
  if (button) button.onclick = run(async () => {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) throw new Error("Couldn't reach Polar. Try again.");
    location.href = (await res.json()).url;
  });
}
const orcidUnlink = document.getElementById("orcid-unlink");
if (orcidUnlink) orcidUnlink.onclick = run(async () => {
  if (!confirm("Unlink your ORCID iD? Your papers stay, without the author positions it gave them.")) return;
  const res = await fetch("/connectors/orcid/unlink", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error("Couldn't unlink. Try again.");
  location.href = "/account";
});
document.getElementById("sign-out").onclick = run(async () => {
  await api("/sign-out", { method: "POST", body: "{}" });
  // The site's copy of the record (apps/web/src/record.ts) leaves with the session. Every open tab of the site
  // closes its socket and its connection to the copy first; one that doesn't answer in a few seconds (an old
  // build) keeps it until it closes, when the deletion still queued here goes through.
  try { new BroadcastChannel("brainiac:session").postMessage("signed-out"); } catch {}
  try { localStorage.removeItem("brainiac:user"); } catch {}
  const names = ((await indexedDB.databases?.()) ?? []).map((db) => db.name).filter((name) => name?.startsWith("brainiac:"));
  await Promise.all(names.map((name) => new Promise((done) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = deleting.onerror = done;
    deleting.onblocked = () => setTimeout(done, 3000);
  })));
  location.href = "/sign-in";
});`,
  );
}

const GITHUB_OUTCOMES: Readonly<Record<string, string>> = {
  connected: "GitHub is connected. Its repos wait for you as projects to accept.",
  requested:
    "Your organization's owner has to approve the app on GitHub first. Connect again once they have.",
  failed:
    "That didn't connect. Start again from Connect GitHub repos, signed in to GitHub as the account that has the repos.",
};

const ORCID_OUTCOMES: Readonly<Record<string, string>> = {
  linked: "ORCID is linked. Works that aren't in your record yet wait for you as papers to accept.",
  denied: "ORCID wasn't linked: you didn't allow it on ORCID.",
  failed: "That didn't link. Start again from Link your ORCID iD.",
};

/** The account page's plan section: shown only on a stage with billing (`view.limits` set). */
export interface PlanSection {
  readonly view: PlanView;
  /** Polar's checkout just sent the person back (`?billing=paid`); the webhook may not have landed yet. */
  readonly paid: boolean;
}

const megabytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${Number((bytes / 1024 ** 3).toFixed(1))} GB`
    : `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;

/** The account page's ORCID section: shown only on a stage with an ORCID client. */
export interface OrcidSection {
  /** The iD the person proved, if they did. */
  readonly linked: string | null;
  /** Its page on ORCID (the sandbox's, off prod). */
  readonly profile: string;
  /** How linking just went, from the callback's redirect (`?orcid=`). */
  readonly outcome?: string | null;
}

/** The account page's GitHub section: shown only on a stage with the GitHub App set up. */
export interface GithubSection {
  /** The App's URL name, for GitHub's page where an installation's repos are picked (personal or organization). */
  readonly slug: string;
  /** How connecting just went, from the setup route's redirect (`?github=`). */
  readonly outcome?: string | null;
  readonly installations: readonly {
    readonly id: number;
    readonly account: string;
    readonly checkedAt: Date | null;
    readonly suspended: boolean;
    readonly member?: { readonly repos: readonly string[]; readonly lapsed: boolean };
  }[];
}

/** A connection and its most recent calls, from the record's audit log. */
export interface Activity {
  readonly connection: Pick<Connection, "kind" | "oauthClientId" | "level" | "sensitive">;
  readonly calls: readonly AuditCall[];
}

/** The notes one call touched, by path, as a short phrase after the tool's name. */
function describeNotes(call: AuditCall): string {
  const paths = call.notes.map((note) => note.path ?? "a deleted note");
  const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
  return (
    (shown ? `: ${escape(shown)}` : "") +
    (call.approvalId ? ' <span class="note">with your approval</span>' : "") +
    (call.background ? ' <span class="note">by background filing</span>' : "")
  );
}

export interface ConsentPageOptions {
  email: string;
  /** The client's own name for itself, from its metadata document. */
  clientName: string | undefined;
  /** The metadata URL the client identifies by. Its host is the part nobody else can claim. */
  clientId: string;
  redirectUri: string;
}

/** Shown once per client: whether an MCP client (claude.ai, Claude Code, ...) may use this account's record. */
export function consentPage({ email, clientName, clientId, redirectUri }: ConsentPageOptions): Response {
  const from = URL.canParse(clientId) ? new URL(clientId).host : clientId;
  const returnsTo = URL.canParse(redirectUri) ? new URL(redirectUri).host : redirectUri;
  return page(
    "Connect an app",
    `<p><strong>${escape(clientName ?? from)}</strong> wants to use your Brainiac record through Brainiac's tools.</p>
<p class="note">It identifies as ${escape(from)} and returns to ${escape(returnsTo)}. You're signed in as ${escape(email)}.</p>
<section><button type="button" id="allow">Allow</button> <button type="button" class="quiet" id="deny">Deny</button></section>`,
    `const answer = (accept) => run(async () => next(await api("/oauth2/consent", { method: "POST", body: JSON.stringify({ accept, oauth_query: oauthQuery }) }), "/account"));
document.getElementById("allow").onclick = answer(true);
document.getElementById("deny").onclick = answer(false);`,
  );
}

/** The consent page when its link wasn't one the server signed, or has expired. */
export const consentExpired = () =>
  page(
    "Connect an app",
    `<p>This link has expired. Go back to the app you were connecting and start again.</p>`,
    "",
  );

export interface CliLoginOptions {
  email: string;
  /** The name the CLI gave its machine. The CLI says it, so the page shows it as a name, never as proof. */
  device: string;
  /** Where the CLI listens on this machine's loopback, and the value only it knows to expect back. */
  port: number;
  state: string;
}

/** `brainiac login`: whether the CLI in a terminal on this machine may sync this account's record. */
export function cliLoginPage({ email, device, port, state }: CliLoginOptions): Response {
  return page(
    "Connect a laptop",
    `<p>The <strong>brainiac</strong> command on <strong>${escape(device)}</strong> wants to sync your Brainiac record.</p>
<p class="note">Continue only if you just ran <code>brainiac login</code>. It won't see your sensitive notes unless you allow it. You're signed in as ${escape(email)}.</p>
<form method="post"><input type="hidden" name="port" value="${port}"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="device" value="${escape(device)}">
<button>Connect</button></form>`,
    "",
  );
}

/**
 * Hands the new token to the CLI listening on this machine's loopback, in a POST body, so it stays out of the
 * address bar, history and request logs. Only ever 127.0.0.1: the port comes from the page, never the host.
 */
export function cliLoginDone({
  port,
  state,
  token,
}: Omit<CliLoginOptions, "email" | "device"> & { token: string }) {
  return page(
    "Connect a laptop",
    `<p>Handing the connection to your terminal…</p>
<form id="hand" method="post" action="http://127.0.0.1:${port}/callback"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="token" value="${escape(token)}">
<noscript><button>Continue</button></noscript></form>`,
    `document.getElementById("hand").submit();`,
  );
}

/** The login page when its link isn't one `brainiac login` made. */
export const cliLoginInvalid = () =>
  new Response("This link isn't one brainiac login made. Run brainiac login again in your terminal.", {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
