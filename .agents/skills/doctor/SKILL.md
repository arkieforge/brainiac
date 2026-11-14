---
name: doctor
description: Diagnose a broken Brainiac dev environment: missing tools, uninstalled hooks, failed installs, typecheck or lint that fails before any change. Use when setup, `vp i`, `vp check` or tests fail for reasons unrelated to the code being changed.
---

# Doctor

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
