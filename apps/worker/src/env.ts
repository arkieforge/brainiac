import type { Base, JobMessage } from "./base.ts";

export interface Env {
  BASE: DurableObjectNamespace<Base>;
  BLOBS: R2Bucket;
  JOBS: Queue<JobMessage>;
  /** Postgres (this stage's Neon branch) for accounts, billing and the base registry. */
  HYPERDRIVE: Hyperdrive;
  /** Signs sessions and encrypts the JWT keys; generated per stage by alchemy.run.ts. */
  BETTER_AUTH_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Cloudflare Email Service, bound only once a sending address is set up (infra/README.md). */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
}
