import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile } from "./test-file.ts";

/** Whether `node` awaits anywhere inside it, not counting functions it only defines. */
function awaits(node: ESTree.Node | null | undefined): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "AwaitExpression") return true;
  if (
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration"
  )
    return false;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((item) => isNode(item) && awaits(item))
        : isNode(value) && awaits(value)),
  );
}

const isNode = (value: unknown): value is ESTree.Node =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

// A loop that awaits until a condition turns true is a poll: it passes when the machine is fast enough and spins
// or times out when it isn't. Await the thing that makes the condition true (a promise, an event, a queue, the
// jobs dispatcher) instead. Loops over a list (`for ... of`, a counted `for`) are fine. Reading a stream to its end
// (`while (true) { const { done } = await reader.read() ... }`) is the one honest awaiting loop: disable the rule
// on that line with a reason.
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow `while`, `do ... while` and `for (;;)` loops that await, in tests." },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    const report = (node: ESTree.Node) =>
      context.report({
        node,
        message: "A loop that awaits until something is true is a poll: await the thing.",
      });
    return {
      WhileStatement(node) {
        if (awaits(node.body) || awaits(node.test)) report(node);
      },
      DoWhileStatement(node) {
        if (awaits(node.body) || awaits(node.test)) report(node);
      },
      // A `for` with no update step loops until something in its body breaks out: a poll in other words.
      ForStatement(node) {
        if (!node.update && (awaits(node.body) || awaits(node.test))) report(node);
      },
    };
  },
});
