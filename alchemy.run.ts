// Every cloud resource Brainiac runs on, per stage: `pnpm deploy --stage dev | pr-123 | prod`.
// Pinned to Alchemy 0.94 (stable). Moving to the 2.0 line is tracked in an issue.
// Neon (project + branch per stage) and Hyperdrive are added by the auth/accounts issue.
import alchemy from "alchemy";
import { DurableObjectNamespace, Queue, R2Bucket, Worker } from "alchemy/cloudflare";

const app = await alchemy("brainiac");

// Stateful resources are adopted, never recreated, and must not be deleted by a plan diff.
const blobs = await R2Bucket("blobs", { adopt: true });
const jobs = await Queue("jobs", { adopt: true });

// One Base Durable Object per person's record (SQLite storage).
const Base = DurableObjectNamespace("base", { className: "Base", sqlite: true });

export const worker = await Worker("worker", {
  entrypoint: "apps/worker/src/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { BASE: Base, BLOBS: blobs, JOBS: jobs },
  url: true,
});

console.log(`brainiac (${app.stage}): ${worker.url}`);

await app.finalize();
