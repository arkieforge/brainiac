# Contributing

1. Pick an issue from the [project board](../../projects) or a milestone (M0 to M3). Comment to claim it.
2. Branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
3. Keep the change to what the issue asks. If you find more work, open an issue for it.
4. Open a pull request that closes the issue. Paste the output of `pnpm lint && pnpm typecheck && pnpm test`,
   and of any eval cases you ran.
5. CI must be green before merge.

Read [`AGENTS.md`](AGENTS.md) for commands and rules, and [`docs/plan.html`](docs/plan.html) for the design.
Open questions that need the owner's call are tracked in the "Open decisions" issue.
