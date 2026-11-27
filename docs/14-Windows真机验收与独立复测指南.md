# Windows 真机九项验收与独立复测指南

本指南适用于 `dsh-leaderteam` 开源线全部 Windows 发行版本（`windows-v2.2.2`、`windows-v2.2.3` 及后续版本），供任何维护者、独立 Agent 或外部审计人员在不触碰本机全局 `%USERPROFILE%\.dsh` 的前提下，基于正式候选包 `dsh-leaderteam-X.Y.Z.tgz` 完整复现全部验收闭环。

---

## 一、环境隔离红线与前置条件

- **零全局污染保证**：所有验收脚本均自动在独立临时目录（默认 `<os.tmpdir>/lt-acceptance-work`，或通过 `--work-dir` 指定）下创建全新的零状态 `DSH_HOME`、`DSH_AGENTS_HOME`、`--user-data-dir` 与受试工作区，并内置运行期护栏校验，**严禁读写用户全局 `%USERPROFILE%\.dsh`**。
- **前置环境**：
  - Windows 10 / 11（x64）与 Node.js `>= 22.15`；
  - 已安装的官方 **DeepSeek Harness Desktop**（`>= 0.2.2-rc.1`，支持默认路径或任意自定义盘符目录，如通过 `--dsh-app` 或环境变量 `LT_DSH_APP` 指定）；
  - 涉及 Windows ACL `pwsh` 沙箱与真实桌面 GUI 的第 9 项验收需要在交互桌面会话（真实桌面终端或临时 `schtasks /Create ... /IT`）下运行，以避免非交互窗口站 `0xC0000142`。

---

## 二、验收工具组成（长期纳入版本管理）

| 文件 | 作用 |
| :--- | :--- |
| `scripts/acceptance/run-clean-dsh-9point.mjs` | **第 1–8 项干净 DSH 全链路验收器**：零状态安装 → 首次进入 `/lt/` 面板与引导 → 单 API Key 配置 → DSH 宿主真实识别与选模型 → 首条消息往返 → 支持模式运行（自动按 `capabilities` 适配纯团队或单/团队双模切换）→ 空闲会话修改模型生效 → 升级/回滚、跨平台诱饵标签拦截与历史数据 `SHA-256` 100% 保留。 |
| `scripts/acceptance/run-win-gui-e2e.mjs` | **第 9 项真机桌面 GUI 与 ACL 沙箱验收器**：零状态 `desktop` Profile 安装、交互式 `WinSta0\Default` Windows ACL `pwsh` 沙箱内外写隔离验证（`exitCode: 0`、零 `0xC0000142`）、官方桌面窗口句柄/截图取证、工程交付 `npm test` 闭环及临时任务/进程树即刻回收。 |
| `scripts/acceptance/lib/host-test-bridge.mjs` | **只读/RPC 宿主测试桥接插件**：仅在验收期间通过 `--patch` 临时挂载，暴露 `/api/__lt_accept/*` 路由以读取真实 DSH `llm` / `sessionController` / `credentials` 状态并驱动会话回合，绝不修改用户配置目录。 |

---

## 三、标准复测步骤

### 1. 校验交付制品 `SHA-256`

在发布制品目录执行：

```powershell
Get-Content .\SHA256SUMS.txt | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})\s+(.+)$') {
    $actual = (Get-FileHash -Algorithm SHA256 $Matches[2]).Hash.ToLower()
    Write-Output ("[" + ($(if ($actual -eq $Matches[1]) { "MATCH" } else { "FAIL" })) + "] " + $Matches[2])
  }
}
```

### 2. 运行离线单元测试与发行治理自检

在仓库根目录执行（零付费算力、零桌面端依赖）：

```powershell
# 全量单元测试
node --test --test-concurrency=4 "test/unit/*.test.mjs"

# 发行治理自检（文档零断链、脚本语法、开源纯净度、版本一致性）
node scripts/ci/verify-release-governance.mjs
```

### 3. 运行第 1–8 项干净 DSH 验收

#### 方式 A：零算力确定性模拟上游（`--mode simulated`，推荐作为每次合流回归门禁）

```powershell
# 打包或指定待测候选 .tgz
npm pack
$tgz = ".\dsh-leaderteam-X.Y.Z.tgz"

# 单包模式（自动在隔离工作区构造 +0.0.1 补丁包演练升级与回滚）：
node scripts/acceptance/run-clean-dsh-9point.mjs `
  --tgz $tgz `
  --mode simulated `
  --dsh-app "<你的 DeepSeek Harness 安装目录>" `
  --out .\acceptance-simulated-report.json

# 双包模式（显式指定真实升级目标包与回滚基线包，例如 2.2.2 -> 2.2.3 -> 2.2.2）：
node scripts/acceptance/run-clean-dsh-9point.mjs `
  --tgz .\dsh-leaderteam-2.2.2.tgz `
  --upgrade-tgz .\dsh-leaderteam-2.2.3.tgz `
  --rollback-tgz .\dsh-leaderteam-2.2.2.tgz `
  --mode simulated `
  --dsh-app "<你的 DeepSeek Harness 安装目录>" `
  --out .\acceptance-simulated-report.json
```

#### 方式 B：真实供应商网关验收（`--mode live-provider`，本地只读抓包代理，密钥仅通过环境变量传入）

> 密钥与上游地址绝不硬编码于脚本或落盘至验收报告。

```powershell
$env:LT_ACCEPT_UPSTREAM_URL   = "https://<your-openai-compatible-endpoint>/v1"
$env:LT_ACCEPT_API_KEY        = "<your-api-key>"
$env:LT_ACCEPT_PRIMARY_MODEL  = "<primary-reasoning-model-id>"
$env:LT_ACCEPT_SECONDARY_MODEL = "<secondary-chat-model-id>"

node scripts/acceptance/run-clean-dsh-9point.mjs `
  --tgz .\dsh-leaderteam-X.Y.Z.tgz `
  --mode live-provider `
  --dsh-app "<你的 DeepSeek Harness 安装目录>" `
  --out .\acceptance-live-report.json
```

### 4. 运行第 9 项真实 Windows Desktop GUI 与 ACL `pwsh` 沙箱验收

```powershell
node scripts/acceptance/run-win-gui-e2e.mjs `
  --tgz .\dsh-leaderteam-X.Y.Z.tgz `
  --dsh-app "<你的 DeepSeek Harness 安装目录>" `
  --out .\acceptance-win-gui-report.json
```

> 提示：若在多盘符环境下希望复用本机 `pnpm` 同盘硬链接加速安装，可通过 `--work-dir <与 pnpm store 同盘的临时目录>` 指定隔离工作根路径。

---

## 四、脚手架边界与独立审计说明

为保证验收结论客观透明，本套验收脚手架的 4 项环境处理约定在此显式披露，供独立审计逐项核查：

1. **沙盒内测试隔离参数**：第 6 项在临时受试工程生成的 `package.json` 中使用 `node --test --test-isolation=none`，以规避 Windows ACL 低完整性令牌下 Node.js 24 默认子进程隔离模式触发的 `spawn EPERM`（此为宿主 ACL 与 Node 24 交互特性；如需覆盖多子进程隔离测试，请在常规交互终端单独补充）。
2. **模式切换前等待异步双审结算**：在支持单/团队双模切换的版本中，执行 `Team -> Single` 切换前会通过 `waitModeReady()` 轮询 `pendingReviewsCount === 0` 且 `canSwitch === true`，遵守“异步评审进行中禁止切换模式”的业务门禁。
3. **运行期桌面端共存与零状态拆分验证**：第 1 项在宿主机已有 `DeepSeek Harness.exe` 运行期间采用 `--profile web` 独立验证安装与在线运行；零状态 `desktop` Profile 初始化、Electron GUI 窗口启动与 ACL 沙箱由第 9 项 `run-win-gui-e2e.mjs` 独立隔离验证。
4. **用户自有工作区权限要求**：Windows ACL 沙箱需要调用 `SetNamedSecurityInfoW`（`WRITE_DAC`），因此受试工作区默认创建于当前用户拥有的 `os.tmpdir()` 下；若 `--work-dir` 位于缺少 `WRITE_DAC` 的共享盘，第 9 项脚本会记录 `usedUserOwnedTempFallback: true` 并在用户自有临时目录完成 ACL 校验。
