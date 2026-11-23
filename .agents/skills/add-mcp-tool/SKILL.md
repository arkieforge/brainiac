---
name: add-mcp-tool
description: Add or change a Brainiac MCP tool (a new tool, an argument, a result, or a description's wording), reaching every place the change has to and proving it. Use whenever packages/base/src/tools.ts or what an agent gets from a tool changes.
---

# Add or change an MCP tool

Every tool's text, schema and logic live in `packages/base/src/tools.ts`, and both transports serve that one
module: `/mcp` through the Base DO, and `brainiac mcp serve`, which forwards to `/mcp` online and answers from the
laptop's copy offline. Logic anywhere else exists on one surface only. Read
[the agent interface](../../../docs/internals/agent-interface.md) and
[the contract](../../../docs/internals/contract.md) first; the contract wins.

## Where it has to reach

1. **Logic** in `packages/base/src`, as a function over `Sql`, exported from `src/index.ts`. Reads go through
   `project`; changes go through `mutate` or `mutateAll` (`mutate.ts`), which apply the hold, the approval list
   and the audit for you. If the site needs it too, the DO method in `apps/worker/src/base.ts` calls the same one.
2. **The tool** in `tools.ts`: `tool(description, schema, run)`, listed in `TOOLS`. Thin: parse, call the logic,
   map the result with `outcome`. Schemas are arktype with `"+": "reject"`, optional arguments as
   `"name?": "T | null"`, since models send null for what they leave out.
3. **Levels.** A read connection's change answers `READ_ONLY`; at propose level a note change generally becomes a
   proposal, but check the tool's own rule (`add` writes an inbox item directly; `organize` refuses propose level). A
   background run is narrowed already (`inBackground`), but decide whether it may call the tool at all: for example
   `add`, `import`, `organize` and `update`'s `withdraw` refuse `ctx.background` (see "Filer access" in
   [security](../../../docs/internals/security.md)).
4. **Approvals.** Anything on [the approval list](../../../docs/internals/contract.md#4-what-always-needs-your-approval)
   answers `needsApproval` with its link (`approval` in `tools.ts`), and the retry with `approval_id` applies it
   once. `mutate` does this for note changes; a new kind of risky action needs its plan through `settle` and `pend`
   in `approvals.ts`.
5. **Offline.** Put the name in `OFFLINE_READS` (the copy can answer) or `ONLINE_READS` (a read that needs the
   record). Anything in neither is refused offline as a write.
6. **Tests.** Behaviour as cases in `packages/base/test/tool-cases.ts` (run on bun:sqlite and in a DO). The MCP
   contract layer, `apps/worker/src/auth/auth.test.ts` ("MCP clients"), already holds every tool to its listed
   schema and description; extend it only for transport behaviour. Offline stdio answers: `apps/cli/test/cases.ts`.
7. **Docs.** The tool's row in `docs/internals/agent-interface.md`, and its levels table if who may call it changed.
8. **The agent skill**, `apps/cli/plugin/skills/brainiac/SKILL.md`, only for a rule the description can't carry.
9. **An eval case** when the change is about how models use a tool: `evals/mcp-tool-use/cases.ndjson` plus its row
   in `cases.test.ts` ([evals/README.md](../../../evals/README.md)). A fix for a model's mistake starts with a `bad`
   case that fails on the old text.
10. **The context budget.** Run `vp test run evals/shared/context-budget.test.ts -u` and commit
    `evals/context-budget.json`. CI fails a total above main's unless a maintainer adds the `context-increase`
    label, so the PR says why it grew.

## Prove it

```sh
vp test run packages/base/test/engines.test.ts -t "<case name>"  # the tool's cases on both engines
vp test run apps/worker/src/auth/auth.test.ts                     # /mcp and stdio: same tools, same answers
vp test run apps/cli/test/daemon.test.ts                          # offline answers over stdio
vp run eval:mcp-tool-use --out evals/runs/<name> --case <id>      # a real model; --dry-run checks the setup
vp run bench                                                      # a read's p95 against the quality bar
```

## Traps

- Every session loads every description and schema, and they are what models follow. Say when to use the tool and
  the next step after each outcome; cut everything else. Wording is proved by evals, not unit tests.
- `callTool` is one synchronous transaction: no `await` inside a tool. I/O happens in the DO around the call (the
  question embedded before, a photo's bytes after) or through the jobs outbox (`jobs.ts`).
- A tool that searches by meaning names its question in `questionOf`, or the cloud never embeds it and its search
  is keyword-only.
- A note the caller can't see reads exactly like a missing one, and a refusal never names another note's path.
  Text from files, emails and pages goes back marked `untrusted`.
- `{ ok: false }` is for a malformed call. A refusal the agent should act on is a value with a message and the
  next step, like `READ_ONLY`. A thrown error reaches the agent as a fixed message, never its own text.
