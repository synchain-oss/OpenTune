#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// sidecar-smoke helper (prerelease.yml, job sidecar-smoke): checks that the unofficial test build works
// when it is extracted to a folder of its own on a machine with official OpenTune installed (the
// "side-car" set-up of INSTALL.txt): models from the official installation, the ONNX Runtime DLL from
// the extracted folder, CPU inference without D3D12Core.dll, and the one-time D3D12 copy. Each command
// appends rows {group, name, result, seconds, note} to the steps file; `summary` renders them. Results
// are PASS, FAIL, SKIP (a check the MCP doctor does not implement yet) and FLAKY-SKIP (a known
// environment limit, e.g. a runner without a GPU). Only FAIL, or a required group without any row,
// fails the job.
//
//   step     --steps <json> --group <g> --name <n> --result <R> [--seconds <n>] [--note <t>]
//   install  --steps <json> --dir <install dir> --expect-dir <dir> --models-dir <dir> --location default|custom
//            --version <x.y.z> [--registry-version <v>] [--seconds <n>] [--out <json>]   exit 1 on a FAIL row
//   package  --steps <json> --dir <extracted package folder> [--documented <mismatch text>] [--seconds <n>]
//                                                             exit 1 on a FAIL row
//   doctor   --steps <json> --report <doctor --json output> --phase no-d3d12|d3d12 --install-dir <dir> [--mcp-ref <r>]
//   launch   --steps <json> --phase no-d3d12|d3d12 --mcp <dist/opentune-mcp.mjs> --exe <side-car OpenTune.exe>
//            --data-dir <new dir> [--template <dir>] --official-dir <dir> --models-dir <dir> [--out <json>]
//            [--logs-out <dir>] [--timeout <seconds>]
//            starts the MCP bundle, calls opentune_launch (OPENTUNE_MCP_OPENTUNE_PATH = the side-car exe), imports a
//            generated tone, waits for the F0 model to load, checks the process and opentune_get_status, then ends
//            the instance it started (only after its discovery file in --data-dir names that pid)
//   d3d12    --steps <json> --official-dir <dir> --sidecar <dir> [--seconds <n>]
//   results  --steps <json> [--contract <vitest json>] [--smoke <json>] [--log <check-log report json>]
//            [--contract-seconds <n>] [--smoke-seconds <n>] [--contract-outcome <outcome>] [--smoke-outcome <outcome>]
//   summary  --steps <json> [--title <t>] [--package <zip name>] [--mcp-ref <r>] [--out <md>] [--json <file>]
//                                                             exit 1 on any FAIL or a missing required group
//
// macOS (`--platform macos` on install | package | doctor | launch | d3d12 | summary; result N/A = no such check on macOS):
//   install  --steps <json> --platform macos --app <installed OpenTune.app> --expect-app /Applications/OpenTune.app
//            --models-dir <dir> --version <x.y.z> [--registry-version <Info.plist version>] [--kind pkg|dmg] [--out <json>]
//   package  --steps <json> --platform macos --dir <extracted package folder> [--official-app <app>] [--documented <shasum output>]
//   doctor   --steps <json> --platform macos --report <doctor --json output> [--mcp-ref <r>]   (Windows-only checks are N/A)
//   launch   --steps <json> --platform macos --mcp <bundle> --exe <package folder>/OpenTune-AI.command --data-dir <new dir>
//            --official-dir <official OpenTune.app> --models-dir <dir> ...   (the ONNX Runtime image is read with lsof)
//   command-launch  --steps <json> --command <OpenTune-AI.command> --mcp <bundle> --exe <app executable> (--data-dir <new dir> | --home <home>)
//            [--tty] [--template <dir>] [--out <json>] [--timeout <seconds>]   runs the launcher script (without a terminal, or
//            with --tty under a pseudo terminal as in a Terminal window), waits for the discovery file, attaches through
//            MCP (opentune_get_status) and ends the instance it started
//   d3d12    --steps <json> --platform macos      (one N/A row)
//
// Exit codes: 0 = ok (rows may hold FAIL, see above), 1 = a check failed, 2 = usage error.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { countSmoke, countVitest, findLogs, hashPrefix, parseModelLoad, scrubLog, scrubPath, sha256File } from './e2e-windows.mjs';
import { isMainModule, parseArgs } from './fork-lib.mjs';
import { checkMacosModes, checkPackageEntries, verifySha256Sums } from './release-lib.mjs';

/** N/A: the check does not exist on this platform (D3D12 and the Windows install checks on macOS). It never fails the job and is never a PASS. */
export const RESULTS = ['PASS', 'FAIL', 'SKIP', 'FLAKY-SKIP', 'N/A'];

/** Groups every complete run has; a group without any row means its step did not run. */
export const REQUIRED_GROUPS = ['install', 'models', 'package', 'doctor:no-d3d12', 'launch:no-d3d12', 'd3d12', 'doctor:d3d12', 'launch:d3d12', 'contract', 'smoke', 'log'];

/** The same for the macOS smoke test: one doctor and one launch phase, and a D3D12 group that is all N/A. */
export const REQUIRED_GROUPS_MACOS = ['install', 'models', 'package', 'doctor', 'launch', 'd3d12', 'contract', 'smoke', 'log'];

export const PHASES = { 'no-d3d12': '未复制 D3D12', d3d12: '已复制 D3D12' };

const row = (group, name, result, note = '', seconds = null) => ({ group, name, result, seconds, note: scrubPath(note) });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function readSteps(file) {
  return fs.existsSync(file) ? readJson(file) : [];
}

export function appendSteps(file, rows) {
  const list = readSteps(file);
  list.push(...rows);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

/** Windows path for comparisons: backslashes, no trailing separator, lower case. */
export const normWin = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
export const sameDir = (a, b) => Boolean(a) && Boolean(b) && normWin(a) === normWin(b);
/** True when `p` is inside `root` (not the root itself). */
export const isUnder = (p, root) => Boolean(p) && Boolean(root) && normWin(p).startsWith(`${normWin(root)}\\`);

// ---------------------------------------------------------------------------------------------
// install: where the official installer put OpenTune, its D3D12 folder and the models
// ---------------------------------------------------------------------------------------------

/** Rows for the official installation, and a description of it for the artifact. */
export function inspectInstall({ dir, expectDir, modelsDir, location, version, registryVersion = '', seconds = null }) {
  const rows = [];
  const exe = dir ? path.join(dir, 'OpenTune.exe') : '';
  const where = location === 'custom' ? '自定义目录 /DIR=' : '默认目录';
  const info = { version, location, dir: dir || null, registryVersion: registryVersion || null, seconds, d3d12Files: [], installDirHasModels: null, modelsDir };
  if (!dir) {
    rows.push(row('install', `安装官方 OpenTune ${version}（${where}）`, 'FAIL', '注册表里没有 OpenTune 的卸载项（InstallLocation），找不到实际安装位置', seconds));
    return { rows, info };
  }
  const problems = [];
  if (!fs.existsSync(exe)) problems.push(`${dir} 下没有 OpenTune.exe`);
  if (!sameDir(dir, expectDir)) problems.push(`实际位置 ${dir}，期望 ${expectDir}`);
  if (registryVersion && registryVersion !== version) problems.push(`卸载项的版本是 ${registryVersion}，期望 ${version}`);
  const secs = seconds === null ? '' : `，耗时 ${Number(seconds).toFixed(1)} 秒`;
  rows.push(row('install', `安装官方 OpenTune ${version}（${where}）`, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('；') : `实际位置 ${dir}（卸载项版本 ${registryVersion || '未记录'}）${secs}`, seconds));
  const d3d12Dir = path.join(dir, 'D3D12');
  info.d3d12Files = fs.existsSync(d3d12Dir) ? fs.readdirSync(d3d12Dir).sort() : [];
  const hasCore = info.d3d12Files.some((f) => f.toLowerCase() === 'd3d12core.dll');
  rows.push(row('install', '官方安装里有 D3D12\\D3D12Core.dll', hasCore ? 'PASS' : 'FAIL', `D3D12 文件夹：${info.d3d12Files.join(', ') || '（不存在）'}`));
  info.installDirHasModels = fs.existsSync(path.join(dir, 'models'));
  const modelsOk = Boolean(modelsDir) && fs.existsSync(modelsDir) && fs.statSync(modelsDir).isDirectory();
  const kind = isUnder(modelsDir, dir) ? '安装目录里' : '共享目录';
  rows.push(row('install', `模型在这个版本的安装程序放置的目录（${kind}）`, modelsOk ? 'PASS' : 'FAIL', `${modelsDir}${modelsOk ? ' 存在' : ' 不存在'}；安装目录下${info.installDirHasModels ? '有' : '没有'} models\\`));
  return { rows, info };
}

// ---------------------------------------------------------------------------------------------
// package: the extracted folder (outside Program Files, SHA256SUMS, allow-list)
// ---------------------------------------------------------------------------------------------

/** Every file and folder below dir, '/'-separated, with the first bytes and the Unix mode of each file (a symbolic link is listed, not followed). */
export function listPackageDir(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(e.parentPath ?? e.path, e.name);
    const rel = path.relative(dir, full).split(path.sep).join('/');
    const st = fs.lstatSync(full);
    if (st.isDirectory()) out.push({ path: rel, isDir: true, mode: st.mode });
    else if (st.isSymbolicLink()) out.push({ path: rel, isDir: false, head: Buffer.alloc(0), mode: st.mode });
    else {
      const fd = fs.openSync(full, 'r');
      const head = Buffer.alloc(64);
      const n = fs.readSync(fd, head, 0, 64, 0);
      fs.closeSync(fd);
      out.push({ path: rel, isDir: false, head: head.subarray(0, n), mode: st.mode });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Rows for the extracted package folder. `programFiles`: the Program Files folders it must not be in. */
export function inspectPackage({ dir, programFiles = [], documented = '', seconds = null }) {
  const rows = [];
  const inside = programFiles.filter((p) => p && (sameDir(dir, p) || isUnder(dir, p)));
  rows.push(row('package', '解压到 Program Files 之外的文件夹', inside.length ? 'FAIL' : 'PASS', inside.length ? `${dir} 在 ${inside[0]} 下` : `${dir}`, seconds));
  if (!fs.existsSync(dir)) {
    rows.push(row('package', 'SHA256SUMS 与解压出的文件一致', 'FAIL', `${dir} 不存在`));
    return rows;
  }
  const entries = listPackageDir(dir);
  const sumsFile = path.join(dir, 'SHA256SUMS');
  let sumProblems;
  if (!fs.existsSync(sumsFile)) sumProblems = ['SHA256SUMS missing'];
  else {
    const hashes = new Map(entries.filter((e) => !e.isDir && e.path !== 'SHA256SUMS' && !e.path.includes('/')).map((e) => [e.path, sha256File(path.join(dir, e.path))]));
    sumProblems = verifySha256Sums(fs.readFileSync(sumsFile, 'utf8'), hashes);
  }
  if (documented.trim()) sumProblems.push(`INSTALL 第 3 步的校验命令有输出：${documented.trim()}`);
  const files = entries.filter((e) => !e.isDir).length;
  rows.push(row('package', 'SHA256SUMS 与解压出的文件一致（含 INSTALL 第 3 步的命令）', sumProblems.length ? 'FAIL' : 'PASS', sumProblems.length ? sumProblems.slice(0, 5).join('；') : `${files} 个文件一致；INSTALL 的校验命令没有输出`));
  const listProblems = checkPackageEntries(entries);
  rows.push(row('package', '白名单：没有 models\\、*.onnx、D3D12 文件或子目录', listProblems.length ? 'FAIL' : 'PASS', listProblems.length ? listProblems.slice(0, 5).join('；') : '与白名单完全一致；没有会遮住官方模型的 models\\'));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// macOS: the same questions for the macOS arm64 package next to an official OpenTune.app
// ---------------------------------------------------------------------------------------------

/**
 * Path for comparisons on macOS: '/'-separated, no trailing slash. Paths are compared as written (the log prints the real
 * path); the platform's own separator is mapped to '/', which changes nothing on macOS and lets the unit tests run on Windows.
 */
export const normPosix = (p) => String(p ?? '').split(path.sep).join('/').replace(/\/+$/, '');
export const samePosix = (a, b) => Boolean(a) && Boolean(b) && normPosix(a) === normPosix(b);
/** True when `p` is inside `root` (not the root itself). */
export const isUnderPosix = (p, root) => Boolean(p) && Boolean(root) && normPosix(p).startsWith(`${normPosix(root)}/`);

/** Rows for the official macOS installation (pkg: sudo installer; dmg: copied to /Applications), and a description of it for the artifact. */
export function inspectInstallMacos({ app, expectApp, modelsDir, version, plistVersion = '', kind = 'pkg', seconds = null }) {
  const rows = [];
  const how = kind === 'dmg' ? '挂载 dmg，把 OpenTune.app 拷到 /Applications' : 'sudo installer -pkg … -target /';
  const name = `安装官方 OpenTune ${version}（${how}）`;
  const info = { version, kind, app: app || null, plistVersion: plistVersion || null, seconds, modelsDir, appHasModels: null };
  if (!app) {
    rows.push(row('install', name, 'FAIL', '安装后找不到 OpenTune.app', seconds));
    return { rows, info };
  }
  const problems = [];
  if (!fs.existsSync(path.join(app, 'Contents', 'MacOS', 'OpenTune'))) problems.push(`${app} 下没有 Contents/MacOS/OpenTune`);
  if (!samePosix(app, expectApp)) problems.push(`实际位置 ${app}，期望 ${expectApp}`);
  if (plistVersion && plistVersion !== version) problems.push(`Info.plist 的版本是 ${plistVersion}，期望 ${version}`);
  const secs = seconds === null ? '' : `，耗时 ${Number(seconds).toFixed(1)} 秒`;
  rows.push(row('install', name, problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('；') : `实际位置 ${app}（Info.plist 版本 ${plistVersion || '未记录'}）${secs}`, seconds));
  info.appHasModels = fs.existsSync(path.join(app, 'Contents', 'Resources', 'models'));
  const modelsOk = Boolean(modelsDir) && fs.existsSync(modelsDir) && fs.statSync(modelsDir).isDirectory();
  const where = isUnderPosix(modelsDir, app) ? '应用包里' : '共享目录';
  rows.push(row('install', `模型在这个版本的安装程序放置的目录（${where}）`, modelsOk ? 'PASS' : 'FAIL', `${modelsDir}${modelsOk ? ' 存在' : ' 不存在'}；应用包的 Contents/Resources 下${info.appHasModels ? '有' : '没有'} models/`));
  return { rows, info };
}

/**
 * Rows for the extracted macOS package folder: outside the official app, SHA256SUMS (the nested file list),
 * and the allow-list with the Unix modes (executables, no symbolic links, no models or LFS pointers).
 */
export function inspectPackageMacos({ dir, officialApp = '', documented = '', seconds = null, listFn = listPackageDir }) {
  const rows = [];
  const inside = Boolean(officialApp) && (samePosix(dir, officialApp) || isUnderPosix(dir, officialApp));
  rows.push(row('package', '解压到官方 OpenTune.app 之外的文件夹', inside ? 'FAIL' : 'PASS', inside ? `${dir} 在 ${officialApp} 里` : `${dir}`, seconds));
  if (!fs.existsSync(dir)) {
    rows.push(row('package', 'SHA256SUMS 与解压出的文件一致', 'FAIL', `${dir} 不存在`));
    return rows;
  }
  const entries = listFn(dir);
  const sumsFile = path.join(dir, 'SHA256SUMS');
  let sumProblems;
  if (!fs.existsSync(sumsFile)) sumProblems = ['SHA256SUMS missing'];
  else {
    const hashes = new Map(entries.filter((e) => !e.isDir && e.path !== 'SHA256SUMS' && !((e.mode & 0o170000) === 0o120000)).map((e) => [e.path, sha256File(path.join(dir, e.path))]));
    sumProblems = verifySha256Sums(fs.readFileSync(sumsFile, 'utf8'), hashes);
  }
  if (documented.trim()) sumProblems.push(`INSTALL 的校验命令（shasum）有失败输出：${documented.trim()}`);
  const files = entries.filter((e) => !e.isDir).length;
  rows.push(row('package', 'SHA256SUMS 与解压出的文件一致（含 INSTALL 的 shasum 命令）', sumProblems.length ? 'FAIL' : 'PASS', sumProblems.length ? sumProblems.slice(0, 5).join('；') : `${files} 个文件一致；INSTALL 的校验命令没有失败行`));
  const listProblems = [...checkPackageEntries(entries, { platform: 'macos-arm64' }), ...checkMacosModes(entries)];
  rows.push(row('package', '白名单：没有 models/、*.onnx、D3D12 文件、符号链接或 LFS 指针；启动脚本与可执行文件有执行权限', listProblems.length ? 'FAIL' : 'PASS', listProblems.length ? listProblems.slice(0, 5).join('；') : '与白名单完全一致；没有会遮住官方模型的 models/'));
  return rows;
}

/** macOS has no D3D12 and no Agility runtime: the group exists so that the table says so explicitly (never a PASS). */
export function inspectD3d12Macos() {
  return [row('d3d12', 'D3D12Core.dll 的复制（INSTALL 第 4 步）与 DirectML', 'N/A', 'macOS 没有 D3D12：包里没有 D3D12 文件（白名单已核对），推理后端由 Core ML 或 CPU 承担')];
}

/** The doctor checks that only exist for Windows (official-install detection, D3D12): on macOS they are N/A whatever the report says. */
export const DOCTOR_WINDOWS_ONLY = ['OT_NO_OFFICIAL_INSTALL', 'OT_VERSION_UNSUPPORTED', 'OT_MODELS_MISSING', 'OT_SIDECAR_INCOMPLETE', 'OT_MODELS_SHADOWED', 'OT_D3D12_NOT_COPIED'];

/**
 * Rows for one doctor report on macOS. OT_OPENTUNE_PATH must pass (the variable points at the executable
 * inside the app bundle); the Windows-only checks are N/A, with what the doctor said kept in the note; any other
 * check the doctor reports passes when it passes and fails when it fails.
 */
export function evaluateDoctorMacos(report, { mcpRef = '' } = {}) {
  const checks = new Map((Array.isArray(report?.checks) ? report.checks : []).map((c) => [c.id, c]));
  if (!checks.size) return [row('doctor', 'doctor（macOS）', 'FAIL', 'doctor --json 没有输出检查结果')];
  const rows = [];
  const first = (c) => String(c?.message ?? '').split('\n')[0];
  const opentunePath = checks.get('OT_OPENTUNE_PATH');
  if (!opentunePath || opentunePath.status === 'not_implemented') rows.push(row('doctor', 'doctor OT_OPENTUNE_PATH：OPENTUNE_MCP_OPENTUNE_PATH 指向应用包里的可执行文件', 'SKIP', `MCP ${mcpRef || 'ref'} 没有实现或没有列出这一项`));
  else rows.push(row('doctor', 'doctor OT_OPENTUNE_PATH：OPENTUNE_MCP_OPENTUNE_PATH 指向应用包里的可执行文件', opentunePath.status === 'pass' ? 'PASS' : 'FAIL', `${opentunePath.status}：${first(opentunePath)}`));
  for (const id of DOCTOR_WINDOWS_ONLY) {
    const c = checks.get(id);
    rows.push(row('doctor', `doctor ${id}`, 'N/A', c ? `Windows 专有检查，macOS 不适用（doctor 报告 ${c.status}：${first(c)}）` : 'Windows 专有检查，macOS 不适用（doctor 输出里没有这一项）'));
  }
  for (const [id, c] of checks) {
    if (id === 'OT_OPENTUNE_PATH' || DOCTOR_WINDOWS_ONLY.includes(id)) continue;
    if (c.status === 'not_implemented') rows.push(row('doctor', `doctor ${id}`, 'SKIP', `MCP ${mcpRef || 'ref'} 尚未实现这一项`));
    else rows.push(row('doctor', `doctor ${id}`, c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'SKIP' : 'FAIL', `${c.status}：${first(c)}`));
  }
  return rows;
}

/**
 * Rows for one start through MCP on macOS: launch, ONNX Runtime image from the package's own app bundle,
 * the models folder of the official app, inference without a crash, and the backend (Core ML or CPU).
 * `facts.ortImages`: the onnxruntime images the process has mapped (lsof), from runMcpLaunch.
 */
export function evaluateLaunchMacos({ facts, log, appDir, officialApp, modelsDir }) {
  const group = 'launch';
  const rows = [];
  const l = facts.launch ?? {};
  const launchOk = l.state === 'READY' && l.launched === true && Boolean(l.pid) && !(facts.problems ?? []).some((p) => /no pid reported/.test(p));
  rows.push(row(group, '经 MCP 的 opentune_launch 启动应用包里的可执行文件', launchOk ? 'PASS' : 'FAIL', `state ${l.state ?? '(无)'}，launched ${l.launched ?? '(无)'}，workingDirectory ${l.workingDirectory ?? '(无)'}${l.reason ? `，reason ${l.reason}` : ''}${facts.problems?.length ? `；${facts.problems.join('；')}` : ''}`, facts.launchSeconds ?? null));

  const images = [...new Set([...(facts.ortImages ?? []), ...(log.runtime?.ortDll ? [log.runtime.ortDll] : [])])].filter((p) => /onnxruntime/i.test(p));
  const ours = images.filter((p) => isUnderPosix(p, appDir));
  const foreign = images.filter((p) => !isUnderPosix(p, appDir));
  let ortNote = log.ortFailed ? 'ensureOnnxRuntimeLoaded failed' : facts.ortError ? `lsof: ${facts.ortError}` : '进程没有映射任何 onnxruntime 动态库（lsof），日志里也没有 ORT 路径';
  if (images.length) ortNote = images.join('；');
  rows.push(row(group, '加载的 ONNX Runtime 动态库来自这个包的应用包（Contents/Frameworks），不是官方 OpenTune.app', ours.length > 0 && foreign.length === 0 && !isUnderPosix(ours[0], officialApp) ? 'PASS' : 'FAIL', ortNote));

  const rt = log.runtime;
  const last = log.loads.at(-1) ?? null;
  const modelsOk = rt ? samePosix(rt.modelsDir, modelsDir) : Boolean(last) && isUnderPosix(last.path, modelsDir);
  rows.push(row(group, '日志里的模型目录是官方安装的模型目录', modelsOk ? 'PASS' : 'FAIL', rt ? `modelsDir=${rt.modelsDir}` : last ? `没有 ProcessF0Runtime 一行；F0 模型加载自 ${last.path}` : '日志里没有 modelsDir，也没有加载 F0 模型'));

  const inferOk = Boolean(last) && facts.aliveAfter === true && facts.status === 'READY';
  rows.push(row(group, '导入后推理不崩溃（F0 模型已加载，进程仍在，状态 READY）', inferOk ? 'PASS' : 'FAIL', `F0 模型${last ? `已加载（${last.backend}），用时 ${facts.f0Seconds ?? '?'} 秒` : '未加载'}；进程${facts.aliveAfter === true ? '仍在' : facts.aliveAfter === false ? '已退出' : '未知'}；opentune_get_status ${facts.status ?? '(无)'}${facts.open && !facts.open.ok ? `；opentune_open_audio 出错：${facts.open.note}` : ''}`, facts.f0Seconds ?? null));

  const backendOk = last?.backend === 'CoreML' || last?.backend === 'CPU';
  rows.push(row(group, '推理后端为 Core ML 或 CPU', backendOk ? 'PASS' : 'FAIL', `F0 后端 ${last?.backend ?? '(无推理)'}${last?.backend === 'CPU' ? '（runner 没有可用的 Core ML 加速时回退到 CPU，属正常）' : ''}`));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// doctor: the checks of `opentune-mcp doctor --json`, by check id
// ---------------------------------------------------------------------------------------------

/**
 * What each phase expects of the doctor checks. `pass`: the check passes (no problem found);
 * `reported`: the check reports the problem (warn or fail). Check ids are those of the MCP repository.
 */
export const DOCTOR_EXPECT = {
  'no-d3d12': [
    ['OT_NO_OFFICIAL_INSTALL', 'pass', '找到官方安装（实际安装位置）'],
    ['OT_OPENTUNE_PATH', 'pass', 'OPENTUNE_MCP_OPENTUNE_PATH 指向带控制接口的 side-car exe'],
    ['OT_VERSION_UNSUPPORTED', 'pass', '官方版本受支持'],
    ['OT_MODELS_MISSING', 'pass', '官方模型完整'],
    ['OT_SIDECAR_INCOMPLETE', 'pass', 'side-car 完整'],
    ['OT_MODELS_SHADOWED', 'pass', '没有被遮住的模型（side-car 里没有 models\\）'],
    ['OT_D3D12_NOT_COPIED', 'reported', '报告未复制 D3D12'],
  ],
  d3d12: [
    ['OT_D3D12_NOT_COPIED', 'pass', '复制后不再报告 D3D12'],
    ['OT_NO_OFFICIAL_INSTALL', 'pass', '仍找到官方安装'],
  ],
};

/** Rows for one doctor report. Checks the MCP doctor does not implement (or does not list) are SKIP. */
export function evaluateDoctor(report, { phase, installDir, mcpRef = '' }) {
  const group = `doctor:${phase}`;
  const expect = DOCTOR_EXPECT[phase];
  if (!expect) throw new Error(`unknown phase ${phase}`);
  const checks = new Map((Array.isArray(report?.checks) ? report.checks : []).map((c) => [c.id, c]));
  if (!checks.size) return [row(group, `doctor（${PHASES[phase]}）`, 'FAIL', 'doctor --json 没有输出检查结果')];
  const rows = [];
  for (const [id, want, what] of expect) {
    const name = `doctor ${id}：${what}`;
    const c = checks.get(id);
    if (!c) {
      rows.push(row(group, name, 'SKIP', `doctor 输出里没有这一项（MCP ${mcpRef || 'ref'}）`));
      continue;
    }
    if (c.status === 'not_implemented') {
      rows.push(row(group, name, 'SKIP', `MCP ${mcpRef || 'ref'} 尚未实现这一项`));
      continue;
    }
    const first = String(c.message ?? '').split('\n')[0];
    let ok = want === 'pass' ? c.status === 'pass' : c.status === 'warn' || c.status === 'fail';
    let note = `${c.status}：${first}`;
    if (ok && id === 'OT_NO_OFFICIAL_INSTALL' && installDir && !normWin(c.message).includes(normWin(installDir))) {
      ok = false;
      note = `找到的不是实际安装位置 ${installDir}：${first}`;
    }
    rows.push(row(group, name, ok ? 'PASS' : 'FAIL', note));
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// launch: the OpenTune log of a start through MCP
// ---------------------------------------------------------------------------------------------

/**
 * Facts from OpenTune log text: which ONNX Runtime DLL was loaded and which models folder was used
 * (`ProcessF0Runtime: onnxRuntime=<dll> modelsDir=<dir>`), the F0 model loads with their backend,
 * whether a DirectX 12 GPU was found, and DirectML failure lines.
 */
export function parseLaunchLog(text) {
  const t = String(text);
  const runtimes = [...t.matchAll(/ProcessF0Runtime: onnxRuntime=(.*?) modelsDir=([^\r\n]*)/g)].map((m) => ({ ortDll: m[1].trim(), modelsDir: m[2].trim() }));
  const selected = [...t.matchAll(/\[AccelerationDetector\] Selected backend: ([A-Za-z]+)/g)].map((m) => m[1]);
  return {
    runtime: runtimes.at(-1) ?? null,
    ortFailed: /ProcessF0Runtime: ensureOnnxRuntimeLoaded failed/.test(t),
    loads: parseModelLoad(t),
    noGpu: /\[AccelerationDetector\] No DirectX 12 compatible GPU found/.test(t),
    selectedBackend: selected.at(-1) ?? null,
    dmlFailures: [...new Set([...t.matchAll(/[^\r\n]*DML EP[^\r\n]*(?:fail|unavailable|null)[^\r\n]*/gi)].map((m) => m[0].replace(/^.*?\[/, '[').trim()))],
  };
}

/** Rows for one start through MCP: launch, ORT DLL, models folder, inference without a crash, backend. */
export function evaluateLaunch({ phase, facts, log, sidecarDir, officialDir, modelsDir }) {
  const group = `launch:${phase}`;
  const tag = `（${PHASES[phase]}）`;
  const rows = [];
  const l = facts.launch ?? {};
  const launchOk = l.state === 'READY' && l.launched === true && l.workingDirectory === 'official_install' && !(facts.problems ?? []).some((p) => /no pid reported/.test(p));
  rows.push(row(group, `经 MCP 的 opentune_launch 启动 side-car${tag}`, launchOk ? 'PASS' : 'FAIL', `state ${l.state ?? '(无)'}，launched ${l.launched ?? '(无)'}，workingDirectory ${l.workingDirectory ?? '(无)'}${l.reason ? `，reason ${l.reason}` : ''}${facts.problems?.length ? `；${facts.problems.join('；')}` : ''}`, facts.launchSeconds ?? null));

  const rt = log.runtime;
  let ortResult = 'FAIL';
  let ortNote = log.ortFailed ? 'ensureOnnxRuntimeLoaded failed' : '日志里没有 "ProcessF0Runtime: onnxRuntime=" 一行';
  if (rt) {
    ortResult = isUnder(rt.ortDll, sidecarDir) && !isUnder(rt.ortDll, officialDir) ? 'PASS' : 'FAIL';
    ortNote = rt.ortDll;
  }
  rows.push(row(group, `加载的 ORT DLL 来自 side-car 目录，不是官方安装目录${tag}`, ortResult, ortNote));
  rows.push(row(group, `日志里的 modelsDir 是官方安装的模型目录${tag}`, rt && sameDir(rt.modelsDir, modelsDir) ? 'PASS' : 'FAIL', rt ? `modelsDir=${rt.modelsDir}` : '日志里没有 modelsDir'));

  const last = log.loads.at(-1) ?? null;
  const inferOk = Boolean(last) && facts.aliveAfter === true && facts.status === 'READY';
  rows.push(row(group, `导入后推理不崩溃（F0 模型已加载，进程仍在，状态 READY）${tag}`, inferOk ? 'PASS' : 'FAIL', `F0 模型${last ? `已加载（${last.backend}），用时 ${facts.f0Seconds ?? '?'} 秒` : '未加载'}；进程${facts.aliveAfter === true ? '仍在' : facts.aliveAfter === false ? '已退出' : '未知'}；opentune_get_status ${facts.status ?? '(无)'}${facts.open && !facts.open.ok ? `；opentune_open_audio 出错：${facts.open.note}` : ''}`, facts.f0Seconds ?? null));

  const env = `检测结果：${log.selectedBackend ?? '未知'}${log.noGpu ? '；没有 DirectX 12 GPU' : ''}${log.dmlFailures.length ? `；${log.dmlFailures.slice(0, 2).join('；')}` : ''}`;
  if (phase === 'no-d3d12') {
    rows.push(row(group, `推理后端为 CPU${tag}`, last?.backend === 'CPU' ? 'PASS' : 'FAIL', `F0 后端 ${last?.backend ?? '(无推理)'}；${env}`));
  } else if (last?.backend === 'DirectML') {
    rows.push(row(group, `复制 D3D12 后用上 DirectML${tag}`, 'PASS', env));
  } else if (last && log.noGpu) {
    rows.push(row(group, `复制 D3D12 后用上 DirectML${tag}`, 'FLAKY-SKIP', `runner 没有 GPU：DirectML 无法初始化，属于环境，不算失败；CPU 推理正常（${env}）`));
  } else {
    rows.push(row(group, `复制 D3D12 后用上 DirectML${tag}`, 'FAIL', `F0 后端 ${last?.backend ?? '(无推理)'}；${env}`));
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// d3d12: the one-time copy of INSTALL step 4
// ---------------------------------------------------------------------------------------------

/** Rows for the copied D3D12 folder: same bytes as the official file, the hash the build expects, nothing else copied. */
export function inspectD3d12({ officialDir, sidecarDir, seconds = null }) {
  const rows = [];
  const official = path.join(officialDir, 'D3D12', 'D3D12Core.dll');
  const copy = path.join(sidecarDir, 'D3D12', 'D3D12Core.dll');
  const officialSha = fs.existsSync(official) ? sha256File(official) : null;
  const copySha = fs.existsSync(copy) ? sha256File(copy) : null;
  const same = officialSha !== null && officialSha === copySha;
  rows.push(row('d3d12', '按 INSTALL 第 4 步复制 D3D12Core.dll，哈希与官方安装中的一致', same ? 'PASS' : 'FAIL', copySha === null ? '复制后的文件不存在' : `${hashPrefix(copySha)}，官方 ${officialSha ? hashPrefix(officialSha) : '(不存在)'}`, seconds));
  let expected = null;
  let agility = '';
  try {
    const control = readJson(path.join(sidecarDir, 'opentune-control.json'));
    expected = control.d3d12?.files?.find((f) => f.name === 'D3D12Core.dll')?.sha256 ?? null;
    agility = control.d3d12?.agilityVersion ?? '';
  } catch {
    expected = null;
  }
  rows.push(row('d3d12', 'D3D12Core.dll 是本构建期望的版本（opentune-control.json 的哈希）', expected !== null && copySha === expected ? 'PASS' : 'FAIL', `期望 ${expected ? hashPrefix(expected) : '(opentune-control.json 没有)'}（Agility ${agility || '?'}），复制的 ${copySha ? hashPrefix(copySha) : '(无)'}`));
  const copied = fs.existsSync(path.dirname(copy)) ? fs.readdirSync(path.dirname(copy)).sort() : [];
  const officialFiles = fs.existsSync(path.dirname(official)) ? fs.readdirSync(path.dirname(official)).sort() : [];
  const onlyCore = copied.length === 1 && copied[0].toLowerCase() === 'd3d12core.dll';
  rows.push(row('d3d12', '只复制了 D3D12Core.dll，没有 D3D12SDKLayers.dll', onlyCore ? 'PASS' : 'FAIL', `side-car 的 D3D12：${copied.join(', ') || '（空）'}；官方的 D3D12：${officialFiles.join(', ') || '（空）'}`));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// results: contract vectors, smoke scenario and the log check, run against the side-car
// ---------------------------------------------------------------------------------------------

export function resultRows({ contract = null, smoke = null, log = null, contractSeconds = null, smokeSeconds = null, contractOutcome = null, smokeOutcome = null }) {
  const rows = [];
  // The two runner steps are continue-on-error: a JSON report that looks fine does not make them pass, the step outcome does.
  // null = the caller does not check the outcome (unit use); the workflow always passes it.
  const outcomeRow = (group, label, outcome) => {
    if (outcome === null || outcome === undefined) return;
    if (outcome !== 'success') rows.push(row(group, `${label}：步骤退出码非 0`, 'FAIL', `某步退出码非 0（步骤结果：${outcome || '(空)'}），即使报告文件看起来正常也不算通过`));
  };
  const counts = (c) => `PASS ${c.pass} / FAIL ${c.fail} / SKIP ${c.skip} / FLAKY-SKIP ${c.flakySkip}`;
  if (!contract) rows.push(row('contract', '契约向量（对 side-car 的 exe）', 'FAIL', '没有结果文件', contractSeconds));
  else {
    const c = countVitest(contract);
    const empty = c.pass + c.fail + c.skip + c.flakySkip === 0;
    rows.push(row('contract', '契约向量（对 side-car 的 exe）', c.fail > 0 || empty ? 'FAIL' : 'PASS', `${counts(c)}${empty ? '；没有任何测试' : ''}${c.failed.length ? `；失败：${c.failed.slice(0, 3).join('；')}` : ''}（带 given 的向量在 exe 上不适用，SKIP 不计为失败）`, contractSeconds));
  }
  if (!smoke) rows.push(row('smoke', '冒烟场景：hello → 导入 → F0 就绪 → AUTO → 导出', 'FAIL', '没有结果文件', smokeSeconds));
  else {
    const c = countSmoke(smoke);
    const notRun = c.skip + c.flakySkip;
    const empty = c.pass + c.fail + notRun === 0;
    rows.push(row('smoke', '冒烟场景：hello → 导入 → F0 就绪 → AUTO → 导出', c.fail > 0 || notRun > 0 || empty ? 'FAIL' : 'PASS', `${counts(c)}${notRun ? '；有未运行的步骤' : ''}${empty ? '；没有任何步骤' : ''}${c.failed.length ? `；失败：${c.failed.slice(0, 3).join('；')}` : ''}`, smokeSeconds));
    for (const s of smoke.steps ?? []) {
      const r = String(s.result ?? '').toUpperCase();
      rows.push(row('smoke', `冒烟：${s.name}`, RESULTS.includes(r) ? r : 'FAIL', String(s.note ?? ''), Number.isFinite(Number(s.ms)) ? Number(s.ms) / 1000 : null));
    }
  }
  outcomeRow('contract', '契约向量', contractOutcome);
  outcomeRow('smoke', '冒烟场景', smokeOutcome);
  if (!log) rows.push(row('log', 'F0 模型来自官方模型目录（契约与冒烟的日志）', 'FAIL', '没有日志检查结果'));
  else rows.push(row('log', 'F0 模型来自官方模型目录（契约与冒烟的日志）', log.ok ? 'PASS' : 'FAIL', `后端 ${log.backend}；${log.f0ModelPath ?? '(无)'}${(log.problems ?? []).length ? `；${log.problems.slice(0, 2).join('；')}` : ''}`));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The step table (job summary and artifact). Missing required groups are FAIL rows. */
export function renderStepSummary(steps, { title = 'side-car 冒烟', packageName = '', mcpRef = '', required = REQUIRED_GROUPS } = {}) {
  const all = [...steps];
  for (const g of required) if (!all.some((s) => s.group === g)) all.push(row(g, `（${g}）`, 'FAIL', '没有结果：这一步没有运行（前面的步骤失败或被跳过）'));
  const counts = Object.fromEntries(RESULTS.map((r) => [r, 0]));
  for (const s of all) {
    if (!RESULTS.includes(s.result)) s.result = 'FAIL';
    counts[s.result] += 1;
  }
  const failed = counts.FAIL > 0;
  const lines = [`### ${title}`, ''];
  if (packageName) lines.push(`测试包：\`${packageName}\``);
  if (mcpRef) lines.push(`MCP 仓库 ref：\`${mcpRef}\``);
  lines.push('', 'SKIP：MCP 的 doctor 尚未实现的检查。FLAKY-SKIP：环境原因（例如 runner 没有 GPU 时 DirectML 无法初始化），不算失败。N/A：这个平台上没有这项检查（例如 macOS 上的 D3D12），不算失败，也不算通过。只有 FAIL（或某组没有结果）使本 job 失败。', '');
  lines.push('| 组 | 步骤 | 结果 | 耗时（秒） | 说明 |', '|---|---|---|---|---|');
  for (const s of all) lines.push(`| ${cell(s.group)} | ${cell(s.name)} | ${s.result} | ${s.seconds === null || s.seconds === undefined ? '' : Number(s.seconds).toFixed(1)} | ${cell(s.note)} |`);
  lines.push('', `合计：PASS ${counts.PASS}，FAIL ${counts.FAIL}，SKIP ${counts.SKIP}，FLAKY-SKIP ${counts['FLAKY-SKIP']}${counts['N/A'] ? `，N/A ${counts['N/A']}` : ''}`, '', failed ? '结果：**FAIL**' : '结果：**PASS**', '');
  return { markdown: scrubPath(lines.join('\n')), failed, counts, steps: all };
}

// ---------------------------------------------------------------------------------------------
// The MCP bundle over stdio, and a start through opentune_launch
// ---------------------------------------------------------------------------------------------

/** Newline-delimited JSON-RPC client for an MCP server on stdio. */
export class McpLineClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-20000);
    });
    child.once('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('the MCP server exited'));
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg.id !== undefined && msg.method !== undefined) {
        // A request from the server (none is expected with empty client capabilities): refuse it.
        this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
    }
  }

  #write(msg) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async initialize(timeoutMs = 30000) {
    const r = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sidecar-smoke', version: '0.0.0' } }, timeoutMs);
    if (r.error) throw new Error(`initialize: ${r.error.message}`);
    this.notify('notifications/initialized');
    return r.result;
  }

  /** Calls a tool; resolves with {isError, body} where body is the structured content. */
  async callTool(name, args, timeoutMs) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const body = r.result?.structuredContent;
    return { isError: r.result?.isError === true, body: body && typeof body === 'object' ? body : {} };
  }

  async stop() {
    this.child.stdin.end();
    const exited = new Promise((resolve) => (this.child.exitCode !== null ? resolve() : this.child.once('exit', resolve)));
    if ((await Promise.race([exited.then(() => 'exited'), sleep(5000).then(() => 'late')])) === 'late') {
      this.child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
  }
}

/** A 16-bit mono PCM WAV of two harmonic tones (A3, B3), 1.1 s each: something with a clear pitch to analyse. */
export function toneWav({ sampleRate = 44100, notes = [220, 246.94], noteSeconds = 1.1 } = {}) {
  const per = Math.round(sampleRate * noteSeconds);
  const n = per * notes.length;
  const data = Buffer.alloc(n * 2);
  const ramp = Math.round(sampleRate * 0.02);
  for (let i = 0; i < n; i++) {
    const k = i % per;
    const f = notes[Math.floor(i / per)];
    const t = i / sampleRate;
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
    const env = Math.min(1, k / ramp, (per - 1 - k) / ramp);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, 0.25 * env * v)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const readLogs = (dir) => findLogs(dir).map((f) => fs.readFileSync(f.full, 'utf8')).join('\n');

/** The onnxruntime images a process has mapped (macOS: lsof -p lists the loaded dylibs as 'txt' entries). */
export function listOrtImages(pid, { exec = execFileSync } = {}) {
  const out = exec('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return [...new Set(String(out).split(/\r?\n/).filter((l) => l.startsWith('n') && /onnxruntime/i.test(l)).map((l) => l.slice(1).trim()))];
}

/**
 * One start through the MCP bundle: opentune_launch with OPENTUNE_MCP_OPENTUNE_PATH = exe and a data
 * folder of its own, an import of a generated tone, a wait for the F0 model to load, then the process
 * and opentune_get_status. The instance is ended at the end, but only when its discovery file in this
 * data folder names the pid that opentune_launch reported (it is then the one this call started).
 * On macOS (`platform: 'macos'`) the onnxruntime images the process has mapped are recorded as well.
 */
export async function runMcpLaunch({ mcp, exe, dataDir, template, timeoutMs = 120000, spawnFn = spawn, platform = 'windows', imagesFn = listOrtImages }) {
  const facts = { launch: null, open: null, f0Seconds: null, aliveAfter: null, status: null, ended: null, problems: [], launchSeconds: null };
  fs.mkdirSync(dataDir, { recursive: true });
  if (template) fs.cpSync(template, dataDir, { recursive: true });
  const wav = path.join(dataDir, 'sidecar-tone.wav');
  fs.writeFileSync(wav, toneWav());
  // Variables of the MCP server and of OpenTune from the calling environment never reach the child: only these do.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^OPENTUNE_/.test(k)));
  const child = spawnFn(process.execPath, [mcp], { stdio: 'pipe', windowsHide: true, env: { ...base, OPENTUNE_MCP_OPENTUNE_PATH: exe, OPENTUNE_DATA_DIR: dataDir } });
  const client = new McpLineClient(child);
  let pid = 0;
  try {
    await client.initialize();
    const t0 = Date.now();
    const launched = await client.callTool('opentune_launch', {}, 90000);
    facts.launchSeconds = (Date.now() - t0) / 1000;
    const b = launched.body;
    pid = Number(b.process?.pid ?? (Array.isArray(b.instances) && b.instances.length === 1 ? b.instances[0]?.pid : 0)) || 0;
    facts.launch = { isError: launched.isError, state: b.state ?? null, reason: b.reason ?? null, launched: b.launched ?? null, workingDirectory: b.workingDirectory ?? null, pid };
    if (b.state !== 'READY') facts.problems.push(`opentune_launch: ${JSON.stringify(b).slice(0, 300)}`);
    else if (!pid) facts.problems.push('opentune_launch: READY but no pid reported');
    if (b.state === 'READY' && pid) {
      const t1 = Date.now();
      const opened = await client.callTool('opentune_open_audio', { path: wav, wait_seconds: 30 }, 90000);
      facts.open = { ok: !opened.isError, note: opened.isError ? JSON.stringify(opened.body).slice(0, 300) : '' };
      while (Date.now() - t1 < timeoutMs && parseModelLoad(readLogs(dataDir)).length === 0 && pidAlive(pid)) await sleep(500);
      if (parseModelLoad(readLogs(dataDir)).length) facts.f0Seconds = (Date.now() - t1) / 1000;
      await sleep(3000); // let inference run on before checking that the process is still there
      facts.aliveAfter = pidAlive(pid);
      if (platform === 'macos' && facts.aliveAfter) {
        try {
          facts.ortImages = imagesFn(pid);
        } catch (e) {
          facts.ortError = String(e.message ?? e).split('\n')[0];
        }
      }
      const status = await client.callTool('opentune_get_status', {}, 30000).catch((e) => ({ isError: true, body: { state: `error: ${e.message}` } }));
      facts.status = status.body.state ?? null;
    }
  } catch (e) {
    facts.problems.push(e.message);
  } finally {
    await client.stop().catch(() => undefined);
    facts.mcpStderrTail = scrubLog(client.stderr.slice(-4000));
    facts.ended = await endOwnInstance(dataDir, pid);
  }
  return { facts, logText: readLogs(dataDir) };
}

/** Ends the OpenTune whose discovery file in <dataDir>/control/instances names `pid`; false when there is none to end. */
export async function endOwnInstance(dataDir, pid) {
  if (!pid || !pidAlive(pid)) return false;
  const file = path.join(dataDir, 'control', 'instances', `${pid}.json`);
  let own = false;
  try {
    own = readJson(file).pid === pid;
  } catch {
    own = false;
  }
  if (!own) return false;
  process.kill(pid);
  for (let i = 0; i < 150 && pidAlive(pid); i++) await sleep(100);
  return !pidAlive(pid);
}

/** The control folder OpenTune uses on macOS when OPENTUNE_DATA_DIR is not set: the parent of control/instances. */
export const macosDefaultControlRoot = (home) => path.join(home, 'Library', 'Application Support', 'OpenTune');

/** Pid of the single instance file <root>/control/instances/<pid>.json, or 0 when there is none yet (or more than one). */
function singleInstance(root) {
  const dir = path.join(root, 'control', 'instances');
  if (!fs.existsSync(dir)) return 0;
  const pids = fs.readdirSync(dir).map((n) => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number);
  return pids.length === 1 ? pids[0] : 0;
}

/**
 * Runs the command ("$@") under a pseudo terminal, as a Terminal window does: macOS's `script` gives it one. `script`
 * copies its own standard input to the pseudo terminal and ends the command when that input ends, and it needs the input
 * to be a pipe or a terminal (not /dev/null, which ends it at once, and not a socket, which Node's 'pipe' stdio is:
 * "tcgetattr/ioctl: Operation not supported on socket"). The process substitution is a real pipe that stays open and idle
 * until the command has returned.
 */
export const TTY_WRAPPER = 'script -q /dev/null "$@" < <(sleep 30)';

/**
 * Starts OpenTune the way a macOS user does after unpacking the package: by running OpenTune-AI.command.
 * With a data folder (OPENTUNE_DATA_DIR) the instance is isolated, and a ready file is asked for through an
 * extra argument to show that arguments reach the app. Without one (`dataDir` empty, `home` given) the
 * default locations under the user's real home are used and the files the app leaves there are recorded.
 * Then the discovery file is awaited and the MCP server attaches to the instance (opentune_get_status).
 * The instance is ended at the end, but only when its discovery file names the pid.
 * Two ways of running the script, as the script itself tells them apart by whether it has a terminal:
 *   - default: no terminal (stdio ignored, like a program that starts it, e.g. OpenTune MCP Server): the script
 *     becomes OpenTune (exec), so the process that was started is the one the discovery file names;
 *   - tty: under a pseudo terminal (TTY_WRAPPER, as in a Terminal window): the script asks macOS to open the app
 *     (open(1)) and returns; OpenTune must be running, and still be, after the script has returned.
 */
export async function runCommandLaunch({ command, mcp, dataDir = '', home = '', template = '', timeoutMs = 90000, spawnFn = spawn, psFn = null, tty = false }) {
  const facts = { mode: tty ? 'tty' : 'exec', exitCode: null, scriptExited: null, scriptPid: 0, pid: 0, sameProcess: null, aliveAfterScript: null, commandLine: '', readyFile: null, status: null, ended: null, seconds: null, settingsDir: null, logs: null, problems: [] };
  const isolated = Boolean(dataDir);
  const root = isolated ? dataDir : macosDefaultControlRoot(home);
  const readyFile = isolated ? path.join(dataDir, 'ready.json') : '';
  if (isolated) {
    fs.mkdirSync(dataDir, { recursive: true });
    if (template) fs.cpSync(template, dataDir, { recursive: true });
  }
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^OPENTUNE_/.test(k)));
  const env = isolated ? { ...base, OPENTUNE_DATA_DIR: dataDir } : base;
  const t0 = Date.now();
  let client = null;
  let pid = 0;
  try {
    const args = readyFile ? [`--control-api-ready-file=${readyFile}`] : [];
    const sh = tty ? spawnFn('bash', ['-c', TTY_WRAPPER, 'bash', command, ...args], { stdio: 'ignore', env }) : spawnFn(command, args, { stdio: 'ignore', env });
    facts.scriptPid = sh.pid ?? 0;
    facts.scriptExited = false;
    const exited = new Promise((resolve) => {
      sh.once('error', () => {
        facts.exitCode = -1;
        facts.scriptExited = true;
        resolve();
      });
      sh.once('exit', (code) => {
        facts.exitCode = code;
        facts.scriptExited = true;
        resolve();
      });
    });
    while (!pid && Date.now() - t0 < timeoutMs) {
      pid = singleInstance(root);
      if (pid) break;
      if (facts.scriptExited && facts.exitCode !== 0 && !tty) break; // the script failed: nothing will appear
      await sleep(500);
    }
    facts.pid = pid;
    facts.seconds = (Date.now() - t0) / 1000;
    if (!pid) facts.problems.push(`no discovery file appeared in ${path.join(root, 'control', 'instances')} within ${Math.round(timeoutMs / 1000)} s`);
    else {
      if (tty) {
        await Promise.race([exited, sleep(15000)]);
        facts.aliveAfterScript = pidAlive(pid);
      } else facts.sameProcess = pid === facts.scriptPid;
      for (let i = 0; i < 20 && readyFile && !(fs.existsSync(readyFile) && fs.statSync(readyFile).size > 0); i++) await sleep(250);
      try {
        facts.commandLine = psFn ? psFn(pid) : String(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })).trim();
      } catch (e) {
        facts.problems.push(`ps: ${String(e.message ?? e).split('\n')[0]}`);
      }
      if (readyFile) facts.readyFile = fs.existsSync(readyFile) && fs.statSync(readyFile).size > 0;
      const child = spawnFn(process.execPath, [mcp], { stdio: 'pipe', env });
      client = new McpLineClient(child);
      await client.initialize();
      const status = await client.callTool('opentune_get_status', {}, 60000).catch((e) => ({ isError: true, body: { state: `error: ${e.message}` } }));
      facts.status = status.body.state ?? null;
      if (!isolated) {
        const settings = path.join(home, 'Library', 'OpenTune');
        facts.settingsDir = fs.existsSync(settings);
        facts.logs = fs.existsSync(path.join(settings, 'Logs')) ? fs.readdirSync(path.join(settings, 'Logs')).filter((n) => n.endsWith('.log')).length : 0;
      }
    }
  } catch (e) {
    facts.problems.push(String(e.message ?? e).split('\n')[0]);
  } finally {
    if (client) await client.stop().catch(() => undefined);
    facts.ended = await endOwnInstance(root, pid);
  }
  return { facts };
}

/** Rows for a start through OpenTune-AI.command. `appExe`: the executable inside the package's app bundle. */
export function evaluateCommandLaunch({ facts, appExe, isolated }) {
  const group = 'launch';
  const where = isolated ? '（OPENTUNE_DATA_DIR 隔离）' : '（默认位置，真实用户目录）';
  const rows = [];
  const found = facts.pid ? `pid ${facts.pid}，${Number(facts.seconds).toFixed(1)} 秒后出现发现文件` : '没有发现文件';
  const problems = facts.problems.length ? `；${facts.problems.join('；')}` : '';
  if (facts.mode === 'tty') {
    // In a Terminal window the script has macOS open the app (open) and returns; OpenTune must outlive it.
    const ok = Boolean(facts.pid) && facts.scriptExited === true && facts.aliveAfterScript === true;
    rows.push(row(group, `在终端里运行 OpenTune-AI.command：请 macOS 打开应用（open），脚本随即返回，OpenTune 继续运行${where}`, ok ? 'PASS' : 'FAIL', `${found}；脚本${facts.scriptExited ? `已返回（退出码 ${facts.exitCode ?? '?'}）` : '没有返回'}；返回后 OpenTune ${facts.aliveAfterScript === true ? '仍在运行' : facts.aliveAfterScript === false ? '已退出' : '未知'}${problems}`, facts.seconds));
  } else {
    // Started by a program (no terminal): the script becomes OpenTune, so the started process is OpenTune itself.
    const ok = Boolean(facts.pid) && facts.sameProcess === true;
    rows.push(row(group, `由程序运行 OpenTune-AI.command（没有终端）：脚本变成 OpenTune，被启动的进程就是 OpenTune${where}`, ok ? 'PASS' : 'FAIL', `${found}；启动的进程 pid ${facts.scriptPid || '(无)'}${facts.sameProcess === false ? '，与发现文件里的 pid 不同' : ''}${problems}`, facts.seconds));
  }
  const cmd = facts.commandLine || '';
  const okCmd = Boolean(cmd) && cmd.includes(appExe) && /(^|\s)--control-api(\s|$)/.test(cmd);
  rows.push(row(group, '应用进程是包里的可执行文件，命令行带 --control-api', okCmd ? 'PASS' : 'FAIL', cmd || '(没有取到命令行)'));
  if (isolated) rows.push(row(group, '脚本的参数原样传给应用（--control-api-ready-file= 写出了就绪文件）', facts.readyFile === true ? 'PASS' : 'FAIL', facts.readyFile === true ? '就绪文件存在' : '就绪文件不存在或为空'));
  rows.push(row(group, `MCP 连上这个实例，opentune_get_status 为 READY${where}`, facts.status === 'READY' ? 'PASS' : 'FAIL', `opentune_get_status ${facts.status ?? '(无)'}${facts.ended === false ? '；实例没有被正常结束' : ''}`));
  if (!isolated) rows.push(row(group, '默认位置：设置与日志在 ~/Library/OpenTune，发现文件在 ~/Library/Application Support/OpenTune/control/instances', facts.settingsDir === true && facts.logs > 0 ? 'PASS' : 'FAIL', `~/Library/OpenTune ${facts.settingsDir ? '存在' : '不存在'}；日志文件 ${facts.logs ?? 0} 个；发现文件${facts.pid ? '在该目录' : '没有出现'}`));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function usage(msg) {
  process.stderr.write(`sidecar-smoke: ${msg}\n`);
  process.exit(2);
}

const CLI_SPEC = {
  steps: 'string', group: 'string', name: 'string', result: 'string', seconds: 'string', note: 'string',
  dir: 'string', 'expect-dir': 'string', 'models-dir': 'string', location: 'string', version: 'string', 'registry-version': 'string', out: 'string',
  documented: 'string', report: 'string', phase: 'string', 'install-dir': 'string', 'mcp-ref': 'string',
  mcp: 'string', exe: 'string', 'data-dir': 'string', template: 'string', 'official-dir': 'string', 'logs-out': 'string', timeout: 'string',
  sidecar: 'string', contract: 'string', smoke: 'string', log: 'string', 'contract-seconds': 'string', 'smoke-seconds': 'string', 'contract-outcome': 'string', 'smoke-outcome': 'string',
  title: 'string', package: 'string', json: 'string',
  // macOS
  platform: 'string', app: 'string', 'expect-app': 'string', kind: 'string', 'official-app': 'string', command: 'string', home: 'string', tty: 'bool',
};

const secondsOpt = (o) => (o.seconds === undefined ? null : Number(o.seconds));
const optJson = (f) => (f && fs.existsSync(f) ? readJson(f) : null);

function printRows(rows) {
  for (const r of rows) process.stdout.write(`${r.result === 'FAIL' ? '::error::' : ''}${r.result} ${r.name}${r.note ? `: ${r.note}` : ''}\n`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  let o;
  try {
    o = parseArgs(rest, CLI_SPEC).opts;
  } catch (e) {
    usage(e.message);
  }
  if (o.platform !== undefined && o.platform !== 'windows' && o.platform !== 'macos') usage('--platform must be windows or macos');
  const mac = o.platform === 'macos';
  const need = (...names) => names.forEach((n) => o[n] ?? usage(`--${n} is required for ${cmd}`));
  const record = (rows, { strict = false } = {}) => {
    appendSteps(o.steps, rows);
    printRows(rows);
    if (strict && rows.some((r) => r.result === 'FAIL')) process.exit(1);
  };
  switch (cmd) {
    case 'step': {
      need('steps', 'group', 'name', 'result');
      if (!RESULTS.includes(o.result)) usage(`--result must be one of ${RESULTS.join(', ')}`);
      record([row(o.group, o.name, o.result, o.note ?? '', secondsOpt(o))]);
      break;
    }
    case 'install': {
      if (mac) {
        need('steps', 'expect-app', 'models-dir', 'version');
        const { rows, info } = inspectInstallMacos({ app: o.app ?? '', expectApp: o['expect-app'], modelsDir: o['models-dir'], version: o.version, plistVersion: o['registry-version'] ?? '', kind: o.kind ?? 'pkg', seconds: secondsOpt(o) });
        if (o.out) fs.writeFileSync(o.out, `${JSON.stringify(info, null, 2)}\n`);
        record(rows, { strict: true });
        break;
      }
      need('steps', 'expect-dir', 'models-dir', 'location', 'version');
      const { rows, info } = inspectInstall({ dir: o.dir ?? '', expectDir: o['expect-dir'], modelsDir: o['models-dir'], location: o.location, version: o.version, registryVersion: o['registry-version'] ?? '', seconds: secondsOpt(o) });
      if (o.out) fs.writeFileSync(o.out, `${JSON.stringify(info, null, 2)}\n`);
      record(rows, { strict: true });
      break;
    }
    case 'package': {
      need('steps', 'dir');
      if (mac) {
        record(inspectPackageMacos({ dir: o.dir, officialApp: o['official-app'] ?? '', documented: o.documented ?? '', seconds: secondsOpt(o) }), { strict: true });
        break;
      }
      const programFiles = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']].filter(Boolean);
      record(inspectPackage({ dir: o.dir, programFiles, documented: o.documented ?? '', seconds: secondsOpt(o) }), { strict: true });
      break;
    }
    case 'doctor': {
      need('steps', 'report');
      if (!mac) need('phase', 'install-dir');
      if (!mac && !PHASES[o.phase]) usage('--phase must be no-d3d12 or d3d12');
      let report = null;
      try {
        report = readJson(o.report);
      } catch {
        report = null;
      }
      if (mac) {
        record(evaluateDoctorMacos(report, { mcpRef: o['mcp-ref'] ?? '' }));
        break;
      }
      record(evaluateDoctor(report, { phase: o.phase, installDir: o['install-dir'], mcpRef: o['mcp-ref'] ?? '' }));
      break;
    }
    case 'launch': {
      need('steps', 'mcp', 'exe', 'data-dir', 'official-dir', 'models-dir');
      if (!mac) need('phase');
      if (!mac && !PHASES[o.phase]) usage('--phase must be no-d3d12 or d3d12');
      const { facts, logText } = await runMcpLaunch({ mcp: o.mcp, exe: o.exe, dataDir: o['data-dir'], template: o.template, timeoutMs: (Number(o.timeout) || 120) * 1000, platform: mac ? 'macos' : 'windows' });
      const log = parseLaunchLog(logText);
      if (o['logs-out']) {
        fs.mkdirSync(o['logs-out'], { recursive: true });
        for (const f of findLogs(o['data-dir'])) fs.writeFileSync(path.join(o['logs-out'], f.rel.replace(/[\\/]+/g, '__')), scrubLog(fs.readFileSync(f.full, 'utf8')));
      }
      if (o.out) fs.writeFileSync(o.out, `${scrubPath(JSON.stringify({ phase: o.phase ?? null, facts, log }, null, 2))}\n`);
      if (mac) {
        // exe = <package>/OpenTune-AI.command (the program the MCP server starts; opentune-control.json sits next to it): the app bundle is its neighbour.
        record(evaluateLaunchMacos({ facts, log, appDir: path.join(path.dirname(o.exe), 'OpenTune-ctl.app'), officialApp: o['official-dir'], modelsDir: o['models-dir'] }));
        break;
      }
      record(evaluateLaunch({ phase: o.phase, facts, log, sidecarDir: path.dirname(o.exe), officialDir: o['official-dir'], modelsDir: o['models-dir'] }));
      break;
    }
    case 'command-launch': {
      // macOS only: start through OpenTune-AI.command (--data-dir: isolated; --home: default locations of that home).
      need('steps', 'command', 'mcp', 'exe');
      if (!o['data-dir'] && !o.home) usage('--data-dir or --home is required for command-launch');
      const { facts } = await runCommandLaunch({ command: o.command, mcp: o.mcp, dataDir: o['data-dir'] ?? '', home: o.home ?? '', template: o.template ?? '', timeoutMs: (Number(o.timeout) || 90) * 1000, tty: Boolean(o.tty) });
      if (o.out) fs.writeFileSync(o.out, `${scrubPath(JSON.stringify({ facts }, null, 2))}\n`);
      record(evaluateCommandLaunch({ facts, appExe: o.exe, isolated: Boolean(o['data-dir']) }));
      break;
    }
    case 'd3d12': {
      if (mac) {
        need('steps');
        record(inspectD3d12Macos());
        break;
      }
      need('steps', 'official-dir', 'sidecar');
      record(inspectD3d12({ officialDir: o['official-dir'], sidecarDir: o.sidecar, seconds: secondsOpt(o) }));
      break;
    }
    case 'results': {
      need('steps');
      const secs = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      record(resultRows({ contract: optJson(o.contract), smoke: optJson(o.smoke), log: optJson(o.log), contractSeconds: secs(o['contract-seconds']), smokeSeconds: secs(o['smoke-seconds']), contractOutcome: o['contract-outcome'] ?? null, smokeOutcome: o['smoke-outcome'] ?? null }));
      break;
    }
    case 'summary': {
      need('steps');
      const r = renderStepSummary(readSteps(o.steps), { title: o.title, packageName: o.package ?? '', mcpRef: o['mcp-ref'] ?? '', required: mac ? REQUIRED_GROUPS_MACOS : REQUIRED_GROUPS });
      if (o.out) fs.appendFileSync(o.out, r.markdown);
      else process.stdout.write(r.markdown);
      if (o.json) fs.writeFileSync(o.json, `${JSON.stringify({ result: r.failed ? 'FAIL' : 'PASS', counts: r.counts, steps: r.steps }, null, 2)}\n`);
      process.exit(r.failed ? 1 : 0);
      break;
    }
    default:
      usage('unknown command (step | install | package | doctor | launch | command-launch | d3d12 | results | summary)');
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`sidecar-smoke: ${e.stack ?? e.message}\n`);
    process.exit(1);
  });
}
