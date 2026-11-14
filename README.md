# Brainiac

Your whole record, ready for every application.

Brainiac keeps everything an application asks for (achievements, projects, papers, grades, test scores,
CVs, recommendation letters, IDs, profiles and links) as typed markdown notes with sources. It syncs live
to the site, phones and any laptop that keeps a local copy, and people manage it with the Claude they
already use (Claude Code, claude.ai, T3 Code) through MCP. Brainiac runs no model of its own and needs no
API key.

- **Plan**: [`docs/plan.html`](docs/plan.html) (open it in a browser). "The contract" section wins over
  everything else.
- **Tracker**: issues grouped by milestone (M0 record + sync, M1 retrieval + filing + trust,
  M2 applications, M3 hands-off) with an epic per milestone.
- **Stack**: Cloudflare Workers, Durable Objects (one per record, SQLite), R2, Queues and Workflows; Neon;
  self-hosted Better Auth; deployed with [Alchemy](https://alchemy.run). TypeScript throughout.

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm dev        # local stack via Alchemy (needs Cloudflare credentials for remote-only resources)
```

See [`AGENTS.md`](AGENTS.md) for commands and rules, and [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
workflow.

## Status

Planning is done; M0 has started. Nothing is deployed yet.
