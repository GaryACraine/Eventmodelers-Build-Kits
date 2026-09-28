#!/bin/sh
# Creates Temporal's databases on the project's Postgres, or upgrades their schema. Safe to run again: an existing
# database is kept, and update-schema only applies versions it hasn't yet.
# Adapted from temporalio/samples-server compose/scripts/setup-postgres.sh.
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
PORT=${DB_PORT:-5432}

nc -z -w 10 "${POSTGRES_SEEDS}" "${PORT}"

sql() {
  temporal-sql-tool --plugin postgres12 --ep "${POSTGRES_SEEDS}" -u "${POSTGRES_USER}" -p "${PORT}" "$@"
}

for DB in temporal temporal_visibility; do
  if sql --db "${DB}" create 2>/dev/null; then
    sql --db "${DB}" setup-schema -v 0.0
  else
    echo "Database ${DB} exists"
  fi
done
sql --db temporal update-schema -d /etc/temporal/schema/postgresql/v12/temporal/versioned
sql --db temporal_visibility update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned

echo "Temporal's schema is ready"
