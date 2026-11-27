# LeaderTeam for DeepSeek Harness (V2.2)

![Version](https://img.shields.io/badge/version-2.2.3-blue)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-success)
![DSH Host](https://img.shields.io/badge/DeepSeek%20Harness-%3E%3D0.2.2--alpha.2%20%3C1.0.0-5b6ee1)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.15-339933)
![License](https://img.shields.io/badge/license-Apache--2.0-orange)

**提交一句工程需求，自动拉起多模型团队完成规划、并行施工、独立审查、纠偏与验收交付——无需人工逐个指挥子代理。**

LeaderTeam 是运行在 **DeepSeek Harness（Linux & Windows）** 上的长周期多 Agent 工程协作与安全治理插件（纯 Node.js ESM，零第三方运行时依赖，支持接入 DeepSeek、阿里云百炼 Qwen、智谱 GLM、OpenAI Codex 等主流模型）：

- **不用手管子代理，也不怕“主管一言堂”跑偏**：领队模型自动拆解阶段并并行派发执行成员；双评审在后台**异步非阻塞监督**，仅当双方一致提出异议并经独立裁断认可时才暂停纠偏；遇到连续空转由独立调查员原位引导恢复，同案争议满三次自动整理卷宗交由人工拍板。
- **零模型调用的确定性宿主安全门**：挂载于宿主工具执行管道最后一环，工作区内的合规文件读写与常规命令按确定性规则直接放行（0 次额外审查模型调用），越界读写与 Shell 逃逸硬阻断，跨界操作才调用独立安全门模型复核；宿主版本未验真时严格 **Fail-Closed**。
- **四桶物理 Token 对账与无人值守护栏**：按 `Input / Cache Read / Cache Write / Output` 四桶逐笔落盘真实用量账本（以各上游接口实际返回的计量字段为准，严格区分未上报 `null` 与真实 `0`），内置 Linux `cgroup v2/v1` 容器内存感知、**不跳过审查的 5 小时请求窗口三级节流**，以及笔记本低电量检查点优雅收尾。

---

## 第一屏：3 分钟安装与单 Key 即刻启动（Quick Start）

### 1. 零命令行图形化一键安装（推荐新手）与标准命令行安装

- **运行环境与宿主兼容范围**（完整列表见《[DSH 宿主版本兼容性列表](docs/10-DSH宿主兼容性列表.md)》）：
  - **Node.js `>= 22.15`**（Windows 官方桌面端用户双击 `Install-LeaderTeam.cmd` 时可自动复用桌面端内置运行时，无需单独安装 Node.js）；
  - **DeepSeek Harness `>=0.2.2-alpha.2 <1.0.0`**：已实机核验覆盖 **`0.2.2-alpha.2` ~ `0.2.2-rc.5`** 及最新 **`0.2.3-alpha.1` ~ `0.2.3-alpha.2`**，并内置**自适应结构契约校验**，后续官方桌面端或 CLI 常规更新只要未破坏安全门管道契约即可免升级直跑（安装前可通过图形安装器或 `node bin/lt-doctor.mjs --compatibility-matrix` 预检）；
  - **控制台内置新手引导与一键升级**：首次打开控制台自动弹出三步引导（免命令行粘贴 API Key、选择团队模式、创建首个任务），并在「设置 → 版本更新与兼容」中支持自动检查更新、SHA-256 校验一键升级与失败自动回滚（开源版与闭源免费版严格独立检查，详见《[一键安装、新手引导与自动更新指南](docs/11-一键安装新手引导与自动更新指南.md)》）。

- **方式 A：图形化一键安装器（全程无需命令行）**：
  - Windows：解压后双击 **`Install-LeaderTeam.cmd`**；
  - Linux / WSL2：执行 **`./install-leaderteam.sh`**（或 `node bin/lt-installer.mjs --gui`），在自动打开的浏览器向导中点击安装并直接启动客户端。

- **方式 B：标准 `dsh plugin` 命令行安装**：

> **安装源与跨平台独立 Release 标签说明**：当前稳定版通过 [GitHub Releases](https://github.com/youzi-ovo-create/dsh-leaderteam/releases) 按平台独立分发离线 `.tgz` 插件包——Linux 发行标签为 **`linux-vX.Y.Z`**（如 `linux-v2.2.3`），Windows 发行标签为 **`windows-vX.Y.Z`**（如 `windows-v2.2.3`）；内置安装器与自动更新器会自动按当前系统匹配对应平台 Release（详见《[跨平台独立发行与长期工程治理规范](docs/13-跨平台独立发行与长期工程规范.md)》）：

```bash
# 1A. Linux / WSL2：从 linux-v2.2.3 Release 下载并安装到 web profile
curl -fLO https://github.com/youzi-ovo-create/dsh-leaderteam/releases/download/linux-v2.2.3/dsh-leaderteam-2.2.3.tgz
dsh plugin --profile web add ./dsh-leaderteam-2.2.3.tgz

# 1B. 官方 Windows Desktop：从 windows-v2.2.3 Release 下载并安装到 desktop profile
# （推荐直接双击随附的 Install-LeaderTeam.cmd 图形向导自动识别默认/自定义安装目录；若用命令行安装：）
curl.exe -fLO https://github.com/youzi-ovo-create/dsh-leaderteam/releases/download/windows-v2.2.3/dsh-leaderteam-2.2.3.tgz
dsh plugin --profile desktop add ./dsh-leaderteam-2.2.3.tgz
```

> 若已 `git clone` 本仓库，也可在仓库根目录直接执行 `dsh plugin --profile web add .`；Windows 旧版脚本备份恢复流程见《[官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md)》。

### 2. 单 Key 免网关即刻启动 vs 多模型异构编队

- **Solo-Key 极速模式（零网关、开箱即跑）**：只需导出任意一个上游模型 API Key（内置支持 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY` / `BAILIAN_API_KEY`、`ZHIPU_API_KEY`、`OPENAI_API_KEY`），首次启动 DSH 时会自动在 `<DSH_HOME>/leaderteam/config/leaderteam.config.json` 生成对应的在役主力模型与自动回退配置，新建会话选择 **LeaderTeam** 预设即可直接发送工程需求：
  ```bash
  # Linux Bash
  export DEEPSEEK_API_KEY="sk-..."
  dsh web

  # Windows PowerShell
  $env:DEEPSEEK_API_KEY = "sk-..."
  ```
- **多模型异构编队模式（进阶生产）**：若你运行本地 OpenAI 兼容聚合网关（如 Magpie）或多厂商直连路由，可通过 DSH 右侧栏 **LeaderTeam 控制台**、`config/leaderteam.local.json` 或 `node scripts/configure-models.mjs --serve --open`，为领队（`leader`）、成员执行池（`executionPool`）、双评审（`discussA` / `discussB`）、独立裁断（`arbiter`）与安全门（`gate`）分别指派不同模型家族与推理档位。

---

## 第二屏：诚实选型矩阵（何时用 / 何时不用 LeaderTeam）

多 Agent 治理并非银弹。在引入 LeaderTeam 前，建议按真实工程场景对照选型：

| 对比维度 | 原生 Codex / Claude Code | 官方 `dsh-agent-team` / 轻量插件 | LeaderTeam V2.2 (`dsh-leaderteam`) |
|---|---|---|---|
| **最适核心场景** | 日常单仓交互式 CRUD、中小规模功能快速迭代、具备稳定低延迟旗舰单模型通道 | 在 DSH 内进行轻量级子任务并行扇出，追求极简提示词开销，无需独立监督或强审计 | **长时间 / 夜间无人值守的可验证复杂工程**，希望组合多厂商高性价比模型（DeepSeek / Qwen / GLM / GPT）稳健交付多模块任务 |
| **协调开销与时效** | **最低**（零多代理协调税，紧凑单流最快；公开实测自举编译器仅 `24m43s` / `$1.33`） | 低（仅基础子代理派发与汇总） | 中（分权自治已剪除同步审批等待，治理仅占约 `0.39%` Token，但多阶段验收墙钟时间长于顶级单体） |
| **执行安全边界** | 依赖宿主内置审批与系统沙箱 | 依赖宿主默认工具权限 | **确定性宿主安全门（工作区内零模型调用）**：挂载于 `dispatchToolBody` 最后一环，沙箱内合规操作按规则直通，Linux `bash` 逃逸/软链越界与跨目录写硬阻断，失配 **Fail-Closed** |
| **治理与防死循环** | 单模型自纠错 | 领队单点汇总 | **四阶段分权治理**：领队免审批直派 + `team_direct_exec`、后台异步双评审、2/3 预议 + 独立裁断检查点会商、三次同案争议上调人工 + 独立熔断调查员 |
| **成本审计与长跑护栏** | 平台侧总量账单 | 会话级基础统计 | **四桶物理 Token 对账账本**（`Input / Cache Read / Cache Write / Output` 去重落盘，`null ≠ 0`）、Linux 层级化 `cgroup` 弹性并发、**不跳过审查的 5h 请求窗口三级节流**与笔记本低电量优雅收尾 |

---

## 第三屏：三阶验证阶梯、运维诊断与实跑基准

推荐按**从零成本到生产分支**的三阶路径渐进体验，无需一上来投入长任务额度：

### 阶梯 1：`¥0` 纯离线单元测试验证（零模型调用、不依赖客户端）

克隆仓库后直接验证安全门硬规则、四阶段自治状态机、Linux `cgroup v2/v1` 并发调度、5h 窗口节流与电量状态机（共 289 项跨平台单测）：

```bash
node --test "test/unit/*.test.mjs"
```

### 阶梯 2：低成本微工程真机冒烟（[`examples/smoke-bugfix/`](examples/smoke-bugfix/README.md)）

随仓附带约 80 行代码的双模块计费缺陷微工程（初始 `2 pass / 2 fail`）及有界配置 `examples/smoke-bugfix/leaderteam.smoke.json`（限制 `directExecMaxSteps: 8`、`maxMembersPerTeam: 4`、`maxActiveMembers: 2`），用于快速跑通「领队拆解 → 安全门确定性直通 → 修复至 `4/4` 全绿 → 四桶物理账本审计」闭环。

> **体验目标声明**：在 DeepSeek Flash / V4 Pro 常规负载下，该冒烟工程的**设计体验目标约为 `3–5 分钟`、`~¥0.5–¥1.5`**；实际耗时与费用随模型排队延迟、缓存命中率及服务商定价波动，**不构成固定时间或固定价格承诺**。

### 阶梯 3：生产 Git 分支集成、预检诊断与隐私开关

在生产项目建议绑定独立 Git 分支或 `git worktree` 运行，并配合内置双 CLI 工具进行环境预检与零泄露问题反馈（在克隆仓库根目录下通过 `node bin/...` 调用，或在已安装插件的 `<DSH_HOME>/profiles/<profile>/node_modules/.bin/` 下直接调用 `lt-doctor` / `lt-bugreport`）：

```bash
# 1. 环境与兼容性预检（Node 版本、已验证 DSH 0.2.2-rc.1 / rc.5 与 pipeline 契约、旧补丁冲突、Linux bash/cgroup/pnpm、Windows Win32 5 沙箱权限、Solo-Key 状态）
node bin/lt-doctor.mjs
# 针对待升级的候选客户端目录执行隔离探针（明确区分 VERIFIED / UNVERIFIED_COMPATIBLE_SHAPE / INCOMPATIBLE_PIPELINE）：
node bin/lt-doctor.mjs --check-host <DSH安装目录或模块目录> --workspace <目标工作区>

# 2. 生成严格脱敏的 GitHub Issue 诊断块（自动抹除全部 API Key、个人路径、主机名与任务原文，仅输出规则计数与四桶 Token 汇总）
node bin/lt-bugreport.mjs --out lt-bugreport.md
```

- **Windows 新建目录 `Win32 5` 沙箱权限一键排查**：若非系统盘新建工作区缺少当前用户显式 `(F)` / `WRITE_DAC` 权限导致 `pwsh` 报 `SetNamedSecurityInfoW (Win32 5)`，`lt-doctor` 会直接打印即拷即用的 `icacls` 与 [`tools/dsh-sandbox-acl`](tools/dsh-sandbox-acl/SKILL.md) 带备份修复命令。
- **低电量优雅停机（Battery-Aware Graceful Shutdown）隐私说明与开关**：
  - 默认开启（`powerMonitor.enabled: true`）：每 **12 分钟**（`720000ms`）以无弹窗静默方式采样一次，**仅读取 `(onBattery, batteryPct)` 两个布尔/数值字段**（绝不读取电池序列号、硬件型号或 OEM 标识；在 Linux VPS、WSL2 与台式机上自动静默跳过）。当电池供电且电量 `<= 20%` 时单次通知领队安全落盘检查点并暂停新派发；插电或恢复至 `>= 25%` 时仅重置检测器闩锁（`autoResumeAllowed: false`，绝不未经用户指令擅自恢复已暂停工程）。
  - 如需关闭，在 DSH 侧栏 **LeaderTeam 控制台**关闭开关，或在 `leaderteam.local.json` 中写入：
    ```json
    {
      "powerMonitor": { "enabled": false }
    }
    ```

### 架构文档与实跑基准报告

- **实跑基准与演进分析**：
  - [V2.2 工程实证报告：49 分钟完成 Linux 跨语言核心模块自举与宿主集成](docs/benchmarks/LeaderTeam_V2.2_Linux跨语言自举工程实证报告.md)（附 [脱敏验收回执与账本核算脚本](docs/benchmarks/evidence/v2.2-linux-selfhost/README.md)）
  - [V1.1–V2.2：基于五项真实工程实测的架构演进与发展潜力分析](docs/benchmarks/LeaderTeam_V1.1至V2.2_架构演进与发展潜力分析.md)
  - [V2.1 双项复杂工程实跑测评报告（自举编译器 & 存量生态账本插件，含耗时/成本客观劣势披露）](docs/benchmarks/LeaderTeam_V2.1_双项工程实跑测评报告.md)
- **核心设计与接口契约**：[架构总览与设计决定](docs/00-总览.md) · [配置与接口参考](docs/01-配置与接口.md) · [按需工具与技能](docs/07-按需工具与技能.md) · [可视化与用量账本](docs/08-可视化与用量.md)
- **日常操作与客户端维护**：[一键安装、新手引导与自动更新指南](docs/11-一键安装新手引导与自动更新指南.md) · [历代设计原则与反退化台账](docs/12-历代设计原则与反退化台账.md) · [跨平台独立发行与长期工程治理规范](docs/13-跨平台独立发行与长期工程规范.md) · [使用指南](docs/使用指南.md) · [官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md) · [CHANGELOG.md](CHANGELOG.md)
- **开源许可**：本项目采用 [Apache License 2.0](LICENSE) 许可发布，第三方组件声明见 [leaderteam/NOTICE](leaderteam/NOTICE)。
