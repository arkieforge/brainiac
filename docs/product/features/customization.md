# Customization

Types, folders, headlines, views, collections, vocabulary, review cadence, output style: all of it is per person, kept as notes in the record (it syncs, has history, travels with an export), and editable by you or by Claude through the same tools.

```
settings/
├── agents.md        house rules for every agent: names, tone, what never to claim
├── glossary.md      your words: "CGPA = GPA", "BUET = Bangladesh University of Engineering and Technology"
├── views.md         overview grouping, saved filters, collections, pins
├── review.md        review cadence, which detectors run, question cap
└── outputs.md       CV template, spelling, date style, page limits, photo by country
```

**Guardrail**: settings notes hold preferences only. Agent levels, token scopes and privacy loosening live in the DO's security tables and change only through approvals, so an edit to a note can never grant access.

**`me.md`**: a generated section between markers (who you are, goals, active applications, with links to the key notes), refreshed after changes, plus your own section below it that Brainiac never touches.

## "Claude, organize my record"

```
You: "Get my record ready for backend jobs in Berlin, and organize the projects."
organize { goal: "jobs, Berlin, backend", dry_run: true }
→ 1. Views     a "jobs" view, Application kind "job" with pipeline statuses, a German-style resume template
  2. Folders   projects/ → projects/backend (6), projects/mobile (4), projects/ml (4); references rewritten
  3. Fixes     2 duplicates to merge · 3 projects with no source · 1 role with no end date
  4. Words     glossary: "Werkstudent", "Lebenslauf" = resume
  5. Sets      collection "backend evidence" (9 items, ranked)
You: "Do 1, 2, 4, 5. Show me the fixes one by one."
→ approval link (moves 14 notes) → applied as run r_311 → fixes open as a review session
```

- **Undo a run**: `undo r_311` applies the inverse of each change in reverse. If you edited the same field since then, that field becomes a conflict instead of being overwritten. Your other edits are kept.
- **Retrieval stays right**: retrieval keys on ids, types and fields. Moves rewrite references. A renamed field re-indexes only that type. Your glossary feeds query rewriting.
- **Self-test after structural changes**: Brainiac generates check questions from your own record ("What is my IELTS writing score?" must cite the current IELTS note) and runs them after every `organize` or schema change. A miss flags the run and offers the undo.
