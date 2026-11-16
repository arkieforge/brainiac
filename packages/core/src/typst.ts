// A draft's markdown as a Typst document (docs/product/features/applications.md, "CV and resume"): the subset a
// CV or a letter uses (headings, paragraphs, bullet lists, bold, italic, links), on one plain template. Every other
// character of the person's text is escaped, so nothing they or their Claude wrote runs as Typst code: a `#` or a
// `//` in a draft prints as itself.

/** The page every draft is set on. Libertinus Serif is the only font the Typst Worker has (apps/typst/fonts). */
const TEMPLATE = `#set document(title: TITLE)
#set page(paper: "a4", margin: (x: 2.2cm, y: 2cm))
#set text(font: "Libertinus Serif", size: 10.5pt)
#set par(justify: true, leading: 0.6em)
#show heading.where(level: 1): set text(size: 18pt)
#show heading.where(level: 2): it => block(above: 1.2em, below: 0.6em, text(size: 12pt, weight: "bold", upper(it.body)))
#show link: set text(fill: rgb("#1f4e8c"))
`;

/** Text as Typst markup prints it: every character Typst could read as markup or code is escaped. */
const escape = (text: string) => text.replaceAll(/[\\#$*_`<>@[\]~/=\-+'"]/g, (c) => `\\${c}`);

/** Text as a Typst string literal. */
const quoted = (text: string) => `"${text.replaceAll(/["\\]/g, (c) => `\\${c}`)}"`;

/** Bold, italic and links in one line of markdown; everything else is text. */
function inline(line: string): string {
  let out = "";
  let rest = line;
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
  for (let found = pattern.exec(rest); found; found = pattern.exec(rest)) {
    out += escape(rest.slice(0, found.index));
    const [whole, bold, bolder, italic, italics, label, url] = found;
    if (bold ?? bolder) out += `#strong[${inline(bold ?? bolder ?? "")}]`;
    else if (italic ?? italics) out += `#emph[${inline(italic ?? italics ?? "")}]`;
    else out += `#link(${quoted(url ?? "")})[${inline(label ?? "")}]`;
    rest = rest.slice(found.index + whole.length);
  }
  return out + escape(rest);
}

/**
 * The Typst source for a draft titled `title` with markdown `body`. Headings (`#` to `###`), bullet lists (`-`,
 * `*`, `+`), numbered lists (`1.`) and paragraphs keep their shape; a fenced block or a table prints as plain text.
 */
export function typstOf(title: string, body: string): string {
  const lines = body
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) return `${"=".repeat(heading[1]?.length ?? 1)} ${inline(heading[2] ?? "")}`;
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (bullet) return `${bullet[1] ?? ""}- ${inline(bullet[2] ?? "")}`;
      const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) return `${numbered[1] ?? ""}+ ${inline(numbered[2] ?? "")}`;
      return inline(line);
    });
  return `${TEMPLATE.replace("TITLE", quoted(title))}\n${lines.join("\n")}\n`;
}
