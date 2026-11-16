import { useEffect, useState } from "react";

import { api } from "../record.ts";

/** Each email Brainiac sends, and what it says it does. Both emails' footers link here. */
const EMAILS = [
  {
    email: "reminders",
    title: "Expiry reminders",
    what: "60, 30 and 7 days before a passport, score or other item in your record expires, and on the day. Private items are only counted, never named.",
  },
  {
    email: "questions",
    title: "Weekly questions",
    what: "Mondays, while questions wait: links to answer them on the site. Sensitive and background filing questions are only counted.",
  },
] as const;

type Email = (typeof EMAILS)[number]["email"];
type Switches = Record<Email, boolean>;

const switchesOf = (body: unknown): Switches | undefined =>
  typeof body === "object" &&
  body !== null &&
  "questions" in body &&
  "reminders" in body &&
  typeof body.questions === "boolean" &&
  typeof body.reminders === "boolean"
    ? { questions: body.questions, reminders: body.reminders }
    : undefined;

/**
 * Which emails are on, from the record, and a setter for what it answers next: undefined while it loads, null when
 * it can't be reached (offline).
 */
export function useEmails() {
  const [on, setOn] = useState<Switches | null>();
  useEffect(() => {
    void api("/api/emails")
      .then((res) => (res.ok ? res.json() : undefined))
      .then((body) => setOn(switchesOf(body) ?? null))
      .catch(() => setOn(null));
  }, []);
  return [on, setOn] as const;
}

/** What Brainiac emails the person, each with its own switch. The record holds them, so offline it says so. */
export function Emails() {
  const [on, setOn] = useEmails();
  const [issue, setIssue] = useState<string>();

  const toggle = async (email: Email, next: boolean) => {
    const res = await api("/api/emails", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, on: next }),
    }).catch(() => undefined);
    const saved = res?.ok ? switchesOf(await res.json()) : undefined;
    setIssue(saved ? undefined : "That didn't save. Check you're online and try again.");
    if (saved) setOn(saved);
  };

  return (
    <section className="emails">
      <header className="pane-head">
        <h1>Emails</h1>
        <p className="muted">
          What Brainiac emails you, at your sign-in address. Each one has its own switch.
        </p>
      </header>
      {on === undefined ? (
        <p className="empty">Loading…</p>
      ) : on === null ? (
        <p className="empty">Your email settings load when you're online.</p>
      ) : (
        <ul>
          {EMAILS.map(({ email, title, what }) => (
            <li key={email}>
              <input
                id={`email-${email}`}
                type="checkbox"
                checked={on[email]}
                onChange={(e) => void toggle(email, e.currentTarget.checked)}
              />
              <label htmlFor={`email-${email}`}>
                <strong>{title}</strong>
                <span className="muted small">{what}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {issue && (
        <p className="error small" role="alert">
          {issue}
        </p>
      )}
    </section>
  );
}
