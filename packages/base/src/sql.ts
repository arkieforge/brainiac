// A BLOB binds as a Uint8Array on both engines, but reads back as an ArrayBuffer from the DO and a Uint8Array
// from Bun, so a row type that selects one says `ArrayBuffer | Uint8Array`.
export type SqlValue = string | number | null | Uint8Array;

/**
 * The one way this package touches SQLite, so the DO and the CLI run the same statements.
 * Whole operations (`migrate`, `mutate`, `undoRun`, the job functions) each run in one transaction of their
 * own; the building blocks they use (`putNote`, `putChunks`, `enqueue`) run in the caller's.
 */
export interface Sql {
  /** Runs one statement and returns its rows. The row type is the query's claim, checked by the tests. */
  all<Row>(query: string, ...params: SqlValue[]): Row[];
  /** Runs `fn` in one transaction: every write in it commits, or none does. */
  transaction<T>(fn: () => T): T;
}

/** The part of a Durable Object's `ctx.storage` used here; the real one satisfies it structurally. */
export interface DurableObjectSql {
  readonly sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

export const doSql = (storage: DurableObjectSql): Sql => ({
  // DO SQLite rejects BEGIN and COMMIT; transactionSync is its transaction.
  all: <Row>(query: string, ...params: SqlValue[]) => storage.sql.exec(query, ...params).toArray() as Row[],
  transaction: (fn) => storage.transactionSync(fn),
});
