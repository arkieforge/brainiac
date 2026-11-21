# Pricing

| Plan     | Price      | Includes                                                                                    |
| -------- | ---------- | ------------------------------------------------------------------------------------------- |
| **Free** | $0         | Site, sync, a local copy, local and remote MCP, 300 notes, 200 MB of files                  |
| **Pro**  | $6 a month | Unlimited notes and devices, 10 GB, applications, CVs and packets, connectors, drift checks |

Polar takes the payment as merchant of record. The record enforces Free's note and file limits once a stage takes
payment (`packages/base/src/plan.ts`); the rest of Pro's list isn't held back from Free yet.

Because thinking runs on the user's own subscription, every plan's cost is infrastructure only. Nearby products: Supermemory and Mem0 (untyped memory for agents), GBrain and Basic Memory (personal markdown with MCP, no hosted product for others). None keep typed, sourced facts with approvals, requirement checks and drift tracking.
