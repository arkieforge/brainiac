// The toolbar popup on a portal's tab: the fills an agent asked for on this page, each with Fill and Dismiss.
// Everything here is built with textContent: field names and values come from an agent.
import { linesOf, said, siteOrigin, type Answer, type Ask, type Fill, type Line } from "./site.ts";

const main = document.querySelector<HTMLElement>("#main");
const hostLine = document.querySelector<HTMLElement>("#host");

const ask = (message: Ask): Promise<Answer> => chrome.runtime.sendMessage(message);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

const say = (text: string, className = "muted") => main?.replaceChildren(el("p", text, className));

const render = (lines: readonly Line[]) => lines.map(({ text, tone }) => el("p", text, tone));

/** What a press of Fill did, in the person's words. */
function outcome(answer: Answer): HTMLElement {
  const box = el("div");
  box.append(...render(said(answer)));
  return box;
}

function card(tabId: number, fill: Fill): HTMLElement {
  const box = el("section", undefined, "fill");
  box.append(el("p", "Your agent asked to fill:", "muted"));
  const list = el("ul");
  for (const field of fill.fields) {
    const row = el("li");
    row.append(el("span", field.field));
    // A secret shows by name only: its value isn't here, and leaves the record only when Fill is pressed.
    row.append("secret" in field ? el("span", `vault: ${field.secret}`, "vault") : el("span", field.value));
    list.append(row);
  }
  const buttons = el("div", undefined, "row");
  const fillButton = el("button", "Fill", "primary");
  const dismiss = el("button", "Dismiss");
  buttons.append(fillButton, dismiss);
  box.append(list, buttons);
  const settle = (node: HTMLElement) => box.replaceChildren(node);
  fillButton.addEventListener("click", async () => {
    fillButton.disabled = dismiss.disabled = true;
    const answer = await ask({ kind: "fill", tabId, fillId: fill.id });
    // The site's passkey page is open; this popup closes as it takes focus.
    if ("signing" in answer) return settle(el("p", "Approve with your passkey in the window that opened."));
    settle(outcome(answer));
  });
  dismiss.addEventListener("click", async () => {
    fillButton.disabled = dismiss.disabled = true;
    const answer = await ask({ kind: "dismiss", fillId: fill.id });
    settle("error" in answer ? outcome(answer) : el("p", "Dismissed. Nothing was filled.", "muted"));
  });
  return box;
}

async function start() {
  if (!main) return;
  const site = await siteOrigin();
  if (!site) {
    const open = el("button", "Set your Brainiac address", "primary");
    open.addEventListener("click", () => void chrome.runtime.openOptionsPage());
    main.replaceChildren(el("p", "Connect the extension to your record first.", "muted"), open);
    return;
  }
  // How the last passkey fill went, which finished after this popup had closed.
  const { last } = await chrome.storage.session.get("last");
  await chrome.storage.session.remove("last");
  await chrome.action.setBadgeText({ text: "" });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return say("Open the page you want to fill.");
  if (tab.url) hostLine?.replaceChildren(new URL(tab.url).host);
  const answer = await ask({ kind: "fills", tabId: tab.id });
  const earlier = render(linesOf(last));
  if ("error" in answer) return main.replaceChildren(...earlier, outcome(answer));
  if (!("fills" in answer)) return;
  if (answer.fills.length === 0)
    return main.replaceChildren(...earlier, el("p", "Nothing to fill on this page.", "muted"));
  main.replaceChildren(...earlier, ...answer.fills.map((fill) => card(tab.id ?? 0, fill)));
}

void start();
