---
name: doctor
description: Diagnose what's broken, from evidence. A dev environment (missing tools, uninstalled hooks, failed installs, checks that fail before any change), or a deployed stage failing for users ("can't sign in", "Something went wrong", a 500, an error ref). Use when setup, `vp i`, `vp check` or tests fail for reasons unrelated to the code being changed, or when someone reports prod or a preview misbehaving.
---

# Doctor

## A dev environment

1. Run `vp run doctor`. Fix every `FAIL` line with the fix it prints; `warn` lines are optional.
2. Still broken? Check, in order:
   - `vp i` output: pnpm 12 blocks build scripts except the ones in `allowBuilds` (pnpm-workspace.yaml).
     Add a package there only if it truly needs its install script.
   - `node --version` is 26 or newer (`mise use node@26`).
   - `git config core.hooksPath` points at `.vite-hooks` (`vp config --no-agent` sets it).
   - Typecheck errors in files you didn't touch: run `vp run typecheck` on a clean `main` to see if they
     predate you. If so, say so; don't fix unrelated code in your PR.
   - Lint errors from `brainiac/*` rules: read the rule in `oxlint-plugin-brainiac/rules/`; its test shows
     what passes.
3. Report what was wrong and what fixed it. If the fix is a repo change (a missing `allowBuilds` entry, a
   doctor check that should exist), open an issue or include it in your PR.

## A deployed stage

Work from the logs, not from guesses. Read-only throughout: never deploy prod, never write to its data.

1. **Get the facts.** Which stage (`prod`, `pr-<n>`, `live_<you>`), which hostname, roughly when, what the
   person did, and the error text. "Something went wrong" from a site page ends with `ref <id>`: that is the
   request's Cloudflare ray id. Ask for a screenshot if there isn't one.
2. **Check what's deployed.** `gh run list --branch main --limit 5` (prod) or the PR's checks: did the last
   deploy succeed, and was it before or after the failure? Probe the stage without signing in:
   `/health`, `/health/db`, `/sign-in` (real Turnstile key on prod, the email form, the social buttons),
   `/.well-known/oauth-authorization-server`.
3. **Read the logs.** `vp run logs --stage <stage> --ray <ref>` shows every line of that request;
   `vp run logs --stage <stage> --since 2h` lists every failed request in the window, with its log lines and
   exceptions. Without a ref, find the request by time and path. When stored logs aren't readable (see
   `CLOUDFLARE_LOGS_TOKEN` in [infra/README.md](../../../infra/README.md)), run
   `vp run logs --stage <stage> --tail` and have the person retry while it runs.
4. **Map it to source.** Find the logged message in `apps/worker/src` or the library that threw it
   (`.repos/better-auth`, `node_modules/<pkg>/dist`). Confirm the cause in code before naming it.
5. **Check it's known.** `gh issue list --search "<message>" --state all`, and recent commits touching that
   path (`git log --oneline -10 -- <path>`).
6. **Report.** The cause with the log line that proves it, the fix (a config or Doppler change for the owner,
   or a code change with a test that fails on `main`), and anything you couldn't check. If it needs an
   issue, write it as a brief (see the `triage` skill).

Logs hold real people's data. Quote only the lines that prove the cause, and replace emails, names and
tokens with placeholders before pasting them anywhere: an issue, a PR, a commit, a chat.
