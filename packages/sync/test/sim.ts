// A record and simulated clients over an unreliable network, in one process. The record runs the same
// `serve` the Base DO runs, on node:sqlite; each client is the real SyncClient.
import { DatabaseSync } from "node:sqlite";

import { patch, type ClientMessage, type ServerMessage } from "@brainiac/core";
import { getNote, migrate, mutate, serve, type NoteRow, type Sql, type SqlValue } from "@brainiac/base";

import { emptyState, SyncClient, type State } from "../src/index.ts";

function nodeSql(db: DatabaseSync): Sql {
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  return {
    all: <Row>(query: string, ...params: SqlValue[]) => {
      let statement = statements.get(query);
      if (!statement) statements.set(query, (statement = db.prepare(query)));
      return statement.all(...params) as Row[];
    },
    transaction: (fn) => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** One client's link to the record: messages in flight each way, lost when the link drops. */
interface Link {
  up: ClientMessage[];
  down: ServerMessage[];
  connected: boolean;
}

export interface Device {
  readonly name: string;
  readonly client: SyncClient;
  readonly link: Link;
}

export class World {
  readonly sql: Sql;
  readonly devices: Device[] = [];
  #ids = 0;
  #now = Date.UTC(2026, 10, 14);

  constructor() {
    this.sql = nodeSql(new DatabaseSync(":memory:"));
    migrate(this.sql);
  }

  /** A note made directly in the record, as the site would. */
  seed(id: string, path: string, body = "## Log\n\nstart\n"): void {
    const raw = `---\nid: ${id}\ntype: Note\ntitle: "${path}"\n---\n${body}`;
    mutate(this.sql, { op: "create", path, raw, class: "normal" }, { actor: "site", now: this.#now });
  }

  /** A device starting from `state` (fresh, or a copy of another's). */
  device(name: string, state: State = emptyState(this.newClientId())): Device {
    const link: Link = { up: [], down: [], connected: false };
    const client = new SyncClient(state, {
      send: (message) => link.connected && link.up.push(message),
      newClientId: () => this.newClientId(),
      schemaVersion: 1,
      appVersion: "test",
    });
    const device = { name, client, link };
    this.devices.push(device);
    return device;
  }

  /** Takes a device off the network for good (replaced by a restored copy). */
  retire(device: Device): void {
    this.disconnect(device);
    this.devices.splice(this.devices.indexOf(device), 1);
  }

  newClientId(): string {
    return `client-${++this.#ids}`;
  }

  connect(device: Device): void {
    device.link.connected = true;
    device.client.connect();
  }

  /** The link drops: whatever was in flight either way is lost. */
  disconnect(device: Device): void {
    Object.assign(device.link, { up: [], down: [], connected: false });
    device.client.disconnect();
  }

  /** Delivers the `pick`-th message waiting from a device to the record (any one, so order is not kept). */
  up(device: Device, pick = 0): boolean {
    const [message] = device.link.up.splice(pick % Math.max(device.link.up.length, 1), 1);
    if (!message) return false;
    const { replies, push } = serve(this.sql, message, { actor: device.name, now: ++this.#now });
    device.link.down.push(...replies);
    if (push) for (const other of this.devices) if (other.link.connected) other.link.down.push(push);
    return true;
  }

  /** Delivers the `pick`-th message waiting for a device. */
  down(device: Device, pick = 0): boolean {
    const [message] = device.link.down.splice(pick % Math.max(device.link.down.length, 1), 1);
    if (!message) return false;
    device.client.receive(message);
    return true;
  }

  /** Connects everyone and delivers everything, in order, until nothing is in flight. */
  settle(): void {
    for (const device of this.devices) if (!device.link.connected) this.connect(device);
    for (let round = 0; round < 10_000; round++) {
      let moved = false;
      for (const device of this.devices) moved = this.up(device) || this.down(device) || moved;
      if (!moved) return;
    }
    throw new Error("the network never went quiet");
  }

  /** The record's live notes, as a client's remote layer should hold them. */
  live(): Map<string, { rev: number; raw: string }> {
    const rows = this.sql.all<NoteRow>("SELECT * FROM notes WHERE deletedAt IS NULL");
    return new Map(rows.map((row) => [row.id, { rev: row.rev, raw: row.raw }]));
  }

  note(id: string): NoteRow | undefined {
    return getNote(this.sql, id);
  }

  /** Each time a revision set a field back to a value an earlier revision of the note had replaced. */
  reverts(): [string, string, unknown][] {
    const rows = this.sql.all<{ noteId: string; patch: string }>(
      "SELECT noteId, patch FROM revisions ORDER BY noteId, rev",
    );
    const replaced = new Map<string, Set<unknown>>();
    const found: [string, string, unknown][] = [];
    for (const row of rows) {
      const fields: Record<string, { before?: unknown; after?: unknown }> = JSON.parse(row.patch).fields;
      for (const [field, change] of Object.entries(fields)) {
        const seen = replaced.get(`${row.noteId}/${field}`) ?? new Set();
        if ("after" in change && seen.has(change.after)) found.push([row.noteId, field, change.after]);
        if ("before" in change) seen.add(change.before);
        replaced.set(`${row.noteId}/${field}`, seen);
      }
    }
    return found;
  }

  /** Whether `token` reached the record: in a revision of the note, or kept in a conflict proposal. */
  kept(noteId: string, token: string): boolean {
    const [hit] = this.sql.all<{ n: number }>(
      `SELECT (SELECT count(*) FROM revisions WHERE noteId = ?1 AND instr(raw, ?2) > 0)
            + (SELECT count(*) FROM proposals WHERE noteId = ?1 AND instr(patch, ?2) > 0) AS n`,
      noteId,
      token,
    );
    return (hit?.n ?? 0) > 0;
  }
}

/** A device's local edit: sets one front-matter field on the text it shows (unless that text is broken). */
export function setField(device: Device, noteId: string, field: string, value: string): boolean {
  const text = device.client.working(noteId);
  if (text === undefined) return false;
  let edited: string;
  try {
    edited = patch(text, [{ op: "set", path: [field], value }]);
  } catch {
    return false;
  }
  device.client.edit(noteId, edited);
  return true;
}

/** A device's local edit to the body: adds a line at the end. */
export function addLine(device: Device, noteId: string, line: string): boolean {
  const text = device.client.working(noteId);
  if (text === undefined) return false;
  device.client.edit(noteId, `${text}${line}\n`);
  return true;
}
