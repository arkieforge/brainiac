// OKF notes kept as raw markdown: parse, patch without reformatting, validate against the manifest.
export { isUlid, ulid } from "./ids.ts";
export { merge, merge3, type Merged } from "./merge.ts";
export {
  ClientMessage,
  decodeClientMessage,
  type Change,
  type Hello,
  type Mutate,
  type NoteState,
  type Result,
  type ServerMessage,
} from "./protocol.ts";
export { NoteParseError, parseFrontMatter, parseNote, splitNote, type Note, type NoteParts } from "./note.ts";
export { deepEqual, patch, PatchError, type Path, type PatchOp, type YamlValue } from "./patch.ts";
export {
  findClash,
  isRelationPath,
  normalizePath,
  PathError,
  pathKey,
  relationTo,
  resolveRelation,
} from "./paths.ts";
export { ManifestError, parseManifest, validate, type Issue, type Manifest } from "./schema.ts";
