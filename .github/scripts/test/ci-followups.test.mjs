// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards for the CI follow-ups: the drift-pins check runs from the base branch's scripts, gates.ps1 sees
// uncommitted work and fails closed, e2e-windows fails closed and scrubs/limits its diagnostics.
// The workflow files and gates.ps1 cannot be executed here, so they are checked as text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pruneScreenshots } from '../e2e-windows.mjs';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { REPO_ROOT, SCRIPTS } from './helpers.mjs';

const read = (...p) => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');

/** The text of one top-level job of a workflow (from `  <name>:` to the next job). */
function jobText(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `job ${name} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Code lines only (comments dropped). */
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('fork-gate: drift-pins is judged by the base branch scripts', () => {
  const wf = read('.github', 'workflows', 'fork-gate.yml');

  test('the drift-pins step runs in delta-checks through $GATE, not in self-test', () => {
    const delta = code(jobText(wf, 'delta-checks'));
    const self = code(jobText(wf, 'self-test'));
    assert.match(delta, /node "\$GATE\/drift-pins\.mjs"/);
    assert.doesNotMatch(self, /drift-pins\.mjs/);
    assert.doesNotMatch(delta, /node \.github\/scripts\/drift-pins\.mjs/);
  });

  test('drift-pins.mjs is one of the entry scripts the gate-script selection insists on', () => {
    const m = code(wf).match(/for f in ([^;]+); do/);
    assert.ok(m, 'entry script loop not found');
    assert.ok(m[1].split(/\s+/).includes('drift-pins.mjs'), m[1]);
  });

  test('delta-checks may list the files of the PR (pull-requests: read); self-test no longer needs it', () => {
    assert.match(jobText(wf, 'delta-checks'), /pull-requests: read/);
    assert.doesNotMatch(jobText(wf, 'self-test'), /pull-requests/);
  });
});

describe('drift-pins.mjs CLI', () => {
  test('the unused --advisory flag is gone: it is a usage error', () => {
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'drift-pins.mjs'), '--check', '--advisory'], { encoding: 'utf8', cwd: REPO_ROOT });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option --advisory/);
  });
});

describe('gates.ps1 drift-pins row', () => {
  const gates = read('.github', 'scripts', 'gates.ps1');
  const row = gates.slice(gates.indexOf('# 6b.'), gates.indexOf('# 7. gitleaks'));

  test('the changed-file list adds uncommitted tracked changes and untracked files to the committed range', () => {
    assert.match(row, /'diff', '--no-renames', '--name-only', "\$Base\.\.\.HEAD"/);
    assert.match(row, /'diff', '--no-renames', '--name-only', 'HEAD'/);
    assert.match(row, /'ls-files', '--others', '--exclude-standard'/);
    // The upstream .gitignore ignores .github/ wholesale, so the exclude-standard listing never shows untracked pin files.
    assert.match(row, /'ls-files', '--others', '--', '\.github\/drift-pins', '\.github\/scripts\/drift-pins\.mjs'/);
  });

  test('a failing git command is a FAIL, never an empty list', () => {
    assert.match(row, /\$LASTEXITCODE -ne 0\) \{ throw /);
    assert.doesNotMatch(row, /name-only[^\n]*2> \$null\)\s*\n\s*Set-Content/);
    assert.match(row, /catch \{\s*\n\s*Add-Row 'drift-pins[^\n]*'FAIL'/);
  });
});

const HAVE_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

describe('gates.ps1 failed-test counting', () => {
  const gates = read('.github', 'scripts', 'gates.ps1');
  const start = gates.indexOf('function Get-FailedTestNames');
  const fn = start >= 0 ? gates.slice(start, gates.indexOf('\n}\n', start) + 3) : '';

  test('both ctest rows merge their summaries through Get-FailedTestNames', () => {
    assert.ok(fn, 'Get-FailedTestNames not found');
    const body = code(gates);
    assert.match(body, /failed = Get-FailedTestNames @\(\$summary, \$sc\)/);
    assert.match(body, /\$failed = Get-FailedTestNames @\(\$sc, \$so\)/);
    // The old merges counted the $null of a summary without failed as one failed test.
    assert.doesNotMatch(body, /@\(\$(sc|so|summary)\.failed\) \+/);
  });

  /** Runs Get-FailedTestNames under the script's strict mode on summaries given as JSON texts (null: no summary). */
  const failedOf = (...summaries) => {
    const dir = makeTempDir('gates-failed');
    try {
      const args = summaries.map((s) => (s === null ? '$null' : `(ConvertFrom-Json '${s}')`)).join(', ');
      const script = path.join(dir, 'run.ps1');
      fs.writeFileSync(script, ['Set-StrictMode -Version 3.0', "$ErrorActionPreference = 'Stop'", fn,
        `$r = Get-FailedTestNames @(${args})`, "Write-Output ('count=' + $r.Count)", "Write-Output ('names=' + ($r -join ','))", ''].join('\n'));
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return { count: Number(/^count=(\d+)$/m.exec(r.stdout)?.[1] ?? NaN), names: /^names=(.*)$/m.exec(r.stdout)?.[1].trim() };
    } finally {
      removeDir(dir);
    }
  };

  test('a summary without failed, with failed null, or none at all adds no failed test', { skip: !HAVE_PWSH && 'pwsh is not installed' }, () => {
    assert.deepEqual(failedOf('{"passed":3,"total":3}', null), { count: 0, names: '' });
    assert.deepEqual(failedOf('{"passed":3,"total":3,"failed":null}', '{"failed":[]}'), { count: 0, names: '' });
    assert.deepEqual(failedOf(null, null), { count: 0, names: '' });
  });

  test('the names of both summaries are kept, in order', { skip: !HAVE_PWSH && 'pwsh is not installed' }, () => {
    assert.deepEqual(failedOf('{"failed":["A"]}', '{"failed":["B","C"]}'), { count: 3, names: 'A,B,C' });
    assert.deepEqual(failedOf('{"total":1}', '{"failed":"D"}'), { count: 1, names: 'D' });
  });
});

describe('e2e-windows workflow', () => {
  const wf = read('.github', 'workflows', 'e2e-windows.yml');

  test('a failing screenshot prune is surfaced as a warning', () => {
    assert.match(wf, /prune-screenshots[^\r\n]*\r?\n\s*if \(\$LASTEXITCODE -ne 0\) \{ Write-Host "::warning::/);
  });

  test('has-scenario is fail-closed: exit code and answer are checked before the effects scenario counts as not run', () => {
    const i = wf.indexOf('has-scenario --dir');
    assert.ok(i > 0);
    const after = wf.slice(i, i + 900);
    assert.match(after, /\$LASTEXITCODE -ne 0\) \{[^\n]*throw/);
    assert.match(after, /-notin @\('present', 'absent'\)/);
  });

  test('window lists are scrubbed before they are printed, and the screenshots are limited', () => {
    const step = wf.slice(wf.indexOf("-Tag 'after'"));
    const scrub = step.indexOf('scrub --dir $env:E2E_DIAG');
    const prune = step.indexOf('prune-screenshots --dir $env:E2E_DIAG');
    const print = step.indexOf('windows.txt');
    assert.ok(scrub > 0 && prune > 0 && print > 0);
    assert.ok(scrub < print, 'scrub must come before the window lists are printed');
  });

  test('the README states that screenshots are uploaded unscrubbed', () => {
    const readme = read('.github', 'e2e', 'README.md');
    assert.match(readme, /Screenshots are uploaded as they are/);
    assert.match(readme, /截图会原样上传/);
  });
});

describe('pruneScreenshots', () => {
  const shot = (dir, name, ageSeconds) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'png');
    const t = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(f, t, t);
  };

  test('keeps the newest n by modification time, leaves other files alone, deletes oldest first', () => {
    const dir = makeTempDir('e2e-prune');
    try {
      // "after-001" sorts before "during-*" by name but is the newest: the order must come from the mtime.
      shot(dir, 'during-001.png', 400);
      shot(dir, 'during-002.png', 300);
      shot(dir, 'during-003.png', 200);
      shot(dir, 'after-001.png', 10);
      fs.writeFileSync(path.join(dir, 'during-001.windows.txt'), 'x');
      assert.deepEqual(pruneScreenshots(dir, 2), ['during-001.png', 'during-002.png']);
      assert.deepEqual(fs.readdirSync(dir).sort(), ['after-001.png', 'during-001.windows.txt', 'during-003.png']);
      assert.deepEqual(pruneScreenshots(dir, 2), []);
    } finally {
      removeDir(dir);
    }
  });

  test('a missing directory is fine; a non-positive keep is an error', () => {
    const dir = makeTempDir('e2e-prune');
    try {
      assert.deepEqual(pruneScreenshots(path.join(dir, 'nope'), 3), []);
      assert.throws(() => pruneScreenshots(dir, 0), /positive integer/);
      const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'e2e-windows.mjs'), 'prune-screenshots', '--dir', dir, '--keep', 'x'], { encoding: 'utf8' });
      assert.equal(r.status, 2);
    } finally {
      removeDir(dir);
    }
  });
});
