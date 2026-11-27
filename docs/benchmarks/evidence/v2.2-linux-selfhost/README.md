# V2.2 Linux 模块级自举实证——公开脱敏核验附件

本目录随附《[LeaderTeam V2.2 工程实证报告](../../LeaderTeam_V2.2_Linux跨语言自举工程实证报告.md)》的可公开核验数据与复算脚本（已剥离本机路径、身份凭据与未公开闭源源码）：

- `receipt.json`：2026-11-26 独立评审会话在 `Linux x86_64 · Node v24.22.3 · DSH 0.2.2-rc.5` 上对首轮自举冻结版（`71975af`）、修复终验私有分支（`b0b2fc2`）及公开维护分支（`1fda9f0`）执行的隔离复测回执、包 SHA-256 指纹与 `rust/mapper` Git Tree Hash 记录。
- `recount.json`：使用 `recount.py` 对 2026-11-25 自举开发窗口（48 分 53 秒）归档的 13 个会话与旁路治理记录逐笔加总得到的模型调用、四桶 Token、输入缓存命中比例、第 7–13 轮调度唤醒与安全门判定汇总。
- `recount.py`：用于从脱敏运行日志目录复算 `recount.json` 各项指标的参考脚本。

> **复现边界说明**：本公开仓库对应 `LeaderTeam V2.2.x` 开源维护线，不包含私有 `V2.3` 分支的 Rust Mapper 源码；`receipt.json` 中记录的私有分支提交与 Tree Hash 作为审计索引保留。
