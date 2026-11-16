// OKF notes kept as raw markdown: parse, patch without reformatting, validate against the manifest.
export { parsePassport, scan, type Finding, type Passport } from "./checks.ts";
export { pageHost, placement, savedDomain, type Placement } from "./domains.ts";
export { areaClass, CATALOG, mergeType, newTypeIssues, type TypeDraft } from "./growth.ts";
export { isUlid, ulid } from "./ids.ts";
export { aboutYou } from "./me.ts";
export {
  csvRows,
  fromCv,
  fromLinkedIn,
  fromVault,
  isLinkedIn,
  linkedInDate,
  type Draft,
  type InboxText,
  type Plan,
} from "./imports.ts";
export { merge, merge3, type Merged } from "./merge.ts";
export {
  ClientMessage,
  decodeClientMessage,
  type Change,
  type Diff,
  type Grants,
  type Hello,
  type Mutate,
  type NoteState,
  type PlanItem,
  type Result,
  type ServerMessage,
} from "./protocol.ts";
export {
  fieldsText,
  NoteParseError,
  parseFrontMatter,
  parseNote,
  splitNote,
  type Note,
  type NoteParts,
} from "./note.ts";
export { deepEqual, patch, PatchError, type Path, type PatchOp, type YamlValue } from "./patch.ts";
export {
  findClash,
  isRelationPath,
  normalizePath,
  PathError,
  pathKey,
  relationTo,
  resolveFile,
  resolveRelation,
} from "./paths.ts";
export {
  isSite,
  ownershipCode,
  paperTitle,
  PROFILE_FIELDS,
  SITES,
  titleHash,
  titleKey,
  type ProfileField,
  type ScholarSays,
  type Site,
} from "./profiles.ts";
export {
  BUILT_IN_TYPES,
  FieldSpec,
  ManifestError,
  parseManifest,
  parseRequirement,
  setType,
  validate,
  type Issue,
  type Manifest,
  type TypeSpec,
} from "./schema.ts";
export {
  answerEdits,
  askNow,
  findQuestions,
  QUESTION_CAP,
  questionLine,
  sameValue,
  valueAt,
  type Edit,
  type Input,
  type Question,
  type QuestionNote,
  type Reply,
} from "./questions.ts";
export {
  detect,
  expiresIn,
  headline,
  meetsEdges,
  nextStageAt,
  overview,
  remindable,
  REMIND_DAYS,
  stageOf,
  requirementsOf,
  reviewFields,
  reviewQueue,
  show,
  verifyOps,
  type Check,
  type Item,
  type Mark,
  type Overview,
  type Requirement,
  type ReviewNote,
  type Stage,
} from "./review.ts";
