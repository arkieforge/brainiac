# Infra

Cloud resources are declared in [`alchemy.run.ts`](../alchemy.run.ts) at the repo root, one stack per stage.
This folder will also hold Neon migrations for the shared account tables and runbooks for restore drills
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

| Secret                  | What                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Account token: Workers Scripts, R2, Queues, Hyperdrive, KV, AI, Browser, Secrets |
| `CLOUDFLARE_ACCOUNT_ID` | The account Brainiac deploys to                                                  |
| `NEON_API_KEY`          | Creates and deletes the per-stage branches                                       |
| `NEON_PROJECT_ID`       | `brainiac-dev` in `dev`, `brainiac-prod` in `prd`                                |

GitHub gets read-only Doppler service tokens: `DOPPLER_TOKEN_DEV` as a repo secret (previews), and
`DOPPLER_TOKEN_PRD` in the `production` environment, which only `main` can deploy to.

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
