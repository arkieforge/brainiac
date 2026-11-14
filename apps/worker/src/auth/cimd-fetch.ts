// How the Worker fetches an MCP client's metadata document (CIMD: the client_id is an HTTPS URL to a JSON
// file). `@better-auth/cimd/node` resolves DNS once, checks every address is public and pins the connection,
// because a Node server sits next to private networks a hostile client_id could point at. Workers have no
// `node:https` or DNS pinning, and on the edge don't need them: the plugin already refuses client_ids on
// private, loopback or reserved hosts, global fetch leaves from Cloudflare's network and reaches no private
// network without a VPC binding (we have none), and `global_fetch_strictly_public` (alchemy.run.ts) routes a
// fetch to one of our own zones through Cloudflare's front door instead of straight to its origin. What's left
// to enforce is the rest of the plugin's contract: HTTPS, GET or HEAD, and no redirects.
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init = {}) => {
  // Never `new Request(input, init)`: the plugin asks for `redirect: "error"`, which workerd refuses to
  // construct, so every client would fail as a network error.
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input));
  const method = init.method ?? request?.method ?? "GET";
  if (url.protocol !== "https:") throw new TypeError("metadata URL must use HTTPS");
  if (method !== "GET" && method !== "HEAD") throw new TypeError("metadata fetch supports only GET and HEAD");
  const response = await fetch(url, {
    method,
    headers: new Headers(init.headers ?? request?.headers),
    redirect: "manual",
    signal: init.signal ?? request?.signal ?? null,
  });
  // Workers hand back the 3xx itself; the Fetch spec's "manual" gives an opaque redirect with status 0.
  const redirected =
    response.status === 0 || (response.status >= 300 && response.status < 400 && response.status !== 304);
  if (redirected) {
    await response.body?.cancel();
    throw new TypeError("metadata fetch refuses redirects");
  }
  return response;
};
