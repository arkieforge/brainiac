# Customization

Types, folders, headlines, views, collections, vocabulary, review cadence, output style: all of it is per person, kept as notes in the record (it syncs, has history, travels with an export), and editable by you or by Claude through the same tools.

```
settings/
├── agents.md        house rules for every agent: names, tone, what never to claim
├── glossary.md      your words: "CGPA = GPA", "NTU = Northvale Technical University"
├── views.md         overview grouping, saved filters, collections, pins
├── review.md        review cadence, which detectors run, question cap
└── outputs.md       CV template, spelling, date style, page limits, photo by country
```

Each is a `Settings` note (a built-in type) whose `kind` names it. `describe` hands all of them to the agent, which follows them. The glossary's `terms` map a word to what it also means (`terms: {NTU: Northvale Technical University, GPA: [CGPA]}`), and search reads them both ways (see "Retrieval"). The rest are words for agents: Brainiac doesn't run anything from them yet.

**Guardrail**: settings notes hold preferences only. Agent levels, token scopes and privacy loosening live in the DO's security tables and change only through approvals, so an edit to a note can never grant access.

**`me.md`**: who you are in your own words, a `Me` note Brainiac never writes. `describe` puts a summary from your record before it: each fact type's current items and your open applications, as headlines linking to their notes. It's made when Claude reads it, from what that connection may see, so a connection without the sensitive scope never gets your scores there, and it can't go stale.

## "Claude, organize my record"

Brainiac runs no model, so your Claude makes the plan: the types to add or change and the notes to convert or move. `organize` checks it (the catalog, the 3-field rule, the areas, the versions), shows it as one approval, and applies it as one run. Views, glossary words and collections are settings notes your Claude edits with `create` and `update`; fixes come from `query {type: "Check"}`.

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

- **Undo a run**: `undo r_311` applies the inverse of each change in reverse, types included, with your passkey. If you edited the same field since then, that field becomes a conflict instead of being overwritten. Your other edits are kept.
- **Retrieval stays right**: retrieval keys on ids, types and fields. Moves rewrite references. A renamed field re-indexes only that type. Your glossary feeds query rewriting.
- **Self-test after structural changes**: after every `organize`, Brainiac asks a question from your own record for each note the run placed or whose type it changed (its type and title, asked as `ask` asks it), and each must find its note in the first 8 hits. A miss is in the run's answer, which offers the undo.
