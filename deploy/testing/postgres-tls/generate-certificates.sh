#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 STATE_DIRECTORY" >&2
  exit 2
fi

STATE_DIR=$1
mkdir -p "$STATE_DIR"
STATE_DIR=$(CDPATH= cd -- "$STATE_DIR" && pwd)
umask 077

make_ca() {
  prefix=$1
  subject=$2
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$STATE_DIR/$prefix.key" >/dev/null 2>&1
  openssl req -x509 -new -sha256 -days 2 -key "$STATE_DIR/$prefix.key" \
    -subj "/CN=$subject" -out "$STATE_DIR/$prefix.crt"
}

make_leaf() {
  prefix=$1
  subject=$2
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$STATE_DIR/$prefix.key" >/dev/null 2>&1
  openssl req -new -sha256 -key "$STATE_DIR/$prefix.key" -subj "/CN=$subject" \
    -out "$STATE_DIR/$prefix.csr"
  cat >"$STATE_DIR/$prefix.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost
EOF
  openssl x509 -req -sha256 -days 2 -in "$STATE_DIR/$prefix.csr" \
    -CA "$STATE_DIR/ca.crt" -CAkey "$STATE_DIR/ca.key" -CAcreateserial \
    -extfile "$STATE_DIR/$prefix.ext" -out "$STATE_DIR/$prefix.crt" >/dev/null 2>&1
}

make_ca ca commander-postgres-tls-fixture-ca
make_ca untrusted-ca commander-postgres-tls-untrusted-ca
make_leaf postgres localhost
make_leaf terminator localhost
chmod 600 "$STATE_DIR"/*.key
chmod 644 "$STATE_DIR"/*.crt
