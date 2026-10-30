OpenTune {{APP_VERSION}} with the local control API
Unofficial test build {{BUILD_LABEL}} for macOS (Apple silicon, arm64)

(中文说明：README-UNOFFICIAL.zh-CN.txt)

THIS IS NOT AN OFFICIAL OPENTUNE RELEASE
========================================

- OpenTune is a project of DAYA STUDIO (author: YuFeng926), licensed under the
  GNU AGPL v3. The official repository is {{OFFICIAL_REPO_URL}}.
  Its Releases page, {{OFFICIAL_RELEASES_URL}},
  is the only official distribution channel of OpenTune.
- This build was made by Synchain from the fork {{FORK_REPO_URL}}.
  It is OpenTune with a local control API added, so that OpenTune MCP Server
  (by Synchain) can operate it. It is not made, reviewed or endorsed by
  DAYA STUDIO.
- It is free of charge. It contains no model weights: the AI models are used
  from your own installation of official OpenTune (see INSTALL.txt).
- It is test software. Expect problems and keep backups of your projects.
- It runs on Apple silicon Macs only (arm64), not on Intel Macs.
- Report problems with this build at {{ISSUES_URL}}.
  Please do not report them to the official OpenTune project; problems that
  also happen in the official release belong there.

The control API
===============

- It is off unless you start OpenTune with OpenTune-AI.command (which passes
  the command-line switch --control-api) or set OPENTUNE_CONTROL_API=1.
- It only listens on 127.0.0.1 (this computer), on a port chosen by macOS.
  While it is on, any program running under your macOS user account can
  find it and control OpenTune. Do not turn it on in a shared account.
- Opened directly (OpenTune-ctl.app), this build behaves like official
  OpenTune {{APP_VERSION}} (apart from the differences in MODIFICATIONS.md).

Not signed by Apple
===================

The app is signed ad hoc and is not notarized (the official macOS builds of
OpenTune are not notarized either): it carries no Apple Developer ID. macOS
Gatekeeper therefore blocks the first start. INSTALL.txt explains the two
ways to allow it. The signature still shows whether a file was damaged:
INSTALL.txt also explains how to verify it.

Files in this folder
====================

  OpenTune-ctl.app                the application; named differently from the
                                  official OpenTune.app so that it never
                                  replaces it (bundle identifier
                                  ca.synchain.opentune.ctltest)
    Contents/MacOS/OpenTune       the program
    Contents/Frameworks/{{ORT_DYLIB}}
                                  ONNX Runtime (macOS arm64)
  OpenTune-AI.command             starts OpenTune-ctl.app with the control API on
  opentune-control.json           build information read by OpenTune MCP Server
                                  next to the program it starts, which is
                                  OpenTune-AI.command (it cannot sit inside the
                                  app: the signature of the app would not hold)
  LICENSE.txt                     GNU AGPL v3 (OpenTune's license)
  THIRD-PARTY-NOTICES.txt         third-party components and their licenses
  README-UNOFFICIAL.txt           this file (README-UNOFFICIAL.zh-CN.txt: Chinese)
  INSTALL.txt                     installation steps (INSTALL.zh-CN.txt: Chinese)
  MODIFICATIONS.md                what this build changes compared with OpenTune
  SHA256SUMS                      SHA-256 of every other file

Source code
===========

This build: {{SOURCE_URL}}
(tag {{TAG}}, commit {{COMMIT}}).
That tree is the complete corresponding source code of this build under the
AGPL, including the build scripts (.github/) and the dependency lock
(.github/scripts/deps.lock.json). The release page of this build lists the
exact build commands.
