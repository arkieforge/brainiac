---
name: add-note-type
description: Add a Brainiac note type or a field, or change the record's SQLite schema with a migration, reaching every place the change has to and proving it on both engines. Use when packages/core's types or catalog, a manifest, or packages/base/src/schema.ts changes.
---

# Add a note type, a field or a migration

Front-matter lives in the note's text and its parsed `notes.fm`, so a type or a field needs no migration. A
migration is for the record's own tables. Read [record format](../../../docs/internals/record-format.md) and
[data model](../../../docs/internals/data-model.md) first.

## A type or a field

1. **Pick where it lives.** `BUILT_IN_TYPES` in `packages/core/src/schema.ts` is for types every record has because
   Brainiac's own code needs them (Draft, Question, Application). `CATALOG` in `packages/core/src/growth.ts` is for
   vetted types a record takes through `organize`; never edit a shipped entry, add `name@<next>`, because records
   keep the entry they took. A person's own types live in their manifest and change only through `organize`, which
   they sign. Code never writes a person's manifest.
2. **The spec.** A fact type is `held: true` (the hold window). `headline` and `key` drive the overview and the
   duplicate and conflict checks (`packages/core/src/review.ts`); `ask` turns an empty field into a question
   (`questions.ts`). A new field starts optional: a required one makes every note without it fail validation.
3. **Privacy.** The folder sets the class through `SENSITIVE_AREAS` in `growth.ts`: grades, scores, IDs, health,
   family and money belong in a sensitive area. Numbers that are secrets never go in a field; they go to the
   vault as a `secret:` reference. Changing what is sensitive is a contract change (§5).
4. **The site.** Forms, `describe` and search fields follow the manifest. Only a new field `kind` needs code: add it
   to `KINDS` and `EXAMPLES` in `schema.ts` (their `satisfies` makes the compiler list the rest), then
   `apps/web/src/fields.ts` and `apps/web/src/components/FieldForm.tsx`.
5. **Fixtures.** Give a new type or field a note in `fixtures/nadia` (and its manifest, `okf-base.yaml`), written as a
   person writes it: comments, both quote styles, flow and block lists. `packages/core/src/fixture.test.ts` checks
   every note against the manifest and that edits keep its bytes.
6. **Docs.** `record-format.md` for a new area, folder or rule of the format. Never a list of a type's fields.

## A migration

1. **Append** to `MIGRATIONS` in `packages/base/src/schema.ts`, with a comment saying why. `SCHEMA_VERSION` is its
   length. Additive for one release (new tables, columns, indexes), camelCase columns, and never edit one that
   shipped. A field queries filter or sort on often may earn a generated column and an index, like `deadline`.
2. **Tests** in `packages/base/test/cases.ts`: a new table joins `ALL_TABLES`, and "the tokenizer migration keeps
   every chunk searchable" takes the reverse of your migration in its list and its `SCHEMA_VERSION - <n>` goes up
   by one. Add a case that migrates a record from the version before and reads its old rows.
3. **Docs.** The table's line in `data-model.md`.

## Prove it

```sh
vp test run packages/core                                   # schema, catalog, fixture notes, questions, review
vp test run packages/base/test/engines.test.ts -t migrat    # migrations on bun:sqlite and in a DO
vp test run packages/base                                   # every record case on both engines, and parity
vp test run apps/cli apps/web/src/fields.test.ts            # daemon, offline copy, the site's form
```

## Traps

- The engines differ: the DO's SQLite rejects `BEGIN` and `COMMIT`, and a BLOB reads back as another type
  (`packages/base/src/sql.ts`). Every case runs on both because a pass on one proves nothing about the other.
- The previous Worker runs on the migrated record after a rollback. A new `NOT NULL` column needs a `DEFAULT`, or
  its inserts fail.
- A DO migrates on the first request after a deploy, inside that request. A backfill over every note is paid by it.
- The laptop runs the same `migrate` on `.brainiac/index.db` (`apps/cli/src/index-db.ts`) and the offline copy
  (`apps/cli/src/offline.ts`). An index whose migration throws is rebuilt empty, so every laptop re-indexes.
- An older CLI knows only the built-in types it shipped with. Manifest types reach it in `welcome`, and an
  `organize` change live through the `manifest` message.
- The fixture feeds tests and evals across the repo (`grep -rl fixtures/nadia`): a new note shifts counts and search
  ranks. Run the whole suite before calling it done.
