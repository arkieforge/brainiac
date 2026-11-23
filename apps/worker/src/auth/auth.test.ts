import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { PROMPTS, TOOLS } from "@brainiac/base";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { bundleWorker } from "../../../../scripts/bundle-worker.ts";
import type { TestBase } from "../../test/harness.ts";
import { serveMcp, type Records } from "../mcp/handler.ts";
import { createAuth } from "./config.ts";
import { consent } from "./consent.ts";
import { nextPasskeyStep } from "./pages.ts";
import { type ApprovingPasskey, canApprove, RECOVERY_WAIT_MS, SIGN_UP_MS, VOUCH_MS } from "./approving.ts";
import { createAuthenticator } from "./test-authenticator.ts";

const ORIGIN = "https://brainiac.test";
// The fixture student (fictional).
const EMAIL = "nadia.karim@example.edu";

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

// One oauthResource table for the whole file, as one Neon database outlives the isolate that seeded it: the seed's
// done mark lasts the isolate (config.ts), so a fresh table per test would never be seeded again.
let resources: unknown[] = [];

function setup({
  noticesFail = false,
  onDisconnect,
}: {
  noticesFail?: boolean;
  onDisconnect?: (userId: string, clientId: string) => Promise<void>;
} = {}) {
  const mail: Mail[] = [];
  /** Flip `down` to make every database call fail, like Neon being unreachable. */
  const neon = { down: false };
  let resourceReads = 0;
  const memory = memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
    passkey: [],
    jwks: [],
    oauthClient: [],
    // The adapter commits a transaction by assigning the table, so the shared one goes through an accessor.
    get oauthResource() {
      return resources;
    },
    set oauthResource(rows) {
      resources = rows;
    },
    oauthClientResource: [],
    oauthRefreshToken: [],
    oauthAccessToken: [],
    oauthConsent: [],
    oauthClientAssertion: [],
  });
  const config: Parameters<typeof createAuth>[0] = {
    database: (options: Parameters<typeof memory>[0]) => {
      const adapter = memory(options);
      const findOne: typeof adapter.findOne = (data) => {
        if (data.model === "oauthResource") resourceReads++;
        return adapter.findOne(data);
      };
      // Like Postgres, a second row with the same id is refused; single-use reservations rely on it.
      const create: typeof adapter.create = async (data) => {
        const id: unknown = data.data.id;
        const taken =
          typeof id === "string" &&
          (await adapter.findOne({ model: data.model, where: [{ field: "id", value: id }] }));
        if (taken) throw new Error(`duplicate key value violates unique constraint "${data.model}_pkey"`);
        return adapter.create(data);
      };
      return new Proxy(adapter, {
        get: (target, key) => {
          const value: unknown =
            key === "create" ? create : key === "findOne" ? findOne : Reflect.get(target, key);
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
    onDisconnect,
  };
  const auth = createAuth(config);

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
      /** The session cookie, for pages served outside the auth handler. */
      cookie: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      /** `oauthQuery`: the signed query an MCP client's authorize request put on the sign-in page. */
      async signInWithCode(email = EMAIL, oauthQuery?: string) {
        await ok("/email-otp/send-verification-otp", {
          body: { email, type: "sign-in" },
          headers: { "x-captcha-response": "passed" },
        });
        const otp = mail.at(-1)?.text.match(/\d{6}/)?.[0];
        return ok("/sign-in/email-otp", { body: { email, otp, oauth_query: oauthQuery } });
      },
      ok,
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

  /** The fixture student's user id (or another account's), read straight from the database. */
  const studentId = async (email = EMAIL) => {
    const found = await (await auth.$context).internalAdapter.findUserByEmail(email);
    if (!found) throw new Error("no user");
    return found.user.id;
  };

  return {
    auth,
    mail,
    browser,
    student,
    neon,
    studentId,
    /** Another Better Auth over the same database, with its own adapter, as the Worker builds one per request. */
    perRequest: () => createAuth(config),
    resourceReads: () => resourceReads,
  };
}

const notices = (mail: Mail[]) => mail.filter((m) => m.subject.includes("passkey"));
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

const approving = (passkeys: { approvesAt: Date | null }[], now = new Date()) =>
  passkeys.filter((p) => canApprove(p, now)).length;

// Each test starts a month after the last. /mcp caches signing keys per isolate (mcp/handler.ts) and refetches
// for a key it doesn't know at most every 30 seconds, so a clock that went back would hide each test's new keys.
let clock = Date.parse("2026-11-14T09:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((clock += 30 * 24 * 60 * 60_000));
  // Turnstile's siteverify: every token passes, so tests exercise only whether one is required.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: true }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

    // The owner removes the intruder's waiting passkey; that needs no fresh passkey proof. Without one it signs
    // nobody out, or the intruder could sign the owner out everywhere by removing its own.
    later(VOUCH_MS + 1);
    const pending = (await owner.passkeys()).find((p) => !canApprove(p));
    expect(await owner.remove(pending?.id ?? "")).toEqual({
      status: 200,
      body: { status: true, signedOut: false },
    });
    expect(await owner.passkeys()).toHaveLength(1);
    expect(await intruder.passkeys()).toHaveLength(1);
  });

  it("signs out whoever added a waiting passkey when the owner removes it with a passkey", async () => {
    const { student, browser } = setup();
    const real = createAuthenticator(ORIGIN);
    const owner = await student(real);
    const intruder = browser();
    await intruder.signInWithCode();
    await intruder.addPasskey(createAuthenticator(ORIGIN));

    later(SIGN_UP_MS + 1);
    await owner.signInWithPasskey(real);
    const pending = (await owner.passkeys()).find((p) => !canApprove(p));
    expect(await owner.remove(pending?.id ?? "")).toEqual({
      status: 200,
      body: { status: true, signedOut: true },
    });

    // Even with its cached cookie, the intruder's session can't add another passkey or remove one.
    await expect(intruder.addPasskey(createAuthenticator(ORIGIN))).rejects.toThrow(/answered 401/);
    const [kept] = await owner.passkeys();
    expect((await intruder.remove(kept?.id ?? "")).status).toBe(401);
    expect((await intruder.call("/get-session?disableCookieCache=true")).body).toBeNull();
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

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A PKCE pair, as an OAuth client makes one per sign-in. */
const pkce = async () => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, codeChallenge: base64url(new Uint8Array(digest)) };
};

/** A client's DPoP key: each proof names the method, URL and (for /mcp) the token it's sent with. */
const dpopKey = async () => {
  const key = await generateKeyPair("ES256");
  const jwk = await exportJWK(key.publicKey);
  return async (htu: string, accessToken?: string) =>
    new SignJWT({
      htm: "POST",
      htu,
      jti: crypto.randomUUID(),
      ...(accessToken && {
        ath: base64url(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken))),
        ),
      }),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .sign(key.privateKey);
};

/** Where a JSON reply from the auth API sends the browser next. */
const redirectTo = (body: unknown) => {
  if (typeof body === "object" && body && "url" in body && typeof body.url === "string") return body.url;
  throw new Error(`no redirect in ${JSON.stringify(body)}`);
};

/** The tokens in a token endpoint reply. */
const tokens = (body: unknown) => {
  if (
    typeof body === "object" &&
    body &&
    "access_token" in body &&
    typeof body.access_token === "string" &&
    "refresh_token" in body &&
    typeof body.refresh_token === "string"
  ) {
    return { access: body.access_token, refresh: body.refresh_token };
  }
  throw new Error(`no tokens in ${JSON.stringify(body)}`);
};

// Workers hand back a manual redirect as the 3xx itself; the Fetch spec makes it an opaque status 0.
const opaqueRedirect = () =>
  Object.defineProperties(new Response(null), { type: { value: "opaqueredirect" }, status: { value: 0 } });
const plainRedirect = () =>
  new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });

// The real Base DO in workerd (test/harness.ts), one per user id, as /mcp reaches records in production.
let mf: Miniflare;
let bases: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>;
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: await bundleWorker(join(import.meta.dirname, "../../test/harness.ts")),
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { BASE: { className: "TestBase", useSQLite: true } },
    queueProducers: { JOBS: { queueName: "jobs" } },
    queueConsumers: { jobs: { maxBatchTimeout: 0 } },
  });
  bases = await mf.getDurableObjectNamespace("BASE");
});
afterAll(() => mf.dispose());

// The stub's RPC methods are the DO's own; Miniflare's types describe only fetch.
const stub = (id: DurableObjectId) => bases.get(id) as unknown as DurableObjectStub<TestBase>;
/** A person's record; index.ts finds it in the base registry (registry.test.ts), here one per user id. */
const recordOf = (userId: string) => stub(bases.idFromName(userId));
const records: Records = {
  of: async (userId) => recordOf(userId),
  byId: (baseId) => {
    try {
      return stub(bases.idFromString(baseId));
    } catch {
      return undefined;
    }
  },
};

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/nadia");
/** The fictional student's record, as they made it (test scores sensitive). */
async function seedFixture(userId: string) {
  const base = recordOf(userId);
  await base.setManifest(readFileSync(join(FIXTURE, "okf-base.yaml"), "utf8"));
  const notes = readdirSync(FIXTURE, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md"))
    .toSorted()
    .map((path) => ({
      path,
      raw: readFileSync(join(FIXTURE, path), "utf8"),
      class: path.startsWith("facts/tests/") ? ("sensitive" as const) : ("normal" as const),
    }));
  return base.seed(notes);
}

describe("the /mcp resource seed", () => {
  it("isn't read again by the Better Auth instances the Worker builds per request", async () => {
    const { auth, perRequest, resourceReads } = setup();
    await auth.$context;
    const seeded = resourceReads();
    for (const request of [perRequest(), perRequest()]) {
      expect((await request.handler(new Request(`${ORIGIN}/api/auth/ok`))).status).toBe(200);
    }
    expect(resourceReads()).toBe(seeded);
  });
});

describe("MCP clients", () => {
  // A client the way claude.ai and Claude Code identify: client_id is the URL of its metadata document (CIMD).
  const CLIENT_ID = "https://client.example/oauth/metadata.json";
  const REDIRECT_URI = "http://127.0.0.1:33418/callback";
  const RESOURCE = `${ORIGIN}/mcp`;
  const metadata = {
    client_id: CLIENT_ID,
    client_name: "Example MCP client",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  /**
   * The network as a Worker sees it: the metadata host answers `document` and Turnstile passes. Our own origin
   * isn't reachable, so `/mcp` has to check tokens without calling itself, and `Request` refuses
   * `redirect: "error"` the way workerd does.
   */
  const network = (document: () => Response) => {
    vi.stubGlobal(
      "Request",
      class extends Request {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          if (init?.redirect === "error")
            throw new TypeError('Invalid redirect value, must be "follow" or "manual"');
          super(input, init);
        }
      },
    );
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === CLIENT_ID) return document();
      if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json({ success: true });
      throw new TypeError(`no route to ${url}`);
    });
  };

  /**
   * What the client's browser tab sees first: the authorize endpoint, answered with a redirect. `resource: ""`
   * leaves the parameter out, as a client that doesn't follow RFC 8707 would.
   */
  const authorize = async (
    auth: ReturnType<typeof setup>["auth"],
    codeChallenge: string,
    resource = RESOURCE,
  ) => {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: "client-state",
      scope: "openid offline_access",
      ...(resource && { resource }),
    });
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: { accept: "text/html" } }),
    );
    return { status: res.status, location: res.headers.get("location") ?? "", body: await res.text() };
  };

  const token = async (
    auth: ReturnType<typeof setup>["auth"],
    params: Record<string, string>,
    headers: Record<string, string> = {},
  ) => {
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(
          Object.entries({ client_id: CLIENT_ID, resource: RESOURCE, ...params }).filter(([, v]) => v !== ""),
        ),
      }),
    );
    return { status: res.status, body: await res.json() };
  };

  const callMcp = (auth: ReturnType<typeof setup>["auth"], headers: Record<string, string>) =>
    serveMcp(
      auth,
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      }),
      records,
      { devTokens: false },
    );

  const initialize = (auth: ReturnType<typeof setup>["auth"], accessToken?: string) =>
    callMcp(auth, accessToken ? { authorization: `Bearer ${accessToken}` } : {});

  /**
   * A person signs in to a client: the server fetches the client's document, sends them to sign in, carries on
   * to consent, and back to the client with a code.
   */
  const grant = async (
    auth: ReturnType<typeof setup>["auth"],
    browser: ReturnType<typeof setup>["browser"],
    resource = RESOURCE,
    email = EMAIL,
  ) => {
    const { verifier, codeChallenge } = await pkce();
    const start = await authorize(auth, codeChallenge, resource);
    expect(start.status).toBe(302);
    const signIn = new URL(start.location, ORIGIN);
    expect(signIn.pathname).toBe("/sign-in");
    const tab = browser();
    const consentUrl = new URL(redirectTo(await tab.signInWithCode(email, signIn.search.slice(1))), ORIGIN);
    expect(consentUrl.pathname).toBe("/consent");
    const accepted = await tab.ok("/oauth2/consent", {
      body: { accept: true, oauth_query: consentUrl.search.slice(1) },
    });
    const callback = new URL(redirectTo(accepted));
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("client-state");
    return { tab, consentUrl, verifier, code: callback.searchParams.get("code") ?? "" };
  };

  it("signs in by metadata URL, consents, calls /mcp and refreshes", async () => {
    const { auth, browser } = setup();
    network(() => Response.json(metadata));

    // No token: the 401 points the client at the protected-resource metadata, which names this server.
    const challenged = await initialize(auth);
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const resourceMetadata = await auth.handler(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(await resourceMetadata.json()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [`${ORIGIN}/api/auth`],
    });
    expect(await auth.api.getOAuthServerConfig()).toMatchObject({
      client_id_metadata_document_supported: true,
    });

    const { tab, consentUrl, code, verifier } = await grant(auth, browser);
    const page = (url: URL) =>
      consent(new Request(url, { headers: { cookie: tab.cookie() } }), auth).then((res) => res.text());
    expect(await page(consentUrl)).toContain("<strong>Example MCP client</strong>");
    // The page names only the client the server signed for.
    const tampered = new URL(consentUrl);
    tampered.searchParams.set("redirect_uri", "https://attacker.example/callback");
    expect(await page(tampered)).toContain("This link has expired");

    const issued = await token(auth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ token_type: "Bearer" });
    const first = tokens(issued.body);

    const connected = await initialize(auth, first.access);
    expect(connected.status).toBe(200);
    expect(await connected.text()).toContain('"name":"brainiac"');
    // Signed by us but not for /mcp: the ID token's audience is the client.
    const idToken =
      issued.body && typeof issued.body === "object" && "id_token" in issued.body ? issued.body.id_token : "";
    for (const wrong of [String(idToken), "not-a-token", "a.b.c"]) {
      const refused = await initialize(auth, wrong);
      expect(refused.status).toBe(401);
      expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }

    const refreshed = await token(auth, {
      grant_type: "refresh_token",
      refresh_token: first.refresh,
    });
    expect(refreshed.status).toBe(200);
    expect((await initialize(auth, tokens(refreshed.body).access)).status).toBe(200);
  });

  it("answers 503, not a bad token, when it can't load signing keys", async () => {
    const { auth, browser, neon } = setup();
    network(() => Response.json(metadata));
    const { code, verifier } = await grant(auth, browser);
    const issued = await token(auth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    neon.down = true;
    // A 401 would send the client to refresh, which needs Neon too, and then maybe to sign the person in again.
    const res = await initialize(auth, tokens(issued.body).access);
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  /** Exchanges a fresh grant's code for tokens, optionally bound to a DPoP key. */
  const connect = async (
    setupResult: ReturnType<typeof setup>,
    dpop?: (htu: string) => Promise<string>,
    email = EMAIL,
  ) => {
    const { auth, browser } = setupResult;
    const { tab, code, verifier } = await grant(auth, browser, RESOURCE, email);
    const issued = await token(
      auth,
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier },
      dpop ? { dpop: await dpop(`${ORIGIN}/api/auth/oauth2/token`) } : {},
    );
    expect(issued.status).toBe(200);
    return { tab, issued: issued.body, ...tokens(issued.body) };
  };

  /** One JSON-RPC request to /mcp with a bearer token: the HTTP status and the message it answered. */
  const rpc = async (
    auth: ReturnType<typeof setup>["auth"],
    bearer: string,
    method: string,
    params: unknown,
    using: Records = records,
  ) => {
    const res = await serveMcp(
      auth,
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      using,
      { devTokens: false },
    );
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return { status: res.status, text, message: data ? JSON.parse(data.slice(5)) : undefined };
  };

  type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

  /** A tools/call, as a client sends it. */
  const call = async (
    auth: ReturnType<typeof setup>["auth"],
    bearer: string,
    name: string,
    args: unknown,
    using?: Records,
  ): Promise<ToolResult> => {
    const { status, message } = await rpc(auth, bearer, "tools/call", { name, arguments: args }, using);
    expect(status).toBe(200);
    return message.result;
  };

  /** A tool's answer as JSON, which must not be an error. */
  const answer = async (
    auth: ReturnType<typeof setup>["auth"],
    bearer: string,
    name: string,
    args: unknown,
  ) => {
    const result = await call(auth, bearer, name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return JSON.parse(result.content[0]?.text ?? "null");
  };

  /** A signed-in student whose client holds an access token for /mcp, and whose record holds the fixture. */
  const fixtureStudent = async (email = EMAIL) => {
    const ctx = setup({ onDisconnect: (userId, clientId) => recordOf(userId).disconnectApp(clientId) });
    network(() => Response.json(metadata));
    const connected = await connect(ctx, undefined, email);
    const userId = await ctx.studentId(email);
    const ids = await seedFixture(userId);
    return { ...ctx, ...connected, userId, ids, base: recordOf(userId) };
  };

  /** The record's connection for the test client, made by its first call. */
  const clientConnection = async (base: DurableObjectStub<TestBase>) => {
    const connection = await base.connectionFor(CLIENT_ID);
    if (!connection) throw new Error("the client has no connection yet");
    return connection;
  };

  it("accepts a DPoP-bound token only with a fresh proof from its own key", async () => {
    const ctx = setup();
    network(() => Response.json(metadata));
    const proof = await dpopKey();
    const { issued, access } = await connect(ctx, proof);
    expect(issued).toMatchObject({ token_type: "DPoP" });

    const once = await proof(RESOURCE, access);
    expect((await callMcp(ctx.auth, { authorization: `DPoP ${access}`, dpop: once })).status).toBe(200);
    const refused = [
      // The same proof again, as someone who copied it off the wire would send it.
      { authorization: `DPoP ${access}`, dpop: once },
      // No proof, or the token sent as a plain bearer token: the binding would mean nothing.
      { authorization: `DPoP ${access}` },
      { authorization: `Bearer ${access}` },
      // A proof from some other key.
      { authorization: `DPoP ${access}`, dpop: await (await dpopKey())(RESOURCE, access) },
      // A proof made for another URL.
      { authorization: `DPoP ${access}`, dpop: await proof(`${ORIGIN}/elsewhere`, access) },
    ];
    for (const headers of refused) {
      const res = await callMcp(ctx.auth, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/error="invalid_(token|dpop_proof)"/);
    }
  });

  it("rotates refresh tokens, and a stolen old one ends the whole grant", async () => {
    const ctx = setup();
    network(() => Response.json(metadata));
    const first = await connect(ctx);
    const refresh = (refresh_token: string) =>
      token(ctx.auth, { grant_type: "refresh_token", refresh_token });

    const second = await refresh(first.refresh);
    expect(second.status).toBe(200);
    const next = tokens(second.body);
    expect(next.refresh).not.toBe(first.refresh);
    // A client retrying a refresh whose reply it lost gets the same reply, not a dead grant.
    expect(tokens((await refresh(first.refresh)).body)).toEqual(next);

    // Past that window the old token can only be a copy, so the server ends the grant for everyone holding it.
    later(31_000);
    expect((await refresh(first.refresh)).body).toMatchObject({ error: "invalid_grant" });
    expect((await refresh(next.refresh)).body).toMatchObject({ error: "invalid_grant" });
  });

  it("stops refreshing after the client revokes its refresh token", async () => {
    const ctx = setup();
    network(() => Response.json(metadata));
    const { refresh } = await connect(ctx);
    const revoked = await ctx.auth.handler(
      new Request(`${ORIGIN}/api/auth/oauth2/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, token: refresh, token_type_hint: "refresh_token" }),
      }),
    );
    expect(revoked.status).toBe(200);
    expect(
      (await token(ctx.auth, { grant_type: "refresh_token", refresh_token: refresh })).body,
    ).toMatchObject({ error: "invalid_grant" });
  });

  it("lists a connected app and disconnects it: no refresh, no more calls, and its record connection ends", async () => {
    const ctx = setup({ onDisconnect: (userId, clientId) => recordOf(userId).disconnectApp(clientId) });
    network(() => Response.json(metadata));
    const { tab, access, refresh } = await connect(ctx);
    const base = recordOf(await ctx.studentId());
    // The person raised this client to write; Disconnect must not leave that for it to come back to.
    expect((await answer(ctx.auth, access, "describe", {})).you.level).toBe("propose");
    await base.setGrants((await clientConnection(base)).id, { level: "write", sensitive: true, holdDays: 0 });
    expect(await tab.ok("/connected-apps")).toMatchObject([
      { clientId: CLIENT_ID, name: "Example MCP client" },
    ]);

    // Better Auth's own consent delete would leave the refresh token working, so it isn't served.
    expect((await tab.call("/oauth2/delete-consent", { body: { id: "any" } })).status).toBe(404);
    expect(
      (await tab.call("/oauth2/update-consent", { body: { id: "any", update: { scopes: [] } } })).status,
    ).toBe(404);
    // Someone else's session can't disconnect this person's app.
    const other = ctx.browser();
    await other.signInWithCode("someone.else@example.edu");
    await other.ok("/connected-apps/disconnect", { body: { clientId: CLIENT_ID } });
    expect(await tab.ok("/connected-apps")).toHaveLength(1);

    await tab.ok("/connected-apps/disconnect", { body: { clientId: CLIENT_ID } });
    expect(await tab.ok("/connected-apps")).toEqual([]);
    expect(
      (await token(ctx.auth, { grant_type: "refresh_token", refresh_token: refresh })).body,
    ).toMatchObject({ error: "invalid_grant" });
    // The access token is a JWT nobody can recall, but /mcp finds its consent gone on the next request.
    expect((await initialize(ctx.auth, access)).status).toBe(401);
    expect(await base.connectionFor(CLIENT_ID)).toBeNull();

    // Connecting again asks again, and starts at the floor.
    const again = await connect(ctx);
    expect((await answer(ctx.auth, again.access, "describe", {})).you).toEqual({
      level: "propose",
      sensitive: false,
      holdDays: 3,
    });
  });

  it("lists every tool with the schema it checks calls against, and every prompt", async () => {
    const { auth, access } = await fixtureStudent();
    const { message } = await rpc(auth, access, "tools/list", {});
    const listed: { name: string; description: string; inputSchema: Record<string, unknown> }[] =
      message.result.tools;
    expect(listed.map((tool) => tool.name)).toEqual(Object.keys(TOOLS));
    for (const tool of listed) {
      const def = TOOLS[tool.name as keyof typeof TOOLS];
      const { $schema: _, ...schema } = def.input["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      expect(tool.inputSchema).toMatchObject(schema);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description).toBe(def.description);
    }
    const prompts = (await rpc(auth, access, "prompts/list", {})).message.result.prompts;
    expect(prompts).toEqual(
      Object.entries(PROMPTS).map(([name, { title, description }]) =>
        expect.objectContaining({ name, title, description }),
      ),
    );
    expect(prompts.find((p: { name: string }) => p.name === "missing_for_application").arguments).toEqual([
      expect.objectContaining({ name: "application", required: true }),
    ]);
    const got = await rpc(auth, access, "prompts/get", {
      name: "missing_for_application",
      arguments: { application: "TUM MSc Informatics" },
    });
    expect(got.message.result.messages).toEqual([
      {
        role: "user",
        content: {
          type: "text",
          text: PROMPTS.missing_for_application.text({ application: "TUM MSc Informatics" }),
        },
      },
    ]);
    expect(
      (await rpc(auth, access, "prompts/get", { name: "missing_for_application" })).message.error,
    ).toBeDefined();
  });

  it("takes arguments as declared: none undeclared, null for an optional one, never for a required one", async () => {
    const { auth, access, base, ids } = await fixtureStudent();
    const refusal = async (name: string, args: unknown) => {
      const result = await call(auth, access, name, args);
      expect(result.isError).toBe(true);
      return result.content[0]?.text ?? "";
    };
    expect(await refusal("query", { type: "Role", bogus: 1 })).toMatch(/bogus/);
    expect(await answer(auth, access, "query", { type: "Role", limit: null, cursor: null })).toEqual(
      await answer(auth, access, "query", { type: "Role" }),
    );
    expect(await refusal("undo", { run: null })).toMatch(/run/);
    // A null inside a value is data: a filter comparing with it is refused, never read as no filter.
    expect(await refusal("query", { where: { expires: { eq: null } } })).toMatch(/exists": false/);
    // And a set to null stores null.
    await base.setGrants((await clientConnection(base)).id, {
      level: "write",
      sensitive: false,
      holdDays: 0,
    });
    const [trf] = (
      await answer(auth, access, "query", { type: "Document", where: { issuer: { text: "british" } } })
    ).rows;
    const set = await answer(auth, access, "update", { id: trf.id, rev: trf.rev, set: { expires: null } });
    expect(set.status).toBe("applied");
    const { notes } = await answer(auth, access, "get", { ids: [trf.id] });
    expect(notes[0].fields).toHaveProperty("expires", null);
    expect(ids).toContain(trf.id);
  });

  it("holds each connection to its level and scope, and the approval list to the passkey", async () => {
    const { auth, access, base } = await fixtureStudent();
    const tests = { type: "TestScore", fields: ["overall"] };
    expect((await answer(auth, access, "query", tests)).rows).toEqual([]);
    const connection = await clientConnection(base);
    await base.setGrants(connection.id, { level: "read", sensitive: false, holdDays: 3 });
    expect(
      await answer(auth, access, "create", { type: "Person", fields: { title: "X", role: "referee" } }),
    ).toEqual({ status: "forbidden", message: "This connection can only read." });
    await base.setGrants(connection.id, { level: "write", sensitive: true, holdDays: 0 });
    const scores = (await answer(auth, access, "query", { ...tests, sort: ["-overall"] })).rows;
    expect(scores.map((row: { fields: { overall: number } }) => row.fields.overall)).toEqual([8, 7]);
    // The November score is verified: changing it needs the person's passkey, whatever the connection's level.
    const held = await answer(auth, access, "update", {
      id: scores[0].id,
      rev: scores[0].rev,
      set: { overall: 9 },
    });
    expect(held.status).toBe("needsApproval");
    expect((await answer(auth, access, "get", { ids: [scores[0].id] })).notes[0].fields.overall).toBe(8);
  });

  it("answers from the record the token names, never another one", async () => {
    const ada = await fixtureStudent();
    // A second student, with an empty record of their own, signed in on the same server.
    const other = await connect(ada, undefined, "someone.else@example.edu");
    expect((await answer(ada.auth, other.access, "describe", {})).counts.notes).toBe(0);
    expect((await answer(ada.auth, ada.access, "describe", {})).counts.notes).toBe(8);

    // A CLI token reaches its own record, and its secret under another record's id reaches nothing.
    const cli = await ada.base.addConnection({ kind: "cli" });
    const cliToken = await ada.base.mintToken(cli.id);
    expect((await answer(ada.auth, cliToken, "describe", {})).counts.notes).toBe(8);
    const otherId = bases.idFromName(await ada.studentId("someone.else@example.edu")).toString();
    const forged = cliToken.replace(/^brn_[0-9a-f]+_/, `brn_${otherId}_`);
    for (const bad of [forged, "brn_zz_nope", `${cliToken}x`]) {
      const refused = await rpc(ada.auth, bad, "tools/call", { name: "describe", arguments: {} });
      expect(refused.status).toBe(401);
    }
  });

  /**
   * `brainiac mcp serve` with `flags`, run by the pinned Bun with a CLI token for `base`, and a way to call it. It
   * forwards to this machine's /mcp, answering as the deployed origin would. Each test boots one: two Bun boots in
   * one test outgrew its 5 s on a loaded runner (#175).
   */
  const stdioBridge = async (
    auth: ReturnType<typeof setup>["auth"],
    base: DurableObjectStub<TestBase>,
    ...flags: string[]
  ) => {
    const cli = await base.addConnection({ kind: "cli" });
    const cliToken = await base.mintToken(cli.id);
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string") headers.set(key, value);
      const response = await serveMcp(
        auth,
        new Request(`${ORIGIN}${req.url}`, { method: "POST", headers, body: Buffer.concat(chunks) }),
        records,
        { devTokens: false },
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    // Its own config folder, so the test never touches this machine's.
    const home = mkdtempSync(join(tmpdir(), "brainiac-mcp-"));
    const child = spawn(
      createRequire(import.meta.url).resolve("bun/bin/bun.exe"),
      [
        join(import.meta.dirname, "../../../cli/src/main.ts"),
        "mcp",
        "serve",
        "--server",
        `http://127.0.0.1:${port}`,
        ...flags,
      ],
      {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, BRAINIAC_TOKEN: cliToken },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    onTestFinished(() => {
      child.kill();
      server.close();
      rmSync(home, { recursive: true, force: true });
    });
    const waiting = new Map<number, (message: { result?: unknown }) => void>();
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    });
    let next = 0;
    const send = (method: string, params: unknown) =>
      new Promise<{ result?: unknown }>((resolve) => {
        const id = ++next;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    return { cli, send };
  };
  const hello = {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  };

  it("answers over stdio exactly as over remote MCP, at the floor and with the sensitive scope", async () => {
    const { auth, access, base } = await fixtureStudent();
    const { cli, send: stdio } = await stdioBridge(auth, base);
    const remote = async (method: string, params: unknown) =>
      (await rpc(auth, access, method, params)).message;
    /**
     * Sends every request both ways at once and expects the same answers. The bridge still answers its lines one
     * at a time, in order, but nothing waits between them, and the remote answers come while Bun boots.
     */
    const same = async (requests: readonly (readonly [method: string, params: unknown])[]) => {
      const answers = await Promise.all(
        requests.map(([method, params]) => Promise.all([stdio(method, params), remote(method, params)])),
      );
      for (const [i, [over, direct]] of answers.entries())
        expect(over.result, JSON.stringify(requests[i])).toEqual(direct.result);
    };
    const calls = [
      ["describe", {}],
      ["query", { sort: ["title"], fields: ["title", "kind"] }],
      ["query", { type: "TestScore", fields: ["overall"] }],
      ["get", { paths: ["facts/tests/ielts-2026-11.md", "facts/roles/acme-intern-2025.md"], history: true }],
      ["query", { type: "Role", bogus: true }],
      ["search", { text: "IELTS" }],
      // The test report form, which proves the November score.
      ["related", { id: "01M6AV2ZR0XCK1MFKF8AQ91WD2", depth: 2 }],
      ["ask", { mode: "context", question: "What was my IELTS writing score?" }],
      [
        "ask",
        {
          mode: "verify",
          text: "Overall 8.0, until 2028-11-02.",
          claims: [{ note: "facts/tests/ielts-2026-11.md", field: "overall", value: 8 }],
        },
      ],
    ].map(([name, args]) => ["tools/call", { name, arguments: args }] as const);
    await same([["initialize", hello], ["tools/list", {}], ["prompts/list", {}], ...calls]);
    // Granted the sensitive scope, both see the test scores, still alike.
    for (const id of [cli.id, (await clientConnection(base)).id])
      await base.setGrants(id, { level: "propose", sensitive: true, holdDays: 3 });
    const scores = await stdio("tools/call", { name: "query", arguments: { type: "TestScore" } });
    expect(JSON.stringify(scores.result)).toContain("IELTS Academic, November 2026");
    await same(calls);
  });

  it("answers a --background bridge (the daemon's filer) with normal notes only, and only proposals", async () => {
    const { auth, base } = await fixtureStudent();
    const { cli, send: background } = await stdioBridge(auth, base, "--background");
    // Even with the sensitive scope granted, nobody is there to see them.
    await base.setGrants(cli.id, { level: "write", sensitive: true, holdDays: 3 });
    const [, hidden, described] = await Promise.all([
      background("initialize", hello),
      background("tools/call", { name: "query", arguments: { type: "TestScore" } }),
      background("tools/call", { name: "describe", arguments: {} }),
    ]);
    expect(JSON.stringify(hidden.result)).not.toContain("IELTS");
    expect(described.result).toMatchObject({ content: [{ type: "text" }] });
    const [text] = (described.result as { content: { text: string }[] }).content;
    expect(JSON.parse(text?.text ?? "{}").you).toEqual({ level: "propose", sensitive: false, holdDays: 3 });
  });

  it("never lets an outside service's error text reach the agent", async () => {
    const { auth, access, neon } = await fixtureStudent();
    const leaky: Records = {
      ...records,
      of: async (userId) => ({
        tool: () => Promise.reject(new Error("pg: password authentication failed for user brainiac_owner")),
        authenticate: (bearer) => recordOf(userId).authenticate(bearer),
      }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await call(auth, access, "describe", {}, leaky);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/pg:|password|brainiac_owner/);
    // Neon failing at the consent check is an outage to retry, not a bad token, and says nothing about Neon.
    neon.down = true;
    const down = await rpc(auth, access, "tools/call", { name: "describe", arguments: {} });
    expect(down.status).toBe(503);
    expect(down.text).not.toMatch(/Neon/);
  });

  it("issues no grant without the MCP resource, since an opaque token can't be checked against Disconnect", async () => {
    const { auth, browser } = setup();
    network(() => Response.json(metadata));
    const { code, verifier } = await grant(auth, browser, "");
    const issued = await token(auth, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: "",
    });
    expect(issued).toMatchObject({ status: 400, body: { error: "invalid_target" } });
  });

  it("lists every connected app, newest first, past the adapter's 100-row default", async () => {
    const ctx = setup();
    network(() => Response.json(metadata));
    const { tab } = await connect(ctx);
    const { adapter } = await ctx.auth.$context;
    const userId = await ctx.studentId();
    for (let i = 0; i < 100; i++) {
      await adapter.create({
        model: "oauthConsent",
        data: {
          clientId: `https://app-${i}.example/client.json`,
          userId,
          scopes: ["openid"],
          // Connected before the real client, a minute apart.
          createdAt: new Date(Date.now() - (i + 1) * 60_000),
          updatedAt: new Date(),
        },
      });
    }
    const listed = await tab.ok("/connected-apps");
    expect(
      Array.isArray(listed) && new Set(listed.map((app: { clientId: string }) => app.clientId)).size,
    ).toBe(101);
    expect(Array.isArray(listed) && listed[0]).toMatchObject({
      clientId: CLIENT_ID,
      name: "Example MCP client",
    });
    expect(Array.isArray(listed) && listed.at(-1)).toMatchObject({
      clientId: "https://app-99.example/client.json",
    });
  });

  it("refuses tokens for a grant whose consent is gone, as when a refresh races a disconnect", async () => {
    const ctx = setup();
    network(() => Response.json(metadata));
    const { refresh } = await connect(ctx);
    const { adapter } = await ctx.auth.$context;
    // The refresh read its token before the disconnect deleted it, so only the consent is missing.
    await adapter.deleteMany({ model: "oauthConsent", where: [{ field: "clientId", value: CLIENT_ID }] });
    expect(
      (await token(ctx.auth, { grant_type: "refresh_token", refresh_token: refresh })).body,
    ).toMatchObject({ error: "invalid_grant" });
    expect(await adapter.count({ model: "oauthRefreshToken" })).toBe(0);
  });

  it.each([plainRedirect, opaqueRedirect])(
    "refuses a metadata document that redirects (%#)",
    async (document) => {
      const { auth } = setup();
      const fetch = network(document);
      const start = await authorize(auth, (await pkce()).codeChallenge);
      expect(start.status).toBe(400);
      // Refused by our transport, not just for being something other than a 200.
      expect(JSON.parse(start.body)).toMatchObject({
        error: "invalid_client",
        error_description: expect.stringContaining("redirect blocked"),
      });
      expect(fetch.mock.calls.map(([input, init]) => [String(input), init?.redirect])).toEqual([
        [CLIENT_ID, "manual"],
      ]);
    },
  );
});
