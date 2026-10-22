// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// doc-consistency: the documentation of the control API against the code. One case per group: a tree with
// one difference must report it (and say which file and line to change); the consistent tree must not.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkDocConsistency, memorySource } from '../doc-consistency.mjs';
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
});
