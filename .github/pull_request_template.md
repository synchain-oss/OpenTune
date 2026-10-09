<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later

synchain-oss/OpenTune（fork）PR 模板。子 PR 的 base 必须是 feature/control-api（或其他 feature/*）。
标题与正文用中文；正文与提交信息不得含任何 AI 署名行（规则见 .github/scripts/attribution-patterns.txt）。
规则全文见根目录 CLAUDE.md。
文中的 gates 脚本、check-ignored-delta.ps1、attribution-patterns.txt 与 CI 检查随后续 PR 加入；加入之前对应项按人工检查勾选，并在汇总表里写明 SKIP 原因。
-->

## 这个 PR 做了什么

<!-- 一段话。关联 issue（问题统一在 MCP 仓库跟踪）：synchain-oss/opentune-mcp-server#___ -->

## 为什么

<!-- 动机与取舍；涉及规范时写明对应的规范章节 -->

## 层（单选；一张卡只属于一个层）

- [ ] L0 fork 专用（`.github/**`、治理文件、fork 脚本、`Tests/ControlFork/**`、`Source/Control/.clang-format`、`docs/control-api*.md`），永不进上游
- [ ] L2 读取与通道
- [ ] L3 job、导入、导出、界面桥
- [ ] L4 音符编辑与撤销
- [ ] L5 时间网格
- [ ] L6 编排、轨道、走带、选择、参考对齐
- [ ] L7 高级曲线、EQ、包络、音符拓扑（波次 C，暂不接受）
- [ ] L8 工程、首选项、音频设备、应用

<!-- 不单独设 L1：接入钩子随第一个需要它的层提交。 -->

## 变更类型

- [ ] feat - [ ] fix - [ ] test - [ ] docs - [ ] refactor - [ ] ci - [ ] chore - [ ] harden

## 触碰的上游已有文件

<!-- 没有就写「无」。有则逐行列出：文件 → 钩子（见 CLAUDE.md §1 表）→ 新增/修改行数 -->

## 本地 gates（`pwsh scripts/gates.ps1`，逐项勾选并贴汇总表）

- [ ] LFS 设置检查通过（`lfs.fetchexclude=*`，模型为未 smudge 的指针）
- [ ] configure + build（RelWithDebInfo，经 `with-build-slot.ps1`）成功
- [ ] `ctest -R Control` 全绿
- [ ] 上游已有测试全绿（`-E ARALifecycleContractTests`，原因见 CLAUDE.md §8）
- [ ] 所有测试使用临时 `OPENTUNE_DATA_DIR`，没有写真实用户目录
- [ ] 改到 Dispatcher / Jobs / Ops / Edit / bridge 或 `spec.lock`：已跑真 Standalone 契约与场景（真 Standalone 测试环境就绪后必填；不涉及请写「不涉及」）
- [ ] 新文件 clang-format 18.1.8 无差异，且都有 SPDX 头
- [ ] 署名与身份检查通过
- [ ] `check-ignored-delta.ps1` 通过（被忽略路径中的新增都是显式 `git add -f -- <精确路径>`）

```text
（在此粘贴 gates 输出的 PASS/FAIL/SKIP 汇总表，含 SHA）
```

## 上游安全自查（逐项勾选；确实不适用的写明原因）

- [ ] 未改变 OpenTune 现有行为：接口关闭时（CMake 选项 OFF，或选项为 ON 但运行时未开启），行为与上游一致
- [ ] 对上游已有文件的改动只限 CLAUDE.md §1 表中声明的钩子，每处都有 `// OpenTune Control API hook:` 标记
- [ ] 没有格式化或重排任何上游文件（没有顺手改空白、缩进、include 顺序、换行符、BOM）
- [ ] 未修改 `PianoRollComponent` / `PianoRollToolHandler`
- [ ] 没有修上游 bug；发现的上游行为已写在下方「上游行为发现」
- [ ] 镜像了上游函数的移植，已同步镜像锁清单（`.github/drift-pins/`）、`MIRRORS.md`、`mirror-map.json`（不涉及请写「不涉及」）
- [ ] 内容修改只在消息线程进行（经 dispatcher 唯一入口）；网络线程不持 lease；实时路径无锁
- [ ] 遵守上游代码约定（C++17、`#pragma once`、成员 `camelCase_`、4 空格、括号风格与所在文件一致、`Result<T>/Error`、只用 AppLogger、测试为 `main()` + `add_test`）
- [ ] 规范副本之外，可上游路径中没有 Synchain / DLsnows / opentune-mcp 字样；L0 卡未触碰可上游路径
- [ ] 未修改规范副本 `Tests/Control/spec/otcp/v1/` 与 `.github/spec.lock`（只有 manager 的 `spec-sync/*` 可以改）
- [ ] 没有提交模型或二进制：无 `*.onnx`、`models/**`、`pc_nsf_hifigan*/**`、`ThirdParty/**`、D3D12 文件；LFS 指针未改动
- [ ] 未修改上游 `.gitignore`
- [ ] token / serverProof 不出现在日志、结果、诊断或测试快照中

## 规范与 MCP 侧影响

- [ ] 不涉及
- [ ] 需要规范变更（列在下面，交 manager 走 `spec-sync/*`）
- [ ] 需要 MCP 仓库同步改动（列在下面）

## 上游行为发现

<!-- 本卡确认的上游行为或缺陷（只记录、不修），没有就写「无」 -->

## 测试说明

<!-- 新增或修改了哪些测试；如何手动验证 -->

## DCO 与署名

- [ ] 所有提交都以 `DLsnows <noreply@synchain.ca>` 身份完成，并用了 `git commit -s`（`Signed-off-by` 是同一身份）
- [ ] 提交信息与本 PR 标题、正文都没有任何 AI 署名行
