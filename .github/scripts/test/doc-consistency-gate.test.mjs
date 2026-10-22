// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The doc-consistency check inside fork-checks: which problems block on which event, and what happens when
// the revision cannot be resolved. Runs in a throw-away repo.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkDocConsistency, memorySource } from '../doc-consistency.mjs';
import { runChecks } from '../fork-checks.mjs';
import { docFixture, patch } from './doc-fixture.mjs';
import { TestRepo, byId } from './helpers.mjs';

let repo;
before(() => {
  repo = TestRepo.withForkBase('fc-docgate');
});
after(() => repo?.dispose());

const BRANCH = 'feat/F99-test';
const run = async (head, extra = {}) => {
  const out = await runChecks({ cwd: repo.dir, head, headBranch: BRANCH, layer: 'L0', only: ['doc-consistency'], ...extra });
  return byId(out.results, 'doc-consistency');
};

describe('doc-consistency in fork-checks', () => {
  test('a CLAUDE.md problem is only a WARN on a sub-PR (base feature/*), a FAIL on a push', async () => {
    const files = patch(docFixture(), 'CLAUDE.md', '`Source/Foo.h/.cpp`', '`Source/Bar.h/.cpp`');
    // The base already holds the consistent docs (pin files included), so the sub-PR touches none of the pin paths.
    const base = repo.change(docFixture());
    repo.ref('refs/remotes/origin/feature/doc-base', base);
    const head = repo.change({ 'CLAUDE.md': files['CLAUDE.md'] }, { parent: base });
    const sub = await run(head, { base: 'origin/feature/doc-base' });
    assert.equal(sub.result, 'WARN', `${sub.detail}\n${sub.problems.join('\n')}`);
    assert.match(sub.detail, /CLAUDE\.md/);
    const push = await run(head, { defaultBase: false });
    assert.equal(push.result, 'FAIL', `${push.detail}\n${push.problems.join('\n')}`);
  });

  test('a README problem in the hook group still blocks on a sub-PR', async () => {
    const files = patch(docFixture(), 'Source/Control/README.md', '`Source/Foo.h` (end of the class)', '`Source/Gone.h` (end of the class)');
    const head = repo.change(files);
    const sub = await run(head, { base: 'origin/feature/control-api' });
    assert.equal(sub.result, 'FAIL', `${sub.detail}\n${sub.problems.join('\n')}`);
  });

  test('a revision that cannot be resolved is a FAIL that names it, not a read of the index', async () => {
    const r = await run(undefined, { head: 'no-such-rev-for-doc-check', defaultBase: false });
    assert.equal(r.result, 'FAIL');
    assert.match(r.detail, /no-such-rev-for-doc-check/);
  });
});

describe('claudeBlocking option', () => {
  test('only the problems from CLAUDE.md become advisory', () => {
    const files = patch(docFixture(), 'CLAUDE.md', '`Source/Foo.h/.cpp`', '`Source/Bar.h/.cpp`');
    const r = checkDocConsistency(memorySource(files), { claudeBlocking: false });
    const hooks = r.problems.filter((p) => p.group === 'hooks');
    assert.ok(hooks.length);
    assert.ok(hooks.every((p) => p.text.startsWith('CLAUDE.md') === p.advisory));
    assert.ok(hooks.some((p) => p.advisory));
  });
});

describe('method table Ops column', () => {
  test('a path that is not under Ops/ and has a - in the file name is read and compared', () => {
    const files = docFixture();
    files['Source/Control/Ops/OpsRegistry.cpp'] = files['Source/Control/Ops/OpsRegistry.cpp'];
    // Move BetaOps (track.add) to a sub directory with a dashed name; the README row must name the new place.
    const moved = { ...files };
    moved['Source/Control/Edit/beta-ops.cpp'] = moved['Source/Control/Ops/BetaOps.cpp'];
    delete moved['Source/Control/Ops/BetaOps.cpp'];
    const stale = checkDocConsistency(memorySource(moved)).problems.filter((p) => p.group === 'methods');
    assert.ok(stale.some((p) => /track\.add 的 Ops 文件列是 Ops\/BetaOps\.cpp，但它在 Source\/Control\/Edit\/beta-ops\.cpp/.test(p.text)), stale.map((p) => p.text).join('\n'));
    const fixed = patch(moved, 'Source/Control/README.md', '`Ops/BetaOps.cpp`', '`Edit/beta-ops.cpp`');
    assert.deepEqual(checkDocConsistency(memorySource(fixed)).problems.filter((p) => p.group === 'methods'), []);
  });
});
