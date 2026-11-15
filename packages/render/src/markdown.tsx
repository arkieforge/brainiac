// Adapted from T3 Code (packages/shared/src/markdownPipeline.ts and apps/web/src/components/chat/markdownRenderer.ts),
// MIT License, Copyright (c) 2026 T3 Tools Inc. See packages/render/NOTICE.md.
//
// A note body is text anyone with write access (an agent, an import) may have written, so it renders through an
// allowlist: raw HTML never enters the tree (remark-rehype drops it), and rehype-sanitize then keeps only the
// elements, attributes and URL schemes below. Nothing here runs a script or loads a frame.
import type { Element, ElementContent, Root } from "hast";
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";

import { remarkGithubAlerts } from "./alerts.ts";
import { Formula } from "./math.tsx";

export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Fence languages plus the two classes remark-math gives formulas.
    code: [["className", /^language-./, "math-inline", "math-display"]],
    blockquote: [...(defaultSchema.attributes?.["blockquote"] ?? []), "dataAlert"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true })
  .use(remarkGithubAlerts)
  // Without allowDangerousHtml, raw HTML in the markdown never becomes part of the tree.
  .use(remarkRehype)
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .freeze();

const classOf = (node: Element | undefined) => {
  const value = node?.properties["className"];
  return Array.isArray(value) ? value.map(String) : [];
};

const COMPONENTS: Partial<Components> = {
  code: ({ node, children, ...props }) => {
    const classes = classOf(node);
    const display = classes.includes("math-display");
    if (display || classes.includes("math-inline")) {
      const tex = (node?.children ?? [])
        .map((child: ElementContent) => ("value" in child ? child.value : ""))
        .join("");
      return <Formula tex={tex} display={display} />;
    }
    return <code {...props}>{children}</code>;
  },
  // Links leave the site in a new tab and say nothing about the page they came from.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
};

// Elements are immutable, so a remount (another note, the preview after an edit lands) reuses one instead of
// parsing again. An element and the hast it keeps hold about 20 bytes per source character, so ~10 MB.
const MAX_CACHED_CHARS = 500_000;
const ENTRY_OVERHEAD_CHARS = 200;
const rendered = new Map<string, ReactElement>();
let cachedChars = 0;

const entrySize = (key: string) => key.length + ENTRY_OVERHEAD_CHARS;

function remember(key: string, element: ReactElement) {
  // One huge note would otherwise evict everything else.
  if (entrySize(key) > MAX_CACHED_CHARS / 4) return;
  rendered.set(key, element);
  cachedChars += entrySize(key);
  for (const oldest of rendered.keys()) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    rendered.delete(oldest);
    cachedChars -= entrySize(oldest);
  }
}

/** A note body's markdown as React elements, sanitized, from the cache when this exact text rendered before. */
export function renderMarkdown(text: string): ReactElement {
  const cached = rendered.get(text);
  if (cached !== undefined) {
    // Refresh its place in the eviction order.
    rendered.delete(text);
    rendered.set(text, cached);
    return cached;
  }
  const file = new VFile(text);
  const tree: Root = processor.runSync(processor.parse(file), file);
  const element = toJsxRuntime(tree, {
    Fragment,
    components: COMPONENTS,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
  remember(text, element);
  return element;
}

/** A rendered note body. */
export function Markdown({ text, className }: { readonly text: string; readonly className?: string }) {
  return <div className={className ?? "markdown"}>{renderMarkdown(text)}</div>;
}
