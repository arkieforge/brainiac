# Open decisions

- **Domain**: pick and register a domain for Brainiac, and check trademark clashes before launch.
- **Open source**: the CLI, `packages/core` and `packages/base` as MIT (recommended), the Worker closed.
- **Hold window default** for agent changes to existing values: 3 days (recommended), 0, or "always a proposal".
- **Who first**: students applying abroad (fits applications and documents) or developers wiring agents (fits MCP).
- **EU residency at launch**, or later.
- **Auth**: Better Auth self-hosted in the Worker (recommended: $0, one passkey system for sign-in and approvals, no beta dependency), Neon Managed Better Auth (free to 60k users, Neon runs the OAuth server, but no passkeys and its MCP support is a new beta, so approvals would keep their own passkey check), or WorkOS AuthKit (free to 1M users, a card on file for production, managed).
