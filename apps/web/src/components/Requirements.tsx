// An application's requirements on the site (docs/internals/record-format.md, "A requirement is met only when..."):
// judged in the browser by the same `requirementsOf` the record's `query` and `get` use, over this tab's copy, so
// the site and the person's Claude never disagree. A manual one is ticked through the note's normal edit path.
import { headline, parseRequirement, requirementsOf, type Manifest, type ReviewNote } from "@brainiac/core";
import type { SyncClient } from "@brainiac/sync";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { commitEdit, tickRequirement } from "../fields.ts";
import { saveOnline } from "../record.ts";
import { parsedNotes } from "../review.ts";

export function Requirements({
  client,
  manifest,
  application,
  live,
  disabled,
}: {
  readonly client: SyncClient;
  readonly manifest: Manifest | null;
  readonly application: ReviewNote;
  /** Before the record answers, this tab may hold only its stored copy, without the sensitive notes it never keeps. */
  readonly live: boolean;
  /** A sensitive application while offline: shown, not tickable. */
  readonly disabled: boolean;
}) {
  const [issue, setIssue] = useState<string>();
  const notes = parsedNotes(client);
  const items = [application.data["requirements"]].flat();
  if (items.length === 0) return null;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const judged = requirementsOf(application, notes, Date.now());
  const met = judged.filter((r) => r.status === "met").length;
  const tick = async (index: number, need: string, done: boolean) => {
    setIssue(
      await commitEdit(client, application.id, (raw) => tickRequirement(raw, index, need, done), saveOnline),
    );
  };
  return (
    <section className="requirements" aria-label="Requirements">
      <h2 className="label">
        <span>Requirements</span>
        <span>
          {met} of {judged.length} met
        </span>
      </h2>
      <ul>
        {judged.map((requirement, i) => {
          const parsed = parseRequirement(items[i]);
          const manual = !("invalid" in parsed) && parsed.check === "manual";
          const isMet = requirement.status === "met";
          return (
            <li key={i} className={isMet ? "met" : "missing"}>
              {manual ? (
                <input
                  type="checkbox"
                  checked={isMet}
                  disabled={disabled}
                  aria-label={`${requirement.need}: done`}
                  onChange={(event) => void tick(i, requirement.need, event.currentTarget.checked)}
                />
              ) : isMet ? (
                <CheckCircle size={15} weight="fill" aria-label="Met" />
              ) : (
                <Circle size={15} aria-label="Missing" />
              )}
              <div>
                <div>{requirement.need}</div>
                <div className="why">
                  {isMet && requirement.by.length > 0 && (
                    <>
                      Met by{" "}
                      {requirement.by.map((id, j) => {
                        const note = byId.get(id);
                        return (
                          <Fragment key={id}>
                            {j > 0 && ", "}
                            <Link to="/n/$noteId" params={{ noteId: id }}>
                              {note ? headline(note, manifest) : id}
                            </Link>
                          </Fragment>
                        );
                      })}
                    </>
                  )}
                  {isMet && manual && "Ticked by you."}
                  {!isMet && manual && "Tick it once it's done."}
                  {!isMet && !manual && requirement.why}
                  {!isMet && !manual && !live && (
                    <span className="warn">
                      {" "}
                      Offline, this tab may not hold every note, so one it lacks may meet it.
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {issue && (
        <p className="error small" role="alert">
          {issue}
        </p>
      )}
    </section>
  );
}
