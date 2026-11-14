// The remote MCP endpoint (`/mcp`), behind the OAuth server in auth/config.ts. Tools arrive with #17; until
// then it answers the handshake and serves nothing, which is enough for a client to show it signed in.
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { APIError, isAPIError } from "better-auth/api";
import {
  createDpopReplayStore,
  enforceDpopBinding,
  isDpopBindingError,
  parseAccessTokenAuthorization,
  verifyJwsAccessToken,
} from "better-auth/oauth2";
import { decodeProtectedHeader } from "jose";

import { type createAuth, mcpResource } from "../auth/config.ts";

// Stateless: every request builds its server from this factory, so no session store is needed. Both protocol
// eras are served, because clients move to 2026-07-28 at their own pace.
const handler = createMcpHandler(() => new McpServer({ name: "brainiac", version: "0.0.0" }));

// Signing keys, cached per isolate for 5 minutes (every origin of a stage shares one key table). A token naming
// a key we don't have refetches, at most every 30 seconds.
const jwksCache = {};

// jose failures that mean we couldn't load keys, not that the token is bad.
const KEY_LOADING_ERRORS = new Set([
  "ERR_JWKS_TIMEOUT",
  "ERR_JWKS_INVALID",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

/** A jose error about the token itself (bad format, signature, claims or expiry). */
const isTokenError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  /^ERR_J(WT|WS|WK|OSE)/.test(error.code) &&
  !KEY_LOADING_ERRORS.has(error.code);

const unauthorized = (message: string, error?: "invalid_token" | "invalid_dpop_proof") =>
  new APIError("UNAUTHORIZED", { message, ...(error && { error, error_description: message }) });

/**
 * Checks the access token in-process. `requireMcpAuth` from `@better-auth/mcp` fetches our own `/jwks` over
 * HTTP, which costs a network hop per cold isolate and timed out behind a public hostname in testing.
 */
async function verify(auth: ReturnType<typeof createAuth>, request: Request, resource: string) {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  if (!authorization?.token) throw unauthorized("missing authorization header");
  if (authorization.scheme === "Unknown")
    throw unauthorized("authorization scheme must be Bearer or DPoP", "invalid_token");
  const { token } = authorization;
  // A header that isn't JSON makes jose throw a bare TypeError, which would read as an outage below.
  try {
    decodeProtectedHeader(token);
  } catch {
    throw unauthorized("invalid access token", "invalid_token");
  }
  let claims;
  try {
    claims = await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: jwksCache,
      verifyOptions: {
        issuer: `${new URL(resource).origin}/api/auth`,
        audience: resource,
        requiredClaims: ["azp", "exp", "sub"],
      },
    });
  } catch (error) {
    // Anything else (Neon down, keys unreadable) isn't the token's fault; saying it was would make the client
    // refresh, and maybe send the person through sign-in, over a blip.
    throw isTokenError(error) ? unauthorized("invalid access token", "invalid_token") : error;
  }
  // A DPoP-bound token (`cnf.jkt`) is good only with a fresh proof from its key, each proof used once. Proofs
  // are remembered in Neon's verification table, so a replay is caught on any isolate; a bearer token skips it.
  try {
    await enforceDpopBinding({
      payload: claims,
      authorization,
      proofJwt: request.headers.get("dpop"),
      method: request.method,
      url: request.url,
      replayStore: createDpopReplayStore((await auth.$context).internalAdapter),
    });
  } catch (error) {
    throw isDpopBindingError(error) ? unauthorized(error.message, error.code) : error;
  }
  return claims;
}

/** A request without a valid token for this origin's `/mcp` gets the 401 that starts a client's sign-in. */
export async function serveMcp(auth: ReturnType<typeof createAuth>, request: Request): Promise<Response> {
  const resource = mcpResource(new URL(request.url).origin);
  try {
    await verify(auth, request, resource);
  } catch (error) {
    const challenge = isAPIError(error)
      ? createResourceServerChallenge(error, resource, { request })
      : undefined;
    if (challenge) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: challenge.message }, id: null },
        { status: challenge.statusCode, headers: challenge.headers },
      );
    }
    console.error("mcp token check failed", error);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Brainiac can't check tokens right now. Try again." },
        id: null,
      },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  return handler.fetch(request);
}
