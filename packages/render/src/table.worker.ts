// Parses a CSV or TSV file off the page and hands its rows back a page at a time, so a 25 MB file neither blocks
// the page while it parses nor copies every row across at once.
import { parseDelimitedPreview } from "./delimited.ts";
import { TABLE_LIMITS, TABLE_PAGE_ROWS, type TableRequest, type TableResult } from "./table-protocol.ts";

let rows: string[][] = [];

// A worker has no target origin; the rule is for window.postMessage.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
const reply = (result: TableResult) => self.postMessage(result);

self.addEventListener("message", (event: MessageEvent<TableRequest>) => {
  const input = event.data;
  if (input.type === "page") {
    reply({
      type: "page",
      index: input.index,
      rows: rows.slice(input.index * TABLE_PAGE_ROWS, (input.index + 1) * TABLE_PAGE_ROWS),
    });
    return;
  }
  try {
    const parsed = parseDelimitedPreview(
      new TextDecoder().decode(input.bytes),
      input.delimiter,
      TABLE_LIMITS,
    );
    rows = parsed.rows;
    reply({
      type: "opened",
      count: rows.length,
      columns: rows.reduce((most, row) => Math.max(most, row.length), 0),
      truncated: parsed.truncated,
      first: rows.slice(0, TABLE_PAGE_ROWS),
    });
  } catch {
    reply({ type: "error" });
  }
});
