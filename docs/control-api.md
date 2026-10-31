<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# OpenTune 本机控制接口（synchain-oss/OpenTune fork）

中文 | [English](control-api.en.md)

> **状态：预发布。** 非官方测试版和 MCP 服务都已发布。在贡献回上游之前，接口与协议仍可能变化。

## 这是什么

`synchain-oss/OpenTune` 是 Synchain 维护的 OpenTune **非官方** fork。它只有一个目的：为 OpenTune Standalone 开发一个**本机控制接口**（只监听 `127.0.0.1`），让本机工具能执行界面里已有的操作，并得到结构化的结果。这类本机工具包括 [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server)。计划支持的操作包括读取音符与音高曲线、导入、AUTO 修音、编辑音符、撤销/重做、导出等。接口跑通后，我们会以 PR 的形式把它贡献回上游。

- OpenTune 是 DAYA STUDIO 的项目（作者 风语），采用 AGPL-3.0 许可。
- **官方仓库是 [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune)，它的 [Releases 页面](https://github.com/YuFeng926/OpenTune/releases) 是唯一的官方发布渠道。** 本 fork 的任何构建都不是官方版本。
- 本 fork 不修改 OpenTune 自身的逻辑，只新增接口代码和少量接入钩子。接口未开启时，行为与上游相同。
- 本 fork、控制接口与测试版的问题，请到 [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/issues) 反馈。在官方 OpenTune 发布版中也能复现的问题属于 OpenTune 本身（见[反馈与安全](#反馈与安全)）。

## 当前状态

| 项 | 状态 |
|---|---|
| 控制接口 | 非官方测试版里可用 |
| 官方 OpenTune 发布版 | 不含此接口，需要本 fork 的补丁版构建 |
| Windows x64 | 有非官方测试版 |
| macOS | 仅 Apple 芯片（arm64）的非官方测试版，还没在真机上测过；不支持 Intel Mac。测试包使用临时签名（ad hoc），没有经过 Apple 公证，第一次启动需要手动放行；需要已安装官方 OpenTune 1.8.0 或更新版本（位于 /Applications）。也可自行从源码构建 |
| Linux | 不支持（OpenTune 本身没有 Linux 版本） |
| 非官方测试版 | 以预发布形式放在 [Releases 页面](https://github.com/synchain-oss/OpenTune/releases) |
| MCP 服务（npm `@synchain/opentune-mcp`） | [已发布](https://www.npmjs.com/package/@synchain/opentune-mcp) |

**已知限制（参考轨道）**：本测试版里 OpenTune 自带的实验性参考轨道仍然存在（在首选项「实验功能」打开后出现）。控制接口既不读取也不修改它，唯一的例外是 `content.getDetails` 的 `autoModes.uiButtonRuns`：它如实报告 AUTO 按钮此刻会运行什么（片段有可用的参考绑定时是 `reference`），而 `autoModes.available` 永远不含 `reference`，`content.autoTune` 也没有这个模式。rebase 到最新上游之后，参考轨道会随上游一起消失。

## 锁定的上游基点

开发期间，本 fork 固定在一个上游提交上，不随上游同步：

- **上游基点**：分支 `upstream-mirror` 的顶端，在本 fork 中打了 tag `upstream/YYYYMMDD-<sha7>`（见本仓库的 tags）；它是 `YuFeng926/OpenTune` `standalone` 分支上的一个提交。
- **分支**：
  - `upstream-mirror`：该提交的原样副本；
  - `dev`（默认分支）：上游基点 + 我们的新增；
  - `feature/control-api`：开发主线。
- 贡献回上游之前，我们会把全部改动一次性 rebase 到上游最新版本，并重新跑完全部检查。
- 每个测试版对应的上游提交，都记录在 MCP 仓库的 COMPATIBILITY 文档中。

## 从源码构建

每个测试版的发布说明都列出了构建它用的确切命令。大致步骤如下：

1. 工具链与依赖要求见上游的 [BUILDING.md](../BUILDING.md)（[English](../BUILDING.en.md)）：Windows 10 1903+ x64、Visual Studio 2022、CMake 3.22+。
2. 克隆时跳过 Git LFS。模型由官方安装包提供，不需要下载：

   ```powershell
   $env:GIT_LFS_SKIP_SMUDGE = '1'
   git clone -b dev https://github.com/synchain-oss/OpenTune.git
   cd OpenTune
   git config lfs.fetchexclude "*"
   git config core.longpaths true
   ```

3. 用 `.github/scripts/bootstrap-deps.ps1 -LinkInto <源码目录> -PatchJuce` 拉取锁定版本的依赖，例如 JUCE 8.0.12、ARA SDK 2.3.0、SoundTouch 2.3.2、ONNX Runtime 1.24.4 与 DirectML 1.15.4。脚本会逐个校验 sha256；完整清单以 `.github/scripts/deps.lock.json` 为准。`-PatchJuce` 在 JUCE 上打上游构建所需的补丁（运行上游的 `scripts/github_actions/patch-juce-ara.py`，需要 Python 3）。脚本**不会**下载任何模型权重。
4. 上游的构建后步骤会复制两个模型文件，而上游仓库已不再跟踪它们：在 `pc_nsf_hifigan_44.1k_ONNX\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.onnx` 与 `models\fcpe.onnx` 各放一个 0 字节的空文件（两个路径都被上游的 `.gitignore` 忽略）。
5. 配置时打开 CMake 选项 `-DOPENTUNE_ENABLE_CONTROL_API=ON`，然后构建 Standalone。
6. 构建输出目录里的 `models\` 文件夹只有占位文件，它会遮住已安装官方版的模型，运行前请删除。模型来自本机已安装的官方 OpenTune（Windows 上为 1.7.9 或更新版本）。

## 开启控制接口

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
| `prefs.get` | `read.v1` | 读取处理设置（A4 频率、编辑方案、混合模式、实验功能、声码器权重、渲染优先级、音高模型，以及可选值 `processing.options`）、是否已完成首次引导、界面语言（经本协议只读）与最近工程列表。无法确定的处理设置为 null，并在 `processing.nullReasons` 里说明原因。最近工程的路径是不可信数据。 |
| `prefs.set` | `prefs.write` | 照首选项窗口的做法修改 `tuningHz`（400–500，A4 的频率）、`editingScheme`（`openTune` 或 `openDyne`）、`hybridMode` 与 `experimentalFeatures`（显示或隐藏 OpenTune 的实验功能）、`vocoderWeight`（声码器权重，取 `processing.options.vocoderWeight` 里的文件名）、`renderingPriority`（`gpuFirst` 或 `cpuFirst`）与 `f0Model`（音高模型，取 `processing.options.f0Model`）。与当前值相同的项不算改动。 |
| `audio.get` | `audio.device` | 读取 Standalone 的音频设备：是否有设备在运行、设备类型、输出设备、采样率、缓冲区大小与输出声道对，以及当前设备类型与设备提供的可选值（`available`）。没有运行的设备时，其余成员为 null，原因是 `no_audio_device`。设备类型与设备名来自操作系统，是不可信数据。 |
| `audio.set` | `audio.device` | 照音频设置页的做法修改 `deviceType`、`outputDevice`、`sampleRateHz`、`bufferSizeFrame`、`outputChannelPair`：给出的成员替换当前设置，设备随之重新打开，重新打开期间播放会停止。 |

要点：

- `tuningHz` 只影响此后的分析与渲染，不会重新计算已有结果（警告 `NOT_RETROACTIVE`）。`hybridMode` 的改动会让 OpenTune 重新渲染所有内容（`sideEffects.reRenderQueued`）。
- OpenTune 异步地把新的编辑方案应用到编辑器，所以改动 `editingScheme` 的调用把全部改动交给一个 `prefsApply` 任务，任务在编辑器应用完方案后结束，不能取消。切换到 `openDyne` 可能让 OpenTune 为钢琴卷帘里打开的片段生成音符，这一步没有撤销条目，结果里有 `sideEffects.notesGenerated` 与警告 `SCHEME_GENERATED_NOTES`、`IRREVERSIBLE`，工程也会被标记为已修改。这些音符无法随任务失败而撤回：任务在编辑器生成音符之后失败（例如声码器没有恢复）时，音符保留，工程仍标记为已修改，错误信息说明生成并保留了音符（只写内容句柄，不写文件名），`executed` 为 true。
- `vocoderWeight` 与 `f0Model` 只接受 `prefs.get` 的 `processing.options` 里列出的值（权重文件存在才会列出），否则返回 `INVALID_ARGUMENT(option_unavailable)`，什么都不改，错误信息只写成员名、不写取值。`renderingPriority` 的取值固定。
- OpenTune 异步地切换声码器权重与渲染优先级：处理器只把命令交给渲染运行时就返回，运行时稍后才让声码器进入「重新配置」。所以改动 `vocoderWeight` 或 `renderingPriority` 的调用同样把全部改动交给 `prefsApply` 任务，任务在声码器重新就绪、不在重新配置且运行时的控制线程空闲后结束，不能取消。改动前声码器就不可用（没有声码器，或正在重新加载）时不等待，任务在改完后立即结束。声码器在限定时间（60 秒）内没有恢复时，任务把全部改动撤回（运行时也会再次收到原来的权重或优先级并重新加载，期间 `session.info` 的 `processing.vocoderReconfiguring` 为 true，之后 `processing.vocoderReady` 表示能否加载成功），以 `MODEL_UNAVAILABLE(vocoder_not_ready)` 失败，可重试，`executed` 为 false。若运行时已经结束切换却没有声码器（权重或后端加载失败），任务不再等到上限，立即撤回全部改动，以 `MODEL_UNAVAILABLE(vocoder_load_failed)` 失败，不可重试（同一个权重会再次失败），`executed` 为 false。等待超时而撤回时 `executed` 同样是 false，但如果原来的切换只是慢，稍后仍会完成，清空缓存并重新渲染，被撤回的切换又会重新渲染一次，最终状态一致。改动 `vocoderWeight` 会让 OpenTune 在新权重加载完成后重新渲染所有内容，每次改动 `vocoderWeight` 的结果里都有 `sideEffects.reRenderQueued`，任务有没有等待声码器都一样（任务没有等待时，重新渲染在任务结束之后才开始；权重加载失败则不会重新渲染，`session.info` 的 `processing.vocoderReady` 保持 false）；改动 `renderingPriority` 不会重新渲染。
- `f0Model`：处理器拒绝切换音高模型时，调用以 `MODEL_UNAVAILABLE(model_missing)` 失败，`executed` 为 false，同一调用里的其他改动也都不生效。当前版本的 OpenTune 只有 `fcpe` 一个模型。
- 还原配方：`prefs.set` 的结果没有撤销条目（`ui_parity`），还原配方是用原来的值再调一次 `prefs.set`。原来的声码器权重名若无法放上线路（不是合法 UTF-8、为空或超过 64 个码点），配方里省略这一项；这次调用只改了它时，配方为 null（原因仍是 `ui_parity`，结果带警告 `IRREVERSIBLE`），不会给出没有参数的 `prefs.set`。
- 与规范的关系：`processing.options`、`vocoderWeight`、`renderingPriority`、`f0Model` 以及原因码 `option_unavailable`、`vocoder_not_ready`、`vocoder_load_failed` 随规范 rc.6 登记（rc.7 去掉了 `referenceAlignMode`），仓库里的规范副本是 rc.7；与向量的差别（目前没有）记录在 `Source/Control/README.md` 的「Deviations from the vectors」。
- `audio.set` 只接受 `audio.get` 的 `available` 里列出的值，否则返回 `INVALID_ARGUMENT(audio_setting_unavailable)`。设备类型和输出设备在动手之前就按清单检查，不在清单里时什么都不改；采样率、缓冲区大小和输出声道对要等将要运行的设备打开之后才能检查，所以同一次调用里前面的步骤（换设备类型、换输出设备）可能已经改过设备：这时服务端像设置页一样先把原来的设置恢复回去，再返回这个错误。设备打不开时，服务端同样恢复原来的设置，调用以 `IO_ERROR(device_open_failed)` 失败，`executed` 为 false；原来的设置也打不开时，`executed` 为 true，且没有设备在运行（`audio.get` 会如实报告）。前面的步骤已经改过设备、后面的值又不在清单里、原来的设置也恢复不了时同样如此：返回的是 `IO_ERROR(device_open_failed)`，`executed` 为 true，而不是 `INVALID_ARGUMENT`。失败信息会说明是哪一步出了问题，以及原设置是否已恢复。
- 在 ASIO 设备上切换设备类型或输出设备之前，服务端会像设置页一样先把 ASIO 采样率恢复为系统共享渲染率。恢复失败或无法确认时切换照常进行（设置页也是如此），结果带告警 `ASIO_RATE_NOT_RESTORED`。

## 与 OpenTune MCP Server 的关系

- [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) 是一个 stdio MCP 服务，采用 MIT 许可。它连接本接口，让 Claude Code、Claude Desktop、Cursor 等 MCP 客户端操作 OpenTune。它的 npm 包是 `@synchain/opentune-mcp`（命令 `opentune-mcp`）。
- 协议 OTCP v1 的规范正本在 MCP 仓库的 `spec/otcp/v1/`（MIT 许可）。本 fork 在 `Tests/Control/spec/otcp/v1/` 保存一份逐字节相同的副本。

## 非官方测试版

上游合入之前，**非官方测试版**以预发布形式放在本 fork 的 [Releases 页面](https://github.com/synchain-oss/OpenTune/releases)：

- 提供 Windows x64 的 zip 和 macOS Apple 芯片（arm64）的 zip，tag 形如 `synchain-test/v<版本>-ctl.<n>`。macOS 包里有 `OpenTune-ctl.app`、`OpenTune-AI.command`（以开启控制接口的方式启动应用）和 `opentune-control.json`（OpenTune MCP Server 要求它放在被启动的程序旁边，所以它在包的顶层、紧挨着 `.command`）；包使用临时签名，没有经过 Apple 公证，并且不支持 Intel Mac。这个包还没在真机上测过。
- **不含任何模型权重**。需要本机已安装官方 OpenTune，由它提供模型。
- 每个测试版都注明了对应的源码（fork tag 与源码归档）和构建方法，并注明 YuFeng926/OpenTune 是唯一的官方渠道。

## 首次启动与首次引导对话框

数据目录全新时的首次启动，OpenTune 会弹出模态的首次引导对话框，让用户选择工作流程。任何模态对话框打开期间，控制接口对写操作返回 `BUSY(modal_open)`。这是上游的正常流程，不是缺陷：真实用户回答一次后就不会再出现。

`e2e-windows` 工作流每次启动都使用新的数据目录，所以它借助 MCP 契约与冒烟运行器的 `OTCP_TARGET_DATA_TEMPLATE` 选项，预置一个最小首选项文件，把「已完成首次使用」（`shared.onboardingShown`）写好，并断言该文件已复制进每次启动的数据目录且未被改写。程序是否读到它，由契约与冒烟运行中没有出现 `BUSY(modal_open)` 体现。

冒烟运行里的效果场景（验证「接口说改了什么，声音里就改了什么」）使用另一个模板（`OTCP_E2E_EFFECTS_DATA_TEMPLATE`），其中另外写入 `shared.rendering.lightPitchCorrection=0`，即在关闭混合模式的实例上运行；工作流在效果场景确实运行过（输出目录里有效果场景的报告）时，并核对至少有一个保留的数据目录含该键且为 0，没有报告时跳过这项核对并在摘要里注明。原因：真实用户默认开启混合模式，在该模式下修正量小于 75 音分的渲染块走 DSP 移调路径而不是声码器（阈值 `kPitchShiftThresholdCents`，见 `Source/Inference/ChunkRenderStrategy.h`，上游原注释：DSP 移调在 75 音分内质量优于声码器）；实测在真实人声与谐波音上这类小修正几乎听不出。这是 OpenTune 自身行为（界面同样），可在首选项里关闭混合模式。契约与其他场景仍使用默认（混合模式开启）的模板。

## 许可

- OpenTune 采用 AGPL-3.0。本 fork 及我们的全部改动同样按 AGPL-3.0 提供，唯一的例外是 `Tests/Control/spec/otcp/v1/` 中的 OTCP 规范副本，它与正本一样采用 MIT 许可。我们新增的源文件标注 `SPDX-License-Identifier: AGPL-3.0-or-later`。
- 我们**不分发任何模型权重**。其中 OpenVPI 声码器权重与 GAME 预训练权重采用 CC BY-NC-SA 4.0（禁止商用），我们从不打包、上传或转发它们。运行所需的模型来自你自己安装的官方 OpenTune。
- 测试版附带第三方许可声明，内容按二进制的实际组成生成。
- MCP 服务与协议规范在各自仓库中以 MIT 许可提供。

## 反馈与安全

- 本 fork、控制接口与测试版的问题与建议：[synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues)。
- 安全问题：请通过本仓库或 [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/security) 的私密漏洞报告（Private Vulnerability Reporting）提交，两处都由同一批维护者处理；备用联系方式为 contact@synchain.ca。请勿公开披露。另见 [SECURITY.md](../.github/SECURITY.md)。
- 在官方 OpenTune 发布版中也能复现的问题，属于 OpenTune 本身的问题，请按上游的方式反馈。

---

[Synchain](https://www.synchain.ca) · contact@synchain.ca
