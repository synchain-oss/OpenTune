// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// with-build-slot.ps1: how many slots (and which lock names) a run resolves to. Uses -ShowConfig, which
// prints the resolved configuration and exits before any lock is taken, so the tests never touch the
// machine-wide build slots.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';
import { SCRIPTS } from './helpers.mjs';

const SCRIPT = path.join(SCRIPTS, 'with-build-slot.ps1');
const HAVE_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

function show(args = [], env = {}) {
  const base = { ...process.env };
  delete base.OPENTUNE_BUILD_SLOTS;
  const r = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-ShowConfig', ...args], { encoding: 'utf8', env: { ...base, ...env } });
  const names = (r.stdout.match(/^name=(.*)$/gm) ?? []).map((l) => l.slice(5).trim());
  const slots = Number(/^slots=(\d+)$/m.exec(r.stdout)?.[1] ?? NaN);
  return { code: r.status, slots, names, stderr: r.stderr };
}

describe('with-build-slot slot count', { skip: !HAVE_PWSH && 'pwsh is not installed' }, () => {
  test('defaults to 2 slots with suffixed names', () => {
    const r = show();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slots, 2);
    assert.deepEqual(r.names, ['Global\\OpenTune-build-slot-0', 'Global\\OpenTune-build-slot-1']);
  });

  test('OPENTUNE_BUILD_SLOTS overrides the default', () => {
    const r = show([], { OPENTUNE_BUILD_SLOTS: '3' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slots, 3);
    assert.equal(r.names.length, 3);
  });

  test('-Slots wins over the environment; 1 keeps the unsuffixed legacy name', () => {
    const r = show(['-Slots', '1'], { OPENTUNE_BUILD_SLOTS: '4' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slots, 1);
    assert.deepEqual(r.names, ['Global\\OpenTune-build-slot']);
  });

  test('-SlotName changes the lock name prefix', () => {
    const r = show(['-SlotName', 'Local\\ot-test-slot']);
    assert.deepEqual(r.names, ['Local\\ot-test-slot-0', 'Local\\ot-test-slot-1']);
  });

  for (const bad of ['0', '9', '-1', 'abc', '2.5', '1e1']) {
    test(`environment value "${bad}" is rejected with exit 64`, () => {
      const r = show([], { OPENTUNE_BUILD_SLOTS: bad });
      assert.equal(r.code, 64, `${r.stdout}${r.stderr}`);
    });
  }

  for (const bad of ['0', '9', 'x']) {
    test(`-Slots ${bad} is rejected with exit 64`, () => {
      const r = show(['-Slots', bad]);
      assert.equal(r.code, 64, `${r.stdout}${r.stderr}`);
    });
  }

  test('an empty environment value falls back to the default', () => {
    const r = show([], { OPENTUNE_BUILD_SLOTS: '' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slots, 2);
  });
});
