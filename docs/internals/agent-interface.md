# Agent interface

MCP is the main way in. The same tools are served by `<domain>/mcp` (OAuth, works as a claude.ai connector on a normal subscription) and `brainiac mcp serve` (stdio for Claude Code, T3 Code, Codex). The CLI has the same commands with `--json`. Brainiac supplies data and checks; the model doing the thinking is always yours.

| Phase | Tool           | Does                                                                                                                                                                                                                                                        |
| ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0    | `describe`     | `me.md`, your schema (types, fields, enums, relations), folders, collections, glossary, house rules, counts, open questions, conflicts, notes "not synced". The first call in a session                                                                     |
| M0    | `query`        | Exact structured lookup with the filter below. Also lists proposals, questions, applications and profiles, since those are types too                                                                                                                        |
| M0    | `get`          | One or many notes by id or path; options for body, sources, history, backlinks, file text by page, and page images for reading scans (cleared files only; vault documents return a redacted summary)                                                        |
| M0    | `add`          | Capture text, a URL or a file into the inbox, optionally attached to a note                                                                                                                                                                                 |
| M0    | `create`       | A new note; warns with the likely duplicate if one exists                                                                                                                                                                                                   |
| M0    | `update`       | Patch one note or every note a filter matches: set, unset, append, body edits by section, link/unlink, move, delete, restore, and `withdraw` for the agent's own proposals. `dry_run` first; carries `rev`. Deciding proposals and conflicts is yours alone |
| M0    | `undo`         | Revert a change or a whole run (inverse patches)                                                                                                                                                                                                            |
| M0    | `request_info` | Queue a question for you (always allowed, since it isn't an edit)                                                                                                                                                                                           |
| M1    | `search`       | Keyword + meaning search over notes and file text, with filters, snippets and pages                                                                                                                                                                         |
| M1    | `related`      | Everything connected to a note, grouped by reason (proves, used by, supersedes, same tags, similar), `depth` up to 3                                                                                                                                        |
| M1    | `ask`          | `mode: "context"`: the notes, canonical values and citations your model needs to answer. `mode: "verify"`: checks a draft's explicit claims (`{note, field, value}`) against current values and flags uncited numbers and dates                             |
| M2    | `draft`        | For a CV, resume, SOP or letter: returns the chosen facts, the template and your house rules; your model writes; `draft {verify}` checks it; `draft {render}` makes the PDF (Typst) or the packet                                                           |
| M3    | `organize`     | Plan, then apply after approval: views, folders, type changes, merges, conversions, glossary, collections                                                                                                                                                   |
| M3    | `fill_form`    | Fill a portal form through the browser extension; secrets resolved at the field                                                                                                                                                                             |

Resources: `brainiac://note/{id}`, `brainiac://schema`. MCP Apps cards (a note, a diff, an approval link) render inside Claude web and desktop. Text from files, emails and web pages is marked `untrusted` in tool results, as a hint to the agent; the real protection is the approval list.

## The filter

```
{ "type": "Project",
  "where": { "categories": { "has": "mobile" }, "synced.stars": { "gte": 50 }, "period.end": { "gte": "2025-01-01" } },
  "text": "flutter",
  "sort": ["-synced.stars"], "fields": ["title", "role", "links.repo", "synced.stars"], "limit": 10, "cursor": null }
```

- **Operators (start small)**: `eq in gte lte exists has text`. More only when a real query needs them.
- **Semantics**: a missing field matches only `exists: false`; `eq` on a list means "contains"; dates compare as ISO dates in UTC; strings compare case-insensitively after Unicode normalization.
- **Paging and cost**: stable cursors (sort key, then id), at most 100 rows a page, and a query that would scan more than 10k rows without an index is refused with a suggestion.
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
- **Tested**: the `mcp-tool-use` eval runs real tasks on the models people use (see "Quality bar").
