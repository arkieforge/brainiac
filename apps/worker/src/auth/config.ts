// Better Auth, self-hosted in the Worker with its tables in Neon (docs/internals/security.md, "Auth").
// Sign-in and approvals share the passkeys enrolled here. Kept free of Worker bindings so the tests and the
// schema check (schema.test.ts) build the same options.
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { captcha } from "better-auth/plugins/captcha";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";

import { fetchClientMetadataResource } from "./cimd-fetch.ts";
import { connectedApps } from "./connected-apps.ts";
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
  /** Ends an MCP client's connection in the person's record when they disconnect the app. */
  onDisconnect?: ((userId: string, clientId: string) => Promise<void>) | undefined;
}

/** Entry points that can create an account. Passkey sign-in can't, so it skips the challenge. */
const SIGN_UP_PATHS = ["/email-otp/send-verification-otp", "/sign-in/social"];

/**
 * How long an MCP access token lives (Better Auth's default). It's a JWT, so it outlives a Disconnect; /mcp also
 * finds its consent on every request (mcp/handler.ts). Not shorter: Codex doesn't refresh, it sends the person
 * through sign-in again when its token runs out.
 */
const ACCESS_TOKEN_SECONDS = 60 * 60;

/** Where MCP clients connect, and the audience every access token is bound to. */
export const mcpResource = (baseURL: string) => `${baseURL}/mcp`;

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
      // These change a consent but not the tokens issued under it; Disconnect (connected-apps.ts) ends the grant.
      "/oauth2/delete-consent",
      "/oauth2/update-consent",
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
      // The OAuth 2.1 server MCP clients sign in through. Clients identify by a metadata URL (CIMD, below) instead
      // of registering, so there's no open registration endpoint. Only the browser flow and refresh: a public
      // client has no secret for client_credentials.
      mcp({
        resource: mcpResource(config.baseURL),
        loginPage: "/sign-in",
        consentPage: "/consent",
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      connectedApps(config.onDisconnect),
    ],
  }) satisfies BetterAuthOptions;

export const createAuth = (config: AuthConfig) => betterAuth(authOptions(config));
