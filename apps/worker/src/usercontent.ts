// The usercontent origin (`usercontent.<domain>`): the only place an uploaded file's bytes are ever served. A file
// can be HTML or SVG that someone else wrote, so it must never run as the site: this origin shares no cookies with
// it, reads none, sets none, and every response forbids scripts. The single-use token in the path is the only
// credential, and it names its record, so routing needs no lookup.
import { fileTokenBase } from "@brainiac/base";

import type { Env } from "./env.ts";

/** Sent with every answer from this origin, including the 404s. */
const USERCONTENT_HEADERS = {
  "cache-control": "private, no-store",
  // `sandbox` gives the document an opaque origin and no scripts, even when opened as its own tab.
  "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

const MIME = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/;

const notFound = () => new Response("Not found", { status: 404, headers: USERCONTENT_HEADERS });

/** Whether this request is for the usercontent origin, which serves nothing else. */
export const isUsercontent = (request: Request, env: Pick<Env, "USERCONTENT_ORIGIN">): boolean =>
  env.USERCONTENT_ORIGIN !== undefined && new URL(request.url).host === new URL(env.USERCONTENT_ORIGIN).host;

/** `GET /f/<token>`: the file the token opens, once. Anything else here is a 404. */
export async function serveUsercontent(request: Request, env: Pick<Env, "BASE">): Promise<Response> {
  const token = /^\/f\/([\w-]+)$/.exec(new URL(request.url).pathname)?.[1];
  if (request.method !== "GET" || token === undefined) return notFound();
  const baseId = fileTokenBase(token);
  let record;
  try {
    record = baseId === undefined ? undefined : env.BASE.get(env.BASE.idFromString(baseId));
  } catch {
    return notFound(); // not an id this namespace made
  }
  const opened = await record?.openFile(token);
  if (!opened) return notFound();
  // The type the uploader gave; nosniff keeps the browser from guessing another one from the bytes.
  const mime = opened.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return new Response(opened.bytes, {
    headers: {
      ...USERCONTENT_HEADERS,
      "content-type": MIME.test(mime) ? mime : "application/octet-stream",
      // Only the site page that asked for the token may read the bytes (the PDF viewer fetches them).
      "access-control-allow-origin": opened.origin,
      vary: "origin",
    },
  });
}
