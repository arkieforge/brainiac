// `brainiac login` and `brainiac logout`. Login listens on this machine's loopback and sends the person to the
// site, which (once they confirm, signed in) makes a CLI connection on their record and posts its token back here.
// Only this terminal knows the login's `state`, so a token another page posts is refused.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { tokenBase } from "@brainiac/base";

import { mustBeEncrypted } from "./link.ts";

/** A login under way: the page to open, and the token once the site posts it back. */
export interface Waiting {
  readonly url: string;
  readonly token: Promise<string>;
  /** Stops listening; the token never comes. */
  readonly close: () => void;
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What the browser shows after posting back; it never sees the token again. */
const answer = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>brainiac login</title><p>${text}</p>`;

/** Starts a login with `server` for this machine, `device` (its name, shown on the confirm page). */
export async function startLogin(server: string, device: string): Promise<Waiting> {
  const state = randomBytes(32).toString("base64url");
  const { promise: token, resolve } = Promise.withResolvers<string>();
  const listener = createServer((request, response) => {
    const reply = (status: number, text: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(answer(text));
    };
    if (request.method !== "POST" || request.url !== "/callback") return reply(404, "Not found.");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      // A token and a state are well under this; anything bigger isn't from the site.
      if (body.length > 4096) request.destroy();
    });
    request.on("end", () => {
      const form = new URLSearchParams(body);
      const given = form.get("token") ?? "";
      if (!same(form.get("state") ?? "", state) || tokenBase(given) === undefined)
        return reply(400, "This isn't the login your terminal started. Run brainiac login again.");
      reply(200, "Logged in. You can close this tab and go back to your terminal.");
      listener.close();
      resolve(given);
    });
  });
  // Loopback only, on a port the OS picks: nothing off this machine can post a token here.
  const port = await new Promise<number>((done, fail) => {
    listener.once("error", fail);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (address && typeof address === "object") done(address.port);
      else fail(new Error("The login listener has no port."));
    });
  });
  const url = new URL("/cli/login", server);
  url.search = new URLSearchParams({ port: String(port), state, device }).toString();
  return { url: url.toString(), token, close: () => listener.close() };
}

/** Opens `url` in the default browser, if there is one; the caller prints it as well. */
export function openBrowser(url: string): void {
  // rundll32 takes the URL as one argument; `cmd /c start` would split it at the `&` between parameters.
  const [command, ...args]: readonly [string, ...string[]] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

/**
 * Ends the connection `token` belongs to, at its record. False when the record no longer knows it (disconnected
 * on the site, say), which leaves nothing to end.
 */
export async function logout(server: string, token: string): Promise<boolean> {
  const url = new URL("/cli/logout", server);
  mustBeEncrypted(url);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 204) return true;
  if (response.status === 401) return false;
  throw new Error(`${server} answered ${response.status} to logout.`);
}
