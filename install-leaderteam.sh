#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER_JS=""

if [[ -f "${SCRIPT_DIR}/bin/lt-installer.mjs" && -f "${SCRIPT_DIR}/leaderteam/core/installer.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/bin/lt-installer.mjs"
elif [[ -f "${SCRIPT_DIR}/installer/lt-installer-standalone.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/installer/lt-installer-standalone.mjs"
elif [[ -f "${SCRIPT_DIR}/lt-installer-standalone.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/lt-installer-standalone.mjs"
elif [[ -f "${SCRIPT_DIR}/bin/lt-installer.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/bin/lt-installer.mjs"
else
  echo "[LeaderTeam] 未找到安装引导脚本（bin/lt-installer.mjs 或 installer/lt-installer-standalone.mjs），请先完整解压安装包目录。" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  exec node "${INSTALLER_JS}" --gui "$@"
fi

for cand in "/opt/node/bin/node" "${HOME}/.nvm/current/bin/node" "/usr/local/bin/node"; do
  if [[ -x "${cand}" ]]; then
    exec "${cand}" "${INSTALLER_JS}" --gui "$@"
  fi
done

echo "[LeaderTeam] 未检测到 Node.js (>= 22.15)，请先安装 Node.js 后再次运行本脚本。" >&2
exit 1
