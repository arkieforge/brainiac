// Better Auth, self-hosted in the Worker with its tables in Neon (docs/internals/security.md, "Auth").
// Sign-in and approvals share the passkeys enrolled here. Kept free of Worker bindings so the tests and the
// schema check (schema.test.ts) build the same options.
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { captcha } from "better-auth/plugins/captcha";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";

import { otpEmail, type Mailer } from "./email.ts";
import { recovery } from "./recovery.ts";

type OAuthApp = { clientId: string; clientSecret: string };

export interface AuthConfig {
  database: BetterAuthOptions["database"];
  /** The origin the request reached, which Cloudflare routed by hostname. Passkeys are bound to its host. */
  baseURL: string;
  secret: string;
  sendEmail: Mailer;
  /** Missing means sign-up fails closed: the captcha plugin refuses without a secret. */
  turnstileSecret?: string | undefined;
  google?: OAuthApp | undefined;
  github?: OAuthApp | undefined;
}

/** Entry points that can create an account. Passkey sign-in can't, so it skips the challenge. */
const SIGN_UP_PATHS = ["/email-otp/send-verification-otp", "/sign-in/social"];

export const authOptions = (config: AuthConfig) =>
  ({
    appName: "Brainiac",
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.database,
    telemetry: { enabled: false },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    // Better Auth turns this on only when NODE_ENV is production, which Workers never set. Per isolate, in memory.
    rateLimit: { enabled: true },
    // Nobody has a password, so the email-code reset flow would only mail codes to people who didn't ask.
    disabledPaths: [
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
      "/email-otp/reset-password",
    ],
    // Session checks skip Neon for 5 minutes, so a short Neon outage doesn't sign anyone out.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    socialProviders: {
      ...(config.google && { google: config.google }),
      ...(config.github && { github: config.github }),
    },
    plugins: [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: config.turnstileSecret ?? "",
        endpoints: SIGN_UP_PATHS,
      }),
      emailOTP({
        storeOTP: "hashed",
        sendVerificationOTP: ({ email, otp }) => config.sendEmail(otpEmail(email, otp)),
      }),
      passkey({ rpName: "Brainiac" }),
      // After passkey: it extends the passkey table.
      recovery(config.sendEmail),
      // JWTs come from /token only. Adding one to every session check needs Neon for the signing key, which
      // would undo the cookie cache during an outage.
      jwt({ disableSettingJwtHeader: true }),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (config: AuthConfig) => betterAuth(authOptions(config));
