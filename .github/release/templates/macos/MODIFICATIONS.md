<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Modifications in this build / 本测试版的改动

**English** | [简体中文](#简体中文)

This program is a modified version of OpenTune (<{{OFFICIAL_REPO_URL}}>), licensed under the GNU AGPL v3. It was modified by Synchain. Last modified: {{DATE}} (commit `{{COMMIT}}`, build {{BUILD_LABEL}}).

This is not an official OpenTune release; see README-UNOFFICIAL.txt.

## Base

The unmodified upstream snapshot is `{{UPSTREAM_BASE_TAG}}`, commit `{{UPSTREAM_BASE_COMMIT}}` of the official repository. The complete source of this build is at <{{SOURCE_URL}}>.

## What changed

1. **A local control API for OpenTune Standalone** (protocol OTCP v1), added as new code: `Source/Control/`, `Source/Standalone/ControlEditorBridge*`, `cmake/OpenTuneControl.cmake`, with tests in `Tests/Control/`. It is compiled in only with the CMake option `OPENTUNE_ENABLE_CONTROL_API=ON` (this build) and turned on at run time only by the command-line switch `--control-api` or `OPENTUNE_CONTROL_API=1`. It listens on `127.0.0.1` only.
2. **Small integration hooks in existing OpenTune files**, each marked with the comment `OpenTune Control API hook`. While the control API is off, OpenTune behaves as the upstream snapshot, apart from item 5.
3. **Build**: Release configuration of the Standalone for macOS (Apple silicon, arm64), control API option on. The VST3 and Audio Unit plug-ins are not part of this build.
4. **Packaging**: this zip is not the official installer. It contains no model weights and no user guide. The application bundle is renamed `OpenTune-ctl.app` (display name `OpenTune-ctl`, bundle identifier `ca.synchain.opentune.ctltest`) so that it never replaces the official `OpenTune.app`, and it is signed ad hoc (not notarized). It adds `OpenTune-AI.command`, `opentune-control.json` (next to it, not inside the app) and these documents.
5. **One fix taken from upstream, applied unchanged**: reopening a saved project keeps the corrected pitch line (the correction segments and their four parameters: retune speed, pitch drift scale, vibrato depth and vibrato rate). In the upstream snapshot this build is based on, a reopened project loses them and shows only the red original line. This is upstream commit `0afb6c8`; it changes `Source/PluginProcessor.cpp`, `Source/Utils/PitchCurve.cpp`, `Source/Utils/PitchCurve.h` and `Source/Utils/ProjectSession.cpp`, and applies whether or not the control API is on. It is dropped once this build is rebased onto an upstream version that has it.

### Existing OpenTune files changed

{{MODIFIED_UPSTREAM_FILES}}

### Existing OpenTune files deleted

{{DELETED_UPSTREAM_FILES}}

### Files added

{{ADDED_PATHS}}

The fork repository also carries {{FORK_ONLY_COUNT}} files of its own (continuous integration, packaging scripts, contributor rules under `.github/`, `CLAUDE.md` and the control API user documentation). They are not part of the program.

## 简体中文

本程序是 OpenTune（<{{OFFICIAL_REPO_URL}}>，GNU AGPL v3 许可）的修改版，由 Synchain 修改。最后修改日期：{{DATE}}（提交 `{{COMMIT}}`，构建 {{BUILD_LABEL}}）。

这不是 OpenTune 官方版本，见 README-UNOFFICIAL.zh-CN.txt。

### 基点

未修改的上游快照是官方仓库的 `{{UPSTREAM_BASE_TAG}}`（提交 `{{UPSTREAM_BASE_COMMIT}}`）。本测试版的完整源代码在 <{{SOURCE_URL}}>。

### 改动内容

1. **为 OpenTune Standalone 加入本机控制接口**（协议 OTCP v1），全部为新增代码：`Source/Control/`、`Source/Standalone/ControlEditorBridge*`、`cmake/OpenTuneControl.cmake`，测试在 `Tests/Control/`。只有用 CMake 选项 `OPENTUNE_ENABLE_CONTROL_API=ON` 构建（本测试版即是）才编译进来，并且只有在运行时传入命令行参数 `--control-api` 或设置 `OPENTUNE_CONTROL_API=1` 才开启。只监听 `127.0.0.1`。
2. **在 OpenTune 已有文件中加入少量接入钩子**，每处都带注释 `OpenTune Control API hook`。控制接口关闭时，OpenTune 的行为与上游快照相同（第 5 条的修复除外）。
3. **构建**：Standalone 的 macOS（Apple 芯片，arm64）Release 配置，控制接口选项打开。本测试版不含 VST3 与 Audio Unit 插件。
4. **打包**：本压缩包不是官方安装包。它不含任何模型权重与用户指南。应用包改名为 `OpenTune-ctl.app`（显示名 `OpenTune-ctl`，Bundle 标识 `ca.synchain.opentune.ctltest`），所以不会覆盖官方的 `OpenTune.app`；使用临时签名（ad hoc），未经公证。另外加入了 `OpenTune-AI.command`、`opentune-control.json`（在它旁边，不在应用包里）与这些说明文件。
5. **从上游挑入的一处修复（原样应用）**：重新打开已保存的工程时保留修正后的音高线（修正段及其 4 个参数：重调速度、音高漂移比例、颤音深度与颤音速率）。本构建所基于的上游快照里，重开的工程会丢失这些内容，只剩红色的原始音高线。对应上游提交 `0afb6c8`，改动 `Source/PluginProcessor.cpp`、`Source/Utils/PitchCurve.cpp`、`Source/Utils/PitchCurve.h` 与 `Source/Utils/ProjectSession.cpp`，无论控制接口是否开启都生效。本构建 rebase 到已含该修复的上游版本后，这一条随之去掉。

修改、删除与新增的文件清单见上方英文部分（文件路径与语言无关）。fork 仓库另有 {{FORK_ONLY_COUNT}} 个自身的文件（`.github/` 下的持续集成、打包脚本与协作规则，`CLAUDE.md`，以及控制接口的用户文档），它们不属于程序本身。
