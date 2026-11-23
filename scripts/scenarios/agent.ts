// A scripted agent for scenarios, Brainiac's version of T3 Code's Replay provider: the MCP calls a model would make,
// played against a stage's real /mcp with a dev token (apps/worker/src/dev.ts), so an agent's side of a flow (it
// proposes, the person decides on the site) runs in every scenario run at no model cost. The token connects like
// any MCP client, at the floor: propose level, no sensitive notes.

/** One tool call's answer: the tool's JSON value when it succeeded, else its error text. */
export type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export interface Agent {
  /** Calls one Brainiac tool by the name agents use (packages/base/src/tools.ts). */
  call(name: string, args: Record<string, unknown>): Promise<Answer>;
}

/** The JSON-RPC message in a /mcp answer, which streams as server-sent events or comes back as plain JSON. */
function messageOf(contentType: string | null, text: string): unknown {
  if (!contentType?.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error(`/mcp answered an event stream with no message: ${text.slice(0, 200)}`);
  return JSON.parse(data.slice("data: ".length));
}

/** The tool result inside a JSON-RPC answer: its first text part, as JSON when it is JSON. */
function answerOf(message: unknown): Answer {
  if (!message || typeof message !== "object") throw new Error("/mcp answered no JSON-RPC message");
  if ("error" in message) throw new Error(`/mcp refused the call: ${JSON.stringify(message.error)}`);
  if (!("result" in message) || !message.result || typeof message.result !== "object")
    throw new Error(`/mcp answered no result: ${JSON.stringify(message)}`);
  const { result } = message;
  const first = "content" in result && Array.isArray(result.content) ? result.content[0] : undefined;
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
 * sign-in token on its first call.
 */
export function scriptedAgent(origin: string, devToken: string, as: string): Agent {
  let accessToken: Promise<string> | undefined;
  const mint = async () => {
    const res = await fetch(`${origin}/dev/token?as=${encodeURIComponent(as)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${devToken}` },
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok || !body || typeof body !== "object" || !("access_token" in body))
      throw new Error(`/dev/token answered ${res.status}`);
    return String(body.access_token);
  };
  let id = 0;
  return {
    async call(name, args) {
      accessToken ??= mint();
      const res = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      if (!res.ok) throw new Error(`/mcp answered ${res.status} to ${name}`);
      return answerOf(messageOf(res.headers.get("content-type"), await res.text()));
    },
  };
}
