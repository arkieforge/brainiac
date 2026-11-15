// The DOI lookup against Crossref and OpenAlex as they answer (test/registries.ts). The record's half (when a
// paper is looked up, and how its block is written) runs on both engines in packages/base/test/papers-cases.ts.
import { expect, it } from "vite-plus/test";

import { FIXTURE_DOI, registries } from "../../test/registries.ts";
import { lookupDoi } from "./doi.ts";

const CROSSREF = "https://api.crossref.org/works/";
const OPENALEX = "https://api.openalex.org/works/doi:";

it("reads the paper from Crossref and its citations from OpenAlex, sending them only the DOI", async () => {
  const { web, asked } = registries();
  const found = {
    title: "Named Entity Recognition for Low-Resource Swahili News",
    venue: "Journal of Fictional Linguistics",
    published: "2026-03-14",
    authors: ["Nadia Karim", "Amara Okafor"],
    citations: 3,
  };
  expect(await lookupDoi(FIXTURE_DOI, web)).toEqual(found);
  // People paste the link as often as the DOI.
  expect(await lookupDoi(` https://doi.org/${FIXTURE_DOI}`, web)).toEqual(found);
  expect(asked).toEqual([
    `${CROSSREF}${FIXTURE_DOI}`,
    `${OPENALEX}${FIXTURE_DOI}`,
    `${CROSSREF}${FIXTURE_DOI}`,
    `${OPENALEX}${FIXTURE_DOI}`,
  ]);
});

it("says a DOI nobody registered is missing, and asks nobody about text that isn't a DOI", async () => {
  const { web, asked } = registries();
  expect(await lookupDoi("10.5555/not-registered", web)).toBe("missing");
  expect(await lookupDoi("my thesis paper", web)).toBe("missing");
  expect(asked).toEqual([`${CROSSREF}10.5555/not-registered`, `${OPENALEX}10.5555/not-registered`]);
});

it("keeps only what the registry has, and fails rather than answer while a service is down", async () => {
  const doi = "10.5555/preprint";
  const preprint = {
    message: {
      title: ["A <scr<script>ipt>preprint</i"],
      institution: [{ name: "arXiv" }],
      published: { "date-parts": [[2026, null]] },
      author: [{ name: "Northvale NLP Group" }, { given: "Nadia", family: "Karim" }],
    },
  };
  // OpenAlex hasn't indexed it yet: no citation count, rather than zero.
  expect(await lookupDoi(doi, registries({ [`${CROSSREF}${doi}`]: preprint }).web)).toEqual({
    // Markup that a single pass leaves half of still leaves no tag.
    title: "A iptpreprint/i",
    venue: "arXiv",
    published: "2026",
    authors: ["Northvale NLP Group", "Nadia Karim"],
  });
  // A failing service is no answer: the job tries again, and the block keeps what it had.
  await expect(
    lookupDoi(FIXTURE_DOI, registries({ [`${OPENALEX}${FIXTURE_DOI}`]: 503 }).web),
  ).rejects.toThrow("api.openalex.org answered 503");
});
