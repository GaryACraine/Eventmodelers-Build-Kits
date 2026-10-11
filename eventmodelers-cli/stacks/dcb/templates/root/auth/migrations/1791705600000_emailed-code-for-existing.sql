-- ADR-056 D2: the emailed code is on for everyone whose email is verified. New and newly verified accounts get it from
-- the sign-in service's user hooks; this turns it on for the accounts verified before the second factor arrived, who
-- would otherwise sign in with the password alone, which passes no check. Written by hand (data, not schema).

-- Up Migration

update "user" set "twoFactorEnabled" = true where "emailVerified" and not coalesce("twoFactorEnabled", false);

-- Down Migration

-- Nothing to undo: the second-factor migration's down drops the column
