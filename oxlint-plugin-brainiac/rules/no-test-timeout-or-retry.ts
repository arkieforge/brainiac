import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile } from "./test-file.ts";

const RUNNERS = new Set(["it", "test", "describe", "bench"]);
const OPTIONS = new Set(["timeout", "retry", "repeats"]);

/** The runner a test call starts from: `it` for `it(...)`, `it.each([...])(...)`, `it.concurrent(...)`. */
function runnerOf(callee: ESTree.Node): string | undefined {
  let node = callee;
  while (node.type === "MemberExpression" || node.type === "CallExpression")
    node = node.type === "MemberExpression" ? node.object : node.callee;
  return node.type === "Identifier" ? node.name : undefined;
}

// A test that needs more time or a second try to pass is wrong: fix the wait, or the race, instead. The project's
// timeout is the ceiling and its retry is 0 (vite.config.ts), so a test must not raise either for itself.
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow per-test timeouts and retries." },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    return {
      CallExpression(node) {
        const runner = runnerOf(node.callee);
        if (!runner || !RUNNERS.has(runner)) return;
        for (const arg of node.arguments) {
          const number = arg.type === "Literal" && typeof arg.value === "number";
          const option =
            arg.type === "ObjectExpression" &&
            arg.properties.some(
              (p) => p.type === "Property" && p.key.type === "Identifier" && OPTIONS.has(p.key.name),
            );
          if (number || option)
            context.report({
              node: arg,
              message: `${runner}() takes no timeout or retry of its own: fix what makes it slow or flaky.`,
            });
        }
      },
    };
  },
});
