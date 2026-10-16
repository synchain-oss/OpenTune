// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e-windows helper: log scrubbing, the models-directory assertion, result counting, the summary, the
// installer / model pin checks, and the shape of the real pin file. No network, no installer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  checkInstaller,
  checkModels,
  hashPrefix,
  pinnedInstaller,
  pinnedModelsDir,
  scrubDir,
  scrubPath,
  countSmoke,
  countVitest,
  hasScenarioReport,
  inspectLog,
  loadScenarioReports,
  parseModelLoad,
  renderSummary,
  scrubLog,
  sha256File,
} from '../e2e-windows.mjs';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { REPO_ROOT, SCRIPTS } from './helpers.mjs';

const PIN_FILE = path.join(REPO_ROOT, '.github', 'e2e', 'official-install.json');
const MODELS = 'C:\\ProgramData\\OpenTune\\Models';

describe('scrubLog', () => {
  test('redacts tokens, serverProof, bearer headers and user names', () => {
    const secret = ['abcDEF', '0123456789', 'abcDEF', '0123456789'].join(''); // assembled at runtime: no secret-shaped literal
    const text = [
      `session token = ${secret}`,
      `{"serverProof":"${secret}"}`,
      `Authorization: Bearer ${secret}`,
      'Log file: C:\\Users\\runneradmin\\AppData\\Roaming\\OpenTune\\Logs\\OpenTune.log',
    ].join('\n');
    const out = scrubLog(text);
    assert.ok(!out.includes(secret), out);
    assert.ok(!out.includes('runneradmin'), out);
    assert.match(out, /C:\\Users\\<user>\\AppData/);
  });

  test('leaves ordinary log lines alone', () => {
    const line = '[ModelFactory] Loaded F0 model (DirectML): C:\\ProgramData\\OpenTune\\Models\\fcpe.onnx';
    assert.equal(scrubLog(line), line);
  });
});

describe('inspectLog', () => {
  const line = (backend, p) => `2026-10-16 01:00:00 [ModelFactory] Loaded F0 model (${backend}): ${p}`;

  test('passes when the F0 model comes from the official models directory, and reports the backend', () => {
    const r = inspectLog(line('CPU', `${MODELS}\\fcpe.onnx`), MODELS);
    assert.equal(r.ok, true);
    assert.equal(r.backend, 'CPU');
    assert.deepEqual(r.problems, []);
  });

  test('matches case-insensitively and across slash styles', () => {
    assert.equal(inspectLog(line('DirectML', 'c:/programdata/opentune/models/fcpe.onnx'), MODELS).ok, true);
  });

  test('fails when the model was loaded from next to the executable', () => {
    const r = inspectLog(line('CPU', 'D:\\a\\build\\models\\fcpe.onnx'), MODELS);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /not from the official models directory/);
  });

  test('a sibling directory with the same prefix does not count', () => {
    assert.equal(inspectLog(line('CPU', `${MODELS}-copy\\fcpe.onnx`), MODELS).ok, false);
  });

  test('fails when no model was loaded at all', () => {
    const r = inspectLog('nothing here', MODELS);
    assert.equal(r.ok, false);
    assert.equal(r.backend, 'unknown');
  });

  test('parseModelLoad finds every load', () => {
    assert.equal(parseModelLoad(`${line('CPU', 'a')}\n${line('DirectML', 'b')}`).length, 2);
  });
});

describe('result counting', () => {
  test('vitest json: PASS / FAIL / SKIP / FLAKY-SKIP are counted apart', () => {
    const report = {
      testResults: [
        {
          name: 'a.test.ts',
          assertionResults: [
            { status: 'passed', fullName: 'one' },
            { status: 'failed', fullName: 'two' },
            { status: 'pending', fullName: 'three' },
            { status: 'skipped', fullName: 'four [FLAKY-SKIP] device' },
            { status: 'todo', fullName: 'five' },
          ],
        },
        { name: 'broken.test.ts', status: 'failed', assertionResults: [] },
      ],
    };
    const c = countVitest(report);
    assert.deepEqual([c.pass, c.fail, c.skip, c.flakySkip], [1, 2, 2, 1]);
    assert.deepEqual(c.failed, ['two', 'broken.test.ts']);
  });

  test('smoke report', () => {
    const c = countSmoke({ steps: [{ name: 'hello', result: 'PASS' }, { name: 'export', result: 'fail' }, { name: 'x', result: 'SKIP' }, { name: 'y', result: 'FLAKY-SKIP' }] });
    assert.deepEqual([c.pass, c.fail, c.skip, c.flakySkip], [1, 1, 1, 1]);
  });
});

describe('smoke report format and empty results', () => {
  test('top-level counts win over the steps array', () => {
    const c = countSmoke({
      result: 'FLAKY-SKIP',
      counts: { PASS: 3, FAIL: 0, SKIP: 1, 'FLAKY-SKIP': 2 },
      steps: [{ name: 'a', result: 'PASS', ms: 1, note: '' }],
    });
    assert.deepEqual([c.pass, c.fail, c.skip, c.flakySkip], [3, 0, 1, 2]);
  });

  test('a report whose result is FAIL never counts as green', () => {
    assert.equal(countSmoke({ result: 'FAIL', steps: [] }).fail, 1);
  });

  test('zero tests or steps is a failure, not a pass', () => {
    const log = { ok: true, backend: 'CPU', f0ModelPath: 'x', problems: [] };
    const some = { steps: [{ name: 'hello', result: 'PASS', ms: 1 }] };
    const r1 = renderSummary({ contract: some && { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }] }] }, smoke: { steps: [] }, log });
    assert.equal(r1.failed, true);
    assert.match(r1.markdown, /没有任何测试或步骤/);
    const r2 = renderSummary({ contract: { testResults: [] }, smoke: some, log });
    assert.equal(r2.failed, true);
    assert.match(r2.markdown, /没有任何测试或步骤/);
  });
});

describe('scrubPath and scrubDir', () => {
  const secret = ['abcDEF', '0123456789', 'abcDEF'].join('');
  test('scrubPath folds the user profile into <home>', () => {
    assert.equal(scrubPath('C:\\Users\\someone\\AppData\\x.onnx'), '<home>\\AppData\\x.onnx');
    assert.equal(scrubPath('c:/Users/someone/x'), '<home>/x');
  });

  test('scrubDir redacts nested json and log files in place', () => {
    const dir = makeTempDir('e2e-scrub');
    try {
      fs.mkdirSync(path.join(dir, 'logs'));
      fs.writeFileSync(path.join(dir, 'contract.json'), JSON.stringify({ failureMessages: [`expected serverProof: "${secret}" at C:\\Users\\someone\\x`] }));
      fs.writeFileSync(path.join(dir, 'logs', 'a.log'), `session token = ${secret}`);
      assert.equal(scrubDir(path.join(dir, 'missing')).length, 0);
      assert.equal(scrubDir(dir).length, 2);
      for (const f of ['contract.json', path.join('logs', 'a.log')]) {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!t.includes(secret) && !t.includes('someone'), t);
      }
    } finally {
      removeDir(dir);
    }
  });
});

describe('hex secrets without a field name', () => {
  const hex64 = 'a1b2c3d4'.repeat(8);
  const hex40 = 'F0e1D2c3B4'.repeat(4);
  test('scrubLog redacts bare 32-128 digit hex, upper case included, in vitest expected/received form', () => {
    const msg = `AssertionError: expected '${hex64}' to be '${hex40}' // sha ${hex40}`;
    const out = scrubLog(msg);
    assert.ok(!out.includes(hex64) && !out.includes(hex40), out);
    assert.match(out, /expected '<redacted-hex>' to be '<redacted-hex>'/);
  });

  test('short hex and ordinary words stay', () => {
    const t = 'build deadbeef 0123456789abcdef x'.concat(' ', 'a'.repeat(31));
    assert.equal(scrubLog(t), t);
  });

  test('scrubDir redacts it in a vitest report', () => {
    const dir = makeTempDir('e2e-hex');
    try {
      fs.writeFileSync(path.join(dir, 'contract.json'), JSON.stringify({ failureMessages: [`expected '${hex64}' to be '${hex64.toUpperCase()}'`] }));
      scrubDir(dir);
      const t = fs.readFileSync(path.join(dir, 'contract.json'), 'utf8');
      assert.ok(!/[0-9a-fA-F]{32}/.test(t), t);
    } finally {
      removeDir(dir);
    }
  });
});

describe('smoke skips fail the run', () => {
  const okLog = { ok: true, backend: 'CPU', f0ModelPath: 'x', problems: [] };
  const okContract = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }, { status: 'pending', fullName: 'b' }] }] };
  test('a SKIP or FLAKY-SKIP smoke step fails and says so; contract skips alone do not', () => {
    for (const result of ['SKIP', 'FLAKY-SKIP']) {
      const smoke = { steps: [{ name: 'hello', result: 'PASS' }, { name: 'import', result: result }] };
      const r = renderSummary({ contract: okContract, smoke, log: okLog });
      assert.equal(r.failed, true, result);
      assert.match(r.markdown, /冒烟有未运行的步骤/);
    }
    const ok = renderSummary({ contract: okContract, smoke: { steps: [{ name: 'hello', result: 'PASS' }] }, log: okLog });
    assert.equal(ok.failed, false);
    assert.match(ok.markdown, /带 given 的向量在 exe 上不适用/);
  });
  test('smoke FAIL is the larger of top-level counts and steps', () => {
    const c = countSmoke({ counts: { PASS: 1, FAIL: 0 }, steps: [{ name: 'a', result: 'FAIL' }] });
    assert.equal(c.fail, 1);
    assert.equal(countSmoke({ counts: { FAIL: 3 }, steps: [{ name: 'a', result: 'FAIL' }] }).fail, 3);
  });
});

describe('renderSummary', () => {
  const okLog = { ok: true, backend: 'CPU', f0ModelPath: `${MODELS}\\fcpe.onnx`, problems: [] };
  const okContract = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }] }] };
  const okSmoke = { steps: [{ name: 'hello', result: 'PASS', ms: 120 }, { name: 'export', result: 'PASS', ms: 900 }] };

  test('all green', () => {
    const { markdown, failed } = renderSummary({ timings: [{ step: 'install', seconds: 12.34 }], contract: okContract, smoke: okSmoke, log: okLog, mcpRef: 'feature/v1' });
    assert.equal(failed, false);
    assert.match(markdown, /后端：\*\*CPU\*\*/);
    assert.match(markdown, /\| install \| 12\.3 \|/);
    assert.match(markdown, /\| hello \| PASS \| 120 \|/);
    assert.match(markdown, /结果：\*\*PASS\*\*/);
  });

  test('a missing result file is a failure, never a silent pass', () => {
    assert.equal(renderSummary({ contract: okContract, smoke: null, log: okLog }).failed, true);
    assert.equal(renderSummary({ contract: null, smoke: okSmoke, log: okLog }).failed, true);
    assert.equal(renderSummary({ contract: okContract, smoke: okSmoke, log: null }).failed, true);
  });

  test('a failed model-directory check fails the run', () => {
    const bad = { ...okLog, ok: false, problems: ['F0 model loaded from X'] };
    const { markdown, failed } = renderSummary({ contract: okContract, smoke: okSmoke, log: bad });
    assert.equal(failed, true);
    assert.match(markdown, /F0 model loaded from X/);
  });

  test('skips do not fail the run but are reported', () => {
    const c = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }, { status: 'pending', fullName: 'b' }] }] };
    const { markdown, failed } = renderSummary({ contract: c, smoke: okSmoke, log: okLog });
    assert.equal(failed, false);
    assert.match(markdown, /\| 契约向量 \| 1 \| 0 \| 1 \| 0 \|/);
  });
});

describe('renderSummary: scenario reports', () => {
  const okLog = { ok: true, backend: 'CPU', f0ModelPath: `${MODELS}\fcpe.onnx`, problems: [] };
  const okContract = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }] }] };
  const okSmoke = { steps: [{ name: 'hello', result: 'PASS', ms: 1 }] };
  const scenario = (name, steps, extra = {}) => ({ scenario: name, report: { schema: 'opentune-mcp-e2e-exe/1', scenario: name, steps: steps.map(([n, r, note]) => ({ name: n, result: r, note })), ...extra } });
  const run = (scenarios) => renderSummary({ contract: okContract, smoke: okSmoke, scenarios, log: okLog });

  test('each scenario gets a row and all-PASS scenarios keep the run green', () => {
    const r = run([scenario('boundary', [['a', 'PASS'], ['b', 'PASS']]), scenario('instances', [['c', 'PASS']])]);
    assert.equal(r.failed, false);
    assert.match(r.markdown, /\| 场景 boundary \| 2 \| 0 \| 0 \| 0 \|/);
    assert.match(r.markdown, /\| 场景 instances \| 1 \| 0 \| 0 \| 0 \|/);
  });

  test('a FAIL in a scenario fails the run and names the step', () => {
    const r = run([scenario('launch-real', [['prepare', 'PASS'], ['two launches at once give one process', 'FAIL', '0 calls started OpenTune'], ['after', 'SKIP']])]);
    assert.equal(r.failed, true);
    assert.match(r.markdown, /\| 场景 launch-real \| 1 \| 1 \| 1 \| 0 \|.*two launches at once give one process/);
    assert.match(r.markdown, /结果：\*\*FAIL\*\*/);
  });

  test('a SKIP or FLAKY-SKIP in a scenario fails the run', () => {
    assert.equal(run([scenario('boundary', [['a', 'PASS'], ['b', 'SKIP']])]).failed, true);
    assert.equal(run([scenario('effects', [['a', 'PASS'], ['b', 'FLAKY-SKIP']])]).failed, true);
  });

  test('a scenario without any step fails; manualChecks are listed under the table', () => {
    assert.equal(run([scenario('effects', [])]).failed, true);
    const r = run([scenario('effects', [['a', 'PASS']], { manualChecks: ['listen to the tuned vocal', { id: 'x', note: 'check the pitch curve' }] })]);
    assert.equal(r.failed, false);
    assert.match(r.markdown, /### 需要人工核对\n\n- effects：listen to the tuned vocal\n- effects：.*check the pitch curve/);
    assert.doesNotMatch(run([scenario('effects', [['a', 'PASS']])]).markdown, /需要人工核对/);
  });

  test('loadScenarioReports takes only opentune-mcp-e2e-* json files and skips the excluded smoke report', () => {
    const dir = makeTempDir('e2e-scn');
    try {
      const put = (n, o) => fs.writeFileSync(path.join(dir, n), typeof o === 'string' ? o : JSON.stringify(o));
      put('smoke.json', { schema: 'opentune-mcp-e2e-exe/1', scenario: 'smoke', steps: [] });
      put('boundary.json', { schema: 'opentune-mcp-e2e-exe/1', scenario: 'boundary', steps: [] });
      put('launch-real.json', { schema: 'opentune-mcp-e2e-launch/2', steps: [] });
      put('timings.json', [{ step: 'x', seconds: 1 }]);
      put('log-report.json', { ok: true });
      put('broken.json', '{not json');
      const got = loadScenarioReports(dir, [path.join(dir, 'smoke.json')]).map((x) => x.scenario);
      assert.deepEqual(got, ['boundary', 'launch-real']);
    } finally {
      removeDir(dir);
    }
  });
});

describe('pin checks (temp files)', () => {
  let tmp;
  before(() => {
    tmp = makeTempDir('e2e-pin');
  });
  after(() => removeDir(tmp));

  test('checkInstaller and checkModels compare sha256', () => {
    const exe = path.join(tmp, 'Setup.exe');
    fs.writeFileSync(exe, 'installer bytes');
    const model = path.join(tmp, 'models');
    fs.mkdirSync(path.join(model, 'GAME'), { recursive: true });
    fs.writeFileSync(path.join(model, 'fcpe.onnx'), 'fcpe');
    fs.writeFileSync(path.join(model, 'GAME', 'encoder.onnx'), 'enc');
    const pin = {
      installer: { sha256: sha256File(exe), size: 15 },
      models: [
        { path: 'fcpe.onnx', sha256: sha256File(path.join(model, 'fcpe.onnx')) },
        { path: 'GAME/encoder.onnx', sha256: sha256File(path.join(model, 'GAME', 'encoder.onnx')) },
      ],
    };
    assert.deepEqual(checkInstaller(pin, exe), []);
    assert.deepEqual(checkModels(pin, model), []);

    fs.writeFileSync(path.join(model, 'fcpe.onnx'), 'changed');
    fs.rmSync(path.join(model, 'GAME', 'encoder.onnx'));
    const sized = { models: [{ path: 'fcpe.onnx', size: 1, sha256: 'x' }] };
    assert.match(checkModels(sized, model)[0], /fcpe\.onnx: size 7, pinned 1/);
    const problems = checkModels(pin, model);
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /fcpe\.onnx: sha256/);
    assert.match(problems.join('\n'), /missing model: GAME\/encoder\.onnx/);

    assert.equal(checkInstaller({ installer: { sha256: '0'.repeat(64), size: 15 } }, exe).length, 1);
    assert.equal(checkInstaller(pin, path.join(tmp, 'nope.exe')).length, 1);
  });

  test('pinnedInstaller: the main installer, an older one by version, or none', () => {
    const pin = { installer: { version: '1.8.1', sha256: 'a' }, olderInstallers: [{ version: '1.7.9', sha256: 'b' }] };
    assert.equal(pinnedInstaller(pin).sha256, 'a');
    assert.equal(pinnedInstaller(pin, '1.8.1').sha256, 'a');
    assert.equal(pinnedInstaller(pin, '1.7.9').sha256, 'b');
    assert.equal(pinnedInstaller(pin, '1.0.0'), null);
    assert.equal(pinnedInstaller({ installer: { version: '1.8.1' } }, '1.7.9'), null);
    assert.match(checkInstaller(pin, path.join(tmp, 'nope.exe'), '1.0.0')[0], /no pinned installer for version 1\.0\.0/);
  });

  test('pinnedModelsDir: the entry\'s own modelsDir with {app}, else the top-level one with %VAR%', () => {
    const pin = { modelsDir: '%ProgramData%\\OpenTune\\Models', installer: { version: '1.8.1' }, olderInstallers: [{ version: '1.7.9', modelsDir: '{app}\\models' }] };
    const env = { ProgramData: 'C:\\ProgramData' };
    assert.equal(pinnedModelsDir(pin, '1.8.1', { appDir: 'C:\\Program Files\\OpenTune', env }), 'C:\\ProgramData\\OpenTune\\Models');
    assert.equal(pinnedModelsDir(pin, '1.7.9', { appDir: 'C:\\Program Files\\OpenTune\\', env }), 'C:\\Program Files\\OpenTune\\models');
    assert.equal(pinnedModelsDir(pin, '1.0.0', { env }), null);
    assert.equal(pinnedModelsDir(pin, undefined, { env: {} }), '%ProgramData%\\OpenTune\\Models', 'an unknown variable stays as written');
    const pinFile = path.join(tmp, 'models-dir-pin.json');
    fs.writeFileSync(pinFile, JSON.stringify(pin));
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'models-dir', '--pin', pinFile, '--version', '1.7.9', '--app', 'D:\\x\\official'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'D:\\x\\official\\models');
  });

  test('the real pin: 1.8.1 uses the shared folder, 1.7.9 the install folder', () => {
    const real = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
    const env = { ProgramData: 'C:\\ProgramData' };
    assert.equal(pinnedModelsDir(real, real.installer.version, { appDir: 'C:\\Program Files\\OpenTune', env }), MODELS);
    assert.equal(pinnedModelsDir(real, '1.7.9', { appDir: 'C:\\Program Files\\OpenTune', env }), 'C:\\Program Files\\OpenTune\\models');
  });

  test('CLI: check-installer and check-models ::error:: lines show both hash prefixes, not <redacted-hex>', () => {
    const exe = path.join(tmp, 'Older-Setup.exe');
    fs.writeFileSync(exe, 'older installer bytes');
    const model = path.join(tmp, 'hex-models');
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, 'fcpe.onnx'), 'fcpe');
    const pinned = 'c0ffee'.repeat(10).slice(0, 64);
    const pinFile = path.join(tmp, 'hex-pin.json');
    fs.writeFileSync(pinFile, JSON.stringify({ installer: { version: '1.8.1', sha256: 'f'.repeat(64) }, olderInstallers: [{ version: '1.7.9', sha256: pinned }], models: [{ path: 'fcpe.onnx', sha256: pinned }] }));
    const run = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), ...args, '--pin', pinFile], { encoding: 'utf8' });
    const inst = run('check-installer', '--file', exe, '--version', '1.7.9');
    assert.equal(inst.status, 1);
    assert.ok(inst.stdout.includes(`sha256 ${hashPrefix(sha256File(exe))}, pinned ${hashPrefix(pinned)}`), inst.stdout);
    assert.doesNotMatch(inst.stdout, /redacted/);
    const models = run('check-models', '--dir', model);
    assert.equal(models.status, 1);
    assert.ok(models.stdout.includes(`fcpe.onnx: sha256 ${hashPrefix(sha256File(path.join(model, 'fcpe.onnx')))}, pinned ${hashPrefix(pinned)}`), models.stdout);
    assert.doesNotMatch(models.stdout, /redacted/);
  });

  test('CLI: check-models exits 1 with a problem and 0 without', () => {
    const model = path.join(tmp, 'cli-models');
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(path.join(model, 'fcpe.onnx'), 'fcpe');
    const pinFile = path.join(tmp, 'pin.json');
    fs.writeFileSync(pinFile, JSON.stringify({ models: [{ path: 'fcpe.onnx', sha256: sha256File(path.join(model, 'fcpe.onnx')) }] }));
    const run = () => spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'check-models', '--pin', pinFile, '--dir', model], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    fs.writeFileSync(path.join(model, 'fcpe.onnx'), 'other');
    assert.equal(run().status, 1);
  });

  test('CLI: check-log scrubs the copy and writes the report', () => {
    const logs = path.join(tmp, 'Logs');
    fs.mkdirSync(logs, { recursive: true });
    const secret = ['abcDEF', '0123456789', 'abcDEF', '0123456789'].join(''); // assembled at runtime: no secret-shaped literal
    fs.writeFileSync(path.join(logs, 'OpenTune_1.log'), `token=${secret}\n[ModelFactory] Loaded F0 model (CPU): ${MODELS}\\fcpe.onnx\n`);
    const out = path.join(tmp, 'logs-out');
    const report = path.join(tmp, 'log-report.json');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'check-log', '--log-dir', logs, '--models-dir', MODELS, '--out-dir', out, '--report', report], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.readFileSync(path.join(out, 'OpenTune_1.log'), 'utf8').includes(secret));
    assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).backend, 'CPU');
  });

  test('CLI: check-log --data-root finds logs in every per-launch sub-directory', () => {
    const root = path.join(tmp, 'kept');
    for (const sub of ['run-a', 'run-b']) fs.mkdirSync(path.join(root, sub, 'Logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'run-a', 'Logs', 'OpenTune_1.log'), 'session start\n');
    fs.writeFileSync(path.join(root, 'run-b', 'Logs', 'OpenTune_2.log'), `[ModelFactory] Loaded F0 model (DirectML): ${MODELS}\\fcpe.onnx\n`);
    const out = path.join(tmp, 'kept-out');
    const report = path.join(tmp, 'kept-report.json');
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'check-log', '--data-root', root, '--models-dir', MODELS, '--out-dir', out, '--report', report], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ['run-a__Logs__OpenTune_1.log', 'run-b__Logs__OpenTune_2.log']);
    assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).backend, 'DirectML');
  });
});

describe('official-install.json', () => {
  const pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));

  test('installer is pinned by version, https url, sha256 and size', () => {
    assert.match(pin.installer.version, /^\d+\.\d+\.\d+$/);
    assert.match(pin.installer.url, /^https:\/\/github\.com\/YuFeng926\/OpenTune\/releases\/download\//);
    assert.match(pin.installer.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.installer.size > 0);
    assert.ok(pin.installer.silentArgs.includes('/VERYSILENT'));
  });

  test('older installers have the same fields, other versions and the release asset url', () => {
    assert.ok(Array.isArray(pin.olderInstallers) && pin.olderInstallers.length >= 1);
    const versions = new Set([pin.installer.version]);
    for (const i of pin.olderInstallers) {
      assert.match(i.version, /^\d+\.\d+\.\d+$/);
      assert.ok(!versions.has(i.version), `duplicate version ${i.version}`);
      versions.add(i.version);
      assert.match(i.url, new RegExp(`^https://github\\.com/YuFeng926/OpenTune/releases/download/[^/]+/OpenTune-${i.version.replace(/\./g, '\\.')}-Windows-x64-Setup\\.exe$`));
      assert.match(i.sha256, /^[0-9a-f]{64}$/);
      assert.ok(i.size > 0);
      assert.deepEqual(i.silentArgs, pin.installer.silentArgs);
    }
  });

  test('the minimum official version of the test build is pinned', () => {
    const release = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'release.json'), 'utf8'));
    assert.ok(pinnedInstaller(pin, release.minOfficialVersion), `no pinned installer for minOfficialVersion ${release.minOfficialVersion}`);
  });

  test('models include fcpe and the GAME set, each with a sha256', () => {
    const names = pin.models.map((m) => m.path);
    assert.ok(names.includes('fcpe.onnx'));
    assert.ok(names.filter((n) => n.startsWith('GAME/')).length >= 5);
    for (const m of pin.models) assert.match(m.sha256, /^[0-9a-f]{64}$/, m.path);
  });
});

describe('hasScenarioReport and has-scenario', () => {
  const put = (dir, n, o) => fs.writeFileSync(path.join(dir, n), typeof o === 'string' ? o : JSON.stringify(o));
  const cli = (dir, name) => spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'has-scenario', '--dir', dir, '--scenario', name], { encoding: 'utf8' });

  test('absent when there is no effects report (older MCP ref), also for a missing directory', () => {
    const dir = makeTempDir('e2e-has');
    try {
      put(dir, 'smoke.json', { schema: 'opentune-mcp-e2e-exe/1', scenario: 'smoke', steps: [] });
      put(dir, 'contract.json', { numTotalTests: 1 });
      assert.equal(hasScenarioReport(dir, 'effects'), false);
      assert.equal(hasScenarioReport(path.join(dir, 'nope'), 'effects'), false);
      assert.deepEqual([cli(dir, 'effects').status, cli(dir, 'effects').stdout.trim()], [0, 'absent']);
    } finally {
      removeDir(dir);
    }
  });

  test('present for a report by scenario name, by schema prefix, or called effects.json', () => {
    for (const [file, body] of [
      ['a.json', { schema: 'opentune-mcp-e2e-exe/1', scenario: 'effects', steps: [] }],
      ['b.json', { schema: 'opentune-mcp-e2e-effects/1', steps: [] }],
      ['effects.json', { whatever: true }],
    ]) {
      const dir = makeTempDir('e2e-has');
      try {
        put(dir, file, body);
        assert.equal(hasScenarioReport(dir, 'effects'), true, file);
        assert.equal(cli(dir, 'effects').stdout.trim(), 'present', file);
      } finally {
        removeDir(dir);
      }
    }
  });

  test('a report of another scenario does not count', () => {
    const dir = makeTempDir('e2e-has');
    try {
      put(dir, 'boundary.json', { schema: 'opentune-mcp-e2e-exe/1', scenario: 'boundary', steps: [] });
      assert.equal(hasScenarioReport(dir, 'effects'), false);
    } finally {
      removeDir(dir);
    }
  });
});
