<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Unofficial Windows test build: packaging

Fork-only (never goes upstream). This directory holds everything that goes into the unofficial Windows x64 test build of OpenTune with the local control API, apart from the binaries:

| Path | What it is |
|---|---|
| `templates/` | Files rendered into the package (`README-UNOFFICIAL`, `INSTALL`, `MODIFICATIONS.md`, `OpenTune-AI.cmd`) and the body of the draft pre-release (`RELEASE-BODY.md`). Placeholders are `{{NAME}}`; a placeholder without a value fails the build. |
| `notices.json` | Catalogue for `THIRD-PARTY-NOTICES.txt`: each component, how to find it in the build, and its license files. |
| `licenses/GPL-3.0.txt` | Verbatim GNU GPL v3 text (from gnu.org), appended to the notices because the LGPL-3.0 cursor images and the GPL-3.0 option of the ASIO SDK require it. |
| `release.json` | Settings: official repository, issue tracker, minimum official OpenTune version. |

Scripts (in `.github/scripts/`): `release-lib.mjs` (pure functions, unit-tested in `test/release-lib.test.mjs`), `release-notices.mjs` (notices and build information, run on the build machine) and `release-package.mjs` (tag validation, assembly, checks, zip, release body). Workflow: `.github/workflows/prerelease.yml`, which calls `build-windows.yml` with `release-package: true`.

## Flow

1. **Validate** (tag builds only): the tag is `synchain-test/v<x.y.z>-ctl.<n>`, `x.y.z` equals `project(OpenTune VERSION …)` in `CMakeLists.txt`, the tagged commit is an ancestor of `dev`, and the latest `fork-gate` check run on it that GitHub Actions created (app `github-actions`) succeeded; same-name check runs from other apps are ignored. Pull requests that touch the packaging and manual runs are *rehearsals*: everything below except the draft release.
2. **Build** (`build-windows.yml`, release-package mode): Standalone only, Release (LTCG), `OPENTUNE_ENABLE_CONTROL_API=ON`, no tests, no compiler cache. The `models\` folder created by the POST_BUILD step (LFS pointers and an empty vocoder placeholder that would hide the official models) is deleted and checked to be gone.
3. **Notices** (`release-notices.mjs`, on the build machine): reads the Ninja graph to find every object linked into `OpenTune.exe` and writes `THIRD-PARTY-NOTICES.txt` and `build-info.json` (see below).
4. **Package** (`release-package.mjs build`): renders the templates, writes `opentune-control.json` and `SHA256SUMS`, checks the allow-list, writes a deterministic zip (sorted names, the commit date as timestamp), reads the zip back and checks it again, renders the release body and runs the attribution check on every text file and on the body.
5. **Side-car smoke test** (job `sidecar-smoke`, helper `.github/scripts/sidecar-smoke.mjs`): checks on fresh Windows runners that the package works when it is extracted next to an installed official OpenTune, the way `INSTALL.txt` describes. One matrix entry per official version and install folder: the pinned version (`.github/e2e/official-install.json`, the same pin as `e2e-windows`) in the default folder and in a custom `/DIR=` folder, and the minimum supported version (`minOfficialVersion`) in the default folder. Each entry installs the official release silently (on the runner only), extracts the zip outside Program Files and checks it against `SHA256SUMS`, runs `opentune-mcp doctor --json`, starts the extracted `OpenTune.exe` through the MCP server's `opentune_launch` and imports a generated tone (the ONNX Runtime DLL must come from the extracted folder, `modelsDir` must be the official shared models folder, inference must run on the CPU without a crash), copies `D3D12Core.dll` as `INSTALL.txt` says (same hash as the official file and as `opentune-control.json` expects, no `D3D12SDKLayers.dll`), runs doctor and a start again, and finally runs the MCP contract vectors and smoke scenario against the extracted executable. Doctor checks the MCP server does not implement yet are SKIP; DirectML on a runner without a GPU is FLAKY-SKIP. Each step's result and time goes to the job summary and to the artifact `sidecar-smoke-<entry>` (scrubbed). Any FAIL fails the entry, and a tag build then creates no draft.
6. **Draft pre-release** (tag builds only): `softprops/action-gh-release` creates a *draft* pre-release with the zip. Publishing the draft is a manual maintainer step; no workflow publishes or pushes tags.

## The package allow-list

The zip contains one folder, `OpenTune-<version>-ctl.<n>-unofficial-win-x64/` (rehearsals: `…-rehearsal-<sha7>-…`), with exactly these files and nothing else:

`OpenTune.exe`, `OpenTuneOnnxRuntime_<x>_<y>_<z>.dll`, `DirectML.dll`, `DirectML-LICENSE.txt`, `LICENSE.txt` (AGPL-3.0), `THIRD-PARTY-NOTICES.txt`, `README-UNOFFICIAL.txt`, `README-UNOFFICIAL.zh-CN.txt`, `MODIFICATIONS.md`, `INSTALL.txt`, `INSTALL.zh-CN.txt`, `opentune-control.json`, `OpenTune-AI.cmd`, `SHA256SUMS`.

Any other file, any subdirectory, two entries with the same name (or names that differ only in case, which collide when the zip is extracted on Windows), or anything that matches the forbidden list fails the build. The forbidden list is checked recursively and case-insensitively: `*.onnx`, a `models` path segment, a Git LFS pointer, any name starting with `D3D12`, `d3dconfig.exe` and `STATEMENTS.txt`. The same rules are applied to the staged files and to the zip as written.

## `opentune-control.json`

A small UTF-8 JSON object (no BOM, at most 8 KiB) next to `OpenTune.exe`. OpenTune MCP Server only launches an executable that has this file beside it, and it reads only `protocolMajors`. The other members describe the build for diagnostics (for example the MCP `doctor` command). Unknown members must be ignored by readers; new members may be added without changing `schema`, while removing or redefining a member increments it.

| Member | Type | Meaning |
|---|---|---|
| `schema` | integer, `1` | Layout version of this file. |
| `protocolMajors` | array of positive integers, contains `1` | OTCP major versions served by this build. Taken from `kControlProtocolMajor` in `Source/Control/ControlProtocol.h`. **The only member OpenTune MCP Server relies on.** |
| `flavor` | `"standalone"` | Which OpenTune product this is (only the Standalone has the control API). |
| `appVersion` | string `x.y.z` | `project(OpenTune VERSION …)` in `CMakeLists.txt`. |
| `unofficial` | `true` | Always true: this is not an official OpenTune release. |
| `build.commit` | 40-digit hex | The fork commit the build was made from. |
| `build.tag` | string or `null` | `synchain-test/v<x.y.z>-ctl.<n>`; `null` for a rehearsal build. |
| `build.label` | string | `ctl.<n>`, or `rehearsal-<sha7>`. |
| `build.date` | `YYYY-MM-DD` | Commit date (UTC). |
| `build.controlApi` | `true` | The build was configured with `OPENTUNE_ENABLE_CONTROL_API=ON`. |
| `sourceUrl` | https URL | The source tree of this build (tag, or commit for a rehearsal). |
| `officialRepository` | https URL | `https://github.com/YuFeng926/OpenTune`, the only official channel. |
| `modelsBundled` | `false` | The package contains no model weights; they come from the official installation. |
| `d3d12.bundled` | `false` | The DirectX 12 Agility runtime is not in the package. |
| `d3d12.directory` | `"D3D12"` | Folder next to `OpenTune.exe` where the runtime is expected (`D3D12SDKPath` exported by `OpenTune.exe`). |
| `d3d12.agilityVersion` | string | Agility SDK package version the build used, e.g. `1.619.5`. |
| `d3d12.sdkVersion` | integer | `D3D12SDKVersion` exported by `OpenTune.exe`, e.g. `619`. |
| `d3d12.files[]` | `{name, sha256}` | Expected hash of each file to copy from the official installation (`D3D12Core.dll` only). A doctor check compares the copied file with it. |

Example:

```json
{
  "schema": 1,
  "protocolMajors": [1],
  "flavor": "standalone",
  "appVersion": "1.8.0",
  "unofficial": true,
  "build": { "commit": "<40 hex>", "tag": "synchain-test/v1.8.0-ctl.1", "label": "ctl.1", "date": "2026-10-20", "controlApi": true },
  "sourceUrl": "https://github.com/synchain-oss/OpenTune/tree/synchain-test/v1.8.0-ctl.1",
  "officialRepository": "https://github.com/YuFeng926/OpenTune",
  "modelsBundled": false,
  "d3d12": { "bundled": false, "directory": "D3D12", "agilityVersion": "1.619.5", "sdkVersion": 619, "files": [{ "name": "D3D12Core.dll", "sha256": "<64 hex>" }] }
}
```

## THIRD-PARTY-NOTICES.txt

Generated from the build itself, not from a hand-written list:

- **Linked code**: the Ninja build graph (`CMakeFiles/impl-Release.ninja`) gives every object linked into `OpenTune.exe` (following the static libraries), its source file and its `-D` macros. JUCE modules, SoundTouch (compiled sources) and r8brain (include path) are detected from it.
- **JUCE's vendored third-party code** comes from `JUCE.spdx.json` of the JUCE checkout: a package is listed when its JUCE module is linked and its switch is on (`juceVendored.conditions` in `notices.json`, evaluated with JUCE's defaults for macros that are not set). Packages without a condition are listed whenever their module is linked. License files are read from the vendored directory.
- **Embedded data** (cursor images, piano samples, the UI font) is detected by searching `OpenTune.exe` for a sample of each repository file.
- **Files next to the executable**: ONNX Runtime (license and third-party notices from the NuGet package) and DirectML (its license terms ship as `DirectML-LICENSE.txt`).
- **ARA SDK**: listed only if it is linked. It counts as linked when an ARA SDK source is compiled in, an ARA library is linked, or `JucePlugin_Enable_ARA` / `JUCE_PLUGINHOST_ARA` is non-zero in any linked object. The Standalone normally has none of these.
- The notices state that the package contains no model weights and no DirectX 12 Agility runtime.

`build-info.json` (an input of the packaging step, not part of the package) records what was found: included and excluded components with reasons, the ARA verdict, the JUCE modules, the `D3D12Core.dll` hash, and the exact build commands.

### Release blockers (fail closed)

`build-info.json` lists *release blockers*. Rehearsals report each one as a warning; a tagged build fails at the packaging step while any is listed. There are two kinds:

- **Unverified terms in the build.** A catalogue component with `"redistribution": "unverified"` is never written into the notices. If the build contains it, it is a release blocker until the terms are confirmed and the catalogue entry is completed.
- **A probe that misses a component the repository has.** When the repository has the component (the files of an `embedded` probe, or `probe.repoFiles` of a `source` / `include` probe) and its terms ask for something (unverified terms, a license text, the GPL-3.0 appendix), but the probe finds nothing in the build, the component is a release blocker too. A probe can stop matching after an upstream change (another way of embedding the data, a changed file, a moved path) while the component is still compiled in; dropping its notice, or the blocker of an unverified component, without a person looking would be wrong. Fix the probe, or, once it is confirmed that the build really no longer contains the component, add `"absentOk": "<reason>"` to its catalogue entry. Components whose terms ask for nothing (the piano samples) and components without repository evidence (the ARA SDK, which the Standalone does not link) are simply left out when their probe misses.

### Components with unverified terms

**HONOR Sans CN Medium** (the UI font, compiled into `OpenTune.exe` from `Resources/Fonts/HONORSansCN-Medium.ttf`) is in this state. Findings from the repository:

- There is no license file for the font in the repository (`LICENSES/` has the combined AGPL/SoundTouch text, the cursor notice and the SoundTouch LGPL text only).
- The only statement is in `Resources/About/credits.md`: "HONOR font license (commercial / personal use within OpenTune)".
- The font's own name table: copyright "Honor Device Co., Ltd", designer Beijing Founder Electronics Co., Ltd., license description only a link to a Founder Type authorization page; `fsType` is 8 (editable embedding), which concerns embedding in documents, not redistribution in software.
- Nothing states whether a third party may redistribute the font inside a modified build. Until that is confirmed, tagged builds stop at the packaging step.
