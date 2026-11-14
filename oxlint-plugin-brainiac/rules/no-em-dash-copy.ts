import { defineRule, type ESTree } from "@oxlint/plugins";

// Built from the code point so formatters never turn it back into a literal this rule would flag.
const EM_DASH = String.fromCodePoint(0x2014);

// Comments are not product copy, so only string, template and JSX text nodes are checked.
export default defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow em dashes in strings and JSX text that people or agents read." },
  },
  create(context) {
    const check = (node: ESTree.Node, text: string | null | undefined) => {
      if (text?.includes(EM_DASH)) {
        context.report({
          node,
          message: "No em dashes in product copy. Use a period, comma, colon, or parentheses instead.",
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
});
