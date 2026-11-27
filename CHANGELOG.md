# Changelog

本项目的所有重要版本变更均记录于此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.0.0] - 2026-11-27 (Open Leader Team / OLT · `linux-v1.0.0`)

**Open Leader Team（OLT）独立开源品牌首个正式发行版**：在完整保留历史公开发行基线 `linux-v2.2.3` 全部能力与提交血统的基础上，整合原定 V2.2.4 的全部 9 项探索性缺陷修复（`O1`–`O9`）、11 项独立审计问题（`R1`–`R11`）、公开安装脚本入口修复（`PUB-01`），以及旧版 LeaderTeam（`v2.1.x`–`v2.2.x`）至 OLT `v1.0.0` 的平滑代际迁移与防误降级机制（历史 `v2.1.0`–`v2.2.3` 发行记录与标签保持不变）。

### Brand & Migration (`LT 2.x → OLT 1.0.0`)
- **品牌更名与版本号重启**：开源线正式启用独立品牌 **Open Leader Team（OLT）** 与 **`1.0.0`** 版本号；继续沿用 `dsh-leaderteam` 插件包名、`~/.dsh/leaderteam` 数据目录及 `lt.public.v1` 公共契约，旧版用户可原地无损升级，零配置丢失。
- **代际版本比较与防误降级机制（`releaseEpoch`）**：
  - `updater.mjs` 引入 `releaseEpoch`（旧版 LT `2.x` = Epoch `1`，OLT `1.0.0+` = Epoch `2`）及 `compareReleaseVersions`，确保自动更新检查、发行列表排序与安装器离线包选择均严格将 OLT `v1.0.0` 识别为旧版 LT `v2.1.x`/`v2.2.x` 的**正向迁移升级**（绝不误判为降级，且 OLT `v1.0.0` 绝不会将历史 `linux-v2.2.3` 误报为新版本）；
  - 备份快照完整性校验同步识别 OLT Epoch `2`（始终校验工作台主脚本与 `public-api.mjs`），同时保留对历史 V2.2.1/V2.2.2/V2.2.3 备份的完整回滚能力。

### Fixed
- **安装、升级、降级兼容与备份回滚（`O5`–`O7`、`R1`、`R2`、`R4`、`R7`、`R8`、`PUB-01`）**：
  - 区分历史 `< 2.2.2` 内嵌面板版（如公开 V2.2.1）与 `>= 2.2.2` 独立工作台版的快照结构校验，完整 V2.2.1 备份可无损回滚，同时继续拦截缺失关键文件或哈希篡改的损坏快照；
  - 即使旧版备份缺少 `fileHashes` 清单，也解析 `web-dist/index.html` 中引用的本地 `.js/.mjs/.css` 资产并校验文件存在且非空，缺失主工作台脚本时严格拒绝回滚（`CORRUPT_BACKUP_SNAPSHOT`）；
  - 降级至旧版 R3 时自动将 `leaderModelPolicy: "follow"` 降级为 `"warn"` 并记录兼容标记，通过一键安装器（`lt-installer` / `install-leaderteam.sh`）、升级器或宿主机启动（`entry-core.mjs`）升回 V2.2.4 后自动幂等恢复 `"follow"`（不覆写用户显式设置的 `"enforce"`）；
  - 更新器严格筛选主插件包资产（`dsh-leaderteam*.tgz`），过滤辅助包（如 `lt-usage-plugin-*.tgz`）与异架构包（`armv7l`/`armhf`/`ia32`/`riscv64` 等），并按 `(track, platform, arch, includePrerelease)` 隔离更新检查缓存，避免稳定版与预发布版缓存串用；
  - 修复 `install-leaderteam.sh` 与 `installer.mjs`，支持 GitHub Release 下载目录中仅放置 `install-leaderteam.sh` + `dsh-leaderteam-*.tgz` 或解压后的 `package/` 目录时直接引导安装并自动识别同目录离线包（`LT_INSTALLER_SOURCE_DIR`）。
- **跨进程配置并发、活跃回合护栏与孤儿会话收敛（`O4`、`O8`、`O9`、`R5`、`R6`）**：
  - 多进程并发保存会话配置采用原子锁（`withSessionConfigLock`）保护，消除写丢失与审计漏记；异常重启后在首回合前自动冲刷已暂存的 `pendingOverride` 并在全局保存/重置时同步温/冷 DSH 会话；
  - 跨 `public-api.mjs` 与 `panel-api.mjs` 统一拒绝不存在会话与升级前遗留孤儿 `session-configs/<ghost>.json`（`404 SESSION_NOT_FOUND`），并在新建同名会话时自动清理早于 `createdAt` 的历史孤儿配置；
  - 跨进程只读识别 `<storageRoot>/active-turns/*--<pid>.json` 活进程标记（0 磁盘写入），确保另一进程运行中回合能正确触发会话配置安全边界暂存及 `GET /workbench/mode` 忙碌拦截，并自动忽略已退出死 PID 残留。
- **衡账失败计费口径与总览一致性（`O2`、`R3`）**：
  - 保留失败但已产生实际 Token 消耗的治理审查调用的真实计费金额与 Token 计数，并同步修正 `overview.totals`、`overview.sessions`、`overview.byModel` 与 `overview.today` 对 `callsSucceeded === 0` 场景的口径，确保已定价失败调用如实计入金额、未定价失败调用诚实展示未知（`null`，绝不伪装为 `¥0`）。
- **网关同步、工作台草稿/错误横幅会话隔离与公开版能力保真（`O1`、`O3`、`R9`、`R10`、`R11`）**：
  - 修改托管 Magpie 网关端口或启动网关时自动同步 DSH 宿主 `providers.magpie.baseURL`；
  - `WorkbenchView` 将发送草稿与异步错误/操作反馈按会话隔离（零新增禁用 React Hook），会话 A 延迟返回的 HTTP 200 或 503 绝不污染或清空会话 B 的草稿与错误横幅；
  - 完整继承 `linux-v2.2.3` 全部能力，确保 `openai-compatible` 自定义中转在首次保存及复用已保存凭据重新保存时均可发现并配置真实 `/v1/models`（如 `local-reasoner`），Team 领队完整保留 `web_fetch`（21 项工具）与 Single 模式 11 项直连工具。

## [2.2.3] - 2026-11-27 (`linux-v2.2.3` / `v2.2.3`)

会话内 `Single / Team` 双模协同、河洛（Heluo）原生控制台 v2、Magpie 网关与衡账（`lt-usage`）融合、历代设计原则（`DP-01`..`DP-06`）防退化护栏、DSH 模型选择器全链路同步修复，以及跨平台独立发行版（`Apache-2.0`）：

### Added
- **会话内 `Single / Team` 双模无缝切换与河洛原生工作台（`lt.public.v1` `1.1.0`）**：支持在同一 `leaderteam` 会话内于安全边界一键切换轻量单兵直连模式（`single`）与多角色分权自治团队模式（`team`），内置完整 React 源码（`packages/lt-web`）与构建产物、Magpie 托管/外置网关生命周期管理及衡账（`packages/lt-usage`）多维成本归因。
- **零命令行图形安装器、三步新手引导、双轨隔离自动升级与会话级模型隔离（Issues #1–#4）**：
  - 自适应宿主结构契约兼容矩阵（覆盖官方 DeepSeek Harness `0.2.2-alpha.2` ~ `0.2.3-alpha.2`）；
  - 图形化一键安装器（`bin/lt-installer.mjs`、`install-leaderteam.sh`、`Install-LeaderTeam.cmd`）与旧补丁无损清理；
  - 控制台内置 SHA-256 校验热升级与一键快照回滚；
  - 会话级独立模型覆盖（`session-config.mjs`）、默认 `leaderModelPolicy: "follow"` 自动跟随 DSH 模型/推理档位切换、空闲会话保存即生效及 User/Agent 严格权限隔离（`403 AGENT_CONFIG_MUTATION_FORBIDDEN`）。
- **跨平台独立发行标签治理（`linux-vX.Y.Z` / `windows-vX.Y.Z`）**：新增《[跨平台独立发行与长期工程治理规范](docs/13-跨平台独立发行与长期工程规范.md)》，升级 `updater.mjs` 与安装器按当前运行平台严格筛选 GitHub Releases（同平台前缀优先、无同平台前缀时向后兼容 `vX.Y.Z`、硬性拦截跨平台标签 `PLATFORM_RELEASE_TAG_MISMATCH`），Linux 与 Windows 各自保留平台专属适配边界并独立验收发版。
- **历代设计原则反退化台账与回归测试（`DP-01`..`DP-06`）**：新增《[历代设计原则与反退化台账](docs/12-历代设计原则与反退化台账.md)》与专项回归套件，固化渐进式规划、免审批自主直派、两级障碍判定、静默前缀 KV 缓存保护、`team_conference` 按需参数注入、隐私脱敏宿主运行事实及 `@deepseek-ai/dsh-tool-web` 原生联网安全边界。

### Fixed
- **修复「面板保存与 Doctor 全绿，但 DSH 客户端选不到模型」P0 体验缺陷**：
  - 打通独立模式（`ctx === null`）与宿主内置模式双路径模型落盘：保存配置或完成新手引导时同步更新实时 `ctx.credentials`、`$DSH_HOME/.credentials.yaml`（`version: 1` `refs:` 实时监听凭据库）、`$DSH_HOME/.env` 以及 `$DSH_HOME/profiles/<web|desktop>/cordis.patch.yml` 中的 `llm-pi-ai` 与 `agent-default-model`（仅在宿主无可用默认模型或显式切换时更新 `agentDefaultModel`）；
  - 新增 `openai-compatible` 自定义网关预设（内置面板与新手引导均支持）并避让保留内置适配器 ID（`deepseek-official`、`deepseek-account`），修复 `openai` 等内置目录供应商填写自定义 `baseURL` 被忽略或触发 `PiAiCatalogError`（`modelOverrides` 冲突 / 自定义模型缺少 `api: "openai-completions"` / 非推理模型误发 `{ off: "none" }`）的问题；
  - 新手引导连通性预检支持解析真实 `/v1/models` 返回列表并在预设静态模型不存在时自动适配可用主力与轻量模型。
- **Node 24+ 多帧 zstd 会话日志解码修复**：修复 `bin/lt-bugreport.mjs`、`leaderteam/host/observability.mjs` 与 `scripts/dev/lib/session-rows.mjs` 在 Node 24+ 上读取多帧拼接 `session.v4.jsonl.zstd` 时仅解压首帧的问题。
- **合入 V2.2.1 治理与回退修复及公开工程实证报告**：领队末位兜底严格按 `(provider, upstreamModel)` 成对匹配、策略拒绝（Policy Refusal）停止后台异步重发、区分安全门策略回执、修正中途重试 5h 窗口归因、双审回执绑定交付材料快照及回放恢复；同步补齐 `docs/benchmarks/` 公开工程实证报告及脱敏核验附件。

## [2.2.1] - 2026-11-26

跨平台稳定性、调度器抑制、治理回执一致性与推理档位同步维护版（纯 Node.js ESM，Apache-2.0）：

### Fixed
- **调度器零派发唤醒与终态轮询抑制**：修复自主滚动规划下触及槽位上限后 `awaitingSlots` 未复位、降容方向反向触发补派通知及跨轮未识别已宣告 `delivered` 终态的问题；补齐常规负载区间施密特滞回死区、多团队健康采样去重与系统采样器被动读数窗口配置接线。
- **供应商策略拒绝（`CONTENT_REFUSED`）处理与双审材料版本绑定**：无工具审查与安全门收到明确策略拒绝时立即停止自动重试、备用切换及异步补审重发；安全门回执明确区分策略拒绝与临时服务故障；异步双审去重键绑定实际送审材料摘要（原样重提去重，修改提案或验收证据后重新获取双审意见），并在历史会话回放时恢复旧版延迟记录中的策略拒绝状态。
- **多供应商兜底路由与 5 小时请求窗口精度**：修正“跟随领队模型兜底”仅按模型名匹配而忽略 `provider + upstreamModel` 成对核对的问题；将重试尝试纳入 5 小时滚动请求窗口计数，并修正中途模型切换时的尝试归属与正式会商恢复作用域。
- **推理档位 `off → none` 映射与事务性配置写盘**：统一全新宿主配置与已有配置下的逻辑 `off` 线协议映射，模型同步更新时保留用户自定义的 `reasoningEfforts` 映射；多配置文件保存改为事务性原子更新。

### Added
- **工程实证报告与脱敏核验档案**：在 `docs/benchmarks/` 下新增《[LeaderTeam V2.2 工程实证报告：49 分钟完成 Linux 跨语言核心模块自举与宿主集成](docs/benchmarks/LeaderTeam_V2.2_Linux跨语言自举工程实证报告.md)》、《[LeaderTeam V1.1–V2.2：基于五项真实工程实测的架构演进与发展潜力分析](docs/benchmarks/LeaderTeam_V1.1至V2.2_架构演进与发展潜力分析.md)》及配套可复算回执目录 [`docs/benchmarks/evidence/v2.2-linux-selfhost/`](docs/benchmarks/evidence/v2.2-linux-selfhost/README.md)。

## [2.2.0] - 2026-11-24

跨平台（Linux & Windows）一等公民支持、标准 `dsh.bundle` 分发、零网关 Solo-Key 起手与长工程韧性增强版（纯 Node.js ESM，Apache-2.0）：

### Added
- **标准 `dsh.bundle` 一行安装与零配置自举**：新增根级 [package.json](package.json)、[cordis.patch.yml](cordis.patch.yml)、`icon.svg` 与中英多语言元数据，支持通过 `dsh plugin --profile web|desktop add ./dsh-leaderteam-2.2.0.tgz` 直接安装；未显式传入 `configPath` 时自动在 `<DSH_HOME>/leaderteam/config/` 初始化配置。
- **Linux 与 Windows 双一等公民支持**：
  - 重构 [leaderteam/host/host-imports.mjs](leaderteam/host/host-imports.mjs)，同时支持官方 Desktop（`app.asar`）与 Linux / WSL2 / Windows（含 `pnpm` 非提升虚拟存储）下的 `@deepseek-ai/dsh` CLI、`dsh web` 及 `dsh headless` 宿主寻址；
  - 增强 [leaderteam/core/scheduler.mjs](leaderteam/core/scheduler.mjs) 的 Linux `/proc/meminfo`（含严格 `overcommit_memory=2` 判别）与层级化 **`cgroup v2` / `cgroup v1`** 容器内存/CPU 余量计算，防止容器环境高估可用内存导致 OOM；
  - 强化 [leaderteam/core/gate-policy.mjs](leaderteam/core/gate-policy.mjs) 对 Linux `bash` 命令替换、进程替换、ANSI-C 转义、中英文符号链接逃逸、外部挂载目录、重定向与后台守护进程的确定性前置拦截，以及 `bwrap` 沙箱故障识别。
- **电池感知式安全收尾（Battery-Aware Graceful Shutdown）**：新增纯状态机 `leaderteam/core/power-monitor.mjs` 与零依赖无窗适配层 `leaderteam/host/power-adapter.mjs`（支持 Linux 多电池按容量加权与外设电池过滤）。默认每 12 分钟（10~15 分钟可配）静默检测一次电源状态（仅读取是否电池供电与电量百分比，支持 `powerMonitor.enabled: false` 随时关闭）；电池供电 `<= 20%` 时持久化通知领队有序保存检查点收尾（不强杀进程），插电或回升 `>= 25%` 仅重置触发器而不擅自自动恢复已暂停工程，VPS 无电池与 WSL2 未知状态安全静默跳过。
- **Solo-Key 免网关极简起手（`leaderteam/core/solo-key.mjs`）**：自动识别 `DEEPSEEK_API_KEY`（`deepseek-v4-pro` + `deepseek-flash`）、`DASHSCOPE_API_KEY`（`qwen-max` + `qwen-plus`）、`ZHIPU_API_KEY`、`OPENAI_API_KEY` 等单通道环境变量，自动注册 DSH `llm-pi-ai` 路由并补齐全角色降级备用链，无需前置部署本地 Magpie 网关即可开箱直跑。
- **不削弱治理的 5 小时滚动请求窗口守卫（`leaderteam/core/request-window.mjs`）**：严格区分 `local-estimate`（本地估算，统一网关与上游前缀口径）与 `provider-confirmed`（上游确认配额，未知保持 `unknown`）；按「抑制非必要探测 → 限制新派发并发 → 可审计检查点暂停」三级节流，**全程严禁静默跳过或削弱既定双审与安全门**。
- **转化与排障三件套**：新增跨平台 `bin/lt-doctor.mjs`（含未验证宿主离线探测、旧版 V2.1 补丁备份清理与 Windows `Win32 5` ACL 修复命令提示）、`bin/lt-bugreport.mjs`（严格剥离密钥/中英文路径/UNC/用户名的脱敏诊断导出）、`examples/smoke-bugfix/` 微型冒烟示例仓与 `.github/ISSUE_TEMPLATE/`，完成 [README.md](README.md) 首屏通俗化重构。
- **宿主兼容范围精化**：经端到端真机实测放行官方 DeepSeek Harness **`0.2.2-rc.1` 与 `0.2.2-rc.5`**（未实机验证的中间版本 `0.2.2-rc.2`–`rc.4` 及未知新版本严格维持 Fail-Closed 拒绝进入受保护生产运行）。

## [2.1.1] - 2026-11-23

发布就绪（Release Readiness）文档、契约与 CI 修正（不改变核心治理行为）：

### Fixed
- 修正 [docs/01-配置与接口.md](docs/01-配置与接口.md) 与 [docs/07-按需工具与技能.md](docs/07-按需工具与技能.md) 中的配置契约与默认值错误：`governance.mode` 仅接受 `"autonomous"` / `"approval"`（移除错误的 `"legacy"`）、补齐精确字段名（`caucusQuorumNumerator`、`caucusQuorumDenominator`、`maxInternalArbitrationRounds`、`maxConferenceDialogueTurns`、`directExecMaxSteps`、`pauseBarrierTimeoutMs` 及 `circuitBreaker.*` 白名单）、更新 `gate.ruleOnlyTools` 允许列表（`team_note`/`team_plan`/`team_conference`）、修正 `team.maxMembersPerTeam` 默认值（`128`）与 `roles.gate.maxTokens`（`8000`，无固定 `16384` 上限）。
- 更新 [docs/05-验收清单.md](docs/05-验收清单.md)，明确区分 V2.1 默认自治模式场景（`it42`–`it45`）与审批兼容/通用核心场景（`it01`–`it40`），核准场景文件名与数量（38 个单元测试文件、45 个集成场景文件）；同步修正 [test/install-desktop.test.ps1](test/install-desktop.test.ps1) 中硬编码旧模型名 `antigravity/gemini-4-argon` 的断言，改为动态读取 `config/leaderteam.config.json` 中的模型列表。
- 统一 [README.md](README.md)、[docs/官方Desktop部署与恢复.md](docs/官方Desktop部署与恢复.md) 与 [docs/08-可视化与用量.md](docs/08-可视化与用量.md) 的 Node.js 版本说明（LT 核心 `>= 22.15`，构建随仓 `dsh-context` 为 `^22.19.0 || >= 24.0.0`，建议 `22.19+` 或 `24.x`）。

### Added & Improved
- 优化 [README.md](README.md) 首次使用体验：前置环境要求与快速安装步骤，明确标注默认配置中的 `codex/*`、`zcode/*`、`antigravity/*` 为示例路由，提示用户按自身网关修改。
- 补全 [leaderteam/NOTICE](leaderteam/NOTICE) 第三方署名与修改声明，涵盖 `dsh-auto-review v0.15.0`、`dsh-context 0.82.1-leaderteam.1`（`bowenliang123/dsh-context`）与 `@deepseek-ai/dsh-sandbox-windows-acl`。
- 新增最小 Windows 单元测试工作流 [.github/workflows/unit-tests.yml](.github/workflows/unit-tests.yml)（Node 22/24，不依赖真实 Desktop 或付费模型）。

## [2.1.0] - 2026-11-23

LeaderTeam V2.1 首个公开发布基线版本（适配官方 DeepSeek Harness Desktop `0.2.2-rc.1`）。

### 核心架构与治理体系（Autonomous Execution & Governance）
- **分权治理重设计**：确立「领队自主执行、双评审异步监督、独立裁断介入纠偏、安全门最高约束、人工处理最终争议」的自治协作架构；仅安全门与独立裁断拥有直接阻断执行或派发的权力。
- **领队自主派发与直属执行模型（`team_direct_exec`）**：领队无需等待双评审审批即可直接派发阶段成员；新增高自由度、工作区沙箱最低权限锁定的直属执行模型，承担局部探查、快速冒烟与小范围修复。
- **四阶段争议升级与正式会商机制（`team_conference`）**：
  - 双评审后台异步监督，非一致异议作为无阻塞参考建议回注领队；按 `(stageId, stageHash, targetFileHashes)` 自动去重避免重复审查。
  - 双评审一致异议进入「双评审 + 独立裁断」三方预议（2/3 多数表决门槛）。
  - 正式二方会商开启前，在途执行成员与直属执行模型执行即时交接检查点屏障（Immediate Handoff Checkpoint Barrier）并绑定 `conferenceId` 世代防竞态恢复。
  - 独立裁断整改指令（`enforce_correction`）须经实质完成度验证方可销账，禁止仅凭工作区文件变化自动销账。
- **事件-行为-争议链身份识别与三次异议上调人工**：以底层工程事件 ID 与实际决策行为身份追踪争议连续性（文件 SHA-256 仅作辅助证据，防无关文件修改重置计数）；同一争议链第 3 次触发一致异议时直接暂停并上调人工决策。

### 模型容量、执行连续性与防空转护栏
- **真实模型能力直通**：自动探测并同步上游模型真实 `contextWindow` 与 `maxTokens` 参数，移除固定硬编码上限；推理预算与可用输出空间分离管理。
- **单次输出截断（`max-tokens`）无损自动续接**：领队与全部执行成员在触及单轮输出上限时保留完整上下文、读取状态与已成功工具列表，从中断处原位继续，禁止将正常截断判败或强拆微阶段。
- **独立熔断调查与原位恢复**：仅在持续零进展、重复相同报错或长串空转时触发软/硬双级异常检测，调用独立调查 Agent 分析现场并原位引导恢复（识别正常长只读任务防误杀）。
- **双层阻塞区分与停机审查收口**：
  - 局部可解阻塞或尚有未完成非受阻代码阶段时，自主化解并推进到底，减少打断人工；
  - 所有非受阻工作完成后遇到全局/边界硬阻塞（如会话根沙箱 `Win32 5` 权限缺失、越界路径限制或人工业务确认）时确定性直接停机（跨宿主重启自动从 `members.jsonl` 恢复沙箱故障证据）；
  - 收回初审模型对停机的无限否决权：二次停机分歧自动升级独立裁断（`stop-review-arbiter`），单任务最多允许驳回 2 次，严禁跨目录拷贝工程（如 `%TEMP%`）等无意义绕行浪费额度。

### 安全门、调度与可视化
- **分层沙箱确定性安全门与模式缓存**：工作区沙箱内合规文件操作与常规命令走确定性规则秒级放行（`0` 模型调用），跨边界操作走无工具模型审查并缓存安全模式，保留完整 `gate.jsonl` 审计回执与 Fail-Closed 版本指纹校验。
- **资源感知弹性并发与按需工具/技能投影**：实时融合用户并发上限、本机 CPU/内存/提交空间与上游限流信号调节执行并发；按任务精确裁剪成员可见工具 schema 与技能快照。
- **内嵌控制台与用量可观测性**：提供 Cordis 模块化子插件体系（`core`、`lead`、`scheduler`、`consensus`、`timer-archive`、`panel`）及适配团队编队与 `usage.jsonl` 账本统计的 `dsh-context` 扩展。
