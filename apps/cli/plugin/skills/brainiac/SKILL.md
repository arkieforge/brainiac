---
name: brainiac
description: How to read and change a person's Brainiac record (achievements, roles, papers, grades, test scores, applications, documents) through the brainiac MCP tools. Use whenever the brainiac tools are connected, or the person asks about their record, an application, a CV, or a fact like a score, grade or date.
---

# Brainiac

The person's record is a set of typed notes with sources. You reach it only through the `brainiac` MCP tools.
Applications, scholarships and jobs are decided on these facts, so a wrong value is worse than no answer.

## Start with describe

Call `describe` first in every session. It says what you may do (your level, and whether you see sensitive
notes), and gives `me.md`, every type with its folder, fields and allowed values, and what is waiting for the
person. Use its type and field names; don't invent your own.

## Find, then read

- `query` finds notes by type and fields. Use it before anything else.
- `get` reads notes by id or path, with their body, sources, history and `rev`.
- A note you can't see reads the same as one that doesn't exist. Say you couldn't find it; don't guess.

## Quote values exactly

- Give a number, date or name exactly as the record returned it in this session: `7.5`, not "about 7.5";
  `2027-05-31`, not "end of May".
- Before you give a number or a date, read it from the record now, even if you saw it earlier. Notes change.
- `verified` on a note lists the fields the person checked. Say "unverified" next to any other value you quote.
- When a value is missing, unclear, or two notes disagree, ask with `request_info` instead of filling the gap.

## Change the record through the tools

- Update the note that exists rather than creating a near copy. A new event is a new note: a new test
  attempt or a new role is `create`, never an overwrite of the old one. Link `supersedes` only when the new
  note replaces an earlier one, like a retake of the same test.
- Send the `rev` you got from `get` with every `update`. On a conflict, get the note again and redo the change.
- Run changes to many notes with `dry_run` first, then again with `expect` set to the count it matched.
- `needsApproval` means nothing changed: ask the person to approve in Brainiac, then send the same call with
  `approval_id`. `proposed` means it waits for the person. Only the person decides proposals and conflicts.
- Mark grades, scores, IDs, health and money as `sensitive` when you create them.
- To undo your own change, use `undo` with the run its answer named.

## Never touch the vault files

Never edit, write, move or delete files in the person's Brainiac folder, and never read its sensitive
folders, `documents/files/` or `inbox/` from disk. Changes made outside the tools aren't attributed or
checked. The plugin's hook refuses those calls; when it does, do the same job with the tools.

## Prompts

The server also offers prompts for common jobs: `file_inbox`, `missing_for_application` and `review_record`.
