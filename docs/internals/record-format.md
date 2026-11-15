# Record format

## Structure: an open knowledge bundle

Each record is an **OKF bundle** (Open Knowledge Format v0.2): markdown files, front-matter as typed data, a manifest declaring the types. Any agent, Obsidian or `okflint` can read it without Brainiac. Examples use a fictional student, Nadia, applying to TUM.

```
~/brainiac/                                one record = one OKF bundle
├── okf-base.yaml                      manifest: schema_version, types (versioned), relations, headlines
├── me.md                              summary Claude reads first (generated part + your part)
├── profile.md
├── facts/
│   ├── education/   bsc-northvale.md
│   ├── roles/       acme-intern-2025.md
│   ├── papers/      swahili-ner-2026.md
│   ├── projects/    library-seat-finder.md
│   └── tests/       ielts-2025-03.md  ielts-2026-11.md     one note per attempt
├── applications/    tum-msc-informatics-2027/application.md  sop-v3.md  cv-v2.md
├── people/          dr-okafor.md
├── letters/         okafor-tum.md                          status only in the MVP
├── documents/       transcript-bsc.md   files/transcript-bsc.pdf
├── profiles/        github.md  linkedin.md
├── links/           daad-scholarship-database.md
├── history/  identity/  health/  finance/                  grown on demand
├── decisions/  signals/  settings/
├── inbox/                                                  raw input for the filer
└── .brainiac/           state.db  index.db                    never synced: pending changes with their base text (keep) · search index (rebuildable)
```

`index.md` per folder and `log.md` are generated on each machine and never synced, so they can't conflict between devices. The tree shows the whole record as the site sees it; a laptop copy leaves out sensitive folders unless you opt in for that device, and never holds vault-document files.

### How files are organized

- **No file stands alone**: every PDF, scan or photo has a sidecar note (Document or Photo) saying what it is, who issued it, when it expires and which fields it proves.
- **Relations are relative paths** in front-matter (readable, Obsidian-friendly, valid OKF). Every note also has a ULID `id` for sync. When a note moves (by you, an agent or `organize`), the DO rewrites every reference to it, in front-matter and in body links, in the same transaction, and every copy receives the rewritten notes.
- **Held types**: a type marked `held: true` in `okf-base.yaml` is a fact type. A connection's change to its existing values waits out the hold window, and its folder is a held area (see "The contract").
- **Names**: kebab-case `<what>-<when>`. Portal file names (`Karim_Nadia_Transcript.pdf`) are applied only when building a packet.
- **Distinct events are distinct notes**: two IELTS attempts are two TestScore notes, the newer one `supersedes` the older. "Current score" is a query, and history stays queryable.
- **Source and generated output are separate**: `out/` and `derived/` can be rebuilt; versions you actually submitted are frozen on the application.
- **Filenames** are normalized to Unicode NFC and checked case-insensitively for clashes, so macOS, Windows and Linux copies agree.

### How edits keep your text

The stored form is the raw markdown, and `patch` in `packages/core` changes only the bytes of the node it
edits, so comments, key order, quoting and blank lines survive every save:

- Setting a field to the value it already has changes nothing. A changed scalar is rewritten in place.
- New values are written as one line in flow style (`{by: human}`, `[a, b]`); text with line breaks becomes
  one double-quoted line. A new key goes at the end of its mapping, at that mapping's indentation.
- An edit inside a flow collection (`sections: {listening: 8.5}`) rewrites that whole collection, so its
  other values come back in YAML's canonical form (`8.0` becomes `8`). Block collections never do.
- Removing the last key of a nested block mapping writes `{}` (or `[]` for a list), so the field keeps its kind.
- A section is the text under a heading up to the next heading of the same or a higher level; headings
  inside code fences don't count.
- Validation errors name the field, the allowed values and an example, from the type in `okf-base.yaml`.

### Example notes

```
# facts/tests/ielts-2026-11.md
---
id: 01JD7QA1...
type: TestScore
title: "IELTS Academic, November 2026"
test: ielts-academic
overall: 8.0
sections: {listening: 8.5, reading: 8.0, writing: 7.0, speaking: 7.5}
date: 2026-11-02
expires: 2028-11-02
trf_number: "26GB001234KARN001A"                # sensitive like the rest of this note
supersedes: ielts-2025-03.md
sources:
  - {id: trf, resource: ../../documents/ielts-trf-2026.md, page: 1, fields: [overall, sections, date]}
verified: {by: human, at: 2026-11-03, rev: 2, fields: [overall, sections]}   # void if those values change
---
```

```
# applications/tum-msc-informatics-2027/application.md
---
id: 01JD7Q8M...
type: Application
title: "TUM MSc Informatics, Winter 2027"
kind: university
deadline: 2027-05-31
portal: "https://campus.tum.de"
portal_login: secret:portal.tum
status: preparing
requirements:
  - need: "Bachelor transcript"
    check: {type: Document, kind: transcript}                       # deterministic check
  - need: "IELTS 6.5 or higher, valid on the deadline"
    check: {type: TestScore, test: ielts-academic, field: overall, gte: 6.5, valid_on: deadline}
  - need: "Two recommendation letters"
    check: {type: Letter, for: this, status: received, count_gte: 2}
  - need: "Motivation for the specialization (portal question 4)"
    check: manual                                                   # free text: you tick it
---
```

A requirement is "met" only when its check passes on the current notes (or you tick a manual one). Thresholds, counts and validity dates are evaluated, never guessed from text.

### The knowledge graph

Notes are nodes. Edges come from relation fields declared in the manifest (`proves`, `for`, `supersedes`, `referee`) plus body links, and a `meets` edge exists only while a requirement check passes. Edges are stored with inverses and rebuilt in the same transaction as the note.

![Knowledge graph example: the TUM application in the center links to the transcript document, the IELTS score, a letter (status) written by Dr Okafor, the SOP draft, and a missing APS certificate. The transcript proves the BSc education fact; the SOP cites a project and a paper.](../assets/knowledge-graph.svg)

- "What's still missing for TUM?" → requirements whose check fails: the APS certificate and a second letter.
- "Which applications break if my IELTS expires?" → checks with `valid_on` after the expiry date.
- "What proves my CGPA?" → the source with `fields: [cgpa]`, its document and page.

## Structure that grows: new kinds of info get the right place

When something worth keeping fits no type (travel history for a visa, a patent, a driving license, music grade exams), Brainiac picks or designs the right type and folder, shows the plan, and creates it once you approve.

| Area                             | Holds                                                                           | Default class                     |
| -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| `facts/`                         | Things you did: Role, Paper, Project, Award, Volunteering, Talk, Patent, Course | normal                            |
| `facts/tests/`                   | Scored exams, one note per attempt                                              | sensitive                         |
| `history/`                       | What forms ask about: Trip, Address, Gap                                        | sensitive                         |
| `identity/` `health/` `finance/` | IdDocument, License, Visa, Vaccination, FundsProof                              | sensitive (+ secrets for numbers) |
| `people/`                        | Referee, Advisor, Family (for visa forms)                                       | sensitive                         |

1. **Fits an existing type?** Use it.
1. **A variant?** Add a `kind` value or one optional field, not a new type.
1. **In the shared catalog?** Reuse it (`catalog: trip@2`): vetted fields, relations and a headline template.
1. **Truly new?** Only with 3+ fields of its own, or its own dates and status. Otherwise it stays a Fact with tags.
1. **Place it** in the matching area with that area's privacy class.

```
"For the Schengen visa I need my travel history: Japan, March 2024 for ACL; Thailand, Dec 2023."
New type   Trip (catalog trip@2)  →  history/travel/
Fields     country, city?, purpose [study, work, conference, tourism, family, transit], start, end
Relations  for → Talk | Application,  proved_by → Document
Notes      jp-2024-03-acl.md, th-2023-12.md;  convert 2 Facts that look like trips? [yes / pick / no]
Unlocks    Schengen requirement "travel history, last 10 years" now checks
```

- **Versioned schemas**: every type has a version and every schema change is a mutation. Additive changes from two devices merge. Incompatible ones (same name, different field types or meaning) become a conflict you resolve, never a silent union.
- **What follows on its own**: site forms and views, search fields, `describe` output, and the manifest plus folders on every local copy.
- **Tidy on request**: folder splits, merges and misfile fixes are suggestions inside `organize`, not a background job.
