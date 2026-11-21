# Services

Buy what isn't the product, pay per use where possible, and add a service only when the feature that needs it is being built. Models are not on this list: people bring their own Claude.

## Tier 1: what the MVP runs on

| Service                                    | Job                                                                                                                                                                        | Why it's worth it                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare** (Workers Paid)              | Worker, Durable Objects, R2, Queues, Workflows, Workers AI (`toMarkdown`, embeddings), Images, Browser Rendering, Email Routing, Turnstile, Workers Logs, Analytics Engine | Almost the whole backend on one bill; idle costs nothing; no R2 egress fees                                                                  |
| **Neon**                                   | Accounts and the base registry                                                                                                                                             | Scales to zero; a branch per preview stage                                                                                                   |
| **Better Auth** (open source, self-hosted) | Sign-in with passkeys, approvals, and MCP OAuth (`@better-auth/mcp` + `cimd`, 2026-07-28 profile)                                                                          | $0 at any scale and no lock-in; we own OAuth security, so M0 includes conformance tests. Fallbacks: Neon Managed Better Auth, WorkOS AuthKit |
| **Polar**                                  | Payments as merchant of record                                                                                                                                             | Tax handled in every country for a global student audience; a percentage, no fixed fee                                                       |
| **Resend**                                 | Reminders, weekly digests                                                                                                                                                  | Deliverability; the free tier covers early use (or Cloudflare Email Sending if it fits)                                                      |
| **treg**                                   | All paid third-party data (tier 2)                                                                                                                                         | One key, per-call prices, providers ranked by measured success, credentials server-side                                                      |
| **GitHub App**                             | Projects from repos, webhooks                                                                                                                                              | Free; the most important connector, done directly                                                                                            |

Not on the bill: an Anthropic account. No auth vendor either: Better Auth runs inside the Worker.

## Tier 2: through treg instead of separate vendors

| Brainiac job                                                      | treg capability                                               | Price per call (catalog, 2026-11-14) |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| Drift check of your own LinkedIn (public profile, started by you) | `linkedin.user.profile` (9 providers, 99.7% measured success) | ~$0.001                              |
| Drift check of X bio and links                                    | `x.user.profile`                                              | ~$0.0002                             |
| Check the Google Scholar listing of your papers                   | `google.serp.scholar` (Serper, one search per paper title)    | $0.001                               |
| Save a link as clean text                                         | `web.extract` (15 providers)                                  | ~$0.004                              |
| Company details on a Role (domain, logo)                          | `companies.enrich`                                            | from free                            |

Each call is cached for a day and recorded against the record's usage. Brainiac never builds a profile of anyone but the user. treg has no background-removal tool yet, which only matters when photos ship.

## Tier 3: only when a feature or an eval needs it

| Service                 | Add when                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Reducto** (or Extend) | The `filing` eval shows `toMarkdown` plus the user's Claude reading page images still misses transcript values |
| **Nango**               | More than ~3 OAuth connectors beyond GitHub and ORCID                                                          |
| **Browserbase**         | Hosted form filling for cloud-only users (the extension covers it first)                                       |
| **Sentry** (free tier)  | The CLI has outside users and needs crash reports                                                              |

## Deliberately not used

- **Paid eval and tracing platforms** (Braintrust, Langfuse): in-repo evals and Cloudflare's built-in logs cover it.
- **Memory products** (Mem0, Supermemory, Zep): Brainiac is the memory.
- **Agent action hubs** (Composio, Klavis, Pipedream): Claude already connects to Gmail, Calendar and Drive; Brainiac is one more connector.
- **Session replay** on a site holding passports and transcripts.
- **A second sync engine** (Convex, Zero, Neon Realtime) next to the DO layer.
