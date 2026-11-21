# Infra

Cloud resources are declared in [`alchemy.run.ts`](../alchemy.run.ts) at the repo root, one stack per stage.
This folder also holds the Neon migrations for the shared tables, and will hold runbooks for restore drills
([docs/internals/security.md](../docs/internals/security.md)).

## Stages

| Stage        | Runs from                                                              | Doppler config | Neon project    |
| ------------ | ---------------------------------------------------------------------- | -------------- | --------------- |
| `dev_$USER`  | `vp run dev` (local Worker on `localhost:1337`)                        | `dev`          | `brainiac-dev`  |
| `live_$USER` | `vp run deploy` (your own cloud stage)                                 | `dev`          | `brainiac-dev`  |
| `pr-<n>`     | CI on every push to a same-repo PR; `preview-cleanup.yml` destroys it  | `dev`          | `brainiac-dev`  |
| `prod`       | CI on every push to `main`, after the checks pass. Never from a laptop | `prd`          | `brainiac-prod` |

Every stage gets its own Worker, R2 bucket, queue, Hyperdrive and a Neon branch named after the stage, cut
from that project's `main`. Cloudflare resources are named `brainiac-<id>-<stage>` (underscores become
dashes). `vp run dev` runs the Worker, R2, queue and Durable Objects locally, but the Neon branch is real,
so local runs talk to Postgres like a deploy does. `vp run plan --stage <name>` shows what a deploy would
change without applying it.

The Neon free plan allows 10 branches per project. Run `vp run destroy --stage dev_$USER` (or `live_$USER`)
when you are done with a personal stage.

## Secrets (Doppler project `braniac`)

| Secret                  | What                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Account token: Workers Scripts, R2, Queues, Hyperdrive, KV, AI, Browser, Secrets                                                                                                                                                                                              |
| `CLOUDFLARE_ACCOUNT_ID` | The account Brainiac deploys to                                                                                                                                                                                                                                               |
| `CLOUDFLARE_LOGS_TOKEN` | `prd` only. Read-only: Workers Observability Read and Workers Tail Read, for `vp run logs --stage prod`. Kept out of `dev` because prod's logs hold real people's data. Other stages read logs with `dev`'s `CLOUDFLARE_API_TOKEN`, which can tail but can't read stored logs |
| `NEON_API_KEY`          | Creates and deletes the per-stage branches                                                                                                                                                                                                                                    |
| `NEON_PROJECT_ID`       | `brainiac-dev` in `dev`, `brainiac-prod` in `prd`                                                                                                                                                                                                                             |

Auth settings are optional: each feature stays off until its values exist, so a stage deploys without them.
The session secret isn't here; `alchemy.run.ts` generates one per stage and keeps it in Alchemy state. So does the
vault key (`VAULT_KEY`), which it stores in the account's Cloudflare Secrets Store as `brainiac_vault_key_<stage>`
(`brainiac_vault_key_<stage>__g<n>` from generation 2); it wraps every record's data key, so replacing it leaves every sealed file and secret
on that stage unreadable. Rotate it by the runbook below instead.

| Secret                                                                                                                       | Turns on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                                                                                                                     | Serves the Worker on this hostname too (e.g. `brainiac.example.com`), in a zone of the account. Turnstile's hostname list and both OAuth redirect URLs must include it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`                                                                                 | Turnstile on sign-up. Other stages fall back to Cloudflare's always-pass test keys; prod has no fallback, so sign-up there refuses until both are set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `EMAIL_FROM`                                                                                                                 | Email codes and recovery notices, through Cloudflare Email Service. The address must be on a domain onboarded to it. Without it nothing sends: the sign-in page offers no email codes, and a recovery passkey is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                                   | Sign in with Google. Redirect URI: `<worker url>/api/auth/callback/google`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                                                                   | Sign in with GitHub. Callback URL: `<worker url>/api/auth/callback/github`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | The GitHub connector (`apps/worker/src/connectors/github.ts`), off until all five are set; one App per Doppler config. App settings: Setup URL `<worker url>/connectors/github/setup` with "Request user authorization (OAuth) during installation" on (the setup route checks the person can reach the installation) and the callback URL the same; "Expire user authorization tokens" left on, so a member's link to an organization installation keeps a refresh token rather than a token that never expires; webhook URL `<worker url>/connectors/github/webhook` with a secret; repository permission Metadata read-only; events Repository and Star; "Only select repositories" offered. The private key goes in as PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem` |
| `ORCID_CLIENT_ID`, `ORCID_CLIENT_SECRET`                                                                                     | The ORCID connector (`apps/worker/src/connectors/orcid.ts`): linking an iD on the account page, the works it brings in, and author positions. A public API client from ORCID's developer tools: a sandbox one (sandbox.orcid.org) in `dev`, since every non-prod stage signs in to the sandbox, a production one in `prd`. Redirect URI: `<worker url>/connectors/orcid/callback`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TREG_TOKEN`                                                                                                                 | Drift checks of people's own LinkedIn, X and Google Scholar (`apps/worker/src/connectors/profiles.ts`). An org-scoped treg token (`treg org agent-new <name>`); each check costs a fraction of a cent from the team's treg balance. Without it every profile says it couldn't be checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID`                                                             | Pro through Polar (`apps/worker/src/billing.ts`). Until all three exist billing is off and no record has a limit. In Polar's sandbox (sandbox.polar.sh) for `dev` and production polar.sh for `prd`: an organization access token with `checkouts:write` and `customer_sessions:write`, the Pro product's id ($6 a month), and a webhook to `<worker url>/billing/webhook` sending `customer.state_changed`, in the Raw format, whose `whsec_` secret is the webhook secret                                                                                                                                                                                                                                                                                                             |
| `DEV_SIGN_IN_TOKEN`                                                                                                          | `dev` only, never `prd`. Turns on dev sign-in as the fixture student (`vp run dev:sign-in`, `vp run dev:token`, `vp run e2e`) on `vp run dev` and every non-prod stage. `alchemy.run.ts` never binds it for prod. Rotate it with `doppler secrets set DEV_SIGN_IN_TOKEN=$(openssl rand -hex 32) --config dev`; stages pick it up on their next deploy                                                                                                                                                                                                                                                                                                                                                                                                                                   |

GitHub gets read-only Doppler service tokens: `DOPPLER_TOKEN_DEV` as a repo secret (previews), and
`DOPPLER_TOKEN_PRD` in the `production` environment, which only `main` can deploy to.

## Rotating the vault key

Two optional settings in the stage's Doppler config pick the vault keys: `VAULT_KEY_GENERATION` (default 1) is
the one that wraps data keys, and `VAULT_KEY_PREVIOUS`, while set, is the generation before it, bound to the Worker
as `VAULT_KEY_PREVIOUS`. Each record says which key wraps its data key (`meta.vaultKeyId`); one wrapped by the
previous key rewraps under the current one the first time it wakes, in one write. Every non-prod stage shares
`dev`, so set them there only to rotate them all; to rotate one stage, export them for one deploy from a laptop
instead. From generation `n` to `n+1`:

1. **Add the new key.** `doppler secrets set VAULT_KEY_GENERATION=<n+1> VAULT_KEY_PREVIOUS=<n> --config prd`, then
   deploy (for prod, re-run the latest `main` CI run). Alchemy makes `brainiac_vault_key_<stage>__g<n+1>` and keeps
   generation `n` bound beside it.
2. **Wait for every record to rewrap.** Records rewrap as they wake, and a sweep every 10 minutes (only while
   `VAULT_KEY_PREVIOUS` is set) wakes the rest. `vp run doctor --stage <stage>` warns
   `No record waiting on the previous vault key` with the count still waiting, and passes at 0. A record that
   keeps failing is in `vp run logs --stage <stage>` as `vault key rewrap failed`; fix it before going on.
3. **Remove the old key.** `doppler secrets delete VAULT_KEY_PREVIOUS --config prd`, then deploy. Other stages
   delete the old secret with the deploy. Prod keeps it in the Secrets Store (Alchemy retains it, which is what
   lets the deploy pass `protect()`), so delete `brainiac_vault_key_prod` (or `__g<n>`) there by hand once the
   doctor has passed.

Never lower `VAULT_KEY_GENERATION` or remove `VAULT_KEY_PREVIOUS` early. A record whose data key is wrapped by a key
the Worker no longer holds refuses every file and secret with an error naming that key, and never makes a new data
key. Don't set `VAULT_KEY_PREVIOUS` again after step 3 to fix one: Alchemy no longer holds that key's value and
would make a new one. Rotating the per-record data keys themselves is not built.

## Migrations

`infra/migrations/*.sql` holds the Neon schema: Better Auth's tables and the base registry. Every deploy applies new files to
the stage's branch, in order, before the Worker updates; `vp run plan` shows the branch as an update while a file is pending (read the diff for which). History is forward only: an
applied file is never edited, and a change goes in a new file that sorts after the others.

Better Auth derives its tables from `apps/worker/src/auth/config.ts`, so a new plugin or field needs a new file.
`apps/worker/src/auth/schema.test.ts` fails, naming each missing `table.column`, until one exists. Better
Auth's `getMigrations(options).compileMigrations()` against a database at the current schema prints the SQL.

## State

Alchemy state lives in the `brainiac-state` Worker (`Cloudflare.state`), so laptops, worktrees and CI share
it. Its auth token and encryption key live in the account's Cloudflare Secrets Store, so Doppler holds no
state secret. The account hosts other apps' stores, which is why ours has its own name. CI never creates
the store; it was made once with `doppler run -- alchemy state bootstrap`.

## Protection

- Prod lives in its own Neon project, so no preview or dev stage can reach its data.
- The Neon projects were made once by hand (Postgres 17, `aws-ap-southeast-1`), not by Alchemy, so no
  destroy can delete one. Alchemy's `NeonProject` can't pass the `org_id` our key needs anyway.
- In `prod`, every resource is under `RemovalPolicy.protect()`: a plan that would replace or delete one (a
  rename, a removed declaration, `alchemy destroy`) fails before anything is applied. The Worker owns every
  Base Durable Object. The policy is stored on each resource's state row, so it guards from the deploy
  that first records it; to remove a prod resource on purpose, deploy it without `protect()` first.
- The `prod` stage runs only with Doppler's `prd` config (and `prd` only with `prod`), so a laptop can't
  deploy prod onto dev data or point a preview at prod's.
- The CI job summary shows the plan for the stage it deployed, and replaced or deleted resources raise a
  warning. Read it on any PR that touches `alchemy.run.ts`.

## Moving from Alchemy 0.94

2.0 started from empty state and adopted what 0.94 made, by the pinned names above (CI deploys with
`--adopt`). One trap: 0.94 tagged each Worker `alchemy:do:base:BASE`, which 2.0 reads as a Durable Object
class named `BASE` and fails with `MissingDurableObjects`. Clearing the Worker's tags before the first 2.0
deploy fixes it; the `Base` namespace and its objects are kept.
