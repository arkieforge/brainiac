# Brainiac

Brainiac keeps a person's whole record (achievements, projects, papers, grades, test scores, CVs, letters,
IDs, profiles, links) as typed markdown notes with sources, for admissions, study abroad, scholarships and
jobs. It syncs live between the site, phones and laptops, and people run it with the Claude they already
pay for, through MCP. Brainiac itself runs no model.

## What we never compromise on

1. **Correct facts.** A number or date we show comes from a stored field, and values nobody checked say
   so. When unsure, we ask the person instead of guessing.
2. **Your data stays yours.** One database per person, permissions checked on every read surface,
   secrets never shown to agents, risky changes approved with a passkey. See
   [The contract](docs/internals/contract.md); it wins over every other doc.
3. **Subscription first, cheap infrastructure.** All model work runs in the user's own agent. We never
   add a paid SaaS where Cloudflare or a few lines of code will do, and never downgrade models to save money.
4. **Simple.** Fight scope creep. Do not keep complexity because it exists, and do not add machinery
   because it looks impressive. Find the real constraint, then the smallest model that makes the right
   behaviour unsurprising.

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

## Verifying

- Before you push: `vp check`, `vp test run`, `vp run typecheck` and `vp run knip`, the same checks CI runs.
- While you iterate: `vp test run <files>`, `vp run typecheck` (`effect-tsgo`, cached per package).
- Test behaviour that can break: sync and merges, permissions and approvals, parsing, migrations, the logic a
  bug fix changed. Skip tests for what types guarantee, copy text, and mock-call mirrors.
- Extend an existing test before adding one. Test at the lowest layer that fails on `main`.
- No sleeps, polling loops, retries or per-test timeouts. A skipped test needs
  `// quarantine: #<issue> <why>` on the line above (lint enforces it).
- A bug fix starts with a test that fails on `main`.
- `vp run doctor` when something about the environment looks wrong.

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
  available, report it; don't substitute. Stop at 9.5 from every member.
- **PRs** (`file-pr`): conventional titles, the problem first, how it was proved. No AI attribution lines.
- **Merging**: squash. `main` has no branch protection yet, so CI green plus the merge gate in `full-send`
  is the bar.
- **Babysitting**: no review bots are installed yet; CI is the only check.

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
- No AI attribution anywhere: no co-author lines, no "generated with" footers.

## Documentation

Most changes need no doc change. Follow [the doc rules](docs/README.md#writing-docs): internals hold
decisions, constraints and traps; rewrite outdated text instead of appending.

## Where code lives

- `alchemy.run.ts`: every cloud resource, per stage (Alchemy pinned to 0.94; its source is in
  `node_modules/alchemy/src`).
- `apps/worker`: the one Worker and the `Base` Durable Object.
- `packages/*`: shared code, added by the issues that need it.
- `oxlint-plugin-brainiac/`: repo lint rules, each with tests. `scripts/`: doctor, setup, repo sync.
- `.repos/`: read-only library source for reference (`vp run repos:sync`). Never import from it.
- [docs/](docs/README.md): product, internals, operations. The tracker is GitHub issues by milestone.

## Taste

TypeScript that Matt Pocock would approve of: inferred types, no `any`, no casting wrappers. Effect for
server and script code where it removes real error-handling and resource code, not for its own sake.
Comments say why, not what.
