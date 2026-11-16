<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# OpenTune: unofficial Synchain fork (local control API)

**English** | [简体中文](#简体中文)

> **This is not the official OpenTune repository.** OpenTune is a project of DAYA STUDIO, licensed under AGPL-3.0. The official repository is [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune), and its [Releases page](https://github.com/YuFeng926/OpenTune/releases) is the only official distribution channel. Nothing published from this fork is an official OpenTune release.

This fork was maintained by [Synchain](https://www.synchain.ca) to develop a local control API for OpenTune Standalone, for use by [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server), and to propose that API to the upstream project. The API has been merged upstream ([YuFeng926/OpenTune#52](https://github.com/YuFeng926/OpenTune/pull/52), 2026-11-16) and is maintained there from now on.

- **Status**: no longer maintained. This fork no longer syncs with upstream and will publish no new test builds. Upstream's control API is off by default (CMake option `OPENTUNE_ENABLE_CONTROL_API`), and no official release so far includes it. The author changed the API after the merge; the code and documents here are the version from before the merge.
- **OpenTune's own README**: [README.md](../README.md) ([English](../README.en.md)), unchanged from upstream.
- **The control API**: [docs/control-api.en.md](../docs/control-api.en.md) ([中文](../docs/control-api.md)).
- **Test builds**: until an official OpenTune release includes the control API, the existing unofficial test builds stay available as pre-releases on [this fork's Releases page](https://github.com/synchain-oss/OpenTune/releases): Windows x64, and macOS on Apple silicon (not yet tested on a real Mac). They are free of charge and contain no model weights; the models come from your own installation of official OpenTune.
- **Reporting problems**: problems with the test builds from this fork go to [synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues). Problems with upstream OpenTune (including the control API in upstream's code), and problems that also reproduce in official OpenTune releases, belong to OpenTune itself; please report those through upstream's channels.
- **Security**: see [SECURITY.md](SECURITY.md). Please do not report vulnerabilities in public issues.

## 简体中文

> **这里不是 OpenTune 的官方仓库。** OpenTune 是 DAYA STUDIO 的项目，采用 AGPL-3.0 许可。官方仓库是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)，它的 [Releases 页面](https://github.com/YuFeng926/OpenTune/releases) 是唯一的官方发布渠道。本 fork 发布的任何内容都不是 OpenTune 官方版本。

本 fork 由 [Synchain](https://www.synchain.ca) 维护，用来为 OpenTune Standalone 开发本机控制接口，供 [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) 使用，并向上游项目提交。这个接口已合入上游（[YuFeng926/OpenTune#52](https://github.com/YuFeng926/OpenTune/pull/52)，2026-11-16），此后由上游维护。

- **状态**：已停止维护。本 fork 不再同步上游，也不再发布新的测试版。上游的控制接口构建时默认关闭（CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`），目前的官方发布版都不含它。作者合入后对接口做了修改；这里的代码与文档是合入之前的版本。
- **OpenTune 自己的说明**：[README.md](../README.md)（[English](../README.en.md)），与上游一致，未作改动。
- **控制接口说明**：[docs/control-api.md](../docs/control-api.md)（[English](../docs/control-api.en.md)）。
- **测试版**：在 OpenTune 官方发布版带上控制接口之前，现有的非官方测试版继续以预发布形式保留在[本 fork 的 Releases 页面](https://github.com/synchain-oss/OpenTune/releases)：Windows x64，以及还没在真机上测过的 macOS Apple 芯片版。测试版免费，不含任何模型权重；模型来自你自己安装的官方 OpenTune。
- **反馈问题**：本 fork 测试版的问题，请到 [synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues) 反馈。上游 OpenTune 的问题（包括上游代码里的控制接口），以及在官方 OpenTune 发布版中也能复现的问题，属于 OpenTune 本身，请按上游的方式反馈。
- **安全**：见 [SECURITY.md](SECURITY.md)。请不要在公开 issue 中报告漏洞。
