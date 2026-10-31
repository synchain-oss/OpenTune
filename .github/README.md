<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# OpenTune: unofficial Synchain fork (local control API)

**English** | [简体中文](#简体中文)

> **This is not the official OpenTune repository.** OpenTune is a project of DAYA STUDIO, licensed under AGPL-3.0. The official repository is [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune), and its [Releases page](https://github.com/YuFeng926/OpenTune/releases) is the only official distribution channel. Nothing published from this fork is an official OpenTune release.

This fork is maintained by [Synchain](https://www.synchain.ca). It exists to develop a local control API for OpenTune Standalone, for use by [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server), and to propose that API to the upstream project. It adds new code and a small number of integration hooks; while the API is off, OpenTune behaves the same as upstream.

- **Status**: pre-release. Unofficial test builds and the MCP server are published; the API and protocol may still change before they are contributed upstream.
- **OpenTune's own README**: [README.md](../README.md) ([English](../README.en.md)), unchanged from upstream.
- **The control API**: [docs/control-api.en.md](../docs/control-api.en.md) ([中文](../docs/control-api.md)).
- **Test builds**: until the API is part of an official OpenTune release, unofficial test builds are published as pre-releases on [this fork's Releases page](https://github.com/synchain-oss/OpenTune/releases): Windows x64, and macOS on Apple silicon (not yet tested on a real Mac). They are free of charge and contain no model weights; the models come from your own installation of official OpenTune.
- **Reporting problems**: problems with this fork, the control API or test builds go to [synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues). Problems that also reproduce in official OpenTune releases belong to OpenTune itself; please report those through upstream's channels.
- **Security**: see [SECURITY.md](SECURITY.md). Please do not report vulnerabilities in public issues.

## 简体中文

> **这里不是 OpenTune 的官方仓库。** OpenTune 是 DAYA STUDIO 的项目，采用 AGPL-3.0 许可。官方仓库是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)，它的 [Releases 页面](https://github.com/YuFeng926/OpenTune/releases) 是唯一的官方发布渠道。本 fork 发布的任何内容都不是 OpenTune 官方版本。

本 fork 由 [Synchain](https://www.synchain.ca) 维护，目的是为 OpenTune Standalone 开发本机控制接口，供 [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) 使用，并计划向上游项目提交。它只新增代码和少量接入钩子；接口关闭时，OpenTune 的行为与上游相同。

- **状态**：预发布。非官方测试版和 MCP 服务都已发布；在贡献回上游之前，接口与协议仍可能变化。
- **OpenTune 自己的说明**：[README.md](../README.md)（[English](../README.en.md)），与上游一致，未作改动。
- **控制接口说明**：[docs/control-api.md](../docs/control-api.md)（[English](../docs/control-api.en.md)）。
- **测试版**：在控制接口进入 OpenTune 官方发布版之前，非官方测试版以预发布形式放在[本 fork 的 Releases 页面](https://github.com/synchain-oss/OpenTune/releases)：Windows x64，以及还没在真机上测过的 macOS Apple 芯片版。测试版免费，不含任何模型权重；模型来自你自己安装的官方 OpenTune。
- **反馈问题**：本 fork、控制接口与测试版的问题，请到 [synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues) 反馈。在官方 OpenTune 发布版中也能复现的问题属于 OpenTune 本身，请按上游的方式反馈。
- **安全**：见 [SECURITY.md](SECURITY.md)。请不要在公开 issue 中报告漏洞。
