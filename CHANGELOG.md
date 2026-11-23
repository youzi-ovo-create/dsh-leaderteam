# Changelog

本项目的所有重要版本变更均记录于此文件，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
