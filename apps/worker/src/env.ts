import type { Base, JobMessage } from "./base.ts";
import type { Typst } from "./drafts.ts";
import type { Ocr } from "./jobs.ts";

export interface Env {
  /** The web app's build (apps/web): its shell and static assets. */
  ASSETS: Fetcher;
  /** Workers AI: document-to-text and embeddings for search (jobs.ts). Brainiac runs no generation model. */
  AI: Ai;
  /** The OCR Worker (apps/ocr), over RPC: the text of photos and scans, for the vault's checks only (jobs.ts). */
  OCR: Ocr;
  /** The Typst Worker (apps/typst), over RPC: a draft's PDF for the person's download (drafts.ts). */
  TYPST?: Typst;
  BASE: DurableObjectNamespace<Base>;
  BLOBS: R2Bucket;
  /** Wraps every record's data key (packages/base/src/vault.ts). A Secrets Store secret, one per stage and generation. */
  VAULT_KEY: SecretsStoreSecret;
  /**
   * The vault key `VAULT_KEY` replaced, bound only while a rotation runs (infra/README.md#rotating-the-vault-key)
   * so records it still wraps open and rewrap.
   */
  VAULT_KEY_PREVIOUS?: SecretsStoreSecret;
  JOBS: Queue<JobMessage>;
  /** Postgres (this stage's Neon branch) for accounts and the base registry. */
  HYPERDRIVE: Hyperdrive;
  /** Signs sessions and encrypts the JWT keys; generated per stage by alchemy.run.ts. */
  BETTER_AUTH_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** The GitHub App the connector runs as (connectors/github.ts); the connector is off until all five exist. */
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** The ORCID API client (connectors/orcid.ts); the connector is off until both exist. */
  ORCID_CLIENT_ID?: string;
  ORCID_CLIENT_SECRET?: string;
  /** treg (docs/operations/services.md), for drift checks of the person's own profiles; off until it exists. */
  TREG_TOKEN?: string;
  /** Polar, for Pro (billing.ts); billing and every record's limits are off until all three exist. */
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_PRODUCT_ID?: string;
  /** Analytics Engine: one point per tool call and upload, by record, to measure what each costs to run. */
  USAGE?: AnalyticsEngineDataset;
  /** Browser Rendering, for a saved link's PDF snapshot (connectors/links.ts); a stage without it takes none. */
  BROWSER?: BrowserRun;
  /** Cloudflare Email Service, bound only once a sending address is set up (infra/README.md). */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  /** The site's public origin (`https://<domain>`), for links in emails the cron sends; set only with a domain. */
  SITE_ORIGIN?: string;
  /** The Alchemy stage: `prod`, `pr-<n>`, `dev_<you>`, `live_<you>`. */
  STAGE: string;
  /**
   * Where uploaded files are served (`https://usercontent.<domain>`, or `http://usercontent.localhost:1337` under
   * `vp run dev`), never from the site's own origin (usercontent.ts). A stage without a custom domain has none,
   * and the site says it can't show files there.
   */
  USERCONTENT_ORIGIN?: string;
  /** Dev sign-in as the fixture student (dev.ts). Bound only outside prod, from Doppler `dev`. */
  DEV_SIGN_IN_TOKEN?: string;
}
