// `vp run bench`: the MCP rows of "Fast, with numbers" (docs/operations/quality-bar.md), measured in workerd through
// Miniflare with the real Base DO and jobs consumer (worker.ts), on the fixture student's record and on a record of
// 20k chunks. Prints p50/p95 per path and exits 1 when a p95 is over its target.
//
// Each sample is the round trip of one `Base.tool` call over RPC on localhost, timed in Node: workerd's clock
// doesn't advance during CPU work inside the DO, so timing there reads low. The round trip is an upper bound on
// server time. Questions are embedded by a stand-in (worker.ts), so a real Workers AI call isn't in it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Answer } from "@brainiac/base";
import { ulid } from "@brainiac/core";
import { Miniflare } from "miniflare";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { fixtureNotes } from "../../../scripts/dev-auth.ts";
import { overBudget, sameCase, type Row } from "./verdict.ts";
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

/** The big record's size: 1000 notes of 20 chunks, a lead paragraph and 19 sections each. */
const NOTES = 1000;
const CHUNKS = 20_000;

/**
 * NOTES fictional notes of CHUNKS / NOTES chunks: a lead paragraph (the body before the first heading is a chunk of
 * its own), then sections long enough to be cut apart. Every word appears plain, so keyword search matches it, beside a
 * numbered variant that keeps the chunks from being alike.
 */
function bigNotes() {
  const words =
    "thesis lab robotics swahili corpus tokens grant award python seminar kernel draft metric baseline".split(
      " ",
    );
  const word = (i: number) => words[i % words.length] ?? "";
  const text = (n: number, s: number) =>
    Array.from(
      { length: 12 },
      (_, w) => `${word(n + s + w)} ${word(n + s + w + 5)}${(n * 7 + s * 3 + w) % 97}`,
    ).join(" ");
  return Array.from({ length: NOTES }, (_, n) => ({
    path: `facts/bench/note-${n}.md`,
    raw:
      `---\nid: ${ulid()}\ntype: Fact\ntitle: Bench note ${n}\n---\n${text(n, 99)}.\n\n` +
      [...Array(CHUNKS / NOTES - 1).keys()].map((s) => `## Section ${s}\n${text(n, s)}.\n`).join("\n"),
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

/** How long indexing may take before the bench gives up, well inside CI's five-minute job. */
const INDEX_MS = 120_000;

/**
 * Runs the jobs outbox until every note is in the search index, waiting on installs rather than sleeping. Gives up
 * after INDEX_MS with the jobs still waiting, so a job that never installs fails the bench instead of hanging CI.
 */
async function indexAll(base: DurableObjectStub<BenchBase>) {
  // What drain saw last, for the deadline's message: the timer itself asks the DO nothing, so a DO that stopped
  // answering can't hold the deadline up too.
  let waiting: readonly unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `indexing didn't finish in ${INDEX_MS} ms; waiting: ${JSON.stringify(waiting.slice(0, 5))}`,
          ),
        ),
      INDEX_MS,
    );
  });
  const drain = async () => {
    for (;;) {
      // Registered before the check, so an install between the two still wakes this loop.
      const installed = base.nextInstall();
      waiting = (await base.jobs()).filter((job) => job.kind === "index");
      if (waiting.length === 0) {
        // The last waiter never resolves; the first cold sample's crash ends it.
        installed.catch(() => {});
        return;
      }
      await base.dispatch();
      await installed;
    }
  };
  try {
    await Promise.race([drain(), deadline]);
  } finally {
    clearTimeout(timer);
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

/** Fills both records, then times every case warm and cold. */
async function measure() {
  // As /dev/seed fills a new account (apps/worker/src/dev.ts).
  const seeded = await record(FIXTURE).seedIfEmpty(
    fixtureNotes().map((note) => ({ op: "create" as const, ...note })),
    { actor: "human" },
  );
  if (seeded.status !== "applied") throw new Error(`seed refused: ${JSON.stringify(seeded)}`);
  // One create per note: a bulk change this big would take the person's passkey.
  await record(BIG).seed(bigNotes());
  for (const [name, word] of [
    [FIXTURE, "Swahili"],
    [BIG, "corpus"],
  ] as const) {
    await indexAll(record(name));
    // Both halves of search must run, or the bench times a cheaper path: hybrid means the vectors took part, and a hit
    // matched by words means the keyword index did.
    const found = await call(record(name), { tool: "search", args: { text: word } });
    if (!isHybridWithWords(found))
      throw new Error(`${name} doesn't search both ways: ${JSON.stringify(found)}`);
  }
  const vectors = (await record(BIG).vectorModels()).length;
  if (vectors !== CHUNKS) throw new Error(`the big record has ${vectors} vectors, not ${CHUNKS}`);

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
  return results;
}

/** A search answer that ran both ways: vectors (hybrid) and at least one hit matched by its words. */
function isHybridWithWords(found: unknown) {
  if (!found || typeof found !== "object" || !("mode" in found) || found.mode !== "hybrid") return false;
  if (!("hits" in found) || !Array.isArray(found.hits)) return false;
  return found.hits.some(
    (hit: unknown) =>
      !!hit &&
      typeof hit === "object" &&
      "matched" in hit &&
      (hit.matched === "words" || hit.matched === "both"),
  );
}

// Disposed however the run ends, so a failure exits rather than leaving workerd running.
const results = await measure().finally(() => mf.dispose());

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

const { values } = parseArgs({ options: { out: { type: "string" }, baseline: { type: "string" } } });
if (values.out) writeFileSync(values.out, JSON.stringify(rows));
const baseline: Row[] | undefined = values.baseline
  ? JSON.parse(readFileSync(values.baseline, "utf8"))
  : undefined;
const failed = rows.filter((row) => overBudget(row, baseline));

const ms = (n: number) => `${n.toFixed(1)} ms`.padStart(9);
const base = (row: Row) => baseline?.find((was) => sameCase(was, row));
console.log(
  `${"record".padEnd(11)} ${"path".padEnd(12)} ${"mode".padEnd(5)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"target".padStart(9)}${baseline ? ` ${"main p95".padStart(9)}` : ""}`,
);
for (const row of rows) {
  const was = base(row);
  console.log(
    `${row.record.padEnd(11)} ${row.path.padEnd(12)} ${row.mode.padEnd(5)} ${ms(row.p50)} ${ms(row.p95)} ${ms(row.target)}${baseline ? ` ${was ? ms(was.p95) : "     none"}` : ""}  ${failed.includes(row) ? "FAIL" : "PASS"}`,
  );
}
if (failed.length > 0) process.exitCode = 1;
