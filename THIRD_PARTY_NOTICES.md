# Third-Party Notices (`dsh-leaderteam`)

`dsh-leaderteam` is Copyright 2026 LeaderTeam Contributors and distributed under the **Apache License, Version 2.0** (see [`LICENSE`](./LICENSE)).

This document summarizes the open-source licenses and attributions for bundled, adapted, and ecosystem-integrated components shipped with or supported by `dsh-leaderteam`. Detailed component notices are maintained at the paths linked below.

---

## 1. LeaderTeam Core & Adapted DSH Ecosystem Components (`Apache-2.0`)

- **Detailed Notice**: [`leaderteam/NOTICE`](./leaderteam/NOTICE)
- **Full License Text**: [`LICENSE`](./LICENSE) (`Apache-2.0`)
- **Summary**:
  - **`dsh-auto-review` (`v0.15.0`)** — Apache License 2.0 (adapted inline secret redaction, tool-less reviewer execution, and reviewer JSON extraction in `leaderteam/core/redact.mjs`, `leaderteam/host/llm.mjs`, and `leaderteam/core/gate-policy.mjs`).
  - **`dsh-context` (`0.82.1`, adapted as `0.82.1-leaderteam.1`)** — Copyright `bowenliang123`, Apache License 2.0 (`https://github.com/bowenliang123/dsh-context`, commit `cc481fc070dff5fec57e9d8381f70698f546f59e`, recorded in `leaderteam/NOTICE`).
  - **`@deepseek-ai/dsh-sandbox-windows-acl`** — Diagnostic skill and PowerShell ACL inspection script (`tools/dsh-sandbox-acl/SOURCE.json`).

---

## 2. Hengzhang Usage Analytics (`lt-usage-plugin` / `packages/lt-usage`, `Apache-2.0`)

- **Detailed Notice**: [`packages/lt-usage/NOTICE.md`](./packages/lt-usage/NOTICE.md)
- **Full License Text**: [`LICENSE`](./LICENSE) (`Apache-2.0`)
- **Summary**:
  - Zero-dependency ESM core & session/team ledger reader synchronized from `lt-usage-plugin` (`@lt-usage/core` & `@lt-usage/reader`) into `packages/lt-usage/`, licensed under Apache License 2.0.

---

## 3. Magpie Ecosystem Gateway Integration (`yetone/magpie`, `MIT`)

- **Detailed Notice & Full MIT License**: [`leaderteam/gateway/NOTICE-MAGPIE.md`](./leaderteam/gateway/NOTICE-MAGPIE.md)
- **Upstream Repository**: `https://github.com/yetone/magpie` (`Copyright (c) 2026 yetone`, MIT License)
- **Summary**:
  - LeaderTeam V2.2.x integrates with **Magpie** (`magpie-cli-*` headless CLI variant, `CGO_ENABLED=0`) as an optional managed or external model gateway strictly through its public `/api/*` and OpenAI-compatible `/v1/*` HTTP interfaces with zero upstream source patches.
