# Security

Brainiac will hold people's grades, IDs and documents, so we take reports seriously.

## Reporting

Report privately through GitHub: [**Security → Report a vulnerability**](https://github.com/arkieforge/brainiac/security/advisories/new).
Never in a public issue, PR or comment. Include what you found, how to reproduce it, and what an attacker
could do with it.

We reply within a week, keep you updated in the advisory until it is fixed, and credit you in it if you want.

## In scope

- Anything that breaks [the contract](../docs/internals/contract.md): reading or changing another person's
  record, a base id taken from a URL, an agent receiving a secret's value, or a change on the approval list
  going through without a passkey.
- The Worker, the `Base` Durable Object, its routes and MCP tools, the daemon and the CLI.
- This repo's CI and deploy workflows, e.g. a pull request that can reach deploy secrets.
- Design flaws in [docs/internals/security.md](../docs/internals/security.md), even before the code exists.

## Out of scope

- Denial of service, load testing, spam and social engineering.
- Bugs in Cloudflare, Neon, GitHub or other providers. Report those to them.
- Scanner output without a working impact on Brainiac.

## Testing rules

Use your own account and the fictional fixture student. Never access, change or keep anyone else's data;
if you reach some, stop and tell us in your report.
