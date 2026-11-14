---
name: test-brainiac
description: Prove a Brainiac change works: pick the right checks for the files you touched, run them, and capture the evidence for the PR. Use before calling work done or when asked to verify, test or prove a change.
---

# Test Brainiac

Proof is output you saw yourself in this session. Match the proof to the change:

| You changed                                   | Run                                                                 | Evidence                              |
| --------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| Any code                                      | `vp check` and `vp test run <files you touched>`                    | The command output                    |
| Types, schemas, tool descriptions             | `vp run typecheck`                                                  | Output                                |
| A bug                                         | A test that fails on `main`, then passes                            | Both runs                             |
| Sync, merges, approvals                       | The property tests for that module                                  | Output, including the seed on failure |
| The Worker or DO                              | `vp test run apps/worker`, and the Workers test pool once it exists | Output                                |
| Model-facing text (MCP tools, skill, prompts) | The eval cases that cover it (`evals/README.md`)                    | The run's `summary.md`                |
| A UI                                          | Run it and look: screenshots before and after                       | Images in the PR                      |
| Lint rules                                    | `vp test run oxlint-plugin-brainiac`                                | Output                                |
| `alchemy.run.ts`                              | `effect-tsgo tsc -p .` locally; a PR stage deploy in CI once wired  | Output, plan diff                     |

## Rules

- Use the fixture student's data. Never a real person's.
- Don't deploy `prod`. Don't point a dev stage at prod resources.
- A flaky test is fixed, not retried. A skipped test needs `// quarantine: #<issue> <why>`.
- If you can't prove a change, say so in the PR and don't call it done.
