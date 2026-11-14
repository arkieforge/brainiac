# Brainiac: guide for agents and contributors

Brainiac keeps a person's whole record (achievements, projects, papers, grades, test scores, CVs,
letters, IDs, profiles, links) as typed markdown notes with sources, synced live between the site, phones
and laptops, and managed by the person's own Claude through MCP. The full plan is in
[`docs/plan.html`](docs/plan.html). Its "The contract" section wins over anything else.

## Commands

- `pnpm install`: install (pnpm 12; build scripts allowed only for esbuild and workerd).
- `pnpm lint` / `pnpm format`: Biome.
- `pnpm typecheck`: TypeScript, every workspace.
- `pnpm test`: Vitest, every workspace.
- `pnpm dev`: run the stack locally with Alchemy. `pnpm deploy --stage <name>`: deploy a stage (needs
  Cloudflare credentials; never deploy `prod` from a laptop).

## Layout

- `alchemy.run.ts`: every cloud resource, per stage. Alchemy is pinned to 0.94; don't upgrade casually.
- `apps/worker`: the one Worker (UI, API, MCP, files, queue consumer) and the `Base` Durable Object.
- `packages/*`: shared code (`core`, `base`, `sync`, `render`) arrives with the issues that need it.

## Rules

- Work from an issue. One issue, one branch, one PR. Conventional commit titles: `feat(sync): ...`.
- Anything that changes the record goes through the server's checks; never write around them.
- No real personal data anywhere: code, tests, fixtures, evals, screenshots. Use the fictional fixture
  student.
- New behaviour comes with a test, a property test or an eval case. Eval cases are added before the fix
  and must fail on the old code.
- Don't add a dependency for a few lines. Don't add abstractions or options nobody asked for.
- Before calling work done, run `pnpm lint && pnpm typecheck && pnpm test` and paste the output in the PR.
