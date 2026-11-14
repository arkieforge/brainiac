// `/consent`: where the OAuth server sends a signed-in person to let an MCP client in (pages.ts renders it).
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

import type { createAuth } from "./config.ts";
import { consentExpired, consentPage } from "./pages.ts";

export async function consent(request: Request, auth: ReturnType<typeof createAuth>): Promise<Response> {
  const url = new URL(request.url);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(new URL(`/sign-in${url.search}`, url).toString(), 303);
  // The client named on the page must be the one the authorize endpoint signed for, not a parameter someone added.
  const { secret } = await auth.$context;
  const clientId = url.searchParams.get("client_id");
  if (!clientId || !(await verifyOAuthQueryParams(url.search.slice(1), secret))) return consentExpired();
  // A client disabled or removed since the link was signed has nothing left to consent to.
  const client = await auth.api
    .getOAuthClientPublic({ query: { client_id: clientId }, headers: request.headers })
    .catch(() => undefined);
  if (!client) return consentExpired();
  return consentPage({
    email: session.user.email,
    clientName: client.client_name,
    clientId,
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
  });
}
