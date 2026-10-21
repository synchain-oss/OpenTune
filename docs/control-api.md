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

## 首选项与音频设备

这两组方法改的是 OpenTune 安装的**全局设置**，不属于某个工程：它们在所有工程里生效，并且在会话结束后保留。与界面一样没有撤销条目；每次改动都带警告 `GLOBAL_PREFERENCE`，结果里同时给出把旧值设回去的还原方法（`prefs.set` / `audio.set`）。写操作遵守通用的忙碌规则（模态对话框、指针按下、导入/导出进行中时返回 `BUSY`）。

| 方法 | 能力 | 作用 |
|---|---|---|
| `prefs.get` | `read.v1` | 读取处理设置（A4 频率、编辑方案、混合模式、实验功能）、是否已完成首次引导、界面语言（经本协议只读）与最近工程列表。无法确定的处理设置为 null，并在 `processing.nullReasons` 里说明原因。最近工程的路径是不可信数据。 |
| `prefs.set` | `prefs.write` | 照首选项窗口的做法修改 `tuningHz`（400–500，A4 的频率）、`editingScheme`（`openTune` 或 `openDyne`）、`hybridMode` 与 `experimentalFeatures`（显示或隐藏参考绑定等实验功能）。与当前值相同的项不算改动。 |
| `audio.get` | `audio.device` | 读取 Standalone 的音频设备：是否有设备在运行、设备类型、输出设备、采样率、缓冲区大小与输出声道对，以及当前设备类型与设备提供的可选值（`available`）。没有运行的设备时，其余成员为 null，原因是 `no_audio_device`。设备类型与设备名来自操作系统，是不可信数据。 |
| `audio.set` | `audio.device` | 照音频设置页的做法修改 `deviceType`、`outputDevice`、`sampleRateHz`、`bufferSizeFrame`、`outputChannelPair`：给出的成员替换当前设置，设备随之重新打开，重新打开期间播放会停止。 |

要点：

- `tuningHz` 只影响此后的分析与渲染，不会重新计算已有结果（警告 `NOT_RETROACTIVE`）。`hybridMode` 的改动会让 OpenTune 重新渲染所有内容（`sideEffects.reRenderQueued`）。
- OpenTune 异步地把新的编辑方案应用到编辑器，所以改动 `editingScheme` 的调用把全部改动交给一个 `prefsApply` 任务，任务在编辑器应用完方案后结束，不能取消。切换到 `openDyne` 可能让 OpenTune 为钢琴卷帘里打开的片段生成音符，这一步没有撤销条目，结果里有 `sideEffects.notesGenerated` 与警告 `SCHEME_GENERATED_NOTES`、`IRREVERSIBLE`，工程也会被标记为已修改。
- 声码器权重、渲染优先级、音高模型与参考对齐模式在当前版本不能设置。
- `audio.set` 只接受 `audio.get` 的 `available` 里列出的值，否则返回 `INVALID_ARGUMENT(audio_setting_unavailable)`，什么都不改。设备打不开时，服务端像设置页一样恢复原来的设置，调用以 `IO_ERROR(device_open_failed)` 失败，`executed` 为 false；原来的设置也打不开时，`executed` 为 true，且没有设备在运行（`audio.get` 会如实报告）。失败信息会说明是哪一步出了问题，以及原设置是否已恢复。
- 在 ASIO 设备上切换设备类型或输出设备之前，服务端会像设置页一样先把 ASIO 采样率恢复为系统共享渲染率；恢复无法确认时调用失败，当前设备保持不变。

## 与 OpenTune MCP Server 的关系

- [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) 是一个 stdio MCP 服务，采用 MIT 许可。它连接本接口，让 Claude Code、Claude Desktop、Cursor 等 MCP 客户端操作 OpenTune。它的 npm 包 `@synchain/opentune-mcp`（命令 `opentune-mcp`）尚未发布。
- 协议 OTCP v1 的规范正本在 MCP 仓库的 `spec/otcp/v1/`（MIT 许可）。本 fork 在 `Tests/Control/spec/otcp/v1/` 保存一份逐字节相同的副本。

## 非官方测试版（计划）

上游合入之前，我们计划在本 fork 的 Releases 中发布**非官方测试版**（预发布）：

- 只提供 Windows x64 的 zip，tag 形如 `synchain-test/v<版本>-ctl.<n>`。
- **不含任何模型权重**。需要本机已安装官方 OpenTune，由它提供模型。
- 每个测试版都会注明对应的源码（fork tag 与源码归档）和构建方法，并注明 YuFeng926/OpenTune 是唯一的官方渠道。

目前尚未发布任何测试版。

## 首次启动与首次引导对话框

数据目录全新时的首次启动，OpenTune 会弹出模态的首次引导对话框，让用户选择工作流程。任何模态对话框打开期间，控制接口对写操作返回 `BUSY(modal_open)`。这是上游的正常流程，不是缺陷：真实用户回答一次后就不会再出现。

`e2e-windows` 工作流每次启动都使用新的数据目录，所以它借助 MCP 契约与冒烟运行器的 `OTCP_TARGET_DATA_TEMPLATE` 选项，预置一个最小首选项文件，把「已完成首次使用」（`shared.onboardingShown`）写好，并断言该文件已复制进每次启动的数据目录且未被改写。程序是否读到它，由契约与冒烟运行中没有出现 `BUSY(modal_open)` 体现。

冒烟运行里的效果场景（验证「接口说改了什么，声音里就改了什么」）使用另一个模板（`OTCP_E2E_EFFECTS_DATA_TEMPLATE`），其中另外写入 `shared.rendering.lightPitchCorrection=0`，即在关闭混合模式的实例上运行；工作流在效果场景确实运行过（输出目录里有效果场景的报告）时，并核对至少有一个保留的数据目录含该键且为 0，没有报告时跳过这项核对并在摘要里注明。原因：真实用户默认开启混合模式，在该模式下修正量小于 75 音分的渲染块走 DSP 移调路径而不是声码器（阈值 `kPitchShiftThresholdCents`，见 `Source/Inference/ChunkRenderStrategy.h`，上游原注释：DSP 移调在 75 音分内质量优于声码器）；实测在真实人声与谐波音上这类小修正几乎听不出。这是 OpenTune 自身行为（界面同样），可在首选项里关闭混合模式。契约与其他场景仍使用默认（混合模式开启）的模板。

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
