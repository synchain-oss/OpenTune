<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# OpenTune local control API (synchain-oss/OpenTune fork)

[中文](control-api.md) | English

> **Status: pre-release, work in progress.** Nothing is published yet. There are no test builds and no npm package. The API and protocol may still change before they are contributed upstream.

## What this is

`synchain-oss/OpenTune` is an **unofficial** fork of OpenTune, maintained by Synchain. It exists for one purpose: to develop a **local control API** for OpenTune Standalone. The API listens on `127.0.0.1` only. It lets local tools perform operations that already exist in the OpenTune UI and get structured results back. One such tool is [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server). Planned operations include reading notes and pitch curves, import, AUTO tuning, note edits, undo/redo, and export. Once it works, we plan to contribute it to upstream as a pull request.

- OpenTune is a project of DAYA STUDIO (author: 风语), licensed under AGPL-3.0.
- **The official repository is [YuFeng926/OpenTune](https://github.com/YuFeng926/OpenTune). Its [Releases page](https://github.com/YuFeng926/OpenTune/releases) is the only official distribution channel.** No build from this fork is an official release.
- This fork does not change OpenTune's own logic. It only adds the API code and a small number of integration hooks. When the API is not enabled, OpenTune behaves the same as upstream.
- Problems with this fork, the control API or test builds: please report them at [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/issues). Problems that also reproduce in official OpenTune releases belong to OpenTune itself (see [Feedback and security](#feedback-and-security)).

## Current status

| Item | Status |
|---|---|
| Control API | In development; no usable build yet |
| Official OpenTune releases | Do not include this API; a patched build from this fork is required |
| Windows x64 | First target (in development) |
| macOS | Not yet. No macOS test builds will be published; on macOS the API is planned to be available once it is part of an official OpenTune release, or in a build from source |
| Linux | Not supported (OpenTune itself has no Linux build) |
| Unofficial test builds | Not published yet |
| MCP server (npm `@synchain/opentune-mcp`) | Not published yet |

## Pinned upstream base

During development, this fork is pinned to a single upstream commit and does not follow upstream:

- **Upstream base**: the tip of branch `upstream-mirror`, tagged in this fork as `upstream/YYYYMMDD-<sha7>` (see the tags of this repository); it is a commit on the `standalone` branch of `YuFeng926/OpenTune`.
- **Branches**:
  - `upstream-mirror`: an unmodified copy of that commit.
  - `dev` (default branch): the upstream base plus our additions.
  - `feature/control-api`: the development mainline.
- Before contributing upstream, we will rebase all of our changes onto the latest upstream once, then rerun every check.
- The upstream commit behind each test build will be recorded in the COMPATIBILITY document of the MCP repository.

## Building from source (planned)

Build instructions will be completed once the build scripts land. The current plan:

1. For the toolchain and dependency requirements, see upstream's [BUILDING.en.md](../BUILDING.en.md) ([中文](../BUILDING.md)): Windows 10 1903+ x64, Visual Studio 2022, CMake 3.22+.
2. Clone with Git LFS smudging disabled. You do not need to download the models; they come from the official installer.

   ```powershell
   $env:GIT_LFS_SKIP_SMUDGE = '1'
   git clone -b dev https://github.com/synchain-oss/OpenTune.git
   cd OpenTune
   git config lfs.fetchexclude "*"
   git config core.longpaths true
   ```

3. Fetch the pinned dependencies with our dependency bootstrap script. These include JUCE 9.0.3, ARA SDK 2.3.0, SoundTouch 2.3.3, ONNX Runtime 1.24.4 and DirectML 1.15.4. The script verifies each one by sha256; `deps.lock.json` is the authoritative list. It does **not** download any model weights.
4. Configure with `-DOPENTUNE_ENABLE_CONTROL_API=ON`, then build the Standalone target. The dependency bootstrap script and the exact build commands will be documented here when the build scripts are added.
5. Delete the `models\` folder from the build output before running. It contains only placeholder files, and it would hide the models of your installed official OpenTune. The models come from the official OpenTune installed on the same machine (minimum version to be determined). We will verify this step before the first test build and document it in full.

## Enabling the control API (planned)

The control API is **off by default**. It is enabled only when both of these are true:

1. The build was configured with the CMake option `OPENTUNE_ENABLE_CONTROL_API`. Upstream's default build and the official releases contain no API code.
2. It is explicitly enabled at launch, in one of two ways:
   - set the environment variable `OPENTUNE_CONTROL_API=1`, or
   - pass the command-line flag `--control-api`, for example `OpenTune.exe --control-api`.

Once enabled:

- It listens only on a system-assigned port on the literal address `127.0.0.1`, and on no other network interface.
- Each launch generates a random token (at least 128 bits, from the system CSPRNG). A client must complete a `session.hello` handshake with this token first.
- Connection details are written to the discovery file `%LOCALAPPDATA%\OpenTune\control\instances\<pid>.json`. The file is deleted on normal exit.
- The token never appears in logs or in any result.

**Security boundary**:

- Any program running as the same OS user can read the discovery file, and can therefore control OpenTune.
- Other OS users, web pages in a browser, and text injected into an AI conversation are treated as untrusted.
- Do not enable the API on a shared OS account.
- The full threat model is in the protocol specification's `SECURITY.md`.

The environment variable `OPENTUNE_DATA_DIR` redirects preferences, logs and the discovery directory to a given folder. It is intended for test isolation only.

## Relationship to OpenTune MCP Server

- [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) is a stdio MCP server under the MIT license. It connects to this API so that MCP clients such as Claude Code, Claude Desktop and Cursor can operate OpenTune. Its npm package `@synchain/opentune-mcp` (command `opentune-mcp`) is not published yet.
- The authoritative OTCP v1 protocol specification lives in the MCP repository under `spec/otcp/v1/` (MIT). This fork keeps a byte-identical copy in `Tests/Control/spec/otcp/v1/`.

## Unofficial test builds (planned)

Until upstream merges the API, we plan to publish **unofficial test builds** as pre-releases on this fork's Releases page:

- They will be Windows x64 zip files only, tagged like `synchain-test/v<version>-ctl.<n>`.
- They will contain **no model weights**. They require an installed official OpenTune, which provides the models.
- Each test build will state its corresponding source (fork tag and source archive) and how it was built. Each will also state that YuFeng926/OpenTune is the only official channel.

No test build has been published yet.

## Licensing

- OpenTune is licensed under AGPL-3.0. This fork and all of our changes are also provided under AGPL-3.0, except the OTCP specification copy in `Tests/Control/spec/otcp/v1/`, which is MIT-licensed like its source. New source files we add carry `SPDX-License-Identifier: AGPL-3.0-or-later`.
- We **do not redistribute any model weights**. In particular, the OpenVPI vocoder weights and the GAME pretrained weights are licensed under CC BY-NC-SA 4.0 (non-commercial). We never bundle, upload or re-host them. The models you need come from the official OpenTune that you install yourself.
- Test builds will include third-party notices generated from the actual contents of the binaries.
- The MCP server and the protocol specification are provided under the MIT license in their own repository.

## Feedback and security

- Problems and suggestions for this fork, the control API or test builds: [synchain-oss/opentune-mcp-server issues](https://github.com/synchain-oss/opentune-mcp-server/issues).
- Security issues: please use Private Vulnerability Reporting on this repository or on [synchain-oss/opentune-mcp-server](https://github.com/synchain-oss/opentune-mcp-server/security); both reach the same maintainers. Fallback: contact@synchain.ca. Please do not disclose them publicly. See also [SECURITY.md](../.github/SECURITY.md).
- Problems that also reproduce in the official OpenTune releases belong to OpenTune itself. Please report those through upstream's channels.

---

[Synchain](https://www.synchain.ca) · contact@synchain.ca
