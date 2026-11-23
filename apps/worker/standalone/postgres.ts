// Postgres's wire protocol over one PGlite, for `vp run dev:standalone`: the Worker's pg pools reach it through
// Miniflare's Hyperdrive as they would a Neon branch.
import { createServer, type Server } from "node:net";

import type { PGlite } from "@electric-sql/pglite";

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
/** Parse, Bind, Describe, Execute, Close: an extended query's messages, which wait for the Sync that ends them. */
const EXTENDED = new Set("PBDEC".split("").map((c) => c.charCodeAt(0)));
const TERMINATE = "X".charCodeAt(0);

/**
 * Serves `db` to any number of connections. PGlite is one Postgres session, so each connection's extended query
 * (its messages up to Sync) runs whole, never interleaved with another connection's, whose Parse would replace its
 * unnamed statement. An open transaction doesn't hold the session: Better Auth awaits a query on a second
 * connection inside its transactions (index.ts), which would deadlock. shortcut: so connections aren't isolated
 * from each other's transactions; fine for one person's local dev, never for anything shared.
 */
export function servePostgres(db: PGlite): Server {
  return createServer((socket) => {
    let started = false;
    let buffered = Buffer.alloc(0);
    let unit: Buffer[] = [];
    socket.on("error", () => socket.destroy());
    socket.on("data", (data) => {
      buffered = Buffer.concat([buffered, data]);
      for (;;) {
        // Before startup a message has no type byte: just its length, then a code.
        if (buffered.length < (started ? 5 : 8)) return;
        const length = started ? 1 + buffered.readInt32BE(1) : buffered.readInt32BE(0);
        if (buffered.length < length) return;
        const message = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        if (!started) {
          const code = message.readInt32BE(4);
          // No TLS on loopback; PGlite has no other session for a cancel to stop.
          if (code === SSL_REQUEST || code === GSS_REQUEST) {
            socket.write("N");
            continue;
          }
          if (code === CANCEL_REQUEST) return void socket.end();
          started = true;
        } else if (message[0] === TERMINATE) return void socket.end();
        unit.push(message);
        if (EXTENDED.has(message[0] ?? 0)) continue;
        const messages = unit;
        unit = [];
        // PGlite's own lock is first come, first served, so one connection's units still run in order.
        db.runExclusive(async () => {
          for (const each of messages) socket.write(await db.execProtocolRaw(each));
        }).catch((error: unknown) => socket.destroy(error instanceof Error ? error : undefined));
      }
    });
  });
}
