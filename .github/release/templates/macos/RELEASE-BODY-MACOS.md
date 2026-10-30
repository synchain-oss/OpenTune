<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later

macOS section of the body of the draft pre-release created by prerelease.yml; rendered by
.github/scripts/release-package.mjs (build-macos) and appended to the Windows body by its compose-body
command (this comment is removed when rendering).
-->
## macOS (Apple silicon, arm64) / macOS（Apple 芯片）

**OpenTune {{APP_VERSION}} with the local control API, build {{BUILD_LABEL}} (macOS arm64)**

- **No model weights / 不含任何模型权重.** Install official OpenTune for macOS {{MIN_OFFICIAL_VERSION}} or later first; this build uses its models. 请先安装官方 OpenTune for macOS {{MIN_OFFICIAL_VERSION}} 或更新版本，本测试版使用其中的模型。
- **Apple silicon only, macOS {{MIN_MACOS}} or later / 只支持 Apple 芯片，需要 macOS {{MIN_MACOS}} 或更新版本.**
- **Signed ad hoc, not notarized / 临时签名，未经公证.** macOS Gatekeeper blocks the first start; INSTALL.txt (INSTALL.zh-CN.txt) shows how to allow it ("Open Anyway" in System Settings, or `xattr -dr com.apple.quarantine`). 首次启动会被 Gatekeeper 拦截，安装说明介绍了放行办法。
- Side-car smoke test (official release installed + this package): {{SMOKE_STATUS}}.

### Download / 下载

`{{ZIP_NAME}}`, {{ZIP_SIZE}} bytes, SHA-256 `{{ZIP_SHA256}}`

```sh
shasum -a 256 ./{{ZIP_NAME}}
```

Files in the zip (folder `{{PACKAGE_NAME}}/`; also listed in its `SHA256SUMS`) / 压缩包内的文件：

{{FILE_TABLE}}

### Corresponding source of the macOS build / macOS 版的对应源代码

The source, dependency and upstream-base lines above apply to this build too (same fork tag and commit). 上面的源代码、依赖与上游基点同样适用于本构建（同一个 fork tag 与提交）。

- Build run / 构建记录：{{RUN_URL}}

Exact build commands (macOS 14 on Apple silicon, Xcode, CMake and Ninja, from a clone with `GIT_LFS_SKIP_SMUDGE=1` checked out at the commit above; `<src>` is the clone, `<build>` the build directory, `<deps>` the dependency cache) / 精确的构建命令：

```text
{{BUILD_COMMANDS}}
```
