import type { Item, Mark, Question } from "@brainiac/core";
import { Tooltip } from "@base-ui/react/tooltip";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import NumberFlow from "@number-flow/react";
import {
  ArrowsClockwise,
  ArrowsLeftRight,
  ChatCircleDots,
  Question as QuestionMark,
  SealCheck,
  Stack,
  Tray,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";

import { typeIcon } from "../icons.ts";
import { LIST, SPRING } from "../motion.ts";
import { questionsOf } from "../questions.ts";
import { useRecord } from "../record.ts";
import { overviewOf } from "../review.ts";
import { CheckProfiles } from "./Drift.tsx";
import { Pip } from "./Pip.tsx";

/** Each mark as the overview draws it, and what it says to a screen reader and in its tooltip. */
const MARKS: Record<Mark, { readonly icon: Icon; readonly label: string }> = {
  checked: { icon: SealCheck, label: "Checked" },
  wrong: { icon: WarningCircle, label: "Looks wrong" },
  unproven: { icon: QuestionMark, label: "Not checked or not proven" },
  stale: { icon: ArrowsClockwise, label: "Checked over a year ago, or expiring soon" },
  conflict: { icon: ArrowsLeftRight, label: "Conflicts with another note" },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The health tiles: which count each shows, and the colour it takes once that count is above zero. */
const STATS = [
  { label: "items", count: "items", icon: Stack },
  { label: "checked", count: "checked", icon: SealCheck, tone: "ok" },
  { label: "look wrong", count: "wrong", icon: WarningCircle, tone: "error" },
  { label: "stale", count: "stale", icon: ArrowsClockwise, tone: "warn" },
  { label: "conflicts", count: "conflict", icon: ArrowsLeftRight, tone: "error" },
  { label: "unchecked", count: "unproven", icon: QuestionMark, tone: "warn" },
] as const;

/** Stand-in rows for the loading skeleton: fictional, so Skullet never measures or remembers the record itself. */
const SAMPLE = [
  ["Application", ["Graduate application, autumn intake"]],
  ["Education", ["Bachelor of Science, Example University", "Higher secondary certificate"]],
  ["TestScore", ["English test, academic module", "Graduate admissions test"]],
] as const;

/**
 * The overview while the record loads: the heading and tile labels are already known, so only the counts and rows
 * wait, as still bars (Skullet, DESIGN.md).
 */
function OverviewLoading() {
  return (
    <section className="overview">
      <header className="pane-head health">
        <h1>Your record</h1>
        <dl className="stats">
          {STATS.map(({ label, icon: StatIcon }) => (
            <div key={label}>
              <dt>
                <StatIcon size={13} aria-hidden />
                {label}
              </dt>
              <dd>
                <SkeletonBox width="1.2em" />
              </dd>
            </div>
          ))}
        </dl>
        <div className="health-actions">
          <Link to="/review" className="stamp">
            Review, worst first
          </Link>
          <Pip sticker="thinking" size={44} say="Loading your record…" />
        </div>
      </header>
      <Skeleton loading label="Loading your record">
        {SAMPLE.map(([type, headlines]) => (
          <section key={type} className="group">
            <h2>
              {type}
              <span className="count">{headlines.length}</span>
            </h2>
            <ul>
              {headlines.map((headline) => (
                <li key={headline} className="item">
                  <span className="mark">
                    <SealCheck size={15} weight="fill" />
                  </span>
                  <Stack size={15} weight="duotone" className="row-type" />
                  <span className="headline">{headline}</span>
                  <span className="aside path">facts/sample/note.md</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Skeleton>
    </section>
  );
}

/** A note's title morphs between pages under this name (styles.css, view transitions). Ids start with a digit. */
export const titleTransition = (noteId: string) => ({ viewTransitionName: `n${noteId}` });

/** The mark, with its meaning in a tooltip; the delay group in Overview makes the next one instant. */
export function MarkIcon({ mark }: { readonly mark: Mark }) {
  const { icon: Glyph, label } = MARKS[mark];
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<span className="mark" role="img" aria-label={label} />}>
        <Glyph size={15} weight="fill" />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tip">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function Row({
  item,
  asks,
  index,
  hovered,
  onHover,
}: {
  readonly item: Item;
  readonly asks: readonly Question[];
  readonly index: number;
  readonly hovered: boolean;
  readonly onHover: (noteId: string | undefined) => void;
}) {
  const flagged = item.mark === "wrong" || item.mark === "conflict";
  const TypeIcon = typeIcon(item.type);
  const quiet = asks.length === 0 && !item.aside;
  return (
    <li
      className="item"
      data-mark={item.mark}
      data-superseded={item.superseded || undefined}
      style={{ "--i": Math.min(index, 12) }}
      onPointerEnter={() => onHover(item.noteId)}
    >
      {hovered && <motion.span layoutId="row-hover" className="row-hover" transition={SPRING} />}
      {item.superseded ? <span className="mark" /> : <MarkIcon mark={item.mark} />}
      <TypeIcon size={15} weight="duotone" className="row-type" aria-hidden />
      <Link
        to="/n/$noteId"
        params={{ noteId: item.noteId }}
        className="headline"
        style={titleTransition(item.noteId)}
      >
        {item.headline}
      </Link>
      {/* With nothing to say on the right, the row shows where the note lives. */}
      {quiet ? (
        <span className="aside path" translate="no">
          {item.path}
        </span>
      ) : (
        <span className={flagged ? "aside warn" : "aside muted"}>
          {asks.length > 0 ? (
            <Link to="/questions" className="ask" title={asks.map((q) => q.text).join("\n")}>
              {plural(asks.length, "question", "questions")}
            </Link>
          ) : null}
          {asks.length > 0 && item.aside ? " · " : ""}
          {item.aside}
        </span>
      )}
    </li>
  );
}

/** One type's items; sync adds, removes and reorders them, and they slide instead of jumping. */
function Group({
  type,
  items,
  asks,
}: {
  readonly type: string;
  readonly items: readonly Item[];
  readonly asks: ReadonlyMap<string, readonly Question[]>;
}) {
  const [list] = useAutoAnimate<HTMLUListElement>(LIST);
  // Hover lives here, not in Overview, so pointing at a row re-renders one group, not the whole record's checks.
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  return (
    <section className="group">
      <h2>
        {type}
        <span className="count">{items.length}</span>
        {type === "Profile" && (
          <span className="group-action">
            <CheckProfiles />
          </span>
        )}
      </h2>
      <ul ref={list} onPointerLeave={() => setHovered(undefined)}>
        {items.map((item, index) => (
          <Row
            key={item.noteId}
            item={item}
            asks={asks.get(item.noteId) ?? []}
            index={index}
            hovered={hovered === item.noteId}
            onHover={setHovered}
          />
        ))}
      </ul>
    </section>
  );
}

/** What Pip says: the one next step the record's own counts point at. */
function nextStep(counts: ReturnType<typeof overviewOf>["counts"], questions: number) {
  if (counts.wrong > 0)
    return `${plural(counts.wrong, "value looks", "values look")} wrong. Worth a look first.`;
  if (counts.conflict > 0)
    return `${plural(counts.conflict, "note disagrees", "notes disagree")} with another.`;
  if (counts.unproven > 0) return `${plural(counts.unproven, "item isn't", "items aren't")} checked yet.`;
  if (questions > 0) return `Your Claude has ${plural(questions, "question", "questions")} for you.`;
  return "Everything here is checked. Nice.";
}

/** See everything: every item's headline and mark, grouped by type, with the record's health on top. */
export function Overview() {
  const { client, manifest, status, schemaLoaded, proposals } = useRecord();
  const waiting = proposals?.length ?? 0;
  if (!client) return status === "loading" ? <OverviewLoading /> : <p className="empty">No record yet.</p>;
  const now = Date.now();
  const health = overviewOf(client, manifest, now);
  const questions = questionsOf(client, manifest, now);
  const asks = Map.groupBy(questions, (q) => q.about ?? q.noteId);
  if (health.items.length === 0)
    return status === "live" ? (
      <div className="empty">
        {waiting > 0 ? (
          <>
            <Pip
              sticker="detective"
              say={`Nothing in your record yet, but ${plural(waiting, "proposal waits", "proposals wait")} for you.`}
            />
            <Link to="/proposals" className="stamp">
              See proposals
            </Link>
          </>
        ) : (
          <Pip
            sticker="coffee"
            say="Nothing in your record yet. Ask your Claude to file something, or add a file."
          />
        )}
      </div>
    ) : (
      <OverviewLoading />
    );
  const groups = Map.groupBy(health.items, (item) => item.type);
  const { counts } = health;
  return (
    <section className="overview">
      <header className="pane-head health">
        <h1>Your record</h1>
        <dl className="stats">
          {STATS.map((stat) => {
            const value = counts[stat.count];
            const tone = "tone" in stat && value > 0 ? stat.tone : undefined;
            const StatIcon = stat.icon;
            return (
              <div key={stat.label} className={tone}>
                <dt>
                  <StatIcon size={13} weight={tone ? "fill" : "regular"} aria-hidden />
                  {stat.label}
                </dt>
                <dd>
                  <NumberFlow value={value} />
                </dd>
              </div>
            );
          })}
          {waiting > 0 && (
            <div className="warn">
              <dt>
                <Tray size={13} weight="fill" aria-hidden />
                <Link to="/proposals">proposals</Link>
              </dt>
              <dd>
                <NumberFlow value={waiting} />
              </dd>
            </div>
          )}
          {questions.length > 0 && (
            <div>
              <dt>
                <ChatCircleDots size={13} aria-hidden />
                <Link to="/questions">questions</Link>
              </dt>
              <dd>
                <NumberFlow value={questions.length} />
              </dd>
            </div>
          )}
        </dl>
        {(status !== "live" || !schemaLoaded) && (
          <p className="warn small">
            This device's copy: the checks and your sensitive notes come in when you're online.
          </p>
        )}
        <div className="health-actions">
          <Link to="/review" className="stamp">
            Review, worst first
          </Link>
          <Pip sticker="detective" size={44} say={nextStep(counts, questions.length)} />
        </div>
      </header>
      <Tooltip.Provider delay={450}>
        {[...groups].map(([type, items]) => (
          <Group key={type} type={type} items={items} asks={asks} />
        ))}
      </Tooltip.Provider>
    </section>
  );
}
