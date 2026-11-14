# Infra

Cloud resources are declared in [`alchemy.run.ts`](../alchemy.run.ts) at the repo root, one stack per
stage (`dev`, `pr-<n>`, `prod`). This folder will hold what doesn't fit there: Neon migrations for the
shared account tables (issue #1) and runbooks for restore drills
([docs/internals/security.md](../docs/internals/security.md)).

- Stateful resources (R2, the Durable Object namespace, Neon) are adopted and protected; a plan diff that
  deletes one is a bug.
- `prod` deploys only from CI. Never from a laptop.
