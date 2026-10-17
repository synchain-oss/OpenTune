<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later

Body of the draft pre-release created by prerelease.yml; rendered by .github/scripts/release-package.mjs
(this comment is removed when rendering).
-->
> [!WARNING]
> **Unofficial test build / 非官方测试版.** This is **not** an official OpenTune release. OpenTune is a project of DAYA STUDIO (author: YuFeng926); the only official distribution channel is <{{OFFICIAL_RELEASES_URL}}>. This build adds a local control API for [OpenTune MCP Server (by Synchain)]({{MCP_REPO_URL}}) and is not made, reviewed or endorsed by DAYA STUDIO.
>
> 这**不是** OpenTune 官方版本。OpenTune 是 DAYA STUDIO 的项目（作者 风语，GitHub YuFeng926），唯一的官方发布渠道是 <{{OFFICIAL_RELEASES_URL}}>。本测试版加入了供 OpenTune MCP Server (by Synchain) 使用的本机控制接口，不是 DAYA STUDIO 制作、审核或认可的版本。

**OpenTune {{APP_VERSION}} with the local control API, build {{BUILD_LABEL}} (Windows x64)**

- **No model weights / 不含任何模型权重.** Install official OpenTune {{MIN_OFFICIAL_VERSION}} or later first; this build uses its models. 请先安装官方 OpenTune {{MIN_OFFICIAL_VERSION}} 或更新版本，本测试版使用其中的模型。
- **No DirectX 12 Agility runtime / 不含 D3D12 运行库.** INSTALL.txt (INSTALL.zh-CN.txt) explains the one-time copy of `D3D12Core.dll` from the official installation; without it, AI inference runs on the CPU. 安装说明介绍了如何从官方安装中一次性复制 `D3D12Core.dll`；不复制则用 CPU 推理。
- Free of charge. Problems with this build: <{{ISSUES_URL}}>. 免费提供；问题请到上面的链接反馈。
- Side-car smoke test (official release installed + this package): {{SMOKE_STATUS}}.

## Download / 下载

`{{ZIP_NAME}}`, {{ZIP_SIZE}} bytes, SHA-256 `{{ZIP_SHA256}}`

```powershell
Get-FileHash -Algorithm SHA256 .\{{ZIP_NAME}}
```

Files in the zip (folder `{{PACKAGE_NAME}}/`; also listed in its `SHA256SUMS`) / 压缩包内的文件：

{{FILE_TABLE}}

## Corresponding source / 对应源代码

This build is licensed under the GNU AGPL v3. Its complete corresponding source: / 本测试版采用 GNU AGPL v3 许可，完整对应源代码：

- Fork tag / tag：`{{TAG}}`, commit `{{COMMIT}}`: <{{SOURCE_URL}}>
- Source archive / 源码归档：<{{SOURCE_ARCHIVE_URL}}> (Git LFS files in the archive are pointers; the models are not part of this build.)
- Dependencies / 依赖：pinned with sha256 or git commit in `.github/scripts/deps.lock.json` at that commit; archive mirror: <{{DEPS_MIRROR_URL}}>
- Upstream base / 上游基点：`{{UPSTREAM_BASE_TAG}}` (`{{UPSTREAM_BASE_COMMIT}}`); the changes are listed in `MODIFICATIONS.md` in the zip.
- Build run / 构建记录：{{RUN_URL}}

Exact build commands (Windows, Visual Studio 2022, from a clone with `GIT_LFS_SKIP_SMUDGE=1` checked out at the commit above; `<src>` is the clone, `<build>` the build directory, `<deps>` the dependency cache) / 精确的构建命令：

```text
{{BUILD_COMMANDS}}
```
