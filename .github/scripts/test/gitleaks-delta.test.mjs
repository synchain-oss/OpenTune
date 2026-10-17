// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gitleaks-delta: a secret planted in a delta commit or a delta file fails; the same secret in the
// upstream snapshot is not ours and is not scanned. Needs gitleaks 8.30.1: set GITLEAKS (CI does) or
// run `node .github/scripts/fetch-tool.mjs gitleaks` first; otherwise the tests are skipped.
// The fake token is generated at runtime so no secret-looking string is ever committed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { scanDelta } from '../gitleaks-delta.mjs';
import { TestRepo, UPSTREAM_FILES, byId, forkBaseFiles, msg, UPSTREAM } from './helpers.mjs';

const exe = process.env.GITLEAKS || null;
const skip = exe ? false : 'set GITLEAKS to a gitleaks 8.30.1 binary (node .github/scripts/fetch-tool.mjs gitleaks)';

function fakeToken() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(36);
  return ['gh', 'p_'].join('') + [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

describe('gitleaks-delta', { skip }, () => {
  test('clean delta passes both scans', () => {
    const repo = TestRepo.withForkBase('gl-clean');
    try {
      const head = repo.change({ 'Source/Control/A.cpp': '// SPDX-License-Identifier: AGPL-3.0-or-later\nint a = 1;\n' });
      repo.checkout(head);
      const out = scanDelta({ cwd: repo.dir, gitleaks: exe, head });
      assert.equal(byId(out.results, 'gitleaks-git').result, 'PASS', JSON.stringify(out.results));
      assert.equal(byId(out.results, 'gitleaks-dir').result, 'PASS', JSON.stringify(out.results));
    } finally {
      repo.dispose();
    }
  });

  test('a secret in a delta commit fails the history scan', () => {
    const repo = TestRepo.withForkBase('gl-commit');
    try {
      const leaked = repo.change({ 'Source/Control/Token.cpp': `const char* token = "${fakeToken()}";\n` });
      const removed = repo.change({ 'Source/Control/Token.cpp': null }, { parent: leaked });
      repo.checkout(removed);
      const out = scanDelta({ cwd: repo.dir, gitleaks: exe, head: removed });
      assert.equal(byId(out.results, 'gitleaks-git').result, 'FAIL');
      assert.equal(byId(out.results, 'gitleaks-dir').result, 'PASS');
    } finally {
      repo.dispose();
    }
  });

  test('a secret in a delta file in the working tree fails the file scan', () => {
    const repo = TestRepo.withForkBase('gl-dir');
    try {
      const head = repo.change({ '.github/notes.txt': 'clean\n' });
      repo.checkout(head);
      repo.write('.github/notes.txt', `token: ${fakeToken()}\n`);
      const out = scanDelta({ cwd: repo.dir, gitleaks: exe, head });
      assert.equal(byId(out.results, 'gitleaks-git').result, 'PASS');
      assert.equal(byId(out.results, 'gitleaks-dir').result, 'FAIL');
    } finally {
      repo.dispose();
    }
  });

  test('a secret that came with the upstream snapshot is not scanned', () => {
    const repo = TestRepo.create('gl-upstream');
    try {
      const up = repo.commit({ files: { ...UPSTREAM_FILES, 'Source/Upstream.cpp': `auto t = "${fakeToken()}";\n` }, author: UPSTREAM, message: 'upstream\n' });
      repo.ref('refs/tags/upstream/20260101-0000000', up);
      repo.ref('refs/remotes/origin/upstream-mirror', up);
      const head = repo.commit({ parent: up, files: forkBaseFiles(), message: msg('chore(fork): base') });
      repo.checkout(head);
      const out = scanDelta({ cwd: repo.dir, gitleaks: exe, head });
      for (const r of out.results) assert.equal(r.result, 'PASS', `${r.id}: ${r.detail} ${r.problems.join('; ')}`);
    } finally {
      repo.dispose();
    }
  });
});
