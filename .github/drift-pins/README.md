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

**本目录的 `<group>.txt` 都由脚本生成，不手改**：`node .github/scripts/drift-pins.mjs --write` 按 `Source/Control/mirror-map.json` 的 `group` 为每组生成一个文件。`sha256` 与规范化方式逐字取自 `mirror-map.json`，脚本不另算一套；`anchor` 是被镜像的代码在 `pinned-at` 上的行范围。

分工如下（本目录属于 fork 专用层，可上游的 PR 不能改 `.github/**`）：

- **可上游的 PR**（移植界面逻辑的各层）只改 `mirror-map.json` 与 `Source/Control/MIRRORS.md`：改了被镜像的函数或新增镜像，就运行 `OpenTuneControlMirrorDriftTests --update`，它刷新 `mirror-map.json` 里的哈希并重新生成 `MIRRORS.md` 的表。
- **manager 的 L0 跟进**随后运行 `node .github/scripts/drift-pins.mjs --write`，把本目录重新生成成与它们一致，并提交。
- `node .github/scripts/drift-pins.mjs --check`（本地 gates 与 fork-gate 的 self-test 都会跑）只读工作区文件，检查三处一致：`mirror-map.json` 的每个条目在对应的 `<group>.txt` 里恰有一行且 `sha256`、规范化方式、`ported-to` 一致；没有多余的清单文件或条目；`MIRRORS.md` 表中的 id 与哈希集合与 `mirror-map.json` 一致（只比较集合，不改写 `MIRRORS.md`）。不一致时，输出写明改了哪里，并提示先运行 `OpenTuneControlMirrorDriftTests --update`、再运行 `--write`。`--write` 默认用当前分支包含的最新 `upstream/*` tag 作为 `pinned-at`，可用 `--pinned-at <tag>` 指定。

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
| `normalization` | 规范化方式的标识：`fn-v1`（函数）或 `stmt-v1`（声明） | `fn-v1` |
| `sha256` | 规范化文本的 sha256，64 位小写十六进制 | `3f0c…`（64 位） |

一个函数只登记一次；同一文件的多个函数各占一行。重载函数在 `symbol` 后加参数类型以区分，例如 `UndoManager::addAction(std::unique_ptr<UndoAction>)`。`stmt-v1` 条目的 `symbol` 是定位声明用的文本，例如 `static constexpr int maxSize_`。

## 规范化方式 `fn-v1`

1. 读取 `pinned-at` 对应提交里该文件的 blob（不是工作树，避免 Windows 检出时的换行符转换），按 UTF-8 解码；去掉开头的 UTF-8 BOM，把 CRLF 与单独的 CR 都换成 LF。
2. 截取函数文本：从包含 `symbol` 定义签名（限定名后紧跟 `(`）的那一行开始，到与函数体第一个 `{` 配对的 `}` 所在行为止。配对时跳过字符串字面量、字符字面量与注释里的花括号。
3. 逐行去掉首尾空白，删除空行，把行内连续的空格与制表符合并成一个空格。注释保留：只改注释也会显示为漂移，复审时可以直接确认。
4. 用 LF 连接各行（末尾不加 LF），对得到的 UTF-8 字节计算 sha256，写成小写十六进制。

规范化方式一旦使用就不再修改；需要不同规则时新增 `fn-v2` 等标识，旧条目在复审时逐条迁移。

## 规范化方式 `stmt-v1`

用于不是函数的镜像，例如常量或成员声明（`static constexpr int maxSize_`）。规则与实现以 `Tests/Control/ControlMirrorHash.h` 的 `extractStatement` 为准（`ControlMirrorDriftTests` 用的就是它），本目录的脚本照同一套规则实现：

1. 文件的读取方式与 `fn-v1` 第 1 步相同（取 `pinned-at` 里的 blob，去 BOM，换行统一为 LF）。
2. 截取声明：从第一个在注释和字符串、字符字面量之外包含 `symbol` 文本的位置所在的**那一行**开始；若 `symbol` 的首尾是标识符字符，则它前后不能紧挨着标识符字符（`maxSize_Extra` 不匹配 `maxSize_`）。结束于从该位置起第一个不在 `()`、`[]`、`{}` 内的 `;`（含该 `;`，同一行里 `;` 之后的内容不计入）。
3. 逐行规范化与哈希同 `fn-v1` 第 3、4 步：逐行去掉首尾空白，删除空行，合并行内连续空白，用 LF 连接，对 UTF-8 字节取 sha256。注释保留。

`anchor` 是声明所在的行范围。`symbol` 在文件里找不到对应的声明时，条目在检查里报「找不到函数」（`missing-symbol`）。

## 计算与检查工具

- `node .github/scripts/drift-pins.mjs --write` / `--check`：生成本目录的清单，以及检查三处一致（见上）。
- `node .github/scripts/drift-pins.mjs hash --rev <提交> --path <文件> --symbol <限定名> [--normalization stmt-v1]`：计算一个函数（默认 `fn-v1`）或声明（`stmt-v1`）的哈希与行范围。
- `node .github/scripts/drift-pins.mjs check --rev <提交>`：用该提交里的上游文件重新计算本目录所有条目，列出文本已变化、文件或函数找不到的条目。每日试 rebase（`sync-dryrun.yml`、`.github/scripts/try-rebase.mjs`）对上游最新调用同一份代码。
- 定位函数时，函数体的开头是签名后第一个不在括号内的 `{`：已知限制：构造函数的成员初始化列表里若有花括号初始化，函数体会在那里被截断；遇到这种函数先不要登记。

## 更新条目

- 移植新的界面逻辑：可上游的 PR 只更新 `mirror-map.json` 与 `MIRRORS.md`；manager 的 L0 跟进运行 `--write` 重新生成本目录。
- 上游变化导致哈希不一致：先复审并按需修改移植，再运行 `OpenTuneControlMirrorDriftTests --update` 与 `--write`（`--write` 会按最新的 `upstream/*` tag 更新 `pinned-at` 与 `anchor`），并在 PR 正文写明复审结论。不要只改哈希而不看移植。
