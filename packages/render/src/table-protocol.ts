/** Rows the worker sends at a time. */
export const TABLE_PAGE_ROWS = 500;

/** As in T3 Code's large text viewer: enough for any file the record takes, with a bound on what one cell holds. */
export const TABLE_LIMITS = { maxRows: 1_000_000, maxColumns: 1024, maxCellLength: 2000 };

export type TableRequest =
  | { readonly type: "open"; readonly bytes: Uint8Array; readonly delimiter: "," | "\t" }
  | { readonly type: "page"; readonly index: number };

export type TableResult =
  | {
      readonly type: "opened";
      readonly count: number;
      readonly columns: number;
      readonly truncated: boolean;
      readonly first: string[][];
    }
  | { readonly type: "page"; readonly index: number; readonly rows: string[][] }
  | { readonly type: "error" };
