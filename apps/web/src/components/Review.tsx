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
import { Tooltip } from "@base-ui/react/tooltip";
import NumberFlow from "@number-flow/react";
import {
  ArrowUUpLeft,
  Check as CheckMark,
  Info,
  PaperPlaneTilt,
  PencilSimple,
  Question,
  SkipForward,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "@yusufceng1z/ding-react";
import { AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";

import { typeIcon } from "../icons.ts";
import { reviewBase, saveReviewed, useRecord } from "../record.ts";
import { endSession, openSession, overviewOf, sessionFor, SESSION_ITEMS } from "../review.ts";
import { Burst } from "./Burst.tsx";
import { Paste } from "./Drift.tsx";
import { MarkIcon, titleTransition } from "./Overview.tsx";
import { Pip } from "./Pip.tsx";

type Base = { readonly rev: number; readonly raw: string };

/**
 * One step the person took. An edit keeps the text before it, and the revision and text it left, so `u` puts the
 * text back only onto exactly that: an edit made since, anywhere, is a conflict instead of being undone too.
 */
interface Step {
  readonly at: number;
  /** Which way the card left (Fly), so an undo brings it back from that side. */
  readonly dx: 1 | -1;
  readonly edit?: { readonly noteId: string; readonly before: string; readonly after: Base };
}

const KEYS = [
  ["y", "Correct", CheckMark, "Every value shown is right, at this version"],
  ["e", "Edit", PencilSimple, "Open the note to change it"],
  ["f", "Apply the fix", Wrench, "Set the value the check suggests"],
  ["?", "Not sure", Question, "Come back to it later"],
  ["s", "Skip", SkipForward, "Next item, nothing saved"],
  ["u", "Undo", ArrowUUpLeft, "Put the last step back"],
] as const satisfies readonly (readonly [string, string, Icon, string])[];
type Key = (typeof KEYS)[number][0];

/**
 * Review while the record answers: the top card as still bars over fictional sample text (Skullet never sees the
 * record), with the deck, the progress bar and the keys, which are already known, around it.
 */
function ReviewLoading() {
  return (
    <section className="review">
      <div className="progress-row">
        <span className="muted small progress">
          <SkeletonBox width="4em" />
        </span>
        <span className="progress-bar" />
      </div>
      <div className="deck">
        {/* Outside the skeleton: Skullet draws every bar on one layer, which would put these over the top card. */}
        {[2, 1].map((depth) => (
          <div key={depth} className="card ghost" data-depth={depth} />
        ))}
        <Skeleton loading label="Loading your review">
          <article className="card">
            <header>
              <span className="badge">TestScore</span>
              <h1>English test, academic module</h1>
              <div className="path">facts/tests/sample.md</div>
            </header>
            <ul className="checks">
              <li>
                <strong>score</strong>: the report attached to this note shows a different overall band.
              </li>
            </ul>
            <dl className="values">
              {["overall", "date", "provider", "listening"].map((field) => (
                <div key={field}>
                  <dt>{field}</dt>
                  <dd>Sample value</dd>
                </div>
              ))}
            </dl>
          </article>
        </Skeleton>
      </div>
      <div className="keys">
        {KEYS.map(([key, label, KeyIcon]) => (
          <button key={key} type="button" className={key === "y" ? "primary" : undefined} disabled>
            <KeyIcon size={14} weight={key === "y" ? "bold" : "regular"} />
            {label} <kbd>{key}</kbd>
          </button>
        ))}
      </div>
    </section>
  );
}

/** How far a swipe must travel to count: right is Correct, left is Skip. */
const SWIPE_PX = 80;

/**
 * A card rises out of the stack and leaves the way it was sent: right and tilted for Correct, left for Skip. An
 * undo brings it back in from the side it left by, and the card it covers sinks back into the stack.
 */
const CARD = {
  enter: ({ dx, back }: Fly) =>
    back ? { opacity: 0, x: dx * 400, rotate: dx * 12 } : { opacity: 0, y: 10, scale: 0.96 },
  shown: { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 },
  gone: ({ dx, back }: Fly) =>
    back ? { opacity: 0, y: 10, scale: 0.96 } : { opacity: 0, x: dx * 400, rotate: dx * 12 },
};

/** Which way the last card went (1 right, -1 left), and whether this move is an undo bringing one back. */
interface Fly {
  readonly dx: 1 | -1;
  readonly back: boolean;
}

/**
 * The card on top of the deck. It follows the finger with a tilt, a CORRECT or SKIP stamp fades in with the
 * distance, and past SWIPE_PX letting go counts; short of it, it springs back.
 */
function TopCard({
  item,
  fly,
  onSwipe,
  children,
}: {
  readonly item: Item;
  readonly fly: Fly;
  readonly onSwipe: (key: "y" | "s") => void;
  readonly children: ReactNode;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-240, 240], [-10, 10]);
  const yes = useTransform(x, [20, SWIPE_PX], [0, 1]);
  const no = useTransform(x, [-SWIPE_PX, -20], [1, 0]);
  return (
    <motion.article
      key={item.noteId}
      className="card"
      data-mark={item.mark}
      custom={fly}
      variants={CARD}
      initial="enter"
      animate="shown"
      exit="gone"
      style={{ x, rotate }}
      drag="x"
      dragSnapToOrigin
      dragElastic={0.7}
      onDragEnd={(_, { offset }) => {
        if (offset.x > SWIPE_PX) onSwipe("y");
        else if (offset.x < -SWIPE_PX) onSwipe("s");
      }}
    >
      <motion.span className="swipe-stamp yes" style={{ opacity: yes }} aria-hidden>
        CORRECT
      </motion.span>
      <motion.span className="swipe-stamp no" style={{ opacity: no }} aria-hidden>
        SKIP
      </motion.span>
      {children}
    </motion.article>
  );
}

/** What the record kept after a key, said in the toast; skips change nothing, so they say nothing. */
const DONE = { y: "Marked correct", f: "Fix applied" } as const;

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
  const [fly, setFly] = useState<Fly>({ dx: 1, back: false });
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
    setFly({ dx: last.dx, back: true });
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
        if (saved) toast.success("Undone");
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
      setSteps([...steps, { at, dx: -1 }]);
      setFly({ dx: -1, back: false });
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
      saved ? { at, dx: 1, edit: { noteId: item.noteId, before: shown.raw, after: saved } } : { at, dx: 1 },
    ]);
    toast.success(DONE[key]);
    // A fix leaves the item here to check again; Correct moves on.
    if (key === "y") {
      setFly({ dx: 1, back: false });
      setAt(at + 1);
    }
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

  if (!client) return status === "loading" ? <ReviewLoading /> : <p className="empty">No record yet.</p>;
  if (!order && !ready)
    return status === "offline" ? (
      <p className="empty">Review needs the record: you're offline.</p>
    ) : (
      <ReviewLoading />
    );
  if (!order || order.length === 0)
    return (
      <div className="empty">
        <Pip sticker="coffee" say="Nothing to review. Everything your Claude filed is checked." />
      </div>
    );
  if (!item)
    return (
      <section className="review done">
        <Burst />
        <Pip sticker="rocket" size={84} say={`All ${order.length} reviewed.`} />
        <p className="progress">
          <NumberFlow value={steps.filter((s) => s.edit).length} /> changed,{" "}
          <NumberFlow value={unsure.length} /> not sure.
        </p>
        <p className="row">
          <button type="button" onClick={() => void act("u")} disabled={steps.length === 0 || busy}>
            <ArrowUUpLeft size={14} /> Undo the last one
          </button>
          <Link to="/" className="stamp">
            Back to the overview
          </Link>
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
  const TypeIcon = typeIcon(item.type);
  // The next two items peek out under the card, so the deck reads as a stack.
  const behind = order.slice(at + 1, at + 3).flatMap((id) => items.get(id) ?? []);
  return (
    <section className="review">
      <div className="progress-row">
        <span className="muted small progress">
          <NumberFlow value={at + 1} /> of {order.length}
        </span>
        <span className="progress-bar" aria-hidden>
          <motion.i animate={{ scaleX: at / order.length }} />
        </span>
      </div>
      <div className="deck">
        {behind.map((next, depth) => (
          <div key={next.noteId} className="card ghost" data-depth={depth + 1} aria-hidden>
            <span className="ghost-title">{next.headline}</span>
          </div>
        ))}
        <AnimatePresence mode="popLayout" initial={false} custom={fly}>
          <TopCard key={item.noteId} item={item} fly={fly} onSwipe={(key) => void act(key)}>
            <header>
              <MarkIcon mark={item.mark} />
              <span className="badge">
                <TypeIcon size={12} weight="duotone" /> {item.type}
              </span>
              {item.usedBy.length > 0 && (
                <span className="badge used">
                  <PaperPlaneTilt size={12} weight="duotone" /> used by an open application
                </span>
              )}
              <h1 style={titleTransition(item.noteId)}>{item.headline}</h1>
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
                      <svg className="drawn-check" viewBox="0 0 16 16" aria-label="checked" role="img">
                        <path d="M3 8.5l3.2 3L13 4.5" />
                      </svg>
                    )}
                  </dt>
                  <dd>{show(data[field])}</dd>
                </div>
              ))}
            </dl>
          </TopCard>
        </AnimatePresence>
      </div>
      <Tooltip.Provider delay={450}>
        <div className="keys" role="toolbar" aria-label="Review">
          {KEYS.map(([key, label, KeyIcon, hint]) => (
            <Tooltip.Root key={key}>
              <Tooltip.Trigger
                render={
                  <button
                    type="button"
                    className={key === "y" ? "primary" : undefined}
                    onClick={() => void act(key)}
                    disabled={busy || (key === "f" && !fix) || (key === "u" && steps.length === 0)}
                  />
                }
              >
                <KeyIcon size={14} weight={key === "y" ? "bold" : "regular"} />
                {label} <kbd>{key}</kbd>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Positioner sideOffset={6}>
                  <Tooltip.Popup className="tip">{hint}</Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>
          ))}
        </div>
      </Tooltip.Provider>
      <p className="muted small rule">
        Correct checks every value shown, at this version. Swipe right to correct, left to skip.
        <Tooltip.Root>
          <Tooltip.Trigger
            render={<button type="button" className="ghost info" aria-label="About the passkey session" />}
          >
            <Info size={14} />
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Positioner sideOffset={6}>
              <Tooltip.Popup className="tip">
                One passkey signature covers the next {SESSION_ITEMS} items for 10 minutes.
              </Tooltip.Popup>
            </Tooltip.Positioner>
          </Tooltip.Portal>
        </Tooltip.Root>
      </p>
      {busy && <p className="muted">Saving…</p>}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
