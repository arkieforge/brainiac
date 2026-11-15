// Drift checks on the site (docs/product/features/projects-profiles-links.md): the record's text to paste into a
// profile, and the button that asks the record to read the person's profiles again.
import { detect, type Check, type Manifest } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";
import { useState } from "react";

import { api } from "../record.ts";
import { parsedNotes } from "../review.ts";

/** The text to paste, as it is, with a button that copies it. */
export function Paste({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="paste">
      Paste: <code>{text}</code>{" "}
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Asks the record to read the person's profiles again; one read less than a day old is kept, not paid again. */
export function CheckProfiles() {
  const [said, setSaid] = useState<string>();
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const res = await api("/api/profiles/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
    const body: unknown = await res?.json().catch(() => undefined);
    setBusy(false);
    if (!res?.ok || typeof body !== "object" || body === null || !("checking" in body) || !("cached" in body))
      return setSaid("The check couldn't start. Are you online?");
    const { checking, cached } = body;
    setSaid(
      [
        typeof checking === "number" &&
          checking > 0 &&
          `Checking ${plural(checking, "profile", "profiles")}.`,
        typeof cached === "number" &&
          cached > 0 &&
          `${plural(cached, "profile was", "profiles were")} checked in the last day.`,
      ]
        .filter(Boolean)
        .join(" ") || "No profiles to check.",
    );
  };
  return (
    <span className="check-profiles">
      <button type="button" onClick={() => void check()} disabled={busy}>
        Check now
      </button>
      {said && (
        <span className="muted small" role="status">
          {" "}
          {said}
        </span>
      )}
    </span>
  );
}

/** One note's drift checks, from this tab's copy, as the overview finds them. */
export function NoteDrift({
  client,
  manifest,
  noteId,
}: {
  readonly client: SyncClient;
  readonly manifest: Manifest | null;
  readonly noteId: string;
}) {
  const checks: Check[] = detect(parsedNotes(client), manifest, Date.now()).filter(
    (check) =>
      check.noteId === noteId &&
      (check.detector === "drift" || check.detector === "unchecked" || check.detector === "dead"),
  );
  if (checks.length === 0) return null;
  return (
    <ul className="checks drift">
      {checks.map((check, i) => (
        <li key={i}>
          {check.field && <strong>{check.field}: </strong>}
          {check.evidence}
          {check.paste !== undefined && (
            <>
              {" "}
              <Paste text={check.paste} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
