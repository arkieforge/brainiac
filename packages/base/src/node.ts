// Its own entry point, like bun.ts: the record's SQL on node:sqlite, for Node tools (the sync simulator, evals).
import type { DatabaseSync } from "node:sqlite";

import type { Sql, SqlValue } from "./sql.ts";

export function nodeSql(db: DatabaseSync): Sql {
  const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  let depth = 0;
  return {
    all: <Row>(query: string, ...params: SqlValue[]) => {
      let statement = statements.get(query);
      if (!statement) statements.set(query, (statement = db.prepare(query)));
      return statement.all(...params) as Row[];
    },
    // Nested, a transaction is a savepoint, as in bun:sqlite and the DO: the mutation path rolls back its own
    // writes inside the sync handler's transaction when they need an approval.
    transaction: (fn) => {
      const name = `t${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
}
