使用 LeaderTeam 完成当前工作区 LT-E2E-SPEC.md 中的两个独立模块（textstats 与 money）。

要求：
1. 完整阅读 LT-E2E-SPEC.md，制定计划，并通过 team_discuss（kind=plan）获得批准后再派发写入成员。
2. 调用 team_models，根据各模型的能力说明和实时额度，为每个模块自行选择执行模型和档位；两个模块分别交给不同成员，同时进行。
3. 每个成员必须先完整读取 LT-E2E-SPEC.md，再在本模块目录内写入，并实际运行 SPEC 中给出的本模块测试命令，等待其完成结果。测试失败时让同一成员继续修复。
4. 你自己检查实际文件和测试结果，再通过 team_discuss（kind=delivery）进行交付讨论。
5. 只有两个模块的全部测试都实际通过时，最终回答以 “DELIVERY: approved (<交付讨论 id>)” 开头。

除 textstats/ 与 money/ 外不得修改任何文件。不要请求提权、修改 ACL、读取凭据、联网或安装任何东西。
