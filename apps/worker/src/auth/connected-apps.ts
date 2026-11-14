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
 * Who and what a fresh token response is for: the access token we just signed names both. An opaque token (one
 * issued without an audience) is never accepted by /mcp, so there's nothing to check.
 */
const issuedTo = (returned: unknown) => {
  if (typeof returned !== "object" || returned === null || !("access_token" in returned)) return;
  if (typeof returned.access_token !== "string" || returned.access_token.split(".").length !== 3) return;
  const { sub, azp } = decodeJwt(returned.access_token);
  return typeof sub === "string" && typeof azp === "string" ? { userId: sub, clientId: azp } : undefined;
};

export const connectedApps = () =>
  ({
    id: "connected-apps",
    endpoints: {
      listConnectedApps: createAuthEndpoint(
        "/connected-apps",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx): Promise<ConnectedApp[]> => {
          const consents = await ctx.context.adapter.findMany<Consent>({
            model: "oauthConsent",
            where: [{ field: "userId", value: ctx.context.session.user.id }],
          });
          if (consents.length === 0) return [];
          const clients = await ctx.context.adapter.findMany<Client>({
            model: "oauthClient",
            where: [{ field: "clientId", operator: "in", value: consents.map((c) => c.clientId) }],
          });
          const names = new Map(clients.map((c) => [c.clientId, c.name ?? undefined]));
          return consents.map((c) => ({
            clientId: c.clientId,
            name: names.get(c.clientId),
            connectedAt: c.createdAt,
          }));
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
