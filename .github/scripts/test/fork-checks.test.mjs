// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every fork-gate check: plant a violation -> FAIL, remove it -> PASS. Runs in throw-away repos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseLayerFromBody, runChecks, workflowTriggerBlock, actionRefProblem } from '../fork-checks.mjs';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import {
  FORK, GITHUB, PINNED_WORKFLOW, SCRIPTS, STRANGER, TestRepo, UPSTREAM, WEB,
  aiGeneratedLine, aiTrailer, byId, fakeClangFormat, msg, realTool,
} from './helpers.mjs';

let repo;
let tmp;
before(() => {
  repo = TestRepo.withForkBase('fc-checks');
  tmp = makeTempDir('fc-checks-tools');
});
after(() => {
  repo?.dispose();
  removeDir(tmp);
});

const BRANCH = 'feat/F99-test';

async function check(id, head, extra = {}) {
  const out = await runChecks({ cwd: repo.dir, head, base: 'origin/feature/control-api', headBranch: BRANCH, layer: 'L0', only: [id], ...extra });
  return byId(out.results, id);
}

async function expectStatus(id, head, status, extra) {
  const r = await check(id, head, extra);
  assert.equal(r.result, status, `${id}: expected ${status}, got ${r.result}: ${r.detail}\n${r.problems.join('\n')}`);
  return r;
}

describe('delta', () => {
  test('clean branch on a tagged snapshot passes', async () => {
    await expectStatus('delta', repo.change({ 'Tests/ControlFork/a.txt': 'x\n' }), 'PASS');
  });

  test('no upstream/* tag in the history fails', async () => {
    const r = TestRepo.create('fc-notag');
    try {
      const up = r.commit({ files: { 'README.md': 'x\n' }, author: UPSTREAM, message: 'up\n' });
      r.ref('refs/remotes/origin/upstream-mirror', up);
      const head = r.commit({ parent: up, files: { '.github/a.md': 'x\n' } });
      const out = await runChecks({ cwd: r.dir, head, layer: 'L0', only: ['delta'] });
      const d = byId(out.results, 'delta');
      assert.equal(d.result, 'FAIL');
      assert.match(d.detail, /未基于已标记的上游快照，请 rebase 到 dev/);
    } finally {
      r.dispose();
    }
  });

  test('a delta larger than the limit fails', async () => {
    let head = repo.forkBase;
    for (let i = 0; i < 3; i++) head = repo.change({ [`Tests/ControlFork/n${i}.txt`]: `${i}\n` }, { parent: head });
    await expectStatus('delta', head, 'PASS', { maxCommits: 4 });
    const d = await expectStatus('delta', head, 'FAIL', { maxCommits: 3 });
    assert.match(d.detail, /增量有 4 个提交，上限 3/);
  });

  test('missing upstream mirror ref fails', async () => {
    const d = await expectStatus('delta', repo.forkBase, 'FAIL', { mirror: 'origin/no-such-mirror' });
    assert.match(d.detail, /找不到上游镜像分支/);
  });
});

describe('dco-identity', () => {
  test('fork identity with sign-off passes', async () => {
    await expectStatus('dco-identity', repo.change({ 'Tests/ControlFork/a.txt': 'a\n' }), 'PASS');
  });

  test('GitHub web merge identity passes', async () => {
    const head = repo.change({ 'Tests/ControlFork/w.txt': 'w\n' }, { author: WEB, committer: GITHUB });
    await expectStatus('dco-identity', head, 'PASS');
  });

  test('foreign author fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/b.txt': 'b\n' }, { author: STRANGER, committer: FORK });
    const r = await expectStatus('dco-identity', head, 'FAIL');
    assert.match(r.problems.join('\n'), /作者 <someone@example.invalid>/);
  });

  test('foreign committer fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/c.txt': 'c\n' }, { author: FORK, committer: STRANGER });
    await expectStatus('dco-identity', head, 'FAIL');
  });

  test('missing Signed-off-by fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/d.txt': 'd\n' }, { message: 'test: no signoff\n' });
    const r = await expectStatus('dco-identity', head, 'FAIL');
    assert.match(r.problems.join('\n'), /缺少 Signed-off-by/);
  });

  test('Signed-off-by with another identity fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/e.txt': 'e\n' }, { message: `test: x\n\nSigned-off-by: ${STRANGER.name} <${STRANGER.email}>\n` });
    await expectStatus('dco-identity', head, 'FAIL');
  });

  test('local commit signed off only by the web identity fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/f.txt': 'f\n' }, { message: `test: x\n\nSigned-off-by: ${WEB.name} <${WEB.email}>\n` });
    await expectStatus('dco-identity', head, 'FAIL');
  });

  test('external PR: any author with a matching sign-off passes, a mismatch fails', async () => {
    const good = repo.change({ 'Tests/ControlFork/g.txt': 'g\n' }, { author: STRANGER, message: `fix: x\n\nSigned-off-by: ${STRANGER.name} <${STRANGER.email}>\n` });
    await expectStatus('dco-identity', good, 'PASS', { external: true });
    const bad = repo.change({ 'Tests/ControlFork/h.txt': 'h\n' }, { author: STRANGER, message: msg('fix: x') });
    await expectStatus('dco-identity', bad, 'FAIL', { external: true });
  });

  test('external PR on top of a GitHub web merge: only the PR commits get the relaxed rule', async () => {
    // A squash merge made on github.com: web author, GitHub committer, sign-off by the local identity.
    const web = repo.change({ 'Tests/ControlFork/web.txt': 'w\n' }, { author: WEB, committer: GITHUB });
    repo.ref('refs/remotes/origin/feature/ext-base', web);
    const base = { base: 'origin/feature/ext-base', external: true };
    const signedByStranger = `fix: x\n\nSigned-off-by: ${STRANGER.name} <${STRANGER.email}>\n`;
    const ext = repo.change({ 'Tests/ControlFork/ext.txt': 'e\n' }, { parent: web, author: STRANGER, message: signedByStranger });
    const r = await expectStatus('dco-identity', ext, 'PASS', base);
    assert.match(r.detail, /外部 PR 的 1 个提交/);
    // The PR's own commit still needs a sign-off by its author ...
    const unsigned = repo.change({ 'Tests/ControlFork/ext.txt': 'u\n' }, { parent: web, author: STRANGER, message: msg('fix: x') });
    await expectStatus('dco-identity', unsigned, 'FAIL', base);
    // ... and a foreign commit already in the base is not excused by the external PR on top of it.
    const foreign = repo.change({ 'Tests/ControlFork/f2.txt': 'f\n' }, { author: STRANGER, message: signedByStranger });
    repo.ref('refs/remotes/origin/feature/ext-foreign', foreign);
    const ext2 = repo.change({ 'Tests/ControlFork/ext2.txt': 'e\n' }, { parent: foreign, author: STRANGER, message: signedByStranger });
    const f = await expectStatus('dco-identity', ext2, 'FAIL', { base: 'origin/feature/ext-foreign', external: true });
    assert.match(f.problems.join('\n'), /作者 <someone@example\.invalid> 不在允许的身份内/);
    // Without a PR range the PR's own commits cannot be told apart: FAIL with the reason.
    const none = await expectStatus('dco-identity', ext, 'FAIL', { base: 'origin/no-such-base', external: true });
    assert.match(none.problems[0], /外部 PR 需要可用的 PR 范围/);
  });
});

describe('attribution', () => {
  test('clean messages and PR text pass', async () => {
    const head = repo.change({ 'Tests/ControlFork/i.txt': 'i\n' });
    await expectStatus('attribution', head, 'PASS', { pr: { title: 'ci(fork): 门禁', body: '## 层\n\n- [x] L0\n' } });
  });

  test('AI co-author trailer in a commit message fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/j.txt': 'j\n' }, { message: msg('test: x', aiTrailer()) });
    const r = await expectStatus('attribution', head, 'FAIL');
    assert.match(r.problems.join('\n'), /co-authored-claude/);
  });

  test('AI attribution in the PR body or title fails', async () => {
    const head = repo.change({ 'Tests/ControlFork/k.txt': 'k\n' });
    await expectStatus('attribution', head, 'FAIL', { pr: { title: 'ci: x', body: `text\n\n${aiGeneratedLine()}\n` } });
    await expectStatus('attribution', head, 'FAIL', { pr: { title: aiGeneratedLine(), body: '' } });
  });

  test('tampered attribution rules fail before any check runs', async () => {
    const dir = path.join(tmp, 'attr');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['check-attribution.mjs', 'attribution-patterns.txt', 'attribution.sha256']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
    const head = repo.change({ 'Tests/ControlFork/l.txt': 'l\n' });
    await expectStatus('attribution-copy', head, 'PASS', { attributionDir: dir });
    fs.appendFileSync(path.join(dir, 'attribution-patterns.txt'), '# local edit\n');
    await expectStatus('attribution-copy', head, 'FAIL', { attributionDir: dir });
    await expectStatus('attribution', head, 'FAIL', { attributionDir: dir });
  });
});

describe('path-guard', () => {
  const cases = {
    'adds a model under models/': { 'models/GAME/new.onnx': 'w' },
    'modifies the LFS pointer': { 'models/fcpe.onnx': 'smudged weights' },
    'deletes the LFS pointer': { 'models/fcpe.onnx': null },
    'adds an .onnx anywhere': { 'Tests/ControlFork/fixtures/tiny.ONNX': 'w' },
    'adds the vocoder directory': { 'pc_nsf_hifigan_44.1k_ONNX/readme.txt': 'x' },
    'touches ThirdParty': { 'ThirdParty/lib/a.h': '#pragma once\n// edit\n' },
    'adds a D3D12 runtime': { 'Tests/ControlFork/D3D12/D3D12Core.dll': 'MZ' },
  };
  for (const [name, files] of Object.entries(cases)) {
    test(`${name} -> FAIL`, async () => {
      await expectStatus('path-guard', repo.change(files), 'FAIL');
    });
  }

  test('a model added and removed again inside the delta still fails', async () => {
    const add = repo.change({ 'models/tmp.onnx': 'w' });
    const rm = repo.change({ 'models/tmp.onnx': null }, { parent: add });
    const r = await expectStatus('path-guard', rm, 'FAIL');
    assert.match(r.problems.join('\n'), /提交 \w+ 新增：models\/tmp\.onnx/);
  });

  test('a workflow with lfs: true fails, lfs: false passes', async () => {
    const bad = repo.change({ '.github/workflows/ok.yml': PINNED_WORKFLOW.replace('lfs: false', 'lfs: true') });
    const r = await expectStatus('path-guard', bad, 'FAIL');
    assert.match(r.problems.join('\n'), /ok\.yml:13/);
    const flow = repo.change({ '.github/workflows/flow.yml': '# SPDX-License-Identifier: MIT\non: push\njobs:\n  a:\n    steps:\n      - with: { lfs: yes }\n' });
    await expectStatus('path-guard', flow, 'FAIL');
    await expectStatus('path-guard', repo.change({ 'Source/Control/A.h': '// x\n' }), 'PASS');
  });
});

describe('ignored-paths', () => {
  test('allow-listed ignored files pass', async () => {
    const head = repo.change({ '.github/scripts/x.mjs': '// x\n', 'docs/control-api.md': '<!-- SPDX-License-Identifier: MIT -->\n', 'CLAUDE.md': 'x\n' });
    await expectStatus('ignored-paths', head, 'PASS');
  });

  for (const [name, file] of [['build output', 'build-lane/out.txt'], ['other docs', 'docs/notes.md'], ['nested AGENTS.md', 'Source/Control/AGENTS.md'], ['tools/ directory', 'Source/Control/tools/gen.h'], ['binary', 'Tests/ControlFork/x.dll']]) {
    test(`${name} ignored upstream -> FAIL`, async () => {
      const r = await expectStatus('ignored-paths', repo.change({ [file]: 'x\n' }), 'FAIL');
      assert.match(r.problems.join('\n'), new RegExp(file.replace(/[.*/]/g, '\\$&')));
    });
  }

  test('index mode sees a force-added file before it is committed', async () => {
    const r = TestRepo.withForkBase('fc-index');
    try {
      r.checkout(r.forkBase);
      r.write('build-x/artifact.bin', 'x');
      r.git(['add', '-f', '--', 'build-x/artifact.bin']);
      const out = await runChecks({ cwd: r.dir, index: true, only: ['ignored-paths'] });
      assert.equal(byId(out.results, 'ignored-paths').result, 'FAIL');
      r.git(['rm', '-q', '--cached', '--', 'build-x/artifact.bin']);
      r.write('.github/new.yml', '# x\n');
      r.git(['add', '-f', '--', '.github/new.yml']);
      const ok = await runChecks({ cwd: r.dir, index: true, only: ['ignored-paths'] });
      assert.equal(byId(ok.results, 'ignored-paths').result, 'PASS');
    } finally {
      r.dispose();
    }
  });
});

describe('scope', () => {
  test('hook files, control code and L0 paths pass', async () => {
    const head = repo.change({ 'Source/Control/A.cpp': 'x\n', 'Source/PluginProcessor.cpp': '\uFEFFx\n', 'Tests/ControlFork/a.txt': 'x\n' });
    await expectStatus('scope', head, 'PASS');
  });

  test('an upstream file outside the hook table fails', async () => {
    await expectStatus('scope', repo.change({ 'README.md': '# Upstream\nedit\n' }), 'FAIL');
    await expectStatus('scope', repo.change({ 'Source/Utils/Foo.cpp': 'void foo() {}\n' }), 'FAIL');
    await expectStatus('scope', repo.change({ 'newdir/file.txt': 'x\n' }), 'FAIL');
  });
});

describe('layer', () => {
  test('L0 change that stays in L0 paths passes', async () => {
    await expectStatus('layer', repo.change({ '.github/x.yml': 'x\n', 'Source/Control/.clang-format': 'x\n' }), 'PASS');
  });

  test('L0 change touching an upstreamable path fails', async () => {
    const r = await expectStatus('layer', repo.change({ '.github/x.yml': 'x\n', 'Source/Control/Server.cpp': 'x\n' }), 'FAIL');
    assert.match(r.problems.join('\n'), /Source\/Control\/Server\.cpp/);
  });

  test('L2 may touch upstreamable and L0 paths but not other upstream files', async () => {
    await expectStatus('layer', repo.change({ 'Source/Control/Server.cpp': 'x\n', 'CMakeLists.txt': 'x\n', '.github/drift-pins/a.txt': 'x\n' }), 'PASS', { layer: 'L2' });
    await expectStatus('layer', repo.change({ 'Source/Control/Server.cpp': 'x\n', 'README.md': 'x\n' }), 'FAIL', { layer: 'L2' });
  });

  test('missing, unknown and deferred layers fail', async () => {
    const head = repo.change({ '.github/x.yml': 'x\n' });
    await expectStatus('layer', head, 'FAIL', { layer: undefined });
    await expectStatus('layer', head, 'FAIL', { layer: 'L1' });
    await expectStatus('layer', head, 'FAIL', { layer: 'L7' });
  });

  test('layer comes from the PR body in CI', async () => {
    const head = repo.change({ 'Source/Control/Server.cpp': 'x\n' });
    const body = (box0, box2) => `## 层（单选）\n\n- [${box0}] L0 fork 专用\n- [${box2}] L2 读取与通道\n\n## 变更类型\n- [x] feat\n`;
    await expectStatus('layer', head, 'PASS', { layer: undefined, pr: { title: 't', body: body(' ', 'x') } });
    await expectStatus('layer', head, 'FAIL', { layer: undefined, pr: { title: 't', body: body('x', ' ') } });
    await expectStatus('layer', head, 'FAIL', { layer: undefined, pr: { title: 't', body: body(' ', ' ') } });
  });

  test('main line or sync/* into dev and spec-sync/* PRs skip the single choice; card PRs do not', async () => {
    repo.ref('refs/remotes/origin/dev', repo.forkBase);
    const mixed = repo.change({ '.github/x.yml': 'x\n', 'Source/Control/Server.cpp': 'x\n' });
    const pr = { title: 't', body: '## 层\n\n- [ ] L0\n- [ ] L2\n' };
    const intoDev = { layer: undefined, pr, base: 'origin/dev' };
    const r = await expectStatus('layer', mixed, 'SKIP', { ...intoDev, headBranch: 'feature/control-api' });
    assert.match(r.detail, /不属于单一层/);
    await expectStatus('layer', mixed, 'SKIP', { ...intoDev, headBranch: 'sync/20261101' });
    await expectStatus('layer', mixed, 'SKIP', { layer: undefined, pr, headBranch: 'spec-sync/v1.0.1' });
    // a card branch into dev, the main line into another base, or an external PR still need a layer
    await expectStatus('layer', mixed, 'FAIL', { ...intoDev, headBranch: 'feat/F99-x' });
    await expectStatus('layer', mixed, 'FAIL', { layer: undefined, pr, headBranch: 'feature/control-api' });
    await expectStatus('layer', mixed, 'FAIL', { ...intoDev, headBranch: 'feature/control-api', external: true });
    // the cumulative scope check still applies to them
    const outside = repo.change({ 'README.md': 'x\n' });
    await expectStatus('scope', outside, 'FAIL', { ...intoDev, headBranch: 'feature/control-api' });
  });

  test('parseLayerFromBody: single choice, HTML comments ignored', () => {
    assert.deepEqual(parseLayerFromBody('## 层\n- [x] L0 fork\n- [ ] L2\n'), { layer: 'L0' });
    assert.ok(parseLayerFromBody('## 层\n- [x] L0\n- [X] L2\n').error);
    assert.ok(parseLayerFromBody('## 层\n<!-- - [x] L0 -->\n- [ ] L2\n').error);
    assert.ok(parseLayerFromBody('').error);
  });
});

describe('spec-copy', () => {
  test('feat/* branch changing the spec copy or spec.lock fails', async () => {
    await expectStatus('spec-copy', repo.change({ 'Tests/Control/spec/otcp/v1/methods.md': 'x\n' }), 'FAIL', { layer: 'L2' });
    await expectStatus('spec-copy', repo.change({ '.github/spec.lock': '{}\n' }), 'FAIL');
  });

  test('spec-sync/* may change it; external PRs may not', async () => {
    const head = repo.change({ 'Tests/Control/spec/otcp/v1/methods.md': 'x\n', '.github/spec.lock': '{}\n' });
    await expectStatus('spec-copy', head, 'PASS', { headBranch: 'spec-sync/v1.0.0' });
    await expectStatus('spec-copy', head, 'FAIL', { headBranch: 'spec-sync/v1.0.0', external: true });
  });

  test('changes elsewhere pass', async () => {
    await expectStatus('spec-copy', repo.change({ 'Tests/Control/Unit.cpp': 'x\n' }), 'PASS');
  });
});

describe('spdx', () => {
  test('new script without SPDX fails, with SPDX passes', async () => {
    await expectStatus('spdx', repo.change({ '.github/scripts/new.mjs': 'export const a = 1;\n' }), 'FAIL');
    await expectStatus('spdx', repo.change({ '.github/scripts/new.mjs': '#!/usr/bin/env node\n// SPDX-License-Identifier: AGPL-3.0-or-later\nexport const a = 1;\n' }), 'PASS');
  });

  test('Markdown needs the HTML comment form', async () => {
    await expectStatus('spdx', repo.change({ '.github/doc.md': '# Title\n\nSPDX-License-Identifier: MIT\n' }), 'FAIL');
    await expectStatus('spdx', repo.change({ '.github/doc.md': '<!--\nSPDX-License-Identifier: AGPL-3.0-or-later\n-->\n# Title\n' }), 'PASS');
  });

  test('workflows and C++ need it; the spec copy, data files and verified copies are exempt', async () => {
    await expectStatus('spdx', repo.change({ '.github/workflows/x.yml': 'name: x\n' }), 'FAIL');
    await expectStatus('spdx', repo.change({ 'Source/Control/A.h': '#pragma once\n' }), 'FAIL');
    await expectStatus('spdx', repo.change({ 'Tests/Control/spec/otcp/v1/a.md': '# spec\n', '.github/scripts/tools.json': '{}\n' }), 'PASS');
    const copies = repo.change({
      '.github/scripts/attribution.sha256': `${'0'.repeat(64)}  check-attribution.mjs\n`,
      '.github/scripts/check-attribution.mjs': '// verbatim copy without a header\n',
    });
    await expectStatus('spdx', copies, 'PASS');
  });

  test('only the two fixed verbatim copies are exempt, not anything listed in attribution.sha256', async () => {
    const head = repo.change({
      '.github/scripts/attribution.sha256': `${'0'.repeat(64)}  check-attribution.mjs\n${'1'.repeat(64)}  other.mjs\n`,
      '.github/scripts/check-attribution.mjs': '// verbatim copy without a header\n',
      '.github/scripts/other.mjs': 'export const x = 1;\n',
    });
    const r = await expectStatus('spdx', head, 'FAIL');
    assert.deepEqual(r.problems.map((p) => p.split('：')[0]), ['.github/scripts/other.mjs']);
  });
});

describe('whitespace', () => {
  test('a clean added line passes (LF, CRLF and BOM files)', async () => {
    const head = repo.change({
      'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 0;\n    int z = 1;\n}\n',
      'Source/Utils/AppLogger.cpp': 'void log()\r\n{\r\n    int x = 0;\r\n    int y = 1;\r\n}\r\n',
      'Source/PluginProcessor.cpp': '\uFEFF#include "PluginProcessor.h"\n\nnamespace OpenTune {\n\nvoid f()\n{\n    int a = 1;\n    int b = 2;\n}\n\n} // namespace OpenTune\n',
    });
    await expectStatus('whitespace', head, 'PASS');
  });

  test('trailing whitespace on an added line fails', async () => {
    const r = await expectStatus('whitespace', repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 0;\n    int z = 1; \n}\n' }), 'FAIL');
    assert.match(r.problems.join('\n'), /Foo\.cpp:4：新增行有行尾空白/);
  });

  test('mixed tab/space or tab indentation fails', async () => {
    await expectStatus('whitespace', repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 0;\n \tint z = 1;\n}\n' }), 'FAIL');
    await expectStatus('whitespace', repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 0;\n\tint z = 1;\n}\n' }), 'FAIL');
  });

  test('changing the line endings fails', async () => {
    await expectStatus('whitespace', repo.change({ 'Source/Utils/Foo.cpp': 'void foo()\r\n{\r\n    int y = 0;\r\n}\r\n' }), 'FAIL');
    await expectStatus('whitespace', repo.change({ 'Source/Utils/AppLogger.cpp': 'void log()\r\n{\r\n    int x = 0;\n}\r\n' }), 'FAIL');
  });

  test('removing or adding a BOM fails', async () => {
    await expectStatus('whitespace', repo.change({ 'Source/PluginProcessor.cpp': '#include "PluginProcessor.h"\n' }), 'FAIL');
    await expectStatus('whitespace', repo.change({ 'Source/Utils/Foo.cpp': '\uFEFFvoid foo()\n{\n    int y = 0;\n}\n' }), 'FAIL');
  });
});

describe('clang-format', () => {
  test('no C++ files in the delta passes without a tool', async () => {
    await expectStatus('clang-format', repo.change({ '.github/x.yml': 'x\n' }), 'PASS', { clangFormat: [path.join(tmp, 'missing-tool')] });
  });

  test('missing or wrong-version tool is SKIP locally and FAIL with --require-tools', async () => {
    const head = repo.change({ 'Source/Control/A.cpp': '// SPDX-License-Identifier: AGPL-3.0-or-later\nint a;\n' });
    await expectStatus('clang-format', head, 'SKIP', { clangFormat: [path.join(tmp, 'missing-tool')] });
    await expectStatus('clang-format', head, 'FAIL', { clangFormat: [path.join(tmp, 'missing-tool')], requireTools: true });
    const dir = path.join(tmp, 'cf17');
    fs.mkdirSync(dir, { recursive: true });
    await expectStatus('clang-format', head, 'SKIP', { clangFormat: fakeClangFormat(dir, '17.0.6') });
  });

  test('a badly formatted file fails, a formatted one passes (fake 18.1.8)', async () => {
    const dir = path.join(tmp, 'cf18');
    fs.mkdirSync(dir, { recursive: true });
    const cf = fakeClangFormat(dir);
    await expectStatus('clang-format', repo.change({ 'Source/Control/A.cpp': 'int a;   \n' }), 'FAIL', { clangFormat: cf });
    // the fix hint names the style file, which Tests/Control/** would not find on its own
    const r = await expectStatus('clang-format', repo.change({ 'Tests/Control/C.cpp': 'int c;   \n' }), 'FAIL', { clangFormat: cf });
    assert.match(r.problems[0], /--style=file:Source\/Control\/\.clang-format -i Tests\/Control\/C\.cpp/);
    await expectStatus('clang-format', repo.change({ 'Tests/Control/B.h': '#pragma once\n' }), 'PASS', { clangFormat: cf });
    await expectStatus('clang-format', repo.change({ 'Tests/Control/spec/otcp/v1/x.h': 'int a;   \n' }), 'PASS', { clangFormat: cf });
  });

  const real = realTool('CLANG_FORMAT');
  test('real clang-format 18.1.8 with Source/Control/.clang-format', { skip: real ? false : 'set CLANG_FORMAT to clang-format 18.1.8 (fetch-tool.mjs clang-format)' }, async () => {
    const good = [
      '// SPDX-License-Identifier: AGPL-3.0-or-later',
      '#pragma once',
      '',
      'namespace OpenTune {',
      '',
      'class ControlSample',
      '{',
      'public:',
      '    int port() const { return port_; }',
      '',
      'private:',
      '    int port_{0};',
      '};',
      '',
      '} // namespace OpenTune',
      '',
    ].join('\n');
    await expectStatus('clang-format', repo.change({ 'Source/Control/Sample.h': good }), 'PASS', { clangFormat: [real] });
    const bad = good.replace('class ControlSample\n{', 'class ControlSample {').replace('    int port_{0};', '  int port_ {0};');
    await expectStatus('clang-format', repo.change({ 'Source/Control/Sample.h': bad }), 'FAIL', { clangFormat: [real] });
  });
});

describe('upstream-words', () => {
  test('fork names in a new upstreamable file fail; L0 paths and the spec copy are exempt', async () => {
    const name = ['Syn', 'chain'].join('');
    await expectStatus('upstream-words', repo.change({ 'Source/Control/A.cpp': `// by ${name}\n` }), 'FAIL', { layer: 'L2' });
    await expectStatus('upstream-words', repo.change({ 'Tests/Control/x.txt': ['opentune', 'mcp'].join('-') }), 'FAIL', { layer: 'L2' });
    await expectStatus('upstream-words', repo.change({ '.github/a.md': `${name}\n`, 'Tests/Control/spec/otcp/v1/a.md': `${name}\n` }), 'PASS');
  });

  test('fork names in lines added to an upstream file fail', async () => {
    const who = ['DL', 'snows'].join('');
    await expectStatus('upstream-words', repo.change({ 'CMakeLists.txt': `cmake_minimum_required(VERSION 3.22)\nproject(Upstream)\n# ${who}\n` }), 'FAIL', { layer: 'L2' });
    await expectStatus('upstream-words', repo.change({ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.22)\nproject(Upstream)\noption(X "x" OFF)\n' }), 'PASS', { layer: 'L2' });
  });
});

describe('workflow-triggers', () => {
  const trig = ['pull_request', 'target'].join('_');
  test('a pull_request_target trigger fails in any form', async () => {
    await expectStatus('workflow-triggers', repo.change({ '.github/workflows/a.yml': `on: [push, ${trig}]\njobs: {}\n` }), 'FAIL');
    await expectStatus('workflow-triggers', repo.change({ '.github/workflows/a.yml': `"on":\n  ${trig}:\n    branches: [dev]\njobs: {}\n` }), 'FAIL');
  });

  test('mentions in comments or in a prompt are not triggers', async () => {
    const text = `# never use ${trig}\non:\n  pull_request: # not ${trig}\njobs:\n  a:\n    steps:\n      - run: echo "${trig}"\n`;
    await expectStatus('workflow-triggers', repo.change({ '.github/workflows/a.yml': text }), 'PASS');
    assert.doesNotMatch(workflowTriggerBlock(text), new RegExp(trig));
  });
});

describe('actions-pinned', () => {
  const wf = (uses) => `# SPDX-License-Identifier: MIT\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${uses}\n`;
  test('tag refs, missing version comments and unlisted owners fail', async () => {
    await expectStatus('actions-pinned', repo.change({ '.github/workflows/a.yml': wf('actions/checkout@v7') }), 'FAIL');
    await expectStatus('actions-pinned', repo.change({ '.github/workflows/a.yml': wf('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1') }), 'FAIL');
    await expectStatus('actions-pinned', repo.change({ '.github/workflows/a.yml': wf('someone/action@3d3c42e5aac5ba805825da76410c181273ba90b1 # v1.0.0') }), 'FAIL');
  });

  test('SHA plus version comment, local actions and allowed third parties pass', async () => {
    await expectStatus('actions-pinned', repo.change({ '.github/workflows/a.yml': wf('actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0') }), 'PASS');
    assert.equal(actionRefProblem('./.github/actions/x', '- uses: ./.github/actions/x'), null);
    assert.equal(actionRefProblem('anthropics/claude-code-action@6fed3ca145920b639991cb756090506e1bcaf515', 'uses: x # v1.0.245'), null);
  });
});

describe('CLI', () => {
  test('exit codes and JSON output', async () => {
    const { spawnSync } = await import('node:child_process');
    const good = repo.change({ 'Tests/ControlFork/cli.txt': 'x\n' });
    const run = (...args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'fork-checks.mjs'), ...args], { cwd: repo.dir, encoding: 'utf8' });
    const ok = run('--head', good, '--layer', 'L0', '--head-branch', BRANCH, '--json', '--clang-format', path.join(tmp, 'missing-tool'));
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(JSON.parse(ok.stdout).status, 'PASS');
    const bad = repo.change({ 'models/fcpe.onnx': null });
    const ko = run('--head', bad, '--layer', 'L0', '--head-branch', BRANCH);
    assert.equal(ko.status, 1);
    assert.match(ko.stdout, /path-guard 路径守卫 \| FAIL/);
    assert.equal(run('--no-such-option').status, 2);
  });

  test('--ci without --base (push to dev) skips the PR-range checks instead of guessing a base', async () => {
    const { spawnSync } = await import('node:child_process');
    const head = repo.change({ 'Tests/ControlFork/push.txt': 'x\n' });
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'fork-checks.mjs'), '--ci', '--head', head, '--only', 'layer,spec-copy', '--head-branch', 'dev'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /layer 层与可上游路径 \| SKIP/);
    const local = await runChecks({ cwd: repo.dir, head, layer: undefined, only: ['layer'] });
    assert.equal(byId(local.results, 'layer').result, 'FAIL', 'locally the default base applies and a layer is required');
  });

  test('PR title/body are read from the environment', async () => {
    const { spawnSync } = await import('node:child_process');
    const head = repo.change({ 'Tests/ControlFork/env.txt': 'x\n' });
    const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'fork-checks.mjs'), '--head', head, '--pr', '--only', 'attribution,layer', '--head-branch', BRANCH], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: { ...process.env, PR_TITLE: 'ci: x', PR_BODY: `## 层\n- [x] L0\n\n${aiTrailer()}\n` },
    });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /attribution 无 AI 署名 \| FAIL/);
    assert.match(r.stdout, /layer 层与可上游路径 \| PASS/);
  });
});
