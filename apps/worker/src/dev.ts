// Dev sign-in, Brainiac's version of T3 Code's reusable dev credential. A stage that has DEV_SIGN_IN_TOKEN
// (Doppler `dev` only) signs whoever holds it in as the fictional fixture student, with no email code or passkey:
//   /dev/sign-in[?as=<tag>][&next=/path]#token=<t>   a link to open once per browser. The token rides in the
//     fragment, which browsers never send, so request logs never see it: the page reads it, drops it from the
//     address bar, POSTs it back in a header, and the answer sets the session cookie. The browser's own history list
//     may still keep the link as opened, so treat it like a password.
//   POST /dev/token[?as=<tag>], `authorization: Bearer <t>`   an access token for /mcp, for agents and scripts
//   POST /dev/seed[?as=<tag>], the same header, `{ notes }`   fills an empty record with the fixture's notes, made
//     by the person through the record's own mutation path, so an agent testing the site isn't looking at nothing
// `as` signs in a separate fixture account (nadia.karim+<tag>@example.edu), so an e2e run starts from a new one.
// `vp run dev:sign-in` and `vp run dev:token` build these for a stage. Never on prod: alchemy.run.ts doesn't bind the
// token there, index.ts refuses /dev/ when STAGE is prod, and the deploy doctor fails if prod's Worker has it bound.
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";

import { type AuthConfig, authOptions, mcpResource } from "./auth/config.ts";
import { DEV_CLIENT } from "./mcp/handler.ts";
import { landing } from "./auth/pages.ts";
import type { NoteClass } from "@brainiac/base";

/** The fictional fixture student that tests, evals and screenshots use (fixtures/README.md). Never a real person. */
export const FIXTURE_STUDENT = { email: "nadia.karim@example.edu", name: "Nadia Karim" };

/** One note for /dev/seed, as it is on disk under fixtures/nadia (scripts/dev-auth.ts reads them). */
export interface SeedNote {
  readonly path: string;
  readonly raw: string;
  readonly class: NoteClass;
}

/** What seeding needs of a person's record: the Base DO's own method, over RPC. */
export interface SeedRecord {
  seedIfEmpty(
    mutations: readonly ({ readonly op: "create" } & SeedNote)[],
    caller: { readonly actor: string },
  ): Promise<{ readonly status: string; readonly notes?: unknown }>;
}

/** The person, as the site speaks for them (site.ts). */
const PERSON = { actor: "human" } as const;

/** More than the fixture will ever hold; a body past it is a mistake, not a seed. */
const MAX_SEED_NOTES = 200;

/** The body of a /dev/seed request, or undefined when it isn't one. */
function seedNotes(body: unknown): SeedNote[] | undefined {
  if (!body || typeof body !== "object" || !("notes" in body) || !Array.isArray(body.notes)) return undefined;
  if (body.notes.length > MAX_SEED_NOTES) return undefined;
  const notes: SeedNote[] = [];
  for (const note of body.notes) {
    if (!note || typeof note !== "object") return undefined;
    const { path, raw, class: cls } = note;
    if (typeof path !== "string" || typeof raw !== "string") return undefined;
    if (cls !== "normal" && cls !== "sensitive") return undefined;
    notes.push({ path, raw, class: cls });
  }
  return notes;
}

/** What /dev/seed answers: the notes it made, or, when the record already held some, how many (it makes none). */
export interface Seeded {
  readonly seeded: number;
  readonly existing: number;
}

/**
 * Creates `notes` in `record` as the person, all or none, unless the record already holds notes: seeding is for a
 * new account, never one someone has been using. A seed the record refuses (a note that doesn't parse, or one that
 * would take the person's passkey) answers 422 with the record's reason, and nothing is made.
 */
async function seed(record: SeedRecord, notes: readonly SeedNote[]): Promise<Response> {
  const result = await record.seedIfEmpty(
    notes.map((note) => ({ op: "create", ...note })),
    PERSON,
  );
  if (result.status === "applied")
    return Response.json({ seeded: notes.length, existing: 0 } satisfies Seeded);
  if (result.status === "notEmpty" && typeof result.notes === "number")
    return Response.json({ seeded: 0, existing: result.notes } satisfies Seeded);
  return Response.json({ error: "the record refused the seed", result }, { status: 422 });
}

/** How long a dev access token for /mcp lasts. */
const TOKEN_SECONDS = 60 * 60;

const notFound = () => new Response("Not found", { status: 404 });

// A separate instance, so the production config never carries Better Auth's test helpers.
const devAuth = (config: AuthConfig) => {
  const options = authOptions(config);
  return betterAuth({ ...options, plugins: [...options.plugins, testUtils()] });
};

const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** Compares hashes byte by byte, so the time taken doesn't say how much of a guess was right. */
async function matches(given: string, expected: string) {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.reduce((diff, byte, i) => diff | (byte ^ (b[i] ?? 0)), 0) === 0;
}

/** The fixture student's address, or a tagged one (letters, digits and dashes) for a fresh account. */
const fixtureEmail = (tag: string | null) => {
  if (!tag) return FIXTURE_STUDENT.email;
  if (!/^[a-z0-9-]{1,40}$/i.test(tag)) return undefined;
  const [local, domain] = FIXTURE_STUDENT.email.split("@");
  return `${local}+${tag}@${domain}`;
};

// Moves the fragment's token into a header, drops it from the address bar, then follows the answer.
const SIGN_IN_PAGE = `<!doctype html><meta charset="utf-8"><title>Dev sign-in · Brainiac</title><p id="status">Signing in…</p>
<script>
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
history.replaceState(null, "", location.pathname + location.search);
fetch(location.href, { method: "POST", headers: { authorization: "Bearer " + token } })
  .then((res) => (res.ok ? res.json() : Promise.reject(new Error("dev sign-in answered " + res.status))))
  .then((body) => location.replace(body.location))
  .catch((error) => { document.getElementById("status").textContent = error.message; });
</script>`;

/**
 * Serves /dev/*. The caller has already checked this stage has a token and isn't prod. `recordOf` is the person's
 * record from the base registry, made on first use (index.ts).
 */
export async function serveDev(
  request: Request,
  config: AuthConfig,
  token: string,
  recordOf: (userId: string) => Promise<SeedRecord | undefined>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/dev/sign-in" && request.method === "GET") {
    return new Response(SIGN_IN_PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "frame-ancestors 'none'",
      },
    });
  }
  const signIn = url.pathname === "/dev/sign-in" && request.method === "POST";
  const mint = url.pathname === "/dev/token" && request.method === "POST";
  const seeding = url.pathname === "/dev/seed" && request.method === "POST";
  const given = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const email = fixtureEmail(url.searchParams.get("as"));
  // A wrong token looks the same as no dev sign-in at all.
  if (!(signIn || mint || seeding) || !given || !email || !(await matches(given, token))) return notFound();
  const notes = seeding ? seedNotes(await request.json().catch(() => undefined)) : undefined;
  if (seeding && !notes)
    return Response.json({ error: "expected { notes: [{ path, raw, class }] }" }, { status: 400 });

  const auth = devAuth(config);
  const context = await auth.$context;
  const find = async () => (await context.internalAdapter.findUserByEmail(email))?.user;
  const user =
    (await find()) ??
    (await context.test
      .saveUser(context.test.createUser({ email, name: FIXTURE_STUDENT.name, emailVerified: true }))
      // Two first requests for one account (a seed and a sign-in at once) both find none and both insert; the
      // loser's insert fails on the unique email, and it takes the winner's account.
      .catch(async (error: unknown) => {
        const winner = await find();
        if (!winner) throw error;
        return winner;
      }));

  if (notes) {
    const record = await recordOf(user.id);
    if (!record) return Response.json({ error: "this account's record was deleted" }, { status: 410 });
    return seed(record, notes);
  }

  if (mint) {
    const resource = mcpResource(url.origin);
    // The claims /mcp checks (mcp/handler.ts), signed with this stage's own keys. No OAuth client or consent stands
    // behind `brainiac-dev`, so /mcp lets it through without one, only where this route exists.
    const { token: accessToken } = await auth.api.signJWT({
      body: {
        payload: {
          sub: user.id,
          azp: DEV_CLIENT,
          iss: `${url.origin}/api/auth`,
          aud: resource,
          exp: Math.floor(Date.now() / 1000) + TOKEN_SECONDS,
        },
      },
    });
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: TOKEN_SECONDS,
      resource,
    });
  }

  const [cookie] = (await context.test.login({ userId: user.id })).cookies;
  if (!cookie) throw new Error("Better Auth made no session cookie");
  const attributes = [
    "Path=/",
    "HttpOnly",
    `SameSite=${cookie.sameSite}`,
    ...(cookie.secure ? ["Secure"] : []),
    // Lasts as long as the session, like a real sign-in's cookie.
    ...(cookie.expires ? [`Max-Age=${cookie.expires - Math.floor(Date.now() / 1000)}`] : []),
  ];
  const headers = new Headers({ "set-cookie": [`${cookie.name}=${cookie.value}`, ...attributes].join("; ") });
  return Response.json({ location: landing(url.searchParams.get("next"), url.origin) }, { headers });
}
