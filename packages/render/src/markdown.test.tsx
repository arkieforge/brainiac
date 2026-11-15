import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Markdown } from "./markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("markdown", () => {
  it("never lets a note body run a script, a handler, a javascript: link or a frame", () => {
    const out = html(
      [
        "# Notes",
        "",
        "<script>document.title='pwned'</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        '<p onclick="alert(2)">click</p>',
        "",
        '<iframe src="https://evil.example"></iframe>',
        "",
        "[a link](javascript:alert(3)) and [another](JaVaScRiPt:alert(4))",
        "",
        "![pic](javascript:alert(5))",
        "",
        '<a href="javascript:alert(6)">raw link</a>',
        "",
        "<svg onload=\"alert(7)\"><circle r='1'/></svg>",
      ].join("\n"),
    );
    expect(out).toContain("<h1>Notes</h1>");
    for (const banned of [
      "<script",
      "onerror",
      "onclick",
      "onload",
      "<iframe",
      "javascript:",
      "<svg",
      "alert(",
    ])
      expect(out.toLowerCase()).not.toContain(banned.toLowerCase());
  });

  it("renders GFM, alerts and math", () => {
    const out = html(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n> [!NOTE]\n> Read me.\n\nCGPA $3.82$\n\n[site](https://example.org)",
    );
    expect(out).toContain("<table>");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('<blockquote data-alert="note">');
    expect(out).toContain("\\(3.82\\)"); // KaTeX loads lazily; until then the TeX shows
    expect(out).toContain('href="https://example.org" target="_blank" rel="noopener noreferrer nofollow"');
  });
});
