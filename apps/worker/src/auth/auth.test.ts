import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createAuth } from "./config.ts";
import { nextPasskeyStep } from "./pages.ts";
import { type ApprovingPasskey, canApprove, RECOVERY_WAIT_MS, SIGN_UP_MS, VOUCH_MS } from "./recovery.ts";
import { createAuthenticator } from "./test-authenticator.ts";

const ORIGIN = "https://brainiac.test";
// The fixture student (fictional).
const EMAIL = "ada.okafor@example.edu";

/** The WebAuthn challenge from a ceremony's options. */
const challenge = (body: unknown) => {
  if (typeof body === "object" && body && "challenge" in body && typeof body.challenge === "string") {
    return { challenge: body.challenge };
  }
  throw new Error("no challenge in options");
};

// Better Auth keeps rate-limit counts in module memory, so device addresses stay unique across tests.
let devices = 0;

type Mail = { to: string; subject: string; text: string };

function setup({ noticesFail = false } = {}) {
  const mail: Mail[] = [];
  /** Flip `down` to make every database call fail, like Neon being unreachable. */
  const neon = { down: false };
  const memory = memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    passkey: [],
    jwks: [],
  });
  const auth = createAuth({
    database: (options: Parameters<typeof memory>[0]) => {
      const adapter = memory(options);
      return new Proxy(adapter, {
        get: (target, key) => {
          const value: unknown = Reflect.get(target, key);
          return neon.down && typeof value === "function"
            ? () => Promise.reject(new Error("Neon is down"))
            : value;
        },
      });
    },
    baseURL: ORIGIN,
    secret: "a-test-secret-that-is-long-enough-to-pass",
    turnstileSecret: "test-turnstile-secret",
    sendEmail: async (message) => {
      if (noticesFail && message.subject.includes("passkey")) throw new Error("mail is down");
      mail.push(message);
    },
  });

  /** A browser: keeps cookies between calls and talks to the auth handler like the pages do. */
  const browser = () => {
    const cookies = new Map<string, string>();
    // Each browser is its own device, so the per-IP rate limit sees them apart.
    const ip = `203.0.113.${++devices}`;
    const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
      const res = await auth.handler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: init.body === undefined ? "GET" : "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            "cf-connecting-ip": ip,
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...init.headers,
          },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        }),
      );
      for (const header of res.headers.getSetCookie()) {
        const [pair = ""] = header.split(";");
        const eq = pair.indexOf("=");
        const value = pair.slice(eq + 1);
        if (value === "" || /max-age=0/i.test(header)) cookies.delete(pair.slice(0, eq));
        else cookies.set(pair.slice(0, eq), value);
      }
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, body };
    };
    const ok = async (path: string, init?: Parameters<typeof call>[1]) => {
      const res = await call(path, init);
      if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body;
    };

    return {
      call,
      async signInWithCode(email = EMAIL) {
        await ok("/email-otp/send-verification-otp", {
          body: { email, type: "sign-in" },
          headers: { "x-captcha-response": "passed" },
        });
        const otp = mail.at(-1)?.text.match(/\d{6}/)?.[0];
        await ok("/sign-in/email-otp", { body: { email, otp } });
      },
      async addPasskey(authenticator: ReturnType<typeof createAuthenticator>) {
        const options = challenge(await ok("/passkey/generate-register-options"));
        return call("/passkey/verify-registration", { body: { response: authenticator.register(options) } });
      },
      async signInWithPasskey(authenticator: ReturnType<typeof createAuthenticator>) {
        const options = challenge(await ok("/passkey/generate-authenticate-options"));
        await ok("/passkey/verify-authentication", {
          body: { response: authenticator.authenticate(options) },
        });
      },
      async passkeys() {
        const list = await ok("/passkey/list-user-passkeys");
        if (!Array.isArray(list)) throw new Error("passkeys is not a list");
        return list.map((p: ApprovingPasskey & { approvesAt: string | null; credentialID: string }) => ({
          id: p.id,
          credentialID: p.credentialID,
          approvesAt: p.approvesAt ? new Date(p.approvesAt) : null,
        }));
      },
      remove: (id: string) => call("/passkey/delete-passkey", { body: { id } }),
    };
  };

  /** A student who signed up the way the account page leads: an email code, then each passkey in turn. */
  const student = async (...authenticators: ReturnType<typeof createAuthenticator>[]) => {
    const tab = browser();
    await tab.signInWithCode();
    for (const authenticator of authenticators) {
      expect((await tab.addPasskey(authenticator)).status).toBe(200);
    }
    return tab;
  };

  /** The fixture student's user id, read straight from the database. */
  const studentId = async () => {
    const found = await (await auth.$context).internalAdapter.findUserByEmail(EMAIL);
    if (!found) throw new Error("no user");
    return found.user.id;
  };

  return { auth, mail, browser, student, neon, studentId };
}

const notices = (mail: Mail[]) => mail.filter((m) => m.subject.includes("passkey"));
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

const approving = (passkeys: { approvesAt: Date | null }[], now = new Date()) =>
  passkeys.filter((p) => canApprove(p, now)).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T09:00:00Z"));
  // Turnstile's siteverify: every token passes, so tests exercise only whether one is required.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: true }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sign-up", () => {
  it("refuses to send a code without a Turnstile token", async () => {
    const { browser, mail } = setup();
    const res = await browser().call("/email-otp/send-verification-otp", {
      body: { email: EMAIL, type: "sign-in" },
    });
    expect(res.status).toBe(400);
    expect(mail).toHaveLength(0);
  });

  it("enrolls a first passkey and the second it asks for, both approving at once without a notice", async () => {
    const { browser, mail } = setup();
    const tab = browser();
    await tab.signInWithCode();
    expect(nextPasskeyStep(await tab.passkeys())).toBe("enroll");

    expect((await tab.addPasskey(createAuthenticator(ORIGIN))).status).toBe(200);
    expect(approving(await tab.passkeys())).toBe(1);
    expect(nextPasskeyStep(await tab.passkeys())).toBe("second");

    // Same session, as the page does after reloading.
    expect((await tab.addPasskey(createAuthenticator(ORIGIN))).status).toBe(200);
    expect(approving(await tab.passkeys())).toBe(2);
    expect(nextPasskeyStep(await tab.passkeys())).toBe("none");
    expect(notices(mail)).toHaveLength(0);
  });

  it("limits code requests per device and offers no password reset by code", async () => {
    const { browser } = setup();
    const tab = browser();
    const send = () =>
      tab.call("/email-otp/send-verification-otp", {
        body: { email: EMAIL, type: "sign-in" },
        headers: { "x-captcha-response": "passed" },
      });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await send()).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await tab.call("/email-otp/request-password-reset", { body: { email: EMAIL } })).status).toBe(
      404,
    );
  });
});

describe("sessions", () => {
  it("keep working through a short Neon outage", async () => {
    const { student, neon } = setup();
    const tab = await student(createAuthenticator(ORIGIN));
    neon.down = true;
    const res = await tab.call("/get-session");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { email: EMAIL } });
  });
});

describe("recovery", () => {
  it("makes a passkey added without one wait 72 hours, and emails a notice", async () => {
    const { student, browser, mail } = setup();
    await student(createAuthenticator(ORIGIN));

    // Both passkeys lost: sign in by email on a new device and enroll a new one.
    const tab = browser();
    await tab.signInWithCode();
    expect((await tab.addPasskey(createAuthenticator(ORIGIN))).status).toBe(200);

    const added = (await tab.passkeys()).at(-1);
    expect(added?.approvesAt?.getTime()).toBe(Date.now() + RECOVERY_WAIT_MS);
    const notice = mail.at(-1);
    expect(notice?.to).toBe(EMAIL);
    expect(notice?.subject).toBe("A new passkey was added to your Brainiac account");
    expect(notice?.text).toContain(`${ORIGIN}/account`);

    const justBefore = new Date(Date.now() + RECOVERY_WAIT_MS - 1);
    expect(canApprove(added ?? { approvesAt: null }, justBefore)).toBe(false);
    expect(canApprove(added ?? { approvesAt: null }, new Date(Date.now() + RECOVERY_WAIT_MS))).toBe(true);
  });

  it("doesn't let a waiting passkey vouch for another one", async () => {
    const { student, browser } = setup();
    await student(createAuthenticator(ORIGIN));
    const tab = browser();
    await tab.signInWithCode();
    const waiting = createAuthenticator(ORIGIN);
    await tab.addPasskey(waiting);

    await tab.signInWithPasskey(waiting);
    await tab.addPasskey(createAuthenticator(ORIGIN));
    const passkeys = await tab.passkeys();
    expect(passkeys.at(-1)?.approvesAt?.getTime()).toBe(Date.now() + RECOVERY_WAIT_MS);
  });

  it("counts a passkey sign-in as proof for 10 minutes", async () => {
    const { student, browser, mail } = setup();
    const real = createAuthenticator(ORIGIN);
    await student(real);
    later(SIGN_UP_MS + 1);
    const tab = browser();
    await tab.signInWithCode();
    await tab.signInWithPasskey(real);
    await tab.addPasskey(createAuthenticator(ORIGIN));
    expect((await tab.passkeys()).at(-1)?.approvesAt?.getTime()).toBe(Date.now());
    expect(notices(mail)).toHaveLength(0);

    later(VOUCH_MS + 1);
    await tab.addPasskey(createAuthenticator(ORIGIN));
    expect((await tab.passkeys()).at(-1)?.approvesAt?.getTime()).toBe(Date.now() + RECOVERY_WAIT_MS);
    expect(notices(mail)).toHaveLength(1);
  });

  it("treats a first passkey on an account left without one as recovery", async () => {
    const { browser, mail } = setup();
    const signedUp = browser();
    await signedUp.signInWithCode();
    // Closed the tab before enrolling; someone with the email comes back later.
    later(SIGN_UP_MS + 1);
    const tab = browser();
    await tab.signInWithCode();
    await tab.addPasskey(createAuthenticator(ORIGIN));
    expect((await tab.passkeys())[0]?.approvesAt?.getTime()).toBe(Date.now() + RECOVERY_WAIT_MS);
    expect(notices(mail)).toHaveLength(1);
  });

  it("gives an account with an unverified address no passkey to hand on", async () => {
    const { auth, browser, mail } = setup();
    const tab = browser();
    await tab.signInWithCode();
    // As if a GitHub sign-in made the account with an address GitHub never verified.
    const { internalAdapter } = await auth.$context;
    const found = await internalAdapter.findUserByEmail(EMAIL);
    if (!found) throw new Error("no user");
    await internalAdapter.updateUser(found.user.id, { emailVerified: false });

    expect((await tab.addPasskey(createAuthenticator(ORIGIN))).status).toBe(403);
    expect(await tab.passkeys()).toHaveLength(0);
    expect(notices(mail)).toHaveLength(0);
  });

  it("removes the new passkey when the notice can't be sent", async () => {
    const { student, browser } = setup({ noticesFail: true });
    await student(createAuthenticator(ORIGIN));
    const tab = browser();
    await tab.signInWithCode();
    const res = await tab.addPasskey(createAuthenticator(ORIGIN));
    expect(res.status).toBe(503);
    expect(await tab.passkeys()).toHaveLength(1);
  });

  it("doesn't let an email-only session remove a passkey that can approve", async () => {
    const { student, browser } = setup();
    const owner = await student(createAuthenticator(ORIGIN));
    const [real] = await owner.passkeys();

    const intruder = browser();
    await intruder.signInWithCode();
    await intruder.addPasskey(createAuthenticator(ORIGIN));
    expect((await intruder.remove(real?.id ?? "")).status).toBe(403);
    expect(await intruder.passkeys()).toHaveLength(2);

    // The owner removes the intruder's waiting passkey; that needs no fresh passkey proof.
    later(VOUCH_MS + 1);
    const pending = (await owner.passkeys()).find((p) => !canApprove(p));
    expect((await owner.remove(pending?.id ?? "")).status).toBe(200);
    expect(await owner.passkeys()).toHaveLength(1);
  });

  it("refuses a removal from a revoked session the cookie cache still holds", async () => {
    const { auth, student, studentId } = setup();
    const tab = await student(createAuthenticator(ORIGIN), createAuthenticator(ORIGIN));
    const [first] = await tab.passkeys();
    const { internalAdapter, adapter } = await auth.$context;
    await internalAdapter.deleteUserSessions(await studentId());
    expect((await tab.remove(first?.id ?? "")).status).toBe(401);
    expect(await adapter.count({ model: "passkey" })).toBe(2);
  });

  it("finds the proving passkey past the first 100", async () => {
    const { auth, student, studentId } = setup();
    const tab = await student(createAuthenticator(ORIGIN));
    const { adapter } = await auth.$context;
    const userId = await studentId();
    const past = new Date(Date.now() - 1);
    for (let i = 0; i < 100; i++) {
      await adapter.create({
        model: "passkey",
        data: {
          userId,
          publicKey: "unused",
          credentialID: `seeded-${i}`,
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
          createdAt: past,
          approvesAt: past,
        },
      });
    }
    // Enrolled after the seeded rows, so a 100-row list would miss it.
    const late = createAuthenticator(ORIGIN);
    await tab.addPasskey(late);
    await tab.signInWithPasskey(late);
    const [first] = await tab.passkeys();
    expect((await tab.remove(first?.id ?? "")).status).toBe(200);
  });

  it("needs proof to remove a passkey once its wait is over", async () => {
    const { student, browser } = setup();
    await student(createAuthenticator(ORIGIN));
    const intruder = browser();
    await intruder.signInWithCode();
    await intruder.addPasskey(createAuthenticator(ORIGIN));
    const added = (await intruder.passkeys()).at(-1);
    later(RECOVERY_WAIT_MS);
    expect((await intruder.remove(added?.id ?? "")).status).toBe(403);
  });

  it("sends the next passkey through recovery after you remove your last one", async () => {
    const { student, mail } = setup();
    const tab = await student(createAuthenticator(ORIGIN));
    const [only] = await tab.passkeys();
    expect((await tab.remove(only?.id ?? "")).status).toBe(200);
    later(SIGN_UP_MS + 1);
    await tab.signInWithCode();
    await tab.addPasskey(createAuthenticator(ORIGIN));
    expect((await tab.passkeys())[0]?.approvesAt?.getTime()).toBe(Date.now() + RECOVERY_WAIT_MS);
    expect(notices(mail)).toHaveLength(1);
  });
});
