import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile } from "./test-file.ts";

// Calls that wait on the real clock.
const WAITS = new Set(["setTimeout", "setInterval", "sleep", "waitForTimeout"]);

/** `setTimeout` for `setTimeout(...)`, `window.setTimeout(...)` and `page.waitForTimeout(...)`. */
function calleeName(callee: ESTree.Node): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier")
    return callee.property.name;
  return undefined;
}

// A test that sleeps passes on a fast machine and fails on a slow one, and one that times itself measures the
// machine. Wait for the thing itself instead: await the promise or event, drain the queue, advance fake timers
// (`vi.useFakeTimers`) past the code under test's own timers, or in a browser test `expect.element(...)` /
// `vi.waitFor(...)`. A test scheduling a timer of its own is waiting, fake clock or not.
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow sleeps, frame waits and wall-clock timing in tests." },
  },
  create(context) {
    if (!isTestFile(context.filename)) return {};
    return {
      // Any use, since `new Promise(requestAnimationFrame)` waits for a frame without calling it.
      Identifier(node) {
        if (node.name === "requestAnimationFrame")
          context.report({ node, message: "Waiting for a frame: assert on the state the frame shows." });
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        const timed =
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "performance" &&
          name === "now";
        if (timed)
          context.report({ node, message: "Assert on events and counts, not on how long something took." });
        else if (name && WAITS.has(name))
          context.report({
            node,
            message: `${name}() makes the test wait: await the event itself, or advance fake timers.`,
          });
        else if (
          name === "addEventListener" &&
          node.arguments[0]?.type === "Literal" &&
          (node.arguments[0].value === "transitionend" || node.arguments[0].value === "animationend")
        )
          context.report({ node, message: "Waiting for an animation to end: assert on the state it shows." });
      },
    };
  },
});
