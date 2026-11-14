# Infra

Cloud resources are declared in [`alchemy.run.ts`](../alchemy.run.ts) at the repo root, one stack per stage.
This folder will also hold Neon migrations for the shared account tables and runbooks for restore drills
([docs/internals/security.md](../docs/internals/security.md)).

## Stages

| Stage    | Runs from                                                              | Doppler config | Neon project    |
| -------- | ---------------------------------------------------------------------- | -------------- | --------------- |
| `$USER`  | `vp run dev` (local Worker on `localhost:1337`) or `vp run deploy`     | `dev`          | `brainiac-dev`  |
| `pr-<n>` | CI on every push to a same-repo PR; `preview-cleanup.yml` destroys it  | `dev`          | `brainiac-dev`  |
| `prod`   | CI on every push to `main`, after the checks pass. Never from a laptop | `prd`          | `brainiac-prod` |

Every stage gets its own Worker, R2 bucket, queue, Hyperdrive and a Neon branch named after the stage, cut
from that project's `main`. `vp run dev` runs the Worker, R2, queue and Durable Objects locally in
Miniflare, but the Neon branch is real, so local runs talk to Postgres like a deploy does.

The Neon free plan allows 10 branches per project. Run `vp run destroy` when you are done with a personal
stage.

## Secrets (Doppler project `braniac`)

| Secret                  | What                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Account token: Workers Scripts, R2, Queues, Hyperdrive, KV, AI, Browser, Secrets   |
| `CLOUDFLARE_ACCOUNT_ID` | The account Brainiac deploys to                                                    |
| `NEON_API_KEY`          | Creates and deletes the per-stage branches                                         |
| `NEON_PROJECT_ID`       | `brainiac-dev` in `dev`, `brainiac-prod` in `prd`                                  |
| `ALCHEMY_PASSWORD`      | Encrypts secrets in Alchemy state. Different per config; losing it loses the state |
| `ALCHEMY_STATE_TOKEN`   | Auth for the shared state Worker. The same in every config                         |

GitHub gets read-only Doppler service tokens: `DOPPLER_TOKEN_DEV` as a repo secret (previews), and
`DOPPLER_TOKEN_PRD` in the `production` environment, which only `main` can deploy to.

## State

Alchemy state lives in the `brainiac-alchemy-state` Worker (`CloudflareStateStore`), so laptops, worktrees
and CI share it. The account hosts other apps, which is why the script has its own name.

## Protection

- Prod lives in its own Neon project, so no preview or dev stage can reach its data.
- The Neon projects were made once by hand (Postgres 17, `aws-ap-southeast-1`), not by Alchemy, so no
  destroy can delete one. Alchemy's `NeonProject` can't pass the `org_id` our key needs anyway.
- In `prod`, the R2 bucket, queue and Worker (which owns every Base Durable Object) have `delete: false`: a
  plan that would delete or replace them only drops them from state.
- `alchemy destroy --stage prod` refuses to run, and the `prod` stage runs only with Doppler's `prd` config
  (and `prd` only with `prod`), so a laptop can't deploy prod onto dev data or point a preview at prod's.
- Alchemy 0.94 has no plan command. The CI job summary lists every created, updated, replaced and deleted
  resource, and replaced or deleted ones raise a warning. Read it on any PR that touches `alchemy.run.ts`.
