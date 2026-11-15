// The DOI connector's lookup (docs/product/features/projects-profiles-links.md): what a paper's registry says
// about it, from Crossref, and how often it is cited, from OpenAlex. Both are free and need no key. The DOI is the
// only thing either one is sent.
import type { Found } from "@brainiac/base";
import { type } from "arktype";

/** Who is asking, as both services ask clients to say. Generic on purpose: never the person's details. */
const USER_AGENT = "Brainiac (https://github.com/arkieforge/brainiac)";

/** How a lookup reaches the outside world: `fetch`, or a test answering in its place. */
export type Web = (url: string, init: RequestInit) => Promise<Response>;

/** A DOI as the services take it (`10.5555/12345678`), from a bare DOI, `doi:` or a doi.org link. */
function bareDoi(text: string): string | undefined {
  const doi = text.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, "");
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

// Crossref writes `[[null]]` for a date it doesn't have.
const DateParts = type({ "date-parts": "(number.integer | null)[][]" });

// Only what Brainiac keeps, from https://api.crossref.org/swagger-ui/index.html (`/works/{doi}`).
const CrossrefWork = type({
  message: {
    "title?": "string[]",
    "container-title?": "string[]",
    /** Where a preprint is posted (arXiv), which has no container. */
    "institution?": type({ "name?": "string" }).array(),
    "published?": DateParts,
    "issued?": DateParts,
    "author?": type({ "given?": "string", "family?": "string", "name?": "string" }).array(),
  },
});

const OpenAlexWork = type({ cited_by_count: "number.integer >= 0" });

/** Crossref keeps some markup in titles (`<i>In vivo</i>`); a note holds the words. */
const plain = (text: string | undefined) => {
  const words = text
    ?.replaceAll(/<[^>]*>/g, "")
    // What one pass leaves of nested or unclosed markup (`<scr<script>ipt>`) is never a tag either.
    .replaceAll(/[<>]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return words || undefined;
};

/** `2026-03-14`, `2026-03` or `2026`: no more precise than the registry is. */
function dateOf(parts: readonly (number | null)[] = []): string | undefined {
  const known = parts.slice(0, 3);
  const end = known.indexOf(null);
  const date = (end === -1 ? known : known.slice(0, end))
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, "0"))
    .join("-");
  return date || undefined;
}

const encode = (doi: string) => doi.split("/").map(encodeURIComponent).join("/");

async function get(web: Web, url: string): Promise<unknown> {
  const response = await web(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (response.status === 404) return undefined;
  // Anything else is the service failing, not an answer: the job is tried again, and nothing known is erased.
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

/**
 * What the registries say about the paper `text` names. A DOI that isn't one, or one Crossref doesn't know, is
 * `missing`. OpenAlex not knowing it yet only leaves the citation count out.
 */
export async function lookupDoi(text: string, web: Web = fetch): Promise<Found> {
  const doi = bareDoi(text);
  if (doi === undefined) return "missing";
  const [crossref, openalex] = await Promise.all([
    get(web, `https://api.crossref.org/works/${encode(doi)}`),
    get(web, `https://api.openalex.org/works/doi:${encode(doi)}`),
  ]);
  if (crossref === undefined) return "missing";
  const { message: work } = CrossrefWork.assert(crossref);
  const authors = work.author
    ?.map((author) => plain(author.name ?? [author.given, author.family].join(" ")))
    .filter((name) => name !== undefined);
  const title = plain(work.title?.[0]);
  const venue = plain(work["container-title"]?.[0] ?? work.institution?.[0]?.name);
  const published = dateOf((work.published ?? work.issued)?.["date-parts"][0]);
  return {
    ...(title && { title }),
    ...(venue && { venue }),
    ...(published && { published }),
    ...(authors?.length && { authors }),
    ...(openalex !== undefined && { citations: OpenAlexWork.assert(openalex).cited_by_count }),
  };
}
