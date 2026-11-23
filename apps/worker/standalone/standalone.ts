// `vp run dev:standalone`: the real Worker and site on localhost with no accounts and no secrets, for a contributor
// or a cloud agent without the maintainers' Doppler (docs/operations/development.md#standalone-dev). Miniflare runs
// the Worker's own bundle with every binding local: the Base DO, R2, the jobs queue, the Secrets Store, the OCR and
// Typst Workers, and email printed to this console. Neon is PGlite served over Postgres's protocol (postgres.ts),
// which the Hyperdrive binding reaches as it would a branch. Workers AI has no local stand-in, so search is keyword
// only and a PDF stays unread. Everything lives in memory: stopping it ends every account and record. It listens on
// 1341, off the ports `vp run dev` takes, or on BRAINIAC_PORT, which `--stage standalone` (scripts/dev-auth.ts) reads.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { Miniflare, Response } from "miniflare";

import { bundleWorker } from "../../../scripts/bundle-worker.ts";
import { standalone, TURNSTILE_TEST_SITE_KEY } from "../../../scripts/doctor.ts";
import { ocrWorker } from "../../../scripts/ocr-worker.ts";
import { typstWorker } from "../../../scripts/typst-worker.ts";
import { servePostgres } from "./postgres.ts";

const ROOT = join(import.meta.dirname, "../../..");
const { port } = standalone;

// The site's build, served as the Worker's assets as alchemy.run.ts does.
execFileSync("vp", ["build"], { cwd: join(ROOT, "apps/web"), stdio: "inherit" });

// Accounts and the base registry, migrated as a Neon branch is.
const db = new PGlite();
const migrations = join(ROOT, "infra/migrations");
for (const file of readdirSync(migrations).toSorted())
  await db.exec(readFileSync(join(migrations, file), "utf8"));
const postgres = servePostgres(db);
await new Promise<void>((resolve) => postgres.listen(0, "127.0.0.1", resolve));
const { port: postgresPort } = postgres.address() as AddressInfo;

/**
 * A helper Worker (OCR, Typst) with its ASSETS served from its folder by Node. Miniflare backs every Worker's assets
 * with one storage service of the same name, so in one instance only the site's can be real. Both fetch flat names.
 */
const folderAssets = <W extends { assets: { directory: string } }>({ assets, ...worker }: W) => ({
  ...worker,
  serviceBindings: {
    ASSETS: (request: Request) =>
      readFile(join(assets.directory, basename(new URL(request.url).pathname))).then(
        (bytes) => new Response(bytes),
        () => new Response("Not found", { status: 404 }),
      ),
  },
});

const origin = `http://localhost:${port}`;
const mf = new Miniflare({
  // Loopback only: the dev sign-in token here is public, so nothing off this machine may reach the server.
  host: "127.0.0.1",
  port,
  workers: [
    {
      name: "worker",
      // Listed rather than given as `script`, which Miniflare scans for imports and a library's computed import()
      // fails.
      modules: [
        {
          type: "ESModule",
          path: "index.js",
          contents: await bundleWorker(join(ROOT, "apps/worker/src/index.ts")),
        },
      ],
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      durableObjects: { BASE: { className: "Base", useSQLite: true } },
      r2Buckets: ["BLOBS"],
      queueProducers: { JOBS: { queueName: "jobs" } },
      queueConsumers: { jobs: { maxBatchSize: 10, maxBatchTimeout: 0.1 } },
      secretsStoreSecrets: { VAULT_KEY: { store_id: "standalone", secret_name: "vault_key" } },
      // PGlite takes any user and password; Miniflare wants both.
      hyperdrives: { HYPERDRIVE: `postgres://postgres:postgres@127.0.0.1:${postgresPort}/postgres` },
      serviceBindings: { OCR: "ocr", TYPST: "typst" },
      email: { send_email: [{ name: "EMAIL" }] },
      assets: {
        directory: join(ROOT, "apps/web/dist/client"),
        binding: "ASSETS",
        routerConfig: { has_user_worker: true },
      },
      bindings: {
        STAGE: "standalone",
        BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
        DEV_SIGN_IN_TOKEN: standalone.token,
        USERCONTENT_ORIGIN: `http://usercontent.localhost:${port}`,
        EMAIL_FROM: "brainiac@localhost",
        // Cloudflare's published always-pass test keys, as every non-prod stage without its own (alchemy.run.ts).
        TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
        TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      },
    },
    folderAssets(await ocrWorker()),
    folderAssets(await typstWorker()),
  ],
});
await mf.ready;
await (
  await mf.getSecretsStoreSecretAPI("VAULT_KEY", "worker")
)().create(randomBytes(32).toString("base64url"));

console.log(`
Brainiac (standalone) on ${origin}
  a browser signed in as the fixture student:  vp run dev:sign-in --stage standalone
  an /mcp access token:                         vp run dev:token --stage standalone
  email codes and notices print here; Ctrl-C ends it, and every account and record with it.
`);

const stop = async () => {
  await mf.dispose();
  // Miniflare's connections are gone with it; close() then waits on none.
  await new Promise((resolve) => postgres.close(resolve));
  await db.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
