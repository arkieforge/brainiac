---
name: debug-sync
description: Reproduce and fix a Brainiac sync bug (a lost or doubled edit, devices that don't converge, a wrong conflict, a tab or laptop stuck), from a failing seed or a report to a focused test that fails on main. Use for bugs in packages/sync, the record's serve, the merge rules, the DO's sockets or the CLI daemon.
---

# Debug sync

Read [the sync engine](../../../docs/internals/sync-engine.md) first. Its rules (exactly once and in order, every
result uses up its number, nothing dropped silently) are what your test asserts.

## Pick the lowest layer that fails

| Layer                                       | Code                                                       | Tests                                                           |
| ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Merge rules                                 | `packages/core/src/merge.ts`                               | `packages/core/src/merge.test.ts`                               |
| Edits that keep every other byte            | `packages/core/src/patch.ts`                               | `packages/core/src/patch.test.ts`, `patch.property.test.ts`     |
| The record's `serve` and the client         | `packages/base/src/sync.ts`, `packages/sync/src/client.ts` | `packages/sync/test/chaos.test.ts`                              |
| A client's store (IndexedDB and `state.db`) | `packages/sync/src/browser.ts`, `store.ts`                 | `packages/sync/test/cases.ts`, run on both by `stores.test.ts`  |
| The DO's sockets, sign-in and pushes        | `apps/worker/src/base.ts`, `devices.ts`                    | `apps/worker/test/sync.test.ts`, the real DO in workerd         |
| The daemon on a real filesystem             | `apps/cli/src/daemon.ts`, `disk.ts`, `swap.ts`             | `apps/cli/test/cases.ts`, run by `daemon.test.ts` in pinned Bun |

## From a failure to a test

1. **The property test** is `packages/sync/test/convergence.test.ts`: three devices (up to five with cloned state)
   over three notes, 30 to 200 random steps of edits, deletes, creates, out-of-order delivery, dropped links and
   half-written saves, 100 runs for each way of starting. On failure fast-check prints
   `{ seed: ..., path: "...", endOnFailure: true }` and the shrunk steps.
2. **Replay it.** Add those three to that test's `fc.assert` options beside `numRuns`, then
   `vp test run packages/sync/test/convergence.test.ts -t "<mid-handshake or in sync, from the failing name>"`. It
   runs the shrunk case alone. Don't commit the seed.
3. **Pin it.** Write the shrunk steps as a named test with `World` (`packages/sync/test/sim.ts`): `seed` notes, add
   `device`s, deliver with `up` and `down` (a `pick` reorders), `disconnect`, `connect`, `later` for the purge, and
   `settle`. It goes in `chaos.test.ts`, or `cases.ts` when the store matters. Assert the rule that broke
   (converged, the value kept, nothing reverted), not internals, and see it fail on main.
4. **Go lower** if you can: a wrong merge reproduces with three strings in `merge.test.ts`.
5. **Only in workerd** (the socket's actor, a push to the wrong socket, a grant change): `apps/worker/test/sync.test.ts`.
   Its `device` helper waits for a message the client handled; wait on that, never on time.
6. **Only on disk** (editor saves, the atomic swap, moves, the mass-change pause): a case in `apps/cli/test/cases.ts`.
   `apps/cli/node_modules/.bin/bun apps/cli/test/bun.ts "<part of its name>"` runs just that case; CI runs them all
   on Linux and on Windows, minus `NOT_ON_WINDOWS`.

## Prove it

```sh
vp test run packages/sync packages/core/src/merge.test.ts   # property, chaos and store cases
vp test run apps/worker/test/sync.test.ts                   # the DO's sockets in workerd
vp test run apps/cli/test/daemon.test.ts                    # the daemon on a real filesystem
```

## Rules and traps

- No sleeps, polling loops, per-test timeouts or retries: `brainiac/no-real-time-in-tests`,
  `no-polling-loop-in-tests` and `no-test-timeout-or-retry` fail lint, and `vite.config.ts` sets `retry: 0`. Move
  time with `World.later` or fake timers; await the message or promise itself.
- A flaky sync test is a race in the code until proved otherwise. Fix it; quarantine only with
  `// quarantine: #<issue> <why>`.
- Don't cut `numRuns` or the step counts to make a run pass: a planted stale-snapshot bug first failed at run 109
  of 200.
- Fix it once in shared code. The site and the daemon run the same `SyncClient`, and the record the same `serve`
  in the DO and in the simulator, so a fix in one app leaves the other broken.
- A protocol change (`packages/core/src/protocol.ts`) meets tabs and CLIs still sending the old messages, and every
  message is checked on arrival.
- If the property test missed the bug, add the invariant it broke to its asserts too.
