import type { Item, Mark, Overview as Health, Question } from "@brainiac/core";
import { Link } from "@tanstack/react-router";

import { questionsOf } from "../questions.ts";
import { useRecord } from "../record.ts";
import { overviewOf } from "../review.ts";

/** Each mark as the overview draws it, and what it says to a screen reader. */
export const MARKS: Record<Mark, { readonly glyph: string; readonly label: string }> = {
  checked: { glyph: "✓", label: "Checked" },
  wrong: { glyph: "!", label: "Looks wrong" },
  unproven: { glyph: "?", label: "Not checked or not proven" },
  stale: { glyph: "↻", label: "Checked over a year ago" },
  conflict: { glyph: "⇄", label: "Conflicts with another note" },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `412 items · 371 checked · 18 look wrong · 9 stale · 3 conflicts · 5 unchecked` */
function healthLine({ counts }: Health): string {
  return [
    plural(counts.items, "item", "items"),
    `${counts.checked} checked`,
    plural(counts.wrong, "looks wrong", "look wrong"),
    `${counts.stale} stale`,
    plural(counts.conflict, "conflict", "conflicts"),
    `${counts.unproven} unchecked`,
  ].join(" · ");
}

function Row({ item, asks }: { readonly item: Item; readonly asks: readonly Question[] }) {
  const mark = MARKS[item.mark];
  const flagged = item.mark === "wrong" || item.mark === "conflict";
  return (
    <li className="item" data-mark={item.mark} data-superseded={item.superseded || undefined}>
      <span className="mark" role="img" aria-label={mark.label} title={mark.label}>
        {item.superseded ? "" : mark.glyph}
      </span>
      <Link to="/n/$noteId" params={{ noteId: item.noteId }} className="headline">
        {item.headline}
      </Link>
      <span className={flagged ? "aside warn" : "aside muted"}>
        {asks.length > 0 ? (
          <Link to="/questions" className="ask" title={asks.map((q) => q.text).join("\n")}>
            {plural(asks.length, "question", "questions")}
          </Link>
        ) : null}
        {asks.length > 0 && item.aside ? " · " : ""}
        {item.aside}
      </span>
    </li>
  );
}

/** See everything: every item's headline and mark, grouped by type, with the record's health on top. */
export function Overview() {
  const { client, manifest, status, schemaLoaded } = useRecord();
  if (!client) return <p className="empty">{status === "loading" ? "Loading" : "No record yet."}</p>;
  const now = Date.now();
  const health = overviewOf(client, manifest, now);
  const questions = questionsOf(client, manifest, now);
  const asks = Map.groupBy(questions, (q) => q.about ?? q.noteId);
  if (health.items.length === 0)
    return <p className="empty">Nothing in your record yet. Pick a note or add one.</p>;
  const groups = Map.groupBy(health.items, (item) => item.type);
  return (
    <section className="overview">
      <header className="pane-head health">
        <h1>Record health</h1>
        <p>
          {healthLine(health)}
          {questions.length > 0 && (
            <>
              {" · "}
              <Link to="/questions">{plural(questions.length, "question", "questions")}</Link>
            </>
          )}
        </p>
        {(status !== "live" || !schemaLoaded) && (
          <p className="warn small">
            This device's copy: the checks and your sensitive notes come in when you're online.
          </p>
        )}
        <Link to="/review" className="button">
          Review, worst first
        </Link>
      </header>
      {[...groups].map(([type, items]) => (
        <section key={type} className="group">
          <h2>{type}</h2>
          <ul>
            {items.map((item) => (
              <Row key={item.noteId} item={item} asks={asks.get(item.noteId) ?? []} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
