// `brainiac mcp serve`: MCP over stdio for Claude Code, Codex and T3 Code. Each message goes to the record's own
// `/mcp` with this device's token, so the tools, their answers and the connection's grants are exactly the
// record's, as over remote MCP, and a narrowed grant applies to the next call.
// shortcut: offline, calls fail with a clear error instead of answering reads from the local copy; that needs the
// copy's revisions and the connection's last grants on disk (#94).
import { createInterface } from "node:readline";

import { BACKGROUND_HEADER } from "@brainiac/base";
import { type } from "arktype";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The JSON-RPC id of a request, or undefined for a notification (which gets no answer). */
function idOf(message: unknown): string | number | null | undefined {
  if (typeof message !== "object" || message === null || !("id" in message)) return undefined;
  const { id } = message;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

const failure = (id: string | number | null, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } });

/** Every JSON-RPC message in a response body, which is JSON or a stream of server-sent events. */
function messagesIn(body: string, contentType: string): string[] {
  if (!contentType.includes("text/event-stream")) return body.trim() === "" ? [] : [body.trim()];
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "");
}

/** `<server>/mcp`, refused unless the token would travel over TLS (or stay on this machine). */
function mcpUrl(server: string): URL {
  const url = new URL("/mcp", server);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new Error(`${server} isn't https: the token only travels over TLS.`);
  return url;
}

const post = (url: URL, token: string, body: string, version?: string, background?: boolean) =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(version && { "mcp-protocol-version": version }),
      ...(background && { [BACKGROUND_HEADER]: "1" }),
    },
    body,
  });

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
    // shortcut: offline, the local copy can't answer yet (#94).
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

export interface Bridge {
  /** The record's server, like https://brainiac.example. Plain http only on this machine. */
  readonly server: string;
  readonly token: string;
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  /** Nobody is there (the daemon's headless filer): the record narrows the connection for every call. */
  readonly background?: boolean;
}

/** Forwards stdin's JSON-RPC lines to `<server>/mcp` one at a time, in order, and writes each answer as a line. */
export async function serveStdio({ server, token, input, write, background }: Bridge): Promise<void> {
  const url = mcpUrl(server);
  let version: string | undefined;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (line.trim() === "") continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    const id = idOf(message);
    let response: Response;
    try {
      response = await post(url, token, line, version, background);
    } catch {
      if (id !== undefined)
        write(failure(id, `Can't reach your Brainiac record at ${url.origin}. Nothing was read or changed.`));
      continue;
    }
    const body = await response.text();
    if (!response.ok && response.status !== 202) {
      if (id === undefined) continue;
      const refused = response.status === 401 || response.status === 403;
      write(
        failure(
          id,
          refused
            ? "Brainiac refused this device's token. Run brainiac login again."
            : `Brainiac answered ${response.status}. Try again.`,
        ),
      );
      continue;
    }
    for (const answer of messagesIn(body, response.headers.get("content-type") ?? "")) {
      // Later requests name the version initialize agreed on.
      const parsed: unknown = JSON.parse(answer);
      const result =
        typeof parsed === "object" && parsed !== null && "result" in parsed ? parsed.result : undefined;
      if (typeof result === "object" && result !== null && "protocolVersion" in result)
        version = String(result.protocolVersion);
      write(answer);
    }
  }
}
