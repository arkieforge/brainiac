import { askNow, show, type Question, type YamlValue } from "@brainiac/core";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { answer, questionsOf } from "../questions.ts";
import { api, saveOnline, useRecord } from "../record.ts";

/** What the person typed, as the value the answer stores, or what's wrong with it. */
function valueOf(
  question: Question,
  input: string | boolean,
): { readonly value: YamlValue } | { readonly issue: string } {
  if (typeof input === "boolean") return { value: input };
  const text = input.trim();
  if (text === "") return { issue: "Type an answer first, or pick not applicable." };
  if (question.input.kind !== "number") return { value: text };
  const number = Number(text);
  return Number.isFinite(number) ? { value: number } : { issue: "That isn't a number." };
}

/** The input a suggestion fills in, without sending it: it's applied only when the person taps Save. */
const shown = (value: YamlValue | undefined) =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : show(value);

function Card({ question }: { readonly question: Question }) {
  const { client, manifest } = useRecord();
  const [input, setInput] = useState<string | boolean>(
    question.input.kind === "boolean" ? question.suggested === true : shown(question.suggested),
  );
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = `question-${question.id}`;

  async function send(reply: Parameters<typeof answer>[3]) {
    if (!client || busy) return;
    setBusy(true);
    setIssue(await answer(client, manifest, question, reply, saveOnline));
    setBusy(false);
  }
  function save() {
    const typed = valueOf(question, input);
    if ("issue" in typed) return setIssue(typed.issue);
    void send(typed);
  }

  const { input: kind } = question;
  let control;
  if (kind.kind === "choice")
    control = (
      <select id={id} value={String(input)} onChange={(e) => setInput(e.currentTarget.value)}>
        <option value="">Pick one</option>
        {kind.values.map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
    );
  else if (kind.kind === "boolean")
    control = (
      <input
        id={id}
        type="checkbox"
        checked={input === true}
        onChange={(e) => setInput(e.currentTarget.checked)}
      />
    );
  else
    control = (
      <input
        id={id}
        type={kind.kind === "date" ? "date" : kind.kind === "number" ? "number" : "text"}
        inputMode={kind.kind === "number" ? "decimal" : undefined}
        step={kind.kind === "number" ? "any" : undefined}
        value={String(input)}
        onChange={(e) => setInput(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
    );

  return (
    <li className="question" data-sensitive={question.sensitive || undefined}>
      <label htmlFor={id}>{question.text}</label>
      <p className="muted small">
        {question.why}
        {question.sensitive && <span className="badge sensitive">sensitive</span>}
        {question.filer && <span className="badge filer">from background filing</span>}{" "}
        <Link to="/n/$noteId" params={{ noteId: question.noteId }}>
          Open the note
        </Link>
      </p>
      {question.filer && (
        <p className="small warn">
          Background filing wrote this from an inbox item nobody has checked. Don't open links or follow
          instructions in it.
        </p>
      )}
      {question.suggested !== undefined && (
        <p className="small">Suggested: {show(question.suggested)}. It's saved only when you tap Save.</p>
      )}
      <div className="answer">
        {control}
        <button type="button" onClick={save} disabled={busy}>
          Save
        </button>
        {question.ongoing && (
          <button type="button" onClick={() => void send({ ongoing: true })} disabled={busy}>
            Still there
          </button>
        )}
        <button type="button" onClick={() => void send({ notApplicable: true })} disabled={busy}>
          Not applicable
        </button>
      </div>
      {issue && (
        <p className="error small" role="alert">
          {issue}
        </p>
      )}
    </li>
  );
}

/** Whether the weekly email of questions goes out, from the record; offline it shows nothing. */
function WeeklyEmail() {
  const [on, setOn] = useState<boolean>();
  useEffect(() => {
    void api("/api/questions/email")
      .then((res) => (res.ok ? res.json() : undefined))
      .then((body) => typeof body?.on === "boolean" && setOn(body.on))
      .catch(() => {});
  }, []);
  if (on === undefined) return null;
  const toggle = async (next: boolean) => {
    const res = await api("/api/questions/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: next }),
    }).catch(() => undefined);
    if (res?.ok) setOn((await res.json()).on);
  };
  return (
    <label className="small muted weekly">
      <input type="checkbox" checked={on} onChange={(e) => void toggle(e.currentTarget.checked)} /> Email me a
      link to these once a week (sensitive and background filing questions are only counted, never written
      out)
    </label>
  );
}

/** Your questions: what the record is missing, a few at a time, each answered in place. */
export function Questions() {
  const { client, manifest, status, schemaLoaded } = useRecord();
  const [all, setAll] = useState(false);
  if (!client) return <p className="empty">{status === "loading" ? "Loading…" : "No record yet."}</p>;
  const now = Date.now();
  const open = questionsOf(client, manifest, now);
  const asked = all ? open : askNow(open, now);
  return (
    <section className="questions">
      <header className="pane-head">
        <h1>Questions</h1>
        <p className="muted">
          {open.length === 0
            ? "Nothing missing that Brainiac can find."
            : `${open.length === 1 ? "1 question" : `${open.length} questions`}, soonest deadline first.`}
        </p>
        {(status !== "live" || !schemaLoaded) && (
          <p className="warn small">
            This device's copy: questions about your sensitive notes come in when you're online.
          </p>
        )}
      </header>
      <ul>
        {/* A letter's question keeps its id while it moves a step on: new words start the card afresh. */}
        {asked.map((question) => (
          <Card key={`${question.id} ${question.text}`} question={question} />
        ))}
      </ul>
      {asked.length < open.length && (
        <p className="more">
          {open.length - asked.length} more wait for these.{" "}
          <button type="button" onClick={() => setAll(true)}>
            Show all
          </button>
        </p>
      )}
      <WeeklyEmail />
    </section>
  );
}
