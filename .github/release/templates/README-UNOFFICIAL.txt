OpenTune {{APP_VERSION}} with the local control API
Unofficial test build {{BUILD_LABEL}} for Windows x64

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
- Report problems with this build at {{ISSUES_URL}}.
  Please do not report them to the official OpenTune project; problems that
  also happen in the official release belong there.

The control API
===============

- It is off unless you start OpenTune with OpenTune-AI.cmd (which passes the
  command-line switch --control-api) or set OPENTUNE_CONTROL_API=1.
- It only listens on 127.0.0.1 (this computer), on a port chosen by Windows.
  While it is on, any program running under your Windows user account can
  find it and control OpenTune. Do not turn it on in a shared account.
- Started with OpenTune.exe directly, this build behaves like official
  OpenTune {{APP_VERSION}} (apart from the differences in MODIFICATIONS.md).

Files in this folder
====================

  OpenTune.exe                    the application
  {{ORT_DLL}}  ONNX Runtime (DirectML build), renamed
  DirectML.dll                    DirectML runtime
  DirectML-LICENSE.txt            license terms of DirectML
  LICENSE.txt                     GNU AGPL v3 (OpenTune's license)
  THIRD-PARTY-NOTICES.txt         third-party components and their licenses
  README-UNOFFICIAL.txt           this file (README-UNOFFICIAL.zh-CN.txt: Chinese)
  INSTALL.txt                     installation steps (INSTALL.zh-CN.txt: Chinese)
  MODIFICATIONS.md                what this build changes compared with OpenTune
  OpenTune-AI.cmd                 starts OpenTune with the control API on
  opentune-control.json           build information read by OpenTune MCP Server
  SHA256SUMS                      SHA-256 of every other file

Source code
===========

This build: {{SOURCE_URL}}
(tag {{TAG}}, commit {{COMMIT}}).
That tree is the complete corresponding source code of this build under the
AGPL, including the build scripts (.github/) and the dependency lock
(.github/scripts/deps.lock.json). The release page of this build lists the
exact build commands.
