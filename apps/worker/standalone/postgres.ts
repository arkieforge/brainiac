// Postgres's wire protocol over one PGlite, for `vp run dev:standalone`: the Worker's pg pools reach it through
// Miniflare's Hyperdrive as they would a Neon branch.
import { createServer, type Server, type Socket } from "node:net";

import type { PGlite } from "@electric-sql/pglite";

const SSL_REQUEST = 80877103;
const GSS_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
/** Parse, Bind, Describe, Execute, Close: an extended query's messages, which wait for the Sync that ends them. */
const EXTENDED = new Set("PBDEC".split("").map((c) => c.charCodeAt(0)));
const TERMINATE = "X".charCodeAt(0);
const READY = "Z".charCodeAt(0);
const IDLE = "I".charCodeAt(0);
/** A simple-protocol Query: "Q", its length, then the SQL ended by a NUL. */
const ROLLBACK = (() => {
  const sql = Buffer.from("rollback\0");
  const length = Buffer.alloc(4);
  length.writeInt32BE(4 + sql.length);
  return new Uint8Array(Buffer.concat([Buffer.from("Q"), length, sql]));
})();

/**
 * Serves `db` to any number of connections. PGlite is one Postgres session, so each connection's extended query
 * (its messages up to Sync) runs whole, never interleaved with another connection's, whose Parse would replace its
 * unnamed statement. An open transaction doesn't hold the session: Better Auth awaits a query on a second
 * connection inside its transactions (index.ts), which would deadlock. shortcut: so connections aren't isolated
 * from each other's transactions (one's write can be rolled back with another's open transaction); fine for one
 * person's local dev, never for anything shared. The connection that opened the transaction owns it: if it goes
 * away mid-transaction (a reload cancels the request), the transaction is rolled back, or it would stay open and
 * every later query on every connection would run inside it.
 */
export function servePostgres(db: PGlite): Server {
  /**
   * The connection whose transaction is open, if any: the one whose reply first left the session in a transaction.
   * Others' queries inside it (Better Auth's second connection) don't take it over; the session going idle ends it.
   */
  let owner: Socket | undefined;
  return createServer((socket) => {
    // Under the lock, behind anything this connection still had queued (which is skipped, the socket being gone),
    // so the owner checked is the one its last unit left. A Query message, since PGlite's exec() takes the lock
    // itself and would wait on this very hold.
    socket.on("close", () => {
      void db
        .runExclusive(async () => {
          if (owner !== socket) return;
          owner = undefined;
          await db.execProtocolRaw(ROLLBACK);
        })
        .catch(() => {});
    });
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
          // A connection that went away while this waited for the lock: nothing of it runs any more. Checked once per
          // unit, never between its messages: a unit stopped before its Sync would leave the session skipping
          // every message until one, the next connection's writes included.
          if (socket.destroyed) return;
          for (const each of messages) {
            const reply = await db.execProtocolRaw(each);
            // A reply that ends in ReadyForQuery ("Z", length 5) carries the transaction status last: I idle,
            // T in a transaction, E in a failed one.
            if (reply.length >= 6 && reply[reply.length - 6] === READY) {
              const status = reply[reply.length - 1];
              if (status === IDLE) owner = undefined;
              else owner ??= socket;
            }
            socket.write(reply);
          }
        }).catch((error: unknown) => socket.destroy(error instanceof Error ? error : undefined));
      }
    });
  });
}
