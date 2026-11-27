# Changelog

本项目的所有重要版本变更均记录于此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.2.2] - 2026-11-27 (`windows-v2.2.2` / `v2.2.2`)

V2.2 产品化团队协作正式版：集成历代设计原则反退化（`DP-01`..`DP-06`）、河洛原生工作台（`lt.public.v1` `1.0.1`，严格保持纯正团队治理边界 `inSessionDualMode: false`）、一键图形化安装与自动升级、会话级模型跟随，以及 Windows 全链路真机适配（纯 Node.js ESM，Apache-2.0）：

### Added
- **河洛原生工作台（`/lt/`）与三步新手引导（Issues `#1`–`#3`）**：
  - 内置零命令行图形化安装器（`bin/lt-installer.mjs`、`installer/lt-installer-standalone.mjs`、`Install-LeaderTeam.cmd`、`install-leaderteam.sh`）、首次使用三步配置向导（`leaderteam/core/onboarding.mjs`）以及带 `SHA-256` 校验、宿主兼容预检与离线快照自动回滚的双轨更新器（`leaderteam/core/updater.mjs`、`bin/lt-update.mjs`）；
  - 升级自适应结构契约宿主兼容引擎（`leaderteam/core/host-compat.mjs`，支持 `>=0.2.2-alpha.2 <1.0.0`，实机认证 `0.2.2-rc.1`、`0.2.2-rc.5`、`0.2.3-alpha.2`），配套《[DSH 宿主兼容性列表](docs/10-DSH宿主兼容性列表.md)》与《[一键安装、新手引导与自动更新指南](docs/11-一键安装新手引导与自动更新指南.md)》；
  - 补齐根级第三方开源组件声明 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **会话级独立配置、手动切换模型自动跟随与 User/Agent 权限分离（Issue `#4`）**：
  - 默认 `leaderModelPolicy: "follow"`：用户在 DSH 原生聊天界面手动切换模型或推理档位时仅同步当前会话（落盘于 `<DSH_HOME>/leaderteam/session-configs/`），不污染全局配置或其他会话；空闲会话配置保存立即生效，执行中会话在安全边界无损切换；
  - 严格隔离 User 与 Agent 身份：API 层（`403 AGENT_CONFIG_MUTATION_FORBIDDEN`）与安全门硬规则（`protected-lt-config`，覆盖 `write`/`edit` 及 `bash`/`pwsh` 写文件命令）双重阻断模型篡改配置。
- **跨平台独立发行标签治理（`windows-vX.Y.Z` / `linux-vX.Y.Z`）**：
  - 更新器与安装器原生支持平台前缀 Release 标签，严禁盲取 `/releases/latest`，按运行平台过滤 `/releases` 列表并向后兼容历史 `vX.Y.Z` 标签，显式跨平台标签硬拦截（`PLATFORM_RELEASE_TAG_MISMATCH`）；新增《[跨平台独立发行与长期工程规范](docs/13-跨平台独立发行与长期工程规范.md)》。
- **Windows 平台专项工程适配（`windows-v2.2.2`）**：
  - **自定义路径自动发现与零状态桌面初始化**：支持自动扫描 `D:\Apps\DeepSeek-Harness` 等全盘自定义目录、Windows 注册表 `Uninstall` 二阶段展开、运行进程路径及 `--dsh-dir` / `--profile web` 参数；在全新 `$DSH_HOME` 执行 `--profile desktop` 安装前自动幂等初始化 `profiles/desktop/package.json` 与 `cordis.patch.yml`，安装后自动净化历史手工补丁并开启 `tool-web`；独立 `lt-update` 支持自动复用自定义目录 `DeepSeek Harness.exe` 内嵌 CLI；
  - **官方桌面端 `dsh-app://app/` 协议与宿主模型选择闭环**：适配官方 Windows 客户端 `dsh-app:` 窗口内 `/lt/` 与 `/` 互跳（不触发 `_blank` 拦截）；修复 DSH `0.2.2-rc.1+` 顶层数组 `settings.describe()` 解析、同步写入 `.credentials.yaml`（`version: 1`）与 `ctx.credentials.set`、探测 `/v1/models` 动态采纳真实模型 ID、保留自定义网关 `/v1` 路径并严守非推理模型 Schema；
  - **Windows `0xC0000142` Shell 通道熔断、NTFS Junction 归并与 Magpie 生命周期加固**：新增宿主级 Shell 初始化故障（`STATUS_DLL_INIT_FAILED`）双振熔断器（`shell-circuit-breaker.mjs`）；修复 NTFS Junction / 软链接下成员参考资料读取追踪与越界判定（`realpathBestEffort` + `isAssignedRef`）；Windows 下优先发现 `magpie-cli.exe` 服务程序（早于 `magpie.exe` GUI 壳），并在同步停机时保留跨进程 `managed-pid.json` 配合 `taskkill /T /F` 杜绝孤儿进程。

### Fixed
- **正交恢复 V1.9 渐进式局部就绪规划 + V2.1 自主直接派发（`DP-01`..`DP-06`）**：修复自治领队提示词与动态规划上下文遗漏“禁止开局私下预设计全工程、阶段仅需对自身边界就绪即刻派发”纪律的问题；常规区间（`tier=normal`）抑制每步递增计数字符串以保护 KV 缓存前缀；注入隐私安全宿主事实（`host-facts.mjs`）并在预设恢复 `@deepseek-ai/dsh-tool-web`；修复空会话治理快照冻结、允许 `enforce` 模式下通过 `team_status` 上报阻塞，并自动修剪 `executionFallbacks`（详见《[历代设计原则与反退化台账](docs/12-历代设计原则与反退化台账.md)》）。
- **多供应商成对回退、策略拒绝即停与双审材料绑定**：修正领队兜底路由成对核对 `(provider, upstreamModel)`；遇到 `CONTENT_REFUSED` 立即停止重试与异步重发；5 小时窗口纳入重试次数与中途切换归属；双审去重键绑定送审材料摘要；衡账与会话目录统一支持 `~XXXX` 安全编码解码与超长 ID 压缩。

## [2.2.1] - 2026-11-26

跨平台稳定性、调度器抑制、治理回执一致性与推理档位同步维护版（纯 Node.js ESM，Apache-2.0）：

### Fixed
- **调度器零派发唤醒与终态轮询抑制**：修复自主滚动规划下触及槽位上限后 `awaitingSlots` 未复位、降容方向反向触发补派通知及跨轮未识别已宣告 `delivered` 终态的问题；补齐常规负载区间施密特滞回死区、多团队健康采样去重与系统采样器被动读数窗口配置接线。
- **供应商策略拒绝（`CONTENT_REFUSED`）处理与双审材料版本绑定**：无工具审查与安全门收到明确策略拒绝时立即停止自动重试、备用切换及异步补审重发；安全门回执明确区分策略拒绝与临时服务故障；异步双审去重键绑定实际送审材料摘要（原样重提去重，修改提案或验收证据后重新获取双审意见），并在历史会话回放时恢复旧版延迟记录中的策略拒绝状态。
- **多供应商兜底路由与 5 小时请求窗口精度**：修正“跟随领队模型兜底”仅按模型名匹配而忽略 `provider + upstreamModel` 成对核对的问题；将重试尝试纳入 5 小时滚动请求窗口计数，并修正中途模型切换时的尝试归属与正式会商恢复作用域。
- **推理档位 `off → none` 映射与事务性配置写盘**：统一全新宿主配置与已有配置下的逻辑 `off` 线协议映射，模型同步更新时保留用户自定义的 `reasoningEfforts` 映射；多配置文件保存改为事务性原子更新，修复 Windows NTFS 只读回滚与并发波次测试计时稳定性。

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
