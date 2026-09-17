#!/bin/sh
# =============================================================================
# Generate the PostgreSQL TLS material the kernel-on Compose profiles require.
#
# The kernel never connects with `sslmode=require`: `createVerifiedPostgresPool`
# demands CA validation, hostname verification against the DSN host, and a
# pinned server SPKI. This produces a CA plus a server certificate whose SAN
# covers the in-network service name (`postgres`) and `localhost`.
#
# Usage:
#   sh deploy/docker/kernel-tls/generate-certificates.sh <state-directory> [db-host]
#
# Then export the two variables the compose override requires:
#   COMMANDER_DATABASE_TLS_HOST_DIR=<state-directory>
#   COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256=<printed below>
# =============================================================================
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 STATE_DIRECTORY [DB_HOST]" >&2
  exit 2
fi

STATE_DIR=$1
DB_HOST=${2:-postgres}
mkdir -p "$STATE_DIR"
STATE_DIR=$(CDPATH= cd -- "$STATE_DIR" && pwd)
umask 077

# CA
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$STATE_DIR/ca.key" >/dev/null 2>&1
openssl req -x509 -new -sha256 -days 365 -key "$STATE_DIR/ca.key" \
  -subj "/CN=commander-kernel-database-ca" -out "$STATE_DIR/ca.crt"

# Server certificate. The DSN host is what `checkServerIdentity` validates, so
# the SAN must carry it alongside localhost.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$STATE_DIR/server.key" >/dev/null 2>&1
openssl req -new -sha256 -key "$STATE_DIR/server.key" -subj "/CN=$DB_HOST" \
  -out "$STATE_DIR/server.csr"
cat >"$STATE_DIR/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$DB_HOST,DNS:localhost
EOF
openssl x509 -req -sha256 -days 365 -in "$STATE_DIR/server.csr" \
  -CA "$STATE_DIR/ca.crt" -CAkey "$STATE_DIR/ca.key" -CAcreateserial \
  -extfile "$STATE_DIR/server.ext" -out "$STATE_DIR/server.crt" >/dev/null 2>&1

chmod 600 "$STATE_DIR"/*.key
chmod 644 "$STATE_DIR"/*.crt

spki=$(openssl x509 -in "$STATE_DIR/server.crt" -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -r | cut -d' ' -f1)

echo "TLS material written to $STATE_DIR"
echo "SAN: DNS:$DB_HOST, DNS:localhost"
echo
echo "export COMMANDER_DATABASE_TLS_HOST_DIR=$STATE_DIR"
echo "export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256=$spki"
