import { defineRule, type ESTree } from "@oxlint/plugins";

// Modifiers that can stop a test from running. `skipIf`/`runIf` are conditional skips.
const SKIPPING = new Set(["skip", "todo", "fails", "skipIf", "runIf"]);
const RUNNERS = new Set(["it", "test", "describe"]);
const QUARANTINE = /^\s*quarantine: #\d+ \S/;

/** For `it.skip.each`, returns ["it", ["skip", "each"]]; undefined when the callee isn't a member chain. */
function chain(callee: ESTree.Node): [string, string[]] | undefined {
  const props: string[] = [];
  let node = callee;
  while (node.type === "MemberExpression") {
    if (node.property.type !== "Identifier") return undefined;
    props.unshift(node.property.name);
    node = node.object;
  }
  return node.type === "Identifier" && props.length ? [node.name, props] : undefined;
}

// A skipped test hides a failure. Each one needs a tracking issue on the line above:
//   // quarantine: #123 <why>
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require a `// quarantine: #<issue> <why>` comment above skipped tests." },
  },
  create(context) {
    return {
      // Only calls on a member chain are checked (`it.skip(...)`, `it.skip.each(...)`, `it.skipIf(x)`),
      // so `it.skipIf(x)(...)` and `it.skip.each([])(...)` are reported once, at the inner call.
      CallExpression(node) {
        const found = chain(node.callee);
        if (!found) return;
        const [runner, props] = found;
        const skip = props.find((p) => SKIPPING.has(p));
        if (!RUNNERS.has(runner) || !skip) return;
        const comments = context.sourceCode.getCommentsBefore(node);
        if (comments.some((c) => QUARANTINE.test(c.value))) return;
        context.report({
          node,
          message: `${runner}.${props.join(".")} needs "// quarantine: #<issue> <why>" on the line above.`,
        });
      },
    };
  },
});
