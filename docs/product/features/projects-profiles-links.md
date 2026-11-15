# Projects, profiles and links

Projects come in from GitHub, profiles are checked for drift, and useful links are saved with snapshots. Connectors propose new notes; they may refresh only their own `synced:` block directly.

| Phase | Source                                                                  | How                                                                                                                       | Brings in                                                  |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| M2    | **GitHub**                                                              | Our GitHub App on the repos you pick; webhooks + a daily ETag sweep                                                       | Repos, stars, language, archived, last push                |
| M2    | **DOIs**                                                                | Crossref and OpenAlex (free, no key), looked up again weekly                                                              | Title, venue, date, authors, citations                     |
| M2    | **ORCID** (#112)                                                        | ORCID OAuth                                                                                                               | A verified iD, your works, your author position            |
| M2    | **LinkedIn**                                                            | Your data export zip                                                                                                      | Positions, education, skills, certifications               |
| M3    | **Drift checks**                                                        | Through treg: `linkedin.user.profile`, `x.user.profile`, `google.serp.scholar` (your own public profiles, started by you) | "LinkedIn says 2025, record says 2026", with text to paste |
| later | Kaggle, LeetCode, Hugging Face, npm, app stores, Credly, Devpost, blogs | Public APIs or treg                                                                                                       | Ranks, packages, apps, certificates, talks                 |

```
# facts/projects/library-seat-finder.md (excerpt)
role: "Lead developer (team of 3)"            # yours; connectors never touch these
summary: "Cut time spent looking for a seat from 14 to 6 minutes."
sources: [{id: analytics, resource: ../../documents/seat-analytics-2025.md, fields: [summary]}]
synced: {repo_id: R_kgDOJx..., repo: nadia-karim/library-seat-finder, url: "https://github.com/nadia-karim/library-seat-finder", stars: 214, language: TypeScript, archived: false, private: false, pushed: 2026-11-14}
```

- **GitHub** (`apps/worker/src/connectors/github.ts` reads GitHub; `packages/base/src/github.ts` decides): you
  install the App from the account page and pick repos on GitHub's own page. The installation is linked to your
  record only after your GitHub sign-in shows it is on your own account (organization installations wait for a
  per-repo check of what you can see there). Each repo is proposed once as a `Project` (the
  built-in type, unless your manifest has its own); a private repo's project is **sensitive**, so agents see it
  only with the sensitive scope. If the repo turns private later, the block stops updating and a proposal asks to make the project sensitive. Once you accept, the connector keeps `synced:` current from Repository and Star
  webhooks and a daily sweep (03:00 UTC) that sends each page's ETag, so an unchanged installation costs no rate
  limit. It writes only keys that changed, so a quiet day writes nothing. A repo is matched by `repo_id`, so a
  rename or transfer updates the block; a deleted repo keeps its snapshot with `archived: true`. A project accepted
  after its repo changed catches up to what GitHub said last. A rejected
  proposal or a deleted project is never proposed again. Disconnecting on the account page stops the reading;
  your projects stay. Laptops get projects through sync; agents read and query them like any note; the
  extension has no part in it.
- **Papers**: a Paper note with a `doi` gets a `synced:` block (title, venue, published, authors, citations,
  checked), refreshed weekly; a DOI no registry knows says `missing: true`. Which author you are is your own
  `position` field, asked until it is set, until ORCID (#112) can tell from your verified iD.
- **Drift checks** (`packages/core/src/profiles.ts` compares; `packages/base/src/profiles.ts` decides when to read;
  `apps/worker/src/connectors/profiles.ts` reads through treg): a `Profile` note in `profiles/` names a site
  (`linkedin`, `x` or `scholar`), its `url`, and what it should say (`name`, `headline`, `about`, `location`). A new
  profile, or a new link, is read once; after that only **Check now** (on the overview's Profile group or the
  profile's page) reads again, and a profile read less than a day ago keeps its answer. What the site showed goes in
  the note's `synced:` block, written as `connector:profiles`. Each field that differs is a "looks wrong" check
  naming the field, what the site says, and the record's text to paste (`LinkedIn says "BSc student at
  Northvale"`, paste `MSc Informatics applicant · ...`). Google Scholar is searched for your papers' titles, never a
  sensitive paper's, up to 20: a different year (`Google Scholar says 2025; the record says 2026`) or a paper it
  doesn't list is drift, with the year or the citation to paste. A read that fails (blocked, not found, no treg
  token) says `unchecked` and why, and nothing from it is compared. Agents read drift through `query` with
  `type: "Check"` (each with `paste`) and can add profiles, but never start a paid re-check; the laptop shows the
  same checks from its copy; the extension has no part in it.
- **Ownership is verified** before a profile counts (OAuth, a code in your bio, or a `rel="me"` link), and private-repo projects default to private. For LinkedIn and X it is a code (`brainiac-` and the end of the note's id) anywhere in the profile's text: until it shows up, nothing the profile says is kept, since it may be someone else's. Once shown at a link, the profile stays yours there, so the code can come out. Google Scholar needs none: it is searched for your own papers, not for a person.
- **Links**: saved from the extension, the phone, the CLI or MCP `add`. Text via treg `web.extract`, a PDF snapshot via Browser Rendering, a weekly health check, and a signal when an application depends on a dead link.
