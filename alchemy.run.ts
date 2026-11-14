// Every cloud resource Brainiac runs on, per stage: `vp run deploy --stage pr-123` (laptops default to $USER;
// `prod` deploys only from CI). Pinned to Alchemy 0.94 (stable); moving to the 2.0 line is issue #2.
// Secrets come from Doppler (`doppler run`); see infra/README.md for what each one is.
import alchemy from "alchemy";
import { DurableObjectNamespace, Hyperdrive, Queue, R2Bucket, Worker } from "alchemy/cloudflare";
import { NeonBranch } from "alchemy/neon";
import { CloudflareStateStore } from "alchemy/state";

// The stage is resolved here and handed to Alchemy, so the guards below check the stage Alchemy will use.
// They run before `alchemy()`, because it performs a destroy itself.
const argv = process.argv;
const stageFlag = argv.indexOf("--stage");
const stage =
  (stageFlag === -1 ? undefined : argv[stageFlag + 1]) ??
  process.env.STAGE ??
  process.env.ALCHEMY_STAGE ??
  process.env.USER ??
  "dev";
const prod = stage === "prod";
if (prod && argv.includes("--destroy")) {
  throw new Error(
    "Refusing to destroy prod. Its resources are protected; remove them by hand if you mean it.",
  );
}
// Doppler's prd config holds prod's Neon project; it and the prod stage only ever run together, so a laptop
// (dev config) can't deploy prod onto dev data and no other stage can reach prod's.
if (prod !== (process.env.DOPPLER_CONFIG === "prd")) {
  throw new Error(`Stage ${stage} can't run with Doppler config ${process.env.DOPPLER_CONFIG ?? "(none)"}.`);
}

const app = await alchemy("brainiac", {
  stage,
  // Remote state, so laptops, worktrees and CI see the same stages. Its own script, because the Cloudflare
  // account hosts other apps whose state service uses a different token.
  stateStore: (scope) => new CloudflareStateStore(scope, { scriptName: "brainiac-alchemy-state" }),
});

// Everything adopts, so a cancelled deploy picks up what it already made. Previews and dev stages clean up
// fully on destroy. In prod, a plan that would delete or replace a stateful resource only drops it from
// state, so the data stays.
const blobs = await R2Bucket("blobs", { adopt: true, delete: !prod, empty: !prod });
const jobs = await Queue("jobs", { adopt: true, delete: !prod });

// One Base Durable Object per person's record (SQLite storage).
const Base = DurableObjectNamespace("base", { className: "Base", sqlite: true });

// Accounts, billing state and the base registry. Each stage gets its own branch of the Doppler config's Neon
// project (brainiac-dev, or brainiac-prod for prod), so a preview never sees prod data. The projects are made
// once outside Alchemy (infra/README.md), so no stage can delete one.
const db = await NeonBranch("db", {
  project: alchemy.env("NEON_PROJECT_ID"),
  name: app.stage,
  adopt: true,
  endpoints: [{ type: "read_write" }],
});
const [dbUri] = db.connectionUris;
if (!dbUri) throw new Error(`Neon branch ${db.name} has no connection URI`);

const hyperdrive = await Hyperdrive("hyperdrive", {
  adopt: true,
  origin: dbUri.connection_uri,
  // Sessions, approvals and billing must never be read stale.
  caching: { disabled: true },
});

export const worker = await Worker("worker", {
  entrypoint: "apps/worker/src/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { BASE: Base, BLOBS: blobs, JOBS: jobs, HYPERDRIVE: hyperdrive },
  url: true,
  adopt: true,
  // Deleting the prod Worker deletes every person's Base Durable Object with it.
  delete: !prod,
});

console.log(`brainiac (${app.stage}): ${worker.url}`);

await app.finalize();
