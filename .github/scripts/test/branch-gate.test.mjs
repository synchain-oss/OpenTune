// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// branch-gate: naming, fork-source names, DCO, identity allow-list and attribution.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkBranchName, runBranchGate } from '../branch-gate.mjs';
import { FORK, GITHUB, SCRIPTS, STRANGER, TestRepo, WEB, aiGeneratedLine, aiTrailer, byId, msg } from './helpers.mjs';

const THIS = 'synchain-oss/OpenTune';
const OTHER = 'someone/OpenTune';

describe('branch-name', () => {
  for (const head of ['feature/control-api', 'feat/F99-gates', 'spec-sync/v1.0.0', 'sync/20261201']) {
    test(`${head} -> dev passes`, () => {
      assert.equal(checkBranchName({ base: 'dev', headBranch: head, headRepo: THIS, thisRepo: THIS }).result, 'PASS');
    });
  }

  for (const head of ['fix/typo', 'main', 'upstream-mirror', 'review-base/1', 'featx/a']) {
    test(`${head} -> dev fails`, () => {
      assert.equal(checkBranchName({ base: 'dev', headBranch: head, headRepo: THIS, thisRepo: THIS }).result, 'FAIL');
    });
  }

  for (const head of ['dev', 'feature/control-api', 'feat/F99-x', 'spec-sync/v1', 'sync/x', 'upstream-mirror']) {
    test(`external PR named ${head} fails`, () => {
      assert.equal(checkBranchName({ base: 'dev', headBranch: head, headRepo: OTHER, thisRepo: THIS }).result, 'FAIL');
    });
  }

  test('external PR with its own branch name passes the naming rule', () => {
    assert.equal(checkBranchName({ base: 'dev', headBranch: 'patch-1', headRepo: OTHER, thisRepo: THIS }).result, 'PASS');
  });

  test('missing names fail', () => {
    assert.equal(checkBranchName({ base: 'dev', headBranch: '', headRepo: THIS, thisRepo: THIS }).result, 'FAIL');
  });
});

describe('commits and PR text', () => {
  let repo;
  before(() => {
    repo = TestRepo.withForkBase('bg');
    repo.ref('refs/remotes/origin/dev', repo.forkBase);
  });
  after(() => repo?.dispose());

  const gate = (head, extra = {}) => runBranchGate({ cwd: repo.dir, base: 'dev', headBranch: 'feature/control-api', headRepo: THIS, thisRepo: THIS, baseRef: 'origin/dev', head, ...extra });

  test('signed-off commits with allowed identities and clean text pass', async () => {
    const c1 = repo.change({ 'Tests/ControlFork/a.txt': 'a\n' });
    const c2 = repo.change({ 'Tests/ControlFork/b.txt': 'b\n' }, { parent: c1, author: WEB, committer: GITHUB });
    const merge = repo.commit({ parents: [c2, repo.forkBase], message: 'Merge (no sign-off needed)\n' });
    const out = await gate(merge, { pr: { title: 'feat: 合入', body: '说明\n' } });
    for (const r of out.results) assert.equal(r.result, 'PASS', `${r.id}: ${r.detail} ${r.problems.join('; ')}`);
    assert.match(byId(out.results, 'dco-identity').detail, /2 个非合并提交/);
  });

  test('a commit without Signed-off-by fails DCO', async () => {
    const head = repo.change({ 'Tests/ControlFork/c.txt': 'c\n' }, { message: 'feat: no sign-off\n' });
    assert.equal(byId((await gate(head)).results, 'dco-identity').result, 'FAIL');
  });

  test('same-repository PR with a foreign identity fails; external PR with its own sign-off passes', async () => {
    const head = repo.change({ 'Tests/ControlFork/d.txt': 'd\n' }, { author: STRANGER, message: `fix: x\n\nSigned-off-by: ${STRANGER.name} <${STRANGER.email}>\n` });
    assert.equal(byId((await gate(head)).results, 'dco-identity').result, 'FAIL');
    const ext = await gate(head, { headRepo: OTHER, headBranch: 'patch-1' });
    assert.equal(byId(ext.results, 'dco-identity').result, 'PASS');
  });

  test('AI attribution in a commit, the PR title or the PR body fails', async () => {
    const dirty = repo.change({ 'Tests/ControlFork/e.txt': 'e\n' }, { message: msg('feat: x', aiTrailer()) });
    assert.equal(byId((await gate(dirty)).results, 'attribution').result, 'FAIL');
    const clean = repo.change({ 'Tests/ControlFork/f.txt': 'f\n' }, { author: FORK });
    assert.equal(byId((await gate(clean, { pr: { title: 'x', body: aiGeneratedLine() } })).results, 'attribution').result, 'FAIL');
    assert.equal(byId((await gate(clean, { pr: { title: aiTrailer(), body: '' } })).results, 'attribution').result, 'FAIL');
  });

  test('CLI reads the PR text from the environment and exits 1 on failure', () => {
    const head = repo.change({ 'Tests/ControlFork/g.txt': 'g\n' });
    const args = [path.join(SCRIPTS, 'branch-gate.mjs'), '--base', 'dev', '--head-branch', 'fix/x', '--head-repo', THIS, '--this-repo', THIS, '--base-ref', 'origin/dev', '--head', head, '--pr'];
    const r = spawnSync(process.execPath, args, { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PR_TITLE: 'x', PR_BODY: 'ok' } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /branch-name 分支命名 \| FAIL/);
    assert.match(r.stdout, /dco-identity DCO 与身份 \| PASS/);
  });
});
