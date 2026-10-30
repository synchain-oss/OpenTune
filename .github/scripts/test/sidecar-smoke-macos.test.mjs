// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// sidecar-smoke helper, macOS part: the official install and package checks, the doctor and launch rows,
// N/A results, the step summary with the macOS groups, the lsof reader and a start through the launcher
// script (stand-in script and stand-in MCP server). No installer, no OpenTune, no macOS needed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { formatSha256Sums, MACOS_APP_FOLDER, MACOS_EXECUTABLES, MACOS_PACKAGE_FILES, sha256Hex } from '../release-lib.mjs';
import {
  evaluateCommandLaunch,
  evaluateDoctorMacos,
  evaluateLaunchMacos,
  inspectD3d12Macos,
  inspectInstallMacos,
  inspectPackageMacos,
  isUnderPosix,
  listOrtImages,
  listPackageDir,
  macosDefaultControlRoot,
  parseLaunchLog,
  renderStepSummary,
  REQUIRED_GROUPS_MACOS,
  RESULTS,
  runCommandLaunch,
  runMcpLaunch,
  samePosix,
  TTY_WRAPPER,
} from '../sidecar-smoke.mjs';
import { SCRIPTS } from './helpers.mjs';

const results = (rows) => rows.map((r) => r.result);
const OFFICIAL = '/Applications/OpenTune.app';
const MODELS = `${OFFICIAL}/Contents/Resources/models`;
const PACKAGE = '/Users/runner/work/_temp/ot-sc/side-car/OpenTune-1.8.1-ctl.1-unofficial-macos-arm64';
const OURS = `${PACKAGE}/${MACOS_APP_FOLDER}`;
const ORT = 'libonnxruntime.1.20.0.dylib';

let tmp;
before(() => {
  tmp = makeTempDir('sidecar-macos');
});
after(() => removeDir(tmp));

describe('POSIX path helpers', () => {
  test('samePosix ignores a trailing slash; isUnderPosix rejects the root itself and a sibling with the same prefix', () => {
    assert.equal(samePosix('/Applications/OpenTune.app/', OFFICIAL), true);
    assert.equal(samePosix('/Applications/OpenTune.app', '/Applications/opentune.app'), false);
    assert.equal(isUnderPosix(MODELS, OFFICIAL), true);
    assert.equal(isUnderPosix(OFFICIAL, OFFICIAL), false);
    assert.equal(isUnderPosix('/Applications/OpenTune.app-old/x', OFFICIAL), false);
  });
});

describe('inspectInstallMacos', () => {
  const make = (name, { models = true, exe = true } = {}) => {
    const app = path.join(tmp, `${name}.app`);
    if (exe) {
      fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'OpenTune'), 'exe');
    }
    const modelsDir = path.join(app, 'Contents', 'Resources', 'models');
    if (models) fs.mkdirSync(modelsDir, { recursive: true });
    return { app, modelsDir };
  };

  test('the app in the expected place, the version of its Info.plist and the models inside the bundle pass', () => {
    const { app, modelsDir } = make('inst-ok');
    const { rows, info } = inspectInstallMacos({ app, expectApp: `${app}/`, modelsDir, version: '1.8.1', plistVersion: '1.8.1', kind: 'pkg', seconds: 31.4 });
    assert.deepEqual(results(rows), ['PASS', 'PASS']);
    assert.match(rows[0].note, /31\.4 秒/);
    assert.match(rows[1].name, /应用包里/);
    assert.equal(info.appHasModels, true);
  });

  test('another place, another version, a missing executable or missing models fail; a dmg install is named as such', () => {
    const { app } = make('inst-bad', { models: false });
    const { rows } = inspectInstallMacos({ app, expectApp: '/Applications/OpenTune.app', modelsDir: path.join(app, 'Contents', 'Resources', 'models'), version: '1.8.1', plistVersion: '1.8.0' });
    assert.deepEqual(results(rows), ['FAIL', 'FAIL']);
    assert.match(rows[0].note, /期望/);
    assert.match(rows[0].note, /1\.8\.0/);
    const noExe = make('inst-noexe', { exe: false });
    assert.equal(inspectInstallMacos({ app: noExe.app, expectApp: noExe.app, modelsDir: noExe.modelsDir, version: '1.8.1' }).rows[0].result, 'FAIL');
    assert.deepEqual(results(inspectInstallMacos({ app: '', expectApp: 'x', modelsDir: 'y', version: '1.8.1' }).rows), ['FAIL']);
    const dmg = make('inst-dmg');
    assert.match(inspectInstallMacos({ app: dmg.app, expectApp: dmg.app, modelsDir: dmg.modelsDir, version: '1.7.9', kind: 'dmg' }).rows[0].name, /dmg/);
  });
});

describe('inspectPackageMacos', () => {
  const content = (p) => `content of ${p}`;
  const names = () => MACOS_PACKAGE_FILES.map((f) => (typeof f === 'string' ? f : `${MACOS_APP_FOLDER}/Contents/Frameworks/${ORT}`)).filter((f) => f !== 'SHA256SUMS');
  const build = (name, extra = () => undefined) => {
    const dir = path.join(tmp, name);
    for (const n of names()) {
      fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
      fs.writeFileSync(path.join(dir, n), content(n));
    }
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), formatSha256Sums(new Map(names().map((n) => [n, sha256Hex(Buffer.from(content(n)))]))));
    extra(dir);
    return dir;
  };
  // A Windows host cannot set Unix modes: give the executables 0755 and the rest 0644 the way the zip would.
  const listFn = (dir) => listPackageDir(dir).map((e) => ({ ...e, mode: e.isDir ? 0o40755 : MACOS_EXECUTABLES.includes(e.path) ? 0o100755 : 0o100644 }));
  const check = (dir, extra = {}) => inspectPackageMacos({ dir, officialApp: OFFICIAL, listFn, ...extra });

  test('an untouched package folder passes: outside the official app, SHA256SUMS, allow-list and modes', () => {
    assert.deepEqual(results(check(build('mpkg-ok'))), ['PASS', 'PASS', 'PASS']);
  });

  test('a changed file, a models folder, a model file, an LFS pointer or a failing shasum fails', () => {
    const changed = build('mpkg-changed', (d) => fs.writeFileSync(path.join(d, 'INSTALL.txt'), 'other'));
    assert.deepEqual(results(check(changed)), ['PASS', 'FAIL', 'PASS']);
    const models = build('mpkg-models', (d) => {
      fs.mkdirSync(path.join(d, MACOS_APP_FOLDER, 'Contents', 'Resources', 'models'), { recursive: true });
      fs.writeFileSync(path.join(d, MACOS_APP_FOLDER, 'Contents', 'Resources', 'models', 'fcpe.onnx'), 'x');
    });
    const rows = check(models);
    assert.equal(rows[2].result, 'FAIL');
    assert.match(rows[2].note, /models|onnx/);
    const lfs = build('mpkg-lfs');
    fs.writeFileSync(path.join(lfs, 'LICENSE.txt'), 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n');
    assert.equal(check(lfs)[2].result, 'FAIL');
    assert.equal(check(build('mpkg-doc'), { documented: 'INSTALL.txt: FAILED;' })[1].result, 'FAIL');
  });

  test('a launcher script without the executable bit, and a package folder inside the official app, fail', () => {
    const dir = build('mpkg-modes');
    const noExec = (d) => listPackageDir(d).map((e) => ({ ...e, mode: e.isDir ? 0o40755 : 0o100644 }));
    const rows = inspectPackageMacos({ dir, officialApp: OFFICIAL, listFn: noExec });
    assert.equal(rows[2].result, 'FAIL');
    assert.match(rows[2].note, /not executable/);
    assert.equal(inspectPackageMacos({ dir, officialApp: path.dirname(dir), listFn })[0].result, 'FAIL');
  });
});

describe('N/A results', () => {
  test('inspectD3d12Macos is one N/A row, never a PASS', () => {
    const rows = inspectD3d12Macos();
    assert.deepEqual(results(rows), ['N/A']);
    assert.ok(RESULTS.includes('N/A'));
    assert.match(rows[0].note, /macOS 没有 D3D12/);
  });

  test('N/A never fails the run and is counted on its own; the macOS groups are required', () => {
    const all = (result = 'PASS') => REQUIRED_GROUPS_MACOS.map((g) => ({ group: g, name: g, result, seconds: 1, note: '' }));
    const ok = renderStepSummary([...all(), { group: 'd3d12', name: 'x', result: 'N/A', note: '' }, { group: 'doctor', name: 'y', result: 'N/A', note: '' }], { required: REQUIRED_GROUPS_MACOS });
    assert.equal(ok.failed, false);
    assert.equal(ok.counts['N/A'], 2);
    assert.match(ok.markdown, /N\/A 2/);
    assert.match(ok.markdown, /结果：\*\*PASS\*\*/);
    const missing = renderStepSummary(all().filter((s) => s.group !== 'launch'), { required: REQUIRED_GROUPS_MACOS });
    assert.equal(missing.failed, true);
    assert.match(missing.markdown, /\| launch \| （launch） \| FAIL \|/);
  });

  test('CLI: a step may be N/A; the macOS summary needs the macOS groups, not the Windows ones', () => {
    const file = path.join(tmp, 'steps', 'macos-steps.json');
    const cli = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'sidecar-smoke.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(cli('d3d12', '--steps', file, '--platform', 'macos').status, 0);
    for (const g of REQUIRED_GROUPS_MACOS.filter((x) => x !== 'd3d12')) assert.equal(cli('step', '--steps', file, '--group', g, '--name', g, '--result', 'PASS').status, 0);
    assert.equal(cli('step', '--steps', file, '--group', 'doctor', '--name', 'OT_D3D12_NOT_COPIED', '--result', 'N/A').status, 0);
    const summary = cli('summary', '--steps', file, '--platform', 'macos');
    assert.equal(summary.status, 0, summary.stdout);
    assert.match(summary.stdout, /N\/A 2/);
    assert.equal(cli('summary', '--steps', file).status, 1, 'the Windows groups are missing');
    assert.equal(cli('summary', '--steps', file, '--platform', 'linux').status, 2);
  });
});

describe('evaluateDoctorMacos', () => {
  const report = (checks) => ({ name: 'opentune-mcp', checks });
  const c = (id, status, message = id) => ({ id, status, message });

  test('the executable-path check passes; Windows-only checks are N/A whatever they say', () => {
    const rows = evaluateDoctorMacos(report([c('OT_OPENTUNE_PATH', 'pass', 'points at the exe'), c('OT_NO_OFFICIAL_INSTALL', 'fail', 'no official install found'), c('OT_D3D12_NOT_COPIED', 'not_implemented')]));
    assert.equal(rows[0].result, 'PASS');
    const windowsOnly = rows.filter((r) => r.name !== 'doctor OT_OPENTUNE_PATH：OPENTUNE_MCP_OPENTUNE_PATH 指向应用包里的可执行文件');
    assert.equal(windowsOnly.length, 6);
    assert.ok(windowsOnly.every((r) => r.result === 'N/A'), JSON.stringify(results(windowsOnly)));
    assert.match(windowsOnly[0].note, /fail：no official install found/, 'what the doctor said stays in the note');
    assert.match(windowsOnly[2].note, /没有这一项/);
  });

  test('other checks follow their status; a failing path check or an empty report fails', () => {
    assert.equal(evaluateDoctorMacos(report([c('OT_OPENTUNE_PATH', 'fail', 'missing')]))[0].result, 'FAIL');
    assert.equal(evaluateDoctorMacos(report([c('OT_SOMETHING_NEW', 'fail', 'broken')])).find((r) => r.name.includes('OT_SOMETHING_NEW')).result, 'FAIL');
    assert.equal(evaluateDoctorMacos(report([c('OT_SOMETHING_NEW', 'warn')])).find((r) => r.name.includes('OT_SOMETHING_NEW')).result, 'SKIP');
    assert.deepEqual(results(evaluateDoctorMacos(null)), ['FAIL']);
    assert.equal(evaluateDoctorMacos(report([c('OT_SOMETHING_NEW', 'pass')]))[0].result, 'SKIP', 'no path check in the report');
  });
});

describe('evaluateLaunchMacos', () => {
  const log = (lines) => parseLaunchLog(lines.join('\n'));
  const runtime = `ProcessF0Runtime: onnxRuntime= modelsDir=${MODELS}`;
  const load = (b, dir = MODELS) => `[INFO] [ModelFactory] Loaded F0 model (${b}): ${dir}/fcpe.onnx`;
  const facts = { launch: { state: 'READY', launched: true, workingDirectory: 'executable_folder', pid: 42 }, aliveAfter: true, status: 'READY', f0Seconds: 2.4, open: { ok: true }, problems: [], ortImages: [`${OURS}/Contents/Frameworks/${ORT}`] };
  const evalLog = (lines, f = facts) => evaluateLaunchMacos({ facts: f, log: log(lines), appDir: OURS, officialApp: OFFICIAL, modelsDir: MODELS });

  test('the ORT image from the package bundle, the official models folder and a Core ML or CPU inference pass', () => {
    assert.deepEqual(results(evalLog([runtime, load('CoreML')])), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    assert.equal(evalLog([runtime, load('CPU')])[4].result, 'PASS');
    // the ProcessF0Runtime line prints an empty ORT path on macOS (the library is linked, not loaded by path)
    assert.equal(log([runtime]).runtime.ortDll, '');
  });

  test('an ORT image from the official app, none at all, another models folder or another backend fails', () => {
    const official = { ...facts, ortImages: [`${OFFICIAL}/Contents/Frameworks/${ORT}`] };
    assert.equal(evalLog([runtime, load('CPU')], official)[1].result, 'FAIL');
    const both = { ...facts, ortImages: [...facts.ortImages, `${OFFICIAL}/Contents/Frameworks/${ORT}`] };
    assert.equal(evalLog([runtime, load('CPU')], both)[1].result, 'FAIL');
    const none = evalLog([runtime, load('CPU')], { ...facts, ortImages: [], ortError: 'lsof: command not found' });
    assert.equal(none[1].result, 'FAIL');
    assert.match(none[1].note, /lsof/);
    assert.equal(evalLog([`ProcessF0Runtime: onnxRuntime= modelsDir=${OURS}/Contents/Resources/models`, load('CPU')])[2].result, 'FAIL');
    assert.equal(evalLog([runtime, load('DirectML')])[4].result, 'FAIL');
  });

  test('without a ProcessF0Runtime line the models folder is taken from where the F0 model was loaded', () => {
    assert.equal(evalLog([load('CPU')])[2].result, 'PASS');
    assert.equal(evalLog([load('CPU', '/somewhere/else')])[2].result, 'FAIL');
    assert.equal(evalLog([])[2].result, 'FAIL');
  });

  test('no inference, a dead process or a launch that is not READY fails', () => {
    assert.equal(evalLog([runtime], facts)[3].result, 'FAIL');
    assert.equal(evalLog([runtime, load('CPU')], { ...facts, aliveAfter: false })[3].result, 'FAIL');
    const noPid = evalLog([runtime, load('CPU')], { ...facts, launch: { ...facts.launch, pid: 0 }, problems: ['opentune_launch: READY but no pid reported'] })[0];
    assert.equal(noPid.result, 'FAIL');
    assert.match(noPid.note, /no pid reported/);
    assert.equal(evalLog([], { ...facts, launch: { state: 'NO_API_BUILD', launched: false } })[0].result, 'FAIL');
  });
});

describe('listOrtImages', () => {
  test('keeps the onnxruntime entries of lsof -Fn output, once each', () => {
    const lsof = ['p42', 'fcwd', 'n/Users/runner', 'ftxt', `n${OURS}/Contents/MacOS/OpenTune`, 'ftxt', `n${OURS}/Contents/Frameworks/${ORT}`, 'ftxt', `n${OURS}/Contents/Frameworks/${ORT}`, ''].join('\n');
    let seen = null;
    const found = listOrtImages(42, { exec: (cmd, args) => ((seen = [cmd, ...args]), lsof) });
    assert.deepEqual(found, [`${OURS}/Contents/Frameworks/${ORT}`]);
    assert.deepEqual(seen, ['lsof', '-p', '42', '-Fn']);
  });
});


describe('runCommandLaunch and evaluateCommandLaunch (stand-in launcher scripts and MCP server)', () => {
  const APP_EXE = `${OURS}/Contents/MacOS/OpenTune`;
  // Stand-in OpenTune-AI.command, no terminal: the script becomes OpenTune (exec). Here the stand-in process itself writes the
  // discovery file under $OPENTUNE_DATA_DIR (or $STAND_IN_HOME) with its own pid, and the ready file when it is asked for one.
  const execScript = path.join(tmp, 'stand-in-exec.mjs');
  // Stand-in under a terminal: starts OpenTune (a long-lived process) in the background, writes its discovery file and returns.
  const backgroundScript = path.join(tmp, 'stand-in-background.mjs');
  const mcpScript = path.join(tmp, 'stand-in-mcp.mjs');
  const common = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const root = process.env.OPENTUNE_DATA_DIR || process.env.STAND_IN_HOME;",
    "const writeFiles = (pid) => {",
    "  fs.mkdirSync(path.join(root, 'control', 'instances'), { recursive: true });",
    "  fs.writeFileSync(path.join(root, 'control', 'instances', pid + '.json'), JSON.stringify({ pid }));",
    "  const ready = process.argv.find((a) => a.startsWith('--control-api-ready-file='));",
    "  if (ready && !process.env.STAND_IN_NO_READY) fs.writeFileSync(ready.slice(ready.indexOf('=') + 1), '{}');",
    '};',
  ];
  before(() => {
    fs.writeFileSync(execScript, [...common, 'writeFiles(process.pid);', 'setInterval(() => {}, 1000);'].join('\n'));
    fs.writeFileSync(
      backgroundScript,
      [
        "import { spawn } from 'node:child_process';",
        ...common,
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
        'child.unref();',
        'writeFiles(child.pid);',
      ].join('\n'),
    );
    fs.writeFileSync(
      mcpScript,
      [
        "import readline from 'node:readline';",
        "const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        '  const m = JSON.parse(line);',
        "  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });",
        "  else if (m.method === 'tools/call') {",
        '    const pid = Number(process.env.STAND_IN_PID) || 0;',
        "    const body = m.params.name === 'opentune_launch' ? { state: 'READY', launched: true, workingDirectory: 'executable_folder', process: { pid } } : { state: process.env.STAND_IN_STATE || 'READY' };",
        "    out({ jsonrpc: '2.0', id: m.id, result: { structuredContent: body, isError: false } });",
        '  }',
        '});',
      ].join('\n'),
    );
  });
  // `exec-cmd` is the stand-in for the script without a terminal, `bg-cmd` the one under a terminal; the wrapper that runs a
  // command under a pseudo terminal (what the tty mode runs) is mapped to the command it wraps.
  const spawnFn = (cmd, args, opts) => {
    if (cmd === 'bash') {
      // The tty mode runs the command through TTY_WRAPPER: macOS's script, whose standard input must be a pipe that stays open.
      assert.deepEqual(args.slice(0, 3), ['-c', TTY_WRAPPER, 'bash']);
      return spawnFn(args[3], args.slice(4), opts);
    }
    if (cmd === 'exec-cmd') return spawn(process.execPath, [execScript, ...args], opts);
    if (cmd === 'bg-cmd') return spawn(process.execPath, [backgroundScript, ...args], opts);
    return spawn(cmd, args, opts);
  };
  const psFn = () => `${APP_EXE} --control-api --control-api-ready-file=/x`;

  test('runMcpLaunch on macOS records the onnxruntime images of the started process (and only there)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.env.STAND_IN_PID = String(child.pid);
    try {
      const mac = await runMcpLaunch({ mcp: mcpScript, exe: APP_EXE, dataDir: path.join(tmp, 'mcp-mac'), template: null, timeoutMs: 300, platform: 'macos', imagesFn: (pid) => [`/images/for/${pid}/${ORT}`] });
      assert.equal(mac.facts.launch.state, 'READY');
      assert.equal(mac.facts.aliveAfter, true);
      assert.deepEqual(mac.facts.ortImages, [`/images/for/${child.pid}/${ORT}`]);
      const failing = await runMcpLaunch({ mcp: mcpScript, exe: APP_EXE, dataDir: path.join(tmp, 'mcp-mac-2'), template: null, timeoutMs: 300, platform: 'macos', imagesFn: () => { throw new Error('lsof: command not found\nmore'); } });
      assert.equal(failing.facts.ortError, 'lsof: command not found');
      const win = await runMcpLaunch({ mcp: mcpScript, exe: APP_EXE, dataDir: path.join(tmp, 'mcp-win'), template: null, timeoutMs: 300, imagesFn: () => ['must not be called'] });
      assert.equal(win.facts.ortImages, undefined);
    } finally {
      delete process.env.STAND_IN_PID;
      child.kill();
    }
  });

  test('no terminal: the started process is the one the discovery file names (exec); the ready file shows the argument arrived', async () => {
    const data = path.join(tmp, 'cmd-exec');
    const { facts } = await runCommandLaunch({ command: 'exec-cmd', mcp: mcpScript, dataDir: data, timeoutMs: 15000, spawnFn, psFn });
    assert.equal(facts.mode, 'exec');
    assert.equal(facts.sameProcess, true);
    assert.equal(facts.pid, facts.scriptPid);
    assert.equal(facts.readyFile, true);
    assert.equal(facts.status, 'READY');
    assert.equal(facts.ended, true);
    assert.deepEqual(results(evaluateCommandLaunch({ facts, appExe: APP_EXE, isolated: true })), ['PASS', 'PASS', 'PASS', 'PASS']);
  });

  test('under a terminal: the script returns and OpenTune keeps running', async () => {
    const data = path.join(tmp, 'cmd-tty');
    const { facts } = await runCommandLaunch({ command: 'bg-cmd', mcp: mcpScript, dataDir: data, timeoutMs: 15000, spawnFn, psFn, tty: true });
    assert.equal(facts.mode, 'tty');
    assert.equal(facts.scriptExited, true);
    assert.equal(facts.exitCode, 0);
    assert.equal(facts.aliveAfterScript, true);
    assert.notEqual(facts.pid, facts.scriptPid, 'OpenTune is a different process from the script');
    const rows = evaluateCommandLaunch({ facts, appExe: APP_EXE, isolated: true });
    assert.deepEqual(results(rows), ['PASS', 'PASS', 'PASS', 'PASS']);
    assert.match(rows[0].name, /终端/);
  });

  test('a launcher that does not become OpenTune without a terminal, one that dies with its window, or an app that is not READY fails', async () => {
    // the background stand-in run without a terminal: the started process is not the instance
    const bg = await runCommandLaunch({ command: 'bg-cmd', mcp: mcpScript, dataDir: path.join(tmp, 'cmd-bg-exec'), timeoutMs: 15000, spawnFn, psFn });
    assert.equal(bg.facts.sameProcess, false);
    assert.equal(evaluateCommandLaunch({ facts: bg.facts, appExe: APP_EXE, isolated: true })[0].result, 'FAIL');
    // under a terminal, OpenTune gone after the script returned
    const gone = { mode: 'tty', exitCode: 0, scriptExited: true, scriptPid: 5, pid: 7, seconds: 1, aliveAfterScript: false, commandLine: `${APP_EXE} --control-api`, readyFile: true, status: 'READY', ended: true, problems: [] };
    assert.equal(evaluateCommandLaunch({ facts: gone, appExe: APP_EXE, isolated: true })[0].result, 'FAIL');
    // the argument did not arrive, and MCP does not see a running instance with the API
    process.env.STAND_IN_NO_READY = '1';
    process.env.STAND_IN_STATE = 'RUNNING_WITHOUT_API';
    try {
      const { facts } = await runCommandLaunch({ command: 'exec-cmd', mcp: mcpScript, dataDir: path.join(tmp, 'cmd-noready'), timeoutMs: 15000, spawnFn, psFn });
      const rows = evaluateCommandLaunch({ facts, appExe: APP_EXE, isolated: true });
      assert.deepEqual(results(rows), ['PASS', 'PASS', 'FAIL', 'FAIL']);
      assert.match(rows[2].name, /参数原样传给应用/);
    } finally {
      delete process.env.STAND_IN_NO_READY;
      delete process.env.STAND_IN_STATE;
    }
  });

  test('no discovery file within the time limit, a failing script, or a command line of another program fails', async () => {
    const quiet = path.join(tmp, 'quiet-command.mjs');
    fs.writeFileSync(quiet, '// exits at once and writes nothing\n');
    const { facts } = await runCommandLaunch({ command: 'quiet', mcp: mcpScript, dataDir: path.join(tmp, 'cmd-quiet'), timeoutMs: 1200, spawnFn: (cmd, args, opts) => spawn(process.execPath, [quiet, ...args], opts), psFn });
    assert.equal(facts.pid, 0);
    assert.equal(evaluateCommandLaunch({ facts, appExe: APP_EXE, isolated: true })[0].result, 'FAIL');
    assert.match(facts.problems.join(' '), /no discovery file/);
    const failing = path.join(tmp, 'failing-command.mjs');
    fs.writeFileSync(failing, 'process.exit(1);\n');
    const t0 = Date.now();
    const bad = await runCommandLaunch({ command: 'failing', mcp: mcpScript, dataDir: path.join(tmp, 'cmd-failing'), timeoutMs: 30000, spawnFn: (cmd, args, opts) => spawn(process.execPath, [failing, ...args], opts), psFn });
    assert.ok(Date.now() - t0 < 20000, 'a script that exits with an error does not make the run wait for the time limit');
    assert.equal(bad.facts.exitCode, 1);
    const other = { mode: 'exec', exitCode: null, scriptExited: false, scriptPid: 7, pid: 7, sameProcess: true, seconds: 1, commandLine: '/usr/bin/other --control-api', readyFile: true, status: 'READY', ended: true, problems: [] };
    assert.equal(evaluateCommandLaunch({ facts: other, appExe: APP_EXE, isolated: true })[1].result, 'FAIL');
    assert.equal(evaluateCommandLaunch({ facts: { ...other, commandLine: `${APP_EXE}` }, appExe: APP_EXE, isolated: true })[1].result, 'FAIL', 'no --control-api');
  });

  test('default locations: the control folder is under Library/Application Support/OpenTune of the home, and its files are reported', async () => {
    const home = path.join(tmp, 'fake-home');
    fs.mkdirSync(path.join(home, 'Library', 'OpenTune', 'Logs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Library', 'OpenTune', 'Logs', 'OpenTune.log'), 'log');
    process.env.STAND_IN_HOME = macosDefaultControlRoot(home);
    try {
      const { facts } = await runCommandLaunch({ command: 'exec-cmd', mcp: mcpScript, home, timeoutMs: 15000, spawnFn, psFn });
      assert.equal(facts.settingsDir, true);
      assert.equal(facts.logs, 1);
      assert.equal(facts.readyFile, null, 'no ready file is asked for in the default-locations run');
      assert.deepEqual(results(evaluateCommandLaunch({ facts, appExe: APP_EXE, isolated: false })), ['PASS', 'PASS', 'PASS', 'PASS']);
    } finally {
      delete process.env.STAND_IN_HOME;
    }
    assert.ok(macosDefaultControlRoot('/Users/x').endsWith('/Library/Application Support/OpenTune') || macosDefaultControlRoot('/Users/x').endsWith('\\Library\\Application Support\\OpenTune'));
  });
});

describe('OpenTune-AI.command template', () => {
  const template = fs.readFileSync(path.join(SCRIPTS, '..', 'release', 'templates', 'macos', 'OpenTune-AI.command'), 'utf8').replace(/\r\n/g, '\n');
  const code = template.split('\n').filter((l) => !l.startsWith('#'));

  test('starts with a shebang and the SPDX header, so the script runs in sh', () => {
    const lines = template.split('\n');
    assert.equal(lines[0], '#!/bin/sh');
    assert.match(lines[1], /SPDX-FileCopyrightText/);
    assert.match(lines[2], /SPDX-License-Identifier: AGPL-3\.0-or-later/);
  });

  test('without a terminal it becomes OpenTune (exec), under a terminal it has macOS open the app', () => {
    assert.ok(code.includes('exec "$exe" --control-api "$@"'), 'exec of the executable, switch first and the arguments passed on');
    assert.ok(code.some((l) => l.trim() === 'exec open "$app" --args --control-api "$@"'));
    assert.ok(code.some((l) => l.trim() === 'exec open "$app" --env "OPENTUNE_DATA_DIR=$OPENTUNE_DATA_DIR" --args --control-api "$@"'));
    assert.ok(code.includes('if [ -t 1 ]; then'));
    // A background child of a terminal session can die with the session: the script does not start the app that way.
    assert.ok(!code.some((l) => /nohup|&\s*$/.test(l)), 'no background start');
  });
});
