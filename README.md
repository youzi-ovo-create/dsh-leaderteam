# LeaderTeam for DeepSeek Harness (V2.2)

![Version](https://img.shields.io/badge/version-2.2.0-blue)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-success)
![DSH Host](https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1%20%7C%200.2.2--rc.5-5b6ee1)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.15-339933)
![License](https://img.shields.io/badge/license-Apache--2.0-orange)

面向 **DeepSeek Harness（Linux & Windows）** 的**分权自治多 Agent 工程治理 + `0ms` 确定性宿主安全门 + `100%` 四桶物理 Token 账本**标准插件体系（纯 Node.js ESM，零第三方运行时依赖）。

---

## 第一屏：30 秒安装与单 Key 即刻启动（Quick Start）

### 1. 一行命令标准安装（`dsh.bundle`）

要求 **Node.js `>= 22.15`**（若需从源码构建 `extensions/dsh-context` 推荐 `22.19+` 或 `24.x`）与已实机端到端验证的 **DeepSeek Harness `0.2.2-rc.1` 或 `0.2.2-rc.5`**（未实机验证的中间或候选版本默认保持 Fail-Closed，可通过 `lt-doctor --check-host` 离线预检）：

```bash
# 若此前通过 V2.1 install-desktop.ps1 写入过旧版 profile 补丁，升级前先一键清理旧补丁（自动备份）：
npx lt-doctor --clean-legacy-patch

# Linux / macOS / Web CLI Profile 一行安装
dsh plugin --profile web add dsh-leaderteam

# 官方 Desktop Profile 一行安装
dsh plugin --profile desktop add dsh-leaderteam

# 离线发布包 (.tgz) 安装
dsh plugin --profile desktop add ./dsh-leaderteam-2.2.0.tgz
```

> 仓库源码调试安装与旧版环境备份恢复脚本仍完整保留，详见《[官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md)》。

### 2. 单 Key 零网关即刻启动 vs 多网关异构编队

- **Solo-Key 极速模式（零 Magpie、分钟级跑通）**：只需注入单个上游模型 API Key（支持 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY` / `BAILIAN_API_KEY`、`ZHIPU_API_KEY`、`OPENAI_API_KEY`），首次启动会自动在 `<DSH_HOME>/leaderteam/config/leaderteam.config.json` 生成匹配的 Solo-Key 初始配置，新建会话选择 **LeaderTeam** 预设即可开工：
  ```bash
  # Linux / macOS
  export DEEPSEEK_API_KEY="sk-..."

  # Windows PowerShell
  $env:DEEPSEEK_API_KEY = "sk-..."
  ```
- **多网关异构编队模式（进阶生产）**：若您运行本地 OpenAI 兼容聚合网关（如 Magpie）或多厂商订阅路由，可通过 `config/leaderteam.local.json`、`node scripts/configure-models.mjs --serve --open` 或 DSH 侧栏 **LeaderTeam 控制台**为领队、执行池、双评审、独立裁断与安全门分别绑定最优异构模型。

---

## 第二屏：诚实选型矩阵（何时用 / 何时不用 LeaderTeam）

多 Agent 治理并非银弹。在引入 LeaderTeam 前，请按真实工程场景对照选型：

| 对比维度 | 原生 Codex / Claude Code | 官方 `dsh-agent-team` / 轻量插件 | LeaderTeam V2.2 (`dsh-leaderteam`) |
|---|---|---|---|
| **最适核心场景** | 日常单仓交互式 CRUD、中小规模功能快速迭代、具备稳定低延迟海外旗舰直连通道 | 在 DSH 内进行轻量级子任务并行扇出，追求极简提示词开销，无需独立监督或强审计 | **异步 / 夜间无人值守的可验证后端与系统工程**，依托国内高性价比主力模型（Qwen / DeepSeek / GLM）攻坚复杂多模块交付 |
| **协调开销与时效** | **最低**（零多代理协调税，紧凑单流最快；实测自举编译器仅 `24m43s` / `$1.33`） | 低（仅基础子代理派发与汇总） | 中（分权自治已剪除同步审批等待，治理仅占约 `0.39%` Token，但多阶段验收墙钟时间长于顶级单体） |
| **执行安全边界** | 依赖宿主内置审批与系统沙箱 | 依赖宿主默认工具权限 | **`0ms` 确定性宿主安全门**：挂载于 `dispatchToolBody` 最后一环，沙箱内合规操作 `0ms` 直通，Linux `bash` 重定向/替换逃逸与越界读写硬阻断，失配 **Fail-Closed** |
| **治理与防死循环** | 单模型自纠错 | 领队单点汇总 | **四阶段分权治理**：领队免审批直派 + `team_direct_exec`、后台异步双评审、2/3 预议 + 独立裁断检查点会商、三次同案争议上调人工 + 独立熔断调查员 |
| **成本审计与长跑护栏** | 平台侧总量账单 | 会话级基础统计 | **`100%` 四桶物理 Token 账本**（`Input / Cache Read / Cache Write / Output` 去重对账，`null ≠ 0`）、Linux `cgroup v2` 容器弹性并发、**不降级治理的 5h 请求窗口三级节流**与笔记本低电量优雅收尾 |

---

## 第三屏：三阶验证阶梯、运维诊断与实跑基准

推荐按**从零成本到生产分支**的三阶路径渐进验证，无需一上来投入长任务额度：

### 阶梯 1：`¥0` 纯离线单元测试验证（零模型调用、不依赖 Desktop）

克隆仓库后直接验证安全门硬规则、四阶段自治状态机、Linux `cgroup v2` 并发调度、5h 窗口节流与电量状态机：

```bash
node --test "test/unit/*.test.mjs"
```

### 阶梯 2：低成本微工程真机冒烟（[`examples/smoke-bugfix/`](examples/smoke-bugfix/README.md)）

随仓附带约 80 行代码的双模块计费缺陷微工程（初始 `2 pass / 2 fail`）及有界配置 `examples/smoke-bugfix/leaderteam.smoke.json`（限制 `directExecMaxSteps: 8`、`maxMembersPerTeam: 4`、`maxActiveMembers: 2`），用于快速打通「领队拆解 → `0ms` 安全门放行 → 修复至 `4/4` 全绿 → 四桶物理账本审计」闭环。

> **体验目标声明**：在 DeepSeek Flash / Chat 错峰时段下，该冒烟工程的**设计体验目标约为 `3–5 分钟`、`~¥0.5–¥1.5`**；实际耗时与费用随模型排队延迟、缓存命中率及服务商定价波动，**不构成固定时间或固定价格承诺**。

### 阶梯 3：生产 Git 分支集成、预检诊断与隐私开关

在生产仓库建议绑定独立 Git 工作分支或 `git worktree` 运行，并配合内置双 CLI 工具进行环境预检与零泄露问题反馈：

```bash
# 1. 环境与兼容性预检（Node 版本、已验证 DSH 0.2.2-rc.1 / rc.5 与 pipeline 契约、旧补丁冲突、Linux bash/cgroup v2、Windows Win32 5 沙箱权限、Solo-Key 状态）
npx lt-doctor
# 或针对未正式签发的候选客户端目录执行隔离探针（明确区分 VERIFIED / UNVERIFIED_COMPATIBLE_SHAPE / INCOMPATIBLE_PIPELINE）：
node bin/lt-doctor.mjs --check-host <DSH安装目录或模块目录> --workspace <目标工作区>

# 2. 生成严格脱敏的 GitHub Issue 诊断块（自动抹除全部 API Key、个人路径、主机名与任务原文，仅输出规则计数与四桶 Token 汇总）
npx lt-bugreport
node bin/lt-bugreport.mjs --out lt-bugreport.md
```

- **Windows 新建目录 `Win32 5` 沙箱权限一键排查**：若非系统盘新建工作区缺少当前用户显式 `(F)` / `WRITE_DAC` 权限导致 `pwsh` 报 `SetNamedSecurityInfoW (Win32 5)`，`lt-doctor` 会直接打印即拷即用的 `icacls` 与 [`tools/dsh-sandbox-acl`](tools/dsh-sandbox-acl/SKILL.md) 带备份修复命令。
- **低电量优雅停机（Battery-Aware Graceful Shutdown）隐私说明与开关**：
  - 默认开启（`powerMonitor.enabled: true`）：每 **12 分钟**（`720000ms`）以无弹窗静默方式采样一次，**仅读取 `(onBattery, batteryPct)` 两个布尔/数值字段**（绝不读取电池序列号、硬件型号或 OEM 标识；在 Linux VPS、WSL2 与台式机上自动静默跳过）。当电池供电且电量 `<= 20%` 时单次通知领队安全落盘检查点并暂停新派发；插电或恢复至 `>= 25%` 时仅重置检测器闩锁（`autoResumeAllowed: false`，绝不未经用户指令擅自恢复已暂停工程）。
  - 如需关闭，在 `leaderteam.local.json` 或 `leaderteam.config.json` 中写入即可：
    ```json
    {
      "powerMonitor": { "enabled": false }
    }
    ```

### 架构文档与实跑基准报告

- **实跑基准与横向对照**：[V2.1 双项复杂工程实跑测评报告（自举编译器 & 存量生态账本插件）](docs/benchmarks/LeaderTeam_V2.1_双项工程实跑测评报告.md)
- **核心设计与接口契约**：[架构总览与设计决定](docs/00-总览.md) · [配置与接口参考](docs/01-配置与接口.md) · [按需工具与技能](docs/07-按需工具与技能.md) · [可视化与用量账本](docs/08-可视化与用量.md)
- **日常操作与客户端维护**：[使用指南](docs/使用指南.md) · [官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md) · [官方客户端更新复验](docs/官方Desktop更新复验.md) · [CHANGELOG.md](CHANGELOG.md)
- **开源许可**：本项目采用 [Apache License 2.0](LICENSE) 许可发布，第三方组件声明见 [leaderteam/NOTICE](leaderteam/NOTICE)。
