// The site's own routes beside `/sync`: who is signed in, the record's manifest, its files, its secrets and the
// fills agents asked for, the person's passkey approvals, and whether the weekly questions email goes out. Each one finds the
// record from the session (through the registry), calls one method on it and maps the answer; none takes a base id
// from the request. A file's bytes never come from here: only a single-use token for the usercontent origin.
import type { FileToken } from "@brainiac/base";
import type { PlanItem } from "@brainiac/core";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import type { Approver } from "./approvals.ts";
import type { Env } from "./env.ts";
import { isUsercontent, serveUsercontent } from "./usercontent.ts";

/**
 * The signed-in person and their record, from the session and the registry; `undefined` when nobody is. With
 * `passkey`, the session is read fresh from Neon and `passkey` says whether it proved a passkey that can approve in
 * the last 10 minutes (`vouchedUntil`), which an unclassified or vault file's original needs (contract §5). With
 * `approver` (a credential id from a signature), `approver` is that passkey as Neon holds it, if it is one of the
 * signed-in person's own: never a key or counter from the request.
 */
export type Session = (opts?: { readonly passkey?: boolean; readonly approver?: string }) => Promise<
  | {
      readonly userId: string;
      readonly baseId: string;
      readonly passkey: boolean;
      readonly approver?: Approver;
    }
  | undefined
>;

/** The largest upload the site takes. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const SHA = /^[0-9a-f]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The most items one review session may cover. */
const REVIEW_ITEMS = 200;
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
  // Every POST but an upload is JSON.
  const body: unknown = post && pathname !== "/api/files" ? await request.json().catch(() => null) : null;
  // Opening a review, or saving or filling a secret: the passkey that signed, as Neon holds it for this person.
  const signed = pathname === "/api/review/open" && post ? signatureOf(body) : undefined;
  const signer = post ? passkeyAnswer(body) : undefined;
  const person = await session({ passkey: token, ...(signer && { approver: signer.id }) });
  if (!person) return failed(401, "Sign in first.");
  const record = env.BASE.get(env.BASE.idFromString(person.baseId));

  if (pathname === "/api/session" && !post) return json({ user: person.userId });
  if (pathname === "/api/schema" && !post) return json({ manifest: await record.manifest() });
  // The weekly email of questions: on unless the person turns it off.
  if (pathname === "/api/questions/email") {
    if (!post) return json({ on: await record.questionEmails() });
    const on = typeof body === "object" && body !== null && "on" in body ? body.on : undefined;
    if (typeof on !== "boolean") return failed(400, "Say whether the weekly email is on.");
    return json({ on: await record.questionEmails(on) });
  }
  // Drift checks of the person's own profiles: paid, so only the signed-in person starts one.
  if (pathname === "/api/profiles/check" && post) return json(await record.checkProfiles());
  const note = /^\/api\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(pathname)?.[1];
  if (note !== undefined && post) return saveNote(body, record, note);
  if (pathname === "/api/review" && post) {
    const ids = typeof body === "object" && body !== null && "noteIds" in body ? body.noteIds : undefined;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > REVIEW_ITEMS ||
      !ids.every((id) => ULID.test(id))
    )
      return failed(400, `Send the ids of the notes to review, up to ${REVIEW_ITEMS}.`);
    return json({ nonce: await record.startReview(ids, PERSON) });
  }
  // The person signed a plan a change came back `needsApproval` with: the change cites the approval once.
  if (pathname === "/api/approve" && post) {
    const items = field(body, "items");
    if (!signer || !Array.isArray(items) || items.length === 0 || items.length > REVIEW_ITEMS)
      return failed(400, "Send the plan's items and your passkey's answer over its hash.");
    if (!person.approver) return failed(403, "That passkey isn't one of yours.");
    // The record hashes these items itself: a signature over any other plan doesn't check out.
    const plan: PlanItem[] = items;
    const approved = await record.approve(plan, signer, person.approver);
    return "error" in approved ? failed(403, approved.error) : json({ approvalId: approved.approvalId });
  }
  if (pathname === "/api/review/open" && post) {
    if (!signed) return failed(400, "Send the review's nonce and your passkey's answer.");
    if (!person.approver) return failed(403, "That passkey isn't one of yours.");
    const opened = await record.openReview(signed.nonce, signed.response, person.approver, PERSON);
    return "error" in opened ? failed(403, opened.error) : json({ review: opened.review });
  }
  if (pathname === "/api/secrets" || pathname.startsWith("/api/fills"))
    return serveSecrets(request, body, record, person.approver);
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
    const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : undefined;
    if (typeof kind !== "string") return failed(400, "Say what the file is, like transcript.");
    if (signer && !person.approver) return failed(403, "That passkey isn't one of yours.");
    const classified = await record.classifyFile(
      sha256,
      kind,
      PERSON,
      signer && person.approver && { response: signer, approver: person.approver },
    );
    // Loosening a kind the person confirmed needs a passkey signature over `challenge` (contract §4).
    if ("status" in classified && classified.status === "needsApproval")
      return json({ needsApproval: true, challenge: classified.challenge }, 409);
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

/** The passkey's answer in a request body (`response`), if there is one; its shape only, the DO checks the rest. */
function passkeyAnswer(body: unknown): AuthenticationResponseJSON | undefined {
  if (typeof body !== "object" || body === null || !("response" in body)) return undefined;
  const { response } = body;
  if (typeof response !== "object" || response === null) return undefined;
  if (!("id" in response) || typeof response.id !== "string") return undefined;
  // SimpleWebAuthn checks every other part of the response against the passkey and the challenge.
  return response as AuthenticationResponseJSON;
}

/** A review's nonce and the passkey's answer over it, from a request body. */
function signatureOf(body: unknown) {
  const response = passkeyAnswer(body);
  if (!response || typeof body !== "object" || body === null || !("nonce" in body)) return undefined;
  return typeof body.nonce === "string" ? { nonce: body.nonce, response } : undefined;
}

const field = (body: unknown, key: string): unknown =>
  typeof body === "object" && body !== null ? Object.entries(body).find(([k]) => k === key)?.[1] : undefined;

/**
 * The person's secrets and the fills their agents asked for (secrets.ts), for the site and the browser extension.
 * `GET /api/secrets` lists names, domains and policies, never values; `POST /api/secrets` saves one
 * (`{ name, value?, domain?, policy?, response? }`); `POST /api/secrets` with `forget: true` removes it.
 * `GET /api/fills?url=` lists the fills waiting for that page; `POST /api/fills/<id>` (`{ url, response? }`) is the
 * person pressing Fill there, and answers each field's value; `POST /api/fills/<id>/dismiss` turns one down. A
 * change that needs the person's passkey answers 409 with the challenge to sign.
 */
async function serveSecrets(
  request: Request,
  body: unknown,
  record: ReturnType<Env["BASE"]["get"]>,
  approver: Approver | undefined,
): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const post = request.method === "POST";
  const response = passkeyAnswer(body);
  if (response && !approver) return failed(403, "That passkey isn't one of yours.");
  const signed = response && approver && { response, approver };
  if (pathname === "/api/secrets") {
    if (!post) {
      const secrets = await record.secrets(PERSON);
      return "status" in secrets ? refusal(secrets) : json({ secrets });
    }
    const name = field(body, "name");
    if (typeof name !== "string") return failed(400, "Name the secret, like portal.tum.");
    if (field(body, "forget") === true) {
      const forgot = await record.forgetSecret(name, PERSON);
      return "status" in forgot ? refusal(forgot) : json(forgot);
    }
    const value = field(body, "value");
    const domain = field(body, "domain");
    const policy = field(body, "policy");
    if (value !== undefined && typeof value !== "string") return failed(400, "value is text.");
    if (domain !== undefined && domain !== null && typeof domain !== "string")
      return failed(400, "domain is a host name, or null for nowhere.");
    if (policy !== undefined && typeof policy !== "string")
      return failed(400, "policy is ask, allow or never.");
    const saved = await record.saveSecret(
      {
        name,
        ...(value !== undefined && { value }),
        ...(domain !== undefined && { domain }),
        ...(policy !== undefined && { policy }),
      },
      PERSON,
      signed,
    );
    if ("challenge" in saved) return json({ needsApproval: true, challenge: saved.challenge }, 409);
    if ("status" in saved || "error" in saved) return refusal(saved);
    return json(saved);
  }
  if (pathname === "/api/fills" && !post) {
    const fills = await record.fills(searchParams.get("url") ?? "", PERSON);
    return "status" in fills ? refusal(fills) : json({ fills });
  }
  const fill = /^\/api\/fills\/([0-9A-HJKMNP-TV-Z]{26})(\/dismiss)?$/.exec(pathname);
  const id = fill?.[1];
  if (!post || id === undefined) return failed(404, "Not found");
  if (fill?.[2]) {
    const dismissed = await record.dismissFill(id, PERSON);
    return "status" in dismissed ? refusal(dismissed) : json(dismissed);
  }
  const url = field(body, "url");
  if (typeof url !== "string") return failed(400, "Send the page's url.");
  const released = await record.fill(id, url, PERSON, signed);
  if ("challenge" in released)
    return json({ needsApproval: true, challenge: released.challenge, host: released.host }, 409);
  if ("status" in released || "error" in released) return refusal(released);
  return json(released);
}

/**
 * `POST /api/notes/<id>` `{ raw, baseRev, review? }`: the site's edit to a note straight to the record, as the
 * person. A sensitive note's edits always come here: a tab never queues one in its sync client, whose queue lives
 * in IndexedDB on a device the person may not have marked as theirs (contract §5). Review mode's edits come here
 * too, with the review session they were made in (`review`), which the record checks covers this note. Online
 * only. A `baseRev` the note has moved past is a conflict, never an overwrite; the change reaches every tab
 * through the sync push.
 */
async function saveNote(
  body: unknown,
  record: ReturnType<Env["BASE"]["get"]>,
  noteId: string,
): Promise<Response> {
  const given = typeof body === "object" && body !== null ? body : {};
  const raw = "raw" in given ? given.raw : undefined;
  const baseRev = "baseRev" in given ? given.baseRev : undefined;
  const review = "review" in given ? given.review : undefined;
  if (typeof raw !== "string" || typeof baseRev !== "number" || !Number.isInteger(baseRev))
    return failed(400, "Send the note's text and the revision it was edited from.");
  if (review !== undefined && typeof review !== "string") return failed(400, "review is a session's nonce.");
  const result = await record.mutate(
    { op: "put", noteId, baseRev, raw },
    { ...PERSON, ...(review !== undefined && { review }) },
  );
  switch (result.status) {
    case "applied":
      return json({ rev: result.rev });
    case "conflict":
      return failed(409, "This note changed since you started editing it. Your edit wasn't saved.");
    case "invalid":
      return failed(400, result.issues.map((issue) => issue.message).join(" "));
    case "forbidden":
      return failed(403, result.reason);
  }
  // The RPC stub's mapped type drops `needsApproval` (its plan holds `unknown` values), so it's read as an object.
  const answer: object = result;
  if ("planHash" in answer)
    return json(
      {
        needsApproval: true,
        error:
          review === undefined
            ? "This change needs your passkey approval."
            : "Your review session doesn't cover this change: it ended, or the change reaches past its items.",
      },
      409,
    );
  return failed(409, "This change is waiting for you as a proposal.");
}

const tooLarge = () => failed(413, `Files can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

type Refusal = { readonly status: "forbidden"; readonly reason: string } | { readonly error: string };

const refusal = (result: Refusal) =>
  "status" in result ? failed(403, result.reason) : failed(400, result.error);
