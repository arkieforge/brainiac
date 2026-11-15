// Rotating the stage's vault key (infra/README.md#rotating-the-vault-key). Each record rewraps its data key the
// first time it wakes with the previous key bound; this sweep wakes the ones nobody uses, so the rotation ends,
// and keeps the registry's count of records the previous key still wraps, which the doctor reports.
import type { Db } from "./registry.ts";

/** Every 10 minutes, and only while the previous key is bound: alchemy.run.ts adds it to the crons then. */
export const VAULT_SWEEP_CRON = "*/10 * * * *";

/** A record, by its base id: it rewraps and says which vault key wraps it now. */
type Records = (baseId: string) => { rewrapDataKey(): Promise<string> };

/**
 * Wakes each record the registry doesn't yet know is on vault key `current` (an id), and notes the key it says
 * it's on. One record failing never stops the rest; it stays counted until it rewraps.
 */
export async function rewrapRecords(db: Db, current: string, records: Records) {
  const { rows } = await db.query<{ id: string }>(
    `select "id" from "bases" where "vaultKeyId" is distinct from $1`,
    [current],
  );
  let rewrapped = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      const keyId = await records(id).rewrapDataKey();
      await db.query(`update "bases" set "vaultKeyId" = $1 where "id" = $2`, [keyId, id]);
      rewrapped++;
    } catch (error) {
      failed++;
      console.error("vault key rewrap failed", { base: id, error: String(error) });
    }
  }
  return { rewrapped, failed };
}

/** How many records the registry doesn't know are on vault key `current`: the previous key can go at 0. */
export async function waitingToRewrap(db: Db, current: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as "count" from "bases" where "vaultKeyId" is distinct from $1`,
    [current],
  );
  return rows[0]?.count ?? 0;
}
