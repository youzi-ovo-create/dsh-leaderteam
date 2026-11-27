#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for cand in "/opt/node/bin/node" "${HOME}/.nvm/current/bin/node" "/usr/local/bin/node"; do
    if [[ -x "${cand}" ]]; then
      echo "${cand}"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[LeaderTeam] 未检测到 Node.js (>= 22.15)，请先安装 Node.js 后再次运行本脚本。" >&2
  exit 1
fi

export LT_INSTALLER_SOURCE_DIR="${LT_INSTALLER_SOURCE_DIR:-${SCRIPT_DIR}}"
INSTALLER_JS=""

if [[ -f "${SCRIPT_DIR}/bin/lt-installer.mjs" && -f "${SCRIPT_DIR}/leaderteam/core/installer.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/bin/lt-installer.mjs"
elif [[ -f "${SCRIPT_DIR}/package/bin/lt-installer.mjs" && -f "${SCRIPT_DIR}/package/leaderteam/core/installer.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/package/bin/lt-installer.mjs"
elif [[ -f "${SCRIPT_DIR}/installer/lt-installer-standalone.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/installer/lt-installer-standalone.mjs"
elif [[ -f "${SCRIPT_DIR}/lt-installer-standalone.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/lt-installer-standalone.mjs"
elif [[ -f "${SCRIPT_DIR}/bin/lt-installer.mjs" ]]; then
  INSTALLER_JS="${SCRIPT_DIR}/bin/lt-installer.mjs"
fi

if [[ -n "${INSTALLER_JS}" ]]; then
  exec "${NODE_BIN}" "${INSTALLER_JS}" --gui "$@"
fi

# Fallback for GitHub Release download folder containing `install-leaderteam.sh` + `dsh-leaderteam-*.tgz`:
SIBLING_TGZ="$("${NODE_BIN}" -e '
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter(f => /^dsh-leaderteam-.*\.tgz$/i.test(f)).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile());
const rank = f => {
  const m = /dsh-leaderteam-(\d+)\.(\d+)\.(\d+)/i.exec(path.basename(f));
  if (!m) return [0, 0, 0, 0];
  const maj = Number(m[1]), min = Number(m[2]), pat = Number(m[3]);
  const epoch = maj === 1 ? 2 : 1; // OLT v1.x (epoch 2) > legacy LT v2.x (epoch 1)
  return [epoch, maj, min, pat];
};
files.sort((a, b) => {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < 4; i++) if (ra[i] !== rb[i]) return rb[i] - ra[i];
  return path.basename(b).localeCompare(path.basename(a));
});
if (files[0]) process.stdout.write(files[0]);
' "${SCRIPT_DIR}" 2>/dev/null || true)"

if [[ -n "${SIBLING_TGZ}" ]] && command -v tar >/dev/null 2>&1; then
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lt-installer-stage-XXXXXX")"
  trap 'rm -rf "${STAGE_DIR}"' EXIT
  tar -xzf "${SIBLING_TGZ}" -C "${STAGE_DIR}"
  if [[ -f "${STAGE_DIR}/package/bin/lt-installer.mjs" && -f "${STAGE_DIR}/package/leaderteam/core/installer.mjs" ]]; then
    "${NODE_BIN}" "${STAGE_DIR}/package/bin/lt-installer.mjs" --gui "$@"
    exit $?
  elif [[ -f "${STAGE_DIR}/package/installer/lt-installer-standalone.mjs" ]]; then
    "${NODE_BIN}" "${STAGE_DIR}/package/installer/lt-installer-standalone.mjs" --gui "$@"
    exit $?
  fi
fi

echo "[LeaderTeam] 未找到安装引导脚本（bin/lt-installer.mjs、package/bin/lt-installer.mjs、installer/lt-installer-standalone.mjs 或同目录 dsh-leaderteam-*.tgz），请先将安装包放在同一目录或完整解压。" >&2
exit 1
