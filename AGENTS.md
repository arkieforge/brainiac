# Brainiac

Brainiac keeps a person's whole record (achievements, projects, papers, grades, test scores, CVs, letters,
IDs, profiles, links) as typed markdown notes with sources, for admissions, study abroad, scholarships and
jobs. It syncs live between the site, phones and laptops, and people run it with the Claude they already
pay for, through MCP. Brainiac itself runs no model.

## What makes Brainiac special?

People trust Brainiac with the record that decides their admissions, scholarships and jobs. Here's what we
can never compromise on.

### 1. Correct facts

A number or date we show comes from a stored field, and values nobody checked say so. When unsure, we ask
the person instead of guessing. A wrong CGPA on an application is worse than no answer.

### 2. Your data stays yours

One database per person, permissions checked on every read surface, secrets never shown to agents, risky
changes approved with a passkey. See [The contract](docs/internals/contract.md); it wins over every other
doc.

### 3. Your Claude does the work

All model work runs in the user's own agent, on their subscription. We never add a paid SaaS where
Cloudflare or a few lines of code will do, and never downgrade models to save money.

### 4. Open at the core

Brainiac is built in the open at `arkieforge/brainiac`: the roadmap, the reasoning in `docs/`, and all the
code. Work stays public; only personal data never is.

### 5. Fast, with numbers

Every main path has a p95 target in the [quality bar](docs/operations/quality-bar.md), such as a
returning user's first screen and an edit reaching another tab or phone in under 300 ms. Regressions usually come from sending too much
over the sync socket, awaiting I/O inside a mutation, or waking a cold DO for work that could wait. Make sure
every change is considerate of that budget.

### 6. Cloud or local, same product

Cloud is the full product; a local copy on a laptop is an option on top. Tool names, answers and rules are
the same in both, and offline answers say they are keyword-only. A feature that works in one mode and not
the other is unfinished. See [Two modes](docs/product/overview.md#two-modes-every-feature-in-each).

### 7. Multi-surface

Brainiac has four ways in: the **site** (desktop and phone browsers, live over one WebSocket), the
**laptop** (`brainiac` CLI and daemon keeping a folder in sync), **agents** (remote MCP at `mcp.<domain>`,
or `brainiac mcp serve` over stdio), and the **browser extension** (form fill and save link). New features
need a decision for each, even if the decision is "not here".

## A note from Siam

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just
because it already exists. Do not introduce machinery because it looks architecturally impressive.
Understand the real constraint, then fight for the smallest model that makes the correct behavior
unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both
a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think
of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be
able to override anything here.

Of note: most Brainiac contributions come from agents in T3 Code, often controlled remotely from a phone. Be
careful about accessing data, killing dev servers, and anything else that may damage the machine the
contributor is working from.

## Glossary

- **you**: the agent changing this repo. **we**: the maintainers. **user**: a person with a record.
- **record** (or **base**): one person's notes and files; one Durable Object each.
- **note**: one markdown file with typed front-matter. **type**: its schema (Role, TestScore, ...).
- **connection**: an agent or CLI's access to a record, with a level (read, propose, write) and scopes.
- **proposal**: a change waiting for the person; **held** proposals apply on their own after the hold window.
- **approval**: a passkey signature over the exact change, required for the list in the contract.
- **local copy**: a laptop folder kept in sync by the daemon.

## The ways to hurt yourself

1. **Deploying prod.** Never run `vp run deploy --stage prod` or point a dev stage at prod resources.
   Prod deploys go through CI.
2. **Real personal data.** Never put a real person's data in code, fixtures, evals, screenshots, issues or
   PRs. Use the fictional fixture student.
3. **Trusting the URL.** A base id comes from the session or token, never from a path or query string.
4. **Writing around the record's checks.** Every change goes through the DO's mutation path; never edit
   storage, R2 or another person's object directly.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before
calling work done, walk this list and say which entries applied:

- **Surfaces.** Site, laptop, agents, extension (above). Fixing the site editor is not fixing the feature.
- **Modes.** Cloud, local copy, and offline. The local copy runs the same queries through `packages/base`,
  so logic belongs there, not in the Worker.
- **Agents.** Anything a user can do, their Claude should reach through the MCP tools. That only works when
  it is a DO method, not handler code. Adding a tool changes the [agent interface](docs/internals/agent-interface.md).
- **Permissions.** Every new read path goes through the connection's level, scopes and filter. Sensitive
  notes are never cached or synced to a device the user didn't mark as theirs; there they load on demand.
- **Approvals.** If the change can do something on the contract's approval list, it returns `needsApproval`.
- **Sync.** Two tabs, a phone and a daemon editing at once, one of them offline. Merges are tested, not hoped.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Archive needs restore.
  Propose needs reject. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance inaccurate, then apply the doc rules below.

## Dev servers

- Worktrees run `scripts/setup-worktree.ts` from `t3.json`. If module resolution looks broken, it probably
  didn't run; `vp run doctor` says what's missing.
- `vp run dev` starts the Worker on `localhost:1337` against your own Neon branch. Secrets come from
  Doppler, never `.env` ([Development](docs/operations/development.md#secrets)).
- Stop what you started, by the task you started it with. Run dev servers from your own shell so they end
  with your session; don't detach them with `nohup`, `setsid` or `tmux` unless asked.
- Need a second checkout? `git worktree add` it next to this one, not in `/tmp`. Remove it when done.
- Never ask a person to sign in for you. `vp run dev:sign-in --stage <stage|local>` gives a link that signs a
  browser in as the fixture student, and `vp run dev:token` an `/mcp` token
  ([Signing in](docs/operations/development.md#signing-in-while-you-work)). Prod has neither.

## Verifying

- Before you push: `vp check`, `vp test run`, `vp run typecheck` and `vp run knip`, the same checks CI runs.
- While you iterate: `vp test run <files>`, `vp run typecheck` (`effect-tsgo`, cached per package).
- Test behaviour that can break: sync and merges, permissions and approvals, parsing, migrations, the logic a
  bug fix changed. Skip tests for what types guarantee, copy text, and mock-call mirrors.
- Extend an existing test before adding one. Test at the lowest layer that fails on `main`.
- No sleeps, polling loops, retries or per-test timeouts. A skipped test needs
  `// quarantine: #<issue> <why>` on the line above (lint enforces it).
- A bug fix starts with a test that fails on `main`. A purely visual bug gets before/after screenshots
  instead.
- `vp run doctor` when something about the environment looks wrong.
- Something broken on a deployed stage (a failing preview, a user's error or `ref`, a 500): use the
  [`doctor`](.agents/skills/doctor/SKILL.md) skill before guessing. It starts from
  `vp run doctor --stage <stage>` and `vp run logs --stage <stage>`. CI runs the same doctor after every
  deploy and puts it in the job summary; a `FAIL` there fails the job, and babysitting the PR picks it up.

## Evals

`evals/` checks how real models behave with Brainiac's model-facing text: MCP tool descriptions and
schemas, the skill, prompts. Read [evals/README.md](evals/README.md) before changing that text, and add a
case that fails before a fix.

## Workflow skills (tstack)

The team uses [tstack](https://github.com/t3dotgg/tstack) in both Claude Code and Codex:

```sh
git clone https://github.com/t3dotgg/tstack
cp -R tstack/skills/* ~/.claude/skills/   # Claude Code
cp -R tstack/skills/* ~/.codex/skills/    # Codex
```

Settings for this repo, which the skills read from here:

- **Proof** (`full-send`, `full-stop`): run the repo's verification skill,
  [`test-brainiac`](.agents/skills/test-brainiac/SKILL.md). Its table maps each kind of change to the
  command and evidence that prove it. Minimum: `vp check && vp run typecheck && vp test run && vp run knip`.
- **Council**: the newest Claude Opus, GPT Sol and Gemini Pro at high effort. If a provider isn't
  available, report it; don't substitute. Stop at 9.5 from every member. Issues labelled `council` run
  the council skill to 9.5 before the PR; others use `sol-loop`.
- **PRs** (`file-pr`): conventional titles, the problem first, how it was proved. No AI attribution lines.
- **Merging**: squash. `main` has no branch protection yet, so CI green plus the merge gate in `full-send`
  is the bar.
- **Babysitting**: no review bots are installed yet; CI and CodeQL code scanning are the checks.

Repo skills live in `.agents/skills` (Codex reads them there; `.claude/skills` links to the same folder):
`triage`, `test-brainiac`, `doctor`.

## Issues are briefs

Every issue is written as a prompt you can act on cold: context links, goal, what ships, out of scope,
where, depends on, rules, verify, done when, how it breaks. Read the linked docs before writing code, and
check its "Depends on" issues are closed. When you open an issue, write it the same way (the feature
template asks for each part).

## Pull requests

- Only open a PR when asked. One request, one PR. Conventional, plain titles:
  `fix(sync): retries no longer double-apply`.
- Body: the problem in a sentence or two, then how you fixed it, then how you proved it.
- Any change a user can see needs proof in the PR body, captured from the real app:
  - **Static UI** (layout, spacing, colour, copy): before and after screenshots, same viewport and data.
  - **Motion or behaviour** (animations, transitions, a flow, an interaction, live sync between devices):
    a video of before and after, recorded at the real frame rate, long enough to show the whole change.
  - Both embedded inline in the PR so a reviewer sees them without downloading. Upload them to GitHub;
    never commit PR-only assets. Use the fixture student, never real data.
  - If you can't capture it, say so in the PR and don't call it done.
- No AI attribution anywhere: no co-author lines, no "generated with" footers.

## Documentation and work artifacts

Most changes need no doc change. Follow [the doc rules](docs/README.md#writing-docs): internals hold
decisions, constraints and traps; rewrite outdated text instead of appending.

Don't commit plans, research notes or scratch files. Active work lives in its GitHub issue, and a merged PR
is the record of what shipped.

## How it works

One Worker serves every hostname. Each record is a `Base` Durable Object with its own SQLite: notes, the
change feed, approvals, search and live WebSockets. Every mutation is one transaction that assigns the next
`seq` and never awaits outside I/O; follow-up work (extract, embed, render) goes through a jobs outbox, and
results install only if the note revision still matches. Neon holds what's shared across users, R2 holds
files. Details: [Architecture](docs/internals/architecture.md), [Sync engine](docs/internals/sync-engine.md).

## Where code lives

- `alchemy.run.ts`: every cloud resource, per stage (Alchemy 2.0, pinned to one beta; its source is in
  `node_modules/alchemy/src` and `node_modules/@alchemy.run/*/src`). [infra/README.md](infra/README.md) has
  the stages, secrets and prod guards.
- `apps/worker`: the one Worker and the `Base` Durable Object.
- `packages/*`: shared code, added by the issues that need it.
- `oxlint-plugin-brainiac/`: repo lint rules, each with tests. `scripts/`: doctor, setup, repo sync.
- `.repos/`: read-only library source for reference (`vp run repos:sync`). Never import from it.
- [docs/](docs/README.md): product, internals, operations. The tracker is GitHub issues by milestone.

## Taste

- TypeScript that Matt Pocock would approve of: inferred types, no `any`, no casting wrappers.
- Effect for server and script code where it removes real error-handling and resource code, not for its own
  sake.
- Complexity belongs at the edges. The DO's mutation path stays pure and ordered; the UI stays dumb.
- Transports stay thin. An HTTP route, sync message or MCP tool decodes input, calls one method on the
  record, and maps errors.
- Comments say why, not what.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
