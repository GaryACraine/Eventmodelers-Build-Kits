-- Better Auth 1.7.7: a second factor and passkeys (ADR-056), and how each session signed in (`session.amr`, D1). Written
-- by its CLI (`npm run schema` against the database after the first migration) and committed unchanged.

-- Up Migration

alter table "user" add column "twoFactorEnabled" boolean default false;

alter table "session" add column "amr" text;

create table "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" boolean not null, "transports" text, "createdAt" timestamptz, "aaguid" text);

create index "twoFactor_secret_idx" on "twoFactor" ("secret");

create index "twoFactor_userId_idx" on "twoFactor" ("userId");

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");
-- Down Migration

drop table "passkey", "twoFactor";
alter table "session" drop column "amr";
alter table "user" drop column "twoFactorEnabled";
