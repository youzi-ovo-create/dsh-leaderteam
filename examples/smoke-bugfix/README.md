# `smoke-bugfix` — 低成本真机冒烟验证微工程

这是一个总计约 80 行的双模块 Node.js ESM 微型工程（零第三方依赖），专门用于在首次安装 **LeaderTeam V2.2** 后，以极小上下文快速验证**「领队规划 / 直属探测 → 沙箱 `0ms` 安全门放行 → 跨模块缺陷修复 → 物理四桶 Token 账本落盘」**全链路是否正常工作。

初始状态下，项目包含 **2 处跨模块计费缺陷**：
1. `src/discount.mjs`：基点（Basis Points，`10000 bps = 100%`）折算美分时误用截断取整而非四舍五入；
2. `src/invoice.mjs`：消费税误按折前 `subtotalCents` 计算，而非按折后应税额 `taxableCents` 计算。

运行 `node --test test/invoice.test.mjs` 会稳定呈现 **`2 pass / 2 fail`**，修复后应达到 **`4 pass / 0 fail`**。

> [!NOTE]
> **关于耗时与费用的诚实说明（非固定承诺）**：
> 在 DeepSeek Flash / Chat 错峰时段配合有界配置 `leaderteam.smoke.json`（`directExecMaxSteps: 8`、`maxMembersPerTeam: 4`、`maxActiveMembers: 2`），本微工程的**设计体验目标约为 `3–5 分钟`、`¥0.5–¥1.5`**。实际耗时与账单金额会随上游 API 实时排队延迟、Prompt Cache 命中率、模型重试次数及各服务商刊例调价而波动，**上述区间仅为设计体验目标，不构成固定耗时或固定价格保证**。

---

## 三步完成真机冒烟

### 第 1 步：复制微工程到独立临时目录（保持主仓干净）

- **Linux / macOS**：
  ```bash
  cp -R examples/smoke-bugfix /tmp/lt-smoke-bugfix
  cd /tmp/lt-smoke-bugfix
  node --test test/invoice.test.mjs   # 预期初始状态：2 pass, 2 fail
  ```
- **Windows (PowerShell)**：
  ```powershell
  Copy-Item -Recurse examples\smoke-bugfix "$env:TEMP\lt-smoke-bugfix"
  Set-Location "$env:TEMP\lt-smoke-bugfix"
  # 若目标目录位于非系统盘新建文件夹，建议先运行一次 lt-doctor 检查 Windows 沙箱权限
  node --test test/invoice.test.mjs   # 预期初始状态：2 pass, 2 fail
  ```

### 第 2 步：加载低步数有界配置并启动会话

可将随附的 `leaderteam.smoke.json`（已限制 `directExecMaxSteps: 8`、`maxMembersPerTeam: 4`、`maxActiveMembers: 2`）作为测试配置加载，或直接在已配置好 Solo-Key（如 `DEEPSEEK_API_KEY`）的 DeepSeek Harness 中打开 `/tmp/lt-smoke-bugfix`（Windows 为 `%TEMP%\lt-smoke-bugfix`），新建会话并选择 **LeaderTeam** 预设。

### 第 3 步：粘贴冒烟提示词并核对四桶物理账本

将以下提示词直接粘贴到会话中运行：

```text
请检查当前工作区 src/discount.mjs、src/invoice.mjs 与 test/invoice.test.mjs，定位并修复导致测试失败的两处计费与税基计算缺陷（保持函数签名与导出契约不变），运行 node --test test/invoice.test.mjs 确认 4/4 测试全部通过，并给出简明修复摘要。
```

完成后可执行脱敏诊断命令查看本次冒烟的**安全门本地放行统计**与**四桶物理 Token 消耗（`Input / Cache Read / Cache Write / Output`）**：

```bash
node bin/lt-bugreport.mjs
```
