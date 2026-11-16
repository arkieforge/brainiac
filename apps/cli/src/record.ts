// One tool call on the record from a CLI command, over the same `/mcp` as `brainiac mcp serve`.
import { type } from "arktype";

import { mcpUrl, messagesIn, post } from "./mcp.ts";

/**
 * One tool call on the record, as this device's connection: what `brainiac questions` and the like ask. Throws
 * with words for the person when the record can't be reached or refuses, or the tool says the call was wrong.
 */
export async function callRecord(
  server: string,
  token: string,
  name: string,
  args: unknown,
): Promise<unknown> {
  const url = mcpUrl(server);
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  let response: Response;
  try {
    response = await post(url, token, JSON.stringify(request));
  } catch {
    // shortcut: offline, only `brainiac mcp serve` answers from the local copy; these commands wait for the record.
    throw new Error(`Can't reach your Brainiac record at ${url.origin}. This needs it online.`);
  }
  if (response.status === 401 || response.status === 403)
    throw new Error("Brainiac refused this device's token. Run brainiac login again.");
  if (!response.ok) throw new Error(`Brainiac answered ${response.status}. Try again.`);
  const [answer] = messagesIn(await response.text(), response.headers.get("content-type") ?? "");
  const parsed = ToolResult(answer === undefined ? undefined : JSON.parse(answer));
  if (parsed instanceof type.errors) throw new Error("Brainiac's answer had no result. Try again.");
  const [{ text }] = parsed.result.content;
  if (parsed.result.isError) throw new Error(text);
  return JSON.parse(text);
}

/** A tools/call answer: the tool's JSON as text, or why the call was wrong. */
const ToolResult = type({
  result: { content: [{ text: "string" }, "...", "unknown[]"], "isError?": "boolean" },
});
