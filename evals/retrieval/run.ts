// The retrieval eval (evals/retrieval/README.md): asks every golden question of the fixture record through each
// route an agent uses (query, search, ask context), as the person's own Claude, and scores the notes that come back.
// Keyword-only by default, as a laptop's copy answers; `--hybrid` embeds the record and each question with the
// cloud's own model first, so search ranks by words and meaning as the record does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  chunkNote,
  EMBED_MODEL,
  listNotes,
  putChunks,
  quantize,
  type Sql,
} from "../../packages/base/src/index.ts";
import { gateTable } from "../shared/gates.ts";
import { connection, fixtureRecord } from "../shared/world.ts";
import { callFor, CASES, K, measure, recallGate, retrieve, ROUTES } from "./cases.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    case: { type: "string", multiple: true },
    hybrid: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out <dir> is required.");
const unknown = values.case?.filter((id) => !CASES.some((c) => c.id === id)) ?? [];
if (unknown.length > 0) throw new Error(`No case named ${unknown.join(", ")}.`);
const cases = values.case ? CASES.filter((c) => values.case?.includes(c.id)) : CASES;
const mode = values.hybrid ? "hybrid" : "keyword";

// Workers AI takes up to 100 texts per bge-m3 call.
const BATCH = 100;

/** Workers AI over its REST API: the model the record embeds with, on the account's own token. */
async function embed(texts: readonly string[]): Promise<number[][]> {
  const account = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!account || !token)
    throw new Error("--hybrid needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Doppler dev has both).");
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${EMBED_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: texts.slice(i, i + BATCH), truncate_inputs: true }),
      },
    );
    if (!response.ok) throw new Error(`${EMBED_MODEL}: ${response.status} ${await response.text()}`);
    const { result } = (await response.json()) as { result: { data: number[][] } };
    vectors.push(...result.data);
  }
  if (vectors.length !== texts.length) throw new Error(`${EMBED_MODEL} returned ${vectors.length} vectors`);
  return vectors;
}

/** Re-indexes every note with its chunks' vectors, of the header and text together, as the jobs consumer embeds. */
async function embedRecord(sql: Sql) {
  const notes = listNotes(sql).map((note) => ({ note, chunks: chunkNote(note) }));
  const vectors = await embed(notes.flatMap(({ chunks }) => chunks.map((c) => `${c.header}\n${c.text}`)));
  let at = 0;
  for (const { note, chunks } of notes)
    putChunks(
      sql,
      note.id,
      note.rev,
      chunks.map((chunk) => ({ ...chunk, vector: quantize(vectors[at++] ?? []) })),
    );
}

const { sql } = fixtureRecord();
// The person's own Claude: it may read everything, sensitive notes included.
const reader = connection(sql, "read", true).connection;
const asked = cases.flatMap((c) => ROUTES.map((route) => ({ c, route, words: callFor(c, route)?.words })));
const questions = [...new Set(asked.flatMap(({ words }) => (words ? [words] : [])))];
const vectorOf = new Map<string, number[]>();
if (values.hybrid) {
  await embedRecord(sql);
  (await embed(questions)).forEach((vector, i) => vectorOf.set(questions[i] ?? "", vector));
}

const retrieved = asked.flatMap(({ c, route, words }) => {
  const got = retrieve(sql, reader, c, route, words === undefined ? undefined : vectorOf.get(words));
  if (!got) return [];
  // A route that fell back to keywords would score a hybrid run on the wrong ranking.
  if (route !== "query" && got.mode !== mode)
    throw new Error(`${c.id} ${route}: answered in ${got.mode} mode, not ${mode}`);
  return [got];
});

const measured = ROUTES.map((route) => measure(cases, retrieved, route));
// The floor is the cloud's: offline, search is keyword-only and says so, and a paraphrase it misses is what that
// costs. A keyword run measures the cost; only a hybrid run is held to the floor.
const gates = values.hybrid ? measured.filter((m) => m.cases > 0).map((m) => recallGate(m, mode)) : [];
const ok = gates.every((g) => g.ok);
const rate = (a: number, b: number) => (b === 0 ? "-" : (a / b).toFixed(2));
const missed = retrieved.flatMap((r) => {
  const c = cases.find((each) => each.id === r.case);
  const lost = c?.answers.filter((id) => !r.ids.slice(0, K).includes(id)) ?? [];
  return c && lost.length > 0 ? [`| ${r.case} | ${c.kind} | ${r.route} | ${lost.join(", ")} |`] : [];
});

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "results.ndjson"), retrieved.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(
  join(values.out, "summary.md"),
  [
    `# retrieval (${mode}): ${ok ? "pass" : "FAIL"}`,
    "",
    `- ${cases.length} golden questions over the fixture record (${listNotes(sql).length} notes), the first ${K} notes each route shows.`,
    values.hybrid
      ? `- Hybrid: the record and ${questions.length} questions embedded with ${EMBED_MODEL} on Workers AI; no other model.`
      : "- Keyword-only, as a laptop's copy answers offline: no model is called.",
    "",
    "| route | cases | recall@8 | citation precision |",
    "| --- | --- | --- | --- |",
    ...measured.map(
      (m) =>
        `| ${m.route} | ${m.cases} | ${rate(m.found, m.of)} (${m.found}/${m.of}) | ${rate(m.found, m.cited)} (${m.found}/${m.cited}) |`,
    ),
    ...(missed.length > 0
      ? [
          "",
          "## Missed",
          "",
          "| case | kind | route | answering notes not in the first 8 |",
          "| --- | --- | --- | --- |",
          ...missed,
        ]
      : []),
    "",
    "## Release gates",
    "",
    ...(values.hybrid
      ? gateTable(gates)
      : ["None: keyword-only answers say so, and the recall@8 floor is judged on a `--hybrid` run."]),
  ].join("\n") + "\n",
);
console.log(`${ok ? "pass" : "FAIL"} (${mode}). Summary in ${join(values.out, "summary.md")}.`);
if (!ok) process.exitCode = 1;
