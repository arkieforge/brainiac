// The two pages auth needs before the web app exists (#50): sign in or up, then enroll passkeys. Plain HTML
// with a little inline script; the WebAuthn ceremonies use the browser's own JSON helpers.
import { canApprove, type ApprovingPasskey } from "./recovery.ts";

/** What the account page asks for next: a first passkey is required, a second strongly suggested. */
export const nextPasskeyStep = (passkeys: readonly unknown[]) =>
  passkeys.length === 0 ? "enroll" : passkeys.length === 1 ? "second" : "none";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string, script: string, head = "") =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Brainiac</title>${head}
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem}form,section{margin:1.5rem 0}input,button{font:inherit;padding:.5rem .75rem;border-radius:.5rem;border:1px solid #bbb}
input{width:100%;box-sizing:border-box;margin:.25rem 0}button{cursor:pointer;background:#1a1a1a;color:#fff;border:0;margin:.25rem 0}
button.quiet{background:none;color:#1a1a1a;border:1px solid #bbb}.note{color:#555;font-size:.9rem}#error{color:#b00020}
ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.5rem 0;border-bottom:1px solid #eee}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}button.quiet{color:#eee}.note{color:#aaa}li{border-color:#333}}
</style></head><body><h1>${title}</h1>${body}<p id="error" role="alert"></p>
<script>
const api = async (path, init = {}) => {
  const res = await fetch("/api/auth" + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? "Something went wrong. Try again.");
  return body;
};
const run = (fn) => async (event) => {
  event.preventDefault();
  document.getElementById("error").textContent = "";
  try { await fn(event); } catch (error) { document.getElementById("error").textContent = error.message; }
};
const passkeySignIn = async () => {
  const options = await api("/passkey/generate-authenticate-options");
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  await api("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
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
  turnstileSiteKey: string;
  providers: readonly ("google" | "github")[];
}

export function signInPage({ turnstileSiteKey, providers }: SignInPageOptions): Response {
  const labels = { google: "Google", github: "GitHub" };
  const social = providers
    .map(
      (p) => `<button type="button" class="quiet" data-provider="${p}">Continue with ${labels[p]}</button>`,
    )
    .join(" ");
  return page(
    "Sign in",
    `<section><button type="button" id="passkey">Sign in with a passkey</button></section>
<form id="email"><label>New here, or no passkey with you? Get a code by email.
<input type="email" name="email" required autocomplete="email"></label>
<div id="turnstile"></div><button>Email me a code</button></form>
<form id="code" hidden><label>Enter the code we sent.
<input name="otp" required inputmode="numeric" autocomplete="one-time-code"></label><button>Continue</button></form>
${social ? `<section>${social}</section>` : ""}`,
    `let widget;
window.onTurnstileLoad = () => { widget = turnstile.render("#turnstile", { sitekey: ${JSON.stringify(turnstileSiteKey)} }); };
const captcha = () => {
  const token = turnstile.getResponse(widget);
  turnstile.reset(widget);
  if (!token) throw new Error("Wait for the check above to finish, then try again.");
  return { "x-captcha-response": token };
};
let email;
document.getElementById("passkey").onclick = run(async () => {
  await passkeySignIn();
  location.href = "/account";
});
document.getElementById("email").onsubmit = run(async (event) => {
  email = new FormData(event.target).get("email");
  await api("/email-otp/send-verification-otp", { method: "POST", headers: captcha(), body: JSON.stringify({ email, type: "sign-in" }) });
  event.target.hidden = true;
  document.getElementById("code").hidden = false;
});
document.getElementById("code").onsubmit = run(async (event) => {
  const otp = new FormData(event.target).get("otp");
  await api("/sign-in/email-otp", { method: "POST", body: JSON.stringify({ email, otp }) });
  location.href = "/account";
});
for (const button of document.querySelectorAll("[data-provider]")) {
  button.onclick = run(async () => {
    const { url } = await api("/sign-in/social", { method: "POST", headers: captcha(), body: JSON.stringify({ provider: button.dataset.provider, callbackURL: "/account" }) });
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
  return page(
    "Your account",
    `<p>Signed in as ${escape(email)}.</p>
${step === "none" ? "" : `<section><p>${PROMPTS[step]}</p><button type="button" id="add">Add a passkey</button></section>`}
${rows ? `<section><h2>Passkeys</h2><ul>${rows}</ul>${step === "none" ? '<button type="button" class="quiet" id="add">Add another passkey</button>' : ""}</section>` : ""}
<button type="button" class="quiet" id="sign-out">Sign out</button>`,
    `// Changing passkeys asks for one that can approve first (the proof lasts 10 minutes, and a security key can
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
    // A passkey that's still waiting can go without proof; that's how you remove one you didn't add.
    if (button.dataset.approves === "true") await confirmPasskey();
    await api("/passkey/delete-passkey", { method: "POST", body: JSON.stringify({ id: button.dataset.remove }) });
    location.reload();
  });
}
document.getElementById("sign-out").onclick = run(async () => {
  await api("/sign-out", { method: "POST", body: "{}" });
  location.href = "/sign-in";
});`,
  );
}
