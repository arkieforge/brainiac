# Projects, profiles and links

Projects come in from GitHub, profiles are checked for drift, and useful links are saved with snapshots. Connectors propose new notes; they may refresh only their own `synced:` block directly.

| Phase  | Source                                                                  | How                                                                                                                       | Brings in                                                  |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `M2    | **GitHub**                                                              | Our GitHub App on the repos you pick; webhooks + a daily ETag sweep                                                       | Repos, stars, languages, releases, your commits and PRs    |
| `M2    | **ORCID + DOIs**                                                        | ORCID OAuth; Crossref and OpenAlex (free)                                                                                 | Works, venues, author position, citations                  |
| `M2    | **LinkedIn**                                                            | Your data export zip                                                                                                      | Positions, education, skills, certifications               |
| `M3    | **Drift checks**                                                        | Through treg: `linkedin.user.profile`, `x.user.profile`, `google.serp.scholar` (your own public profiles, started by you) | "LinkedIn says 2025, record says 2026", with text to paste |
| `later | Kaggle, LeetCode, Hugging Face, npm, app stores, Credly, Devpost, blogs | Public APIs or treg                                                                                                       | Ranks, packages, apps, certificates, talks                 |

```
# facts/projects/campus-bus-tracker.md (excerpt)
role: "Lead developer (team of 3)"            # yours; connectors never touch these
summary: "Cut average wait at stops from 14 to 6 minutes."
sources: [{id: analytics, resource: ../../documents/bus-analytics-2025.md, fields: [summary]}]
synced:                                       # owned by the GitHub connector
  repo_id: R_kgDOJx...                         # stable across renames
  stars: 214
  my_commits: 412
  archived: false
  checked: 2026-11-14T03:00:00Z
```

- **Ownership is verified** before a profile counts (OAuth, a code in your bio, or a `rel="me"` link), and private-repo projects default to private.
- **Links**: saved from the extension, the phone, the CLI or MCP `add`. Text via treg `web.extract`, a PDF snapshot via Browser Rendering, a weekly health check, and a signal when an application depends on a dead link.
