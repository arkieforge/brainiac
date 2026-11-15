// The daemon on a real filesystem, run by Bun (daemon.test.ts starts test/bun.ts). Each case gets its own
// vault folder; editors' save patterns are interleaved at every step of the daemon's swap.
import { deepStrictEqual as same, equal, ok, throws } from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PERSON, search, serve } from "@brainiac/base";
import { decodeClientMessage, patch, type NoteState } from "@brainiac/core";

import { doctor, lockVault, request, restore, takeRequest } from "../src/commands.ts";
import { Daemon, type DaemonOptions } from "../src/daemon.ts";
import type { Step } from "../src/disk.ts";
import { openIndex } from "../src/index-db.ts";
import { socketLink } from "../src/link.ts";
import { DISPLACED_MS } from "../src/state.ts";
import { TestRecord } from "./record.ts";

export type CaseResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

const A = "01M6AAAAAAAAAAAAAAAAAAAAA1";
const B = "01M6AAAAAAAAAAAAAAAAAAAAA2";
const C = "01M6AAAAAAAAAAAAAAAAAAAAA3";

interface Vault {
  readonly root: string;
  readonly record: TestRecord;
  readonly daemon: Daemon;
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  /** Waits, on each synced batch or delivered message, until `done` holds. */
  until(done: () => boolean, what: string): Promise<void>;
}

/** Every folder a case made, removed after the run. */
export const folders: string[] = [];

/** A new empty folder under the OS temp folder, with symlinks resolved (macOS's /var is one). */
function folder(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  folders.push(path);
  return path;
}

/** A record with notes A, B and C, and a daemon that has written them into a new vault folder. */
async function vault(options: Partial<DaemonOptions> = {}, root?: string, extra = 0): Promise<Vault> {
  const record = new TestRecord();
  record.seed(A, "notes/a.md");
  record.seed(B, "notes/b.md");
  record.seed(C, "notes/c.md");
  for (let i = 0; i < extra; i++) record.seed(`01M6AAAAAAAAAAAAAAAAAAAAB${i}`, `notes/x${i}.md`);
  return open(record, root ?? folder("brainiac-vault-"), options);
}

async function open(record: TestRecord, root: string, options: Partial<DaemonOptions> = {}): Promise<Vault> {
  const daemon = await Daemon.start({
    root,
    deviceId: "laptop",
    connect: record.connect,
    debounceMs: 20,
    ...options,
  });
  const read = (path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined;
  const v: Vault = {
    root,
    record,
    daemon,
    read,
    write: (path, text) => writeFileSync(join(root, path), text),
    async until(done, what) {
      for (let events = 0; !done(); events++) {
        if (events > 2_000) throw new Error(`never happened: ${what}`);
        await Promise.race([daemon.nextBatch(), record.nextEvent()]);
      }
    },
  };
  await v.until(() => synced(v, A) && synced(v, B), "the first sync");
  return v;
}

/** The note's file is the record's text, and nothing waits to be sent. */
const synced = (v: Vault, id: string, path = `notes/${id === A ? "a" : id === B ? "b" : "c"}.md`) =>
  v.read(path) === v.record.note(id)?.raw && v.daemon.client.state.pending.length === 0;

/** Every revision of the note, oldest first. */
const revisions = (v: Vault, id: string) =>
  v.record.sql
    .all<{ raw: string }>("SELECT raw FROM revisions WHERE noteId = ? ORDER BY rev", id)
    .map((r) => r.raw);

const setField = (raw: string, field: string, value: string) =>
  patch(raw, [{ op: "set", path: [field], value }]);

/** How editors save: in place, write-then-rename (most), and vim's rename-then-write. */
const SAVES: Record<string, (full: string, text: string) => void> = {
  "in place": (full, text) => writeFileSync(full, text),
  "atomic rename": (full, text) => {
    writeFileSync(`${full}.editor-tmp`, text);
    renameSync(`${full}.editor-tmp`, full);
  },
  "rename then write": (full, text) => {
    const had = existsSync(full);
    if (had) renameSync(full, `${full}~`);
    writeFileSync(full, text);
    if (had) rmSync(`${full}~`);
  },
};

const STEPS: readonly Step[] = ["temp", "swapped", "read"];

/** A note in the change feed, at `path`, as the record would send it. */
const fed = (noteId: string, path: string): NoteState => ({
  noteId,
  seq: 1,
  deleted: false,
  rev: 1,
  path,
  raw: `---\nid: ${noteId}\n---\nhostile\n`,
  class: "normal",
});

/** A change feed message as a buggy or hostile server might send it, straight to the daemon's client. */
function feed(v: Vault, ...items: NoteState[]): void {
  const cursor = v.daemon.client.state.cursor ?? 0;
  v.daemon.client.receive({ type: "changes", from: cursor, to: cursor + 1, items });
}

const cases: Record<string, () => Promise<void>> = {
  async "an editor still writing into the file it had open across the swap loses nothing"() {
    let armed = false;
    let fd: number | undefined;
    const local = { text: "" };
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (!armed || path !== "notes/a.md") return;
          // It opened the file before the swap, and writes after the daemon read what the swap displaced.
          if (at === "temp") fd = openSync(join(v.root, path), "r+");
          if (at === "read" && fd !== undefined) {
            armed = false;
            ftruncateSync(fd, 0);
            writeSync(fd, local.text, 0);
            fsyncSync(fd);
            closeSync(fd);
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    local.text = `${v.read("notes/a.md")}late line\n`;
    armed = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => (v.record.note(A)?.raw.includes("late line") ?? false) && synced(v, A),
      "the late write to reach the record",
    );
    ok(v.record.note(A)?.raw.includes("status: from the site"), "merged with the web edit");
    v.daemon.stop();
  },

  async "a kept-aside file named in state.db is only ever read from the daemon's own folder"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "not yours");
    // state.db sits in the vault, so anyone who can write the vault can write this row.
    v.daemon.state.displace("notes/a.md", v.read("notes/a.md")!, Date.now(), A, secret);
    v.daemon.stop();
    const again = await open(v.record, v.root);
    equal(readFileSync(secret, "utf8"), "not yours", "never deleted");
    ok(!v.record.note(A)?.raw.includes("not yours"), "never read into the record");
    again.daemon.stop();
  },

  async "paths planted in state.db never lead the daemon out of the vault"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, "secret.md"), "---\nid: 01M6AAAAAAAAAAAAAAAAAAAAA1\n---\nnot yours\n");
    // A row that claims note A's file is outside the vault, and a displaced folder that leads out of it.
    v.daemon.state.setKnown({ path: `../${outside.split("/").at(-1)}/secret.md`, noteId: A, text: "x" });
    v.daemon.stop();
    const again = await open(v.record, v.root);
    rmSync(join(v.root, ".brainiac", "displaced"), { recursive: true, force: true });
    symlinkSync(outside, join(v.root, ".brainiac", "displaced"));
    const site = v.record.client();
    await again.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await again.until(
      () => again.read("notes/a.md")?.includes("status: from the site") ?? false,
      "the web edit",
    );
    same(readdirSync(outside), ["secret.md"], "nothing written through the symlink");
    equal(readFileSync(join(outside, "secret.md"), "utf8").includes("not yours"), true, "never touched");
    ok(!v.record.note(A)?.raw.includes("not yours"), "never read into the record");
    again.daemon.stop();
  },

  async "a kept file a crash left with no record is recovered by the note its name carries"() {
    const v = await vault();
    v.daemon.stop();
    mkdirSync(join(v.root, ".brainiac", "displaced"), { recursive: true });
    const orphan = join(v.root, ".brainiac", "displaced", `1-0000abcd-${A}`);
    writeFileSync(orphan, `${v.read("notes/a.md")}only in the kept file\n`);
    const again = await open(v.record, v.root);
    await again.until(
      () => v.record.note(A)?.raw.includes("only in the kept file") ?? false,
      "the recovered save",
    );
    equal(existsSync(orphan), false);
    again.daemon.stop();
  },

  async "a file the disk won't let the daemon touch is held, and the rest keeps syncing"() {
    const v = await vault();
    mkdirSync(join(v.root, "locked"));
    v.write("locked/new.md", "---\ntype: Note\ntitle: Locked\n---\nbody\n");
    chmodSync(join(v.root, "locked"), 0o555); // the id can't go in: no temp file in a read-only folder
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "still syncing"));
    await v.until(() => v.record.note(B)?.raw.includes("status: still syncing") ?? false, "the other save");
    // As root (a container) the folder isn't read-only, and the file just syncs.
    await v.until(
      () => v.daemon.held.has("locked/new.md") || v.record.byPath("locked/new.md") !== undefined,
      "the locked file held or synced",
    );
    chmodSync(join(v.root, "locked"), 0o755);
    v.daemon.stop();
  },

  async "a remote delete that arrives during a pause reaches the file on resume"() {
    const v = await vault();
    v.daemon.state.setPause({ reason: "a test pause", at: Date.now() });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.delete(A);
    await v.until(() => v.daemon.client.state.remote.get(A) === undefined, "the delete to arrive");
    ok(v.read("notes/a.md") !== undefined, "paused: the file stays");
    await v.daemon.resume();
    await v.until(() => v.read("notes/a.md") === undefined, "the file to go");
    v.daemon.stop();
  },

  async "a note file replaced by a symlink is never read or written through"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, "secret.md"), "not yours\n");
    rmSync(join(v.root, "notes/a.md"));
    symlinkSync(join(outside, "secret.md"), join(v.root, "notes/a.md"));
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.daemon.held.has("notes/a.md"), "the symlink to be held");
    equal(readFileSync(join(outside, "secret.md"), "utf8"), "not yours\n", "never written through");
    ok(!v.record.note(A)?.raw.includes("not yours"), "never read into the record");
    v.daemon.stop();
  },

  async "notes under a symlinked folder that leads out of the vault are not synced"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, "note.md"), "---\ntype: Note\ntitle: Outside\n---\nnot yours\n");
    symlinkSync(outside, join(v.root, "linked"));
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a batch"));
    await v.until(() => v.record.note(B)?.raw.includes("status: a batch") ?? false, "the batch");
    v.daemon.stop();
    const again = await open(v.record, v.root); // the startup scan walks the folder too
    equal(v.record.byPath("linked/note.md"), undefined, "never synced");
    again.daemon.stop();
  },

  async "an editor saving into its open file after the first check is still caught"() {
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (arm && at === "temp" && path === "notes/a.md") {
            arm = false;
            fd = openSync(join(v.root, path), "r+");
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    const late = `${v.read("notes/a.md")}much later\n`;
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => synced(v, A) && fd !== undefined, "the web edit");
    await v.daemon.nextBatch(); // the grace check has passed by now
    ftruncateSync(fd!, 0);
    writeSync(fd!, late, 0);
    fsyncSync(fd!);
    closeSync(fd!);
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.record.note(A)?.raw.includes("much later") ?? false, "the late save");
    v.daemon.stop();
  },

  async "an editor saving into its open file while a web delete removes it brings the note back"() {
    let fd: number | undefined;
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (fd !== undefined && at === "read" && path === "notes/a.md") {
            ftruncateSync(fd, 0);
            writeSync(fd, late, 0);
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
          }
        },
      },
    });
    const late = `${v.read("notes/a.md")}written as it went\n`;
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    fd = openSync(join(v.root, "notes/a.md"), "r+");
    site.delete(A);
    await v.until(
      () =>
        v.record.note(A)?.deletedAt === null &&
        (v.record.note(A)?.raw.includes("written as it went") ?? false),
      "the late save to bring it back",
    );
    v.daemon.stop();
  },

  async "a save made while a sensitive note's file is removed is sent, and the file still goes"() {
    let armed = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (!armed || at !== "swapped" || path !== "notes/a.md") return;
          armed = false;
          writeFileSync(join(v.root, path), `${raw}saved as it went\n`);
        },
      },
    });
    const raw = v.read("notes/a.md")!;
    armed = true;
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    await v.until(() => v.read("notes/a.md") === undefined, "the file to go");
    await v.until(() => v.record.note(A)?.raw.includes("saved as it went") ?? false, "the save to be sent");
    v.daemon.stop();
  },

  async "a note that becomes sensitive after a move leaves no history at its old path"() {
    const v = await vault();
    v.daemon.state.displace("notes/a.md", "from before the move", Date.now(), A);
    mkdirSync(join(v.root, "moved"));
    renameSync(join(v.root, "notes/a.md"), join(v.root, "moved/a.md"));
    await v.until(() => v.daemon.state.known("moved/a.md") !== undefined, "the move");
    const raw = v.read("moved/a.md")!;
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    same(restore(v.root, "notes/a.md", Date.now()), [], "no history at the old path");
    v.daemon.stop();
  },

  async "a record note whose name another local note holds is held, not written"() {
    const v = await vault();
    feed(v, {
      noteId: "01M6AAAAAAAAAAAAAAAAAAAAA7",
      seq: 9,
      deleted: false,
      rev: 1,
      path: "notes/b.md",
      raw: "---\nid: 01M6AAAAAAAAAAAAAAAAAAAAA7\n---\nwants b\n",
      class: "normal",
    });
    ok(v.daemon.held.get("notes/b.md")?.includes("01M6AAAAAAAAAAAAAAAAAAAAA7"));
    ok(!v.read("notes/b.md")?.includes("wants b"), "B's file is untouched");
    v.daemon.stop();
  },

  async "a vault reached through a symlink is the same vault to the lock"() {
    const config = folder("brainiac-config-");
    const root = folder("brainiac-vault-");
    const alias = join(folder("brainiac-alias-"), "vault");
    symlinkSync(root, alias);
    const unlock = lockVault(config, root);
    throws(() => lockVault(config, alias), /Another brainiac daemon/);
    unlock();
  },

  async "a local delete racing a web write still reaches the record"() {
    let armed = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (!armed || at !== "temp" || path !== "notes/a.md") return;
          armed = false;
          rmSync(join(v.root, path));
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    armed = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    // Deleted here, edited on the web: by the merge rules the note stays and the delete waits for the person.
    await v.until(
      () => v.daemon.client.state.blocked.get(A)?.some((b) => b.change.kind === "delete") ?? false,
      "the delete to reach the record",
    );
    v.daemon.stop();
  },

  async "a symlink loop in the vault doesn't hide notes, and doctor still runs"() {
    const v = await vault();
    v.daemon.stop();
    mkdirSync(join(v.root, "inbox"));
    symlinkSync(v.root, join(v.root, "inbox", "loop"));
    v.write("notes/offline.md", "---\ntype: Note\ntitle: Offline\n---\nmade while stopped\n");
    const again = await open(v.record, v.root);
    await again.until(() => v.record.byPath("notes/offline.md") !== undefined, "the offline note");
    const config = folder("brainiac-config-");
    ok((await doctor(config, v.root)).length > 0, "doctor reports");
    again.daemon.stop();
  },

  async "renaming a note to another case keeps one note and its id"() {
    const v = await vault();
    const before = v.read("notes/a.md")!;
    renameSync(join(v.root, "notes/a.md"), join(v.root, "notes/A.md"));
    await v.until(() => v.daemon.state.known("notes/A.md") !== undefined, "the rename");
    ok(v.read("notes/A.md")!.includes(`id: ${A}`), "the same id");
    equal(v.read("notes/A.md"), before, "the file is untouched");
    equal(v.record.liveCount(), 3, "no new note");
    v.daemon.stop();
  },

  async "an editor that truncates then writes across the swap merges with the web edit"() {
    let fd: number | undefined;
    let armed = false;
    const local = { text: "" };
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (!armed || path !== "notes/a.md") return;
          if (at === "temp") fd = openSync(join(v.root, path), "w"); // truncated, not yet written
          if (at === "read" && fd !== undefined) {
            armed = false;
            writeSync(fd, local.text, 0);
            fsyncSync(fd);
            closeSync(fd);
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    local.text = `${v.read("notes/a.md")}line from the editor\n`;
    armed = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => (v.record.note(A)?.raw.includes("line from the editor") ?? false) && synced(v, A),
      "the editor's write",
    );
    ok(v.record.note(A)?.raw.includes("status: from the site"), "merged, not a conflict");
    v.daemon.stop();
  },

  async "temp files under a symlinked folder are never read or deleted"() {
    const v = await vault();
    v.daemon.stop();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, ".~brainiac-deadbeef-x.md"), "not yours");
    symlinkSync(outside, join(v.root, "linked"));
    const again = await open(v.record, v.root);
    equal(readFileSync(join(outside, ".~brainiac-deadbeef-x.md"), "utf8"), "not yours", "untouched");
    again.daemon.stop();
  },

  async "a kept file with no record is recovered on a repair too"() {
    const v = await vault();
    v.daemon.stop();
    mkdirSync(join(v.root, ".brainiac", "displaced"), { recursive: true });
    writeFileSync(
      join(v.root, ".brainiac", "displaced", `1-0000abcd-${A}`),
      `${v.read("notes/a.md")}only in the kept file\n`,
    );
    const again = await open(v.record, v.root, { repair: true });
    await again.until(
      () => v.record.note(A)?.raw.includes("only in the kept file") ?? false,
      "the recovered save",
    );
    again.daemon.stop();
  },

  async "an editor writing into a sensitive note's open file as it goes is sent, and nothing stays"() {
    let fd: number | undefined;
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (fd === undefined || at !== "read" || path !== "notes/a.md") return;
          writeSync(fd, late, 0);
          fsyncSync(fd);
          closeSync(fd);
          fd = undefined;
        },
      },
    });
    const raw = v.read("notes/a.md")!;
    const late = `${raw}written as it went\n`;
    fd = openSync(join(v.root, "notes/a.md"), "r+");
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.record.note(A)?.raw.includes("written as it went") ?? false, "the late save");
    await v.until(() => v.daemon.state.asides().length === 0, "the brief watch to end");
    equal(v.read("notes/a.md"), undefined, "the file is gone");
    same(restore(v.root, "notes/a.md", Date.now()), [], "nothing kept");
    v.daemon.stop();
  },

  async "an editor still writing into a file restore replaced is caught by the daemon"() {
    const v = await vault({ graceMs: 20 });
    const original = v.read("notes/a.md")!;
    v.daemon.state.displace("notes/a.md", setField(original, "status", "older"), Date.now(), A);
    // The editor has the original open; it writes its own buffer into that file after the restore.
    const fd = openSync(join(v.root, "notes/a.md"), "r+");
    restore(v.root, "notes/a.md", Date.now(), 1);
    const late = `${original}written into the old file\n`;
    ftruncateSync(fd, 0);
    writeSync(fd, late, 0);
    fsyncSync(fd);
    closeSync(fd);
    // restore runs in its own process; the daemon checks kept files on its next batch.
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    // Both reach the record, in either order, and merge: the restored field and the editor's line.
    await v.until(() => {
      const raw = v.record.note(A)?.raw ?? "";
      return raw.includes("written into the old file") && raw.includes("status: older");
    }, "the late save and the restore");
    v.daemon.stop();
  },

  async "a sensitive note's file an editor saves again is taken off the device again"() {
    const v = await vault();
    const raw = v.read("notes/a.md")!;
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    equal(v.read("notes/a.md"), undefined);
    v.write("notes/a.md", raw); // the editor still had it open, unchanged
    await v.until(() => v.read("notes/a.md") === undefined, "the file to go again");
    v.daemon.stop();
  },

  async "state.db must not be a symlink; a symlinked index.db is just rebuilt"() {
    const v = await vault();
    v.daemon.stop();
    const outside = folder("brainiac-outside-");
    renameSync(join(v.root, ".brainiac", "index.db"), join(outside, "index.db"));
    symlinkSync(join(outside, "index.db"), join(v.root, ".brainiac", "index.db"));
    const again = await open(v.record, v.root);
    again.daemon.stop();
    ok(!lstatSync(join(v.root, ".brainiac", "index.db")).isSymbolicLink(), "rebuilt in place");
    renameSync(join(v.root, ".brainiac", "state.db"), join(outside, "state.db"));
    symlinkSync(join(outside, "state.db"), join(v.root, ".brainiac", "state.db"));
    let refused = false;
    await Daemon.start({ root: v.root, deviceId: "laptop", connect: v.record.connect }).then(
      (d) => d.stop(),
      () => (refused = true),
    );
    ok(refused, "a symlinked state.db is refused");
  },

  async "a refused edit undone in the file clears the block, and web edits flow again"() {
    const v = await vault();
    const original = v.read("notes/a.md")!;
    v.write("notes/a.md", "---\nid: [\n---\nhalf saved\n");
    await v.until(() => v.daemon.client.state.blocked.has(A), "the refused save");
    v.write("notes/a.md", original); // the person presses undo
    await v.until(() => !v.daemon.client.state.blocked.has(A), "the block to clear");
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    v.daemon.stop();
  },

  async "a sensitive note with no file here still loses its history"() {
    const v = await vault();
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "one"));
    await v.until(
      () => (v.read("notes/a.md")?.includes("status: one") ?? false) && synced(v, A),
      "the web edit",
    );
    const raw = v.record.note(A)!.raw;
    site.delete(A);
    await v.until(() => v.read("notes/a.md") === undefined, "the web delete");
    // A version already past its watch: plain history, with no kept file to go with it.
    v.daemon.state.displace("notes/a.md", "an older version", Date.now(), A);
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    same(restore(v.root, "notes/a.md", Date.now()), [], "none left");
    v.daemon.stop();
  },

  async "a late save in an earlier kept file is sent before a note is withheld"() {
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (arm && at === "temp" && path === "notes/a.md") {
            arm = false;
            fd = openSync(join(v.root, path), "r+");
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    const late = `${v.read("notes/a.md")}saved into the old file\n`;
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => synced(v, A) && fd !== undefined, "the web edit");
    ftruncateSync(fd!, 0);
    writeSync(fd!, late, 0);
    fsyncSync(fd!);
    closeSync(fd!);
    const raw = v.record.note(A)!.raw;
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    await v.until(() => v.record.note(A)?.raw.includes("saved into the old file") ?? false, "the late save");
    v.daemon.stop();
  },

  async "a .brainiac folder swapped for a symlink while running never leads kept files out"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    renameSync(join(v.root, ".brainiac"), join(outside, "moved-meta")); // the open state.db goes with it
    symlinkSync(outside, join(v.root, ".brainiac"));
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    equal(existsSync(join(outside, "displaced")), false, "nothing kept through the symlink");
    v.daemon.stop();
  },

  async "an empty save a sync write displaced is kept, and held once it stays empty"() {
    let clock = Date.now();
    let armed = false;
    const v = await vault({
      now: () => clock,
      disk: {
        step: (at, path) => {
          if (!armed || at !== "temp" || path !== "notes/a.md") return;
          armed = false;
          writeFileSync(join(v.root, path), ""); // the person emptied the file
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    armed = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => (v.read("notes/a.md")?.includes("status: from the site") ?? false) && synced(v, A),
      "the web edit",
    );
    clock += 11 * 60_000; // past the watch
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.daemon.held.has("notes/a.md"), "the empty save to be held");
    ok(
      v.daemon.state.displaced("notes/a.md", clock).some((d) => d.text === ""),
      "the empty version is kept",
    );
    v.daemon.stop();
  },

  async "moving a folder of notes is no mass change"() {
    const v = await vault({}, undefined, 4); // 7 notes, all in notes/
    renameSync(join(v.root, "notes"), join(v.root, "moved"));
    await v.until(() => v.daemon.state.known("moved/a.md") !== undefined, "the move");
    equal(v.daemon.paused(), undefined, "moves change nothing in the record");
    equal(v.record.liveCount(), 7);
    v.daemon.stop();
  },

  async "restore finds a note's versions from before a move"() {
    const v = await vault();
    v.daemon.state.displace("notes/a.md", "from before the move", Date.now(), A);
    mkdirSync(join(v.root, "moved"));
    renameSync(join(v.root, "notes/a.md"), join(v.root, "moved/a.md"));
    await v.until(() => v.daemon.state.known("moved/a.md") !== undefined, "the move");
    equal(restore(v.root, "moved/a.md", Date.now()).length, 1);
    v.daemon.stop();
  },

  async "an editor emptying its open file after the read keeps that empty version"() {
    let clock = Date.now();
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      now: () => clock,
      disk: {
        step: (at, path) => {
          if (!arm || path !== "notes/a.md") return;
          if (at === "temp") fd = openSync(join(v.root, path), "r+");
          if (at === "read" && fd !== undefined) {
            arm = false;
            ftruncateSync(fd, 0); // emptied, through the file it had open
            fsyncSync(fd);
            closeSync(fd);
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => !arm && (v.read("notes/a.md")?.includes("status: from the site") ?? false),
      "the web edit",
    );
    clock += 11 * 60_000;
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.daemon.held.has("notes/a.md"), "the empty save to be held");
    ok(
      v.daemon.state.displaced("notes/a.md", clock).some((d) => d.text === ""),
      "restore has the empty version",
    );
    v.daemon.stop();
  },

  async "with nowhere to keep a displaced file, it stays beside the note and is recovered"() {
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (!arm || path !== "notes/a.md") return;
          if (at === "temp") fd = openSync(join(v.root, path), "r+");
          if (at === "read" && fd !== undefined) {
            arm = false;
            ftruncateSync(fd, 0);
            writeSync(fd, late, 0);
            fsyncSync(fd);
            closeSync(fd);
          }
        },
      },
    });
    const late = `${v.read("notes/a.md")}written as it went\n`;
    rmSync(join(v.root, ".brainiac", "displaced"), { recursive: true, force: true });
    writeFileSync(join(v.root, ".brainiac", "displaced"), "not a folder");
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => !arm && (v.read("notes/a.md")?.includes("status: from the site") ?? false),
      "the web edit",
    );
    v.daemon.stop();
    const again = await open(v.record, v.root); // the leftover beside the note is recovered on start
    await again.until(() => v.record.note(A)?.raw.includes("written as it went") ?? false, "the save");
    again.daemon.stop();
  },

  async "a vault folder deleted while a batch waits pauses instead of crashing"() {
    const v = await vault();
    mkdirSync(join(v.root, "new folder")); // a folder event, queued for the next batch
    rmSync(v.root, { recursive: true, force: true });
    await v.daemon.nextBatch();
    equal(v.record.liveCount(), 3, "nothing deleted in the record");
    ok(v.daemon.paused()?.includes("gone"));
    v.daemon.stop();
  },

  async "a vault folder deleted and made again pauses instead of syncing deletes"() {
    const v = await vault();
    rmSync(v.root, { recursive: true, force: true });
    mkdirSync(v.root); // faster than a batch: the folder exists, but it isn't the vault's any more
    await v.daemon.nextBatch().catch(() => {});
    equal(v.record.liveCount(), 3, "nothing deleted in the record");
    ok(v.daemon.paused()?.includes("gone"));
    v.daemon.stop();
  },

  async "a displaced file left beside the note is no save on the next start"() {
    const v = await vault();
    rmSync(join(v.root, ".brainiac", "displaced"), { recursive: true, force: true });
    writeFileSync(join(v.root, ".brainiac", "displaced"), "not a folder");
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    v.daemon.stop();
    const again = await open(v.record, v.root);
    ok(v.record.note(A)?.raw.includes("status: from the site"), "the web edit is not undone");
    same(
      readdirSync(join(v.root, "notes")).filter((name) => name.startsWith(".~")),
      [],
      "the leftover is cleared",
    );
    again.daemon.stop();
  },

  async "a displaced file the daemon can't read stays for the next start"() {
    const v = await vault();
    chmodSync(join(v.root, "notes/a.md"), 0o000); // the swap still works; reading what it displaced doesn't
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    const written = () => {
      try {
        return v.read("notes/a.md")?.includes("status: from the site") ?? false;
      } catch {
        return false; // still the unreadable one
      }
    };
    await v.until(written, "the web edit");
    const left = readdirSync(join(v.root, "notes")).filter((name) => name.startsWith(".~"));
    // As root (a container) it can be read, and nothing is left; otherwise the displaced file stays.
    ok(left.length <= 1);
    for (const name of left) chmodSync(join(v.root, "notes", name), 0o644);
    v.daemon.stop();
  },

  async "an orphan whose text is already history undoes nothing"() {
    const v = await vault();
    const older = v.read("notes/a.md")!;
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    v.daemon.stop();
    // A crash after the kept file's row committed but before it was removed: its text is in the history.
    mkdirSync(join(v.root, ".brainiac", "displaced"), { recursive: true });
    for (const name of readdirSync(join(v.root, ".brainiac", "displaced"))) {
      rmSync(join(v.root, ".brainiac", "displaced", name));
    }
    writeFileSync(join(v.root, ".brainiac", "displaced", `1-0000abcd-${A}`), older);
    const again = await open(v.record, v.root);
    ok(v.record.note(A)?.raw.includes("status: from the site"), "the web edit stays");
    again.daemon.stop();
  },

  async "an empty leftover is kept as a version and held"() {
    const v = await vault();
    v.daemon.stop();
    writeFileSync(join(v.root, "notes", ".~brainiac-deadbeef-a.md"), "");
    const again = await open(v.record, v.root);
    ok(again.daemon.held.has("notes/a.md"), "held");
    ok(
      again.daemon.state.displaced("notes/a.md", Date.now(), A).some((d) => d.text === ""),
      "kept",
    );
    again.daemon.stop();
  },

  async "withholding a note clears files left beside it"() {
    const v = await vault();
    const raw = v.read("notes/a.md")!;
    writeFileSync(join(v.root, "notes", ".~brainiac-deadbeef-a.md"), raw); // an earlier write's leftover
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    same(
      readdirSync(join(v.root, "notes")).filter((name) => name.includes("a.md")),
      [],
      "nothing of it left",
    );
    v.daemon.stop();
  },

  async "repair refuses a .brainiac folder swapped for a symlink"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, "index.db"), "outside");
    renameSync(join(v.root, ".brainiac"), join(outside, "moved-meta"));
    symlinkSync(outside, join(v.root, ".brainiac"));
    let refused = false;
    await v.daemon.repair().catch(() => (refused = true));
    ok(refused, "refused");
    equal(readFileSync(join(outside, "index.db"), "utf8"), "outside", "untouched");
    v.daemon.stop();
  },

  async "a state.db with a queue but no owner is another machine's"() {
    const v = await vault();
    const oldId = v.daemon.client.state.clientId;
    v.daemon.state.sql.all("DELETE FROM meta WHERE key = 'owner'");
    v.daemon.stop();
    const again = await open(v.record, v.root);
    ok(again.daemon.client.state.clientId !== oldId, "started over");
    again.daemon.stop();
  },

  async "a kept file that can't be read yet is kept until it can"() {
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (arm && at === "temp" && path === "notes/a.md") {
            arm = false;
            fd = openSync(join(v.root, path), "r+");
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    const late = `${v.read("notes/a.md")}late and locked\n`;
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => synced(v, A) && fd !== undefined, "the web edit");
    ftruncateSync(fd!, 0);
    writeSync(fd!, late, 0);
    closeSync(fd!);
    const [name] = readdirSync(join(v.root, ".brainiac", "displaced"));
    chmodSync(join(v.root, ".brainiac", "displaced", name!), 0o000);
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a batch"));
    await v.until(() => v.record.note(B)?.raw.includes("status: a batch") ?? false, "the batch");
    ok(existsSync(join(v.root, ".brainiac", "displaced", name!)), "still kept");
    chmodSync(join(v.root, ".brainiac", "displaced", name!), 0o644);
    v.write("notes/c.md", setField(v.read("notes/c.md")!, "status", "another batch"));
    await v.until(() => v.record.note(A)?.raw.includes("late and locked") ?? false, "the late save");
    v.daemon.stop();
  },

  async "a copied vault keeps a late save from its kept files as history, and sends none"() {
    const v = await vault();
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    const [name] = readdirSync(join(v.root, ".brainiac", "displaced"));
    writeFileSync(join(v.root, ".brainiac", "displaced", name!), "a late save on the other machine\n");
    v.daemon.stop();
    const copy = await open(v.record, v.root, { deviceId: "another laptop" });
    ok(
      copy.daemon.state.displaced("notes/a.md", Date.now(), A).some((d) => d.text.includes("other machine")),
    );
    ok(!v.record.note(A)?.raw.includes("other machine"), "never sent");
    copy.daemon.stop();
  },

  async "withholding judges files left beside a note while its history still says what they are"() {
    const v = await vault();
    rmSync(join(v.root, ".brainiac", "displaced"), { recursive: true, force: true });
    writeFileSync(join(v.root, ".brainiac", "displaced"), "not a folder");
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => v.read("notes/a.md")?.includes("status: from the site") ?? false, "the web edit");
    const raw = v.record.note(A)!.raw;
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a batch"));
    await v.until(() => v.record.note(B)?.raw.includes("status: a batch") ?? false, "a batch");
    ok(v.record.note(A)?.raw.includes("status: from the site"), "the web edit is not undone");
    v.daemon.stop();
  },

  async "a save not yet synced when its note turns sensitive leaves no history"() {
    const v = await vault({ graceMs: 20 });
    const raw = v.read("notes/a.md")!;
    v.write("notes/a.md", `${raw}saved just before\n`); // the batch hasn't taken it yet
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a batch"));
    await v.until(() => v.record.note(A)?.raw.includes("saved just before") ?? false, "the save");
    await v.until(() => v.daemon.state.asides().length === 0, "the brief watch to end");
    same(restore(v.root, "notes/a.md", Date.now()), [], "none of it kept");
    v.daemon.stop();
  },

  async "starting in repair mode ends a pause and does the repair"() {
    const v = await vault();
    v.daemon.state.setPause({ reason: "a test pause", at: Date.now() });
    v.daemon.stop();
    rmSync(join(v.root, "notes/b.md"));
    const again = await open(v.record, v.root, { repair: true });
    equal(again.daemon.paused(), undefined, "not paused");
    ok(again.read("notes/b.md") !== undefined, "the repair wrote the missing file");
    // And it syncs from then on: the index it rebuilt is writable, so a save lands.
    await again.until(() => again.daemon.state.known("notes/a.md") !== undefined, "the files known again");
    again.write("notes/a.md", setField(again.read("notes/a.md")!, "status", "after the repair"));
    await again.until(() => v.record.note(A)?.raw.includes("status: after the repair") ?? false, "the save");
    again.daemon.stop();
  },

  async "withholding keeps an unreadable kept file until its late save can be sent"() {
    let fd: number | undefined;
    let arm = false;
    const v = await vault({
      graceMs: 20,
      disk: {
        step: (at, path) => {
          if (arm && at === "temp" && path === "notes/a.md") {
            arm = false;
            fd = openSync(join(v.root, path), "r+");
          }
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    const late = `${v.read("notes/a.md")}late, then locked\n`;
    arm = true;
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(() => synced(v, A) && fd !== undefined, "the web edit");
    ftruncateSync(fd!, 0);
    writeSync(fd!, late, 0);
    closeSync(fd!);
    const [name] = readdirSync(join(v.root, ".brainiac", "displaced"));
    const kept = join(v.root, ".brainiac", "displaced", name!);
    chmodSync(kept, 0o000);
    const raw = v.record.note(A)!.raw;
    feed(v, { noteId: A, seq: 99, deleted: false, rev: 9, path: "notes/a.md", raw, class: "sensitive" });
    // As root (a container) the file is readable, so the save is sent and the file goes at once.
    if (process.getuid?.() !== 0) ok(existsSync(kept), "not purged while unreadable");
    if (existsSync(kept)) chmodSync(kept, 0o644);
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a batch"));
    await v.until(() => v.record.note(A)?.raw.includes("late, then locked") ?? false, "the late save");
    v.daemon.stop();
  },

  async "a save left in a temp file by a crash is recovered on the next start"() {
    const v = await vault();
    v.daemon.stop();
    const leftover = join(v.root, "notes", ".~brainiac-deadbeef-a.md");
    writeFileSync(leftover, `${v.read("notes/a.md")}saved before the crash\n`);
    const again = await open(v.record, v.root);
    await again.until(
      () => v.record.note(A)?.raw.includes("saved before the crash") ?? false,
      "the recovered save",
    );
    equal(existsSync(leftover), false, "the temp file is gone");
    again.daemon.stop();
  },

  async "a blocked note that becomes sensitive still leaves the device"() {
    const v = await vault();
    v.write("notes/a.md", "---\nid: [\n---\nhalf saved\n");
    await v.until(() => v.daemon.client.state.blocked.has(A), "the refused save");
    const raw = v.record.note(A)!.raw;
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    equal(v.read("notes/a.md"), undefined, "the file is gone");
    equal(v.daemon.state.known("notes/a.md"), undefined);
    v.daemon.stop();
  },

  async "a new note the record refused is created once the file is fixed"() {
    const v = await vault();
    v.record.requireTitles();
    v.write("notes/new.md", "---\ntype: Note\n---\nno title yet\n");
    await v.until(() => /\nid: 01/.test(v.read("notes/new.md") ?? ""), "an id in the file");
    const id = /\nid: (\w+)/.exec(v.read("notes/new.md")!)![1]!;
    await v.until(() => v.daemon.client.state.blocked.has(id), "the refused create");
    v.write("notes/new.md", v.read("notes/new.md")!.replace("type: Note", "type: Note\ntitle: Fixed"));
    await v.until(() => v.record.note(id)?.raw.includes("title: Fixed") ?? false, "the create");
    v.daemon.stop();
  },

  async "remote changes that missed the disk are written on the next start"() {
    const v = await vault({ disk: { exchange: () => "unsupported" } });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "while it couldn't write"));
    await v.until(
      () => v.daemon.client.state.remote.get(A)?.raw.includes("status:") ?? false,
      "it to arrive",
    );
    ok(!v.read("notes/a.md")?.includes("status:"), "not written");
    v.daemon.stop();
    const again = await open(v.record, v.root); // the first sync it waits for is that write
    ok(again.read("notes/a.md")?.includes("status: while it couldn't write"));
    again.daemon.stop();
  },

  async "a file named in another Unicode form still gets web edits"() {
    const v = await vault();
    const nfd = "notes/re\u0301sume\u0301.md";
    v.write(nfd, "---\ntype: Note\ntitle: CV\n---\nfirst\n");
    await v.until(() => v.record.byPath("notes/r\u00e9sum\u00e9.md") !== undefined, "the create");
    const id = v.record.byPath("notes/r\u00e9sum\u00e9.md")!.id;
    const site = v.record.client();
    await v.until(() => site.working(id) !== undefined, "the site to load");
    site.edit(id, setField(site.working(id)!, "status", "from the site"));
    await v.until(() => v.read(nfd)?.includes("status: from the site") ?? false, "the web edit on disk");
    v.daemon.stop();
  },

  async "symlinks and folders named like notes are left alone, and the rest keeps syncing"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    writeFileSync(join(outside, "secret.md"), "---\ntitle: not yours\n---\nsecret\n");
    symlinkSync(join(outside, "secret.md"), join(v.root, "notes/link.md"));
    mkdirSync(join(v.root, "notes/folder.md"));
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "still syncing"));
    await v.until(() => v.record.note(B)?.raw.includes("status: still syncing") ?? false, "the save");
    await v.until(() => v.daemon.held.has("notes/link.md"), "the symlink to be held");
    equal(v.record.byPath("notes/link.md"), undefined, "the symlink's target never reached the record");
    v.daemon.stop();
  },

  async "an editor saving a new file without the id the daemon added keeps the note's id"() {
    const v = await vault();
    const first = "---\ntype: Note\ntitle: New\n---\nfirst\n";
    v.write("notes/new.md", first);
    await v.until(() => /\nid: 01/.test(v.read("notes/new.md") ?? ""), "an id in the file");
    const id = /\nid: (\w+)/.exec(v.read("notes/new.md")!)![1]!;
    await v.until(() => v.record.note(id) !== undefined, "the create");
    v.write("notes/new.md", `${first}second\n`); // the editor's buffer from before the id
    await v.until(() => v.record.note(id)?.raw.includes("second") ?? false, "the save");
    equal(v.daemon.client.state.blocked.has(id), false);
    await v.until(() => v.read("notes/new.md")?.includes(`id: ${id}`) ?? false, "the id back in the file");
    v.daemon.stop();
  },

  async "a note moved on disk stays searchable"() {
    const v = await vault();
    mkdirSync(join(v.root, "moved"));
    renameSync(join(v.root, "notes/a.md"), join(v.root, "moved/a.md"));
    await v.until(() => v.daemon.state.known("moved/a.md") !== undefined, "the move");
    equal(v.daemon.paused(), undefined, "a move is one note, not a mass change");
    const { index } = openIndex(join(v.root, ".brainiac", "index.db"));
    equal(search(index.sql, PERSON, "start").length, 3);
    index.close();
    equal(v.record.note(A)?.deletedAt, null, "not deleted in the record");
    v.daemon.stop();
  },

  async "one daemon per vault, reachable even after its vault folder is deleted"() {
    const config = folder("brainiac-config-");
    const root = folder("brainiac-vault-");
    const unlock = lockVault(config, root);
    throws(() => lockVault(config, root), /Another brainiac daemon/);
    rmSync(root, { recursive: true, force: true });
    process.once("SIGUSR2", () => {}); // this process stands in for the daemon
    ok(request(config, root, "repair"), "the request reaches it");
    equal(takeRequest(config, root), "repair");
    unlock();
    equal(request(config, root, "resume"), false, "no daemon once it stops");
  },

  async "the daemon reaches the record over a real socket with its token, and reconnects"() {
    const record = new TestRecord();
    record.seed(A, "notes/a.md");
    const sockets = new Set<Bun.ServerWebSocket<unknown>>();
    let token: string | null = null;
    const start = (port: number) =>
      Bun.serve({
        port,
        fetch(incoming, server) {
          token = incoming.headers.get("authorization");
          return server.upgrade(incoming) ? undefined : new Response("not a socket", { status: 400 });
        },
        websocket: {
          open: (socket) => void sockets.add(socket),
          close: (socket) => void sockets.delete(socket),
          message(socket, data) {
            const message = decodeClientMessage(String(data));
            if ("error" in message) return;
            const { replies, push } = serve(
              record.sql,
              message,
              { actor: "laptop", now: Date.now() },
              PERSON,
            );
            for (const reply of replies) socket.send(JSON.stringify(reply));
            if (push) for (const other of sockets) other.send(JSON.stringify(push(PERSON)));
          },
        },
      });
    let server = start(0);
    const port = server.port!;
    const root = folder("brainiac-vault-");
    const daemon = await Daemon.start({
      root,
      deviceId: "laptop",
      connect: socketLink(`http://localhost:${port}`, "the token"),
      debounceMs: 20,
    });
    const until = async (done: () => boolean, what: string) => {
      for (let events = 0; !done(); events++) {
        if (events > 2_000) throw new Error(`never happened: ${what}`);
        await Promise.race([
          daemon.nextBatch(),
          new Promise<void>((resolve) => {
            const stop = daemon.client.subscribe(() => {
              stop();
              resolve();
            });
          }),
        ]);
      }
    };
    const file = join(root, "notes/a.md");
    await until(
      () => existsSync(file) && readFileSync(file, "utf8") === record.note(A)?.raw,
      "the first sync",
    );
    equal(token, "Bearer the token");

    void server.stop(true); // the network drops
    await until(() => daemon.client.state.cursor !== null && sockets.size === 0, "the drop");
    server = start(port);
    writeFileSync(file, setField(readFileSync(file, "utf8"), "status", "after the drop"));
    await until(
      () => record.note(A)?.raw.includes("status: after the drop") ?? false,
      "the save over the new socket",
    );
    daemon.stop();
    void server.stop(true);
  },

  async "the record's paths never leave the vault or reach hidden files"() {
    const v = await vault();
    const outside = folder("brainiac-outside-");
    symlinkSync(outside, join(v.root, "linked"));
    // Unique per run: a write that escaped must not be mistaken for one from an earlier run.
    const escape = `escape-${crypto.randomUUID()}.md`;
    feed(
      v,
      fed("01M6EVIL00000000000000000A", `../${escape}`),
      fed("01M6EVIL00000000000000000B", `linked/${escape}`),
      fed("01M6EVIL00000000000000000E", "notes/nul\u0000.md"),
      fed("01M6EVIL00000000000000000C", ".brainiac/state.md"),
      fed("01M6EVIL00000000000000000D", "notes/fine.md"),
    );
    equal(existsSync(join(v.root, "..", escape)), false);
    equal(existsSync(join(outside, escape)), false);
    equal(existsSync(join(v.root, ".brainiac", "state.md")), false);
    ok(v.read("notes/fine.md")?.includes("hostile"), "a plain path is still written");
    v.daemon.stop();
  },

  // Through the record's own projected feed, as a connection without the sensitive scope gets it: the note
  // comes as withheld, with no class to go on, and still leaves with its history, even while paused.
  async "a note withheld from this connection leaves the device, history and all, even while paused"() {
    const record = new TestRecord({ sensitive: false });
    record.seed(A, "notes/a.md", "CANARY-7Q3X\n");
    record.seed(B, "notes/b.md");
    record.seed(C, "notes/c.md");
    const v = await open(record, folder("brainiac-vault-"), { graceMs: 20 });
    v.daemon.state.displace("notes/a.md", "an older CANARY-7Q3X", Date.now(), A);
    v.daemon.state.setPause({ reason: "a test pause", at: Date.now() });
    record.classify(A, "sensitive");
    await v.until(() => v.read("notes/a.md") === undefined, "the file to go");
    ok(v.daemon.client.withheld(A));
    // Its history is gone at once; only the file just removed is watched briefly for an editor still writing.
    const kept = v.daemon.state.displaced("notes/a.md", Date.now(), A).map((version) => version.text);
    ok(!kept.some((text) => text.includes("an older")), JSON.stringify(kept));
    ok(kept.length <= 1, JSON.stringify(kept));
    const { index } = openIndex(join(v.root, ".brainiac", "index.db"));
    same(search(index.sql, PERSON, "CANARY-7Q3X"), [], "out of the local index");
    index.close();
    await v.daemon.resume();
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.daemon.state.asides().length === 0, "the brief watch to end");
    same(restore(v.root, "notes/a.md", Date.now()), [], "no versions left");
    same(v.daemon.state.displaced("notes/a.md", Date.now(), A), []);
    v.daemon.stop();
  },

  async "a note that becomes sensitive leaves the device: file, index and displaced versions"() {
    const v = await vault({ graceMs: 20 });
    const raw = v.read("notes/a.md")!;
    v.daemon.state.displace("notes/a.md", "an older version", Date.now());
    // A version still kept aside for late writes goes with it.
    mkdirSync(join(v.root, ".brainiac", "displaced"), { recursive: true });
    writeFileSync(join(v.root, ".brainiac", "displaced", `1-0000abcd-${A}`), "kept aside");
    v.daemon.state.displace("notes/a.md", "kept aside", Date.now(), A, `1-0000abcd-${A}`);
    feed(v, { noteId: A, seq: 9, deleted: false, rev: 2, path: "notes/a.md", raw, class: "sensitive" });
    equal(v.read("notes/a.md"), undefined, "the file is gone");
    // The file it just removed is watched briefly for an editor still writing; then nothing is left.
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "a later batch"));
    await v.until(() => v.daemon.state.asides().length === 0, "the brief watch to end");
    same(restore(v.root, "notes/a.md", Date.now()), [], "no displaced versions left");
    equal(
      existsSync(join(v.root, ".brainiac", "displaced", `1-0000abcd-${A}`)),
      false,
      "the kept file is gone",
    );
    const { index } = openIndex(join(v.root, ".brainiac", "index.db"));
    equal(search(index.sql, PERSON, "start").length, 2, "only B and C are searchable");
    index.close();
    v.daemon.stop();
  },

  async "a web edit reaches the file, and the daemon's own write is not sent back"() {
    const v = await vault();
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => v.read("notes/a.md")?.includes("status: from the site") ?? false,
      "the file to change",
    );
    await v.until(() => synced(v, A), "the echo to settle");
    // Seed and the site's edit: the write coming back from disk changed nothing.
    equal(revisions(v, A).length, 2);
    v.daemon.stop();
  },

  async "a save reaches the record"() {
    const v = await vault();
    v.write("notes/b.md", setField(v.read("notes/b.md")!, "status", "saved"));
    await v.until(() => v.record.note(B)?.raw.includes("status: saved") ?? false, "the save to land");
    await v.until(() => synced(v, B), "settled");
    v.daemon.stop();
  },

  async "a new file gets an id and is created; a file that doesn't parse waits until fixed"() {
    const v = await vault();
    v.write("notes/new.md", "---\ntype: Note\ntitle: New\n---\nhello\n");
    await v.until(() => /\nid: 01/.test(v.read("notes/new.md") ?? ""), "an id in the file");
    const id = /\nid: (\w+)/.exec(v.read("notes/new.md")!)![1]!;
    await v.until(() => v.record.note(id)?.path === "notes/new.md", "the note to be created");
    v.write("notes/broken.md", "---\ntitle: [\n---\n");
    await v.until(() => v.daemon.held.has("notes/broken.md"), "the broken file to be held");
    v.write("notes/broken.md", "---\ntype: Note\ntitle: Fixed\n---\n");
    await v.until(
      () => !v.daemon.held.has("notes/broken.md") && v.daemon.state.known("notes/broken.md") !== undefined,
      "the fix",
    );
    v.daemon.stop();
  },

  async "no swap call: an existing file is never replaced, and saves still sync"() {
    const v = await vault({ disk: { exchange: () => "unsupported" } });
    const before = v.read("notes/a.md");
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "remote"));
    await v.until(() => v.record.note(A)?.raw.includes("status: remote") ?? false, "the remote edit");
    await v.until(
      () => v.daemon.client.state.remote.get(A)?.raw.includes("status: remote") ?? false,
      "it to arrive",
    );
    equal(v.read("notes/a.md"), before, "the file stays as it was");
    v.write("notes/a.md", setField(before!, "title", "local"));
    await v.until(() => v.record.note(A)?.raw.includes("title: local") ?? false, "the local save");
    ok(v.record.note(A)?.raw.includes("status: remote"), "merged with the remote edit");
    v.daemon.stop();
  },

  async "versions a write displaced are kept for 7 days, and restore brings one back"() {
    let armed = false;
    const local = { text: "" };
    const v = await vault({
      disk: {
        step: (step, path) => {
          if (!armed || step !== "temp" || path !== "notes/a.md") return;
          armed = false;
          writeFileSync(join(v.root, path), local.text);
        },
      },
    });
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    local.text = `${v.read("notes/a.md")}kept line\n`;
    armed = true;
    site.edit(A, setField(site.working(A)!, "status", "remote"));
    await v.until(() => synced(v, A) && (v.read("notes/a.md")?.includes("kept line") ?? false), "the merge");
    const now = Date.now();
    const listed = restore(v.root, "notes/a.md", now);
    ok(listed.length >= 1, "a displaced version is listed");
    same(restore(v.root, "notes/a.md", now + DISPLACED_MS + 1), [], "gone after 7 days");
    const oldest = listed.length;
    restore(v.root, "notes/a.md", now, oldest);
    await v.until(() => synced(v, A), "the restored version to sync");
    v.daemon.stop();
  },

  async "deleting the vault folder pauses instead of syncing deletes, and repair brings it back"() {
    const v = await vault();
    rmSync(v.root, { recursive: true, force: true });
    await v.until(() => v.daemon.paused() !== undefined, "the pause");
    equal(v.record.liveCount(), 3, "nothing was deleted in the record");
    await v.daemon.repair();
    await v.until(() => synced(v, A) && synced(v, B) && synced(v, C), "the files to come back");
    equal(v.record.liveCount(), 3);
    v.daemon.stop();
  },

  async "a mass change pauses; resume --undo puts the record's versions back, resume syncs them"() {
    const v = await vault({}, undefined, 4); // 7 notes, so 5 deleted at once is a mass change
    const gone = ["notes/a.md", "notes/b.md", "notes/c.md", "notes/x0.md", "notes/x1.md"];
    for (const path of gone) rmSync(join(v.root, path));
    v.write("notes/new.md", "---\ntype: Note\ntitle: New\n---\nmade in the same change\n");
    await v.until(() => v.daemon.paused() !== undefined, "the pause");
    equal(v.record.liveCount(), 7);
    await v.daemon.resume({ undo: true });
    await v.until(() => v.record.byPath("notes/new.md") !== undefined, "the new file to sync after the undo");
    await v.until(
      () => gone.every((path) => v.read(path) !== undefined) && synced(v, A),
      "the files to come back",
    );
    for (const path of gone) rmSync(join(v.root, path));
    await v.until(() => v.daemon.paused() !== undefined, "the second pause");
    await v.daemon.resume();
    await v.until(() => v.record.liveCount() === 3, "the deletes to sync"); // x2, x3 and the new note
    v.daemon.stop();
  },

  async "a corrupt index.db is rebuilt from the files"() {
    const v = await vault();
    v.daemon.stop();
    writeFileSync(join(v.root, ".brainiac", "index.db"), "not a database");
    rmSync(join(v.root, ".brainiac", "index.db-wal"), { force: true });
    rmSync(join(v.root, ".brainiac", "index.db-shm"), { force: true });
    const again = await open(v.record, v.root);
    // The index is private to the daemon; read it the way local search will.
    const { index } = openIndex(join(v.root, ".brainiac", "index.db"));
    equal(search(index.sql, PERSON, "start").length, 3);
    index.close();
    again.daemon.stop();
    // Deleted outright, it is rebuilt the same way.
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(join(v.root, ".brainiac", `index.db${suffix}`), { force: true });
    const third = await open(v.record, v.root);
    const rebuilt = openIndex(join(v.root, ".brainiac", "index.db")).index;
    equal(search(rebuilt.sql, PERSON, "start").length, 3);
    rebuilt.close();
    third.daemon.stop();
  },

  async "a vault copied to another machine never replays the copied queue or kept files"() {
    const v = await vault();
    // A sync write leaves a kept file behind for a while: the copy carries it.
    const site = v.record.client();
    await v.until(() => site.working(A) !== undefined, "the site to load");
    site.edit(A, setField(site.working(A)!, "status", "from the site"));
    await v.until(
      () => (v.read("notes/a.md")?.includes("status: from the site") ?? false) && synced(v, A),
      "the web edit",
    );
    ok(readdirSync(join(v.root, ".brainiac", "displaced")).length > 0, "a kept file is there");
    const oldId = v.daemon.client.state.clientId;
    v.daemon.stop();
    const copy = await open(v.record, v.root, { deviceId: "another laptop" });
    ok(copy.daemon.client.state.clientId !== oldId, "a new client id");
    equal(revisions(copy, A).length, 2, "nothing replayed");
    same(readdirSync(join(v.root, ".brainiac", "displaced")), [], "the other machine's kept files are gone");
    copy.daemon.stop();
  },
};

for (const [name, save] of Object.entries(SAVES)) {
  for (const step of STEPS) {
    cases[`an editor saving ${name} at "${step}" loses nothing`] = async () => {
      let armed = false;
      const local = { text: "" };
      const v = await vault({
        disk: {
          step: (at, path) => {
            if (!armed || at !== step || path !== "notes/a.md") return;
            armed = false;
            save(join(v.root, path), local.text);
          },
        },
      });
      const site = v.record.client();
      await v.until(() => site.working(A) !== undefined, "the site to load");
      // The editor has the file as it was before the web edit, plus a line of its own.
      local.text = `${v.read("notes/a.md")}line from the editor\n`;
      armed = true;
      site.edit(A, setField(site.working(A)!, "status", "from the site"));
      await v.until(
        () => !armed && synced(v, A) && (v.record.note(A)?.raw.includes("line from the editor") ?? false),
        "the editor's save to reach the record",
      );
      // Both edits are in the record's history; an editor saving a stale buffer may undo the other on purpose.
      ok(
        revisions(v, A).some((raw) => raw.includes("status: from the site")),
        "the web edit is kept",
      );
      if (step === "temp")
        ok(v.record.note(A)?.raw.includes("status: from the site"), "displaced, so merged");
      v.daemon.stop();
    };
  }
}

cases["a third save racing the second's way back onto disk is the one that syncs"] = async () => {
  let saves = 0;
  const v = await vault({
    disk: {
      step: (at, path) => {
        if (at !== "temp" || path !== "notes/new.md" || saves >= 2) return;
        saves++;
        writeFileSync(join(v.root, path), `---\ntype: Note\ntitle: New\n---\nsave ${saves + 1}\n`);
      },
    },
  });
  v.write("notes/new.md", "---\ntype: Note\ntitle: New\n---\nsave 1\n");
  await v.until(() => v.record.byPath("notes/new.md")?.raw.includes("save 3") ?? false, "the newest save");
  v.daemon.stop();
};

for (const [name, save] of Object.entries(SAVES)) {
  cases[`a save racing the id written into a new file (${name}) is kept`] = async () => {
    let armed = false;
    const v = await vault({
      disk: {
        step: (at, path) => {
          if (!armed || at !== "temp" || path !== "notes/new.md") return;
          armed = false;
          save(join(v.root, path), "---\ntype: Note\ntitle: New\n---\nsecond save\n");
        },
      },
    });
    armed = true;
    v.write("notes/new.md", "---\ntype: Note\ntitle: New\n---\nfirst save\n");
    await v.until(
      () => (v.record.byPath("notes/new.md")?.raw.includes("second save") ?? false) && !armed,
      "the second save to be created",
    );
    v.daemon.stop();
  };
  for (const step of ["swapped", "read"] as const) {
    cases[`an editor saving ${name} while a web delete removes the file at "${step}" brings the note back`] =
      async () => {
        let armed = false;
        const local = { text: "" };
        const v = await vault({
          disk: {
            step: (at, path) => {
              if (!armed || at !== step || path !== "notes/a.md") return;
              armed = false;
              save(join(v.root, path), local.text);
            },
          },
        });
        const site = v.record.client();
        await v.until(() => site.working(A) !== undefined, "the site to load");
        local.text = `${v.read("notes/a.md")}line from the editor\n`;
        armed = true;
        site.delete(A);
        await v.until(
          () =>
            !armed &&
            v.record.note(A)?.deletedAt === null &&
            (v.record.note(A)?.raw.includes("line from the editor") ?? false),
          "the save to bring the note back",
        );
        v.daemon.stop();
      };
  }
}

export { cases };

export async function runCase(name: string): Promise<CaseResult> {
  try {
    await cases[name]!();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
}
