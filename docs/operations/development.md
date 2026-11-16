# Development

## Setup

1. Install [Vite+](https://viteplus.dev) once: `curl -fsSL https://vite.plus | bash`. It provides `vp`.
2. `vp i` installs dependencies (pnpm 12 underneath) and `prepare` installs the git hooks.
3. `vp run doctor` checks your machine and tells you what's missing.
4. Optional: `vp run repos:sync` clones the reference repos into `.repos/` (see below).
5. Secrets: set up Doppler for this folder (see [Secrets](#secrets)).

In a T3 Code worktree, `t3.json` runs `scripts/setup-worktree.ts` on creation, which does steps 2 and 4 and
links the main checkout's `.env`.

## Commands

| Command                             | Does                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `vp check`                          | Format check, lint and type-aware checks                                                            |
| `vp test run [files]`               | Tests (Vitest through Vite+)                                                                        |
| `vp run typecheck`                  | `effect-tsgo` type check in every workspace                                                         |
| `vp run knip`                       | Unused files, exports and dependencies                                                              |
| `vp run dev`                        | Local Worker and site on `localhost:1337`, with your own Neon branch (stage `dev_$USER`)            |
| `vp run plan --stage <name>`        | What a deploy would change, without applying it                                                     |
| `vp run deploy --stage <name>`      | Deploy a stage (defaults to `live_$USER`; never `prod` from a laptop)                               |
| `vp run destroy --stage <name>`     | Tear down a stage, Neon branch included                                                             |
| `vp run doctor`                     | Environment check; `--stage <name>` probes a deployed stage (CI runs it after each deploy)          |
| `vp run logs --stage <name>`        | A deployed stage's failed requests (`--ray <ref>`, `--since 2h`, `--tail`)                          |
| `vp run dev:sign-in --stage <name>` | A link that signs a browser in as the fixture student (`--stage local` for `vp run dev`)            |
| `vp run dev:token --stage <name>`   | An access token for that stage's `/mcp`, as the fixture student                                     |
| `vp run e2e --stage <name>`         | Sign-in, a passkey, sign-out and passkey sign-in in a real browser (`--headed`, `--evidence <dir>`) |

The pre-commit hook (`.vite-hooks/pre-commit`) runs `vp staged`: format, then lint, on staged files.

## Layout

| Path                     | Holds                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| `alchemy.run.ts`         | Every cloud resource, per stage. Alchemy 2.0, pinned to one beta                 |
| `apps/worker`            | The one Worker: API, `/mcp`, queue consumer, and the `Base` Durable Object       |
| `apps/web`               | The site (TanStack Start, SPA mode); the Worker serves its build                 |
| `apps/cli`               | The `brainiac` CLI, daemon and stdio MCP (Bun)                                   |
| `apps/marketing`         | The public Astro site; a placeholder for now                                     |
| `apps/extension`         | The Chrome extension (MV3); `vp build` there, then load `dist/` unpacked         |
| `packages/*`             | Shared code (`core`, `base`, `sync`, `render`), added by the issues that need it |
| `oxlint-plugin-brainiac` | Repo-specific lint rules, each with tests                                        |
| `evals/`                 | Model-behaviour evals ([README](../../evals/README.md))                          |
| `infra/`                 | Infrastructure notes and, later, database migrations                             |
| `scripts/`               | Doctor, logs, worktree setup, reference-repo sync                                |
| `assets/`                | Brand and icon sources                                                           |
| `.agents/skills`         | Skills for agents working on this repo (`.claude/skills` links here)             |
| `.repos/`                | Read-only reference checkouts, gitignored                                        |

Apps never import each other; shared code goes in `packages/*` (lint rule `brainiac/no-cross-app-import`).

Some folders T3 Code has don't exist here yet, on purpose: `native/` (no native code planned),
`packaging/` (arrives with the CLI release, see the daemon issue), `patches/` (only when a dependency
needs one).

## Secrets

Secrets (Cloudflare, Neon, Alchemy state, later treg) live in Doppler: workplace **LaunchPad**, project
**braniac**, config `dev` (`prd` is for CI's prod deploy, plus the read-only token for prod's logs). [infra/README.md](../../infra/README.md) lists
each one, the stages and how prod is protected. Nothing secret goes in `.env` or the repo. Doppler logins are scoped per folder, so a laptop with
several workplaces picks the right one by directory:

```sh
doppler login --scope ~/Work/brainiac                 # approve in the browser with the LaunchPad account
doppler login --scope ~/.t3/worktrees/brainiac        # T3 Code worktrees of this repo
doppler setup --no-interactive                        # reads doppler.yaml: project braniac, config dev
```

`vp run dev`, `deploy` and `destroy` run through `doppler run`, so Alchemy gets the secrets. Worktree setup
runs `doppler setup` for you. Under `vp run dev` uploaded files open from `http://usercontent.localhost:1337`
(browsers resolve `*.localhost` to loopback), the dev stand-in for `usercontent.<domain>`. Trap: the dev stage's
Alchemy state is shared by every checkout, but the vault key's local value lives in each checkout's
`.alchemy/local/secrets-store`, seeded only when Alchemy creates or changes it. A second worktree's dev Worker
then fails any upload with `Secret "brainiac_vault_key_dev_<you>" not found`; copy that folder from a checkout
where it works (the Worker stopped). On macOS the token lives in the login keychain, so Doppler only works in a
signed-in session.

## Signing in while you work

Nobody signs in by hand on a dev stage. Every stage but prod has dev sign-in (`apps/worker/src/dev.ts`), turned
on by `DEV_SIGN_IN_TOKEN` in Doppler `dev`, the way T3 Code's reusable dev credential works:

- **A browser:** `vp run dev:sign-in --stage pr-12` prints a link. Open it once, in your browser or the agent's,
  and you're the fictional fixture student (`ada.okafor@example.edu`). `--as <tag>` gives a separate fresh
  account (`ada.okafor+<tag>@example.edu`); `--next /path` picks where it lands.
- **An agent or script calling `/mcp`:** `vp run dev:token --stage pr-12` prints a one-hour access token.
- **Passkeys and approvals:** a dev session starts with no passkey. Add one on `/account` with Chrome's virtual
  authenticator (DevTools → More tools → WebAuthn) or a real one; on a fresh `--as` account the first one can
  approve at once, as on any new account. `vp run e2e` does this on its own.

The token rides in the link's `#fragment`, which the browser never sends, so request logs never see it, and the
page drops it from the address bar. Your browser's own history may still keep the link, so treat it like a password and never paste one into an issue, PR or chat. Prod has none: the
token is never bound there, the Worker refuses `/dev/` on prod anyway, and the deploy doctor fails if the prod
Worker ever has it bound.

## Reference repos

`.repos/` holds shallow checkouts of the libraries we lean on, so agents can read real source instead of
guessing: `effect` and `alchemy` (each at the tag of the version we install), `better-auth`, and `t3code`
(for the renderer glue we copy). `.repos/` is gitignored, excluded from lint, format, tests and editor
search, and never imported.

## Dev container

`.devcontainer/` mirrors CI: Ubuntu, Node 26, `vp`, and `gh`. Open the repo in a container and it runs
`vp i` for you.

## Never

- Deploy `prod` from a laptop, or point a dev stage at prod resources.
- Use real personal data in code, fixtures, evals, screenshots or issues. Use the fictional fixture student.
- Read a base id from a URL. It comes from the session or token.
