// The site's own routes beside `/sync`: who is signed in, the record's manifest, and its files. Each one finds the
// record from the session (through the registry), calls one method on it and maps the answer; none takes a base id
// from the request. A file's bytes never come from here: only a single-use token for the usercontent origin.
import type { FileToken } from "@brainiac/base";

import type { Env } from "./env.ts";
import { isUsercontent, serveUsercontent } from "./usercontent.ts";

/**
 * The signed-in person and their record, from the session and the registry; `undefined` when nobody is. With
 * `passkey`, the session is read fresh from Neon and `passkey` says whether it proved a passkey that can approve in
 * the last 10 minutes (`vouchedUntil`), which an unclassified or vault file's original needs (contract §5).
 */
export type Session = (opts?: { readonly passkey?: boolean }) => Promise<
  | {
      readonly userId: string;
      readonly baseId: string;
      readonly passkey: boolean;
    }
  | undefined
>;

/** The largest upload the site takes. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const SHA = /^[0-9a-f]{64}$/;
const MIME = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/;
const PERSON = { actor: "human" } as const;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const failed = (status: number, error: string) => json({ error }, status);

/**
 * A browser sends the session cookie with any request to this site, including one a page on the usercontent
 * origin makes: only this origin's own pages may change anything.
 */
const sameOrigin = (request: Request) => request.headers.get("origin") === new URL(request.url).origin;

/**
 * The routes for files and the site's data, or `undefined` for a request that isn't one. The usercontent origin
 * answers here and nowhere else; the main origin never serves a file's bytes, so `/f/` is a 404 on it.
 */
export function routeSite(
  request: Request,
  env: Pick<Env, "BASE" | "USERCONTENT_ORIGIN">,
  session: Session,
): Promise<Response> | undefined {
  if (isUsercontent(request, env)) return serveUsercontent(request, env);
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/f/")) return Promise.resolve(failed(404, "Not found"));
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/auth/")) return undefined;
  return serveApi(request, env, session, pathname);
}

async function serveApi(
  request: Request,
  env: Pick<Env, "BASE" | "USERCONTENT_ORIGIN">,
  session: Session,
  pathname: string,
): Promise<Response> {
  const post = request.method === "POST";
  if (post ? !sameOrigin(request) : request.method !== "GET") return failed(403, "Forbidden");
  const file = /^\/api\/files\/([^/]+)\/(token|kind)$/.exec(pathname);
  const token = post && file?.[2] === "token";
  const person = await session({ passkey: token });
  if (!person) return failed(401, "Sign in first.");
  const record = env.BASE.get(env.BASE.idFromString(person.baseId));

  if (pathname === "/api/session" && !post) return json({ user: person.userId });
  if (pathname === "/api/schema" && !post) return json({ manifest: await record.manifest() });
  if (pathname === "/api/files") {
    if (!post) {
      const files = await record.files(PERSON);
      return "status" in files ? refusal(files) : json({ files });
    }
    const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return tooLarge();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge();
    if (bytes.byteLength === 0) return failed(400, "That file is empty.");
    const uploaded = await record.upload(
      bytes,
      { mime: MIME.test(mime) ? mime : "application/octet-stream" },
      PERSON,
    );
    if ("status" in uploaded || "error" in uploaded) return refusal(uploaded);
    // The RPC stub's mapped type drops the success arm (its MutationResult holds `unknown` values), so it's read
    // as a plain object here.
    const answer: object = uploaded;
    return json({ file: "file" in answer ? answer.file : undefined });
  }
  const sha256 = file?.[1];
  if (!post || !file || sha256 === undefined || !SHA.test(sha256)) return failed(404, "Not found");
  if (file[2] === "kind") {
    const body: unknown = await request.json().catch(() => null);
    const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : undefined;
    if (typeof kind !== "string") return failed(400, "Say what the file is, like transcript.");
    const classified = await record.classifyFile(sha256, kind, PERSON);
    // Loosening a kind the person confirmed needs a passkey signature over `challenge` (contract §4).
    if ("status" in classified && classified.status === "needsApproval")
      return json({ needsApproval: true }, 409);
    if ("status" in classified) return refusal(classified);
    return "error" in classified ? refusal(classified) : json({ file: classified.file });
  }
  if (!env.USERCONTENT_ORIGIN)
    return failed(503, "This stage has no usercontent domain, so it can't show files.");
  const minted: FileToken = await record.fileToken(sha256, PERSON, {
    origin: new URL(request.url).origin,
    passkey: person.passkey,
  });
  if ("status" in minted && minted.status === "needsPasskey") return json({ needsPasskey: true }, 403);
  if ("status" in minted) return refusal(minted);
  if ("error" in minted) return refusal(minted);
  return json({ url: `${env.USERCONTENT_ORIGIN}/f/${minted.token}`, expiresAt: minted.expiresAt });
}

const tooLarge = () => failed(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

type Refusal = { readonly status: "forbidden"; readonly reason: string } | { readonly error: string };

const refusal = (result: Refusal) =>
  "status" in result ? failed(403, result.reason) : failed(400, result.error);
