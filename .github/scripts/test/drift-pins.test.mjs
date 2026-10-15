// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// drift-pins: fn-v1 normalisation (README in .github/drift-pins) and the check against a revision.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkPins, extractFunction, hashFunctionText, hashSymbol, normalizeSource, parsePinFile } from '../drift-pins.mjs';
import { SIGNOFF, TestRepo } from './helpers.mjs';

const SRC = [
  '#include "Foo.h"',
  '',
  'namespace OpenTune {',
  '',
  'void Foo::helper();   // declaration only: not a definition',
  '',
  'int Foo::commit(int a)',
  '{',
  '    const char* s = "} not a brace {";',
  '    char c = \'}\';',
  '    // } in a comment',
  '    /* { in a block comment */',
  '    if (a > 0) { return 1; }',
  '    return 0;',
  '}',
  '',
  'int Foo::commit(double d) const noexcept',
  '{',
  '    return static_cast<int>(d);',
  '}',
  '',
  'Foo::Foo(int x) : x_(x), y_(1)',
  '{',
  '}',
  '',
  '} // namespace OpenTune',
  '',
].join('\n');

describe('extractFunction', () => {
  test('finds a definition, skipping braces in strings, characters and comments', () => {
    const f = extractFunction(SRC, 'Foo::commit(int)');
    assert.ok(f);
    assert.equal(f.startLine, 7);
    assert.equal(f.endLine, 15);
    assert.match(f.text, /return 0;\n\}$/);
  });

  test('overloads are told apart by their parameter list', () => {
    const f = extractFunction(SRC, 'Foo::commit(double)');
    assert.ok(f);
    assert.equal(f.startLine, 17);
    assert.match(f.text, /static_cast<int>/);
    // the name alone matches the first definition
    assert.equal(extractFunction(SRC, 'Foo::commit').startLine, 7);
  });

  test('a declaration without body and a missing symbol give null', () => {
    assert.equal(extractFunction(SRC, 'Foo::helper'), null);
    assert.equal(extractFunction(SRC, 'Foo::nothing'), null);
  });

  test('constructors with an initialiser list are found', () => {
    const f = extractFunction(SRC, 'Foo::Foo');
    assert.ok(f);
    assert.equal(f.startLine, 22);
    assert.equal(f.endLine, 24);
  });

  test('a call site is not a definition', () => {
    const text = 'void g()\n{\n    Foo::commit(3);\n}\n';
    assert.equal(extractFunction(text, 'Foo::commit'), null);
  });

  test('a call site that comes before the definition is not mistaken for it', () => {
    const call = 'void g()\n{\n    h(Foo::commit(3)) ;\n    k();\n}\n';
    assert.equal(extractFunction(call, 'Foo::commit'), null);
    const f = extractFunction(`${call}void Foo::commit(int n)\n{\n    run(n);\n}\n`, 'Foo::commit');
    assert.equal(f.startLine, 6);
    assert.equal(f.endLine, 9);
  });
});

describe('fn-v1 normalisation', () => {
  const fn = 'int f()\n{\n    return 1;\n}';

  test('BOM, CRLF, indentation, blank lines and blank runs do not change the hash', () => {
    const base = hashFunctionText(fn);
    const noisy = '﻿int   f()\r\n{\r\n\r\n\treturn  1;\r\n}\r\n';
    const h = hashSymbol(Buffer.from(noisy, 'utf8'), 'f');
    assert.equal(h.sha256, base);
    assert.equal(normalizeSource(Buffer.from(noisy)).includes('\r'), false);
  });

  test('a changed comment or statement changes the hash', () => {
    const base = hashFunctionText(fn);
    assert.notEqual(hashSymbol('int f()\n{\n    // new note\n    return 1;\n}\n', 'f').sha256, base);
    assert.notEqual(hashSymbol('int f()\n{\n    return 2;\n}\n', 'f').sha256, base);
  });
});

describe('parsePinFile', () => {
  const sha = 'a'.repeat(64);
  test('reads metadata and entries; reports malformed lines', () => {
    const text = [
      '# SPDX-License-Identifier: AGPL-3.0-or-later',
      '# group: demo',
      '# pinned-at: upstream/20260101-0000000',
      '# ported-to: Source/Control/X.cpp',
      '',
      `Source/A.cpp\tA::f\tL1-L9\tfn-v1\t${sha}`,
      'Source/B.cpp\tonly\ttwo',
      `Source/C.cpp\tC::g\tL1-L2\tfn-v9\t${sha}`,
      `Source/D.cpp\tD::h\tL1-L2\tfn-v1\t${'A'.repeat(64)}`,
      '',
    ].join('\n');
    const p = parsePinFile(text, 'demo.txt');
    assert.equal(p.group, 'demo');
    assert.equal(p.pinnedAt, 'upstream/20260101-0000000');
    assert.deepEqual(p.portedTo, ['Source/Control/X.cpp']);
    assert.equal(p.entries.length, 1);
    assert.equal(p.problems.length, 3);
  });
});

describe('checkPins', () => {
  let repo;
  let pinsAt;
  let newer;
  before(() => {
    repo = TestRepo.withForkBase('drift-pins');
    const oldSrc = 'void Foo::keep()\n{\n    int a = 1;\n}\n\nvoid Foo::watch()\n{\n    int b = 1;\n}\n';
    const up = repo.commit({ parent: repo.upstream, files: { 'Source/Foo.cpp': oldSrc }, message: `up\n\n${SIGNOFF}\n` });
    const pin = (sym, src) => `Source/Foo.cpp\t${sym}\tL1-L4\tfn-v1\t${hashSymbol(src, sym).sha256}`;
    const pins = ['# group: demo', '# pinned-at: upstream/x', '# ported-to: Source/Control/X.cpp', pin('Foo::keep', oldSrc), pin('Foo::watch', oldSrc), '', ''].join('\n');
    pinsAt = repo.commit({ parent: up, files: { '.github/drift-pins/demo.txt': pins } });
    newer = repo.commit({ parent: up, files: { 'Source/Foo.cpp': oldSrc.replace('int b = 1;', 'int b = 2;\n    int c = 3;') } });
  });
  after(() => repo.dispose());

  test('an unchanged revision reports every pin unchanged', () => {
    const r = checkPins({ cwd: repo.dir, rev: pinsAt, pinsRev: pinsAt });
    assert.equal(r.pins, 2);
    assert.deepEqual(r.entries.map((e) => e.status), ['unchanged', 'unchanged']);
    assert.deepEqual(r.problems, []);
  });

  test('a changed function is reported, an untouched one is not', () => {
    const r = checkPins({ cwd: repo.dir, rev: newer, pinsRev: pinsAt });
    const by = Object.fromEntries(r.entries.map((e) => [e.symbol, e.status]));
    assert.deepEqual(by, { 'Foo::keep': 'unchanged', 'Foo::watch': 'changed' });
  });

  test('a removed file or function is reported as missing', () => {
    const gone = repo.commit({ parent: repo.upstream, files: {} });
    assert.deepEqual(checkPins({ cwd: repo.dir, rev: gone, pinsRev: pinsAt }).entries.map((e) => e.status), ['missing-file', 'missing-file']);
    const other = repo.commit({ parent: repo.upstream, files: { 'Source/Foo.cpp': 'void Foo::other()\n{\n}\n' } });
    assert.deepEqual(checkPins({ cwd: repo.dir, rev: other, pinsRev: pinsAt }).entries.map((e) => e.status), ['missing-symbol', 'missing-symbol']);
  });

  test('no pin files: zero pins', () => {
    const r = checkPins({ cwd: repo.dir, rev: repo.forkBase, pinsRev: repo.forkBase });
    assert.equal(r.pins, 0);
  });
});
