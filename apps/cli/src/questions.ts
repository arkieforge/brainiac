// `brainiac questions`: the person's questions, as the record lists them for this device's connection (the
// `query` tool's Question rows), with a link to answer them on the site. Online only for now, like `mcp serve`.
import { askNow } from "@brainiac/core";
import { type } from "arktype";

const Row = type({
  id: "string",
  fields: { question: "string", "why?": "string", "deadline?": "string" },
});
const Page = type({ rows: Row.array() });

/** The lines `brainiac questions` prints: the ones asked now (or all), each with why, then where to answer. */
export function questionsReport(answer: unknown, server: string, now: number, all: boolean): string[] {
  const page = Page.assert(answer);
  const open = page.rows.map((row) => ({ ...row.fields, id: row.id }));
  if (open.length === 0) return ["No questions: nothing missing that Brainiac can find."];
  const asked = all ? open : askNow(open, now);
  return [
    ...asked.map((q) => `? ${q.question}${q.why ? `  (${q.why})` : ""}`),
    ...(asked.length < open.length
      ? [`${open.length - asked.length} more wait: brainiac questions --all`]
      : []),
    `Answer them at ${new URL("/questions", server).toString()}`,
  ];
}

/** The query that lists them: open ones, soonest deadline first. */
export const QUESTIONS_QUERY = {
  type: "Question",
  where: { status: { eq: "open" } },
  fields: ["question", "why", "deadline", "note", "field", "kind"],
  limit: 100,
};
