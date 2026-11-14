import { defineRule } from "@oxlint/plugins";

const SKIPPING = new Set(["skip", "todo", "fails"]);
const QUARANTINE = /^\s*quarantine: #\d+ \S/;

// A skipped test hides a failure. Each one needs a tracking issue on the line above:
//   // quarantine: #123 <why>
export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Require a `// quarantine: #<issue> <why>` comment above skipped tests." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
        if (callee.object.type !== "Identifier" || !["it", "test", "describe"].includes(callee.object.name))
          return;
        if (!SKIPPING.has(callee.property.name)) return;
        const comments = context.sourceCode.getCommentsBefore(node);
        if (comments.some((c) => QUARANTINE.test(c.value))) return;
        context.report({
          node,
          message: `${callee.object.name}.${callee.property.name} needs "// quarantine: #<issue> <why>" on the line above.`,
        });
      },
    };
  },
});
