import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { defineRule, type ESTree } from "@oxlint/plugins";

// Each app (`@brainiac/<dir>`) is worked on alone, so it shares code only through packages/*.
const APPS = new Set(readdirSync(join(import.meta.dirname, "..", "..", "apps")));

/** The app or package a path lies in, by its last `apps/<name>/` or `packages/<name>/` segment. */
function owner(path: string): { kind: string; name: string } | undefined {
  const match = [...path.matchAll(/[\\/](apps|packages)[\\/]([^\\/]+)[\\/]/g)].at(-1);
  return match?.[1] && match[2] ? { kind: match[1], name: match[2] } : undefined;
}

/** The app a specifier imports from, if any. */
function targetApp(specifier: string, filename: string): string | undefined {
  const pkg = /^@brainiac\/([^/]+)/.exec(specifier)?.[1];
  if (pkg) return APPS.has(pkg) ? pkg : undefined;
  if (!specifier.startsWith(".")) return undefined;
  const found = owner(resolve(dirname(filename), specifier) + "/");
  return found?.kind === "apps" ? found.name : undefined;
}

export default defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow importing one app from another app or from a package." },
  },
  create(context) {
    const from = owner(context.filename);
    if (!from) return {};
    const check = (node: ESTree.Node, source: ESTree.Node | null | undefined) => {
      if (source?.type !== "Literal" || typeof source.value !== "string") return;
      const app = targetApp(source.value, context.filename);
      if (!app || (from.kind === "apps" && from.name === app)) return;
      context.report({
        node,
        message: `${from.kind}/${from.name} imports apps/${app}. Move the shared code into packages/*.`,
      });
    };
    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
});
