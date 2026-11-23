# LeaderTeam for DeepSeek Harness (V2.1)

运行在官方 **DeepSeek Harness Desktop `0.2.2-rc.1`**（<https://deepseek.com/harness/>）内的多模型工程协作插件与预设体系。核心插件采用纯 JavaScript ESM 编写（零第三方运行时依赖），复用官方原生子代理机制，以**工程交付与任务可完成性**为首要目标。

- 日常使用与治理操作：[使用指南](docs/使用指南.md)
- 配置契约与接口参考：[配置与接口](docs/01-配置与接口.md)
- 部署、沙箱权限与卸载恢复：[官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md)
- 版本变更记录：[CHANGELOG.md](CHANGELOG.md)

---

## 一、环境要求与快速安装

### 1. 运行环境

- **操作系统**：Windows 10/11 x64
- **宿主客户端**：官方 **DeepSeek Harness Desktop `0.2.2-rc.1`**
- **Node.js**：
  - LeaderTeam 核心插件与脚本要求 **`>= 22.15`**（`leaderteam/package.json`）；
  - 若需自行构建随仓 `extensions/dsh-context` 扩展，要求 **`^22.19.0 || >= 24.0.0`**；
  - **推荐统一安装 Node.js `22.19+` 或 `24.x`**。
- **模型网关**：本地回环运行的 OpenAI 兼容聚合网关（如 Magpie，默认 `http://127.0.0.1:3425/v1`）。

### 2. 四步完成安装与首次配置

1. **填写本机路径**（已加入 `.gitignore`，不会入库）：
   将 `config/official-desktop.paths.example.json` 复制为 `config/official-desktop.paths.json`，填入本机 `app`、`home`、`userData` 与 `workspace` 四个绝对路径。
2. **自定义模型路由（重要）**：
   > **提示**：随仓 `config/leaderteam.config.json` 中的 `codex/*`、`zcode/*`、`antigravity/*` 等路由均为**示例网关配置**。请务必按自己的网关与可用模型修改，推荐将 `config/leaderteam.local.example.json` 复制为 `config/leaderteam.local.json` 覆盖，或安装后通过 `node scripts/configure-models.mjs` / DSH 侧栏 **LeaderTeam 控制台**一键探测并切换。
3. **初始化并安装到 Desktop Profile**：
   先运行一次 `scripts\start-official-desktop.ps1` 完成官方目录初始化并完全退出（含系统托盘），再执行幂等安装（自动备份原配置）：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-desktop.ps1 -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-desktop.ps1
   ```
   可选创建桌面快捷方式：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deployment\create-official-shortcut.ps1
   ```
4. **启动与一键卸载**：
   - 日常运行 `scripts\start-official-desktop.ps1`（或桌面快捷方式），新建会话选择 **LeaderTeam** 预设即可工作；点击左侧栏 **LeaderTeam 控制台**图标可实时管理角色模型、执行池、并发上限、工程计时与外部历史计划库（内嵌控制台与 `dsh-context` 用量洞察说明见 [可视化与用量](docs/08-可视化与用量.md)）。
   - 停用并恢复原生执行器（完全退出 Desktop 后执行）：
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-desktop.ps1
     ```

---

## 二、总体架构与权力划分（V2.1）

LeaderTeam V2.1 采用**「领队自主执行、双评审异步监督、独立裁断介入纠偏、安全门最高约束、人工处理最终争议」**的分权治理架构：

| 角色 | 核心职责 | 权限定位 |
|---|---|---|
| **安全门（Safety Gate）** | 最终调度前安全检查、越界拦截、拒绝违规操作 | **最高安全权限**（任何治理决议不得绕过） |
| **独立裁断（Arbiter）** | 争议事实核查、与领队正式会商、强制干预纠偏 | **最高自主治理裁决权** |
| **领队（Leader）** | 滚动规划、技术决策、直接派发、组织施工与验收 | **日常执行指挥权**（无需等待评审审批即可派发） |
| **双评审（Reviewers A/B）** | 后台异步监督、风险提示、发起裁断提请 | **监督权与提请权**（无直接阻断领队权） |
| **直属执行模型（Direct Exec）** | 接受领队高频灵活调用，完成局部探测、验证与修复 | **高调用自由度、最低工作区沙箱执行权限** |
| **普通执行成员（Members）** | 按阶段分工与授权范围独立完成模块研发与测试 | **授权范围内自主执行** |
| **人工（User）** | 处理自治体系三次同案争议仍无法化解的分歧及外部授权 | **最终人工决策权** |

> **核心治理铁律**：仅**安全门**与**独立裁断**拥有直接阻止领队执行或派发的权力；常规施工与后台监督完全并行，零审批阻塞。如需回退传统同步审批流程，可在配置中设置 `governance.mode: "approval"`。

---

## 三、核心工程特性

- **领队自主派发 + 直属执行模型（`team_direct_exec`）**：领队通过 `team_plan` 定义就绪阶段后即可直接调用 `team_dispatch` 派发成员施工，无需同步等待 `plan_id`；局部验证、环境探查或小范围修补可直接调用受沙箱硬锁约束的 `team_direct_exec`，免去繁琐建阶开销。
- **四阶段异步争议治理与三次异议上调人工**：
  1. **异步双评审监督**：后台并行审查阶段契约与产出，非一致异议作为顾问建议（`advisory`）无阻塞回注领队。
  2. **三方内部预议（2/3 多数门槛）**：仅当双评审一致提出强制干预异议，且「双评审 + 独立裁断」达成至少 2/3 多数时才启动正式干预。
  3. **正式二方会商与即时交接检查点**：会商开启前，在途执行成员先写下精确交接检查点并有序暂停（绑定 `conferenceId` 世代防竞态）；领队与裁断直接交涉，裁断可纠偏、采纳替代方案或推翻原异议，整改指令须经实质验证方可销账。
  4. **事件-行为-争议链追踪**：按底层工程事件与实际决策行为累计争议次数；同一实质争议第 3 次触发一致异议时，自动暂停并上调人工裁决。
- **分层确定性安全门与模式缓存**：挂载于 `ToolExecutionPipeline.dispatchToolBody` 最后一环。工作区沙箱内的合规读写与常规构建直接由确定性硬规则放行（`by: "sandbox"`，零大模型调用），跨边界或敏感命令才进入安全门模型复核并支持同类安全模式缓存。
- **真实模型容量直通与无损截断续接**：自动同步上游模型真实 `contextWindow` 与 `maxTokens`（推理档位与可用输出空间独立管理，移除人为固定上限）；领队与成员单次输出触及 `max-tokens` 时自动保留完整上下文与已成功工具记录原位续接，不判失败、不重复执行已落盘操作。
- **独立熔断调查员与双层阻塞区分**：仅在持续零进展空转或重复相同报错时触发独立调查 Agent 诊断恢复（区分正常长只读任务与真死循环）；严格区分**局部可解工程阻塞**（自主排障推进到底，减少打断人工）与**全局/边界级硬阻塞**（如会话根沙箱权限缺失、越界路径限制，在完成非受阻工作后确定性停机，二次停机分歧升级裁断并设硬上限，严禁跨目录拷工程等无意义绕行浪费额度）。
- **资源感知弹性并发与内嵌可视化控制台**：结合用户实时并发上限、CPU/内存/提交空间与上游限流动态调节执行槽位；内置 `leaderteam-panel` 侧栏控制台与 `dsh-context` 扩展，直观展示编队状态、工程计时、历史计划库与真实模型 Token 账本。

---

## 四、目录结构

| 路径 | 说明 |
|---|---|
| `leaderteam/` | 核心插件源码（纯 Node ESM，零第三方运行时依赖）及 `leaderteam/plugins/*` 六个模块化 Cordis 子插件 |
| `config/` | 默认示例配置 `leaderteam.config.json`、本机覆盖模板 `leaderteam.local.example.json`、Desktop/Headless YAML 补丁模板 |
| `extensions/dsh-context/`、`packages/dsh-context/` | 适配团队编队档位徽章与辅助账本统计的 `dsh-context` 扩展源码及打包产物 |
| `scripts/` | Desktop 安装/卸载、启动器、模型与角色配置 CLI、并发控制、外部计划归档管理与官方客户端更新复验脚本 |
| `tools/dsh-sandbox-acl/` | Windows 工作区沙箱文件权限诊断与带回滚修复工具 |
| `test/` | 38 个单元测试文件、安装/备份测试与 45 个官方运行时端到端集成测试场景 |
| `docs/` | 使用指南、架构总览、配置与接口参考、DSH 集成事实、验收清单与部署维护文档 |

---

## 五、安全与运行边界说明

- **Fail-Closed 版本与完整性锁定**：启动时精确校验宿主 `@deepseek-ai/dsh-tools` 版本（`0.2.2-rc.1`）与 `dispatchToolBody` 特征；若官方客户端未经验收升级或关键配置损坏，受管环境会直接拒绝启动，绝不在缺失安全门的状态下降级运行（紧急恢复运行 `scripts\uninstall-desktop.ps1`）。
- **命令行沙箱边界**：文件类工具（`read`/`write`/`edit`/`glob`/`grep`）受词法与 `realpath` 硬边界严格约束；`shell` 档位依赖官方 Windows `workspace-write` 沙箱与安全门审查，处理不可信外部代码时建议优先采用 `readonly` 或 `code` 档位。
- **领队外部只读授权**：领队访问工作区与配置参考根之外的路径默认拦截，需用户在当前会话显式发送一行 `允许读取 <绝对路径>`（仅本会话对领队只读生效，成员不继承）。
- **Windows 新目录沙箱权限**：若共享盘或新建目录缺少当前用户的 `WRITE_DAC`/`WRITE_OWNER` 权限导致 `pwsh` 报 `Win32 5`，详见 [官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md) 使用 `tools/dsh-sandbox-acl` 一键诊断修复。

---

## 六、常用测试与维护命令

```powershell
# 运行纯逻辑与治理状态机单元测试（零模型调用、不依赖 Desktop）
node --test test/unit/*.test.mjs

# 运行 Windows 完整测试套件（单元 + 备份 + 安装 + 配置合并 + 官方运行时集成场景）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-tests.ps1

# 实时查看或调整执行成员最大并发上限（<= 500ms 热生效，无需重启）
node scripts/dev/set-max-members.mjs --status
node scripts/dev/set-max-members.mjs --max 6

# 命令行或本地回环面板管理模型目录、执行池与治理角色
node scripts/configure-models.mjs --status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\open-model-config.ps1

# 外部历史计划库检索、复盘与按期清理
node scripts/plan-archive.mjs --status
node scripts/plan-archive.mjs --clean --older-than-days 30 --dry-run

# 官方客户端新安装包兼容性预检（独立沙盒副本运行，不改动当前环境）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-desktop-update.ps1 -Installer <官方安装包.exe>
```

---

## 七、开源许可

本项目采用 [Apache License 2.0](LICENSE) 开源许可，第三方组件署名与修改声明见 [leaderteam/NOTICE](leaderteam/NOTICE)。
