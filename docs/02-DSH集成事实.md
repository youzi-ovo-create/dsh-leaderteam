# DeepSeek Harness 0.2.2-rc.1 集成事实（均已实测，2026-11-07）

实测方式：官方 DeepSeek Harness 0.2.2-rc.1 发行包，官方 CLI（`--expose-internals .../dsh-desktop-host/lib/cli.js`）`headless` 启动，模型由本地脚本化服务扮演；Desktop 配置合并用官方 CLI `web --patch <已安装 desktop patch> --dump-config` 实际验证。核心 pipeline 与基线 SHA256 一致，见 `reports/official-core-compatibility.json`。

| 事实 | 依据 | 本设计如何使用 |
|---|---|---|
| 官方发行包不会为外部文件插件自动解析宿主 peer；LeaderTeam 仅为自己的导入注册精确宿主解析钩子，共享实际宿主模块实例 | `leaderteam/host/host-imports.mjs`，锚定实际 `process.execPath` 的 moduleRoot；官方集成实测 | 安全门补丁、`defineTool`，不改全局包路由 |
| `tools/execute` 包装可在审查后改写 `exec.name/arguments`；`dispatchToolBody` 同步读取二者后调用工具主体 | `dsh-tools/lib/pipeline.js`；实测改写被安全门看到并拒绝 | 门放在 `dispatchToolBody` |
| `ctx.llm.stream({provider, model, reasoningEffort, maxTokens, system, messages, temperature, signal})` 发出无工具单次请求 | 实测请求 tools=[]、effort/max_tokens 透传 | 安全门、讨论、裁断 |
| `ctx.subagents.startActivation({provider:'spawn', childId, request:{prompt, parent, agentPreset, agentOptions:{provider, model, reasoningEffort}}})` 可跨 Provider 启动成员 | 实测 Gemini 领队 → GLM 成员 | `team_dispatch` |
| `agent/created` 为串行等待事件（startup/resume/clear/compaction），先于首个模型请求 | `dsh-agent/lib/index.js` announce | 注册角色、注入提示段、屏蔽工具 |
| `agent.ctx.systemPrompt.section` 只作用于该 agent | 实测领队/成员各自只见自己的段 | 角色规则（不会被压缩冲掉） |
| `agent.ctx.tools.restrict({deny})` 豁免当前作用域自身注册，不能单独实现完整隔离 | 官方 rc.1 ToolsService 实际代码、第三轮失败、completion-next 原生请求核验 | 改在最终 registry view 过滤所有注册；resolve 冻结后的集合同时用于提示与执行。按任务精确授权及延迟加载见07 |
| headless 一次性运行器不为根会话组合预设；子成员可用预设 | `dsh-headless/lib/index.js` currentPreset；实测 | headless 下领队工具为全局行 |
| Desktop/Web 组合禁用了全局工具行，工具全部在预设里，默认预设 `standard` | `dsh-web-app/cordis.patch.yml` | Desktop 领队与成员各自独立预设 |
| Desktop profile 为 `desktop`，patch 文件为 `profiles/desktop/cordis.patch.yml`；普通 CLI 禁用 `--profile desktop` | 官方 0.2.2-rc.1 配置结构与安装测试 | 安装脚本在 `desktop` profile 的 `cordis.patch.yml` 内写入 managed patch |
| 本地 Magpie provider 可直接合并入 desktop patch | 官方 CLI 实际配置合并 23 项实测 | 安装脚本自动合并 Magpie provider（`apiKeyEnv` 引用启动器进程变量 `LEADERTEAM_MAGPIE_KEY=magpie-local`，`baseURL: http://127.0.0.1:3425/v1`），不需要真实密钥 |
| 恢复（`--session-id`）时成员的模型/档位由 DSH 持久化，但插件状态需自行持久化 | 实测：未持久化时恢复后成员退化为只读 | 成员记录先落盘再启动 |
| 官方一般插件失败会成为警告；LeaderTeam 用同一 required ID 的原生执行器包装插件验证 core、gate、readiness 和模块身份，缺失时拒绝启动且零模型请求 | `entry-native-executor.mjs`、`entry-core.mjs`；it11、it14、it16 | 让团队安全门缺失成为启动失败 |
| 工具输出必须是无损 JSON（不能含 undefined） | 实测 INVALID_TOOL_OUTPUT | 所有团队工具输出统一归一化 |
| DSH 推理档位词表只有 off/minimal/low/medium/high/xhigh/max | llm-pi-ai 配置校验 | 配置中不使用 ultra |
| 官方 Desktop 使用独立数据目录与显式 `--user-data-dir`（路径在本地 `config/official-desktop.paths.json` 中配置）；启动器检测到已在运行会拒绝重复启动，安装/卸载要求该产品全部退出（`test-work/` 下的隔离测试目录除外） | `scripts/start-official-desktop.ps1`、`config/official-desktop.paths.example.json` | 日常启动与安装/卸载共用同一本机路径文件 |
| workspace-write 下文件工具与 pwsh（Windows ACL 受限令牌）只能写工作区与私有临时目录 | dsh-fs-sandbox、dsh-sandbox-windows-acl README | 全局参考的 OS 级兜底 |
| Windows ACL 沙箱要求工作区及其上级具备当前用户的 WRITE_DAC/WRITE_OWNER；只有普通“修改”权限时 pwsh 在启动前失败 | 官方运行时实测 | 新项目目录首次使用 shell 成员前检查并在用户同意后用 `tools/dsh-sandbox-acl` 修复 |
| `agent.model.current()` 返回会话当前模型选择 `{provider, model, reasoningEffort?}`（已记录的切换优先，其次启动选项） | `dsh-agent` AgentModel、`dsh-agent-loop` 构造；it17 实测 | 团队工具核对领队模型（`team.leaderModelPolicy`） |
| Desktop profile 的全局工具 `working_directory`（可切换 cwd）与 `load_workspace_dependencies` 对所有会话可见 | 原生领队/成员 request header；it18 以重新启用的全局工具实测 | 团队会话按档位遮蔽；安全门对档位外工具本就拒绝 |
| bash/pwsh 工具参数必须含 `description`，否则 INVALID_ARGS；安全门审查发生在参数校验之前 | it19 实测 | 场景脚本给出 description；检查器以 callId 对应回执 |
| 会话日志为 `sessions/<cwd 段>/<id>/session.v4.jsonl.zstd`，由多个 zstd 帧拼接 | 实测；Node `zstdDecompressSync` 只解首帧 | 检查器逐帧解码（`scripts/dev/lib/session-rows.mjs`） |

**升级 DSH 时：** 安全门对 `@deepseek-ai/dsh-tools` 版本（`leaderteam/package.json` 的 supportedCoreVersions）与 `dispatchToolBody` 源码特征做精确校验，不匹配会拒绝启动。新版本先在独立环境核对实际执行主体与插件接缝，再明确更新对应版本支持并运行自动、真实模型与原生窗口验收，通过后才部署日常环境。
