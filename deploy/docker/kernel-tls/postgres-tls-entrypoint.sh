#!/bin/sh
# Installs the host-provided TLS material with the ownership PostgreSQL
# requires, then hands off to the stock image entrypoint. Runs as root, exactly
# like the official entrypoint's own data-directory preparation.
#
# Requires COMMANDER_DATABASE_TLS_HOST_DIR to be bind-mounted read-only at
# /run/commander/database-tls-source.
set -eu

install -d -m 700 -o postgres -g postgres /var/lib/postgresql/server-tls
install -m 600 -o postgres -g postgres /run/commander/database-tls-source/server.key /var/lib/postgresql/server-tls/tls.key
install -m 644 -o postgres -g postgres /run/commander/database-tls-source/server.crt /var/lib/postgresql/server-tls/tls.crt
install -m 644 -o postgres -g postgres /run/commander/database-tls-source/ca.crt /var/lib/postgresql/server-tls/ca.crt

exec /usr/local/bin/docker-entrypoint.sh "$@"
