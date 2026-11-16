// What runs inside the portal's tab when the person presses Fill. `chrome.scripting.executeScript` sends this
// function's source alone, so it closes over nothing and every helper lives inside it.

/** A field the record released: the label, name or id the agent named, and the value to put there. */
export interface Released {
  readonly field: string;
  readonly value: string;
}

/** What a press of Fill did to the page. Never the values: they stay in the fields. */
export type Filled =
  | { readonly filled: readonly string[]; readonly missing: readonly string[] }
  | { readonly refused: string };

/**
 * Puts each value into its field and fires the events a page's own code listens for, then stops: nothing is
 * submitted. Only when the page is still at `url`, the one read at the click and sent to the record (its `#` part
 * aside, which a page changes as it goes): a page that moved after the click gets nothing. Fields are matched exactly by id, name, label or aria-label, all inside one form, the one
 * that holds the most of them; when two forms hold as many, nothing is filled rather than the wrong one.
 */
export function fillPage(fields: readonly Released[], url: string): Filled {
  if (location.href.split("#")[0] !== url.split("#")[0])
    return { refused: "The page moved after you pressed Fill, so nothing was filled. Press Fill again." };

  type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  // Values that aren't typed text: a hidden field is the page's own, and a box or a button isn't a value.
  const SKIP = new Set(["hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio"]);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Chrome sends only this function's source.
  const norm = (text: string) =>
    text
      .replace(/\s+/g, " ")
      .replace(/[\s*:]+$/, "")
      .trim()
      .toLowerCase();
  const controls = [...document.querySelectorAll<Control>("input, select, textarea")].filter(
    (el) =>
      !(el instanceof HTMLInputElement && SKIP.has(el.type)) &&
      !el.disabled &&
      !(el instanceof HTMLSelectElement ? false : el.readOnly) &&
      el.checkVisibility?.() !== false,
  );
  const namesOf = (el: Control) =>
    [
      el.id,
      el.name,
      el.getAttribute("aria-label") ?? "",
      ...[...(el.labels ?? [])].map((l) => l.textContent ?? ""),
    ]
      .map(norm)
      .filter((name) => name !== "");
  const named = new Map(controls.map((el) => [el, namesOf(el)]));
  const matches = fields.map(({ field }) => controls.filter((el) => named.get(el)?.includes(norm(field))));

  // The form that holds the most of the fields; outside any form counts as one more.
  const holds = new Map<HTMLFormElement | null, number>();
  for (const found of matches)
    for (const form of new Set(found.map((el) => el.form))) holds.set(form, (holds.get(form) ?? 0) + 1);
  const most = Math.max(0, ...holds.values());
  const best = [...holds].filter(([, count]) => count === most);
  if (best.length > 1)
    return {
      refused: "Two forms on this page fit these fields, so nothing was filled. Fill this one yourself.",
    };
  const form = best[0]?.[0];

  const put = (el: Control, value: string) => {
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find((o) => o.value === value || norm(o.text) === norm(value));
      if (!option) return false;
      el.value = option.value;
    } else {
      // The prototype's setter, so a framework that wraps `value` (React) sees the change as the person's.
      const proto =
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const filled: string[] = [];
  const missing: string[] = [];
  fields.forEach(({ field, value }, i) => {
    const here = (matches[i] ?? []).filter((el) => form !== undefined && el.form === form);
    // Two fields in one form by the same name: guessing could put a password in the wrong one.
    const [only] = here;
    if (here.length === 1 && only && put(only, value)) filled.push(field);
    else missing.push(field);
  });
  return { filled, missing };
}
