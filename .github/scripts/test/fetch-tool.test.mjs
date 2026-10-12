// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fetch-tool: sha256 verification of downloads and of the cached executable, against a local
// 127.0.0.1 server (no network). Also sanity-checks the real tools.lock.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { VerificationError, ensureTool } from '../fetch-tool.mjs';
import { makeTempDir, removeDir, sha256Hex } from '../fork-lib.mjs';
import { SCRIPTS } from './helpers.mjs';

const PLAT = 'test-plat';

function tarExe() {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

describe('fetch-tool (local server)', () => {
  let tmp;
  let server;
  let base;
  let hits = 0;
  let archive;
  let archiveSha;

  before(async () => {
    tmp = makeTempDir('fetch-tool-test');
    const stage = path.join(tmp, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'fake-tool'), 'fake tool v1.2.3\n');
    archive = path.join(tmp, 'fake.tar.gz');
    const r = spawnSync(tarExe(), ['-czf', archive, '-C', stage, 'fake-tool'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    archiveSha = sha256Hex(fs.readFileSync(archive));
    server = http.createServer((req, res) => {
      hits++;
      if (req.url === '/fake.tar.gz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(fs.readFileSync(archive));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    removeDir(tmp);
  });

  function lockWith(sha, name = 'lock.json') {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify({
      tools: { fake: { version: '1.2.3', kind: 'archive', binary: 'fake-tool', assets: { [PLAT]: { name: 'fake.tar.gz', url: `${base}/fake.tar.gz`, sha256: sha } } } },
    }));
    return file;
  }

  test('matching sha256: downloads, extracts, records a stamp, then reuses the cache', async () => {
    const dest = path.join(tmp, 'dest-ok');
    const lock = lockWith(archiveSha);
    const exe = await ensureTool('fake', { dest, lock, platform: PLAT });
    assert.equal(fs.readFileSync(exe, 'utf8'), 'fake tool v1.2.3\n');
    const stamp = JSON.parse(fs.readFileSync(path.join(path.dirname(exe), '.ot-tool.json'), 'utf8'));
    assert.equal(stamp.archiveSha256, archiveSha);
    const before2 = hits;
    assert.equal(await ensureTool('fake', { dest, lock, platform: PLAT }), exe);
    assert.equal(hits, before2, 'cached copy must not be downloaded again');
  });

  test('a tampered cached executable is replaced from the verified archive', async () => {
    const dest = path.join(tmp, 'dest-tamper');
    const lock = lockWith(archiveSha, 'lock-tamper.json');
    const exe = await ensureTool('fake', { dest, lock, platform: PLAT });
    fs.writeFileSync(exe, 'evil\n');
    assert.equal(fs.readFileSync(await ensureTool('fake', { dest, lock, platform: PLAT }), 'utf8'), 'fake tool v1.2.3\n');
  });

  test('a sha256 mismatch fails and leaves nothing usable behind', async () => {
    const dest = path.join(tmp, 'dest-bad');
    const lock = lockWith('0'.repeat(64), 'lock-bad.json');
    await assert.rejects(ensureTool('fake', { dest, lock, platform: PLAT }), (e) => e instanceof VerificationError && /sha256 mismatch/.test(e.message));
    assert.equal(fs.existsSync(path.join(dest, '_downloads', 'fake.tar.gz')), false);
    assert.equal(fs.existsSync(path.join(dest, `fake-1.2.3-${PLAT}`, 'fake-tool')), false);
  });

  test('unknown tool or platform is an error', async () => {
    const lock = lockWith(archiveSha, 'lock-x.json');
    await assert.rejects(ensureTool('nope', { dest: path.join(tmp, 'x'), lock, platform: PLAT }), /unknown tool/);
    await assert.rejects(ensureTool('fake', { dest: path.join(tmp, 'x'), lock, platform: 'other-plat' }), /no asset/);
  });
});

describe('tools.lock.json', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'tools.lock.json'), 'utf8'));

  test('gitleaks 8.30.1: every asset is an official release URL with a sha256', () => {
    const g = lock.tools.gitleaks;
    assert.equal(g.version, '8.30.1');
    assert.match(g.checksumsFile.sha256, /^[0-9a-f]{64}$/);
    for (const plat of ['linux-x64', 'win32-x64', 'darwin-arm64']) assert.ok(g.assets[plat], plat);
    for (const [plat, a] of Object.entries(g.assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, plat);
      assert.equal(a.url, `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/${a.name}`, plat);
    }
  });

  test('clang-format 18.1.8 is installed only with pinned hashes', () => {
    const c = lock.tools['clang-format'];
    assert.equal(c.version, '18.1.8');
    const req = fs.readFileSync(path.join(SCRIPTS, c.requirements), 'utf8');
    assert.match(req, /^clang-format==18\.1\.8\b/m);
    assert.ok((req.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length >= 3);
  });
});
