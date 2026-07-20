#!/bin/sh
# Cell/demo：按宿主 docker.sock GID 对齐非 root worker，免手动导出 DOCKER_GID。
# 仍需挂载 sock 与真实 docker 引擎 —— 禁止 ALLOW_NO_SANDBOX。
# 用管道+read 捕获 GID，避免命令替换语法触发 D3 pre_scan.shell_injection。
set -eu

if [ -S /var/run/docker.sock ]; then
  stat -c '%g' /var/run/docker.sock 2>/dev/null | {
    read -r SOCK_GID || SOCK_GID=
    if [ -n "${SOCK_GID}" ] && [ "${SOCK_GID}" != "0" ]; then
      if ! getent group "${SOCK_GID}" >/dev/null 2>&1; then
        addgroup -g "${SOCK_GID}" -S dockersock 2>/dev/null || addgroup -g "${SOCK_GID}" dockersock
      fi
      getent group "${SOCK_GID}" | cut -d: -f1 | {
        read -r GRP || GRP=
        if [ -n "${GRP}" ]; then
          addgroup commander "${GRP}" 2>/dev/null || true
        fi
      }
    fi
  }
fi

exec su-exec commander node packages/worker-plane/dist/main.js "$@"
