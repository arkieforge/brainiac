// Dev sign-in, Brainiac's version of T3 Code's reusable dev credential. A stage that has DEV_SIGN_IN_TOKEN
// (Doppler `dev` only) signs whoever holds it in as the fictional fixture student, with no email code or passkey:
//   GET  /dev/sign-in?token=<t>[&as=<tag>][&next=/path]   sets the session cookie; open it once per browser
//   POST /dev/token, `authorization: Bearer <t>`, [?as=<tag>]   an access token for /mcp, for agents and scripts
// `as` signs in a separate fixture account (ada.okafor+<tag>@example.edu), so an e2e run starts from a new one.
// `vp run dev:sign-in` and `vp run dev:token` build these for a stage. Never on prod: alchemy.run.ts doesn't bind the
// token there, index.ts refuses /dev/ when STAGE is prod, and the deploy doctor fails if prod answers it.
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";

import { type AuthConfig, authOptions, mcpResource } from "./auth/config.ts";

/** The fictional fixture student that tests, evals and screenshots use. Never a real person. */
export const FIXTURE_STUDENT = { email: "ada.okafor@example.edu", name: "Ada Okafor" };

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

/** A relative path on this origin, so the link can't send anyone elsewhere. */
const samePath = (next: string | null) =>
  next?.startsWith("/") && !next.startsWith("//") ? next : "/account";

/** Serves /dev/*. The caller has already checked this stage has a token and isn't prod. */
export async function serveDev(request: Request, config: AuthConfig, token: string): Promise<Response> {
  const url = new URL(request.url);
  const signIn = url.pathname === "/dev/sign-in" && request.method === "GET";
  const mint = url.pathname === "/dev/token" && request.method === "POST";
  const given = signIn
    ? url.searchParams.get("token")
    : /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const email = fixtureEmail(url.searchParams.get("as"));
  // A wrong token looks the same as no dev sign-in at all.
  if (!(signIn || mint) || !given || !email || !(await matches(given, token))) return notFound();

  const auth = devAuth(config);
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(email);
  const user =
    found?.user ??
    (await context.test.saveUser(
      context.test.createUser({ email, name: FIXTURE_STUDENT.name, emailVerified: true }),
    ));

  if (mint) {
    const resource = mcpResource(url.origin);
    // The claims /mcp checks (mcp/handler.ts), signed with this stage's own keys.
    const { token: accessToken } = await auth.api.signJWT({
      body: {
        payload: {
          sub: user.id,
          azp: "brainiac-dev",
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
  ];
  return new Response(null, {
    status: 303,
    headers: {
      location: samePath(url.searchParams.get("next")),
      "set-cookie": [`${cookie.name}=${cookie.value}`, ...attributes].join("; "),
      "cache-control": "no-store",
      // The link carries the token; don't hand it to whatever the next page loads.
      "referrer-policy": "no-referrer",
    },
  });
}
