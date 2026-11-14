// Every cloud resource Brainiac runs on, per stage: `vp run deploy --stage pr-123` (laptops default to
// `live_$USER`, `vp run dev` to `dev_$USER`; `prod` deploys only from CI). Alchemy 2.0, pinned to one beta.
// Secrets come from Doppler (`doppler run`); see infra/README.md for what each one is.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "brainiac",
  {
    providers: Neon.providers().pipe(Layer.provideMerge(Cloudflare.providers())),
    // Shared by laptops, worktrees and CI. Its own Worker, because the account hosts other apps' stores.
    state: Cloudflare.state({ workerName: "brainiac-state" }),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const prod = stage === "prod";

    // Doppler's prd config holds prod's Neon project; it and the prod stage only ever run together, so a
    // laptop (dev config) can't deploy prod onto dev data and no other stage can reach prod's.
    const doppler = yield* Config.String("DOPPLER_CONFIG").pipe(Config.withDefault("(none)"));
    if (prod !== (doppler === "prd")) {
      return yield* Effect.die(new Error(`Stage ${stage} can't run with Doppler config ${doppler}.`));
    }

    // The names Alchemy 0.94 gave (`brainiac-<id>-<stage>`), so 2.0 adopted prod in place and every stage
    // keeps a readable workers.dev URL. R2 names allow no underscores, and 2.0 stages have them (`dev_sam`).
    const name = (id: string) => `brainiac-${id}-${stage.replaceAll("_", "-")}`;
    const projectId = yield* Config.String("NEON_PROJECT_ID");

    const stack = Effect.gen(function* () {
      const blobs = yield* Cloudflare.R2.Bucket("blobs", { name: name("blobs") });
      const jobs = yield* Cloudflare.Queues.Queue("jobs", { name: name("jobs") });

      // Accounts, billing state and the base registry. Each stage gets its own branch of the Doppler
      // config's Neon project (brainiac-dev, or brainiac-prod for prod), so a preview never sees prod
      // data. The projects are made once outside Alchemy (infra/README.md), so no stage can delete one.
      const db = yield* Neon.Branch("db", { project: { projectId }, name: stage });
      const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("hyperdrive", {
        name: name("hyperdrive"),
        origin: db.origin,
        // Sessions, approvals and billing must never be read stale.
        caching: { disabled: true },
      });

      const worker = yield* Cloudflare.Worker("worker", {
        name: name("worker"),
        main: "apps/worker/src/index.ts",
        compatibility: { flags: ["nodejs_compat"] },
        env: {
          // One Base Durable Object per person's record (SQLite storage).
          BASE: Cloudflare.DurableObject("Base"),
          BLOBS: blobs,
          JOBS: jobs,
          HYPERDRIVE: hyperdrive,
        },
      });
      return { url: worker.url };
    });

    // In prod, any plan that would replace or delete a resource (a rename, a removed declaration,
    // `alchemy destroy`) fails before anything is applied. The Worker owns every Base Durable Object.
    return yield* stack.pipe(Alchemy.RemovalPolicy.protect(prod));
  }),
);
