---
name: test-brainiac
description: Prove a Brainiac change works: pick the right checks for the files you touched, run them, and capture the evidence for the PR. Use before calling work done or when asked to verify, test or prove a change.
---

# Test Brainiac

Proof is output you saw yourself in this session. Match the proof to the change:

| You changed                                   | Run                                                                                                                                | Evidence                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Any code                                      | `vp check` and `vp test run <files you touched>`                                                                                   | The command output                            |
| Before a push                                 | `vp run check:changed`: CI's checks for what the branch changed                                                                    | The command output                            |
| A site component's behaviour (focus, keys)    | `vp run test:browser`: `apps/web/src/**/*.browser.test.tsx` in headless Chromium                                                   | Output                                        |
| Types, schemas, tool descriptions             | `vp run typecheck`                                                                                                                 | Output                                        |
| A bug                                         | A test that fails on `main`, then passes                                                                                           | Both runs                                     |
| Sync, merges, approvals                       | `vp test run packages/sync packages/core/src/merge.test.ts`                                                                        | Output, including the seed on failure         |
| `packages/base` (SQL, migrations)             | `vp test run packages/base`: every case on bun:sqlite and in workerd                                                               | Output                                        |
| The Worker or DO                              | `vp test run apps/worker`: the real Base DO and queue in workerd                                                                   | Output                                        |
| The CLI daemon (`apps/cli`)                   | `vp test run apps/cli`: the daemon in Bun on the real filesystem                                                                   | Output, on macOS and Linux                    |
| Model-facing text (MCP tools, skill, prompts) | The eval cases that cover it (`evals/README.md`)                                                                                   | The run's `summary.md`                        |
| A UI, static                                  | Run it and look: screenshots before and after, same viewport                                                                       | Both images inline in the PR                  |
| Motion, a flow, or any visible behaviour      | Run it and record before and after                                                                                                 | Both videos inline in the PR                  |
| Lint rules                                    | `vp test run oxlint-plugin-brainiac`                                                                                               | Output                                        |
| `alchemy.run.ts`                              | `vp run plan --stage <stage>`, then the PR stage deploy in CI                                                                      | The plan, the CI job summary                  |
| Sign-in, the account page, anything behind it | `vp run e2e --stage pr-<n>` (CI runs it on every preview); for a look yourself, `vp run dev:sign-in --stage pr-<n>` in the browser | The e2e output; screenshots with `--evidence` |
| A bug a person sees on the site               | A scenario in `scripts/scenarios`, then `vp run scenarios:prove <scenario> --stage pr-<n>`: fails on `main`, passes on the fix     | The prove output                              |
| Anything a signed-out visitor reaches         | After the preview deploys: `vp run doctor --stage pr-<n>`, then use it, then `vp run logs --stage pr-<n> --since 30m`              | Doctor output; no failed requests             |

## Rules

- Use the fixture student's data. Never a real person's.
- Don't deploy `prod`. Don't point a dev stage at prod resources.
- A flaky test is fixed, not retried. A skipped test needs `// quarantine: #<issue> <why>`.
- If you can't prove a change, say so in the PR and don't call it done.
