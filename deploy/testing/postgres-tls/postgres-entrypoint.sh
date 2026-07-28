#!/bin/sh
set -eu

install -d -m 700 -o postgres -g postgres /var/lib/postgresql/server-tls
install -m 600 -o postgres -g postgres /fixture-certs/postgres.key /var/lib/postgresql/server-tls/tls.key
install -m 644 -o postgres -g postgres /fixture-certs/postgres.crt /var/lib/postgresql/server-tls/tls.crt
install -m 644 -o postgres -g postgres /fixture-certs/ca.crt /var/lib/postgresql/server-tls/ca.crt
exec /usr/local/bin/docker-entrypoint.sh "$@"
