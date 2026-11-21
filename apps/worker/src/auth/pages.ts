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

const page = (title: string, body: string, script: string, head = "") =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Brainiac</title>${head}
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1c1a16;background:#f5f1e8;color-scheme:light}
h1{font-size:1.5rem}a{color:#ad411b}form,section{margin:1.5rem 0}input,button{font:inherit;padding:.5rem .75rem;border-radius:.5rem;border:1px solid #d2c8b3}
input{width:100%;box-sizing:border-box;margin:.25rem 0;background:#fbf9f3;color:inherit}button{cursor:pointer;background:#1c1a16;color:#f5f1e8;border:0;margin:.25rem 0}
button.quiet{background:none;color:#1c1a16;border:1px solid #d2c8b3}.note{color:#57514a;font-size:.9rem}#error{color:#b42318}
ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.5rem 0;border-bottom:1px solid #e0d8c7}
</style></head><body><h1>${title}</h1>${body}<p id="error" role="alert"></p>
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
  const labels = { google: "Google", github: "GitHub" };
  const social = providers
    .map(
      (p) => `<button type="button" class="quiet" data-provider="${p}">Continue with ${labels[p]}</button>`,
    )
    .join(" ");
  return page(
    "Sign in",
    `<section><button type="button" id="passkey">Sign in with a passkey</button></section>
${emailCodes ? "" : '<p class="note">Email codes aren\'t set up on this server yet.</p>'}
<form id="email"${emailCodes ? "" : " hidden"}><label>New here, or no passkey with you? Get a code by email.
<input type="email" name="email" required autocomplete="email"></label>
<div id="turnstile"></div><button>Email me a code</button></form>
<form id="code" hidden><label>Enter the code we sent.
<input name="otp" required inputmode="numeric" autocomplete="one-time-code"></label><button>Continue</button></form>
${social ? `<section>${social}</section>` : ""}`,
    `const landsOn = ${JSON.stringify(landsOn).replace(/</g, "\\u003c")};
let widget;
window.onTurnstileLoad = () => { widget = turnstile.render("#turnstile", { sitekey: ${JSON.stringify(turnstileSiteKey)}, theme: "light" }); };
const captcha = () => {
  const token = turnstile.getResponse(widget);
  turnstile.reset(widget);
  if (!token) throw new Error("Wait for the check above to finish, then try again.");
  return { "x-captcha-response": token };
};
let email;
document.getElementById("passkey").onclick = run(async () => next(await passkeySignIn(), landsOn));
document.getElementById("email").onsubmit = run(async (event) => {
  email = new FormData(event.target).get("email");
  await api("/email-otp/send-verification-otp", { method: "POST", headers: captcha(), body: JSON.stringify({ email, type: "sign-in" }) });
  event.target.hidden = true;
  document.getElementById("code").hidden = false;
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
  );
}

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
    : '<button type="button" id="billing-checkout">Upgrade to Pro, $6 a month</button><p class="note">Pro has no note limit and holds 10 GB of files. Polar takes the payment and handles tax.</p>'
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
