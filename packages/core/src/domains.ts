// Where a secret may be filled (docs/internals/security.md): only into a page on the domain saved with it. The
// guarantee is the exact match in `placement`; `lookalike` only names a refused page that imitates the domain, so
// the agent and the person are told it may be phishing rather than just "somewhere else".

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A URL's host as the browser would reach it: ASCII (punycode), lowercase, no trailing dot. */
function hostOf(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

/**
 * The domain a secret is saved for, from what the person typed or the page they were on: `tum.de`,
 * `https://campus.tum.de/login`. `undefined` for anything that isn't a public host name: an IP address, a single
 * label like `localhost`, or a scheme other than https.
 */
export function savedDomain(input: string): string | undefined {
  const text = input.trim().toLowerCase();
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = hostOf(url);
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;
  if (/^\d+$/.test(labels.at(-1) ?? "")) return undefined;
  return host;
}

/**
 * The host of a page a form may be filled on: https only, since anything else can be rewritten on the way, and
 * never a URL with credentials before its host (`https://campus.tum.de@evil.example`), which only phishing uses.
 */
export function pageHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    return hostOf(parsed);
  } catch {
    return undefined;
  }
}

/** Where a page's host stands to a saved domain: on it (the domain or a subdomain of it), imitating it, or neither. */
export type Placement = "on" | "lookalike" | "elsewhere";

export function placement(host: string, domain: string): Placement {
  if (host === domain || host.endsWith(`.${domain}`)) return "on";
  return lookalike(host, domain) ? "lookalike" : "elsewhere";
}

// Letters a reader takes for others: `rn` for `m`, `0` for `o`. Folded before comparing, longest first.
const CONFUSABLE: readonly (readonly [RegExp, string])[] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/cl/g, "d"],
  [/0/g, "o"],
  [/[1i]/g, "l"],
  [/5/g, "s"],
];
const fold = (text: string) => CONFUSABLE.reduce((out, [from, to]) => out.replace(from, to), text);

/** Edits (insert, delete, replace, swap two neighbours) from `a` to `b`. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_row, i) =>
    Array.from({ length: b.length + 1 }, (_cell, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  return d[a.length]![b.length]!;
}

/**
 * Whether a host off the domain imitates it: an internationalized label (a homograph of an ASCII name), a name of
 * the domain's inside it (`tum.de.login-check.com`, `tum-portal.com`), or the same tail but for a letter or a
 * confusable pair (`turn.de`, `tvm.de`).
 */
function lookalike(host: string, domain: string): boolean {
  const labels = host.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) return true;
  const names = new Set(
    domain
      .split(".")
      .slice(0, -1)
      .filter((label) => label.length >= 3)
      .map(fold),
  );
  if (host.split(/[.-]/).some((token) => names.has(fold(token)))) return true;
  const tail = labels.slice(-domain.split(".").length).join(".");
  return distance(fold(tail), fold(domain)) <= 1;
}
