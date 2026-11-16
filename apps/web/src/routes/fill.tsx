import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { sign } from "../approve.ts";
import { ApproveButton } from "../components/Approval.tsx";
import { api } from "../record.ts";

/** A fill as the record lists it for a page: the agent's own values, and secrets by name only. */
interface Fill {
  readonly id: string;
  readonly fields: readonly ({ readonly field: string } & ({ value: string } | { secret: string }))[];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The browser extension's passkey step for a fill that uses an `ask` secret: an extension can't ask for a passkey
 * for the site, so it opens this page with the challenge the record gave it. The person sees where the values go,
 * signs, and the page hands the signature to the extension (a message to itself, which the extension's script here
 * passes on). The extension then presses Fill again with it; this page never sees a value.
 */
export const Route = createFileRoute("/fill")({
  validateSearch: (search) => ({
    id: text(search["id"]),
    host: text(search["host"]),
    challenge: text(search["challenge"]),
  }),
  component: FillPasskey,
});

function FillPasskey() {
  const { id, host, challenge } = Route.useSearch();
  const [fill, setFill] = useState<Fill | "gone" | "signed-out" | "offline">();
  const [signed, setSigned] = useState(false);
  useEffect(() => {
    // The fills waiting for that host, as the record has them: what the page shows comes from there, not the URL.
    void api(`/api/fills?${new URLSearchParams({ url: `https://${host}/` })}`)
      .then(async (res) => {
        if (res.status === 401) return setFill("signed-out");
        const body: unknown = res.ok ? await res.json() : undefined;
        const fills: unknown[] =
          typeof body === "object" && body !== null && "fills" in body && Array.isArray(body.fills)
            ? body.fills
            : [];
        const found = fills.find(
          (f): f is Fill => typeof f === "object" && f !== null && "id" in f && f.id === id && "fields" in f,
        );
        setFill(found ?? "gone");
      })
      .catch(() => setFill("offline"));
  }, [id, host]);

  const approve = async () => {
    const answer = await sign(challenge);
    if ("error" in answer) return answer;
    postMessage({ type: "brainiac:fill-signed", fill: id, response: answer.response }, location.origin);
    setSigned(true);
    return undefined;
  };

  return (
    <main className="fill-passkey">
      <h1>Fill on {host}</h1>
      {fill === undefined ? (
        <p className="muted">Loading…</p>
      ) : fill === "signed-out" ? (
        <p>
          <a href={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in</a> to
          approve this fill.
        </p>
      ) : fill === "offline" ? (
        <p className="error">Brainiac can't be reached. Check you're online.</p>
      ) : fill === "gone" ? (
        <p className="muted">This fill ran out or was used. Ask your agent to start it again.</p>
      ) : signed ? (
        <p className="ok">
          Approved. The extension is filling the page now; check it, then submit it yourself.
        </p>
      ) : (
        <>
          <p className="muted">
            Your agent asked to fill this form. Your secrets go only into the page on {host}, and only this
            once.
          </p>
          <ul className="plan">
            {fill.fields.map((field) => (
              <li key={field.field}>
                <span>{field.field}</span>
                <span className="muted">
                  {"secret" in field ? `from your vault: ${field.secret}` : field.value}
                </span>
              </li>
            ))}
          </ul>
          <ApproveButton approve={approve} />
        </>
      )}
    </main>
  );
}
