import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { TABLE_PAGE_ROWS, type TableResult } from "./table-protocol.ts";

const ROW = 28;
const COLUMN = 160;
const NUMBERS = 56;
/** Rows and columns drawn beyond the edges, so a fast scroll doesn't show blanks. */
const OVERSCAN = 8;

type Opened = Omit<Extract<TableResult, { type: "opened" }>, "type" | "first">;

/**
 * A CSV or TSV file as a table. Its first row is the header. A worker parses it, and only the rows and columns in
 * view are in the page, so a file of a million rows scrolls like one of ten.
 */
export function TableViewer(props: {
  readonly bytes: Uint8Array;
  readonly delimiter: "," | "\t";
  readonly name: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker>(null);
  const asked = useRef(new Set<number>());
  const [opened, setOpened] = useState<Opened>();
  const [pages, setPages] = useState(new Map<number, string[][]>());
  const [error, setError] = useState(false);
  const [view, setView] = useState({ top: 0, left: 0, width: 0, height: 0 });
  useEffect(() => {
    const parser = new Worker(new URL("./table.worker.ts", import.meta.url), { type: "module" });
    worker.current = parser;
    asked.current = new Set([0]);
    parser.addEventListener("error", () => setError(true));
    parser.addEventListener("message", (event: MessageEvent<TableResult>) => {
      const result = event.data;
      if (result.type === "error") setError(true);
      else if (result.type === "opened") {
        setOpened({ count: result.count, columns: result.columns, truncated: result.truncated });
        setPages(new Map([[0, result.first]]));
      } else setPages((old) => new Map(old).set(result.index, result.rows));
    });
    // A copy: the page keeps its bytes for a re-render.
    // A worker has no target origin; the rule is for window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    parser.postMessage({ type: "open", bytes: props.bytes.slice(), delimiter: props.delimiter });
    return () => {
      parser.terminate();
      worker.current = null;
    };
  }, [props.bytes, props.delimiter]);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setView((old) => ({ ...old, width: node.clientWidth, height: node.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [opened]);
  const body = Math.max(0, (opened?.count ?? 0) - 1);
  const columns = opened?.columns ?? 0;
  const firstRow = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const lastRow = Math.min(body, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const firstColumn = Math.max(0, Math.floor((view.left - NUMBERS) / COLUMN) - 1);
  const lastColumn = Math.min(columns, Math.ceil((view.left + view.width) / COLUMN) + 1);
  // Row `n` of the body is row `n + 1` of the file, after the header.
  const row = (n: number) => pages.get(Math.floor((n + 1) / TABLE_PAGE_ROWS))?.[(n + 1) % TABLE_PAGE_ROWS];
  useEffect(() => {
    for (let n = firstRow; n < lastRow; n++) {
      const page = Math.floor((n + 1) / TABLE_PAGE_ROWS);
      if (asked.current.has(page)) continue;
      asked.current.add(page);
      worker.current?.postMessage({ type: "page", index: page });
    }
  }, [firstRow, lastRow]);
  if (error) return <p role="alert">This file can't be read as a table.</p>;
  if (!opened) return <p className="muted">Loading</p>;
  if (opened.count === 0) return <p className="muted">This file is empty.</p>;
  const header = pages.get(0)?.[0] ?? [];
  const shown = Array.from({ length: Math.max(0, lastColumn - firstColumn) }, (_, i) => firstColumn + i);
  const cells = (values: readonly string[] | undefined, head: boolean) =>
    shown.map((column) => (
      <div
        key={column}
        role={head ? "columnheader" : "cell"}
        aria-colindex={column + 1}
        className="table-cell"
        style={{ left: NUMBERS + column * COLUMN }}
        title={values?.[column]}
      >
        {values?.[column]}
      </div>
    ));
  return (
    <div className="table-view">
      <p className="small muted" role="status">
        {body.toLocaleString()} row{body === 1 ? "" : "s"} · {columns.toLocaleString()} column
        {columns === 1 ? "" : "s"}
        {opened.truncated
          ? " · Shortened: very long cells, or more than a million rows or 1,024 columns"
          : ""}
      </p>
      <div
        ref={scroller}
        className="table-scroller"
        onScroll={(event) => {
          const { scrollTop, scrollLeft } = event.currentTarget;
          setView((old) => ({ ...old, top: scrollTop, left: scrollLeft }));
        }}
      >
        <div
          role="table"
          aria-label={props.name}
          aria-rowcount={opened.count}
          aria-colcount={columns}
          style={{ height: (body + 1) * ROW, width: NUMBERS + columns * COLUMN }}
        >
          <div role="row" aria-rowindex={1} className="table-head">
            <div className="table-number" />
            {cells(header, true)}
          </div>
          {Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, i) => firstRow + i).map((n) => (
            <div
              key={n}
              role="row"
              aria-rowindex={n + 2}
              className="table-row"
              style={{ top: (n + 1) * ROW }}
            >
              <div className="table-number">{n + 1}</div>
              {cells(row(n), false)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
