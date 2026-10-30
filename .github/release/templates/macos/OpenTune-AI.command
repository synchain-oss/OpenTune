#!/bin/sh
# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Starts OpenTune-ctl.app from this folder with the local control API turned on, by
# passing the command-line switch --control-api (extra arguments are passed on). It
# changes nothing else: no settings, no files, and no environment variables outside
# this script.
#
# Run from a Terminal window (double click, or typed there), it starts OpenTune in the
# background and returns, so OpenTune keeps running when the window is closed. Started
# by a program (for example OpenTune MCP Server, which watches the process it started),
# there is no Terminal window: the script then becomes OpenTune (exec), so the process
# that was started is OpenTune itself.
#
# [zh] 以开启本机控制接口的方式启动本文件夹中的 OpenTune-ctl.app (switch --control-api)
# [zh] 传给本脚本的其他参数会原样转交给 OpenTune (pass-through)
# [zh] 除此之外不做任何改动：不改设置、不写文件，也不在本脚本之外设置环境变量 (no side effects)
# [zh] 在终端窗口里运行（双击或手敲）时，在后台启动 OpenTune 后返回，关闭窗口后 OpenTune 继续运行
# [zh] 由程序启动（例如盯着所启动进程的 OpenTune MCP Server）时没有终端窗口：脚本直接变成 OpenTune (exec)，
# [zh] 这样被启动的进程就是 OpenTune 本身

here=$(cd "$(dirname "$0")" && pwd) || exit 1
exe="$here/OpenTune-ctl.app/Contents/MacOS/OpenTune"
if [ ! -x "$exe" ]; then
  echo "OpenTune was not found next to this script: $exe" >&2
  exit 1
fi
if [ -t 1 ]; then
  nohup "$exe" --control-api "$@" >/dev/null 2>&1 &
  exit 0
fi
exec "$exe" --control-api "$@"
