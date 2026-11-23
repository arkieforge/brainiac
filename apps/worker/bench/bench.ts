// `vp run bench`: the MCP rows of "Fast, with numbers" (docs/operations/quality-bar.md), measured in workerd through
// Miniflare with the real Base DO and jobs consumer (worker.ts), on the fixture student's record and on a record of
// 20k chunks. Prints p50/p95 per path and exits 1 when a p95 is over its target.
//
// Each sample is the round trip of one `Base.tool` call over RPC on localhost, timed in Node: workerd's clock
// doesn't advance during CPU work inside the DO, so timing there reads low. The round trip is an upper bound on
// server time. Questions are embedded by a stand-in (worker.ts), so a real Workers AI call isn't in it.
import { join } from "node:path";

import type { Answer } from "@brainiac/base";
import { ulid } from "@brainiac/core";
import { Miniflare } from "miniflare";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { fixtureNotes } from "../../../scripts/dev-auth.ts";
import type { BenchBase } from "./worker.ts";

/** The fixture's TUM application (fixtures/nadia/applications/), the heaviest note to read: it carries checks. */
const APPLICATION = "01M6AM78G0STS7TB29G7A10DCY";
const FIXTURE = "fixture";
const BIG = "20k chunks";

// p95 targets in ms, from docs/operations/quality-bar.md ("Fast, with numbers"). Keep the two in step.
const CASES = [
  {
    record: FIXTURE,
    path: "query",
    warm: 80,
    tool: "query",
    args: { type: "Role", where: { start: { gte: "2024-01-01" } } },
  },
  { record: FIXTURE, path: "get", warm: 80, tool: "get", args: { ids: [APPLICATION] } },
  { record: FIXTURE, path: "related", warm: 80, tool: "related", args: { id: APPLICATION, depth: 2 } },
  {
    record: FIXTURE,
    path: "search",
    warm: 150,
    tool: "search",
    args: { text: "Swahili named entity recognition" },
  },
  {
    record: FIXTURE,
    path: "ask context",
    warm: 150,
    tool: "ask",
    args: { mode: "context", question: "Which IELTS score should I send to TUM?" },
  },
  { record: BIG, path: "search", warm: 150, tool: "search", args: { text: "swahili corpus baseline" } },
  {
    record: BIG,
    path: "ask context",
    warm: 150,
    tool: "ask",
    args: { mode: "context", question: "Which grant paid for the corpus?" },
  },
] as const;
/** "Same, cold DO": every path, after the instance is evicted. */
const COLD = 600;

const WARMUP = 5;
const SAMPLES = { warm: 100, cold: 20 } as const;
/** An MCP client at the floor (propose, no sensitive notes), as a new connection is. */
const VIA = { oauthClientId: "bench" };

/** 1000 fictional notes of 20 chunks each: their fields, then 19 sections long enough to be cut apart. */
function bigNotes() {
  const words =
    "thesis lab robotics swahili corpus tokens grant award python seminar kernel draft metric baseline".split(
      " ",
    );
  const section = (n: number, s: number) =>
    `## Section ${s}\n${Array.from({ length: 24 }, (_, w) => `${words[(n + s + w) % words.length]}${(n * 7 + s * 3 + w) % 97}`).join(" ")}.\n`;
  return Array.from({ length: 1000 }, (_, n) => ({
    path: `facts/bench/note-${n}.md`,
    raw: `---\nid: ${ulid()}\ntype: Fact\ntitle: Bench note ${n}\n---\n${[...Array(19).keys()].map((s) => section(n, s)).join("\n")}`,
    class: "normal" as const,
  }));
}

const mf = new Miniflare({
  modules: true,
  script: await bundleWorker(join(import.meta.dirname, "worker.ts")),
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { BASE: { className: "BenchBase", useSQLite: true } },
  queueProducers: { JOBS: { queueName: "jobs" } },
  queueConsumers: { jobs: { maxBatchTimeout: 0 } },
});
const namespace = await mf.getDurableObjectNamespace("BASE");
// The stub's RPC methods are the DO's own; Miniflare's types describe only fetch. A new stub after each crash.
const record = (name: string) =>
  namespace.get(namespace.idFromName(name)) as unknown as DurableObjectStub<BenchBase>;

/** Runs the jobs outbox until every note is in the search index, waiting on installs rather than sleeping. */
async function indexAll(base: DurableObjectStub<BenchBase>) {
  for (;;) {
    // Registered before the check, so an install between the two still wakes this loop.
    const installed = base.nextInstall();
    if (!(await base.jobs()).some((job) => job.kind === "index")) {
      // The last waiter never resolves; the first cold sample's crash ends it.
      installed.catch(() => {});
      return;
    }
    await base.dispatch();
    await installed;
  }
}

/** One call's value. A failed call stops the bench: timing an error path measures nothing. */
async function call(base: DurableObjectStub<BenchBase>, { tool, args }: { tool: string; args: unknown }) {
  // RPC's types can't carry an `unknown` value, so the answer is read as the DO returns it (as the tests do).
  const answer = (await base.tool(VIA, tool, args)) as Answer;
  if (!answer.ok) throw new Error(`${tool} failed: ${answer.error}`);
  return answer.value;
}

async function time(base: DurableObjectStub<BenchBase>, bench: (typeof CASES)[number]) {
  const start = performance.now();
  await call(base, bench);
  return performance.now() - start;
}

/** The nearest-rank percentile `p` (0..1) of `samples`. */
const percentile = (samples: readonly number[], p: number) =>
  samples.toSorted((a, b) => a - b)[Math.ceil(p * samples.length) - 1] ?? Number.NaN;

// As /dev/seed fills a new account (apps/worker/src/dev.ts).
const seeded = await record(FIXTURE).seedIfEmpty(
  fixtureNotes().map((note) => ({ op: "create" as const, ...note })),
  { actor: "human" },
);
if (seeded.status !== "applied") throw new Error(`seed refused: ${JSON.stringify(seeded)}`);
// One create per note: a bulk change this big would take the person's passkey.
await record(BIG).seed(bigNotes());
for (const name of [FIXTURE, BIG]) {
  await indexAll(record(name));
  // A record without vectors searches by keyword only, which would time the cheaper path.
  const found = await call(record(name), { tool: "search", args: { text: "corpus" } });
  if (!(typeof found === "object" && found !== null && "mode" in found && found.mode === "hybrid"))
    throw new Error(`${name} has no vectors: ${JSON.stringify(found)}`);
}

// Round robin over the cases, so a burst of other load on the machine costs every case one sample rather than one
// case many: a run's p95 then moves with the code, not with what else the machine was doing.
const results = CASES.map((bench) => ({ bench, warm: [] as number[], cold: [] as number[] }));
const warmed = { [FIXTURE]: record(FIXTURE), [BIG]: record(BIG) };
for (let round = 0; round < WARMUP + SAMPLES.warm; round++)
  for (const result of results) {
    const elapsed = await time(warmed[result.bench.record], result.bench);
    if (round >= WARMUP) result.warm.push(elapsed);
  }
// Cold: the instance is evicted before each sample, so the call pays the constructor (migrate, re-index check) and
// reads everything from storage again. Miniflare can't evict the isolate, so module load isn't in it.
for (let round = 0; round < SAMPLES.cold; round++)
  for (const result of results) {
    // crash() always rejects: the call it runs in is the one it aborts.
    await record(result.bench.record)
      .crash()
      .catch(() => {});
    result.cold.push(await time(record(result.bench.record), result.bench));
  }
await mf.dispose();

const rows = results.flatMap(({ bench, warm, cold }) =>
  (
    [
      ["warm", warm, bench.warm],
      ["cold", cold, COLD],
    ] as const
  ).map(([mode, samples, target]) => ({
    record: bench.record,
    path: bench.path,
    mode,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    target,
  })),
);

const ms = (n: number) => `${n.toFixed(1)} ms`.padStart(9);
console.log(
  `${"record".padEnd(11)} ${"path".padEnd(12)} ${"mode".padEnd(5)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"target".padStart(9)}`,
);
for (const row of rows)
  console.log(
    `${row.record.padEnd(11)} ${row.path.padEnd(12)} ${row.mode.padEnd(5)} ${ms(row.p50)} ${ms(row.p95)} ${ms(row.target)}  ${row.p95 < row.target ? "PASS" : "FAIL"}`,
  );
if (rows.some((row) => !(row.p95 < row.target))) process.exitCode = 1;
