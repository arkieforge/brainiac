---
name: triage
description: Triage Brainiac's GitHub issues and PRs: label by area and type, set the milestone, link to the right epic, merge duplicates, and ask for what's missing. Use for "triage the issues", "triage new PRs", or a single issue or PR number. Not for writing code or reviewing a diff in depth.
---

# Triage

The tracker is GitHub issues on `arkieforge/brainiac`. Every issue has one `area:*` label, one `type:*`
label, a milestone (M0 to M3, or Later), and, for features in a milestone, a parent epic
("epic: M0 Record + sync" and so on). Open decisions live in the issue titled
"decisions: open questions for the owner".

## Issues

For each open issue without a milestone, or the ones named:

1. Read it and the docs it touches ([docs/README.md](../../../docs/README.md) maps them). The roadmap
   ([docs/product/roadmap.md](../../../docs/product/roadmap.md)) decides the milestone.
2. Look for duplicates (`gh issue list --search "<key words>" --state all`). Close a duplicate with a link to
   the original and a one-line reason.
3. Set labels and milestone: `gh issue edit <n> --add-label area:sync,type:feature --milestone "M0 Record + sync"`.
   Add `council` when it touches security, auth, sync or retrieval (`area:security`, `area:auth`,
   `area:sync`, `area:rag`), and give its brief a `## Review` section saying to run the `council` skill
   until every member scores 9.5/10 before filing the PR.
4. Link a feature to its epic as a sub-issue:
   `gh api -X POST repos/arkieforge/brainiac/issues/<epic>/sub_issues -F sub_issue_id=$(gh api repos/arkieforge/brainiac/issues/<n> --jq .id)`.
5. Make it a brief: every feature issue needs Goal, What ships, Out of scope, Where, Depends on, Done when
   and How it breaks (see any M0 issue for the shape). Fill gaps you can answer from the docs; ask for the rest.
6. If it can't be acted on (no repro for a bug, no "Done when" for a feature), comment with the exact
   questions and label it `question`. Don't guess the answers.
7. If it asks for something the contract forbids (agents seeing secrets, reading a base id from a URL,
   paid SaaS for something Cloudflare covers), say which rule and suggest the version that fits.

## Pull requests

1. Check it closes an issue and stays inside it. One problem per PR.
2. Check the body says how it was proved, and CI is green.
3. Check the PR template boxes, especially "no real personal data".
4. Comment with what's missing. Don't merge, close or approve unless the maintainer asked you to.

## Never

- Paste personal data from an issue into another issue, a commit or a fixture.
- Change milestones of issues already in progress without saying why in a comment.
