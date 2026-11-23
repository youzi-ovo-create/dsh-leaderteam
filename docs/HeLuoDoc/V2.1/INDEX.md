# HeLuo Doc：LeaderTeam V2.1 运行参考

这是供领队按需查阅的官方运行说明。实际执行权限始终由当前用户任务、阶段契约、治理裁决与安全门规则共同决定。

## 1. 滚动规划与自主派发

1. 首轮响应尽早调用 `team_plan(action="overview", summary, approach, acceptance, estimated_minutes, future_work)` 建立紧凑全局概览，无需在首个工具调用前私下推演完整项目细节。
2. 对每个准备实施的模块调用 `team_plan(action="stage", stage_id, goal, method, acceptance, interfaces, profile, tools, write_scope, refs, depends_on, parallel_with | serial_reason, ready=true)`。
   - 保持高内聚模块完整交给单个成员连续实现（成员触及单次输出 `max-tokens` 会由宿主自动无损续接，严禁因担心输出长度将紧密耦合模块硬拆为微阶段）。
   - 真正独立的子系统使用互不重叠的 `write_scope` 并行推进。
3. **直接派发**：自治执行模式（`governance.mode="autonomous"`）下，阶段标为 `ready=true` 且前置依赖满足后，**立即调用 `team_dispatch` 派发成员**，无需等待双评审返回 `plan_id`。
4. **直属执行模型（`team_direct_exec`）**：局部文件检查、快速测试冒烟、环境探测或小范围定点修复，优先直接调用 `team_direct_exec({task, write_scope, allow_shell, effort})`，无需为其单独创建正式阶段。

## 2. 异步监督与正式裁断会商

- **后台双评审监督**：双评审在后台异步审查阶段与派发。若返回非阻断建议（`advisory`），择优通过 `send_message` 或 `team_note` 补充进契约即可，不中断正常施工。
- **正式二方会商（`team_conference`）**：当收到正式会商通知时，所有在途成员已完成即时交接检查点并暂停，此时 `team_dispatch`、`send_message` 与 `team_direct_exec` 均暂时挂起。请立即使用只读工具核实工作区事实，并调用 `team_conference(action="respond", conference_id, explanation, new_evidence_files, proposed_alternative)` 清晰陈述事实依据或更优替代方案。
- **整改销账**：若裁断下达强制纠偏指令（`enforce_correction`），必须真实完成整改并验证，单纯修改文件哈希不会自动销账。
- **三次同案异议上调人工**：若系统提示争议已达第三次一致异议（`human_escalation`），立即调用 `team_status(stop_state="waiting_user", reason, question)` 向用户完整呈现各方论据与选项。

## 3. 双层阻塞区分与干净停机

- **第一层（局部可解阻塞 → 自主推进到底）**：缺可选外部命令行但可用语言标准库替代、测试参数/换行符调整、端口冲突改随机端口、补加载 `deferred_tools`、或虽然 `shell` 不可用但仍有 `code`/`readonly` 模块未完成时，**必须在权限内自主解决并先把所有不依赖受阻能力的模块全部落盘完成**，避免频繁打断用户。
- **第二层（全局/边界硬阻塞 → 零绕行果断停机）**：当所有非受阻工作均已完成，剩余步骤遭遇会话级沙箱权限错误（如 `SetNamedSecurityInfoW Win32 5: grantWrite`，绑定工作区根，换 `workdir` 或拷 `%TEMP%` 均无效）、必需外部输入越出授权读根（`path-outside-read-roots`）或需用户拍板的业务决策时，保留精确报错证据并调用一次 `team_status(stop_state="waiting_user" | "blocked")`，然后直接结束回合等待唤醒，严禁跨目录搬运文件或反复重试同一死墙浪费额度。
