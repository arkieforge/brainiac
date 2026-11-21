// Every cloud resource Brainiac runs on, per stage: `vp run deploy --stage pr-123` (laptops default to
// `live_$USER`, `vp run dev` to `dev_$USER`; `prod` deploys only from CI). Alchemy 2.0, pinned to one beta.
// Secrets come from Doppler (`doppler run`); see infra/README.md for what each one is.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
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
    const { dev } = yield* Alchemy.AlchemyContext;
    const prod = stage === "prod";

    // The names Alchemy 0.94 gave (`brainiac-<id>-<stage>`), so 2.0 adopted prod in place and every stage
    // keeps a readable workers.dev URL. R2 names allow no underscores, and 2.0 stages have them (`dev_sam`).
    const name = (id: string) => `brainiac-${id}-${stage.replaceAll("_", "-")}`;
    const projectId = yield* Config.String("NEON_PROJECT_ID");

    const stack = Effect.gen(function* () {
      // Previews and dev stages tear down with their files; in prod, protect() refuses the delete anyway.
      const blobs = yield* Cloudflare.R2.Bucket("blobs", { name: name("blobs"), forceDestroy: !prod });
      const jobs = yield* Cloudflare.Queues.Queue("jobs", { name: name("jobs") });

      // Accounts and the base registry. Each stage gets its own branch of the Doppler
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
        // Sessions and approvals must never be read stale.
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
      // Wraps every record's data key (the vault, packages/base/src/vault.ts). Each generation is made once per
      // stage and kept in Alchemy state; replacing one (a new value or a rename) leaves every record it wraps
      // unreadable, which is why prod's are protected below. Rotating moves to a new generation, with the one
      // before bound beside it until every record has rewrapped (infra/README.md#rotating-the-vault-key).
      // Generation 1 keeps the names it was made with. The account has one Secrets Store, shared with other
      // apps' secrets, so ours carry the stage in their name.
      const secrets = yield* Cloudflare.SecretsStore.Store("secrets");
      const vaultKey = Effect.fn(function* (generation: number) {
        const id = generation === 1 ? "" : `-${generation}`;
        return yield* Cloudflare.SecretsStore.Secret(`vault-key${id}`, {
          store: secrets,
          name: `brainiac_vault_key_${stage.replaceAll(/\W/g, "_")}${generation === 1 ? "" : `__g${generation}`}`,
          value: yield* Alchemy.makeRandom(`vault-key-value${id}`),
        });
      });
      const generation = Number((yield* optional("VAULT_KEY_GENERATION")) ?? 1);
      const previousGeneration = yield* optional("VAULT_KEY_PREVIOUS");
      if (
        !Number.isInteger(generation) ||
        generation < 1 ||
        (previousGeneration !== undefined && Number(previousGeneration) !== generation - 1)
      )
        return yield* Effect.die(
          new Error(
            `VAULT_KEY_GENERATION=${generation} with VAULT_KEY_PREVIOUS=${previousGeneration ?? "(unset)"}: ` +
              "the generation is a whole number from 1, and the previous one, while set, is the one before it.",
          ),
        );
      // Prod retains the previous key when its declaration goes, so ending a rotation passes protect() and the
      // old value stays in the Secrets Store until someone deletes it by hand; other stages delete it.
      const previousKey =
        previousGeneration === undefined
          ? undefined
          : yield* vaultKey(generation - 1).pipe(Alchemy.RemovalPolicy.retain(prod));

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

      // A custom hostname in a Cloudflare zone of this account, kept in Doppler so moving domains needs no code
      // change. The workers.dev URL keeps working beside it. Passkeys are bound to the hostname they were
      // made on, so a passkey from one won't sign in on the other.
      const domain = yield* optional("DOMAIN");
      // Uploaded files are served only from their own origin, never the site's (apps/worker/src/usercontent.ts).
      // Under `vp run dev` that is usercontent.localhost, which browsers resolve to loopback; a stage without a
      // custom domain has none, and the site says it can't show files there.
      const usercontent = domain ? `usercontent.${domain}` : undefined;
      const usercontentOrigin = usercontent
        ? `https://${usercontent}`
        : dev
          ? "http://usercontent.localhost:1337"
          : undefined;

      // The site (apps/web), built to static files: its shell and assets. Rebuilt only when its files change.
      const web = yield* Command.Build("web", {
        command: "vp build",
        cwd: "apps/web",
        outdir: "dist/client",
      });

      // OCR for the vault's checks (apps/ocr): its own Worker, so Tesseract's wasm and its ~60 MB heap stay out
      // of the main one's isolates and cold starts. Only the jobs consumer reaches it, over RPC; its models are its
      // assets, and it has no URL of its own.
      const ocr = yield* Cloudflare.Worker("ocr", {
        name: name("ocr"),
        main: "apps/ocr/src/index.ts",
        assets: { directory: "apps/ocr/models" },
        compatibility: { flags: ["nodejs_compat"] },
        workersDev: false,
        // One image is two Tesseract passes, about a second each locally; room for slower CPUs and large scans.
        limits: { cpuMs: 60_000 },
        env: { IMAGES: Cloudflare.Images.Images() },
        dev: { port: 1338 },
      });

      // Typst for drafts (apps/typst): its own Worker, so the compiler's 28 MB of wasm stays out of the main one's
      // cold starts. Only the site's download routes reach it, over RPC; its fonts are its assets.
      const typst = yield* Cloudflare.Worker("typst", {
        name: name("typst"),
        main: "apps/typst/src/index.ts",
        assets: { directory: "apps/typst/fonts" },
        compatibility: { flags: ["nodejs_compat"] },
        workersDev: false,
        // A CV compiles in well under a second locally; room for a long packet on a slower CPU.
        limits: { cpuMs: 30_000 },
        dev: { port: 1339 },
      });

      const worker = yield* Cloudflare.Worker("worker", {
        name: name("worker"),
        ...(domain && usercontent && { domain: { name: domain, aliases: [usercontent] } }),
        main: "apps/worker/src/index.ts",
        // The site's own port under `vp run dev`: the dev scripts, usercontent.localhost and the docs all say 1337,
        // so the helper Workers above, which start first, keep off it and this one fails rather than drift.
        dev: { port: 1337, strictPort: true },
        // A path that is a built file is served straight from the edge; every other one runs the Worker, which
        // answers its own routes and hands the rest of the pages the web app's shell (apps/worker/src/index.ts).
        // The build's output hash is set whenever it memoizes, which it does by default.
        assets: { directory: web.outdir, hash: web.hash.output.as<string>() },
        // Strictly public fetch: a fetch to one of our own hostnames goes through Cloudflare's front door, not
        // straight to an origin. The MCP client metadata fetch relies on it (apps/worker/src/auth/cimd-fetch.ts).
        compatibility: { flags: ["nodejs_compat", "global_fetch_strictly_public"] },
        // The weekly questions email (apps/worker/src/digest.ts, DIGEST_CRON) and the GitHub connector's daily
        // sweep (apps/worker/src/connectors/github.ts, SWEEP_CRON).
        // While a vault key rotation runs, the sweep that wakes records which haven't rewrapped
        // (apps/worker/src/vault-rotation.ts, VAULT_SWEEP_CRON).
        crons: ["0 8 * * 1", "0 3 * * *", ...(previousKey ? ["*/10 * * * *"] : [])],
        env: {
          // One Base Durable Object per person's record (SQLite storage).
          BASE: Cloudflare.DurableObject("Base"),
          BLOBS: blobs,
          // Document-to-text and embeddings for search, in the jobs consumer.
          AI: Cloudflare.Workers.AI(),
          // A saved link's PDF snapshot, in the jobs consumer (apps/worker/src/connectors/links.ts).
          BROWSER: Cloudflare.Workers.Browser(),
          // The text of photos and scans, for the vault's checks only, in the jobs consumer.
          OCR: ocr,
          // A draft's PDF, in the site's download routes (apps/worker/src/drafts.ts).
          TYPST: typst,
          VAULT_KEY: yield* vaultKey(generation),
          ...(previousKey && { VAULT_KEY_PREVIOUS: previousKey }),
          JOBS: jobs,
          HYPERDRIVE: hyperdrive,
          BETTER_AUTH_SECRET: authSecret,
          STAGE: stage,
          ...(usercontentOrigin && { USERCONTENT_ORIGIN: usercontentOrigin }),
          // Links in the weekly questions email (apps/worker/src/digest.ts); a stage without a domain sends none.
          ...(domain && { SITE_ORIGIN: `https://${domain}` }),
          // Dev sign-in as the fixture student (apps/worker/src/dev.ts); prod never gets it.
          ...(prod ? {} : yield* secretIf("DEV_SIGN_IN_TOKEN")),
          TURNSTILE_SITE_KEY: turnstileSite,
          ...(turnstileSecret && { TURNSTILE_SECRET_KEY: Redacted.make(turnstileSecret) }),
          ...(yield* secretIf("GOOGLE_CLIENT_ID")),
          ...(yield* secretIf("GOOGLE_CLIENT_SECRET")),
          ...(yield* secretIf("GITHUB_CLIENT_ID")),
          ...(yield* secretIf("GITHUB_CLIENT_SECRET")),
          // The GitHub connector's App (apps/worker/src/connectors/github.ts); off until all five are set.
          ...(yield* secretIf("GITHUB_APP_SLUG")),
          ...(yield* secretIf("GITHUB_APP_CLIENT_ID")),
          ...(yield* secretIf("GITHUB_APP_CLIENT_SECRET")),
          ...(yield* secretIf("GITHUB_APP_PRIVATE_KEY")),
          ...(yield* secretIf("GITHUB_APP_WEBHOOK_SECRET")),
          // The ORCID connector (apps/worker/src/connectors/orcid.ts): a sandbox client off prod; off until both are set.
          ...(yield* secretIf("ORCID_CLIENT_ID")),
          ...(yield* secretIf("ORCID_CLIENT_SECRET")),
          // Drift checks through treg (apps/worker/src/connectors/profiles.ts); off until it is set.
          ...(yield* secretIf("TREG_TOKEN")),
          // Pro through Polar (apps/worker/src/billing.ts): Polar's sandbox off prod; off until all three are set.
          ...(yield* secretIf("POLAR_ACCESS_TOKEN")),
          ...(yield* secretIf("POLAR_WEBHOOK_SECRET")),
          ...(yield* secretIf("POLAR_PRODUCT_ID")),
          // What each record costs to run: a point per tool call and upload (apps/worker/src/base.ts).
          USAGE: yield* Cloudflare.AnalyticsEngine.Dataset("usage", { dataset: name("usage") }),
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
      // The public site (apps/marketing): static pages on an assets-only Worker, linking to the app's origin. It has
      // its workers.dev URL until the domain decision (#47) gives it one of its own.
      const marketing = yield* Command.Build("marketing-pages", {
        command: "npx astro build",
        cwd: "apps/marketing",
        outdir: "dist",
        env: { PUBLIC_APP_ORIGIN: domain ? `https://${domain}` : worker.url.as<string>() },
      });
      yield* Cloudflare.Worker("marketing", {
        name: name("marketing"),
        dev: { port: 1340 },
        assets: { directory: marketing.outdir, hash: marketing.hash.output.as<string>() },
      });

      return { url: worker.url };
    });

    // In prod, any plan that would replace or delete a resource (a rename, a removed declaration,
    // `alchemy destroy`) fails before anything is applied. The Worker owns every Base Durable Object.
    return yield* stack.pipe(Alchemy.RemovalPolicy.protect(prod));
  }),
);
