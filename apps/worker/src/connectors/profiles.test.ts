// Reading a profile through treg as it answers (test/treg.ts). The record's half (when a profile is read, what is
// kept) runs on both engines in packages/base/test/profiles-cases.ts.
import { expect, it } from "vite-plus/test";

import { FIXTURE_LINKEDIN, linkedinOutput, treg } from "../../test/treg.ts";
import { readProfile } from "./profiles.ts";

const CODE = "brainiac-fixture1";
const TOKEN = "treg-test-token";
/** A network that never answers. */
const down: Parameters<typeof readProfile>[2] = () => Promise.reject(new Error("offline"));

it("reads a LinkedIn profile by its link through treg, capped in cost, and keeps the contract's fields", async () => {
  const { web, asked } = treg({
    "treg.linkedin.user.profile": { output: linkedinOutput(CODE), raw: {}, _treg: { served_by: "fixture" } },
  });
  const seen = await readProfile(
    { site: "linkedin", url: "https://linkedin.com/in/brainiac-fixture-nadia/?trk=share", code: CODE },
    TOKEN,
    web,
  );
  expect(seen).toEqual({
    says: {
      name: "Nadia Karim",
      headline: "BSc Computer Science student at Northvale",
      about: `I build NLP tools for Swahili. ${CODE}`,
      location: "Dhaka, Bangladesh",
    },
  });
  expect(asked).toEqual([
    {
      endpoint: "treg.linkedin.user.profile",
      // Only the link: never the code, the record or the person's details.
      body: { linkedin_url: FIXTURE_LINKEDIN },
      headers: { "content-type": "application/json", "x-treg-token": TOKEN, "x-treg-route-max-cost": "0.02" },
    },
  ]);
});

it("reads an X profile by its username, from a link or a handle", async () => {
  const { web, asked } = treg({
    "treg.x.user.profile": {
      output: { username: "fixture_nadia", name: "Nadia Karim", description: `NLP for Swahili. ${CODE}` },
    },
  });
  const work = { site: "x", code: CODE } as const;
  const says = { name: "Nadia Karim", about: `NLP for Swahili. ${CODE}` };
  expect(await readProfile({ ...work, url: "https://x.com/fixture_nadia" }, TOKEN, web)).toEqual({ says });
  expect(await readProfile({ ...work, url: "@fixture_nadia" }, TOKEN, web)).toEqual({ says });
  expect(asked.map((a) => a.body)).toEqual([{ username: "fixture_nadia" }, { username: "fixture_nadia" }]);
});

it("anything but a profile is unchecked, with why, and a link that isn't one asks nobody", async () => {
  const work = { site: "linkedin", url: FIXTURE_LINKEDIN, code: CODE } as const;
  const missed = treg();
  expect(await readProfile(work, TOKEN, missed.web)).toEqual({ unchecked: "it didn't show this profile" });
  expect(await readProfile(work, TOKEN, treg({ "treg.linkedin.user.profile": 403 }).web)).toEqual({
    unchecked: "the read was refused (403)",
  });
  expect(await readProfile(work, TOKEN, down)).toEqual({ unchecked: "it couldn't be reached" });

  const none = treg();
  expect(await readProfile({ ...work, url: "https://example.com/nadia" }, TOKEN, none.web)).toEqual({
    unchecked: "that isn't a LinkedIn profile link",
  });
  expect(await readProfile({ ...work, url: FIXTURE_LINKEDIN }, undefined, none.web)).toEqual({
    unchecked: "drift checks aren't set up here yet",
  });
  expect(none.asked).toEqual([]);
});

it("searches Google Scholar for each paper's title and keeps only a listing with the same title", async () => {
  const title = "Named Entity Recognition for Low-Resource Swahili News";
  const { web, asked } = treg({
    "serper.google.serp.scholar": {
      organic: [
        { title: "Named entity recognition for Swahili tweets", year: 2024 },
        { title: "Named Entity Recognition for Low-Resource Swahili News.", year: 2025, citedBy: 3 },
      ],
    },
  });
  const seen = await readProfile(
    {
      site: "scholar",
      url: "https://scholar.google.com/citations?user=fixture",
      papers: [{ id: "p1", title }],
    },
    TOKEN,
    web,
  );
  expect(seen).toEqual({ papers: { p1: { title, says: 2025 } } });
  expect(asked.map((a) => a.body)).toEqual([{ q: title }]);

  const nothing = treg({
    "serper.google.serp.scholar": { organic: [{ title: "Something else", year: 2025 }] },
  });
  const blocked = treg({ "serper.google.serp.scholar": 503 });
  const work = { site: "scholar", url: "u", papers: [{ id: "p1", title }] } as const;
  expect(await readProfile(work, TOKEN, nothing.web)).toEqual({ papers: { p1: { title, says: "missing" } } });
  expect(await readProfile(work, TOKEN, blocked.web)).toEqual({
    papers: { p1: { title, says: "unchecked" } },
  });
});
