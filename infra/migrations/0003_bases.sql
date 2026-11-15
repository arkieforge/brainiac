-- The base registry (apps/worker/src/registry.ts): each person's record, by the id of its Base Durable Object, the
-- same id a CLI token names. One per person. Deleting a person who still has a row fails, so a record is never
-- orphaned by accident; deletion (contract §6) ends the record first.

create table "bases" ("id" text not null primary key, "ownerId" text not null unique references "user" ("id"), "jurisdiction" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "deletedAt" timestamptz);
