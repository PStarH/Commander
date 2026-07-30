#!/bin/sh
set -eu

rendered=/run/commander/postgres-init/postgres-init.sql
test -f "$rendered"
test ! -L "$rendered"
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" < "$rendered"
rm -f "$rendered"
