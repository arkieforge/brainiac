-- The GitHub connector (apps/worker/src/connectors/github.ts). An installation of our GitHub App on the repos
-- someone picked, and the records it feeds: a link is made only after the person proves, through GitHub, that
-- the installation is on their own account. `etags` holds the last ETag of each page of its repo list, for the daily sweep's conditional requests.

create table "github_installations" ("id" bigint not null primary key, "account" text not null, "etags" text not null default '[]', "checkedAt" timestamptz, "suspended" boolean not null default false);

create table "github_links" ("installationId" bigint not null references "github_installations" ("id") on delete cascade, "baseId" text not null references "bases" ("id") on delete cascade, "linkedAt" timestamptz default CURRENT_TIMESTAMP not null, primary key ("installationId", "baseId"));

create index "github_links_base" on "github_links" ("baseId");
