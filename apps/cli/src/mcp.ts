// `brainiac mcp serve`: MCP over stdio for Claude Code, Codex and T3 Code. Each message goes to the record's own
// `/mcp` with this device's token, so the tools, their answers and the connection's grants are exactly the
// record's, as over remote MCP, and a narrowed grant applies to the next call.
// shortcut: offline, calls fail with a clear error instead of answering reads from the local copy; that needs the
// copy's revisions and the connection's last grants on disk (#94).
import { createInterface } from "node:readline";

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

export interface Bridge {
  /** The record's server, like https://brainiac.example. Plain http only on this machine. */
  readonly server: string;
  readonly token: string;
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
}

/** Forwards stdin's JSON-RPC lines to `<server>/mcp` one at a time, in order, and writes each answer as a line. */
export async function serveStdio({ server, token, input, write }: Bridge): Promise<void> {
  const url = new URL("/mcp", server);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new Error(`${server} isn't https: the token only travels over TLS.`);
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
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(version && { "mcp-protocol-version": version }),
        },
        body: line,
      });
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
