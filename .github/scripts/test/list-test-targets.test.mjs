// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// list-test-targets.ps1: ctest test names -> build targets, read from generated CTestTestfile.cmake files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { SCRIPTS } from './helpers.mjs';

const SCRIPT = path.join(SCRIPTS, 'list-test-targets.ps1');
const HAVE_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

describe('list-test-targets', { skip: !HAVE_PWSH && 'pwsh is not installed' }, () => {
  let dir;
  before(() => {
    dir = makeTempDir('list-targets');
    // The three spellings CMake uses for the same call: plain, "quoted" and [=[bracketed]=].
    fs.writeFileSync(path.join(dir, 'CTestTestfile.cmake'), [
      'if(CTEST_CONFIGURATION_TYPE MATCHES "^([Rr][Ee][Ll][Ww][Ii][Tt][Hh][Dd][Ee][Bb][Ii][Nn][Ff][Oo])$")',
      '  add_test(ControlUnitTests "C:/b/RelWithDebInfo/OpenTuneControlUnitTests.exe")',
      'endif()',
      'add_test([=[OtherTests]=] [=[/b/OtherTests]=])',
      'add_test([=[PlainBracketTests]=] "/b/PlainBracketTests" )',
      'add_test("QuotedTests" "/b/QuotedTests")',
      'subdirs("sub")',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'CTestTestfile.cmake'), 'add_test(ControlProcessorTests "/b/sub/OpenTuneControlProcessorTests")\n');
  });
  after(() => removeDir(dir));

  const run = (...args) => spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-BuildDir', dir, ...args], { encoding: 'utf8' });
  const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);

  test('-Include Control lists every matching test target, including those in subdirectories', () => {
    const r = run('-Include', 'Control');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r), ['OpenTuneControlUnitTests', 'OpenTuneControlProcessorTests']);
  });

  test('plain, quoted and bracketed spellings are all read', () => {
    assert.deepEqual(lines(run()).sort(), ['OpenTuneControlProcessorTests', 'OpenTuneControlUnitTests', 'OtherTests', 'PlainBracketTests', 'QuotedTests']);
  });

  test('-Exclude removes by test name', () => {
    assert.deepEqual(lines(run('-Include', 'Control', '-Exclude', 'ControlProcessorTests')), ['OpenTuneControlUnitTests']);
  });

  test('a pattern without matches exits 1 and shows what was parsed', () => {
    const r = run('-Include', 'Nothing');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /parsed 5 test/);
  });
});
