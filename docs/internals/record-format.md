# Record format

## Structure: an open knowledge bundle

Each record is an **OKF bundle** (Open Knowledge Format v0.2): markdown files, front-matter as typed data, a manifest declaring the types. Any agent, Obsidian or `okflint` can read it without Brainiac. Examples use a fictional student, Nadia, applying to TUM.

```
~/brainiac/                                one record = one OKF bundle
├── okf-base.yaml                      manifest: schema_version, types (versioned), relations, headlines
├── me.md                              who you are in your own words; describe puts a summary from the record before it
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
- **How a sidecar names its file**: `file:` is a path relative to the note, like a relation (`files/transcript-bsc.pdf` in `documents/`). The cloud finds the stored file by the path that resolves to (`files.path`), and a laptop copy keeps the file at that same path, so both mean one file. An upload gets its place and its sidecar in the same transaction: `unorganized/files/upload-<day>-<id>.<ext>` beside `unorganized/upload-<day>-<id>.md`, named for the upload and never for the person's filename, which can print a secret (`Passport_A1234567.pdf`). The filename is kept on the file for the person and never written into a note, so no agent sees it. The sidecar starts sensitive, titled "Uploaded document", with no `kind` until the person says what the file is. Uploading the same bytes again never makes a second sidecar. A laptop copy never writes an unclassified or vault file to disk, only its sidecar. `unorganized/` is where uploads wait to be filed: moving a sidecar moves its file to the path its unchanged `file:` resolves to from there (`files/` beside it), so the cloud and a copy agree on what's still unorganized by the note's path alone.
- **Relations are relative paths** in front-matter (readable, Obsidian-friendly, valid OKF). Every note also has a ULID `id` for sync. When a note moves (by you, an agent or `organize`), the DO rewrites every reference to it, in front-matter and in body links, and its own relations to live notes, in the same run, and every copy receives the rewritten notes; undoing the run moves it back. A relation by id needs no rewriting. A laptop daemon moves the note's file to follow, and a note the person renames or moves on disk (in Finder or Obsidian) moves in the record the same way, keeping its id and history.
- **Headlines and keys**: a type's `headline` template (`"{degree} · {institution} · {end|year}"`) is its one
  line in the overview; a part whose value is missing is left out, never guessed. Its `key` lists the fields that
  name one item (`[test, date]`), so two notes with the same key values are one item: a conflict if they
  disagree, a duplicate if not. A type without a `key` is never checked for either.
- **What a document says**: a Document's `extracted` mapping holds the values it prints, and a note's source
  (`{resource, page, fields}`) names which of them it proves. The detectors compare the two field by field.
- **Questions**: a field spec's `ask` (`"When did your role at {org} end?"`) makes an empty value a question
  for the person; `current: true` says an item has no end yet, and `not_applicable: [end]` that a field is never
  asked about on that note. Agents' questions are `Question` notes in `questions/` (see "Questions").
- **Held types**: a type marked `held: true` in `okf-base.yaml` is a fact type. A connection's change to its existing values waits out the hold window, and its folder is a held area (see "The contract").
- **Names**: kebab-case `<what>-<when>`. Portal file names (`Karim_Nadia_Transcript.pdf`) are applied only when building a packet.
- **Distinct events are distinct notes**: two IELTS attempts are two TestScore notes, the newer one `supersedes` the older. "Current score" is a query, and history stays queryable.
- **Source and generated output are separate**: a draft (`Draft`: a CV, resume, SOP, cover letter or essay) is a note in its application's folder, one per version (`cv-v2.md`), its body the text and `claims` the value behind each number, date and name in it; its PDF is rendered on demand and never stored. An application's `packet` lists the drafts and documents its portal takes, each `{item, name}`. A draft for an application that is submitted, at interview or decided is frozen: the mutation path refuses any change to it until the application goes back to preparing.
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

A requirement is "met" only when its check passes on the current notes (or you tick a manual one with `done: true`). Thresholds, counts and validity dates are evaluated, never guessed from text: `need` is words for you, and a check that isn't typed (`check: "IELTS 6.5"`) is refused when the note is saved. A check matches notes of its `type` whose other keys equal theirs (`test`, `kind`, `status`), `field` within its bounds (`gte`, `lte`, `gt`, `lt`), not expired on the application's `valid_on` date (today without one), at least `count_gte` of them; `for: this` takes only notes whose `for` names the application, and a superseded note meets nothing. An application without the date its check names meets nothing rather than guess one. The status runs `researching → preparing → submitted → interview → decision`; at `decision` nothing relies on its items any more. A `Letter` names its `referee` (a `Person` note) and the application it is `for`, and its `status` runs `to-ask → requested → sent → received`: `sent` is the referee's word, `received` the portal's, so only `received` meets a letters check like the one above. `query` and `get` hand an application's checks to agents, and the site's note pane judges the same checks in the browser over its synced copy, where you tick a manual one; both run `requirementsOf` (`packages/core/src/review.ts`), so they never disagree.

### The knowledge graph

Notes are nodes. Edges come from relations in the front-matter (`proves`, `for`, `supersedes`, `referee`, a source's `resource`: any value that is a relative `.md` path or a note id, whatever its field's kind) plus body links (`[text](path.md)`), and a `meets` edge exists only while a requirement check passes. Edges are read from the note when a query follows them, so they are always the current revision's, and a relative path resolves the way approvals resolve `supersedes`.

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
| `people/` `letters/`             | Person (referee, advisor, family for visa forms), Letter (status only)          | sensitive                         |

1. **Fits an existing type?** Use it.
1. **A variant?** Add a `kind` value or one optional field, not a new type.
1. **In the shared catalog?** Reuse it (`catalog: trip@2`): vetted fields, relations and a headline template (`packages/core/src/growth.ts`, `CATALOG`; an entry changes only by adding the next version).
1. **Truly new?** Only with 3+ fields of its own (title, tags, sources and the like don't count), or its own dates and a status, and a folder outside what Brainiac keeps (`inbox/`, `questions/`, `unorganized/`, `settings/`). Otherwise it stays a `Fact` with tags, a built-in type. A name the catalog has must come from the catalog.
1. **Place it** in the matching area with that area's privacy class: a note `organize` places in a sensitive area becomes sensitive in the same run.

```
"For the Schengen visa I need my travel history: Japan, March 2024 for ACL; Thailand, Dec 2023."
New type   Trip (catalog trip@2)  →  history/travel/
Fields     country, city?, purpose [study, work, conference, tourism, family, transit], start, end
Relations  for → Talk | Application,  proved_by → Document
Notes      jp-2024-03-acl.md, th-2023-12.md;  convert 2 Facts that look like trips? [yes / pick / no]
Unlocks    Schengen requirement "travel history, last 10 years" now checks
```

- **Versioned schemas**: every type has a version, and every change to the manifest is a new `schema` row in the run that made it (`packages/base/src/organize.ts`), only through `organize`, signed by the person whole with the notes it moves or converts. A change names the version it was made from. Made from an older one, it merges with what changed since, setting by setting and field by field (`mergeType`): two agents adding different fields both land. When both changed the same field or setting (same name, another kind or other values) nothing merges, and the agent reads the schema again and plans from there: never a silent union. A change that would leave any note failing its type is refused, naming the notes the caller can see. Comments in `okf-base.yaml` survive, though the YAML library may move one onto its own line.
- **Undo per run**: `undo` takes back an organize run's notes, then its types, with the person's signature; a type changed again since keeps the whole undo from applying.
- **Self-test**: after each organize, a question from the record (a placed note's type and title, asked as `ask` asks it) must find that note in its first 8 hits, as the caller, over what it may see. A miss is in the answer with the run's undo.
- **What follows on its own**: site forms, search fields and `describe` output. Every open socket hears `manifest` (that it changed, never its text): an open tab reads `/api/schema` again, and a laptop's daemon says hello again for the welcome that carries it, so a new type is in the forms and the offline copy without a reload. A tab that was offline reads it again when it comes back.
- **Tidy on request**: folder splits, merges and misfile fixes are suggestions inside `organize`, not a background job.
