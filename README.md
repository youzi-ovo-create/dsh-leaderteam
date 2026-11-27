# LeaderTeam for DeepSeek Harness (V2.2)

![Version](https://img.shields.io/badge/version-2.2.2-blue)
![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-success)
![DSH Host](https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--alpha.2%20..%200.2.3--alpha.2-5b6ee1)
![Node.js](https://img.shields.io/badge/node-%3E%3D22.15-339933)
![License](https://img.shields.io/badge/license-Apache--2.0-orange)

**提交一句工程需求，自动拉起多模型团队完成规划、并行施工、独立审查、纠偏与验收交付——无需人工逐个指挥子代理。**

LeaderTeam 是运行在 **DeepSeek Harness（Linux & Windows）** 上的长周期多 Agent 工程协作与安全治理插件（纯 Node.js ESM，零第三方运行时依赖，支持接入 DeepSeek、阿里云百炼 Qwen、智谱 GLM、OpenAI Codex 等主流模型）：

- **不用手管子代理，也不怕“主管一言堂”跑偏**：领队模型按局部边界就绪即刻并行派发执行成员；双评审在后台**异步非阻塞监督**，仅当双方一致提出异议并经独立裁断认可时才暂停纠偏；遇到连续空转由独立调查员原位引导恢复，同案争议满三次自动整理卷宗交由人工拍板。
- **零模型调用的确定性宿主安全门**：挂载于宿主工具执行管道最后一环，工作区内的合规文件读写与常规命令按确定性规则直接放行（0 次额外审查模型调用），越界读写、配置篡改与 Shell 逃逸硬阻断，跨界操作才调用独立安全门模型复核；宿主结构契约失配时严格 **Fail-Closed**。
- **四桶物理 Token 对账与河洛原生工作台（`/lt/`）**：按 `Input / Cache Read / Cache Write / Output` 四桶逐笔落盘真实用量账本（严格区分未上报 `null` 与真实 `0`），内置河洛序可视化工作台、三步新手向导、会话级独立模型跟随（默认 `leaderModelPolicy: "follow"`）、SHA-256 校验热升级与一键回滚，以及 5 小时请求窗口三级节流与笔记本低电量优雅收尾。

---

## 第一屏：3 分钟零命令行安装与单 Key 即刻启动（Quick Start）

### 1. 图形化一键安装（推荐）与标准 `dsh.bundle` 安装

- **运行环境要求**：
  - **Node.js `>= 22.15`**（Windows 下若未单独安装 Node.js，`Install-LeaderTeam.cmd` 会自动复用官方 DeepSeek Harness 桌面端内置运行时启动安装向导）；
  - 官方 **DeepSeek Harness `>= 0.2.2-alpha.2 < 1.0.0`**（已实机认证 `0.2.2-rc.1`、`0.2.2-rc.5`、`0.2.3-alpha.2` 等版本，详见《[DSH 宿主兼容性列表](docs/10-DSH宿主兼容性列表.md)》）；
  - **跨平台独立发行说明**：Linux 与 Windows 共享全部治理内核与 `lt.public.v1`（`1.0.1`）契约，按平台独立验收发版，分别使用 **`windows-v2.2.2`** 与 **`linux-v2.2.2`** Release 标签（详见《[跨平台独立发行与长期工程规范](docs/13-跨平台独立发行与长期工程规范.md)》）。

```powershell
# 方式 A：图形化零命令行一键安装（自动识别默认及 D:\Apps\DeepSeek-Harness 等自定义目录、自动初始化桌面端 Profile、自动校验 SHA-256）
# Windows：解压发布包或克隆仓库后直接双击运行
.\Install-LeaderTeam.cmd

# Linux / WSL2：直接运行一键安装向导
./install-leaderteam.sh
```

```bash
# 方式 B：命令行直接安装对应平台的标准 .tgz 插件包
# Windows PowerShell 下载 windows-v2.2.2：
curl.exe -fLO https://github.com/youzi-ovo-create/dsh-leaderteam/releases/download/windows-v2.2.2/dsh-leaderteam-2.2.2.tgz
# Linux Bash 下载 linux-v2.2.2：
curl -fLO https://github.com/youzi-ovo-create/dsh-leaderteam/releases/download/linux-v2.2.2/dsh-leaderteam-2.2.2.tgz

# 安装到 Web/CLI 或官方 Desktop Profile
dsh plugin --profile web add ./dsh-leaderteam-2.2.2.tgz
dsh plugin --profile desktop add ./dsh-leaderteam-2.2.2.tgz
```

> 更多安装方式（含 `--dsh-dir` 自定义目录、`--profile web` 共存安装、三步新手向导与控制台一键升级回滚）请见《[一键安装、新手引导与自动更新指南](docs/11-一键安装新手引导与自动更新指南.md)》。

### 2. 单 Key 免网关即刻启动 vs 多模型异构编队

- **三步新手引导 / Solo-Key 极速模式（零网关、开箱即跑）**：首次打开 `/lt/` 工作台（官方桌面端侧栏点击 **「立即进入 /lt/ →」**，或 Web 端访问 `/lt/`）会弹出图形化三步向导，点选厂商并粘贴任意一个 API Key（DeepSeek、阿里云百炼 Qwen、智谱 GLM、OpenAI 等），系统将自动写入本地 `0600` 凭据库（`.credentials.yaml` / `.env`）、探测可用模型并同步至 DSH 模型选择器与团队 7 角色路由。也可直接通过环境变量启动：
  ```bash
  # Linux Bash
  export DEEPSEEK_API_KEY="sk-..."
  dsh web

  # Windows PowerShell
  $env:DEEPSEEK_API_KEY = "sk-..."
  ```
- **多模型异构编队模式（进阶生产）**：支持通过 `/lt/` 原生工作台连接本地 Magpie 网关或多厂商直连路由，为领队（`leader`）、成员执行池（`executionPool`）、双评审（`discussA` / `discussB`）、独立裁断（`arbiter`）与安全门（`gate`）分别指派不同模型家族与推理档位；在聊天框手动切换会话模型时默认仅对当前会话自动跟随（`leaderModelPolicy: "follow"`），空闲会话修改配置立即热生效。

---

## 第二屏：诚实选型矩阵（何时用 / 何时不用 LeaderTeam）

多 Agent 治理并非银弹。在引入 LeaderTeam 前，建议按真实工程场景对照选型：

| 对比维度 | 原生 Codex / Claude Code | 官方 `dsh-agent-team` / 轻量插件 | LeaderTeam V2.2 (`dsh-leaderteam`) |
|---|---|---|---|
| **最适核心场景** | 日常单仓交互式 CRUD、中小规模功能快速迭代、具备稳定低延迟旗舰单模型通道 | 在 DSH 内进行轻量级子任务并行扇出，追求极简提示词开销，无需独立监督或强审计 | **长时间 / 夜间无人值守的可验证复杂工程**，希望组合多厂商高性价比模型（DeepSeek / Qwen / GLM / GPT）稳健交付多模块任务 |
| **协调开销与时效** | **最低**（零多代理协调税，紧凑单流最快；公开实测自举编译器仅 `24m43s` / `$1.33`） | 低（仅基础子代理派发与汇总） | 中（分权自治已剪除同步审批等待，治理仅占约 `0.39%` Token，但多阶段验收墙钟时间长于顶级单体） |
| **执行安全边界** | 依赖宿主内置审批与系统沙箱 | 依赖宿主默认工具权限 | **确定性宿主安全门（工作区内零模型调用）**：挂载于 `dispatchToolBody` 最后一环，沙箱内合规操作按规则直通，越界读写、配置篡改与 Shell 逃逸硬阻断，失配 **Fail-Closed** |
| **治理与防死循环** | 单模型自纠错 | 领队单点汇总 | **四阶段分权治理**：局部边界就绪即刻派发 + `team_direct_exec`、后台异步双评审、2/3 预议 + 独立裁断检查点会商、三次同案争议上调人工 + 独立熔断调查员 + Windows `0xC0000142` Shell 通道熔断保护 |
| **成本审计与长跑护栏** | 平台侧总量账单 | 会话级基础统计 | **四桶物理 Token 对账账本**（`Input / Cache Read / Cache Write / Output` 去重落盘，`null ≠ 0`）、Linux 层级化 `cgroup` 弹性并发、**不跳过审查的 5h 请求窗口三级节流**与笔记本低电量优雅收尾 |

---

## 第三屏：三阶验证阶梯、运维诊断与实跑基准

推荐按**从零成本到生产分支**的三阶路径渐进体验，无需一上来投入长任务额度：

### 阶梯 1：`¥0` 纯离线单元测试验证（零模型调用、不依赖客户端）

克隆仓库后直接验证安全门硬规则、四阶段自治状态机、跨平台安装升级过滤、`lt.public.v1` 契约与电量/节流状态机：

```bash
node --test "test/unit/*.test.mjs"
```

### 阶梯 2：低成本微工程真机冒烟（[`examples/smoke-bugfix/`](examples/smoke-bugfix/README.md)）

随仓附带约 80 行代码的双模块计费缺陷微工程（初始 `2 pass / 2 fail`）及有界配置 `examples/smoke-bugfix/leaderteam.smoke.json`（限制 `directExecMaxSteps: 8`、`maxMembersPerTeam: 4`、`maxActiveMembers: 2`），用于快速跑通「领队拆解 → 安全门确定性直通 → 修复至 `4/4` 全绿 → 四桶物理账本审计」闭环。

> **体验目标声明**：在 DeepSeek Flash / V4 Pro 常规负载下，该冒烟工程的**设计体验目标约为 `3–5 分钟`、`~¥0.5–¥1.5`**；实际耗时与费用随模型排队延迟、缓存命中率及服务商定价波动，**不构成固定时间或固定价格承诺**。

### 阶梯 3：生产 Git 分支集成、预检诊断与隐私开关

```bash
# 1. 环境与宿主兼容性预检（Node 版本、DSH 结构契约与兼容矩阵、旧补丁冲突、Windows Win32 5 沙箱权限、Solo-Key 状态）
node bin/lt-doctor.mjs
node bin/lt-doctor.mjs --matrix
node bin/lt-doctor.mjs --check-host <DSH安装目录或模块目录> --workspace <目标工作区>

# 2. 按当前平台检查与升级正式版（Windows 自动匹配 windows-v*，Linux 自动匹配 linux-v*，绝不跨平台串台）
node bin/lt-update.mjs --check

# 3. 生成严格脱敏的 GitHub Issue 诊断块（自动抹除全部 API Key、个人路径、主机名与任务原文）
node bin/lt-bugreport.mjs --out lt-bugreport.md
```

- **Windows 专项稳定性保障**：支持自动发现 `D:\Apps\DeepSeek-Harness` 等非默认安装路径、零状态初始化 `profiles/desktop`、识别官方客户端 `dsh-app://app/` 内置协议、拦截 `0xC0000142` (`STATUS_DLL_INIT_FAILED`) Shell 初始化故障防死循环，以及通过 [`tools/dsh-sandbox-acl`](tools/dsh-sandbox-acl/SKILL.md) 一键排查修复新建磁盘目录 `Win32 5` 沙箱权限。
- **低电量优雅停机（Battery-Aware Graceful Shutdown）隐私说明与开关**：默认开启（`powerMonitor.enabled: true`），每 **12 分钟**以无弹窗静默方式仅读取 `(onBattery, batteryPct)` 两个字段（绝不读取硬件序列号；Linux VPS、WSL2 与台式机自动静默跳过）；可在控制台关闭或在 `leaderteam.local.json` 设置 `"powerMonitor": { "enabled": false }`。

### 架构文档与工程治理索引

- **安装、兼容与跨平台发行规范**：[一键安装、新手引导与自动更新指南](docs/11-一键安装新手引导与自动更新指南.md) · [DSH 宿主兼容性列表](docs/10-DSH宿主兼容性列表.md) · [跨平台独立发行与长期工程规范](docs/13-跨平台独立发行与长期工程规范.md) · [历代设计原则与反退化台账](docs/12-历代设计原则与反退化台账.md)
- **实跑基准与演进分析**：
  - [V2.2 工程实证报告：49 分钟完成 Linux 跨语言核心模块自举与宿主集成](docs/benchmarks/LeaderTeam_V2.2_Linux跨语言自举工程实证报告.md)（附 [脱敏验收回执与账本核算脚本](docs/benchmarks/evidence/v2.2-linux-selfhost/README.md)）
  - [V1.1–V2.2：基于五项真实工程实测的架构演进与发展潜力分析](docs/benchmarks/LeaderTeam_V1.1至V2.2_架构演进与发展潜力分析.md)
  - [V2.1 双项复杂工程实跑测评报告](docs/benchmarks/LeaderTeam_V2.1_双项工程实跑测评报告.md)
- **核心设计与日常维护**：[架构总览与设计决定](docs/00-总览.md) · [配置与接口参考](docs/01-配置与接口.md) · [可视化与用量账本](docs/08-可视化与用量.md) · [使用指南](docs/使用指南.md) · [官方 Desktop 部署与恢复](docs/官方Desktop部署与恢复.md) · [CHANGELOG.md](CHANGELOG.md)
- **开源许可**：本项目采用 [Apache License 2.0](LICENSE) 许可发布，第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [leaderteam/NOTICE](leaderteam/NOTICE)。
