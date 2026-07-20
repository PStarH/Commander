#!/bin/sh
# Cell/demo: align non-root worker with host docker.sock GID so DockerSB
# works without a manually exported DOCKER_GID. Still requires a mounted sock
# and real docker engine — never ALLOW_NO_SANDBOX.
set -eu

if [ -S /var/run/docker.sock ]; then
  SOCK_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  if [ -n "${SOCK_GID}" ] && [ "${SOCK_GID}" != "0" ]; then
    if ! getent group "${SOCK_GID}" >/dev/null 2>&1; then
      addgroup -g "${SOCK_GID}" -S dockersock 2>/dev/null || addgroup -g "${SOCK_GID}" dockersock
    fi
    GRP="$(getent group "${SOCK_GID}" | cut -d: -f1)"
    if [ -n "${GRP}" ]; then
      addgroup commander "${GRP}" 2>/dev/null || true
    fi
  fi
fi

exec su-exec commander node packages/worker-plane/dist/main.js "$@"
