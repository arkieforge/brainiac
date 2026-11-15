# Agent interface

MCP is the main way in. The same tools are served by `<domain>/mcp` (OAuth, works as a claude.ai connector on a normal subscription) and `brainiac mcp serve` (stdio for Claude Code, T3 Code, Codex). The tools' text, schemas and logic live in one module, `packages/base/src/tools.ts`. `brainiac mcp serve` forwards every message to `/mcp` with the device's token, so online its tools, answers and grants are the record's own by construction; offline it says so and answers nothing yet (#94). The CLI has the same commands with `--json`. Brainiac supplies data and checks; the model doing the thinking is always yours.

| Phase | Tool           | Does                                                                                                                                                                                                                                                                                                                                    |
| ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0    | `describe`     | `me.md`, your schema (types, fields, enums, relations), folders, collections, glossary, house rules, counts, open questions, conflicts, notes "not synced". The first call in a session                                                                                                                                                 |
| M0    | `query`        | Exact structured lookup with the filter below. Also lists proposals, questions, applications and profiles, since those are types too                                                                                                                                                                                                    |
| M0    | `get`          | One or many notes by id or path; options for body, sources, history, backlinks, file text by page, and page images for reading scans (cleared files only; vault documents return a redacted summary)                                                                                                                                    |
| M0    | `add`          | Capture text, a URL or a file into the inbox, optionally attached to a note                                                                                                                                                                                                                                                             |
| M0    | `create`       | A new note; warns with the likely duplicate if one exists                                                                                                                                                                                                                                                                               |
| M0    | `update`       | Patch one note or every note a filter matches: set, unset, append, body edits by section, link/unlink, delete, restore, and `withdraw` for the agent's own proposals (move arrives with #38). Carries `rev`; a bulk update applies only with the count its `dry_run` showed (`expect`). Deciding proposals and conflicts is yours alone |
| M0    | `undo`         | Revert a change or a whole run (inverse patches)                                                                                                                                                                                                                                                                                        |
| M0    | `request_info` | Queue a question for you as a `Question` note in `questions/` (allowed at propose level, like `add`); a field that already has an open question gets that one back                                                                                                                                                                      |
| M1    | `search`       | Keyword + meaning search over notes and file text, with filters, snippets and pages                                                                                                                                                                                                                                                     |
| M1    | `related`      | Everything connected to a note, grouped by reason (proves, used by, supersedes, same tags, similar), `depth` up to 3                                                                                                                                                                                                                    |
| M1    | `ask`          | `mode: "context"`: the notes, canonical values and citations your model needs to answer. `mode: "verify"`: checks a draft's explicit claims (`{note, field, value}`) against current values and flags uncited numbers and dates                                                                                                         |
| M2    | `draft`        | For a CV, resume, SOP or letter: returns the chosen facts, the template and your house rules; your model writes; `draft {verify}` checks it; `draft {render}` makes the PDF (Typst) or the packet                                                                                                                                       |
| M3    | `organize`     | Plan, then apply after approval: views, folders, type changes, merges, conversions, glossary, collections                                                                                                                                                                                                                               |
| M3    | `fill_form`    | Fill a portal form through the browser extension; secrets resolved at the field                                                                                                                                                                                                                                                         |

Resources: `brainiac://note/{id}`, `brainiac://schema`. MCP Apps cards (a note, a diff, an approval link) render inside Claude web and desktop. Text from files, emails and web pages is marked `untrusted` in tool results, as a hint to the agent; the real protection is the approval list.

## The filter

```
{ "type": "Project",
  "where": { "categories": { "has": "mobile" }, "synced.stars": { "gte": 50 }, "period.end": { "gte": "2025-01-01" } },
  "text": "flutter",
  "sort": ["-synced.stars"], "fields": ["title", "role", "links.repo", "synced.stars"], "limit": 10, "cursor": null }
```

- **Operators (start small)**: `eq in gte lte exists has text`. More only when a real query needs them.
- **Semantics**: a missing field matches only `exists: false`, and so do a null and an empty list; comparing with `null` is refused with that hint rather than read as no condition. `eq` on a list means "contains"; `has` is "contains" for a list and "has this key" for a mapping; dotted paths reach into mappings and lists (`sources.page`). Dates compare in UTC, a date-time against a plain date by its UTC day; strings compare case-insensitively after Unicode normalization, and `text` also ignores accents. Several operators in one condition must all hold. Rows pass the projection before the filter sees them.
- **Paging and cost**: stable cursors (sort key, then id; default sort `-date`, missing values last), bound to the query they came from; at most 100 rows a page (default 20); a query without a `type` over more than 10k notes is refused and asks for one. `type: "Proposal"` and `type: "Question"` list proposals (with `yours`) and the person's questions through the same filter (questions found from the schema and asked by agents, soonest deadline first, each naming the note and field its answer goes to; see "Questions"), and `type: "Check"` what the detectors flag (`packages/core/src/review.ts`), computed over only the notes the connection can see, so a check's evidence never comes from a note it couldn't read.
- CLI shorthand: `brainiac query 'type:Project categories:mobile synced.stars>=50 sort:-synced.stars'`.

## Levels

| Level       | Can                                                                                                                        | Typical for                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **read**    | describe, query, get, search, related, ask, within the token's scopes                                                      | A helper bot                 |
| **propose** | read + add, request_info, withdrawing its own proposals, and every change as a proposal                                    | Agents you don't fully trust |
| **write**   | propose + direct create, update, undo, draft, organize plans, fill_form (subject to the hold window and the approval list) | Your own Claude              |

When a call hits the approval list, the result is `needsApproval` with a link (and an MCP elicitation prompt where the client supports it, which only shows the link). The change applies after you approve on the site or phone.

## A session

```
You (in your Claude, whose connection you granted the sensitive scope): "My new IELTS result is in this PDF. Update everything that depends on it."
add       { file: "IELTS-TRF-2026.pdf", kind: "test-report" }    → unclassified until checks pass + your tap
          (you tap "test report" on your phone; server checks found no ID numbers → cleared, text p1)
query     { type: "TestScore", where: { test: "ielts-academic" } } → ielts-2025-03 (7.5, valid to 2027-03)
create    { type: "TestScore", from_document: …, supersedes: "ielts-2025-03.md", dry_run: true }
          → ielts-2026-11 (8.0; writing 7.0), sources per field
create    { …, dry_run: false }                → held { autoApplyAt: 2026-11-17, approveLink }
          (you approve early on your phone with your passkey; the note is created, unverified)
related   { id: ielts-2026-11 }                                   → TUM, KTH, Edinburgh checks re-ran
query     { type: "Application", where: { "checks.failing": { "exists": true } } }
          → Edinburgh: writing must be 7.5 or higher, the new attempt has 7.0 → failing
draft     { kind: "cv", for: "tum-msc-informatics-2027", from: "cv-v2" } → facts + template; Claude writes cv-v3
draft     { verify: cv-v3 }                                       → all values match
Claude: "Your November IELTS (8.0) is in as a new attempt; the 2025 one stays in history. TUM and KTH
still pass. Edinburgh needs 7.5 in writing and you have 7.0, so I've flagged it. The TUM CV is v3.
The score is labeled unverified until you mark it checked in review."
```

## Teaching the agent

- **Skill** (Claude Code plugin, also at `<domain>/skill.md`): call `describe` first; `query` before `search`; update rather than create; new events are new notes; quote values exactly as returned; run `verify` before giving numbers; dry-run bulk changes; never write vault files directly.
- **Hook**: the plugin installs a Claude Code hook that blocks Edit, Write and shell commands touching the vault path, plus Read, Grep and Glob on sensitive folders, `documents/files/` and `inbox/`, and points to the tools.
- **Prompts**: "file my inbox", "what's missing for <application>", "review my record", so a subscription user starts common jobs in one line.
- **Tested**: contract tests hold each tool to its schema and the connection's level through `/mcp`. Online, stdio returns the same tools and answers as remote. The `mcp-tool-use` eval runs real tasks on the models people use (see "Quality bar").
