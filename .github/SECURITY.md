<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Security policy

**English** | [简体中文](#简体中文)

This fork develops a local control API for OpenTune Standalone (see [docs/control-api.en.md](../docs/control-api.en.md)). Nothing has been released yet.

## Reporting a vulnerability

**Do not open a public issue.** Use Private Vulnerability Reporting (Security → Report a vulnerability) on this repository or on [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/security); both reach the same maintainers. If neither is available, write to **contact@synchain.ca** with `[security]` in the subject. Reports in English or Chinese are welcome. Do not include tokens from OpenTune discovery files or any other credentials.

Response targets, the threat model and the full scope are in the [security policy of OpenTune MCP Server](https://github.com/synchain-oss/opentune-mcp-server/blob/dev/SECURITY.md).

## Scope

- In scope: the control API code and integration hooks that we add in this fork, and our unofficial test builds.
- Out of scope: OpenTune's own code. Report those issues to [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune). If you are unsure which side is affected, report to us and we will route it.

## 简体中文

### 报告漏洞

**不要开公开 issue。** 请通过本仓库或 [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/security) 的私密漏洞报告（Security → Report a vulnerability）提交，两处都由同一批维护者处理。两处都不可用时，请发邮件到 **contact@synchain.ca**，标题带 `[security]`。中文、英文均可。请不要附上 OpenTune 发现文件里的令牌或任何其他凭据。

响应时限、威胁模型与完整范围见 [OpenTune MCP Server 的安全策略](https://github.com/synchain-oss/opentune-mcp-server/blob/dev/SECURITY.md)。

### 范围

- 在范围内：我们在本 fork 中新增的控制接口代码与接入钩子，以及我们的非官方测试版。
- 不在范围内：OpenTune 自身的代码，请报告给 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)。不确定属于哪一方时，报给我们，我们来转交。
