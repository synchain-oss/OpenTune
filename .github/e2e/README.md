<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# e2e-windows

Fork-only (L0), never part of an upstream PR. / fork 专用（L0），永不进入上游 PR。

**English.** `.github/workflows/e2e-windows.yml` runs the real OpenTune Standalone (our build, control API ON) against the MCP repository's contract vectors and smoke scenario on a Windows runner. It is **never a required check**; it runs when a PR carries the label `e2e-windows` (on labeling and on every push while the label stays) and on `workflow_dispatch` (usable once the file is on the default branch; before that `gh workflow run` returns 404). A new run for the same PR cancels the older one. **Run it by hand before cutting a preview** and look at the latest run: all of contract and smoke must be PASS, the model-directory check must be PASS, and SKIP / FLAKY-SKIP counts are listed separately in the job summary.

- Our build comes from `build-windows.yml` in release-package mode; the `models\` folder that the POST_BUILD step creates is deleted, and the job asserts again that neither `models\` nor any `*.onnx` is in the build.
- The official installer is pinned in `official-install.json` (version, URL, sha256, size, silent arguments) and is installed silently **on the runner only**, never on a developer machine. The models land in `%ProgramData%\OpenTune\Models`; the job checks the sha256 of fcpe and the GAME files against the pin.
- OpenTune starts with a temporary `OPENTUNE_DATA_DIR`. After the run, the log must show the F0 model loaded from the official models folder; the log is scrubbed (tokens, serverProof, user names) before it is uploaded, and the backend (CPU or DirectML) is recorded.
- Inputs: `mcp-ref` (default `feature/v1`), `contract-script` (default `test:contract`), `smoke-script` (default `e2e:exe`). Label-triggered runs have no inputs and use these defaults. Contract: `npm run test:contract -- -t "against the exe"`. Both scripts read `OTCP_TARGET_EXE`; the smoke script writes `{"result","counts":{"PASS","FAIL","SKIP","FLAKY-SKIP"},"steps":[{"name","result","ms","note"}]}` to the absolute path in `OTCP_E2E_REPORT` (top-level `counts` win). A report with zero tests or steps counts as FAIL. Every uploaded file is scrubbed (tokens, serverProof, user names).
- Updating the pin: take the version, URL and sha256 from the official release page, re-derive the model hashes, then run the workflow.
- `olderInstallers` in the same file lists older official releases (same fields as `installer`) that only the side-car smoke test of `prerelease.yml` installs: the minimum official version the test build supports (`minOfficialVersion` in `.github/release/release.json`). `e2e-windows.mjs check-installer --version <x.y.z>` checks one of them; their models are checked against the same `models` list. An entry may set its own `modelsDir`, where `{app}` is the install folder (official 1.7.9 installs the models into `{app}\models`, 1.8.1 into the shared folder); `e2e-windows.mjs models-dir --pin <file> --version <x.y.z> --app <install folder>` prints the expanded path.

**中文。** `.github/workflows/e2e-windows.yml` 在 Windows runner 上用真实的 OpenTune Standalone（我们的构建，控制接口 ON）运行 MCP 仓库的契约向量与冒烟场景。它**永不设为必需检查**，只在 PR 带 `e2e-windows` 标签时（打标签时与标签仍在时的每次推送）和 `workflow_dispatch` 时运行（后者要等文件合入默认分支后才可用，之前 `gh workflow run` 返回 404）；同一 PR 的新运行会取消旧运行。**预览前请手动运行一次**，并检查最近一次结果：契约与冒烟必须全部 PASS，模型目录检查必须 PASS，SKIP 与 FLAKY-SKIP 在 job 摘要里单独列出。

- 我们的构建来自 `build-windows.yml` 的出包模式；POST_BUILD 生成的 `models\` 已删除，job 再断言构建里既没有 `models\` 也没有 `*.onnx`。
- 官方安装包钉在 `official-install.json`（版本、URL、sha256、大小、静默参数），**只在 runner 上**静默安装，绝不在开发机上运行。模型装到 `%ProgramData%\OpenTune\Models`；job 按钉版核对 fcpe 与 GAME 文件的 sha256。
- OpenTune 以临时 `OPENTUNE_DATA_DIR` 启动。运行后日志必须显示 F0 模型是从官方模型目录加载的；日志在上传前脱敏（token、serverProof、用户名），并记录后端（CPU 或 DirectML）。
- 输入：`mcp-ref`（默认 `feature/v1`）、`contract-script`（默认 `test:contract`）、`smoke-script`（默认 `e2e:exe`）。标签触发没有输入，使用这些默认值。契约：`npm run test:contract -- -t "against the exe"`。两个脚本都读取 `OTCP_TARGET_EXE`；冒烟脚本把 `{"result","counts":{"PASS","FAIL","SKIP","FLAKY-SKIP"},"steps":[{"name","result","ms","note"}]}` 写到 `OTCP_E2E_REPORT` 指向的绝对路径（优先使用顶层 `counts`）。没有任何测试或步骤的报告算 FAIL。上传的每个文件都做脱敏（token、serverProof、用户名）。
- 更新钉版：从官方发布页取版本、URL 与 sha256，重新核对模型哈希，然后运行 workflow。
- 同一文件的 `olderInstallers` 列出只由 `prerelease.yml` 的 side-car 冒烟安装的旧官方版本（字段与 `installer` 相同），即测试版支持的最低官方版本（`.github/release/release.json` 的 `minOfficialVersion`）。`e2e-windows.mjs check-installer --version <x.y.z>` 核对其中一个；它们的模型按同一份 `models` 清单核对。条目可以有自己的 `modelsDir`，其中 `{app}` 代表安装目录（官方 1.7.9 把模型装在 `{app}\models`，1.8.1 装在共享目录）；`e2e-windows.mjs models-dir --pin <文件> --version <x.y.z> --app <安装目录>` 打印展开后的路径。
