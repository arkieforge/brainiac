// The record's SQL: one schema, migrations and queries, run by the Base DO and by the CLI's bun:sqlite.
export {
  getNote,
  getNoteByPath,
  listNotes,
  putNote,
  type NoteClass,
  type NoteInput,
  type NoteRow,
} from "./notes.ts";
export { migrate, SCHEMA_VERSION, schemaVersion } from "./schema.ts";
export { putChunks, search, type ChunkInput, type Family, type Hit } from "./search.ts";
export { doSql, type DurableObjectSql, type Sql, type SqlValue } from "./sql.ts";
