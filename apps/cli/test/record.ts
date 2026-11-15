// A record for the daemon tests: the same `serve` the Base DO runs, on bun:sqlite, with links that deliver
// each message on a later turn of the event loop, like a socket. Other clients (the site, a phone) are real
// SyncClients on the same record.
import { Database } from "bun:sqlite";

import { bunSql } from "@brainiac/base/bun";
import {
  changesSince,
  currentSeq,
  getNote,
  getNoteByPath,
  migrate,
  mutate,
  PERSON,
  serve,
  type NoteClass,
  type NoteRow,
  type Principal,
} from "@brainiac/base";
import { emptyState, SyncClient } from "@brainiac/sync";

import type { Connect } from "../src/daemon.ts";

interface Peer {
  readonly on: Parameters<Connect>[0];
  open: boolean;
}

export class TestRecord {
  readonly sql = bunSql(new Database(":memory:", { strict: true }));
  readonly #peers = new Set<Peer>();
  #now = Date.UTC(2026, 10, 14);
  #ids = 0;
  readonly #events = new Set<() => void>();

  /** What every client may read: the person's view, or a connection's with fewer scopes. */
  readonly reader: Principal;

  constructor(reader: Principal = PERSON) {
    this.reader = reader;
    migrate(this.sql);
  }

  /** A note made in the record directly, as the site would. */
  seed(id: string, path: string, body = "start\n", cls: "normal" | "sensitive" = "normal"): void {
    const raw = `---\nid: ${id}\ntype: Note\ntitle: "${path}"\n---\n${body}`;
    mutate(this.sql, { op: "create", path, raw, class: cls }, { actor: "site", now: this.#now });
  }

  /** Sets a note's class in the record, as the site would, and pushes the change to every client. */
  classify(id: string, cls: NoteClass): void {
    const before = currentSeq(this.sql);
    const baseRev = getNote(this.sql, id)?.rev ?? 0;
    mutate(this.sql, { op: "classify", noteId: id, baseRev, class: cls }, { actor: "site", now: this.#now });
    const pushed = changesSince(this.sql, before, this.reader);
    for (const peer of this.#peers) this.#later(peer, () => peer.on.message(pushed));
  }

  note(id: string): NoteRow | undefined {
    return getNote(this.sql, id);
  }

  byPath(path: string): NoteRow | undefined {
    return getNoteByPath(this.sql, path);
  }

  /** From now on every note needs a title, as a record's manifest can require. */
  requireTitles(): void {
    const manifest =
      "schema_version: 1\ntypes:\n  Note:\n    version: 1\n    fields:\n      title: {kind: text, required: true}\n";
    this.sql.all("INSERT INTO schema (version, manifest) VALUES (1, ?)", manifest);
  }

  liveCount(): number {
    return this.sql.all<{ n: number }>("SELECT count(*) AS n FROM notes WHERE deletedAt IS NULL")[0]?.n ?? 0;
  }

  /** Resolves on the next message delivered to anyone. */
  nextEvent(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.#events.delete(done);
        resolve();
      };
      this.#events.add(done);
    });
  }

  #later(peer: Peer, deliver: () => void): void {
    setTimeout(() => {
      if (!peer.open) return;
      deliver();
      for (const done of this.#events) done();
    }, 0);
  }

  readonly connect: Connect = (on) => {
    const peer: Peer = { on, open: true };
    this.#peers.add(peer);
    this.#later(peer, () => on.open());
    return {
      send: (message) =>
        this.#later(peer, () => {
          const { replies, push } = serve(
            this.sql,
            message,
            { actor: "laptop", now: ++this.#now },
            this.reader,
          );
          for (const reply of replies) this.#later(peer, () => peer.on.message(reply));
          const pushed = push?.(this.reader);
          if (pushed) for (const other of this.#peers) this.#later(other, () => other.on.message(pushed));
        }),
      close: () => {
        peer.open = false;
        this.#peers.delete(peer);
        on.close();
      },
    };
  };

  /** Another client of the record (the site, a phone), connected and catching up. */
  client(): SyncClient {
    const client: SyncClient = new SyncClient(emptyState(`peer-${++this.#ids}`), {
      send: (message) => link.send(message),
      newClientId: () => `peer-${++this.#ids}`,
      schemaVersion: 1,
      appVersion: "test",
    });
    const link = this.connect({
      open: () => client.connect(),
      message: (message) => client.receive(message),
      close: () => client.disconnect(),
    });
    return client;
  }
}
