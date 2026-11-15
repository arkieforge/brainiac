// How a tab or a laptop reaches its own record, and only its own: `/sync` (one WebSocket per client),
// `/cli/login` (the site hands `brainiac login` a token) and `/cli/logout`. A record comes from the session, through
// the registry, or from the id inside a CLI token, which the record itself then checks; never from the URL.
import { tokenBase } from "@brainiac/base";

import { cliLoginDone, cliLoginInvalid, cliLoginPage } from "./auth/pages.ts";
import { ACTOR_HEADER } from "./base.ts";
import type { Env } from "./env.ts";

/** The signed-in person and their record's id (session, then registry); `undefined` when nobody is signed in. */
export type SignedIn = () => Promise<{ readonly email: string; readonly baseId: string } | undefined>;

/** The actor a socket opened with the person's session speaks as. */
const PERSON_ACTOR = "human";

const refused = (status: number, text: string) => new Response(text, { status });

/** The record a base id names; `undefined` for one that isn't a Durable Object id of this namespace. */
function recordOf(env: Pick<Env, "BASE">, baseId: string | undefined) {
  if (baseId === undefined) return undefined;
  try {
    return env.BASE.get(env.BASE.idFromString(baseId));
  } catch {
    return undefined;
  }
}

const bearer = (request: Request) => /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];

/**
 * A browser sends the session cookie with any request to this site, including one a page on another origin of
 * the same site makes (`usercontent.`): only this origin's own pages may act as the person.
 */
const sameOrigin = (request: Request) => request.headers.get("origin") === new URL(request.url).origin;

/**
 * `/sync`: a CLI token goes to the record its id names, which decides whether it is good; anything else needs the
 * person's session. The socket then speaks for that connection or for the person.
 */
export async function openSync(
  request: Request,
  env: Pick<Env, "BASE">,
  signedIn: SignedIn,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return refused(426, "Expected a WebSocket");
  const token = bearer(request);
  let record;
  let actor;
  if (token !== undefined) {
    record = recordOf(env, tokenBase(token));
    const connection = await record?.authenticate(token);
    if (!connection) return refused(401, "Unauthorized");
    actor = `connection:${connection.id}`;
  } else {
    const person = await signedIn();
    if (person && !sameOrigin(request)) return refused(403, "Forbidden");
    record = recordOf(env, person?.baseId);
    actor = PERSON_ACTOR;
  }
  if (!record) return refused(401, "Unauthorized");
  // The record trusts the actor header, so it only ever comes from here; neither credential goes further.
  const headers = new Headers(request.headers);
  for (const name of [ACTOR_HEADER, "authorization", "cookie"]) headers.delete(name);
  headers.set(ACTOR_HEADER, actor);
  return record.fetch(request.url, { headers });
}

/** The loopback port `brainiac login` listens on: a user port, never a privileged one. */
const portOf = (text: string | null) => {
  const port = Number(text);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
};

/**
 * `/cli/login?port=<p>&state=<s>&device=<name>`: shows the signed-in person what is asking, and on their confirm
 * (a same-origin POST) makes a CLI connection on their record and hands its token to 127.0.0.1:<p>.
 */
export async function cliLogin(
  request: Request,
  env: Pick<Env, "BASE">,
  signedIn: SignedIn,
): Promise<Response> {
  const url = new URL(request.url);
  const post = request.method === "POST";
  if (!post && request.method !== "GET") return refused(405, "Method not allowed");
  if (post && !sameOrigin(request)) return refused(403, "Forbidden");
  const params = post ? new URLSearchParams(await request.text()) : url.searchParams;
  const port = portOf(params.get("port"));
  const state = params.get("state");
  const device =
    (params.get("device") ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").slice(0, 64) || "this computer";
  if (port === undefined || !state || !/^[\w-]{16,128}$/.test(state)) return cliLoginInvalid();
  const person = await signedIn();
  if (!person) {
    if (post) return refused(401, "Sign in first.");
    const signIn = new URL("/sign-in", url);
    signIn.searchParams.set("next", url.pathname + url.search);
    return Response.redirect(signIn.toString(), 303);
  }
  if (!post) return cliLoginPage({ email: person.email, device, port, state });
  const record = recordOf(env, person.baseId);
  if (!record) throw new Error(`The registry names a record that isn't one: ${person.baseId}`);
  return cliLoginDone({ port, state, token: await record.login() });
}

/** `/cli/logout`: a CLI token ends its own connection, so its open sockets close and the token works nowhere. */
export async function cliLogout(request: Request, env: Pick<Env, "BASE">): Promise<Response> {
  if (request.method !== "POST") return refused(405, "Method not allowed");
  const token = bearer(request);
  const record = token === undefined ? undefined : recordOf(env, tokenBase(token));
  if (!token || !(await record?.logout(token))) return refused(401, "Unauthorized");
  return new Response(null, { status: 204 });
}
