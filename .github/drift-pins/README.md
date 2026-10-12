<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# 镜像锁清单（drift pins）

fork 专用（L0），永不进入上游 PR。

控制接口里有一部分计算只存在于 OpenTune 的界面代码中（例如钢琴卷帘的范围提交、编排视图的左裁剪计算、编辑器里的工程流程）。接口层不改上游，而是照界面的步骤另写一份，只调用上游现成的底层函数（见根目录 `CLAUDE.md` §1「界面里才有的计算」）。这样的移植叫**镜像**。上游以后若改了被镜像的函数，我们的移植就可能与界面行为不再一致，这就是**漂移**。

本目录记录每个被镜像的上游函数在锁定基点上的规范化哈希。之后的检查会用最新的上游重新计算这些哈希，凡是变化的条目，对应的移植都必须复审：

- 每日的只读试 rebase 报告列出发生变化的条目；
- 最终 rebase 时，逐条复审变化条目对应的移植后才能继续；
- 上游侧用 `Source/Control/mirror-map.json` 与 `ControlMirrorDriftTests` 携带同一批条目（规范化方式相同），让作者那边也能自动发现漂移。三处必须一致：本目录、`mirror-map.json`、`Source/Control/MIRRORS.md`。

本目录目前只有格式说明。清单文件由之后移植界面逻辑的 PR 随移植一起添加，不预先建空文件。

## 文件

每个镜像组一个文件：`.github/drift-pins/<group>.txt`。

- `<group>` 用小写字母、数字与连字符（`[a-z0-9-]+`），按被镜像的功能命名，例如 `pianoroll-range-commit`、`arrangement-left-trim`、`editor-project-flow`。
- 文件是 UTF-8 纯文本、LF 换行。以 `#` 开头的行是注释；空行忽略。
- 文件开头是 SPDX 头和三条必填的元数据注释：

```text
# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# group: pianoroll-range-commit
# pinned-at: upstream/20261008-addb4f4
# ported-to: Source/Control/Edit/RangeCommit.cpp
```

| 元数据 | 含义 |
|---|---|
| `group` | 与文件名一致的组名 |
| `pinned-at` | 计算哈希时所用的上游基点 tag（`upstream/YYYYMMDD-<sha7>`） |
| `ported-to` | 我们的移植所在文件；有多个时写多行 `# ported-to:` |

## 条目

每个非注释行是一条锁定记录，5 个字段，以一个 TAB 分隔：

```text
<path>	<symbol>	<anchor>	<normalization>	<sha256>
```

| 字段 | 含义 | 示例 |
|---|---|---|
| `path` | 上游文件，相对仓库根目录，`/` 分隔 | `Source/Standalone/UI/PianoRollComponent.cpp` |
| `symbol` | 被镜像函数的限定名，用来在文件里定位函数定义 | `PianoRollComponent::commitRangeEdit` |
| `anchor` | 锁定时函数所在的行范围，只供人查看，计算时不使用 | `L1007-L1110` |
| `normalization` | 规范化方式的标识，目前只有 `fn-v1` | `fn-v1` |
| `sha256` | 规范化文本的 sha256，64 位小写十六进制 | `3f0c…`（64 位） |

一个函数只登记一次；同一文件的多个函数各占一行。重载函数在 `symbol` 后加参数类型以区分，例如 `UndoManager::addAction(std::unique_ptr<UndoAction>)`。

## 规范化方式 `fn-v1`

1. 读取 `pinned-at` 对应提交里该文件的 blob（不是工作树，避免 Windows 检出时的换行符转换），按 UTF-8 解码；去掉开头的 UTF-8 BOM，把 CRLF 与单独的 CR 都换成 LF。
2. 截取函数文本：从包含 `symbol` 定义签名（限定名后紧跟 `(`）的那一行开始，到与函数体第一个 `{` 配对的 `}` 所在行为止。配对时跳过字符串字面量、字符字面量与注释里的花括号。
3. 逐行去掉首尾空白，删除空行，把行内连续的空格与制表符合并成一个空格。注释保留：只改注释也会显示为漂移，复审时可以直接确认。
4. 用 LF 连接各行（末尾不加 LF），对得到的 UTF-8 字节计算 sha256，写成小写十六进制。

规范化方式一旦使用就不再修改；需要不同规则时新增 `fn-v2` 等标识，旧条目在复审时逐条迁移。

## 更新条目

- 移植新的界面逻辑：在同一个 PR 里添加或扩充对应的 `<group>.txt`，并同步 `mirror-map.json` 与 `MIRRORS.md`。
- 上游变化导致哈希不一致：先复审并按需修改移植，再在同一个 PR 里更新 `pinned-at`、`anchor` 与 `sha256`，并在 PR 正文写明复审结论。不要只改哈希而不看移植。
