// The world every eval runs in: the fictional fixture student's record (fixtures/README.md) on node:sqlite in
// packages/base, and its `/mcp` on a local port, served by the Worker's own tool server, so every Brainiac tool
// returns a real result and no model plays the server.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  authenticate,
  BACKGROUND_HEADER,
  callTool,
  chunkNote,
  connect,
  grant,
  listNotes,
  migrate,
  mintToken,
  mutate,
  putChunks,
  recordApproval,
  type Answer,
  type Level,
  type Sql,
} from "../../packages/base/src/index.ts";
import { serveTools } from "../../packages/base/src/mcp.ts";
import { nodeSql } from "../../packages/base/src/node.ts";

export const ROOT = join(import.meta.dirname, "../..");
export const FIXTURES = join(ROOT, "fixtures/nadia");
/** The agent skill the plugin loads (#18), as every eval hands it to the model. */
export const SKILL = readFileSync(join(ROOT, "apps/cli/plugin/skills/brainiac/SKILL.md"), "utf8");
const BASE_ID = "e0a1";

/** The person, as the fixture was made: changes from them apply, the verified ones with their passkey. */
export const PERSON = { actor: "human", now: Date.now() };

let signatures = 0;
/** A passkey signature from the person, for what the record asks them to approve. */
export const signature = () => ({
  credentialId: "eval",
  counter: ++signatures,
  assertion: `{"n":${signatures}}`,
});

/**
 * A new in-memory record holding the fixture student's notes as the person made them, test scores sensitive,
 * indexed as a laptop's copy is (keyword only: no model embeds here). Returns note ids by path.
 */
export function fixtureRecord() {
  const sql = nodeSql(new DatabaseSync(":memory:"));
  migrate(sql);
  sql.all(
    "INSERT INTO schema (version, manifest) VALUES (1, ?)",
    readFileSync(join(FIXTURES, "okf-base.yaml"), "utf8"),
  );
  const ids: Record<string, string> = {};
  for (const path of readdirSync(FIXTURES, { recursive: true, encoding: "utf8" }).filter((p) =>
    p.endsWith(".md"),
  )) {
    const mutation = {
      op: "create",
      path,
      raw: readFileSync(join(FIXTURES, path), "utf8"),
      class: path.startsWith("facts/tests/") ? "sensitive" : "normal",
    } as const;
    let result = mutate(sql, mutation, PERSON);
    // The November score arrives verified, which takes the person's passkey.
    if (result.status === "needsApproval") {
      const approved = recordApproval(sql, result.items, signature(), PERSON.now);
      if (!("approvalId" in approved))
        throw new Error(`fixture approval failed: ${JSON.stringify(approved)}`);
      result = mutate(sql, mutation, { ...PERSON, approvalId: approved.approvalId });
    }
    if (result.status !== "applied") throw new Error(`${path}: ${JSON.stringify(result)}`);
    ids[path] = result.noteId;
  }
  for (const note of listNotes(sql)) putChunks(sql, note.id, note.rev, chunkNote(note));
  return { sql, ids };
}

/** A device connection the person granted `level` (and the sensitive scope when asked), with its `/mcp` token. */
export function connection(sql: Sql, level: Level, sensitive: boolean) {
  const floor = connect(sql, { kind: "cli" }, PERSON.now);
  const granted = grant(
    sql,
    { connectionId: floor.id, rev: floor.rev, level, sensitive, holdDays: 0 },
    signature(),
  );
  if (!("connection" in granted)) throw new Error(granted.error);
  return { connection: granted.connection, token: mintToken(sql, BASE_ID, floor.id, PERSON.now) };
}

/** Adds an inbox item as the person, returning its note id. */
export function addItem(sql: Sql, text: string, sensitive = false) {
  const added = callTool(sql, "add", { text, sensitive }, PERSON);
  if (!added.ok) throw new Error(added.error);
  return String((added.value as { id: string }).id);
}

/** A photo's bytes, by sha256, as R2 would hold them. */
export type Photos = ReadonlyMap<string, { readonly bytes: Buffer; readonly mime: string }>;

/**
 * This record's `/mcp` on a local port, answering as the Worker does: as the token's connection, narrowed when a
 * request comes through the daemon's background bridge, with the photo a `photos` answer names attached from
 * `photos`, as the record attaches it from R2. `background()` says whether every request came through the bridge,
 * and `handed()` which photos went to the agent.
 */
export async function serve(sql: Sql, photos: Photos = new Map()) {
  let background = true;
  const handed: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(key, value);
    const caller = authenticate(sql, headers.get("authorization")?.replace(/^Bearer /, "") ?? "", Date.now());
    if (!caller) return void res.writeHead(401).end();
    const behind = headers.get(BACKGROUND_HEADER) === "1";
    background &&= behind;
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? "POST",
      headers,
      ...(req.method === "POST" && { body: Buffer.concat(chunks) }),
    });
    const response = await serveTools(request, async (name, args): Promise<Answer> => {
      const answer = callTool(sql, name, args, {
        actor: `connection:${caller.id}`,
        connection: caller,
        now: Date.now(),
        ...(behind && { background: true }),
      });
      if (!answer.ok || answer.attach === undefined) return answer;
      const { attach, ...rest } = answer;
      const photo = photos.get(attach.sha256);
      if (!photo) return { ok: false, error: "That photo is gone." };
      handed.push(attach.sha256);
      return { ...rest, image: { data: photo.bytes.toString("base64"), mimeType: photo.mime } };
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    background: () => background,
    handed: () => [...handed],
    close: () => server.close(),
  };
}
