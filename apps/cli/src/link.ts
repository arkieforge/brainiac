import type { ServerMessage } from "@brainiac/core";

import type { Connect } from "./daemon.ts";

/** Reconnects start after a second and back off to half a minute. */
const RETRY_MS = [1_000, 30_000] as const;

/** The token never travels in the clear, except to this machine (a dev server). */
export function mustBeEncrypted(url: URL): void {
  if (url.protocol === "wss:" || url.protocol === "https:") return;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  throw new Error(`${url.origin} isn't https: Brainiac sends its token only over an encrypted connection.`);
}

/**
 * The daemon's socket to the record: `<server>/sync`, with the connection's token in a header, which the Worker
 * routes to the record it names. It reconnects for as long as the daemon runs; the sync client resends whatever is
 * pending on each `open`.
 */
export function socketLink(server: string, token: string | undefined): Connect {
  const url = new URL("/sync", server.replace(/^http/, "ws"));
  if (token) mustBeEncrypted(url);
  return (on) => {
    let socket: WebSocket | undefined;
    let stopped = false;
    let delay: number = RETRY_MS[0];
    const open = () => {
      socket = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
      socket.addEventListener("open", () => {
        delay = RETRY_MS[0];
        on.open();
      });
      // The record's own messages; anything else on the socket (a proxy's error page) is dropped, not followed.
      socket.addEventListener("message", (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return console.error("Not a message from the record:", String(event.data).slice(0, 200));
        }
        if (typeof message === "object" && message !== null && "type" in message)
          on.message(message as ServerMessage);
      });
      socket.addEventListener("close", () => {
        on.close();
        if (stopped) return;
        setTimeout(open, delay);
        delay = Math.min(delay * 2, RETRY_MS[1]);
      });
    };
    open();
    return {
      send: (message) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close: () => {
        stopped = true;
        socket?.close();
      },
    };
  };
}
