// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// sidecar-smoke helper: the install, package, doctor, launch-log, D3D12 and result checks, the step summary,
// the generated tone and the MCP stdio client (against a stand-in server). No installer, no OpenTune.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sha256File } from '../e2e-windows.mjs';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { formatSha256Sums, PACKAGE_FILES, sha256Hex } from '../release-lib.mjs';
import {
  appendSteps,
  evaluateDoctor,
  evaluateLaunch,
  inspectD3d12,
  inspectInstall,
  inspectPackage,
  isUnder,
  McpLineClient,
  parseLaunchLog,
  readSteps,
  REQUIRED_GROUPS,
  renderStepSummary,
  resultRows,
  runMcpLaunch,
  toneWav,
} from '../sidecar-smoke.mjs';
import { SCRIPTS } from './helpers.mjs';

const MODELS = 'C:\\ProgramData\\OpenTune\\Models';
const SIDECAR = 'D:\\a\\_temp\\ot-sc\\side-car\\OpenTune-1.8.1-rehearsal-abc1234-unofficial-win-x64';
const OFFICIAL = 'C:\\Program Files\\OpenTune';
const results = (rows) => rows.map((r) => r.result);

let tmp;
before(() => {
  tmp = makeTempDir('sidecar');
});
after(() => removeDir(tmp));

describe('paths', () => {
  test('isUnder is case-insensitive, accepts both slash styles and rejects a sibling with the same prefix', () => {
    assert.equal(isUnder('c:/program files/opentune/x.dll', OFFICIAL), true);
    assert.equal(isUnder('C:\\Program Files\\OpenTune-old\\x.dll', OFFICIAL), false);
    assert.equal(isUnder(OFFICIAL, OFFICIAL), false);
  });
});

describe('inspectInstall', () => {
  const make = (name, { d3d12 = ['D3D12Core.dll', 'D3D12SDKLayers.dll'], models = false } = {}) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, 'D3D12'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'OpenTune.exe'), 'exe');
    for (const f of d3d12) fs.writeFileSync(path.join(dir, 'D3D12', f), f);
    if (models) fs.mkdirSync(path.join(dir, 'models'));
    return dir;
  };
  const models = () => {
    const m = path.join(tmp, 'shared-models');
    fs.mkdirSync(m, { recursive: true });
    return m;
  };

  test('passes for the expected folder, with the D3D12 folder and models in the shared folder', () => {
    const dir = make('inst-ok');
    const { rows, info } = inspectInstall({ dir, expectDir: `${dir}\\`, modelsDir: models(), location: 'default', version: '1.8.1', registryVersion: '1.8.1', seconds: 18.3 });
    assert.deepEqual(results(rows), ['PASS', 'PASS', 'PASS']);
    assert.match(rows[0].note, /18\.3 秒/);
    assert.deepEqual(info.d3d12Files, ['D3D12Core.dll', 'D3D12SDKLayers.dll']);
    assert.equal(info.installDirHasModels, false);
  });

  test('fails for another folder, another version, no uninstall entry, no D3D12Core.dll or no shared models', () => {
    const dir = make('inst-bad', { d3d12: [] });
    const { rows } = inspectInstall({ dir, expectDir: path.join(tmp, 'elsewhere'), modelsDir: path.join(tmp, 'no-models'), location: 'custom', version: '1.8.1', registryVersion: '1.7.9' });
    assert.deepEqual(results(rows), ['FAIL', 'FAIL', 'FAIL']);
    assert.match(rows[0].note, /期望/);
    assert.match(rows[0].note, /1\.7\.9/);
    assert.deepEqual(results(inspectInstall({ dir: '', expectDir: 'x', modelsDir: 'y', location: 'default', version: '1.8.1' }).rows), ['FAIL']);
  });
});

describe('inspectPackage', () => {
  const build = (name, extra = () => undefined) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    const names = PACKAGE_FILES.map((f) => (typeof f === 'string' ? f : 'OpenTuneOnnxRuntime_1_24_4.dll')).filter((f) => f !== 'SHA256SUMS');
    for (const n of names) fs.writeFileSync(path.join(dir, n), `content of ${n}`);
    const hashes = new Map(names.map((n) => [n, sha256Hex(Buffer.from(`content of ${n}`))]));
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), formatSha256Sums(hashes));
    extra(dir);
    return dir;
  };

  test('an untouched folder outside Program Files passes', () => {
    const dir = build('pkg-ok');
    assert.deepEqual(results(inspectPackage({ dir, programFiles: [OFFICIAL.replace('\\OpenTune', '')] })), ['PASS', 'PASS', 'PASS']);
  });

  test('a changed file, a models folder, a D3D12 file or output of the documented check fails', () => {
    const changed = build('pkg-changed', (d) => fs.writeFileSync(path.join(d, 'INSTALL.txt'), 'other'));
    assert.deepEqual(results(inspectPackage({ dir: changed })), ['PASS', 'FAIL', 'PASS']);
    const models = build('pkg-models', (d) => fs.mkdirSync(path.join(d, 'models')));
    assert.equal(inspectPackage({ dir: models })[2].result, 'FAIL');
    const d3d = build('pkg-d3d', (d) => fs.writeFileSync(path.join(d, 'D3D12Core.dll'), 'x'));
    assert.match(inspectPackage({ dir: d3d })[2].note, /D3D12/);
    assert.equal(inspectPackage({ dir: build('pkg-doc'), documented: 'MISMATCH: INSTALL.txt' })[1].result, 'FAIL');
  });

  test('a folder below Program Files fails', () => {
    const dir = build('pkg-pf');
    assert.equal(inspectPackage({ dir, programFiles: [tmp] })[0].result, 'FAIL');
  });
});

describe('evaluateDoctor', () => {
  const report = (over = {}) => ({
    name: 'opentune-mcp',
    checks: [
      { id: 'OT_NODE_VERSION', status: 'pass', message: 'Node.js v22' },
      { id: 'OT_OPENTUNE_PATH', status: 'pass', message: 'OPENTUNE_MCP_OPENTUNE_PATH = x, a build with the control API.' },
      { id: 'OT_NO_OFFICIAL_INSTALL', status: 'pass', message: `Official OpenTune installation in ${OFFICIAL} (version "1.8.1", found by its uninstall entry).` },
      ...['OT_VERSION_UNSUPPORTED', 'OT_MODELS_MISSING', 'OT_SIDECAR_INCOMPLETE', 'OT_MODELS_SHADOWED', 'OT_D3D12_NOT_COPIED'].map((id) => ({ id, status: over[id] ?? 'not_implemented', message: 'This check is not implemented yet.' })),
    ],
  });

  test('implemented checks are asserted, checks not implemented yet are SKIP', () => {
    const rows = evaluateDoctor(report(), { phase: 'no-d3d12', installDir: OFFICIAL, mcpRef: 'feature/v1' });
    assert.deepEqual(results(rows), ['PASS', 'PASS', 'SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP']);
    assert.match(rows[2].note, /feature\/v1 尚未实现/);
  });

  test('once implemented: problems must be absent, and D3D12 must be reported before the copy and not after', () => {
    const before = report({ OT_VERSION_UNSUPPORTED: 'pass', OT_MODELS_MISSING: 'pass', OT_SIDECAR_INCOMPLETE: 'pass', OT_MODELS_SHADOWED: 'pass', OT_D3D12_NOT_COPIED: 'warn' });
    assert.deepEqual(results(evaluateDoctor(before, { phase: 'no-d3d12', installDir: OFFICIAL })), Array(7).fill('PASS'));
    const shadowed = report({ OT_MODELS_SHADOWED: 'fail', OT_D3D12_NOT_COPIED: 'pass' });
    assert.deepEqual(results(evaluateDoctor(shadowed, { phase: 'no-d3d12', installDir: OFFICIAL })).slice(5), ['FAIL', 'FAIL']);
    assert.deepEqual(results(evaluateDoctor(report({ OT_D3D12_NOT_COPIED: 'pass' }), { phase: 'd3d12', installDir: OFFICIAL })), ['PASS', 'PASS']);
    assert.deepEqual(results(evaluateDoctor(report({ OT_D3D12_NOT_COPIED: 'warn' }), { phase: 'd3d12', installDir: OFFICIAL })), ['FAIL', 'PASS']);
  });

  test('another installation than the one installed, a missing check id, or no output', () => {
    assert.equal(evaluateDoctor(report(), { phase: 'no-d3d12', installDir: 'D:\\a\\_temp\\ot-sc\\official' })[0].result, 'FAIL');
    const r = report();
    r.checks = r.checks.filter((c) => c.id !== 'OT_MODELS_MISSING');
    assert.match(evaluateDoctor(r, { phase: 'no-d3d12', installDir: OFFICIAL })[3].note, /没有这一项/);
    assert.deepEqual(results(evaluateDoctor(null, { phase: 'd3d12', installDir: OFFICIAL })), ['FAIL']);
  });
});

describe('parseLaunchLog and evaluateLaunch', () => {
  const ort = (dll) => `ProcessF0Runtime: onnxRuntime=${dll} modelsDir=C:\\ProgramData\\OpenTune\\models`;
  const cpuNoGpu = ['[WARN] [AccelerationDetector] No DirectX 12 compatible GPU found', '[INFO] [AccelerationDetector] Selected backend: CPU'];
  const load = (b) => `[INFO] [ModelFactory] Loaded F0 model (${b}): C:\\ProgramData\\OpenTune\\models/fcpe.onnx`;
  const facts = { launch: { state: 'READY', launched: true, workingDirectory: 'official_install', pid: 42 }, aliveAfter: true, status: 'READY', f0Seconds: 2.1, open: { ok: true }, problems: [] };
  const evalLog = (phase, lines, f = facts) => evaluateLaunch({ phase, facts: f, log: parseLaunchLog(lines.join('\n')), sidecarDir: SIDECAR, officialDir: OFFICIAL, modelsDir: MODELS });

  test('no D3D12: everything passes for the side-car ORT DLL, the shared models folder and CPU', () => {
    const lines = [ort(`${SIDECAR}\\OpenTuneOnnxRuntime_1_24_4.dll`), ...cpuNoGpu, load('CPU')];
    assert.deepEqual(results(evalLog('no-d3d12', lines)), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    const p = parseLaunchLog(lines.join('\n'));
    assert.equal(p.noGpu, true);
    assert.equal(p.selectedBackend, 'CPU');
  });

  test('an ORT DLL with spaces in its path from the official folder, or another models folder, fails', () => {
    const rows = evalLog('no-d3d12', [`ProcessF0Runtime: onnxRuntime=${OFFICIAL}\\OpenTuneOnnxRuntime_1_24_4.dll modelsDir=${SIDECAR}\\models`, load('CPU')]);
    assert.deepEqual(results(rows).slice(1, 3), ['FAIL', 'FAIL']);
    assert.match(rows[1].note, /Program Files\\OpenTune\\OpenTuneOnnxRuntime/);
  });

  test('no inference, a dead process, or a launch that is not READY in the official folder fails', () => {
    assert.deepEqual(results(evalLog('no-d3d12', [ort(`${SIDECAR}\\x.dll`)])).slice(3), ['FAIL', 'FAIL']);
    assert.equal(evalLog('no-d3d12', [load('CPU')], { ...facts, aliveAfter: false })[3].result, 'FAIL');
    assert.equal(evalLog('no-d3d12', [load('CPU')], { ...facts, launch: { ...facts.launch, workingDirectory: 'executable_folder' } })[0].result, 'FAIL');
    assert.equal(evalLog('no-d3d12', [], { ...facts, launch: { state: 'NO_API_BUILD', launched: false } })[0].result, 'FAIL');
    assert.equal(evalLog('no-d3d12', [load('DirectML')])[4].result, 'FAIL');
  });

  test('D3D12 copied: DirectML passes, CPU on a runner without a GPU is FLAKY-SKIP, CPU with a GPU fails', () => {
    const side = ort(`${SIDECAR}\\OpenTuneOnnxRuntime_1_24_4.dll`);
    assert.equal(evalLog('d3d12', [side, load('DirectML')])[4].result, 'PASS');
    const flaky = evalLog('d3d12', [side, ...cpuNoGpu, load('CPU')]);
    assert.equal(flaky[4].result, 'FLAKY-SKIP');
    assert.equal(flaky[3].result, 'PASS');
    const dml = evalLog('d3d12', [side, '[INFO] [AccelerationDetector] Selected backend: DirectML', '[WARN] [ModelFactory] DML EP append failed for F0, falling back to CPU', load('CPU')]);
    assert.equal(dml[4].result, 'FAIL');
    assert.match(dml[4].note, /DML EP append failed/);
  });
});

describe('inspectD3d12', () => {
  const setup = (name, { copy = 'core-bytes', layers = false, expected = 'core-bytes' } = {}) => {
    const official = path.join(tmp, `${name}-official`);
    const side = path.join(tmp, `${name}-side`);
    fs.mkdirSync(path.join(official, 'D3D12'), { recursive: true });
    fs.mkdirSync(path.join(side, 'D3D12'), { recursive: true });
    fs.writeFileSync(path.join(official, 'D3D12', 'D3D12Core.dll'), 'core-bytes');
    fs.writeFileSync(path.join(official, 'D3D12', 'D3D12SDKLayers.dll'), 'layers');
    if (copy !== null) fs.writeFileSync(path.join(side, 'D3D12', 'D3D12Core.dll'), copy);
    if (layers) fs.writeFileSync(path.join(side, 'D3D12', 'D3D12SDKLayers.dll'), 'layers');
    const control = { d3d12: { agilityVersion: '1.619.5', files: [{ name: 'D3D12Core.dll', sha256: sha256Hex(Buffer.from(expected)) }] } };
    fs.writeFileSync(path.join(side, 'opentune-control.json'), JSON.stringify(control));
    return { officialDir: official, sidecarDir: side };
  };

  test('a copy of the official D3D12Core.dll with the expected hash passes', () => {
    const rows = inspectD3d12(setup('d3-ok'));
    assert.deepEqual(results(rows), ['PASS', 'PASS', 'PASS']);
    assert.match(rows[0].note, /^[0-9a-f]{12}\.\.\./);
    assert.match(rows[2].note, /D3D12SDKLayers\.dll/);
  });

  test('SDKLayers copied too, another version than the build expects, or no copy fails', () => {
    assert.equal(inspectD3d12(setup('d3-layers', { layers: true }))[2].result, 'FAIL');
    assert.deepEqual(results(inspectD3d12(setup('d3-version', { expected: 'other' }))), ['PASS', 'FAIL', 'PASS']);
    assert.deepEqual(results(inspectD3d12(setup('d3-none', { copy: null }))), ['FAIL', 'FAIL', 'FAIL']);
  });
});

describe('resultRows', () => {
  const contract = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }, { status: 'pending', fullName: 'b' }] }] };
  const smoke = { counts: { PASS: 2, FAIL: 0, SKIP: 0, 'FLAKY-SKIP': 0 }, steps: [{ name: 'hello', result: 'PASS', ms: 7 }, { name: 'export', result: 'PASS', ms: 4531 }] };
  const log = { ok: true, backend: 'CPU', f0ModelPath: `${MODELS}\\fcpe.onnx`, problems: [] };

  test('green results, one row per smoke step with its time', () => {
    const rows = resultRows({ contract, smoke, log });
    assert.deepEqual(results(rows), ['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    assert.equal(rows[3].seconds, 4.531);
  });

  test('a skipped smoke step, an empty contract report or missing files fail', () => {
    const skipped = { steps: [{ name: 'hello', result: 'PASS' }, { name: 'import', result: 'SKIP' }] };
    assert.equal(resultRows({ contract, smoke: skipped, log })[1].result, 'FAIL');
    assert.equal(resultRows({ contract: { testResults: [] }, smoke, log })[0].result, 'FAIL');
    assert.deepEqual(results(resultRows({})), ['FAIL', 'FAIL', 'FAIL']);
  });
});

describe('renderStepSummary and the steps file', () => {
  const all = (result = 'PASS') => REQUIRED_GROUPS.map((g) => ({ group: g, name: g, result, seconds: 1, note: '' }));

  test('SKIP and FLAKY-SKIP do not fail the run, a FAIL or a missing group does', () => {
    const ok = renderStepSummary([...all(), { group: 'doctor:no-d3d12', name: 'x', result: 'SKIP', note: '' }, { group: 'launch:d3d12', name: 'y', result: 'FLAKY-SKIP', note: '' }], { title: 't', packageName: 'p.zip', mcpRef: 'feature/v1' });
    assert.equal(ok.failed, false);
    assert.match(ok.markdown, /合计：PASS 11，FAIL 0，SKIP 1，FLAKY-SKIP 1/);
    assert.match(ok.markdown, /结果：\*\*PASS\*\*/);
    const missing = renderStepSummary(all().filter((s) => s.group !== 'smoke'));
    assert.equal(missing.failed, true);
    assert.match(missing.markdown, /\| smoke \| （smoke） \| FAIL \|/);
    assert.equal(renderStepSummary([...all(), { group: 'd3d12', name: 'z', result: 'FAIL', note: '' }]).failed, true);
  });

  test('notes are scrubbed (user folder, long hex) in the table', () => {
    const hex = 'ab'.repeat(32);
    const r = renderStepSummary([{ group: 'install', name: 'n', result: 'PASS', note: `C:\\Users\\someone\\x ${hex}` }], { required: [] });
    assert.ok(!r.markdown.includes('someone') && !r.markdown.includes(hex), r.markdown);
  });

  test('appendSteps keeps earlier rows; CLI step and summary', () => {
    const file = path.join(tmp, 'steps', 'steps.json');
    appendSteps(file, [{ group: 'install', name: 'a', result: 'PASS', seconds: null, note: '' }]);
    const cli = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'sidecar-smoke.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(cli('step', '--steps', file, '--group', 'models', '--name', 'b', '--result', 'PASS', '--seconds', '2.5').status, 0);
    assert.equal(cli('step', '--steps', file, '--group', 'models', '--name', 'b', '--result', 'MAYBE').status, 2);
    assert.deepEqual(readSteps(file).map((s) => [s.group, s.seconds]), [['install', null], ['models', 2.5]]);
    const json = path.join(tmp, 'steps', 'report.json');
    const r = cli('summary', '--steps', file, '--json', json);
    assert.equal(r.status, 1, 'required groups are missing');
    assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).result, 'FAIL');
  });
});

describe('toneWav', () => {
  test('a 16-bit mono PCM WAV of 2.2 seconds', () => {
    const wav = toneWav();
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt32LE(40), Math.round(44100 * 1.1) * 2 * 2);
    assert.equal(wav.length, 44 + wav.readUInt32LE(40));
  });
});

describe('MCP stdio client (stand-in server)', () => {
  // A stand-in MCP server: answers initialize, and tools/call with a fixed structured result per tool.
  const server = (results) => {
    const file = path.join(tmp, `fake-mcp-${Object.keys(results).join('-')}.mjs`);
    fs.writeFileSync(
      file,
      [
        "import readline from 'node:readline';",
        `const results = ${JSON.stringify(results)};`,
        "const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
        "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
        '  const m = JSON.parse(line);',
        "  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });",
        "  else if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { structuredContent: results[m.params.name] ?? { state: 'UNKNOWN_TOOL' }, isError: !(m.params.name in results) } });",
        "  else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });",
        "  process.stderr.write('handled ' + m.method + '\\n');",
        '});',
      ].join('\n'),
    );
    return file;
  };

  test('McpLineClient: initialize, a tool call and stop', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [server({ opentune_get_status: { state: 'NOT_RUNNING' } })], { stdio: 'pipe' });
    const c = new McpLineClient(child);
    await c.initialize(10000);
    assert.deepEqual(await c.callTool('opentune_get_status', {}, 10000), { isError: false, body: { state: 'NOT_RUNNING' } });
    assert.equal((await c.callTool('other', {}, 10000)).isError, true);
    await c.stop();
    assert.match(c.stderr, /handled tools\/call/);
  });

  test('runMcpLaunch: a launch that does not start OpenTune is reported and nothing is ended', async () => {
    const data = path.join(tmp, 'launch-data');
    const template = path.join(tmp, 'launch-template');
    fs.mkdirSync(template, { recursive: true });
    fs.writeFileSync(path.join(template, 'app-preferences.settings'), '<PROPERTIES/>');
    const { facts, logText } = await runMcpLaunch({ mcp: server({ opentune_launch: { state: 'NO_API_BUILD', launched: false } }), exe: 'C:\\x\\OpenTune.exe', dataDir: data, template, timeoutMs: 1000 });
    assert.equal(facts.launch.state, 'NO_API_BUILD');
    assert.equal(facts.ended, false);
    assert.match(facts.problems.join(' '), /NO_API_BUILD/);
    assert.equal(logText, '');
    assert.ok(fs.existsSync(path.join(data, 'app-preferences.settings')), 'template copied');
    assert.equal(fs.readFileSync(path.join(data, 'sidecar-tone.wav')).toString('ascii', 0, 4), 'RIFF');
  });
});

describe('the helper reads files it wrote', () => {
  test('sha256File of a generated tone is stable', () => {
    const f = path.join(tmp, 'tone.wav');
    fs.writeFileSync(f, toneWav());
    assert.equal(sha256File(f), sha256Hex(toneWav()));
  });
});
