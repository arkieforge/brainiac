-- Organization installations (apps/worker/src/connectors/github.ts). A member may be unable to see some of an
-- organization installation's repos, so their link reads only what their own GitHub sign-in can see there.
-- `repos` is that list as it was last read (JSON, the connector's Repo shape), null for a link to the person's
-- own account, which reads the whole installation. `grant` is their GitHub sign-in, sealed with a key from the
-- auth secret; null once it ran out, and then the link reads nothing until they connect again. `checkedAt` is
-- when `repos` was last read.

alter table "github_links" add column "repos" text;

alter table "github_links" add column "grant" text;

alter table "github_links" add column "checkedAt" timestamptz;
