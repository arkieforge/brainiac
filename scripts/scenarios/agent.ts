// A scripted agent for scenarios, Brainiac's version of T3 Code's Replay provider: the MCP calls a model would make,
// played against a stage's real /mcp with a dev token (apps/worker/src/dev.ts), so an agent's side of a flow (it
// proposes, the person decides on the site) runs in every scenario run at no model cost. Its connection is like any
// MCP client's, at the floor: propose level, no sensitive notes. It skips `initialize` and sends each `tools/call`
// alone, which works because /mcp is stateless (packages/base/src/mcp.ts `serveTools`); a session-keeping server
// would need the handshake first.
import { mcpToken } from "../dev-auth.ts";

/** One tool call's answer: the tool's JSON value when it succeeded, else its error text. */
export type ToolAnswer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export interface Agent {
  /** Calls one Brainiac tool by the name agents use (packages/base/src/tools.ts). */
  call(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
}

/**
 * The JSON-RPC response to request `id` in a /mcp answer, which streams as server-sent events (one message per
 * `data:` field, other messages such as notifications possible) or comes back as plain JSON.
 */
function responseTo(id: number, contentType: string | null, text: string): unknown {
  const messages: unknown[] = contentType?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice("data:".length)))
    : [JSON.parse(text)];
  const response = messages.find(
    (message) => !!message && typeof message === "object" && "id" in message && message.id === id,
  );
  if (!response) throw new Error(`/mcp answered no response to request ${id}: ${text.slice(0, 200)}`);
  return response;
}

/** The tool result inside a JSON-RPC response: its first text part, as JSON when it is JSON. */
function answerOf(response: unknown): ToolAnswer {
  if (!response || typeof response !== "object") throw new Error("/mcp answered no JSON-RPC response");
  if ("error" in response) throw new Error(`/mcp refused the call: ${JSON.stringify(response.error)}`);
  if (!("result" in response) || !response.result || typeof response.result !== "object")
    throw new Error(`/mcp answered no result: ${JSON.stringify(response)}`);
  const { result } = response;
  const content: unknown = "content" in result ? result.content : undefined;
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = first && typeof first === "object" && "text" in first ? first.text : undefined;
  if (typeof text !== "string") throw new Error(`/mcp answered no text: ${JSON.stringify(result)}`);
  if ("isError" in result && result.isError) return { ok: false, error: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: true, value: text };
  }
}

/**
 * The agent of the fixture account tagged `as` on `origin`, signed in with a `/mcp` token minted from the dev
 * sign-in token on its first call, so a scenario that never uses it costs nothing.
 */
export function scriptedAgent(origin: string, devToken: string, as: string): Agent {
  let accessToken: Promise<string> | undefined;
  let id = 0;
  return {
    async call(name, args) {
      accessToken ??= mcpToken(origin, devToken, as).then((minted) => minted.access_token);
      const request = ++id;
      const res = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: request,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!res.ok) throw new Error(`/mcp answered ${res.status} to ${name}`);
      return answerOf(responseTo(request, res.headers.get("content-type"), await res.text()));
    },
  };
}
