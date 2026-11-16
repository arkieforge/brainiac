// @vitest-environment happy-dom
// A tab's start-up racing a sign-out: everything else here is the browser, faked as little as it can be.
import type { Store } from "@brainiac/sync";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const slots: { name: string; released: boolean }[] = [];
let releasedOnce: () => void = () => {};
vi.mock("@brainiac/sync/browser", () => ({
  openTabStore: async (name: string) => {
    const slot = { name, released: false };
    slots.push(slot);
    const store: Store = { load: async () => undefined, write: async () => {} };
    return {
      store,
      release: async () => {
        slot.released = true;
        releasedOnce();
      },
    };
  },
}));

const sockets: string[] = [];
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  constructor(url: string) {
    super();
    sockets.push(url);
  }
  send(_data: string) {}
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("record", () => {
  it("opens and connects nothing for a session that answers after sign-out", async () => {
    localStorage.setItem("brainiac:user", "ada");
    const session = Promise.withResolvers<Response>();
    const asked = Promise.withResolvers<void>();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("fetch", async (path: string) => {
      if (path !== "/api/session") return Response.json({});
      asked.resolve();
      return session.promise;
    });
    const { start } = await import("./record.ts");

    const starting = start();
    await asked.promise; // the stored copy is open; the session is slow to answer
    expect(slots).toEqual([{ name: "brainiac:ada", released: false }]);
    const released = new Promise<void>((resolve) => (releasedOnce = resolve));
    // The account page, in another tab. A BroadcastChannel has no target origin; the rule is for window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    new BroadcastChannel("brainiac:session").postMessage("signed-out");
    await released;

    // The session answers late, for another account than the stored copy's.
    session.resolve(Response.json({ user: "someone-else" }));
    await starting;
    expect(slots).toEqual([{ name: "brainiac:ada", released: true }]);
    expect(sockets).toEqual([]);
  });
});

describe("review saves", () => {
  it("are live only once the record answered, and go on the revision shown, not one that arrived since", async () => {
    vi.resetModules();
    localStorage.setItem("brainiac:user", "ada");
    const ID = "01M6AGSCW0VCVQ4638KZVD05RK";
    const opened: (EventTarget & { sent: string[]; readyState: number })[] = [];
    class Socket extends FakeSocket {
      sent: string[] = [];
      constructor(url: string) {
        super(url);
        opened.push(this);
      }
      override send(data: string) {
        this.sent.push(data);
      }
    }
    const posted: unknown[] = [];
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
      if (path === "/api/session") return Response.json({ user: "ada" });
      if (path === "/api/schema") return Response.json({ manifest: null });
      if (path === "/api/files") return Response.json({ files: [] });
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ rev: 4 });
    });
    const record = await import("./record.ts");
    await record.start();
    const [socket] = opened;
    if (!socket) throw new Error("no socket");
    socket.readyState = 1;
    socket.dispatchEvent(new Event("open"));
    // The socket is open, but the record hasn't answered the hello yet: not live, so nothing is reviewed.
    const early = { rev: 1, raw: "" };
    expect(await record.saveReviewed(ID, (raw) => `${raw}x`, "nonce", early)).toHaveProperty("error");
    const hello = JSON.parse(socket.sent.at(-1) ?? "{}");
    const push = (data: unknown) =>
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
    const state = (rev: number, raw: string) => ({
      noteId: ID,
      seq: rev,
      deleted: false,
      rev,
      path: "facts/roles/a.md",
      raw,
      class: "normal",
    });
    // An answer to an older hello, which the client sets aside: still not live.
    push({ type: "snapshot", seq: 1, notes: [], attempt: hello.attempt - 1 });
    expect(await record.saveReviewed(ID, (raw) => `${raw}x`, "nonce", early)).toHaveProperty("error");
    push({ type: "snapshot", seq: 2, notes: [state(2, "---\ntitle: A\n---\n")], attempt: hello.attempt });

    // What the card showed when the person pressed y; another device's edit lands during the passkey prompt.
    const shown = record.reviewBase(ID);
    expect(shown).toMatchObject({ rev: 2, raw: "---\ntitle: A\n---\n" });
    push({ type: "changes", from: 2, to: 3, items: [state(3, "---\ntitle: B\n---\n")] });
    if (!shown) return;
    expect(await record.saveReviewed(ID, (raw) => raw.replace("A", "A!"), "nonce", shown)).toEqual({
      rev: 4,
      raw: "---\ntitle: A!\n---\n",
    });
    // Sent on revision 2, so the record refuses it as a conflict rather than verifying title B unseen.
    expect(posted).toEqual([{ raw: "---\ntitle: A!\n---\n", baseRev: 2, review: "nonce" }]);
  });
});

describe("the manifest", () => {
  it("is read again when the record says it changed, and when the tab comes back online", async () => {
    vi.resetModules();
    localStorage.setItem("brainiac:user", "ada");
    const opened: (FakeSocket & { sent: string[] })[] = [];
    class Socket extends FakeSocket {
      sent: string[] = [];
      constructor(url: string) {
        super(url);
        opened.push(this);
      }
      override send(data: string) {
        this.sent.push(data);
      }
    }
    // Each read of the schema answers with the record's manifest as of then.
    let types: Record<string, object> = {};
    let schemaReads = 0;
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", async (path: string) => {
      if (path === "/api/session") return Response.json({ user: "ada" });
      if (path === "/api/schema") {
        schemaReads++;
        return Response.json({ manifest: { schema_version: 1, types } });
      }
      return Response.json({ files: [], proposals: [] });
    });
    const record = await import("./record.ts");
    // A mounted component reading the manifest as a form does: each wait settles when it renders with that type.
    const waits: [string, () => void][] = [];
    const shows = (type: string) => new Promise<void>((resolve) => waits.push([type, resolve]));
    function Probe() {
      const has = record.useRecord().manifest?.types ?? {};
      useEffect(() => {
        for (const [type, resolve] of waits) if (type in has) resolve();
      });
      return null;
    }
    createRoot(document.createElement("div")).render(createElement(Probe));
    await record.start();
    const live = async () => {
      const socket = opened.at(-1);
      if (!socket) throw new Error("no socket");
      socket.readyState = 1;
      socket.dispatchEvent(new Event("open"));
      const hello = JSON.parse(socket.sent.at(-1) ?? "{}");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "snapshot", seq: 0, notes: [], attempt: hello.attempt }),
        }),
      );
      return socket;
    };
    const socket = await live();
    expect(schemaReads).toBe(1);

    // Organize added Trip somewhere else: the socket says so, and the tab's forms get it without a reload.
    types = { Trip: { version: 2, folder: "history/travel", fields: {} } };
    const trip = shows("Trip");
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "manifest" }) }));
    await trip;
    expect(schemaReads).toBe(2);

    // Changed again while the tab was offline: the push went to nobody, so coming back reads it again.
    socket.dispatchEvent(new Event("close"));
    types = { ...types, Visa: { version: 1, folder: "identity/visas", fields: {} } };
    const visa = shows("Visa");
    window.dispatchEvent(new Event("online"));
    await live();
    await visa;
    expect(schemaReads).toBe(3);
  });
});
