// Expiry reminders, the Worker's half (packages/base/src/reminders.ts): the record says what the email may say, and
// this sends it to the record's owner. A sensitive item's words never reach it; the email counts it and links to
// the site, where the flag beside it says what runs out.
import type { Reminder } from "@brainiac/base";

import type { Mailer } from "./auth/email.ts";
import type { Db } from "./registry.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One reminder email. The subject names nothing: notification previews show it. */
export function reminderEmail(to: string, reminder: Reminder, origin: string) {
  return {
    to,
    subject: "Something in your Brainiac record expires soon",
    text: [
      "Brainiac reminds you 60, 30 and 7 days before something in your record expires, and on the day.",
      reminder.lines.map((line) => `- ${line}`).join("\n"),
      reminder.private > 0
        ? `${plural(reminder.private, "private item", "private items")} too, shown only when you sign in.`
        : "",
      `See what relies on it, and add the renewed one: ${origin}/`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Sends a record's reminder email; resolves without sending when there is nobody or nothing to send it to. */
export type Remind = (baseId: string, reminder: Reminder) => Promise<void>;

/**
 * Sends to the verified owner of a live record. A record with nothing left to say (its items were renewed or
 * superseded since), or whose owner has no verified address, sends nothing.
 */
export const remind =
  (db: Db, mail: Mailer, origin: string): Remind =>
  async (baseId, reminder) => {
    if (reminder.lines.length === 0 && reminder.private === 0) return;
    const { rows } = await db.query<{ email: string }>(
      `select "user"."email" from "bases" join "user" on "user"."id" = "bases"."ownerId"
       where "bases"."id" = $1 and "bases"."deletedAt" is null and "user"."emailVerified"`,
      [baseId],
    );
    const [owner] = rows;
    if (owner) await mail(reminderEmail(owner.email, reminder, origin));
  };
