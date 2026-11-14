// Recovery (contract §4): a passkey added without proof of an existing one waits 72 hours, with a notice to
// every verified address, before it can approve anything. Sign-in still works meanwhile; only approvals wait.
import type { Passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import { recoveryNotice, type Mailer } from "./email.ts";

export const RECOVERY_WAIT_MS = 72 * 60 * 60 * 1000;
/** How long a passkey check vouches for the session, like the contract's 10-minute review session. */
export const VOUCH_MS = 10 * 60 * 1000;
/** A first passkey approves at once only during sign-up; an account left without one recovers like any other. */
export const SIGN_UP_MS = 60 * 60 * 1000;

/** `approvesAt` stays empty until enrollment finishes, so a half-enrolled passkey never approves. */
export type ApprovingPasskey = Passkey & { approvesAt?: Date | null };

/** The check approvals (the plan-hash signature in the DO) make before trusting a passkey. */
export const canApprove = (passkey: Pick<ApprovingPasskey, "approvesAt">, now = new Date()) =>
  passkey.approvesAt != null && passkey.approvesAt.getTime() <= now.getTime();

/** What a session records about the last time it proved a passkey that can approve. */
type SessionFields = { passkeyId?: string | null | undefined; passkeyAt?: Date | string | null | undefined };

/**
 * Until when (ms since epoch, 0 if never) this session counts as holding a passkey that can approve: 10
 * minutes after it last proved one. A session cookie alone isn't possession of a passkey, so an old or stolen
 * one can't vouch for a new passkey.
 */
export const vouchedUntil = (
  session: SessionFields,
  passkeys: readonly ApprovingPasskey[],
  now = new Date(),
) => {
  const passkey = passkeys.find((p) => p.id === session.passkeyId);
  if (!passkey || !canApprove(passkey, now) || session.passkeyAt == null) return 0;
  return new Date(session.passkeyAt).getTime() + VOUCH_MS;
};

const vouches = (session: SessionFields, passkeys: readonly ApprovingPasskey[], now: Date) =>
  vouchedUntil(session, passkeys, now) >= now.getTime();

export const recovery = (sendEmail: Mailer) =>
  ({
    id: "recovery",
    schema: {
      passkey: { fields: { approvesAt: { type: "date", required: false, input: false } } },
      session: {
        fields: {
          passkeyId: { type: "string", required: false, input: false },
          passkeyAt: { type: "date", required: false, input: false },
        },
      },
    },
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              // Runs after the passkey plugin verified the assertion, inside its sign-in.
              before: async (session, ctx) => {
                if (ctx?.path !== "/passkey/verify-authentication") return;
                const passkey = await ctx.context.adapter.findOne<Passkey>({
                  model: "passkey",
                  where: [
                    { field: "credentialID", value: String(ctx.body?.response?.id) },
                    { field: "userId", value: session.userId },
                  ],
                });
                if (passkey) return { data: { ...session, passkeyId: passkey.id, passkeyAt: new Date() } };
              },
            },
          },
        },
      },
    }),
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.returned;
            if (created instanceof APIError || !isPasskey(created)) return;
            const session = await getSessionFromCtx<{}, SessionFields>(ctx, { disableCookieCache: true });
            if (!session) return;
            const now = new Date();
            const others = (await passkeysOf(ctx, created.userId)).filter((p) => p.id !== created.id);
            // Only a verified address makes a sign-up: an OAuth account can arrive with someone else's
            // unverified email, and its passkey must not outlast the real owner claiming the address.
            const signUp =
              session.user.emailVerified &&
              others.length === 0 &&
              now.getTime() - session.user.createdAt.getTime() <= SIGN_UP_MS;
            const immediate = signUp || vouches(session.session, others, now);
            const approvesAt = immediate ? now : new Date(now.getTime() + RECOVERY_WAIT_MS);
            // Nobody to notify means no recovery passkey at all.
            if (!immediate && !session.user.emailVerified) {
              await removePasskey(ctx, created.id);
              throw new APIError("FORBIDDEN", {
                message: "Confirm your email first: sign out, then sign in with an email code.",
              });
            }
            // The notice goes out before the passkey gets a date: if anything fails in between, the passkey is
            // left unable to approve, never approving without anyone told.
            if (!immediate) {
              try {
                const accountURL = new URL("/account", ctx.context.baseURL).toString();
                await sendEmail(recoveryNotice(session.user.email, approvesAt, accountURL));
              } catch (error) {
                ctx.context.logger.error("recovery notice failed", error);
                await removePasskey(ctx, created.id);
                throw new APIError("SERVICE_UNAVAILABLE", {
                  message: "We couldn't send the notice for this passkey. Try again in a few minutes.",
                });
              }
            }
            await ctx.context.adapter.update({
              model: "passkey",
              where: [{ field: "id", value: created.id }],
              update: { approvesAt },
            });
            // The sign-up passkey vouches for the second one the account page asks for next.
            if (signUp) {
              await ctx.context.internalAdapter.updateSession(session.session.token, {
                passkeyId: created.id,
                passkeyAt: now,
              });
            }
            return ctx.json({ ...created, approvesAt });
          }),
        },
      ],
      before: [
        {
          // Without this, someone holding only the email could remove the real passkeys. Removing your own last
          // approving passkey is allowed: like losing it, the next one goes through recovery.
          matcher: (ctx) => ctx.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            // Straight from Neon: a revoked session must not fall through to the endpoint, whose session
            // check would still accept the 5-minute cookie cache.
            const session = await getSessionFromCtx<{}, SessionFields>(ctx, { disableCookieCache: true });
            if (!session) throw new APIError("UNAUTHORIZED");
            const now = new Date();
            // A passkey that can't approve yet (enrollment unfinished, or still waiting) goes without proof;
            // that's how you remove one you didn't add. Each delete is one conditional statement, judged as of
            // this request, so a check can't go stale before its delete. Two of them, because adapters disagree
            // on how AND and OR combine; NULL first, since a date only ever goes from NULL to a value.
            const removeIf = (approvesAt: { operator: "gt"; value: Date } | { value: null }) =>
              ctx.context.adapter.deleteMany({
                model: "passkey",
                where: [
                  { field: "id", value: String(ctx.body?.id) },
                  { field: "userId", value: session.user.id },
                  { field: "approvesAt", ...approvesAt },
                ],
              });
            if ((await removeIf({ value: null })) + (await removeIf({ operator: "gt", value: now })) > 0) {
              return ctx.json({ status: true });
            }
            const proof = session.session.passkeyId
              ? await ctx.context.adapter.findOne<ApprovingPasskey>({
                  model: "passkey",
                  where: [
                    { field: "id", value: session.session.passkeyId },
                    { field: "userId", value: session.user.id },
                  ],
                })
              : null;
            if (!vouches(session.session, proof ? [proof] : [], now)) {
              throw new APIError("FORBIDDEN", {
                message: "Confirm with a passkey that can approve to remove this one.",
              });
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

const passkeysOf = (ctx: HookContext, userId: string) =>
  ctx.context.adapter.findMany<ApprovingPasskey>({
    model: "passkey",
    where: [{ field: "userId", value: userId }],
  });

const removePasskey = (ctx: HookContext, id: string) =>
  ctx.context.adapter.delete({ model: "passkey", where: [{ field: "id", value: id }] });

const isPasskey = (value: unknown): value is Passkey =>
  typeof value === "object" && value !== null && "credentialID" in value && "userId" in value;
