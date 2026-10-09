<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# OpenTune 本机控制接口（synchain-oss/OpenTune fork）

中文 | [English](control-api.en.md)

> **状态：预发布，开发中。** 目前没有发布任何东西：既没有测试版构建，也没有 npm 包。在贡献回上游之前，接口与协议仍可能变化。

## 这是什么

`synchain-oss/OpenTune` 是 Synchain 维护的 OpenTune **非官方** fork。它只有一个目的：为 OpenTune Standalone 开发一个**本机控制接口**（只监听 `127.0.0.1`），让本机工具能执行界面里已有的操作，并得到结构化的结果。这类本机工具包括 [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server)。计划支持的操作包括读取音符与音高曲线、导入、AUTO 修音、编辑音符、撤销/重做、导出等。接口跑通后，我们会以 PR 的形式把它贡献回上游。

- OpenTune 是 DAYA STUDIO 的项目（作者 风语），采用 AGPL-3.0 许可。
- **官方仓库是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)，它的 [Releases 页面](https://github.com/YuFeng926/OpenTune/releases) 是唯一的官方发布渠道。** 本 fork 的任何构建都不是官方版本。
- 本 fork 不修改 OpenTune 自身的逻辑，只新增接口代码和少量接入钩子。接口未开启时，行为与上游相同。
- 本 fork、控制接口与测试版的问题，请到 [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/issues) 反馈。在官方 OpenTune 发布版中也能复现的问题属于 OpenTune 本身（见[反馈与安全](#反馈与安全)）。

## 当前状态

| 项 | 状态 |
|---|---|
| 控制接口 | 开发中，尚无可用构建 |
| 官方 OpenTune 发布版 | 不含此接口，需要本 fork 的补丁版构建 |
| Windows x64 | 首先支持（开发中） |
| macOS | 暂无。不会发布 macOS 测试版；macOS 上计划在 OpenTune 官方发布版包含控制接口后可用（或自行从源码构建） |
| Linux | 不支持（OpenTune 本身没有 Linux 版本） |
| 非官方测试版 | 尚未发布 |
| MCP 服务（npm `@synchain/opentune-mcp`） | 尚未发布 |

## 锁定的上游基点

开发期间，本 fork 固定在一个上游提交上，不随上游同步：

- **上游基点**：分支 `upstream-mirror` 的顶端，在本 fork 中打了 tag `upstream/YYYYMMDD-<sha7>`（见本仓库的 tags）；它是 `YuFeng926/OpenTune` `standalone` 分支上的一个提交。
- **分支**：
  - `upstream-mirror`：该提交的原样副本；
  - `dev`（默认分支）：上游基点 + 我们的新增；
  - `feature/control-api`：开发主线。
- 贡献回上游之前，我们会把全部改动一次性 rebase 到上游最新版本，并重新跑完全部检查。
- 每个测试版对应的上游提交，会记录在 MCP 仓库的 COMPATIBILITY 文档中。

## 从源码构建（计划）

构建说明会在构建脚本合入后补全。目前的计划如下：

1. 工具链与依赖要求见上游的 [BUILDING.md](../BUILDING.md)（[English](../BUILDING.en.md)）：Windows 10 1903+ x64、Visual Studio 2022、CMake 3.22+。
2. 克隆时跳过 Git LFS。模型由官方安装包提供，不需要下载：

   ```powershell
   $env:GIT_LFS_SKIP_SMUDGE = '1'
   git clone -b dev https://github.com/synchain-oss/OpenTune.git
   cd OpenTune
   git config lfs.fetchexclude "*"
   git config core.longpaths true
   ```

3. 用我们的依赖脚本拉取锁定版本的依赖，例如 JUCE 9.0.3、ARA SDK 2.3.0、SoundTouch 2.3.3、ONNX Runtime 1.24.4 与 DirectML 1.15.4。脚本会逐个校验 sha256；完整清单以 `deps.lock.json` 为准。脚本**不会**下载任何模型权重。
4. 配置时打开 CMake 选项 `-DOPENTUNE_ENABLE_CONTROL_API=ON`，然后构建 Standalone。依赖脚本与确切的构建命令会在构建脚本加入后写在这里。
5. 构建输出目录里的 `models\` 文件夹只有占位文件，它会遮住已安装官方版的模型，运行前请删除。模型来自本机已安装的官方 OpenTune（最低版本待定）。这一步会在测试版发布前验证，并补成完整步骤。

## 开启控制接口（计划）

控制接口**默认关闭**。只有同时满足以下两个条件才会开启：

1. 构建时打开了 CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`。上游的默认构建与官方发布版都不含接口代码。
2. 启动时显式开启，二选一：
   - 设置环境变量 `OPENTUNE_CONTROL_API=1`；
   - 传入命令行参数 `--control-api`，例如 `OpenTune.exe --control-api`。

开启后的行为：

- 只监听字面量 `127.0.0.1` 上由系统分配的端口，不监听其他网络接口。
- 每次启动都用系统 CSPRNG 生成随机 token（≥128 位）。连接方必须先用它完成 `session.hello` 握手。
- 连接信息写在发现文件 `%LOCALAPPDATA%\OpenTune\control\instances\<pid>.json` 中，正常退出时删除。
- token 不会出现在日志或任何返回结果中。

**安全边界**：

- 以同一系统用户身份运行的程序可以读取发现文件，因此可以控制 OpenTune。
- 其他系统用户、浏览器网页、注入到 AI 对话里的文本，都视为不可信。
- 请不要在多人共用的系统账户中开启接口。
- 完整的威胁模型见协议规范中的 `SECURITY.md`。

环境变量 `OPENTUNE_DATA_DIR` 会把首选项、日志与发现目录重定向到指定目录，仅供测试隔离使用。

## 与 OpenTune MCP Server 的关系

- [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) 是一个 stdio MCP 服务，采用 MIT 许可。它连接本接口，让 Claude Code、Claude Desktop、Cursor 等 MCP 客户端操作 OpenTune。它的 npm 包 `@synchain/opentune-mcp`（命令 `opentune-mcp`）尚未发布。
- 协议 OTCP v1 的规范正本在 MCP 仓库的 `spec/otcp/v1/`（MIT 许可）。本 fork 在 `Tests/Control/spec/otcp/v1/` 保存一份逐字节相同的副本。

## 非官方测试版（计划）

上游合入之前，我们计划在本 fork 的 Releases 中发布**非官方测试版**（预发布）：

- 只提供 Windows x64 的 zip，tag 形如 `synchain-test/v<版本>-ctl.<n>`。
- **不含任何模型权重**。需要本机已安装官方 OpenTune，由它提供模型。
- 每个测试版都会注明对应的源码（fork tag 与源码归档）和构建方法，并注明 YuFeng926/OpenTune 是唯一的官方渠道。

目前尚未发布任何测试版。

## 许可

- OpenTune 采用 AGPL-3.0。本 fork 及我们的全部改动同样按 AGPL-3.0 提供，唯一的例外是 `Tests/Control/spec/otcp/v1/` 中的 OTCP 规范副本，它与正本一样采用 MIT 许可。我们新增的源文件标注 `SPDX-License-Identifier: AGPL-3.0-or-later`。
- 我们**不分发任何模型权重**。其中 OpenVPI 声码器权重与 GAME 预训练权重采用 CC BY-NC-SA 4.0（禁止商用），我们从不打包、上传或转发它们。运行所需的模型来自你自己安装的官方 OpenTune。
- 测试版会附带第三方许可声明，内容按二进制的实际组成生成。
- MCP 服务与协议规范在各自仓库中以 MIT 许可提供。

## 反馈与安全

- 本 fork、控制接口与测试版的问题与建议：[synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues)。
- 安全问题：请通过本仓库或 [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/security) 的私密漏洞报告（Private Vulnerability Reporting）提交，两处都由同一批维护者处理；备用联系方式为 contact@synchain.ca。请勿公开披露。另见 [SECURITY.md](../.github/SECURITY.md)。
- 在官方 OpenTune 发布版中也能复现的问题，属于 OpenTune 本身的问题，请按上游的方式反馈。

---

[Synchain](https://www.synchain.ca) · contact@synchain.ca
