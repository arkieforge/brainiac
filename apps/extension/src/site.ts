// Which Brainiac site the extension talks to. Each stage has its own address, so the person sets it once, and
// Chrome grants the extension that one origin (`optional_host_permissions`), which also sends their session
// cookie with its requests.

const KEY = "site";

/** The site's origin, once the person has set it and Chrome still grants it. */
export async function siteOrigin(): Promise<string | undefined> {
  const { [KEY]: site } = await chrome.storage.local.get(KEY);
  if (typeof site !== "string") return undefined;
  return (await chrome.permissions.contains({ origins: [`${site}/*`] })) ? site : undefined;
}

/** The origin of an address the person typed, like `brainiac.example` or `http://localhost:1338/`. */
export function originOf(input: string): string | undefined {
  const text = input.trim();
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    const local = url.protocol === "http:" && url.hostname === "localhost";
    return url.protocol === "https:" || local ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Asks Chrome for the site's origin (a user gesture must start this) and keeps it. */
export async function setSite(origin: string): Promise<boolean> {
  if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) return false;
  await chrome.storage.local.set({ [KEY]: origin });
  return true;
}

/** What the popup asks the service worker. */
export type Ask =
  | { readonly kind: "fills"; readonly tabId: number }
  | { readonly kind: "fill"; readonly tabId: number; readonly fillId: string }
  | { readonly kind: "dismiss"; readonly fillId: string };

/** A fill as the site lists it: the agent's own values, and secrets by name only. */
export interface Fill {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly fields: readonly ({ readonly field: string } & ({ value: string } | { secret: string }))[];
}

/** What the service worker answers. */
export type Answer =
  | { readonly fills: readonly Fill[] }
  | { readonly filled: readonly string[]; readonly missing: readonly string[] }
  /** An `ask` secret: the person signs on the site's page, which the service worker opened. */
  | { readonly signing: true }
  | { readonly dismissed: boolean }
  | { readonly error: string };

/** A line of what happened, in the person's words. */
export interface Line {
  readonly text: string;
  readonly tone: "ok" | "error" | "muted";
}

/** What a press of Fill did, as the popup says it. */
export function said(answer: Answer): readonly Line[] {
  if ("error" in answer) return [{ text: answer.error, tone: "error" }];
  if (!("filled" in answer)) return [];
  return [
    ...(answer.filled.length > 0
      ? [
          {
            text: `Filled ${answer.filled.join(", ")}. Check them, then submit it yourself.`,
            tone: "ok" as const,
          },
        ]
      : []),
    ...(answer.missing.length > 0
      ? [{ text: `Not found on this page: ${answer.missing.join(", ")}.`, tone: "error" as const }]
      : []),
  ];
}

/** Lines kept in session storage, read back. */
export const linesOf = (kept: unknown): readonly Line[] =>
  Array.isArray(kept)
    ? kept.flatMap((line: unknown) =>
        typeof line === "object" &&
        line !== null &&
        "text" in line &&
        typeof line.text === "string" &&
        "tone" in line &&
        (line.tone === "ok" || line.tone === "error" || line.tone === "muted")
          ? [{ text: line.text, tone: line.tone }]
          : [],
      )
    : [];
