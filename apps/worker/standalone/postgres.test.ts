// The standalone dev server's Postgres (postgres.ts): connections sharing one PGlite the way the Worker's pools do.
import { once } from "node:events";
import { connect as dial, type AddressInfo, type Socket } from "node:net";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { servePostgres } from "./postgres.ts";

const db = new PGlite();
const server = servePostgres(db);
const port = () => (server.address() as AddressInfo).port;
const closing: (() => unknown)[] = [];

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await db.exec(`create table "user" ("id" text primary key, "name" text not null)`);
});
afterAll(async () => {
  await Promise.all(closing.map((close) => close()));
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

// Frontend messages, as pg writes them.
const text = (value: string) => Buffer.from(`${value}\0`);
const int = (bytes: 2 | 4, value: number) => {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 2) buffer.writeInt16BE(value);
  else buffer.writeInt32BE(value);
  return buffer;
};
const message = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type), int(4, 4 + body.length), body]);
};
const STARTUP = (() => {
  const body = Buffer.concat([
    int(4, 196608),
    text("user"),
    text("postgres"),
    text("database"),
    text("postgres"),
  ]);
  return Buffer.concat([int(4, 5 + body.length), body, Buffer.from([0])]);
})();
// The unnamed statement and portal, with no parameters and every format the default.
const parseAndBind = (sql: string) =>
  Buffer.concat([
    message("P", text(""), text(sql), int(2, 0)),
    message("B", text(""), text(""), int(2, 0), int(2, 0), int(2, 0)),
  ]);
const describeExecuteSync = Buffer.concat([
  message("D", Buffer.from("P"), text("")),
  message("E", text(""), int(4, 0)),
  message("S"),
]);

/** A raw connection: `send` writes bytes, and `ready` resolves with the backend's message types up to ReadyForQuery. */
async function raw() {
  const socket: Socket = dial(port(), "127.0.0.1");
  closing.push(() => socket.destroy());
  let received = Buffer.alloc(0);
  let waiting: ((types: string) => void) | undefined;
  socket.on("data", (data) => {
    received = Buffer.concat([received, data]);
    const types: string[] = [];
    for (let at = 0; at + 5 <= received.length; at += 1 + received.readInt32BE(at + 1)) {
      const type = String.fromCharCode(received[at] ?? 0);
      // ParameterStatus, which PGlite reports whenever it likes.
      if (type !== "S") types.push(type);
      if (types.at(-1) === "Z" && at + 6 <= received.length) {
        received = received.subarray(at + 6);
        waiting?.(types.join(""));
        return;
      }
    }
  });
  const ready = () => new Promise<string>((resolve) => (waiting = resolve));
  const started = ready();
  socket.write(STARTUP);
  await started;
  return { send: (bytes: Buffer) => socket.write(bytes), ready, destroy: () => socket.destroy() };
}

it("runs a connection's extended query whole, even when another's arrives in the middle of it", async () => {
  const [a, b] = await Promise.all([raw(), raw()]);
  a.send(parseAndBind("select 'a' as who"));
  const answeredB = b.ready();
  b.send(Buffer.concat([parseAndBind("select 'b' as who"), describeExecuteSync]));
  // ParseComplete, BindComplete, RowDescription, DataRow, CommandComplete, ReadyForQuery; no ErrorResponse ("E").
  expect(await answeredB).toBe("12TDCZ");
  const answeredA = a.ready();
  a.send(describeExecuteSync);
  expect(await answeredA).toBe("12TDCZ");
});

it("answers another connection's query inside an open transaction, which then commits", async () => {
  const url = `postgres://postgres:postgres@127.0.0.1:${port()}/postgres`;
  const [a, b] = [new Client(url), new Client(url)];
  closing.push(
    () => a.end(),
    () => b.end(),
  );
  await Promise.all([a.connect(), b.connect()]);
  await a.query("begin");
  await a.query(`insert into "user" ("id", "name") values ($1, $2)`, ["user-ada", "Nadia Karim"]);
  // What Better Auth does: a second connection's query, awaited before the first commits.
  const seen = await b.query(`select count(*)::int as n from "user"`);
  await a.query("commit");
  expect(seen.rows).toEqual([{ n: 1 }]);
  expect((await b.query(`select "name" from "user" where "id" = $1`, ["user-ada"])).rows).toEqual([
    { name: "Nadia Karim" },
  ]);
});

it("rolls back the transaction of a connection that goes away in the middle of it", async () => {
  // The server's end of A, to know when the bridge has seen it close.
  const accepted = once(server, "connection");
  const a = await raw();
  const [serverSide]: Socket[] = await accepted;
  if (!serverSide) throw new Error("no connection");
  const answered = a.ready();
  a.send(message("Q", text(`begin; insert into "user" ("id", "name") values ('user-gone', 'Left mid-way')`)));
  await answered;
  // A cancelled request: its socket closes with the transaction open.
  const closed = once(serverSide, "close");
  a.destroy();
  await closed;
  // B commits on its own, and A's half-done write is gone.
  const url = `postgres://postgres:postgres@127.0.0.1:${port()}/postgres`;
  const b = new Client(url);
  closing.push(() => b.end());
  await b.connect();
  await b.query(`insert into "user" ("id", "name") values ($1, $2)`, ["user-next", "Next"]);
  expect((await b.query(`select "id" from "user" where "id" in ('user-gone', 'user-next')`)).rows).toEqual([
    { id: "user-next" },
  ]);
});
