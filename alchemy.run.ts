// Every cloud resource Brainiac runs on, per stage: `vp run deploy --stage pr-123` (laptops default to
// `live_$USER`, `vp run dev` to `dev_$USER`; `prod` deploys only from CI). Alchemy 2.0, pinned to one beta.
// Secrets come from Doppler (`doppler run`); see infra/README.md for what each one is.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Doppler's prd config holds prod's Neon project; it and the prod stage only ever run together, so a laptop
// (dev config) can't deploy prod onto dev data and no other stage can reach prod's. A layer under the
// providers, because `destroy` builds those but never runs the stack program below.
const dopplerMatchesStage = Layer.effectDiscard(
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const doppler = yield* Config.String("DOPPLER_CONFIG").pipe(Config.withDefault("(none)"));
    if ((stage === "prod") !== (doppler === "prd")) {
      return yield* Effect.die(new Error(`Stage ${stage} can't run with Doppler config ${doppler}.`));
    }
  }).pipe(Effect.orDie),
);

export default Alchemy.Stack(
  "brainiac",
  {
    providers: Neon.providers().pipe(
      Layer.provideMerge(Cloudflare.providers()),
      Layer.provideMerge(dopplerMatchesStage),
    ),
    // Shared by laptops, worktrees and CI. Its own Worker, because the account hosts other apps' stores.
    state: Cloudflare.state({ workerName: "brainiac-state" }),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const prod = stage === "prod";

    // The names Alchemy 0.94 gave (`brainiac-<id>-<stage>`), so 2.0 adopted prod in place and every stage
    // keeps a readable workers.dev URL. R2 names allow no underscores, and 2.0 stages have them (`dev_sam`).
    const name = (id: string) => `brainiac-${id}-${stage.replaceAll("_", "-")}`;
    const projectId = yield* Config.String("NEON_PROJECT_ID");

    const stack = Effect.gen(function* () {
      // Previews and dev stages tear down with their files; in prod, protect() refuses the delete anyway.
      const blobs = yield* Cloudflare.R2.Bucket("blobs", { name: name("blobs"), forceDestroy: !prod });
      const jobs = yield* Cloudflare.Queues.Queue("jobs", { name: name("jobs") });

      // Accounts, billing state and the base registry. Each stage gets its own branch of the Doppler
      // config's Neon project (brainiac-dev, or brainiac-prod for prod), so a preview never sees prod
      // data. The projects are made once outside Alchemy (infra/README.md), so no stage can delete one.
      // Better Auth's tables come from infra/migrations, applied (forward only) before the Worker updates. That
      // order rides on Hyperdrive: it waits for the branch's origin, and the Worker waits for Hyperdrive.
      const db = yield* Neon.Branch("db", {
        project: { projectId },
        name: stage,
        migrations: "infra/migrations",
      });
      const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("hyperdrive", {
        name: name("hyperdrive"),
        origin: db.origin,
        // Sessions, approvals and billing must never be read stale.
        caching: { disabled: true },
      });

      // Signs sessions and encrypts the JWT keys. Made once per stage and kept in Alchemy state; replacing
      // it ends every session.
      const authSecret = yield* Alchemy.makeRandom("auth-secret");
      // Optional settings from Doppler. Each feature stays off until its values exist (infra/README.md).
      const optional = Effect.fn(function* (key: string) {
        return Option.getOrUndefined(yield* Config.option(Config.String(key))) || undefined;
      });
      const secretIf = Effect.fn(function* (key: string) {
        const value = yield* optional(key);
        return value ? { [key]: Redacted.make(value) } : {};
      });
      // Without its own keys a non-prod stage uses Turnstile's published always-pass test keys; prod has no
      // fallback, so sign-up there refuses until the real keys are set.
      const turnstileTest = {
        site: "1x00000000000000000000AA",
        secret: "1x0000000000000000000000000000000AA",
      };
      const turnstileSite = (yield* optional("TURNSTILE_SITE_KEY")) ?? (prod ? "" : turnstileTest.site);
      const turnstileSecret =
        (yield* optional("TURNSTILE_SECRET_KEY")) ?? (prod ? undefined : turnstileTest.secret);
      // Cloudflare Email Service sends from an address on a domain onboarded to it; until one exists, email
      // codes and recovery notices fail with a clear error.
      const emailFrom = yield* optional("EMAIL_FROM");
      const email = emailFrom
        ? {
            EMAIL: yield* Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [emailFrom] }),
            EMAIL_FROM: emailFrom,
          }
        : {};

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
          BETTER_AUTH_SECRET: authSecret,
          TURNSTILE_SITE_KEY: turnstileSite,
          ...(turnstileSecret && { TURNSTILE_SECRET_KEY: Redacted.make(turnstileSecret) }),
          ...(yield* secretIf("GOOGLE_CLIENT_ID")),
          ...(yield* secretIf("GOOGLE_CLIENT_SECRET")),
          ...(yield* secretIf("GITHUB_CLIENT_ID")),
          ...(yield* secretIf("GITHUB_CLIENT_SECRET")),
          ...email,
        },
      });
      // The jobs outbox: each Base DO's alarm sends due jobs here, and the Worker's queue() handler runs
      // them. A message that keeps failing is also re-sent by the DO once its lease runs out.
      yield* Cloudflare.Queues.Consumer("jobs-consumer", {
        queueId: jobs.queueId,
        scriptName: worker.workerName,
        settings: { batchSize: 10, maxWaitTimeMs: 100 },
      });
      return { url: worker.url };
    });

    // In prod, any plan that would replace or delete a resource (a rename, a removed declaration,
    // `alchemy destroy`) fails before anything is applied. The Worker owns every Base Durable Object.
    return yield* stack.pipe(Alchemy.RemovalPolicy.protect(prod));
  }),
);
