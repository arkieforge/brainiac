import {
  parseNote,
  patch,
  reviewFields,
  reviewQueue,
  show,
  verifyOps,
  type Check,
  type Item,
  type PatchOp,
} from "@brainiac/core";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { reviewBase, saveReviewed, useRecord } from "../record.ts";
import { endSession, openSession, overviewOf, sessionFor, SESSION_ITEMS } from "../review.ts";
import { Paste } from "./Drift.tsx";
import { MARKS } from "./Overview.tsx";

type Base = { readonly rev: number; readonly raw: string };

/**
 * One step the person took. An edit keeps the text before it, and the revision and text it left, so `u` puts the
 * text back only onto exactly that: an edit made since, anywhere, is a conflict instead of being undone too.
 */
interface Step {
  readonly at: number;
  readonly edit?: { readonly noteId: string; readonly before: string; readonly after: Base };
}

const KEYS = [
  ["y", "Correct"],
  ["e", "Edit"],
  ["f", "Apply the fix"],
  ["?", "Not sure"],
  ["s", "Skip"],
  ["u", "Undo"],
] as const;
type Key = (typeof KEYS)[number][0];

/** How far a swipe must travel to count: right is Correct, left is Skip. */
const SWIPE_PX = 80;

const fixOf = (item: Item | undefined): Check | undefined => item?.checks.find((check) => check.fix);

/** Review mode: one item at a time, worst first; each key press is a change the person signed for. */
export function Review() {
  const { client, manifest, status, schemaLoaded } = useRecord();
  const navigate = useNavigate();
  const now = Date.now();
  const health = overviewOf(client, manifest, now);
  const items = new Map(health.items.map((item) => [item.noteId, item]));
  // The order is fixed when review starts, so an item that changes doesn't jump around under the person.
  const [order, setOrder] = useState<readonly string[] | undefined>(undefined);
  const [at, setAt] = useState(0);
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [unsure, setUnsure] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const swipe = useRef<number | undefined>(undefined);
  // Fixed only once the record answered: this device's copy lacks sensitive notes and the schema's checks.
  const ready = status === "live" && schemaLoaded;
  if (order === undefined && client && ready && health.items.length > 0)
    setOrder(reviewQueue(health.items).map((item) => item.noteId));
  const noteId = order?.[at];
  const item = noteId === undefined ? undefined : items.get(noteId);

  /**
   * Saves an edit to `id` made on `from` inside a review session, asking for a signature when none covers it.
   * Always on `from`: if the note moved on while the passkey prompt was open, the record refuses it.
   */
  async function save(id: string, edit: (raw: string) => string, from: Base) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let nonce = sessionFor(id);
      if (nonce === undefined) {
        const opened = await openSession([...new Set([id, ...(order ?? []).slice(at, at + SESSION_ITEMS)])]);
        if (typeof opened !== "string") return opened;
        nonce = opened;
      }
      const saved = await saveReviewed(id, edit, nonce, from);
      if (saved && "ended" in saved) {
        // Ended early (another device, a restart): one new signature, then the same edit once more.
        endSession();
        continue;
      }
      return saved;
    }
    return { error: "Your review session keeps ending. Try again in a moment." };
  }

  /** Back to the step undone, with what's left of the history. */
  function undone(last: Step, rest: readonly Step[]) {
    setSteps(rest);
    setUnsure(unsure.filter((id) => id !== order?.[last.at]));
    setAt(last.at);
  }

  async function act(key: Key) {
    if (busy || !order) return;
    setMessage(undefined);
    if (key === "u") {
      const last = steps.at(-1);
      if (!last) return;
      if (last.edit) {
        const { noteId: id, before, after } = last.edit;
        setBusy(true);
        const saved = await save(id, () => before, after);
        setBusy(false);
        if (saved && "error" in saved) return setMessage(saved.error);
        // The step before left the text this undo restored: it now stands at the undo's revision.
        if (saved)
          return undone(
            last,
            steps
              .slice(0, -1)
              .map((step) =>
                step.edit?.noteId === id && step.edit.after.raw === before
                  ? { ...step, edit: { ...step.edit, after: saved } }
                  : step,
              ),
          );
      }
      return undone(last, steps.slice(0, -1));
    }
    if (!item || !client) return;
    if (key === "e") return void navigate({ to: "/n/$noteId", params: { noteId: item.noteId } });
    if (key === "s" || key === "?") {
      if (key === "?") setUnsure([...unsure, item.noteId]);
      setSteps([...steps, { at }]);
      return setAt(at + 1);
    }
    const fix = fixOf(item)?.fix;
    if (key === "f" && !fix) return setMessage("There's no fix to apply here. Edit it with e.");
    // The text on the card, as the person saw it before any passkey prompt.
    const shown = reviewBase(item.noteId);
    if (!shown)
      return setMessage("An edit to this note is still on its way. Check it again once it's saved.");
    const ops: PatchOp[] =
      key === "f" && fix
        ? [{ op: "set", path: [fix.field], value: fix.value }]
        : verifyOps(parseNote(shown.raw).data, manifest, shown.rev, Date.now());
    setBusy(true);
    const saved = await save(item.noteId, (raw) => patch(raw, ops), shown);
    setBusy(false);
    if (saved && "error" in saved) return setMessage(saved.error);
    setSteps([
      ...steps,
      saved ? { at, edit: { noteId: item.noteId, before: shown.raw, after: saved } } : { at },
    ]);
    // A fix leaves the item here to check again; Correct moves on.
    if (key === "y") setAt(at + 1);
  }

  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      const key = KEYS.find(([k]) => k === event.key)?.[0];
      if (key === undefined) return;
      event.preventDefault();
      void latest.current(key);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const onPointerDown = (event: PointerEvent) => {
    swipe.current = event.clientX;
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe.current;
    swipe.current = undefined;
    if (start === undefined) return;
    const dx = event.clientX - start;
    if (dx > SWIPE_PX) void act("y");
    else if (dx < -SWIPE_PX) void act("s");
  };

  if (!client) return <p className="empty">{status === "loading" ? "Loading" : "No record yet."}</p>;
  if (!order && !ready)
    return (
      <p className="empty">
        {status === "offline" ? "Review needs the record: you're offline." : "Loading your record"}
      </p>
    );
  if (!order || order.length === 0) return <p className="empty">Nothing to review.</p>;
  if (!item)
    return (
      <section className="review done">
        <h1>All done</h1>
        <p>
          {steps.filter((s) => s.edit).length} changed, {unsure.length} not sure, {order.length} reviewed.
        </p>
        <p>
          <button type="button" onClick={() => void act("u")} disabled={steps.length === 0 || busy}>
            Undo the last one
          </button>{" "}
          <Link to="/">Back to the overview</Link>
        </p>
        {message && <p role="alert">{message}</p>}
      </section>
    );

  const raw = reviewBase(item.noteId)?.raw ?? client.working(item.noteId) ?? "";
  let data: Readonly<Record<string, unknown>> = {};
  try {
    data = parseNote(raw).data;
  } catch {
    // Shown as a note with no fields; its own pane says why.
  }
  const verified = new Set(item.verified);
  const fix = fixOf(item)?.fix;
  const mark = MARKS[item.mark];
  return (
    <section className="review">
      <p className="muted small">
        {at + 1} of {order.length}
        {item.usedBy.length > 0 && ` · an open application uses this`}
      </p>
      <article
        className="card"
        data-mark={item.mark}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (swipe.current = undefined)}
      >
        <header>
          <span className="mark" role="img" aria-label={mark.label} title={mark.label}>
            {mark.glyph}
          </span>
          <span className="badge">{item.type}</span>
          <h1>{item.headline}</h1>
          <div className="path">{item.path}</div>
        </header>
        {item.checks.length > 0 && (
          <ul className="checks">
            {item.checks.map((check, i) => (
              <li key={i}>
                <strong>{check.field ?? "this item"}</strong>: {check.evidence}
                {check.fix && (
                  <span className="muted">
                    {" "}
                    Fix: set {check.fix.field} to {show(check.fix.value)}.
                  </span>
                )}
                {check.paste !== undefined && (
                  <>
                    {" "}
                    <Paste text={check.paste} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <dl className="values">
          {reviewFields(data, manifest).map((field) => (
            <div key={field}>
              <dt>
                {field}
                {verified.has(field) && (
                  <span className="ok" aria-label="checked">
                    {" "}
                    ✓
                  </span>
                )}
              </dt>
              <dd>{show(data[field])}</dd>
            </div>
          ))}
        </dl>
      </article>
      <div className="keys" role="toolbar" aria-label="Review">
        {KEYS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => void act(key)}
            disabled={busy || (key === "f" && !fix) || (key === "u" && steps.length === 0)}
          >
            <kbd>{key}</kbd> {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        Correct checks every value shown, at this version. One passkey signature covers the next{" "}
        {SESSION_ITEMS} items for 10 minutes. On a phone, swipe right for Correct and left to skip.
      </p>
      {busy && <p className="muted">Saving</p>}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
