# Brainiac docs

Start with [The contract](internals/contract.md). When any other page seems to disagree, the contract wins.

## Product

What Brainiac is for and what it does.

- [Overview](product/overview.md): who it's for, what makes it different, the two modes
- [Onboarding](product/onboarding.md)
- Features: [applications](product/features/applications.md), [projects, profiles and links](product/features/projects-profiles-links.md), [viewer](product/features/viewer.md), [overview and review](product/features/review.md), [questions](product/features/questions.md), [customization](product/features/customization.md)
- [Roadmap](product/roadmap.md), [pricing](product/pricing.md), [open decisions](product/decisions.md)

## Internals

Decisions and constraints that span components, and the traps that are hard to see in the code.

- [The contract](internals/contract.md): authority, models, permissions, approvals, privacy, retention
- [Architecture](internals/architecture.md): one Durable Object per record, Neon, R2, the jobs outbox, caching
- [Record format](internals/record-format.md): the OKF bundle, files, the knowledge graph, structure that grows
- [Sync engine](internals/sync-engine.md): protocol, merge rules, the local daemon
- [Retrieval](internals/retrieval.md): authorization projection, ingest, search, verify
- [Agent interface](internals/agent-interface.md): the 14 MCP tools, the filter, levels
- [Data model](internals/data-model.md), [Security and privacy](internals/security.md), [Failure modes](internals/failure-modes.md)

## Operations

How we build, check and run it.

- [Development](operations/development.md): setup, commands, worktrees, the dev container, reference repos
- [Quality bar](operations/quality-bar.md): tests, evals, release gates, cost and latency targets
- [Services](operations/services.md): what we buy, what goes through treg, what waits

## Writing docs

- Most code changes need no doc change. Agents can read the code.
- `internals/` holds decisions with their reasons, constraints across components, and traps the source
  doesn't show. Before adding a paragraph, ask what a maintainer would get wrong without it.
- Don't list fields or methods, narrate control flow, keep file catalogs, or append PR summaries.
- When a documented decision changes, rewrite or remove the old text. Don't append a second account.
- No em dashes. Plain words. Link to source instead of copying it.
