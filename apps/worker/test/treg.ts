// treg as it answers drift checks for the fixture student: fictional, in the shapes treg documents (`catalog_get`
// on each endpoint): a routed call is `{output, raw, _treg}` with the capability's contract in `output`, and
// Serper's Scholar answer is relayed unchanged. Anything it doesn't know is a routed miss.
import type { Web } from "../src/connectors/doi.ts";

export const FIXTURE_LINKEDIN = "https://www.linkedin.com/in/brainiac-fixture-nadia";

/** What the fixture student's LinkedIn shows: an old headline, and the ownership code in the about. */
export const linkedinOutput = (code: string) => ({
  full_name: "Nadia Karim",
  headline: "BSc Computer Science student at Northvale",
  about: `I build NLP tools for Swahili. ${code}`,
  location: "Dhaka, Bangladesh",
  followers: 120,
  linkedin_url: FIXTURE_LINKEDIN,
});

export interface Asked {
  readonly endpoint: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/** Answers as treg does; every call it got is in `asked`. `answers` maps an endpoint to a body or a status. */
export function treg(answers: Readonly<Record<string, unknown>> = {}) {
  const asked: Asked[] = [];
  const web: Web = async (url, init) => {
    const endpoint = url.replace("https://treg.to/call/", "");
    const body: unknown = JSON.parse(String(init.body));
    asked.push({ endpoint, body, headers: Object.fromEntries(new Headers(init.headers)) });
    const answer = answers[endpoint];
    if (typeof answer === "number") return Response.json({ error: "refused" }, { status: answer });
    if (answer !== undefined) return Response.json(answer);
    // treg's miss: a 200 whose contract fields are empty.
    return Response.json({
      output: { full_name: null, username: null },
      raw: {},
      _treg: { served_by: null },
    });
  };
  return { web, asked };
}
