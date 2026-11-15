// The remote MCP endpoint (`/mcp`), behind the OAuth server in auth/config.ts. It serves the tools in
// packages/base/src/tools.ts, each call answered by the caller's own record as the caller's connection. It takes an
// MCP client's OAuth access token, or a CLI token (`brainiac mcp serve` forwards here with one).
import { BACKGROUND_HEADER, tokenBase, type Answer, type Connection } from "@brainiac/base";
import { serveTools } from "@brainiac/base/mcp";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
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

/**
 * Which connection a call comes through: an MCP client's, by its OAuth client id, or a CLI connection's. A client
 * with nobody there says so (`BACKGROUND_HEADER`), which narrows the connection for the call.
 */
export type Via = ({ readonly oauthClientId: string } | { readonly connectionId: string }) & {
  readonly background?: boolean;
};

/** The part of a Base DO's stub /mcp uses. */
export interface RecordStub {
  tool(via: Via, name: string, args: unknown): Promise<Answer>;
  authenticate(token: string): Promise<Connection | null>;
}

/** How /mcp finds a record. The base comes from the token: its user's registry row, or the id inside a CLI token. */
export interface Records {
  /** The person's record, from the base registry; undefined once it was deleted. */
  of(userId: string): Promise<RecordStub | undefined>;
  /** The record a CLI token names, if that is a record id at all. */
  byId(baseId: string): RecordStub | undefined;
}

export interface McpOptions {
  /** Takes dev.ts's `brainiac-dev` tokens, which have no consent behind them. Never on prod. */
  readonly devTokens: boolean;
}

/** The OAuth client id dev.ts signs its tokens for. */
export const DEV_CLIENT = "brainiac-dev";

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

/**
 * The record and connection a request speaks for. A CLI token names its record and the record checks it; an
 * access token names its user, and must still have the consent it was issued under, since a disconnected app's
 * token stays valid for up to an hour.
 */
async function caller(
  auth: ReturnType<typeof createAuth>,
  request: Request,
  resource: string,
  records: Records,
  options: McpOptions,
): Promise<{ readonly record: RecordStub; readonly via: Via }> {
  const authorization = parseAccessTokenAuthorization(request.headers.get("authorization"));
  const token = authorization?.token;
  if (token?.startsWith("brn_") && authorization?.scheme === "Bearer") {
    const baseId = tokenBase(token);
    const record = baseId === undefined ? undefined : records.byId(baseId);
    const connection = record && (await record.authenticate(token));
    if (!record || !connection) throw unauthorized("invalid access token", "invalid_token");
    return { record, via: { connectionId: connection.id } };
  }
  const claims = await verify(auth, request, resource);
  const userId = String(claims.sub);
  const clientId = String(claims.azp);
  if (!(options.devTokens && clientId === DEV_CLIENT)) {
    const consent = await (
      await auth.$context
    ).adapter.findOne({
      model: "oauthConsent",
      where: [
        { field: "userId", value: userId },
        { field: "clientId", value: clientId },
      ],
    });
    if (!consent) throw unauthorized("this app was disconnected", "invalid_token");
  }
  const record = await records.of(userId);
  if (!record) throw unauthorized("this record was deleted", "invalid_token");
  return { record, via: { oauthClientId: clientId } };
}

/** A request without a valid token for this origin's `/mcp` gets the 401 that starts a client's sign-in. */
export async function serveMcp(
  auth: ReturnType<typeof createAuth>,
  request: Request,
  records: Records,
  options: McpOptions,
): Promise<Response> {
  const resource = mcpResource(new URL(request.url).origin);
  let from;
  try {
    from = await caller(auth, request, resource, records, options);
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
  const { record } = from;
  const via: Via = {
    ...from.via,
    ...(request.headers.get(BACKGROUND_HEADER) === "1" && { background: true }),
  };
  return serveTools(request, (name, args) => record.tool(via, name, args));
}
