// The MCP server every transport answers with: every tool and prompt in this package, each tool call answered by
// `call`. The Worker's `/mcp` serves it in front of the record, `brainiac mcp serve` in front of the local copy
// when the record can't be reached, and the filing eval in front of its fixture record, so all three advertise
// exactly the same tools.
import { createMcpHandler, McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import { PROMPTS } from "./prompts.ts";
import { TOOLS, type Answer } from "./tools.ts";

const UNAVAILABLE = "Brainiac couldn't finish that call. Get the note again before you retry a change.";

/** A prompt's text as the one user message prompts/get returns. */
const say = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

/** An MCP server with every tool and prompt, each tool call answered by `call`. Stateless: one per request. */
function toolServer(call: (name: string, args: unknown) => Promise<Answer>): McpServer {
  const server = new McpServer({ name: "brainiac", version: "0.0.0" });
  for (const [name, tool] of Object.entries(TOOLS)) {
    // The SDK advertises this schema in tools/list and checks each call against it; the record checks again.
    const inputSchema: StandardSchemaWithJSON = tool.input;
    server.registerTool(name, { description: tool.description, inputSchema }, async (args) => {
      let answer: Answer;
      try {
        answer = await call(name, args);
      } catch (error) {
        // The record or the network failed: its words are for the logs, not the agent.
        console.error("mcp tool call failed", name, error);
        return { content: [{ type: "text", text: UNAVAILABLE }], isError: true };
      }
      if (!answer.ok) return { content: [{ type: "text", text: answer.error }], isError: true };
      const text = { type: "text" as const, text: JSON.stringify(answer.value) };
      return {
        content: answer.image ? [text, { type: "image" as const, ...answer.image }] : [text],
      };
    });
  }
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    const { title, description } = prompt;
    if ("args" in prompt)
      server.registerPrompt(name, { title, description, argsSchema: prompt.args }, (args) =>
        say(prompt.text(args)),
      );
    else server.registerPrompt(name, { title, description }, () => say(prompt.text()));
  }
  return server;
}

/** Answers one MCP request, each tool call by `call`. Both protocol eras are served, since clients move at their own pace. */
export const serveTools = (request: Request, call: (name: string, args: unknown) => Promise<Answer>) =>
  createMcpHandler(() => toolServer(call)).fetch(request);
