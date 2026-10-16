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
  countSmoke,
  countVitest,
  inspectLog,
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
    const c = countSmoke({ steps: [{ name: 'hello', status: 'PASS' }, { name: 'export', status: 'fail' }, { name: 'x', status: 'SKIP' }, { name: 'y', status: 'FLAKY-SKIP' }] });
    assert.deepEqual([c.pass, c.fail, c.skip, c.flakySkip], [1, 1, 1, 1]);
  });
});

describe('renderSummary', () => {
  const okLog = { ok: true, backend: 'CPU', f0ModelPath: `${MODELS}\\fcpe.onnx`, problems: [] };
  const okContract = { testResults: [{ assertionResults: [{ status: 'passed', fullName: 'a' }] }] };
  const okSmoke = { steps: [{ name: 'hello', status: 'PASS', ms: 120 }, { name: 'export', status: 'PASS', ms: 900 }] };

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
    const problems = checkModels(pin, model);
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /fcpe\.onnx: sha256/);
    assert.match(problems.join('\n'), /missing model: GAME\/encoder\.onnx/);

    assert.equal(checkInstaller({ installer: { sha256: '0'.repeat(64), size: 15 } }, exe).length, 1);
    assert.equal(checkInstaller(pin, path.join(tmp, 'nope.exe')).length, 1);
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

  test('models include fcpe and the GAME set, each with a sha256', () => {
    const names = pin.models.map((m) => m.path);
    assert.ok(names.includes('fcpe.onnx'));
    assert.ok(names.filter((n) => n.startsWith('GAME/')).length >= 5);
    for (const m of pin.models) assert.match(m.sha256, /^[0-9a-f]{64}$/, m.path);
  });
});
