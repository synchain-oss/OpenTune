<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# CLAUDE.md —— synchain-oss/OpenTune（fork）协作规范

> 本文件是 AI 编码代理与贡献者在本 fork 内的常驻法条。它只存在于 fork（`dev` 及其派生分支），**永不进入上游 PR**。上游 `.gitignore` 忽略 `CLAUDE.md`，本文件以 `git add -f -- CLAUDE.md` 入库。与维护者书面指令冲突时以维护者为准。
>
> 文中提到的脚本与检查（`scripts/gates.ps1`、`check-ignored-delta.ps1`、`.github/scripts/attribution-patterns.txt`、fork-gate、branch-gate、`sync-dryrun.yml` 等）随后续 PR 陆续加入，路径以合入后为准；加入之前以本机护栏与人工检查代替。

## 0. 基本约定

- **本 fork 是什么**：Synchain 维护的 OpenTune 非官方 fork，唯一目的是为 OpenTune Standalone 开发本机控制接口（OTCP v1，只监听 `127.0.0.1`），跑通后贡献回上游。OpenTune 是 DAYA STUDIO 的项目（作者 风语，GitHub `YuFeng926`），许可 AGPL-3.0；官方仓库与唯一官方发布渠道是 <https://github.com/YuFeng926/OpenTune>。
- **配套仓库**：OpenTune MCP Server (by Synchain) 在 [`synchain-oss/opentune-mcp-server`](https://github.com/synchain-oss/opentune-mcp-server)（MIT）。OTCP 规范正本在该仓 `spec/otcp/v1/`；本仓 `Tests/Control/spec/otcp/v1/` 是逐字节副本，`.github/spec.lock` 记录其来源与 sha256。
- **语言**：本文件、PR 标题与描述、评论与回复用中文；外部贡献者用什么语言就用什么语言回复。新增 C++ 注释用英文。`Source/Control/README.md` 与 `Source/Control/REVIEW-CHECKLIST.md` 中英双语。面向用户的 `docs/control-api.md` 为中文，`docs/control-api.en.md` 为英文；fork 首页说明 `.github/README.md` 与 `.github/SECURITY.md` 中英双语。
- **上游作者**：不主动联系；不对 `YuFeng926/OpenTune` 做任何写操作（issue、PR、评论、反应）。确需作者决策时由 manager 起草中英消息，维护者转达。上游 PR 只由 manager 按审批包提交。
- **对外联络**：只用 `contact@synchain.ca`；网站 <https://www.synchain.ca>。
- **内部规划编号不进公开文本**：代码注释、文档、提交信息与 PR 正文里把理由本身写出来，不要只留读者打不开的编号（卡号、计划章节号）；分支名里的任务 ID 不受此限。

### §0 安全铁律

1. 任何 key/token 绝不明文入库，包括测试用的假 key。
2. workflow 里引用 secret 只能用 `${{ secrets.X }}`；禁止 echo 到日志、禁止写进 artifact。
3. 第三方 action 必须 pin 到 40 位 commit SHA（注释写版本号），可变 ref 一律不接受。二进制工具（gitleaks、sccache 等）用脚本下载，并锁定版本与 sha256。
4. 任何 workflow 一律不得使用 pull_request_target。外部 fork 发来的 PR 只跑无 secrets 的检查，AI review 不自动运行。
5. 所有消费仓库外部文本的自动化（review bot 等），prompt 末尾必须带「不可信数据声明」。
6. 控制接口只绑字面量 `127.0.0.1`。会话 token 与 serverProof 只能来自系统 CSPRNG（禁止用 `juce::Random` / `juce::Uuid` 产生密钥），比较必须是常量时间。它们永不出现在日志、结果、诊断、进度信息或测试快照里。

## 1. 第一原则：不改变 OpenTune 的行为

- **只做两类改动**：① 新增接口代码；② 下表声明过的最小接入钩子。以下两种情况下，OpenTune 的行为必须与上游完全相同：CMake 选项 `OPENTUNE_ENABLE_CONTROL_API` 为 OFF；或选项为 ON、但运行时未开启接口。
- **新增代码的位置**（`namespace OpenTune`，PascalCase 文件名）：`Source/Control/**`、`Source/Standalone/ControlEditorBridge*`、`Tests/Control/**`、`cmake/OpenTuneControl.cmake`。fork 专用测试放 `Tests/ControlFork/**`。
- **已声明的钩子**：这是对上游已有文件的全部改动。每处钩子都要加标记 `// OpenTune Control API hook: <purpose>, see Source/Control/README.md#hooks`。

| 钩子 | 文件 | 约行数 |
|---|---|---|
| ControlService 成员；构造末尾受保护的 callAsync 启动；析构**第一句** `stop()`；getter（Standalone 宏 + 选项宏） | `Source/PluginProcessor.h/.cpp` | 20–25 |
| 公开 `ensureRuntimeInitialized()` | `Source/PluginProcessor.h/.cpp` | 6–8 |
| `OPENTUNE_DATA_DIR` 重定向 | `Source/Utils/AppPreferences.cpp`（+ `AppLogger.cpp`） | 5（+3） |
| `contentEpoch` + getter | `Source/Content/StandaloneContentRepository.h/.cpp` | 4–6 |
| `friend class ControlEditorBridge;` + 成员；构造后创建，析构时先注销 | `Source/Standalone/PluginEditor.h/.cpp` | ~6 |
| 导出锁（UI 与 API 共用）、master 导出错误信息、按 placementId 导出 clip | `Source/PluginProcessor.*`、`Source/Standalone/PluginEditor.cpp` | 15–25 |
| 抽出 `afterUndoRedo()`（纯重构）+ bridge 调用 | `Source/Standalone/PluginEditor.cpp` | 5–8 |
| `peekUndo` / `peekRedo` / `size` / `cursor` | `Source/Utils/UndoManager.h/.cpp` | ~8 |
| 公开 `dismiss()`，包装私有 `finish()`（只关闭已显示的首次引导） | `Source/Editor/OnboardingOverlayComponent.*` | ~3 |
| （可选）公开包装私有选择提交 | `Source/Standalone/UI/ArrangementViewComponent.*` | ~8 |
| 参考特征生产者 getter；记录每个内容最近一次 F0 失败原因 | `Source/PluginProcessor.*` | ~4 / ~8 |
| `option()` + `include(cmake/OpenTuneControl.cmake)` | `CMakeLists.txt` | 2–5 |

- **表外的上游文件一律不改。** 确需新钩子时先停下，在 PR 或返回结果的问题列表里提出。由 manager 更新本表与 `Source/Control/README.md` 的钩子清单后再做。
- `PianoRollComponent` / `PianoRollToolHandler` 零改动。遵守上游 `docs/code-architecture-review.md` 的约束：`PluginProcessor` 不再承担新的数据模型或通用 Router 职责。因此 processor 只增加以下内容：服务成员、启停与 getter、`ensureRuntimeInitialized`、导出锁、两个只读 getter。`ProjectSession` 留在编辑器内，经 `ControlUiBridge` 暴露窄接口。
- **不修上游 bug。** 接口如实报告（告警与原因码，结果里标明不可撤销等），并在 PR 的「上游行为发现」里记录。是否给作者提 issue 由 manager 决定；任何对外内容都先给维护者过目。
- **界面里才有的计算**：在接口层照 UI 的步骤另写一份，只调用上游现成的底层函数。有意镜像的上游函数要登记到镜像锁清单 `.github/drift-pins/<group>.txt`，并同步 `Source/Control/MIRRORS.md` 与 `Source/Control/mirror-map.json`（`ControlMirrorDriftTests` 比对规范化哈希）。
- **范围**：只做波次 A（修音主流程）与波次 B（编排与工程）。波次 C 推迟，包括画、拉伸、切分、合并音符，单音符 EQ，包络，手绘曲线，锚点，橡皮擦，以及插入/删除时间手柄。不做界面里没有的「接口扩展」，也不做纯外观/视图设置。上游本来就没有的功能，统一返回 `UNSUPPORTED`。
- `.gitignore` 与其他上游文件保持原样。不在任何产出里改写、摘录或另行打包上游的说明与声明类文件（测试版只按白名单打包）。

## 2. 上游代码约定（从上游现有代码归纳，新代码照此写）

- C++17；头文件用 `#pragma once`；`namespace OpenTune`；类名与文件名 PascalCase；成员变量 `camelCase_`；4 空格缩进；括号风格与所在文件一致。
- 错误用 `Source/Utils/Error.h` 的 `Result<T>` / `Error`，只在 `ControlDispatcher` 里映射为 OTCP 错误 kind。
- 日志只用 `AppLogger`，不得记录 token、serverProof 或完整请求体。
- 实时（音频）路径上不加锁、不分配内存、不做 I/O。
- 内容修改只在消息线程进行，唯一入口是 `ControlDispatcher::runOnMessageThread`。网络线程等待主线程时，绝不持有 `CompletionCallbackLease`。关闭合同见 `Source/Control/README.md`。
- 测试：每个文件一个 `main()`，用 CMake `add_test` 注册，不用 gtest / Catch2。生命周期测试沿用上游 `Tests/LifecycleWatchdog.h`。超时不够时用命名常量。
- 新文件首行写 SPDX：`// SPDX-License-Identifier: AGPL-3.0-or-later`（规范副本目录除外）。
- `Source/Control/**`、`Tests/Control/**`、`ControlEditorBridge*` 的新文件用 clang-format 18.1.8 格式化（fork 专用配置）。
- **绝不格式化上游文件。** 只写需要的那几行。不改上游文件的缩进、空白、include 顺序、换行符或编码；部分上游文件带 UTF-8 BOM，必须保留。fork-gate 会检查上游文件新增行的空白。
- `Source/Control/**` 里每个公开类与函数都要有英文 doc 注释，写明职责、线程要求和错误语义。调用上游函数的地方，注明调用的是哪个函数、为什么调用。
- 规范副本之外，可上游路径中不得出现 `Synchain`、`DLsnows`、`opentune-mcp` 等字样（上游 PR 审查 job 会拒绝）。这些字样只能出现在 L0 路径里。

## 3. 层与可上游路径

- 每张卡只属于一个层，在 PR 模板中标明：
  - **L0** fork 专用，永不进上游：`.github/**`、本文件等治理文件、fork 脚本、`Tests/ControlFork/**`、`Source/Control/.clang-format`、`docs/control-api*.md`。
  - 波次 A：**L2** 读取与通道 · **L3** job、导入、导出、界面桥 · **L4** 音符编辑与撤销 · **L5** 时间网格。
  - 波次 B：**L6** 编排、轨道、走带、选择、参考对齐 · **L8** 工程、首选项、音频设备、应用。
  - **L7** 高级曲线、EQ、包络、音符拓扑：属于波次 C，推迟。
  - 不单独设 L1：接入钩子随第一个需要它的层提交。
- **可上游路径白名单**：`Source/Control/**`、`Source/Standalone/ControlEditorBridge*`、`Tests/Control/**`、`cmake/OpenTuneControl.cmake`、`CMakeLists.txt`、§1 表中的钩子文件，以及 `BUILDING*.md` 里的几行。上游 PR 由 manager 从 rebase 后的 `dev` 按白名单差分重新构建；L0 路径永不离开 fork。
- L0 卡不得触碰可上游路径。`feat/F*` 分支不得修改规范副本与 `.github/spec.lock`，只有 manager 的 `spec-sync/*` PR 可以改。

## 4. 分支与 tag

| 分支 / tag | 用途 | 谁能写 |
|---|---|---|
| `upstream-mirror` | 锁定的上游基点（建 fork 时上游 `standalone` 的 HEAD），原样副本 | 只在最终 rebase 之后，由 manager 按审批包更新 |
| `dev`（默认分支） | fork 集成分支 = 上游基点 + 我们的新增 | 只经 PR 合入；由 manager 按审批包合并；禁止删除 |
| `feature/control-api` | 主支线，所有子 PR 的 base | manager 经 merge-train 合并 |
| `feat/F<ID>-<slug>` | 子支线：一卡一条、一个 PR | 该卡的 lane |
| `spec-sync/*` | 更新规范副本与 `.github/spec.lock` | 只有 manager |
| `sync/*` | 最终 rebase 的候选分支 | 只有 manager |
| `upstream-pr/<n>`、`review-base/<n>` | 上游 PR 在 fork 内的审查 PR（do-not-merge） | 只有 manager |
| tag `upstream/YYYYMMDD-<sha7>` | 上游基点快照 | 只增不改 |
| tag `synchain-test/v<版本>-ctl.<n>` | 非官方测试版 | 按审批包；tag 名绝不用 `v*` 或 `OpenTune*` |

- 提交规范：`type(scope): 描述`，type ∈ {feat, fix, test, docs, refactor, ci, chore, perf, revert, harden}；所有提交都用 `git commit -s`。
- 上游 PR 的精选提交另用英文 conventional commits：主题只用 ASCII，不带卡号，也不带 `(#NN)`。

## 5. 锁定的上游基点与最终 rebase

- **当前基点**：分支 `upstream-mirror` 的顶端，在本 fork 中打了 tag `upstream/YYYYMMDD-<sha7>`（见 §4）；它是 `YuFeng926/OpenTune` `standalone` 分支上的一个提交。波次 A、B 都基于它。
- **开发期间**：`upstream-mirror` 不更新；`dev` 与主支线永不强推；不把上游的新提交 merge 或 rebase 进任何分支。
- **「我们的增量」** = `git rev-list --no-merges <head> --not --tags='upstream/*' origin/upstream-mirror`，所有门禁只看这部分。找不到 `upstream/*` tag、或增量超过 150 个提交，即判失败（提示「未基于已标记的上游快照，请 rebase 到 dev」）。
- `sync-dryrun.yml` 每天做一次只读的试 rebase，目标是上游最新。它报告冲突文件数、冲突块数与镜像漂移清单，用来预估最终 rebase 的成本，永不推送。
- **最终 rebase** 在波次 B 门禁之后、上游 PR 之前进行，只由 manager 执行。步骤如下：
  1. 在临时克隆中（固定身份 + rerere）把 `dev` 与主支线 rebase 到上游最新；
  2. 复审镜像漂移涉及的移植；
  3. 推 `sync/*` 候选分支，跑全套门禁；
  4. 出同步报告（range-diff、冲突、CI 结果）并列入审批包；
  5. 批准后由 manager 执行原子 `git push --force-with-lease`（强制确认）。
- 子 agent 不 rebase 到上游、不强推、不删分支、不推 tag。

## 6. 流程与权限

- 一卡一 PR，base 必须是 `feature/control-api`（或其他 `feature/*`）。子 agent 只能通过维护者工作区提供的开 PR 脚本开 PR。子 agent 不得合并 PR、发布 release，也不得修改仓库设置、保护规则、环境或 secret。
- 以下事项只由 manager 执行：
  - 合并：用 merge-train 试合并 → 跑 gates → `gh pr merge --squash --match-head-commit <sha>`，标题与正文显式给出；
  - 打 tag；
  - `spec-sync/*`；
  - 最终 rebase；
  - 上游 PR；
  - 测试版发布。
- **不可逆操作只按维护者批准的审批包执行**：推 `dev` 或主支线、任何强推或删除、推 `upstream/*` 或 `synchain-test/*` tag、发布预发布。脚本只打印最终命令，绝不自己执行。
- **暂存只用显式路径**：`git add -- <路径>`。被上游 `.gitignore` 忽略的新文件用 `git add -f -- <精确路径>`。不用 `git add -A` / `git add .`。暂存后运行 `check-ignored-delta.ps1`。
- **不得绕过本机或 CI 的检查**。以下做法一律禁止：
  - 提交或推送时用参数跳过 git 钩子；
  - 改写钩子目录配置；
  - 设置 `GIT_CONFIG_*` 环境变量；
  - 定义 git/gh 别名；
  - 使用 `iex` / `Invoke-Expression` 或 `-EncodedCommand`。

  被护栏拒绝时，阅读原因并按规则改正。确需例外，由 manager 向维护者申请。

## 7. 被上游 `.gitignore` 忽略的路径

- 不修改 `.gitignore`。上游的忽略模式不锚定（如 `.*/`、`docs/`、`tools/`、`specs/`、`research/`、`spike/`、`Logs/`、`knowledge/`、`Python/`、`openspec/`、`build-*/`、`CLAUDE.md`、`AGENTS.md`），我们的新目录要避开这些名字。
- 本 fork 需要 force-add 的文件有：`.github/` 下的每个新文件、根目录 `CLAUDE.md`、`docs/control-api.md`、`docs/control-api.en.md`。每个都用 `git add -f -- <精确路径>` 暂存。
- 每次暂存后运行 `check-ignored-delta.ps1`：确认 force-add 的路径都在允许清单内，并且没有误加被忽略的构建产物、依赖或模型。

## 8. 本地 gates（开 PR 前必跑）

> 以下脚本随后续 PR 加入，路径以合入后为准。

- 一键运行 `pwsh scripts/gates.ps1`（在 lane 内）。它输出带 SHA 的 PASS/FAIL/SKIP 汇总表，原样贴进 PR。依次执行：
  1. LFS 设置检查：`lfs.fetchexclude=*`，模型文件仍是未 smudge 的指针。
  2. configure / build / ctest / 真机启动，全部经 `with-build-slot.ps1`：全机一个构建槽，命名互斥锁，空闲内存检查，显式 `--parallel 8`。
  3. `ctest -R Control`，再加上游已有测试，用 `-E ARALifecycleContractTests` 排除一项。该测试依赖 ARA_DRAFT 的 `persistentID`，在锁定的 ARA SDK 2.3.0 下编不过，属于上游问题。
  4. 所有测试都使用临时 `OPENTUNE_DATA_DIR`，因为上游 ctest 会写真实的 `%APPDATA%\OpenTune`。
  5. 真 Standalone 测试环境就绪后：改到 Dispatcher / Jobs / Ops / Edit / bridge 或 `spec.lock` 的 PR，还要跑真 Standalone 的契约与场景测试。这一步持 E2E 互斥锁，并先快照、再恢复 `OpenTune.settings` 与 AppPreferences。
  6. 署名与身份检查。
  7. `check-ignored-delta.ps1`。
- **构建**：JUCE 9.0.3（8.0.15 为已验证的备选），Ninja Multi-Config。lane、gates 与 CI 测试一律用 RelWithDebInfo。Release（LTCG）只用于出包与 E2E，不在 Release 下构建测试。依赖由 `bootstrap-deps.ps1` 按 `deps.lock.json` 拉取并逐个校验 sha256，绝不下载模型。
- **CI 分档**：子 PR（base=`feature/**`）只跑轻量门禁，即 fork-gate；改到原生代码时才跑 build-windows。所以本地 gates 是第一道编译门，不要指望 CI 替你发现编译错误。PR→`dev` 跑完整套件。

## 9. Review 规则

- 所有 PR 都跑 Claude review（`claude-review.yml`）。控制接口相关改动以 `Source/Control/REVIEW-CHECKLIST.md` 为权威清单。C++ 专项检查：主线程编组、生命周期与 CompletionGate、socket 安全、CSPRNG、关闭合同、等待时不持 lease、与所在文件风格一致、不顺手重排格式。
- **处理完所有评论**，包括 bot 与人工、所有 SHA 上的评论、总结条目与 review 正文：
  - manager 逐条裁决，分级为【红旗】/【重要】/【建议】；
  - 每个线程在最后一条 bot 评论之后，都要有 org 身份的处置回复并标记 Resolve；
  - 未解决的线程会挡住合并。
- 修复只改被接受的条目，跑 gates 后只推一次，不夹带无关改动。
- 首轮之后最多再审 2 轮，最后一轮只有【红旗】阻塞。超出轮数仍有【红旗】的，交维护者决定。
- **合并前置条件**（全部满足才能合并）：
  - head SHA 上的 review 成功并发出总结（跳过、取消、失败、额度耗尽都不算）；
  - 未解决线程为 0；
  - 没有未处理的【红旗】；
  - 不在线程里的评论都已登记处置；
  - 该 SHA 的检查全绿。

  只有维护者能豁免 review。

## 10. 身份、DCO 与署名

- 本地提交身份一律是 `DLsnows <noreply@synchain.ca>`，用 `git commit -s`（DCO，`Signed-off-by` 必须是同一身份）。不改 `user.name` / `user.email`，也不在命令行临时覆盖身份。
- 唯一的例外是 GitHub 网页合并产生的提交：作者为 `140901583+DLsnows@users.noreply.github.com`，提交者为 GitHub 自身账号。
- **零 AI 署名**：以下位置一律不得出现 AI 工具署名，包括合著者尾注、会话尾注、「由某 AI 工具生成」字样（含机器人表情前缀）及其产品链接、AI 厂商的 noreply 邮箱：
  - 提交信息、tag 信息；
  - PR 标题与正文、评论与回复、review；
  - issue、release 说明。

  机器规则以 `.github/scripts/attribution-patterns.txt` 为准，它与维护者的正本逐字节一致。commit-msg / pre-push 钩子、branch-gate 与 fork-gate 都会检查。
- 不在任何文件、提交、PR、日志或测试快照中写个人路径或个人邮箱。

## 11. 模型权重与 Git LFS

- 上游用 LFS 跟踪 `models/fcpe.onnx` 与 `models/GAME/*.onnx`；声码器 `pc_nsf_hifigan_*` 不在仓库内。
- **`models/` 永不提交、永不分发。** 我们的增量不得新增、修改或删除以下任何内容（fork-gate 路径守卫会拒绝）：`models/**`、任何 `*.onnx`、`pc_nsf_hifigan*/**`、`ThirdParty/**`、D3D12 运行库。LFS 指针文件保持原样，不要去「修复」它们。
- 构建产物里由 POST_BUILD 生成的 `models\`（LFS 指针 + 0 字节声码器占位）会遮住官方安装的模型。要用官方模型运行我们构建的 exe，或者打包测试版，都必须先删除它，并断言它已不存在。
- 测试版 zip 不含任何模型权重：按白名单打包，出现 `*.onnx` 或 `models/` 即失败。模型由用户已安装的官方 OpenTune 提供。许可方面：OpenVPI 声码器权重与 GAME 预训练权重为 CC BY-NC-SA 4.0，FCPE 为 MIT。使用非商用权重的 E2E 仅限非商业测试。
- **LFS 一律跳过 smudge**：
  - 克隆前设置 `GIT_LFS_SKIP_SMUDGE=1`；
  - 克隆后执行 `git config lfs.fetchexclude "*"` 与 `git config core.longpaths true`；
  - 不运行 `git lfs pull` / `git lfs fetch`；
  - CI checkout 一律 `lfs: false`，workflow 里出现 `lfs: true` 即 fork-gate 失败；
  - 如果 `git status` 显示模型文件有改动，不要暂存，先还原。

## 12. 开启控制接口（计划，实现中）

- **编译期**：CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`，上游默认 OFF。所有接入代码都在该选项与 Standalone 宏之内。
- **运行期**：默认关闭。设置 `OPENTUNE_CONTROL_API=1` 或传命令行参数 `--control-api` 才开启。只有开启后才读取 `--control-api-dir=`、`--control-api-ready-file=`、`--control-api-launch-nonce=`。
- **监听与发现**：只监听 `127.0.0.1` 上由系统分配的端口。发现文件写在 `%LOCALAPPDATA%\OpenTune\control\instances\<pid>.json`，正常退出时删除。
- **测试隔离**：`OPENTUNE_DATA_DIR` 把首选项、日志与发现目录重定向到临时目录。
- 面向用户的说明见 `docs/control-api.md` / `docs/control-api.en.md`。面向上游作者及其 AI agent 的开发者文档见 `Source/Control/README.md`。
