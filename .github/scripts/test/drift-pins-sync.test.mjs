// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// drift-pins --write / --check: stmt-v1, and the agreement of the pin files, mirror-map.json and MIRRORS.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import { checkWorkingTree, extractStatement, hashSymbol, parsePinFile, readMirrors, renderPinFiles, verifyConsistency } from '../drift-pins.mjs';
import { REPO_ROOT } from './helpers.mjs';

describe('stmt-v1', () => {
  const SAMPLE = 'namespace N {\nstatic constexpr int kLimit_Extra{1};\n  static constexpr int kLimit{500};  // comment\n}\n';

  test('stops at the semicolon and does not match a longer identifier', () => {
    const s = extractStatement(SAMPLE, 'static constexpr int kLimit');
    assert.equal(s.startLine, 3);
    assert.equal(s.endLine, 3);
    assert.equal(s.text, '  static constexpr int kLimit{500};');
  });

  test('a declaration that spans lines; a mention in a comment does not count', () => {
    const text = '// static constexpr int kA = 1;\nstatic constexpr int kA =\n    f(1, 2);\n';
    const s = extractStatement(text, 'static constexpr int kA');
    assert.equal(s.startLine, 2);
    assert.equal(s.endLine, 3);
    assert.equal(extractStatement('int x;\n', 'static constexpr int kB'), null);
  });

  test('the hash ignores formatting and sees a changed value', () => {
    const a = hashSymbol(SAMPLE, 'static constexpr int kLimit', 'stmt-v1').sha256;
    assert.equal(hashSymbol('\tstatic constexpr int kLimit{500};   \r\n', 'static constexpr int kLimit', 'stmt-v1').sha256, a);
    assert.notEqual(hashSymbol(SAMPLE.replace('500', '600'), 'static constexpr int kLimit', 'stmt-v1').sha256, a);
  });
});

describe('pin files, mirror-map.json and MIRRORS.md agree', () => {
  const h = (c) => c.repeat(64);
  const mapOf = (mirrors) => JSON.stringify({ schema: 1, mirrors });
  const entry = (id, group, symbol, sha, normalization = 'fn-v1') => ({
    id,
    group,
    upstream: { file: 'Source/Up.cpp', symbol, kind: 'function', normalization, sha256: sha },
    control: [{ file: `Source/Control/${group}.cpp`, symbols: ['x'] }],
  });
  const MAP = mapOf([entry('one', 'alpha', 'A::one', h('1')), entry('two', 'alpha', 'A::two', h('2')), entry('three', 'beta', 'B::three', h('3'), 'stmt-v1')]);
  const mdOf = (rows) =>
    [
      '# t',
      '<!-- mirror-table:begin (generated) -->',
      '| Id | a | b | c | sha256 | Note |',
      '|---|---|---|---|---|---|',
      ...rows.map(([id, sha]) => `| \`${id}\` | \`f\`<br>\`s\` (fn-v1) | \`c\` | \`T\` | \`${sha}\` | note |`),
      '<!-- mirror-table:end -->',
      '',
    ].join('\n');
  const MD = mdOf([['one', h('1')], ['two', h('2')], ['three', h('3')]]);
  const render = () => renderPinFiles(readMirrors(MAP), { pinnedAt: 'upstream/20261008-addb4f4', anchorOf: () => 'L1-L2' });
  const verify = (over = {}) => verifyConsistency({ mirrors: readMirrors(MAP), pinFiles: render(), mirrorsMd: MD, ...over });
  const edit = (name, fn) => {
    const files = render();
    files.set(name, fn(files.get(name)));
    return files;
  };

  test('generated files are deterministic, with the metadata and one TAB-separated line per mirror', () => {
    const a = render();
    assert.deepEqual([...a.keys()], ['alpha.txt', 'beta.txt']);
    assert.equal(a.get('alpha.txt'), render().get('alpha.txt'));
    const p = parsePinFile(a.get('alpha.txt'), 'alpha.txt');
    assert.deepEqual([p.group, p.pinnedAt, p.portedTo, p.problems], ['alpha', 'upstream/20261008-addb4f4', ['Source/Control/alpha.cpp'], []]);
    assert.deepEqual(p.entries.map((e) => [e.symbol, e.sha256]), [['A::one', h('1')], ['A::two', h('2')]]);
    assert.equal(parsePinFile(a.get('beta.txt'), 'beta.txt').entries[0].normalization, 'stmt-v1');
  });

  test('consistent state: no problems', () => {
    assert.deepEqual(verify(), []);
  });

  test('missing pin file', () => {
    const files = render();
    files.delete('beta.txt');
    const p = verify({ pinFiles: files });
    assert.equal(p.length, 1);
    assert.match(p[0], /beta\.txt 缺失/);
  });

  test('no pin files at all (the state before the lists existed) fails', () => {
    assert.equal(verify({ pinFiles: new Map() }).length, 2);
  });

  test('extra pin file and extra entry', () => {
    const files = render();
    files.set('gamma.txt', files.get('alpha.txt').replace('# group: alpha', '# group: gamma'));
    assert.match(verify({ pinFiles: files }).join('\n'), /gamma\.txt 多余/);
    const more = edit('alpha.txt', (t) => `${t}Source/Up.cpp\tA::extra\tL1-L2\tfn-v1\t${h('9')}\n`);
    const p = verify({ pinFiles: more });
    assert.equal(p.length, 1);
    assert.match(p[0], /多余条目：Source\/Up\.cpp 的 A::extra/);
  });

  test('missing entry and duplicated entry', () => {
    const lost = edit('alpha.txt', (t) => t.split('\n').filter((l) => !l.includes('A::two')).join('\n'));
    assert.match(verify({ pinFiles: lost }).join('\n'), /缺少条目：Source\/Up\.cpp 的 A::two/);
    const twice = edit('alpha.txt', (t) => `${t}${t.split('\n').find((l) => l.includes('A::one'))}\n`);
    assert.match(verify({ pinFiles: twice }).join('\n'), /出现了不止一行/);
  });

  test('a hash or normalization that differs from mirror-map.json', () => {
    const p = verify({ pinFiles: edit('alpha.txt', (t) => t.replace(h('2'), h('f'))) });
    assert.equal(p.length, 1);
    assert.match(p[0], /two 的 sha256 与 Source\/Control\/mirror-map\.json 不一致/);
    assert.match(verify({ pinFiles: edit('beta.txt', (t) => t.replace('stmt-v1', 'fn-v1')) }).join('\n'), /three 的规范化方式是 fn-v1/);
  });

  test('MIRRORS.md that differs: hash, missing row, extra row, no table', () => {
    assert.match(verify({ mirrorsMd: mdOf([['one', h('1')], ['two', h('e')], ['three', h('3')]]) }).join('\n'), /MIRRORS\.md：two 的 sha256/);
    assert.match(verify({ mirrorsMd: mdOf([['one', h('1')], ['three', h('3')]]) }).join('\n'), /MIRRORS\.md 缺少 two/);
    assert.match(verify({ mirrorsMd: mdOf([['one', h('1')], ['two', h('2')], ['three', h('3')], ['four', h('4')]]) }).join('\n'), /MIRRORS\.md 多余的行：four/);
    assert.match(verify({ mirrorsMd: '# no table\n' }).join('\n'), /找不到 mirror-table/);
  });

  test('mirror-map.json that lists a function twice or uses a bad group name', () => {
    const dup = readMirrors(mapOf([entry('one', 'alpha', 'A::one', h('1')), entry('uno', 'alpha', 'A::one', h('1'))]));
    assert.match(verifyConsistency({ mirrors: dup, pinFiles: new Map(), mirrorsMd: MD }).join('\n'), /登记了不止一次/);
    const bad = readMirrors(mapOf([entry('one', 'Alpha_1', 'A::one', h('1'))]));
    assert.match(verifyConsistency({ mirrors: bad, pinFiles: new Map(), mirrorsMd: MD }).join('\n'), /group「Alpha_1」/);
  });

  test('checkWorkingTree reads the three places from a directory', () => {
    const dir = makeTempDir('drift-pins-tree');
    try {
      const put = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      };
      put('Source/Control/mirror-map.json', MAP);
      put('Source/Control/MIRRORS.md', MD);
      assert.equal(checkWorkingTree(dir).problems.length, 2);
      for (const [name, text] of render()) put(`.github/drift-pins/${name}`, text);
      assert.deepEqual(checkWorkingTree(dir).problems, []);
      put('.github/drift-pins/alpha.txt', render().get('alpha.txt').replace(h('1'), h('0')));
      assert.equal(checkWorkingTree(dir).problems.length, 1);
    } finally {
      removeDir(dir);
    }
  });

  test('this repository: the committed pin files match mirror-map.json and MIRRORS.md', () => {
    const r = checkWorkingTree(REPO_ROOT);
    assert.deepEqual(r.problems, []);
    assert.ok(r.mirrors > 0);
  });
});
