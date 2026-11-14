// The way out of an MCP client's consent: the account page lists the apps a person let in, and Disconnect ends
// the grant. Better Auth's own `/oauth2/delete-consent` removes the consent but leaves the client's refresh
// tokens working, so it's switched off (config.ts) in favour of this.
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { decodeJwt } from "jose";

type Consent = { clientId: string; createdAt: Date };
type Client = { clientId: string; name?: string | null };

export interface ConnectedApp {
  clientId: string;
  /** The client's own name for itself, from its metadata document. */
  name: string | undefined;
  connectedAt: Date;
}

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** Ends one client's grant: the consent first, then every token, so a refresh racing this finds no consent. */
const disconnect = async (ctx: Ctx, userId: string, clientId: string) => {
  const where = [
    { field: "userId", value: userId },
    { field: "clientId", value: clientId },
  ];
  await ctx.context.adapter.deleteMany({ model: "oauthConsent", where });
  await ctx.context.adapter.deleteMany({ model: "oauthRefreshToken", where });
  await ctx.context.adapter.deleteMany({ model: "oauthAccessToken", where });
};

/**
 * Who and what a fresh token response is for: the access token we just signed names both. `"opaque"` when it isn't
 * a JWT: a client that named no resource gets one, and it can't be traced back to a consent.
 */
const issuedTo = (returned: unknown) => {
  if (typeof returned !== "object" || returned === null || !("access_token" in returned)) return;
  const token = returned.access_token;
  if (typeof token !== "string" || token.split(".").length !== 3) return "opaque";
  const { sub, azp } = decodeJwt(token);
  return typeof sub === "string" && typeof azp === "string" ? { userId: sub, clientId: azp } : "opaque";
};

const PAGE = 100;

/** Every matching row: the adapter returns 100 at most unless asked for more, and pages need a fixed order. */
async function findAll<T>(
  ctx: Ctx,
  model: string,
  where: Parameters<Ctx["context"]["adapter"]["findMany"]>[0]["where"],
) {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await ctx.context.adapter.findMany<T>({
      model,
      where,
      limit: PAGE,
      offset,
      sortBy: { field: "id", direction: "asc" },
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

export const connectedApps = () =>
  ({
    id: "connected-apps",
    endpoints: {
      listConnectedApps: createAuthEndpoint(
        "/connected-apps",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx): Promise<ConnectedApp[]> => {
          const consents = await findAll<Consent>(ctx, "oauthConsent", [
            { field: "userId", value: ctx.context.session.user.id },
          ]);
          if (consents.length === 0) return [];
          const clients = await findAll<Client>(ctx, "oauthClient", [
            { field: "clientId", operator: "in", value: consents.map((c) => c.clientId) },
          ]);
          const names = new Map(clients.map((c) => [c.clientId, c.name ?? undefined]));
          // Newest first; pages come in id order, which is random.
          return consents
            .map((c) => ({
              clientId: c.clientId,
              name: names.get(c.clientId),
              connectedAt: new Date(c.createdAt),
            }))
            .toSorted((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
        },
      ),
      disconnectApp: createAuthEndpoint("/connected-apps/disconnect", { method: "POST" }, async (ctx) => {
        const clientId: unknown = ctx.body?.clientId;
        if (typeof clientId !== "string" || !clientId)
          throw new APIError("BAD_REQUEST", { message: "clientId is required" });
        // Straight from Neon, so a session revoked in the last 5 minutes can't act on the cookie cache.
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (!session) throw new APIError("UNAUTHORIZED");
        await disconnect(ctx, session.user.id, clientId);
        return ctx.json({ status: true });
      }),
    },
    hooks: {
      after: [
        {
          // Every grant the token endpoint hands out (a code exchange or a refresh) must still have its consent
          // once the tokens exist. A refresh that read its token just before a disconnect deleted it would
          // otherwise write a new refresh token nobody consented to.
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const grant = issuedTo(ctx.context.returned);
            if (!grant) return;
            // /mcp takes only its own JWTs, and an opaque grant couldn't be checked against Disconnect.
            if (grant === "opaque") {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_target",
                error_description: "Brainiac issues tokens only for its MCP endpoint: send its resource",
              });
            }
            const consent = await ctx.context.adapter.findOne<Consent>({
              model: "oauthConsent",
              where: [
                { field: "userId", value: grant.userId },
                { field: "clientId", value: grant.clientId },
              ],
            });
            if (consent) return;
            await disconnect(ctx, grant.userId, grant.clientId);
            throw new APIError("BAD_REQUEST", {
              error: "invalid_grant",
              error_description: "this app was disconnected",
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
