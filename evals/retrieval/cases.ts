// The retrieval eval's golden questions over the fixture student's record (fixtures/nadia), each naming the notes
// that answer it, and its scorers: recall@8 and citation precision, per route. No model takes part, so every
// verdict is exact and the same on every run.
import { callTool, type Connection, type Sql } from "../../packages/base/src/index.ts";
import { atLeast, FLOORS, type Gate } from "../shared/gates.ts";

/** Fixture note ids, from each note's front-matter. */
const NOTE = {
  application: "01M6AM78G0STS7TB29G7A10DCY",
  trf: "01M6AV2ZR0XCK1MFKF8AQ91WD2",
  transcript: "01M6AQN440XW2HFGGHJ78Q7YPB",
  bsc: "01M6A6FT00TTWJ9B75727G2EWN",
  paper: "01KN35E000WGR5JDTQ7Z2X0FA8",
  role: "01M6AGSCW0VCVQ4638KZVD05RK",
  ielts2025: "01M6A9XNM0AR4BM0ESE4KX8KVB",
  ielts2026: "01M6ADBH80DEGPEVAAVR2625V1",
  okafor: "01M6AYGVC0RJMJJ7ZYHPC25MYC",
  linkedin: "01M7E81W00NTC6KVRWAZQ5KQMG",
} as const;

export const ROUTES = ["query", "search", "ask"] as const;
export type Route = (typeof ROUTES)[number];

/** How many of a route's results count: an `ask` context holds 8 notes by default. */
export const K = 8;

export interface Case {
  readonly id: string;
  readonly source: string;
  /**
   * `control`: the question shares words with the notes that answer it. `guard`: a paraphrase that shares none
   * of the words that matter, so only meaning finds it, which keeps the set from holding only what keyword search
   * already finds.
   */
  readonly kind: "control" | "guard";
  /** The person's words, as `ask` context takes them. */
  readonly question: string;
  /** The notes that answer it. */
  readonly answers: readonly string[];
  /** The words an agent would `search` for. */
  readonly search: string;
  /** The `query` an agent would send, where fields can ask it. */
  readonly query?: Readonly<Record<string, unknown>>;
}

const SOURCE = "#151";

export const CASES: readonly Case[] = [
  {
    id: "ielts-writing",
    source: SOURCE,
    kind: "control",
    question: "What was my IELTS writing score?",
    answers: [NOTE.ielts2026],
    search: "IELTS writing",
    query: { type: "TestScore", where: { test: { eq: "ielts-academic" } } },
  },
  {
    id: "english-exam",
    source: SOURCE,
    kind: "guard",
    question: "How did I do on my English language exam?",
    answers: [NOTE.ielts2026],
    search: "English exam",
    query: { type: "TestScore" },
  },
  {
    id: "first-try",
    source: SOURCE,
    kind: "guard",
    question: "How did my first try at the language test go?",
    answers: [NOTE.ielts2025],
    search: "first try language test",
    query: { type: "TestScore", sort: ["date"] },
  },
  {
    id: "cgpa",
    source: SOURCE,
    kind: "control",
    question: "What is my CGPA?",
    answers: [NOTE.bsc],
    search: "CGPA",
    query: { type: "Education", fields: ["cgpa", "scale"] },
  },
  {
    id: "what-i-studied",
    source: SOURCE,
    kind: "guard",
    question: "What did I major in during undergrad?",
    answers: [NOTE.bsc],
    search: "undergrad major",
    query: { type: "Education" },
  },
  {
    id: "courses",
    source: SOURCE,
    kind: "control",
    question: "Which courses did I get an A in?",
    answers: [NOTE.bsc],
    search: "courses",
  },
  {
    id: "grade-sheet",
    source: SOURCE,
    kind: "guard",
    question: "Is my official grade sheet stamped?",
    answers: [NOTE.transcript],
    search: "grade sheet stamp",
    query: { type: "Document", where: { kind: { eq: "transcript" } } },
  },
  {
    id: "ielts-proof",
    source: SOURCE,
    kind: "control",
    question: "Which document proves my IELTS score?",
    answers: [NOTE.trf],
    search: "IELTS test report",
    query: { type: "Document", where: { kind: { eq: "test-report" } } },
  },
  {
    id: "internship",
    source: SOURCE,
    kind: "control",
    question: "Where did I do my internship?",
    answers: [NOTE.role],
    search: "internship",
    query: { type: "Role", where: { kind: { eq: "internship" } } },
  },
  {
    id: "jobs",
    source: SOURCE,
    kind: "guard",
    question: "What jobs have I held?",
    answers: [NOTE.role],
    search: "job employment",
    query: { type: "Role" },
  },
  {
    id: "acme-work",
    source: SOURCE,
    kind: "control",
    question: "What did I build at Acme Robotics?",
    answers: [NOTE.role],
    search: "Acme Robotics",
  },
  {
    id: "monitoring",
    source: SOURCE,
    kind: "guard",
    question: "Have I worked on monitoring or observability tooling?",
    answers: [NOTE.role],
    search: "monitoring observability",
  },
  {
    id: "swahili-paper",
    source: SOURCE,
    kind: "control",
    question: "What is my Swahili paper about?",
    answers: [NOTE.paper],
    search: "Swahili",
    query: { type: "Paper" },
  },
  {
    id: "publications",
    source: SOURCE,
    kind: "guard",
    question: "Have I published any research?",
    answers: [NOTE.paper],
    search: "published research",
    query: { type: "Paper" },
  },
  {
    id: "supervisor",
    source: SOURCE,
    kind: "control",
    question: "Who supervised my thesis?",
    answers: [NOTE.okafor, NOTE.bsc],
    search: "thesis supervisor",
    query: { text: "thesis" },
  },
  {
    id: "recommender",
    source: SOURCE,
    kind: "guard",
    question: "Who could vouch for me in a reference?",
    answers: [NOTE.okafor],
    search: "vouch reference",
    query: { type: "Person", where: { role: { eq: "referee" } } },
  },
  {
    id: "letter-notice",
    source: SOURCE,
    kind: "guard",
    question: "How early should I ask for my recommendation?",
    answers: [NOTE.okafor],
    search: "ask early recommendation",
  },
  {
    id: "tum-deadline",
    source: SOURCE,
    kind: "control",
    question: "When is the TUM application deadline?",
    answers: [NOTE.application],
    search: "TUM deadline",
    query: { type: "Application", fields: ["deadline"] },
  },
  {
    id: "masters-programs",
    source: SOURCE,
    kind: "guard",
    question: "Which graduate schools am I applying to?",
    answers: [NOTE.application],
    search: "graduate school",
    query: { type: "Application" },
  },
  {
    id: "linkedin-headline",
    source: SOURCE,
    kind: "control",
    question: "What does my LinkedIn headline say?",
    answers: [NOTE.linkedin],
    search: "LinkedIn headline",
    query: { type: "Profile", where: { site: { eq: "linkedin" } } },
  },
  {
    id: "hometown",
    source: SOURCE,
    kind: "guard",
    question: "Where am I based?",
    answers: [NOTE.linkedin],
    search: "hometown residence",
  },
];

/** What one route returned for one case: note ids, best first, as the agent sees them. */
export interface Retrieved {
  readonly case: string;
  readonly route: Route;
  readonly mode: "hybrid" | "keyword";
  readonly ids: readonly string[];
}

/** The call `route` makes for `c`, if it can ask it, and the words the cloud embeds for it (`questionOf`). */
export function callFor(c: Case, route: Route) {
  if (route === "query") return c.query && { name: route, args: { limit: K, ...c.query } };
  if (route === "search") return { name: route, args: { text: c.search, limit: K }, words: c.search };
  return { name: route, args: { mode: "context", question: c.question, limit: K }, words: c.question };
}

const idsAt = (value: Record<string, unknown>, key: string) => {
  const list = value[key];
  return Array.isArray(list) ? list.map((item: { id: string }) => item.id) : [];
};

/**
 * Asks `c` through `route` as `reader`, given the question's embedding on a hybrid run. The ids are what the answer
 * shows, best first: query's rows; search's hits, then the notes related to them; the notes of an ask context.
 */
export function retrieve(
  sql: Sql,
  reader: Connection,
  c: Case,
  route: Route,
  vector?: readonly number[],
): Retrieved | undefined {
  const made = callFor(c, route);
  if (!made) return undefined;
  const answer = callTool(sql, made.name, made.args, {
    actor: `connection:${reader.id}`,
    connection: reader,
    now: Date.now(),
    ...(vector && { vector }),
  });
  if (!answer.ok) throw new Error(`${c.id} ${route}: ${answer.error}`);
  const value = answer.value as Record<string, unknown>;
  const mode = value["mode"] === "hybrid" ? "hybrid" : "keyword";
  const ids =
    route === "query"
      ? idsAt(value, "rows")
      : route === "search"
        ? [...idsAt(value, "hits"), ...idsAt(value, "related")]
        : idsAt(value, "notes");
  return { case: c.id, route, mode, ids };
}

/**
 * How many answering notes are in the first `K` of `ids` (`found`, of `of`), and how many notes those first `K`
 * hold (`cited`): an answer may cite any of them, so `found / cited` is its citation precision.
 */
export function score(answers: readonly string[], ids: readonly string[]) {
  const top = [...new Set(ids)].slice(0, K);
  const wanted = new Set(answers);
  return { found: top.filter((id) => wanted.has(id)).length, of: wanted.size, cited: top.length };
}

/** Recall@8 and citation precision for one route over the cases it ran. */
export function measure(cases: readonly Case[], retrieved: readonly Retrieved[], route: Route) {
  const scores = retrieved.flatMap((r) => {
    const c = cases.find((each) => each.id === r.case);
    return r.route === route && c ? [score(c.answers, r.ids)] : [];
  });
  const sum = (key: keyof ReturnType<typeof score>) => scores.reduce((total, s) => total + s[key], 0);
  return {
    route,
    cases: scores.length,
    found: sum("found"),
    of: sum("of"),
    cited: sum("cited"),
  };
}

export type Measured = ReturnType<typeof measure>;

/** A route's recall@8 gate: the answering notes found in the first 8, over all the answering notes it was asked for. */
export const recallGate = (m: Measured, mode: string): Gate =>
  atLeast(`Recall@8, ${m.route} (${mode})`, FLOORS.recall, m.found, m.of);
