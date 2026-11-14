# Development

## Setup

1. Install [Vite+](https://viteplus.dev) once: `curl -fsSL https://vite.plus | bash`. It provides `vp`.
2. `vp i` installs dependencies (pnpm 12 underneath) and `prepare` installs the git hooks.
3. `vp run doctor` checks your machine and tells you what's missing.
4. Optional: `vp run repos:sync` clones the reference repos into `.repos/` (see below).

In a T3 Code worktree, `t3.json` runs `scripts/setup-worktree.ts` on creation, which does steps 2 to 4 and
links the main checkout's `.env`.

## Commands

| Command                        | Does                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `vp check`                     | Format check, lint and type-aware checks                                  |
| `vp test run [files]`          | Tests (Vitest through Vite+)                                              |
| `vp run typecheck`             | `effect-tsgo` type check in every workspace                               |
| `vp run knip`                  | Unused files, exports and dependencies                                    |
| `vp run dev`                   | Local stack through Alchemy                                               |
| `vp run deploy --stage <name>` | Deploy a stage (needs Cloudflare credentials; never `prod` from a laptop) |
| `vp run doctor`                | Environment check                                                         |

The pre-commit hook (`.vite-hooks/pre-commit`) runs `vp staged`: format, then lint, on staged files.

## Layout

| Path                     | Holds                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| `alchemy.run.ts`         | Every cloud resource, per stage. Alchemy is pinned to 0.94                       |
| `apps/worker`            | The one Worker and the `Base` Durable Object                                     |
| `packages/*`             | Shared code (`core`, `base`, `sync`, `render`), added by the issues that need it |
| `oxlint-plugin-brainiac` | Repo-specific lint rules, each with tests                                        |
| `evals/`                 | Model-behaviour evals ([README](../../evals/README.md))                          |
| `infra/`                 | Infrastructure notes and, later, database migrations                             |
| `scripts/`               | Doctor, worktree setup, reference-repo sync                                      |
| `assets/`                | Brand and icon sources                                                           |
| `.agents/skills`         | Skills for agents working on this repo (`.claude/skills` links here)             |
| `.repos/`                | Read-only reference checkouts, gitignored                                        |

Some folders T3 Code has don't exist here yet, on purpose: `native/` (no native code planned),
`packaging/` (arrives with the CLI release, see the daemon issue), `patches/` (only when a dependency
needs one).

## Reference repos

`.repos/` holds shallow checkouts of the libraries we lean on, so agents can read real source instead of
guessing: `effect` (`main` until a package depends on it, then the tag of that version), `alchemy` (the 2.0 line, for the migration spike),
`better-auth`, and `t3code` (for the renderer glue we copy). For the Alchemy 0.94 we actually run, read
`node_modules/alchemy/src`. `.repos/` is gitignored, excluded from lint, format, tests and editor search,
and never imported.

## Dev container

`.devcontainer/` mirrors CI: Ubuntu, Node 26, `vp`, and `gh`. Open the repo in a container and it runs
`vp i` for you.

## Never

- Deploy `prod` from a laptop, or point a dev stage at prod resources.
- Use real personal data in code, fixtures, evals, screenshots or issues. Use the fictional fixture student.
- Read a base id from a URL. It comes from the session or token.
