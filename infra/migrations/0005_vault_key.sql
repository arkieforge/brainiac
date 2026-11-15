-- Which vault key wraps each record's data key, as the record last said (apps/worker/src/vault-rotation.ts). Null
-- until the rotation sweep asks, so a record nobody asked counts as not yet rewrapped.

alter table "bases" add column "vaultKeyId" text;
