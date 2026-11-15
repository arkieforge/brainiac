// The base registry (Neon `bases`, infra/migrations/0003_bases.sql): which record is whose. A record is a Base
// Durable Object named by its id (`newUniqueId`), the same string a CLI token carries and the jobs queue routes by.

/** What the registry needs of pg's pool (and of PGlite, in tests). */
export interface Db {
  query<Row>(text: string, values: unknown[]): Promise<{ rows: Row[] }>;
}

/**
 * The record of the person `ownerId`, made on first use with the id `newId` gives; `undefined` once it was
 * deleted. One round trip once it exists. Two first requests racing both insert: one wins, and the other reads
 * the winner's row in a statement of its own, so both get the same record.
 */
export async function baseOf(db: Db, ownerId: string, newId: () => string): Promise<string | undefined> {
  const find = async () => {
    const { rows } = await db.query<{ id: string; deletedAt: Date | null }>(
      `select "id", "deletedAt" from "bases" where "ownerId" = $1`,
      [ownerId],
    );
    return rows[0];
  };
  let row = await find();
  if (!row) {
    const { rows } = await db.query<{ id: string }>(
      `insert into "bases" ("id", "ownerId") values ($1, $2) on conflict ("ownerId") do nothing returning "id"`,
      [newId(), ownerId],
    );
    row = rows[0] ? { id: rows[0].id, deletedAt: null } : await find();
  }
  if (!row) throw new Error(`The registry has no record for ${ownerId}, even after making one.`);
  return row.deletedAt === null ? row.id : undefined;
}
