// The MCP prompts (docs/internals/agent-interface.md, "Teaching the agent"): common jobs a person starts in one
// line. Served next to the tools by `/mcp`, so `brainiac mcp serve`, which forwards there, serves them too.
import { type } from "arktype";

const ApplicationArgs = type({
  application: type("string").describe("The application: its title, id or path"),
});

const RULES = `Quote every value exactly as the record returns it, and say which ones aren't verified. Never guess a value: ask the person with request_info. Change the record only through Brainiac's tools, never by editing files.`;

/** Every prompt, by the name clients list it under. `text` is the message the agent receives. */
export const PROMPTS = {
  file_inbox: {
    title: "File my inbox",
    description: "File everything waiting in the inbox into the right notes.",
    text: () =>
      `File my Brainiac inbox. Call describe first for the schema. Then query {"type": "InboxItem"} and get each item with its body.
For each item, pick the type and folder from the schema. Update the note it adds to; create a new note when it is a new event (a new test attempt, a new role). Mark scores, grades, IDs, health and money as sensitive. When an item is filed, delete it with update.
${RULES}
Finish with a short list: what went where, what you asked me, and what is still in the inbox and why.`,
  },
  missing_for_application: {
    title: "What's missing for an application",
    description: "Check an application's requirements against the record and list what's missing.",
    args: ApplicationArgs,
    text: ({ application }: typeof ApplicationArgs.infer) =>
      `What's missing for my application "${application}"? Call describe first. Find the Application note with query (or get, for an id or path) and read its requirements.
For each requirement, query the notes that would meet it and compare their values with what it asks, on the application's deadline. Count a requirement as met only when a stored value shows it.
${RULES}
Answer with each requirement as met, missing or unsure, the note and value behind it, and what to do next for anything not met. Change nothing unless I ask.`,
  },
  review_record: {
    title: "Review my record",
    description: "Review the record for gaps, open questions and values to check.",
    text: () =>
      `Review my Brainiac record. Call describe first and look at the counts, open questions and open proposals.
Then look for: important values nobody has verified, documents and test scores that expired or expire soon, notes missing required fields, likely duplicates, and facts with no source.
${RULES}
Answer with a short list, most important first, each with the note and the fix you suggest. Change nothing unless I ask.`,
  },
};
