// Crossref and OpenAlex as they answer for the fixture paper's DOI: fictional, in the shape the real services
// answer in (compare https://api.crossref.org/works/10.5555/12345678, Crossref's own test record). Any other DOI
// is a 404 from both, as an unregistered one is.
import type { Web } from "../src/connectors/doi.ts";

export const FIXTURE_DOI = "10.5555/brainiac.swahili-ner.2026";

const CROSSREF = {
  status: "ok",
  "message-type": "work",
  message: {
    DOI: FIXTURE_DOI,
    type: "journal-article",
    title: ["Named Entity Recognition for <i>Low-Resource</i> Swahili News"],
    "container-title": ["Journal of Fictional Linguistics"],
    published: { "date-parts": [[2026, 3, 14]] },
    issued: { "date-parts": [[2026, 3, 14]] },
    author: [
      // Her iD is outside the ranges ORCID issues, so nobody's.
      {
        ORCID: "https://orcid.org/0000-0000-0000-0001",
        "authenticated-orcid": false,
        given: "Nadia",
        family: "Karim",
        sequence: "first",
        affiliation: [],
      },
      { given: "Amara", family: "Okafor", sequence: "additional", affiliation: [] },
    ],
    "is-referenced-by-count": 1,
  },
};

const OPENALEX = {
  id: "https://openalex.org/W0000000001",
  doi: `https://doi.org/${FIXTURE_DOI}`,
  publication_date: "2026-03-14",
  cited_by_count: 3,
};

/** Answers as the two services do; every URL it was asked for is in `asked`. */
export function registries(answers: Readonly<Record<string, unknown>> = {}) {
  const asked: string[] = [];
  const known: Record<string, unknown> = {
    [`https://api.crossref.org/works/${FIXTURE_DOI}`]: CROSSREF,
    [`https://api.openalex.org/works/doi:${FIXTURE_DOI}`]: OPENALEX,
    ...answers,
  };
  const web: Web = async (url) => {
    asked.push(url);
    const body = known[url];
    if (typeof body === "number") return new Response(null, { status: body });
    return body === undefined ? new Response("Resource not found.", { status: 404 }) : Response.json(body);
  };
  return { web, asked };
}
