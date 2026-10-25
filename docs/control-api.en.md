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

## Preferences and the audio device

These two groups of methods change **global settings** of the OpenTune installation, not of a project: they apply to every project and outlive the session. As in the UI there is no undo entry; every change carries the warning `GLOBAL_PREFERENCE`, and the result gives a revert recipe that sets the previous values back (`prefs.set` / `audio.set`). The writes follow the common busy rules (`BUSY` while a modal dialog is open, the pointer is down, or an import or export runs).

| Method | Capability | What it does |
|---|---|---|
| `prefs.get` | `read.v1` | Reads the processing settings (A4 frequency, editing scheme, hybrid mode, experimental features, vocoder weight, rendering priority, pitch model, reference alignment mode, and the values on offer in `processing.options`), whether the first-run onboarding was shown, the UI language (read-only through this protocol) and the recent projects. A processing setting that cannot be determined is null and named in `processing.nullReasons`. Recent project paths are untrusted data. |
| `prefs.set` | `prefs.write` | Changes `tuningHz` (400-500, the frequency of A4), `editingScheme` (`openTune` or `openDyne`), `hybridMode` and `experimentalFeatures` (shows or hides experimental features such as reference binding), `vocoderWeight` (a file name from `processing.options.vocoderWeight`), `renderingPriority` (`gpuFirst` or `cpuFirst`), `f0Model` (from `processing.options.f0Model`) and `referenceAlignMode` (`standardAuto` or `game`), as the preferences window does. A value equal to the current one is not a change. |
| `audio.get` | `audio.device` | Reads the audio device of OpenTune Standalone: whether a device runs, the device type, the output device, the sample rate, the buffer size and the output channel pair, and the values the current device type and device offer (`available`). Without a running device the other members are null with `no_audio_device`. Device type and device names come from the operating system and are untrusted data. |
| `audio.set` | `audio.device` | Changes `deviceType`, `outputDevice`, `sampleRateHz`, `bufferSizeFrame` and `outputChannelPair` as the audio settings page does: the members given replace those of the current setup and the device is opened again; playback stops while it reopens. |

Notes:

- `tuningHz` applies to analysis and rendering from now on and does not recompute existing results (warning `NOT_RETROACTIVE`). Changing `hybridMode` makes OpenTune render every content again (`sideEffects.reRenderQueued`).
- OpenTune applies a new editing scheme to its editor asynchronously, so a call that changes `editingScheme` hands all its changes to a `prefsApply` job, which ends when the editor has applied the scheme and cannot be cancelled. Switching to `openDyne` may make OpenTune generate notes for the clip open in the piano roll, with no undo entry: the result has `sideEffects.notesGenerated` and the warnings `SCHEME_GENERATED_NOTES` and `IRREVERSIBLE`, and the project is marked as changed.
- `vocoderWeight` and `f0Model` only accept values listed in `processing.options` of `prefs.get` (a weight is listed when its file exists); others give `INVALID_ARGUMENT(option_unavailable)` and change nothing, and the error text names the member, never the value. The values of `renderingPriority` and `referenceAlignMode` are fixed.
- OpenTune switches the vocoder weight and the rendering priority asynchronously: the processor only hands the command to the render runtime and returns, and the runtime puts the vocoder into "reconfiguring" a little later. So a call that changes `vocoderWeight` or `renderingPriority` hands all its changes to a `prefsApply` job as well, which ends when the vocoder is ready again, is not reconfiguring and the runtime's control worker is idle, and cannot be cancelled. If the vocoder was not available before the change (no vocoder, or one that is reloading) the job does not wait and ends as soon as the changes are made. If the vocoder is not back within the limit (60 seconds), the job takes all its changes back (the runtime is asked for the previous weight or priority again) and fails with `MODEL_UNAVAILABLE(vocoder_not_ready)`, retryable, `executed` false. If the runtime has finished the switch and there is no vocoder (the weight or the backend could not be loaded), the job does not wait for the limit: it takes all its changes back at once and fails with `MODEL_UNAVAILABLE(vocoder_load_failed)`, not retryable (the same weight fails again), `executed` false. A withdrawal after a timeout also reports `executed` false, but if the original switch was merely slow it still completes later, clears the caches and renders again, and the withdrawn switch renders once more; the final state is consistent. Changing `vocoderWeight` makes OpenTune render every content again once the runtime has switched (when the job waited for the vocoder, the result has `sideEffects.reRenderQueued`); changing `renderingPriority` does not.
- `f0Model`: if the processor refuses to switch the pitch model, the call fails with `MODEL_UNAVAILABLE(model_missing)` and `executed` false, and no other change of the same call takes effect. OpenTune currently has one model, `fcpe`.
- `referenceAlignMode` applies at once and carries the warning `EXPERIMENTAL_FEATURE`: the mode only matters for AUTO Ref, an experimental feature. The editor refreshes the reference context.
- Revert recipe: a `prefs.set` result has no undo entry (`ui_parity`); its revert recipe calls `prefs.set` again with the previous values. A previous vocoder weight whose name cannot go on the wire (not valid UTF-8, empty, or longer than 64 code points) is left out of the recipe; when it was the only member the call changed, the recipe is null (the reason stays `ui_parity` and the result carries the warning `IRREVERSIBLE`), never a `prefs.set` without params.
- Relationship to the specification: `processing.options`, `vocoderWeight`, `renderingPriority`, `f0Model`, `referenceAlignMode` and the reasons `option_unavailable`, `vocoder_not_ready` and `vocoder_load_failed` are registered with specification rc.6; the copy in this repository is still rc.5, and the difference is recorded under "Deviations from the vectors" in `Source/Control/README.md`.
- `audio.set` only accepts values listed in `available` of `audio.get`; others give `INVALID_ARGUMENT(audio_setting_unavailable)`. The device type and the output device are checked against the lists before anything changes, so a value that is not on offer there changes nothing; the sample rate, buffer size and output channel pair can only be checked once the device that will run is open, so an earlier step of the same call (switching the device type or the output device) may already have changed the device: the server then puts the previous setup back, as the settings page does, before it answers with that error. If the device cannot be opened, the server restores the previous setup as the settings page does, and the call fails with `IO_ERROR(device_open_failed)` and `executed` false; if the previous setup cannot be opened either, `executed` is true and no device runs (`audio.get` reports it). The same holds when an earlier step had already changed the device, a later value is not on offer and the previous setup cannot be put back: the answer is `IO_ERROR(device_open_failed)` with `executed` true, not `INVALID_ARGUMENT`. The error text says which step failed and whether the previous setup was restored.
- Before an ASIO device is closed for another device type or output device, the server restores the ASIO sample rate to the system's shared render rate, as the settings page does; if that cannot be confirmed the call fails and the current device stays.

## Relationship to OpenTune MCP Server

- [OpenTune MCP Server (by Synchain)](https://github.com/synchain-oss/opentune-mcp-server) is a stdio MCP server under the MIT license. It connects to this API so that MCP clients such as Claude Code, Claude Desktop and Cursor can operate OpenTune. Its npm package `@synchain/opentune-mcp` (command `opentune-mcp`) is not published yet.
- The authoritative OTCP v1 protocol specification lives in the MCP repository under `spec/otcp/v1/` (MIT). This fork keeps a byte-identical copy in `Tests/Control/spec/otcp/v1/`.

## Unofficial test builds (planned)

Until upstream merges the API, we plan to publish **unofficial test builds** as pre-releases on this fork's Releases page:

- They will be Windows x64 zip files only, tagged like `synchain-test/v<version>-ctl.<n>`.
- They will contain **no model weights**. They require an installed official OpenTune, which provides the models.
- Each test build will state its corresponding source (fork tag and source archive) and how it was built. Each will also state that YuFeng926/OpenTune is the only official channel.

No test build has been published yet.

## First launch and the onboarding dialog

On the very first launch with a fresh data directory, OpenTune shows a modal onboarding dialog that asks you to pick a workflow. While any modal dialog is open, the control API answers write operations with `BUSY(modal_open)`. This is normal upstream behaviour, not a defect: a real user answers the dialog once, and it does not appear again.

The `e2e-windows` workflow starts OpenTune with a new data directory on every launch, so it pre-seeds a minimal preferences file that already marks first-time use as completed (`shared.onboardingShown`), through the `OTCP_TARGET_DATA_TEMPLATE` option of the MCP contract and smoke runners. It then asserts that the file was copied into every launch's data directory unmodified. That the app actually read it shows in the contract and smoke runs: no `BUSY(modal_open)` appears.

The effects scenario in the smoke run (which checks that what the API says it changed is really changed in the sound) uses a second template (`OTCP_E2E_EFFECTS_DATA_TEMPLATE`) that additionally sets `shared.rendering.lightPitchCorrection=0`, so it runs on an instance with hybrid mode off; when the effects scenario actually ran (its report is in the output directory), the workflow also checks that at least one kept data directory has that key set to 0, and skips that check with a note in the summary when there is no such report. Reason: real users have hybrid mode on by default, and in that mode render chunks whose correction is under 75 cents are pitch-shifted by the DSP path instead of the vocoder (threshold `kPitchShiftThresholdCents` in `Source/Inference/ChunkRenderStrategy.h`; the upstream comment there says DSP pitch shifting is better than the vocoder within 75 cents); in practice such small corrections are barely audible on real voices and harmonic tones. This is OpenTune's own behavior (the UI behaves the same) and hybrid mode can be turned off in the preferences. The contract run and the other scenarios keep the default template (hybrid mode on).

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
