// The weekly email of questions (docs/product/features/questions.md): links to the site, where each is answered,
// never by reply. The Worker's cron sends one to each record's owner with something waiting. The record decides
// what the email may say (packages/base/src/questions.ts); a sensitive question's words never reach it.
import type { Digest } from "@brainiac/base";

import type { Mailer } from "./auth/email.ts";
import type { Db } from "./registry.ts";

/** The weekly cron (alchemy.run.ts): Mondays at 08:00 UTC. */
export const DIGEST_CRON = "0 8 * * 1";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One week's email. The subject says only how many: notification previews show it. */
export function digestEmail(to: string, digest: Digest, origin: string) {
  const asked = digest.lines.length + digest.private;
  const url = `${origin}/questions`;
  return {
    to,
    subject: `${plural(asked, "question", "questions")} about your Brainiac record`,
    text: [
      "Brainiac found gaps in your record before an application does. Answer them on the site:",
      digest.lines.map((line) => `- ${line}`).join("\n"),
      digest.private > 0
        ? `${plural(digest.private, "private question", "private questions")}, shown only when you sign in.`
        : "",
      digest.more > 0 ? `${digest.more} more wait until these are answered.` : "",
      url,
      `You get this once a week while questions are waiting. Turn it off at ${url}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** A record's digest, by its base id. */
type Records = (baseId: string) => { questionDigest(): Promise<Digest | undefined> | Digest | undefined };

/**
 * Sends this week's emails: one per live record whose owner has a verified address and something waiting. One
 * record failing never stops the rest; the failures are logged and counted.
 */
export async function sendDigests(db: Db, records: Records, mail: Mailer, origin: string) {
  const { rows } = await db.query<{ id: string; email: string }>(
    `select "bases"."id", "user"."email" from "bases" join "user" on "user"."id" = "bases"."ownerId"
     where "bases"."deletedAt" is null and "user"."emailVerified"`,
    [],
  );
  let sent = 0;
  let failed = 0;
  for (const { id, email } of rows) {
    try {
      const digest = await records(id).questionDigest();
      if (!digest) continue;
      await mail(digestEmail(email, digest, origin));
      sent++;
    } catch (error) {
      failed++;
      console.error("weekly questions email failed", { base: id, error: String(error) });
    }
  }
  return { sent, failed };
}
