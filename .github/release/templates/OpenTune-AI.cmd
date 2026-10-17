@echo off
rem SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
rem SPDX-License-Identifier: AGPL-3.0-or-later
rem
rem Starts OpenTune.exe from this folder with the local control API turned on,
rem by passing the command-line switch --control-api (extra arguments are passed on).
rem It changes nothing else: no settings, no files, and no environment variables
rem outside this script.
rem
rem [zh] 以开启本机控制接口的方式启动本文件夹中的 OpenTune.exe (switch --control-api)
rem [zh] 传给本脚本的其他参数会原样转交给 OpenTune.exe (pass-through)
rem [zh] 除此之外不做任何改动：不改设置、不写文件，也不在本脚本之外设置环境变量 (no side effects)
setlocal
set "OT_EXE=%~dp0OpenTune.exe"
if exist "%OT_EXE%" goto run
echo OpenTune.exe was not found next to this script.
exit /b 1
:run
start "" /D "%~dp0." "%OT_EXE%" --control-api %*
endlocal
