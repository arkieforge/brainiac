// Its own entry point, so the Worker never type-checks against bun:sqlite.
import type { Database } from "bun:sqlite";

import type { Sql, SqlValue } from "./sql.ts";

export const bunSql = (db: Database): Sql => ({
  // `query` caches the prepared statement per SQL string.
  all: <Row>(query: string, ...params: SqlValue[]) => db.query<Row, SqlValue[]>(query).all(...params),
  transaction: (fn) => db.transaction(fn)(),
});
