// @vitest-environment happy-dom
// A tab's start-up racing a sign-out: everything else here is the browser, faked as little as it can be.
import type { Store } from "@brainiac/sync";
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
  send() {}
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
