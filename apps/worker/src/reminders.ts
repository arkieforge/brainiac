// Expiry reminders by email (docs/product/features/applications.md): the record's alarm sends one on the days an
// item is 60, 30, 7 and 0 days from expiring. The record decides what it may say (packages/base/src/expiry.ts);
// a sensitive item is only counted. It follows the same switch as the weekly questions email.
import type { Reminders } from "@brainiac/base";

import type { Mailer } from "./auth/email.ts";
import type { Db } from "./registry.ts";

/** A reminder email. The subject says only how many: notification previews show it. */
export function reminderEmail(to: string, reminders: Reminders, origin: string) {
  const items = reminders.lines.length + reminders.private;
  return {
    to,
    subject: `${items === 1 ? "1 item" : `${items} items`} in your Brainiac record ${items === 1 ? "expires" : "expire"} soon`,
    text: [
      "Renew these before an application needs them:",
      reminders.lines.map((line) => `- ${line}`).join("\n"),
      reminders.private > 0
        ? `${reminders.private === 1 ? "1 private item" : `${reminders.private} private items`} too, shown only when you sign in.`
        : "",
      `${origin}/review`,
      `Turn these emails off at ${origin}/questions.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Emails `reminders` to the record's owner, if the record is live and its owner's address is verified. */
export async function sendReminders(
  db: Db,
  baseId: string,
  reminders: Reminders,
  mail: Mailer,
  origin: string,
) {
  const { rows } = await db.query<{ email: string }>(
    `select "user"."email" from "bases" join "user" on "user"."id" = "bases"."ownerId"
     where "bases"."id" = $1 and "bases"."deletedAt" is null and "user"."emailVerified"`,
    [baseId],
  );
  const [owner] = rows;
  if (owner) await mail(reminderEmail(owner.email, reminders, origin));
}
