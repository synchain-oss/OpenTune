// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// try-rebase: the read-only dry run of the final rebase, in throw-away repositories.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hashSymbol } from '../drift-pins.mjs';
import { formatSummary, tryRebase } from '../try-rebase.mjs';
import { SCRIPTS, TestRepo, UPSTREAM, msg } from './helpers.mjs';

const FOO_OLD = 'void foo()\n{\n    int y = 0;\n}\n';
let repo;

before(() => {
  repo = TestRepo.withForkBase('try-rebase');
});
after(() => repo.dispose());

const refs = () => repo.git(['for-each-ref', '--format=%(refname) %(objectname)']);

describe('tryRebase', () => {
  test('without --upstream it rebases onto the locked mirror: nothing to do', () => {
    const head = repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 1;\n}\n', '.github/a.md': 'a\n' });
    const r = tryRebase({ cwd: repo.dir, head });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.conflictedCommits.length, 0);
    assert.equal(r.conflictBlocks, 0);
    assert.equal(r.commits, 2);
    assert.equal(r.applied, 2);
    assert.equal(r.complete, true);
  });

  test('an upstream change to other files rebases cleanly', () => {
    const head = repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 1;\n}\n' });
    const up = repo.commit({ parent: repo.upstream, files: { 'README.md': '# Upstream, newer\n' }, author: UPSTREAM });
    const r = tryRebase({ cwd: repo.dir, head, upstream: up });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.conflictedCommits.length, 0);
    assert.equal(r.overlapFiles.length, 0);
    assert.equal(r.applied, r.commits);
  });

  test('conflicting edits of the same lines are counted: files, blocks, commits', () => {
    const c1 = repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 1;\n}\n' });
    const head = repo.change({ '.github/b.md': 'b\n' }, { parent: c1 });
    const up = repo.commit({ parent: repo.upstream, files: { 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 2;\n}\n' }, author: UPSTREAM });
    const r = tryRebase({ cwd: repo.dir, head, upstream: up });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.commits, 3); // the fork base commit, the conflicting edit and the unrelated one
    assert.equal(r.conflictedCommits.length, 1);
    assert.deepEqual(r.conflictFiles, ['Source/Utils/Foo.cpp']);
    assert.equal(r.conflictBlocks, 1);
    assert.deepEqual(r.overlapFiles, ['Source/Utils/Foo.cpp']);
    assert.equal(r.applied, 3);
    const md = formatSummary(r);
    assert.match(md, /冲突文件 1 个，冲突块 1 个/);
    assert.match(md, /永不推送/);
  });

  test('a file deleted upstream and edited by us is a conflict that is resolved and counted', () => {
    const head = repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 5;\n}\n' });
    const up = repo.commit({ parent: repo.upstream, files: { 'Source/Utils/Foo.cpp': null }, author: UPSTREAM });
    const r = tryRebase({ cwd: repo.dir, head, upstream: up });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.conflictFiles, ['Source/Utils/Foo.cpp']);
    assert.equal(r.complete, true);
  });

  test('mirrored functions that changed upstream are listed', () => {
    const pins = `# group: demo\n# pinned-at: upstream/x\nSource/Utils/Foo.cpp\tfoo\tL1-L4\tfn-v1\t${hashSymbol(FOO_OLD, 'foo').sha256}\n`;
    const head = repo.change({ '.github/drift-pins/demo.txt': pins });
    const up = repo.commit({ parent: repo.upstream, files: { 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 3;\n}\n' }, author: UPSTREAM });
    const r = tryRebase({ cwd: repo.dir, head, upstream: up });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.drift.pins, 1);
    assert.equal(r.drift.entries[0].status, 'changed');
    assert.match(formatSummary(r), /文本已变化/);
    const same = tryRebase({ cwd: repo.dir, head });
    assert.equal(same.drift.entries[0].status, 'unchanged');
  });

  test('the repository is left as it was: refs unchanged, nothing checked out, no remote contacted', () => {
    const head = repo.change({ '.github/c.md': 'c\n' });
    const before = refs();
    const headFile = fs.readFileSync(path.join(repo.dir, '.git', 'HEAD'), 'utf8');
    const r = tryRebase({ cwd: repo.dir, head });
    assert.equal(r.ok, true, r.error);
    assert.equal(refs(), before);
    assert.equal(fs.readFileSync(path.join(repo.dir, '.git', 'HEAD'), 'utf8'), headFile);
    assert.equal(fs.existsSync(path.join(repo.dir, '.github')), false);
  });

  test('a branch that is not built on a tagged snapshot reports failure code 1', () => {
    const r2 = TestRepo.create('try-rebase-notag');
    try {
      const up = r2.commit({ files: { 'README.md': 'x\n' }, author: UPSTREAM, message: 'up\n' });
      r2.ref('refs/remotes/origin/upstream-mirror', up);
      const head = r2.commit({ parent: up, files: { '.github/a.md': 'x\n' }, message: msg('chore: x') });
      const r = tryRebase({ cwd: r2.dir, head });
      assert.equal(r.ok, false);
      assert.equal(r.code, 1);
      assert.match(formatSummary(r), /失败/);
    } finally {
      r2.dispose();
    }
  });

  test('the script can never push', () => {
    for (const f of ['try-rebase.mjs', 'drift-pins.mjs']) {
      const text = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
      assert.equal(/['"]push['"]/.test(text), false, `${f} mentions a push`);
    }
  });
});
