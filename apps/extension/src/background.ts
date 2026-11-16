// The extension's service worker: it lists the fills waiting for a tab, presses Fill with the tab's own URL, and
// puts the values the record releases into that tab's fields. An `ask` secret takes the person's passkey, which
// only the site's own page can ask for (an extension can't assert for the site's rpId), so this opens that page,
// waits for the signature it hands back, and presses Fill again with it.
//
// Released values go from the record's answer straight into the page's fields: never logged, stored or sent on.
import { fillPage, type Filled, type Released } from "./fill.ts";
import { said, siteOrigin, type Answer, type Ask } from "./site.ts";

/**
 * A fill waiting for the person's passkey on the site's page: kept in session storage, since Chrome can stop this
 * worker while the person signs. Ids only, never a value.
 */
interface Signing {
  readonly fillId: string;
  /** The portal's tab. */
  readonly tabId: number;
  /** The site's page that signs. */
  readonly signTab: number;
  /** The portal's address when the person pressed Fill: the tab must still be there to be filled. */
  readonly url: string;
}

const NO_SITE = "Set your Brainiac address in the extension's options first.";

async function call(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const site = await siteOrigin();
  if (!site) return { status: 0, body: { error: NO_SITE } };
  const res = await fetch(`${site}${path}`, {
    credentials: "include",
    ...(body !== undefined && {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  }).catch(() => undefined);
  if (!res) return { status: 0, body: { error: "Brainiac can't be reached. Check you're online." } };
  if (res.status === 401) return { status: 401, body: { error: `Sign in to Brainiac at ${site} first.` } };
  const answer: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: typeof answer === "object" && answer !== null ? { ...answer } : {} };
}

const errorOf = (body: Record<string, unknown>, fallback: string): Answer => ({
  error: typeof body["error"] === "string" ? body["error"] : fallback,
});

/** The tab's address as Chrome has it now: the page's real one, never one an agent or the page supplied. */
async function urlOf(tabId: number): Promise<string | undefined> {
  return (await chrome.tabs.get(tabId).catch(() => undefined))?.url;
}

async function fills(tabId: number): Promise<Answer> {
  const url = await urlOf(tabId);
  if (!url?.startsWith("https://")) return { fills: [] };
  const { status, body } = await call(`/api/fills?${new URLSearchParams({ url })}`);
  return status === 200 && Array.isArray(body["fills"])
    ? { fills: body["fills"] }
    : errorOf(body, "Your fills didn't load.");
}

const MOVED = "The page changed. Open Brainiac on it again and press Fill.";
const page = (url: string) => url.split("#")[0];

/**
 * Presses Fill on the tab; with the person's passkey answer once they've signed, then only if the tab is still at
 * `pressed`, the address it had when they pressed Fill.
 */
async function fill(
  tabId: number,
  fillId: string,
  passkey?: { response: unknown; pressed: string },
): Promise<Answer> {
  const url = await urlOf(tabId);
  if (!url || (passkey && page(url) !== page(passkey.pressed))) return { error: MOVED };
  const response = passkey?.response;
  const { status, body } = await call(`/api/fills/${fillId}`, {
    url,
    ...(response !== undefined && { response }),
  });
  const challenge = body["challenge"];
  const host = body["host"];
  if (status === 409 && typeof challenge === "string" && typeof host === "string" && response === undefined)
    return sign({ tabId, fillId, url }, challenge, host);
  const released = body["fields"];
  if (status !== 200 || !Array.isArray(released)) return errorOf(body, "That fill didn't go through.");
  const fields: Released[] = released;
  const [ran] = await chrome.scripting
    .executeScript({ target: { tabId }, func: fillPage, args: [fields, url] })
    .catch(() => []);
  const filled: Filled | undefined = ran?.result;
  if (!filled) return { error: "Chrome didn't let Brainiac into this page, so nothing was filled." };
  return "refused" in filled ? { error: filled.refused } : filled;
}

/** Opens the site's page that signs the fill's challenge with the person's passkey. */
async function sign(
  asked: Pick<Signing, "tabId" | "fillId" | "url">,
  challenge: string,
  host: string,
): Promise<Answer> {
  const site = await siteOrigin();
  if (!site) return { error: NO_SITE };
  const signPage = `${site}/fill?${new URLSearchParams({ id: asked.fillId, host, challenge })}`;
  const window = await chrome.windows.create({ url: signPage, type: "popup", width: 460, height: 620 });
  const signTab = window?.tabs?.[0]?.id;
  if (signTab === undefined) return { error: "The passkey page didn't open." };
  const waiting: Signing = { ...asked, signTab };
  await chrome.storage.session.set({ signing: waiting });
  return { signing: true };
}

async function signing(): Promise<Signing | undefined> {
  const { signing: kept } = await chrome.storage.session.get("signing");
  if (
    typeof kept !== "object" ||
    kept === null ||
    !("fillId" in kept && "tabId" in kept && "signTab" in kept && "url" in kept)
  )
    return undefined;
  const { fillId, tabId, signTab, url } = kept;
  return typeof fillId === "string" &&
    typeof tabId === "number" &&
    typeof signTab === "number" &&
    typeof url === "string"
    ? { fillId, tabId, signTab, url }
    : undefined;
}

/**
 * Runs in the site's signing page: passes the signature the page posts to itself on to this worker. A content
 * script, so it reaches the extension however the site's address was set.
 */
function relay(fillId: string) {
  // Chrome can report the page loaded more than once, and each report injects this again: one listener per page,
  // and one signature passed on, since a second press of Fill finds the fill already used.
  if ("brainiacRelay" in globalThis) return;
  Object.assign(globalThis, { brainiacRelay: true });
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (event.source !== window || typeof data !== "object" || data === null) return;
    if (!("type" in data) || data.type !== "brainiac:fill-signed") return;
    if (!("fill" in data) || data.fill !== fillId || !("response" in data)) return;
    removeEventListener("message", onMessage);
    void chrome.runtime.sendMessage({ kind: "signed", fillId, response: data.response });
  };
  addEventListener("message", onMessage);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete") return;
  void signing().then((waiting) => {
    if (waiting?.signTab !== tabId) return;
    return chrome.scripting.executeScript({ target: { tabId }, func: relay, args: [waiting.fillId] });
  });
});

/** The person signed on the site's page: close it, go back to the portal, and fill it. */
async function signed(sender: chrome.runtime.MessageSender, fillId: string, response: unknown) {
  const waiting = await signing();
  const site = await siteOrigin();
  if (!waiting || waiting.fillId !== fillId || sender.tab?.id !== waiting.signTab || sender.origin !== site)
    return;
  await chrome.storage.session.remove("signing");
  if (sender.tab.windowId !== undefined) await chrome.windows.remove(sender.tab.windowId).catch(() => {});
  const portal = await chrome.tabs.update(waiting.tabId, { active: true }).catch(() => undefined);
  if (portal?.windowId !== undefined) await chrome.windows.update(portal.windowId, { focused: true });
  await show(await fill(waiting.tabId, fillId, { response, pressed: waiting.url }));
}

/** After a passkey fill the popup is gone: the badge says how it went, and the popup tells the rest next time. */
async function show(answer: Answer) {
  const ok = "filled" in answer && answer.missing.length === 0;
  await chrome.action.setBadgeBackgroundColor({ color: ok ? "#4ade80" : "#f87171" });
  await chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  await chrome.storage.session.set({ last: said(answer) });
}

/** What one of the extension's own pages asked, read back from the message. */
function askOf(message: object): Ask | undefined {
  const field = (key: string): unknown => Object.entries(message).find(([k]) => k === key)?.[1];
  const [kind, tabId, fillId] = [field("kind"), field("tabId"), field("fillId")];
  if (kind === "fills" && typeof tabId === "number") return { kind, tabId };
  if (kind === "fill" && typeof tabId === "number" && typeof fillId === "string")
    return { kind, tabId, fillId };
  if (kind === "dismiss" && typeof fillId === "string") return { kind, fillId };
  return undefined;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || typeof message !== "object" || message === null) return false;
  if ("kind" in message && message.kind === "signed" && "fillId" in message && "response" in message) {
    if (typeof message.fillId === "string") void signed(sender, message.fillId, message.response);
    return false;
  }
  // Only the extension's own pages ask anything else, never a content script in a web page.
  if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const ask = askOf(message);
  if (!ask) return false;
  const answer =
    ask.kind === "fills"
      ? fills(ask.tabId)
      : ask.kind === "fill"
        ? fill(ask.tabId, ask.fillId)
        : call(`/api/fills/${ask.fillId}/dismiss`, {}).then(({ status, body }) =>
            status === 200 ? { dismissed: body["dismissed"] === true } : errorOf(body, "That didn't work."),
          );
  void answer.then(reply);
  return true;
});
