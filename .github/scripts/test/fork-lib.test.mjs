// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers: path classes, globs, text and YAML helpers.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { stripYamlComment, workflowCodeLines, workflowTriggerBlock, spdxProblem, needsSpdx } from '../fork-checks.mjs';
import { classifyPath, eolStyle, findSignoffs, globToRegExp, matchesAny, parseArgs, parseNameStatusZ, reportToGitHub, result, GUARDED_PATTERNS } from '../fork-lib.mjs';

describe('globs and path classes', () => {
  test('globToRegExp', () => {
    assert.ok(globToRegExp('**/*.onnx').test('a/b/c.onnx'));
    assert.ok(globToRegExp('**/*.onnx').test('c.onnx'));
    assert.ok(!globToRegExp('models/*').test('models/a/b'));
    assert.ok(globToRegExp('models/**').test('models/a/b'));
    assert.ok(globToRegExp('Source/Standalone/ControlEditorBridge*').test('Source/Standalone/ControlEditorBridge.cpp'));
    assert.ok(!globToRegExp('Source/Standalone/ControlEditorBridge*').test('Source/Standalone/ControlEditorBridge/x.cpp'));
    assert.ok(globToRegExp('**/D3D12*.dll', { nocase: true }).test('out/d3d12core.DLL'));
  });

  test('classifyPath', () => {
    assert.equal(classifyPath('.github/workflows/fork-gate.yml'), 'L0');
    assert.equal(classifyPath('Source/Control/.clang-format'), 'L0');
    assert.equal(classifyPath('Tests/ControlFork/a.cpp'), 'L0');
    assert.equal(classifyPath('docs/control-api.en.md'), 'L0');
    assert.equal(classifyPath('Source/Control/ControlServer.cpp'), 'upstreamable');
    assert.equal(classifyPath('Source/Standalone/ControlEditorBridge.h'), 'upstreamable');
    assert.equal(classifyPath('Source/PluginProcessor.cpp'), 'upstreamable');
    assert.equal(classifyPath('BUILDING.en.md'), 'upstreamable');
    assert.equal(classifyPath('Source/Standalone/UI/PianoRollComponent.cpp'), 'other');
    assert.equal(classifyPath('README.md'), 'other');
    assert.equal(classifyPath('docs/other.md'), 'other');
  });

  test('guarded paths', () => {
    for (const p of ['models/fcpe.onnx', 'models/GAME/x.onnx', 'a/b.ONNX', 'pc_nsf_hifigan_44.1k_ONNX/x', 'ThirdParty/x/y.h', 'out/D3D12/D3D12Core.dll', 'd3dconfig.exe']) {
      assert.ok(matchesAny(p, GUARDED_PATTERNS, { nocase: true }), p);
    }
    for (const p of ['Source/Utils/D3D12AgilityBootstrap.cpp', 'Source/Control/Models.cpp', 'docs/models.md']) {
      assert.ok(!matchesAny(p, GUARDED_PATTERNS, { nocase: true }), p);
    }
  });
});

describe('text helpers', () => {
  test('eolStyle', () => {
    assert.equal(eolStyle(Buffer.from('a\nb\n')), 'lf');
    assert.equal(eolStyle(Buffer.from('a\r\nb\r\n')), 'crlf');
    assert.equal(eolStyle(Buffer.from('a\r\nb\n')), 'mixed');
    assert.equal(eolStyle(Buffer.from('a')), 'none');
  });

  test('findSignoffs', () => {
    assert.deepEqual(findSignoffs('x\n\nSigned-off-by: A B <A@Example.invalid>\n'), [{ name: 'A B', email: 'a@example.invalid' }]);
    assert.deepEqual(findSignoffs('Signed-off-by A <a@b>'), []);
  });

  test('parseNameStatusZ', () => {
    assert.deepEqual(parseNameStatusZ('A\0a b.txt\0M\0c\0'), [{ status: 'A', path: 'a b.txt' }, { status: 'M', path: 'c' }]);
  });

  test('parseArgs', () => {
    const { opts, positional } = parseArgs(['--a', 'x', '--b', '--c=1,2', 'p'], { a: 'string', b: 'bool', c: 'list' });
    assert.deepEqual(opts, { a: 'x', b: true, c: ['1', '2'] });
    assert.deepEqual(positional, ['p']);
    assert.throws(() => parseArgs(['--zzz'], {}), /unknown option/);
  });

  test('SPDX header rules', () => {
    assert.equal(spdxProblem('a.mjs', Buffer.from('#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\n')), null);
    assert.ok(spdxProblem('a.mjs', Buffer.from('\n'.repeat(12) + '// SPDX-License-Identifier: MIT\n')));
    assert.equal(spdxProblem('a.md', Buffer.from('\uFEFF<!--\nSPDX-License-Identifier: MIT\n-->\n')), null);
    assert.ok(spdxProblem('a.md', Buffer.from('<!-- x -->\nSPDX-License-Identifier: MIT\n')));
    assert.ok(needsSpdx('.github/CODEOWNERS'));
    assert.ok(needsSpdx('Source/Control/.clang-format'));
    assert.ok(!needsSpdx('.github/scripts/tools.lock.json'));
  });
});

describe('workflow YAML helpers', () => {
  test('stripYamlComment keeps # inside quotes', () => {
    assert.equal(stripYamlComment('run: echo "a # b" # c'), 'run: echo "a # b" ');
    assert.equal(stripYamlComment('uses: x@sha # v1'), 'uses: x@sha ');
    assert.equal(stripYamlComment('url: a#b'), 'url: a#b');
  });

  test('workflowCodeLines skips block scalars', () => {
    const lines = workflowCodeLines('a:\n  run: |\n    lfs: true\n    uses: x\n  b: 1\n');
    assert.deepEqual(lines.map((l) => l.code.trim()).filter(Boolean), ['a:', 'run: |', 'b: 1']);
  });

  test('workflowTriggerBlock', () => {
    assert.match(workflowTriggerBlock('name: x\non:\n  push:\n  pull_request: # c\njobs: {}\n'), /push:\n\s+pull_request:/);
    assert.equal(workflowTriggerBlock('name: x\njobs: {}\n'), '');
  });
});

describe('reportToGitHub', () => {
  /** Run reportToGitHub with stdout and the job summary captured. */
  const capture = (results) => {
    const lines = [];
    const write = process.stdout.write;
    const summary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    process.stdout.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      reportToGitHub('table\n', results);
    } finally {
      process.stdout.write = write;
      if (summary !== undefined) process.env.GITHUB_STEP_SUMMARY = summary;
    }
    return lines;
  };

  test('a FAIL is an ::error annotation, a WARN is a ::warning annotation, PASS and SKIP are silent', () => {
    const lines = capture([
      result('a', 'A', 'FAIL', 'bad', ['first', 'second']),
      result('b', 'B', 'WARN', 'report only', ['p1', 'p2']),
      result('c', 'C', 'PASS', 'ok'),
      result('d', 'D', 'SKIP', 'not applicable'),
    ]);
    assert.deepEqual(lines, ['::error title=a::bad：first\n', '::warning title=b::report only：p1\n']);
  });

  test('a WARN without problems still gets its annotation, and the text is escaped', () => {
    const lines = capture([result('w', 'W', 'WARN', '100% done\nsecond line')]);
    assert.deepEqual(lines, ['::warning title=w::100%25 done%0Asecond line\n']);
  });
});
