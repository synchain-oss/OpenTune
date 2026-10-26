// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// doc-consistency: the documentation of the control API against the code. One case per group: a tree with
// one difference must report it (and say which file and line to change); the consistent tree must not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { CLAUDE_MD, README, checkDocConsistency, decideClaudeEnforcement, fsSource, memorySource, resolveInside } from '../doc-consistency.mjs';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { docFixture, patch } from './doc-fixture.mjs';

/** Run the check over a tree given as { path: text }. */
const run = (files, opts) => checkDocConsistency(memorySource(files), opts);
const of = (r, group) => r.problems.filter((p) => p.group === group);
const any = (list, re) => list.find((p) => re.test(p.text));

describe('doc-consistency', () => {
  test('the consistent tree has no problem', () => {
    const r = run(docFixture());
    assert.equal(r.applicable, true);
    assert.deepEqual(r.problems, []);
    // track.delete is in the spec copy but nobody registers it: information, not a problem.
    assert.deepEqual(r.unimplemented, ['track.delete']);
  });

  test('a tree without the control README is not applicable', () => {
    const files = docFixture();
    delete files['Source/Control/README.md'];
    const r = run(files);
    assert.equal(r.applicable, false);
    assert.deepEqual(r.problems, []);
  });

  describe('group: methods', () => {
    test('a registered method missing from the README table is reported with the file and line', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', '| `content.getNotes` | `read.v1` | `Ops/AlphaOps.cpp` | `ControlProcessorTests.Reads` | `methods/content.getNotes.schema.json` |\n', '');
      const problems = of(run(files), 'methods');
      const p = any(problems, /方法表缺少 content\.getNotes/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      // The message points at the file to change and at the place that registers the method.
      assert.match(p.text, /Source\/Control\/README\.md/);
      assert.match(p.text, /Ops\/AlphaOps\.cpp/);
    });

    test('a README row without a registered method is reported on its own line', () => {
      const row = '| `track.rename` | `tracks.v1` | `Ops/BetaOps.cpp` | `ControlProcessorTests.Tracks` | `methods/track.rename.schema.json` |\n';
      const files = patch(docFixture(), 'Source/Control/README.md', '| `track.add` |', `${row}| \`track.add\` |`);
      const problems = of(run(files), 'methods');
      const p = any(problems, /方法表列了 track\.rename/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md:\d+/);
    });

    test('a wrong capability in the README table is reported against the protocol table', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', '| `content.getNotes` | `read.v1` |', '| `content.getNotes` | `tracks.v1` |');
      const problems = of(run(files), 'methods');
      const p = any(problems, /content\.getNotes 的能力列/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md:\d+/);
      assert.match(p.text, /ControlProtocol\.cpp/);
    });

    test('a method the spec copy does not know is reported', () => {
      const files = patch(docFixture(), 'Source/Control/Ops/BetaOps.cpp', '"track.add"', '"track.rename"');
      const problems = of(run(files), 'methods');
      const p = any(problems, /注册了 track\.rename，但锁定的规范副本里没有/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Ops\/BetaOps\.cpp:\d+/);
    });
  });

  describe('group: hooks', () => {
    test('a marker in a file the README does not list is reported', () => {
      const files = docFixture();
      files['Source/Bar.cpp'] = [
        '#include "Bar.h"',
        '// OpenTune Control API hook: a hook in a file the README forgets, see Source/Control/README.md#hooks',
        'void bar() {}',
        '',
      ].join('\n');
      const problems = of(run(files), 'hooks');
      const p = any(problems, /钩子清单缺少 Source\/Bar\.cpp/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md/);
    });

    test('a README row for a file without a marker is reported', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', '`Source/Foo.h` (end of the class)', '`Source/Gone.h` (end of the class)');
      const problems = of(run(files), 'hooks');
      const p = any(problems, /钩子清单列了 Source\/Gone\.h，但文件里没有/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md:\d+/);
    });

    test('a marker that does not name the README section is reported', () => {
      const files = patch(docFixture(), 'Source/Foo.cpp', '// OpenTune Control API hook: service type, see Source/Control/README.md#hooks', '// OpenTune Control API hook: service type');
      const problems = of(run(files), 'hooks');
      const p = any(problems, /钩子标记应写成/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Foo\.cpp:\d+/);
    });

    test('a CLAUDE.md row for a file without a marker is reported', () => {
      const files = patch(docFixture(), 'CLAUDE.md', '`Source/Foo.h/.cpp`', '`Source/Bar.h/.cpp`');
      const problems = of(run(files), 'hooks');
      const p = any(problems, /钩子表列了 Source\/Bar\.h，但文件里没有/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /CLAUDE\.md:\d+/);
    });

    test('a marker whose purpose the README does not mention is reported', () => {
      const files = patch(docFixture(), 'Source/Foo.cpp', 'the service starts after this constructor', 'the telemetry uploader warms up here');
      const problems = of(run(files), 'hooks');
      const p = any(problems, /钩子标记的用途/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Foo\.cpp:\d+/);
      assert.match(p.text, /Source\/Control\/README\.md/);
    });
  });

  describe('group: mirrors', () => {
    test('a hash in MIRRORS.md that differs from mirror-map.json is reported', () => {
      const files = patch(docFixture(), 'Source/Control/MIRRORS.md', '1'.repeat(64), '0'.repeat(64));
      const problems = of(run(files), 'mirrors');
      const p = any(problems, /MIRRORS\.md：one 的 sha256 与 .*mirror-map\.json 不一致/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/MIRRORS\.md/);
    });

    test('a missing pin file is reported', () => {
      const files = docFixture();
      delete files['.github/drift-pins/beta.txt'];
      const problems = of(run(files), 'mirrors');
      const p = any(problems, /drift-pins\/beta\.txt 缺失/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
    });
  });

  describe('group: test names', () => {
    test('a test name the CMake files do not register is reported on its line', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', '`ControlProcessorTests.Reads`', '`ControlProcessorTests.Nope`');
      const problems = of(run(files), 'tests');
      const p = any(problems, /引用的测试名 ControlProcessorTests\.Nope 没有注册/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md:\d+/);
      assert.match(p.text, /cmake\/OpenTuneControl\.cmake/);
    });

    test('a ctest pattern that matches no registered test is reported', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', 'ctest -R Control`', 'ctest -R NothingHere`');
      const problems = of(run(files), 'tests');
      const p = any(problems, /ctest -R NothingHere 匹配不到任何注册的测试/);
      assert.ok(p, problems.map((x) => x.text).join('\n'));
      assert.match(p.text, /Source\/Control\/README\.md:\d+/);
    });
  });

  describe('enforcement', () => {
    test('the mirror group is only advisory when the caller says so', () => {
      const files = patch(docFixture(), 'Source/Control/MIRRORS.md', '1'.repeat(64), '0'.repeat(64));
      const blocking = of(run(files), 'mirrors');
      assert.ok(blocking.length);
      assert.ok(blocking.every((p) => p.advisory === false));
      const advisory = of(run(files, { mirrorsBlocking: false }), 'mirrors');
      assert.ok(advisory.length);
      assert.ok(advisory.every((p) => p.advisory === true));
    });

    test('the other groups are never advisory', () => {
      const files = patch(docFixture(), 'Source/Control/README.md', '`ControlProcessorTests.Reads`', '`ControlProcessorTests.Nope`');
      const problems = of(run(files, { mirrorsBlocking: false }), 'tests');
      assert.ok(problems.length);
      assert.ok(problems.every((p) => p.advisory === false));
    });
  });

  describe('source of a problem', () => {
    test('every problem says which file it comes from, without looking at its wording', () => {
      const claude = patch(docFixture(), 'CLAUDE.md', '`Source/Foo.h/.cpp`', '`Source/Bar.h/.cpp`');
      const fromClaude = of(run(claude), 'hooks');
      assert.ok(fromClaude.length);
      assert.ok(fromClaude.every((p) => p.source === CLAUDE_MD), JSON.stringify(fromClaude));
      const readme = patch(docFixture(), 'Source/Control/README.md', '`Source/Foo.h` (end of the class)', '`Source/Gone.h` (end of the class)');
      const fromReadme = of(run(readme), 'hooks');
      assert.ok(fromReadme.length);
      assert.ok(fromReadme.every((p) => typeof p.source === 'string' && p.source.length > 0));
      assert.ok(fromReadme.some((p) => p.source === README), JSON.stringify(fromReadme));
      assert.ok(!fromReadme.some((p) => p.source === CLAUDE_MD));
      assert.ok(of(run(readme, { claudeBlocking: false }), 'hooks').every((p) => p.advisory === false));
    });

    test('claudeBlocking false makes only the problems whose source is CLAUDE.md advisory', () => {
      // One problem from each: the hook table of CLAUDE.md and the hook list of the README both lose a file.
      let files = patch(docFixture(), 'CLAUDE.md', '`Source/Foo.h/.cpp`', '`Source/Bar.h/.cpp`');
      files = patch(files, 'Source/Control/README.md', '`Source/Foo.h` (end of the class)', '`Source/Gone.h` (end of the class)');
      const hooks = of(run(files, { claudeBlocking: false }), 'hooks');
      assert.ok(hooks.some((p) => p.source === CLAUDE_MD && p.advisory === true), JSON.stringify(hooks));
      assert.ok(hooks.some((p) => p.source !== CLAUDE_MD && p.advisory === false), JSON.stringify(hooks));
      assert.ok(hooks.every((p) => p.advisory === (p.source === CLAUDE_MD)));
    });
  });

  describe('decideClaudeEnforcement', () => {
    const sub = { event: 'pull_request', baseRef: 'feature/control-api' };
    test('a sub-PR that does not change CLAUDE.md only reports, with its own reason', () => {
      const d = decideClaudeEnforcement({ ...sub, changedFiles: ['Source/Control/README.md'] });
      assert.equal(d.blocking, false);
      assert.match(d.reason, /CLAUDE\.md/);
      assert.match(d.reason, /feature\/control-api/);
    });

    test('touching the pin files does not make CLAUDE.md problems block', () => {
      const d = decideClaudeEnforcement({ ...sub, changedFiles: ['.github/drift-pins/alpha.txt', '.github/scripts/drift-pins.mjs'] });
      assert.equal(d.blocking, false);
    });

    test('a branch that changes CLAUDE.md stays blocking whatever its base is', () => {
      const d = decideClaudeEnforcement({ ...sub, changedFiles: ['CLAUDE.md'] });
      assert.equal(d.blocking, true);
      assert.match(d.reason, /CLAUDE\.md/);
    });

    test('pushes and pull requests into dev, review-base/** and sync/** block', () => {
      assert.equal(decideClaudeEnforcement({ event: 'push' }).blocking, true);
      for (const baseRef of ['dev', 'refs/heads/dev', 'review-base/12', 'sync/20260101']) {
        assert.equal(decideClaudeEnforcement({ event: 'pull_request', baseRef, changedFiles: [] }).blocking, true, baseRef);
      }
    });
  });

  describe('files read from a working tree', () => {
    const dirs = [];
    after(() => dirs.forEach(removeDir));
    /** <tmp>/outside.txt next to <tmp>/repo/ with the documentation fixture. */
    const tree = () => {
      const top = makeTempDir('doccons');
      dirs.push(top);
      const root = path.join(top, 'repo');
      for (const [file, text] of Object.entries(docFixture())) {
        const abs = path.join(root, ...file.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
      }
      fs.writeFileSync(path.join(top, 'outside.txt'), 'outside');
      fs.writeFileSync(path.join(top, 'outside.h'), '// outside the tree\n');
      fs.writeFileSync(path.join(root, 'inside.txt'), 'inside');
      return { top, root };
    };

    test('paths are normalised and read as long as they stay inside the root', () => {
      const { root } = tree();
      const src = fsSource(root);
      assert.equal(src.read('inside.txt'), 'inside');
      assert.equal(src.read('Source/../inside.txt'), 'inside');
      assert.equal(src.read('Source/Control/../../inside.txt'), 'inside');
      assert.equal(src.read('./inside.txt'), 'inside');
      assert.equal(src.read('no-such-file.txt'), null);
      assert.ok(src.list('Source/Control/../Control').length > 0);
    });

    test('a path that climbs out of the root reads as missing', () => {
      const { top, root } = tree();
      const src = fsSource(root);
      assert.equal(src.read('../outside.txt'), null);
      assert.equal(src.read('Source/../../outside.txt'), null);
      assert.equal(src.read('Source/Control/../../../outside.txt'), null);
      assert.equal(src.read(`${top.replace(/\\/g, '/')}/outside.txt`), null);
      assert.equal(src.read('C:/Windows/win.ini'), null);
      assert.equal(src.read('inside.txt\0'), null);
      assert.deepEqual([...src.readMany(['../outside.txt', 'inside.txt'])], [['../outside.txt', null], ['inside.txt', 'inside']]);
      assert.deepEqual(src.list('..'), []);
      assert.deepEqual(src.list('Source/../..'), []);
      assert.deepEqual(src.list('../outside.txt'), []);
    });

    test('resolveInside', () => {
      const root = path.resolve('some', 'repo');
      assert.equal(resolveInside(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
      assert.equal(resolveInside(root, 'a/../b.txt'), path.join(root, 'b.txt'));
      assert.equal(resolveInside(root, ''), root);
      assert.equal(resolveInside(root, '..'), null);
      assert.equal(resolveInside(root, 'a/../../b.txt'), null);
      assert.equal(resolveInside(root, '..repo/x'), path.join(root, '..repo', 'x'));
    });

    test('a README row that names a file outside the tree reports it as missing, although it exists there', () => {
      const { root } = tree();
      assert.deepEqual(checkDocConsistency(fsSource(root)).problems, []);
      const readme = path.join(root, 'Source', 'Control', 'README.md');
      const before = fs.readFileSync(readme, 'utf8');
      const text = before.replace('Public `ensureRuntime()`', 'Public `ensureRuntime()` next to `Source/../../outside.h`');
      assert.notEqual(text, before);
      fs.writeFileSync(readme, text);
      const problems = of(checkDocConsistency(fsSource(root)), 'hooks');
      assert.ok(problems.some((p) => /outside\.h 不存在/.test(p.text)), problems.map((p) => p.text).join('\n'));
    });
  });
});
