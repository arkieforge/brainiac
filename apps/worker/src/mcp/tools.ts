// The MCP server `/mcp` answers with: every tool and prompt in packages/base, each tool call answered by the
// record. Kept apart from the token checks in handler.ts so the filing eval serves exactly these tools too.
import { PROMPTS, TOOLS, type Answer } from "@brainiac/base";
import { createMcpHandler, McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

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
      return answer.ok
        ? { content: [{ type: "text", text: JSON.stringify(answer.value) }] }
        : { content: [{ type: "text", text: answer.error }], isError: true };
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
