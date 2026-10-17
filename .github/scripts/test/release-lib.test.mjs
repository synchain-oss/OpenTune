// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests of the test-build packaging: release-lib.mjs (pure functions), the notices collector of
// release-notices.mjs, and release-package.mjs end to end on synthetic build inputs (the package is
// assembled from the real templates; the binaries are a few placeholder bytes).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import {
  araLinkStatus,
  buildControlJson,
  checkPackageEntries,
  containsSample,
  createZip,
  evaluateForkGate,
  evaluateWhen,
  formatSha256Sums,
  linkClosure,
  PACKAGE_FILES,
  packageName,
  parseDefines,
  parseNinja,
  parseSha256Sums,
  parseTestTag,
  readCmakeProjectVersion,
  readProtocolMajor,
  readZip,
  renderTemplate,
  selectJuceVendored,
  sha256Hex,
  summarizeModifications,
  toCrlf,
  validateControlJson,
  verifySha256Sums,
} from '../release-lib.mjs';
import { collectComponents, mustNotDropSilently, renderNotices } from '../release-notices.mjs';
import { validateBuild, verifyZipBuffer } from '../release-package.mjs';
import { REPO_ROOT, SCRIPTS } from './helpers.mjs';

const ORT = 'OpenTuneOnnxRuntime_1_24_4.dll';
const ALLOWED = PACKAGE_FILES.map((f) => (typeof f === 'string' ? f : ORT));
const entries = (names) => names.map((n) => ({ path: n, head: Buffer.from('MZ') }));
const SHA = 'a'.repeat(40);
const ACTIONS = { slug: 'github-actions' };

describe('tags and versions', () => {
  it('accepts synchain-test/v<x.y.z>-ctl.<n> only', () => {
    assert.deepEqual(parseTestTag('synchain-test/v1.8.0-ctl.2'), { version: '1.8.0', n: 2, label: 'ctl.2' });
    for (const bad of ['v1.8.0', 'synchain-test/v1.8.0', 'synchain-test/v1.8-ctl.1', 'synchain-test/v1.8.0-ctl.0', 'synchain-test/v1.8.0-ctl.1-x', 'OpenTune-1.8.0', '']) {
      assert.equal(parseTestTag(bad), null, bad);
    }
  });

  it('reads the CMake version and the protocol major from the repository', () => {
    assert.match(readCmakeProjectVersion(fs.readFileSync(path.join(REPO_ROOT, 'CMakeLists.txt'), 'utf8')), /^\d+\.\d+\.\d+$/);
    assert.equal(readProtocolMajor(fs.readFileSync(path.join(REPO_ROOT, 'Source', 'Control', 'ControlProtocol.h'), 'utf8')), 1);
    assert.throws(() => readCmakeProjectVersion('project(Other VERSION 1.0.0)'));
  });

  it('names the package after the version and the build label', () => {
    assert.equal(packageName({ version: '1.8.0', label: 'ctl.3' }), 'OpenTune-1.8.0-ctl.3-unofficial-win-x64');
    assert.equal(packageName({ version: '1.8.0', label: 'rehearsal-abcdef0' }), 'OpenTune-1.8.0-rehearsal-abcdef0-unofficial-win-x64');
    assert.throws(() => packageName({ version: '1.8.0', label: '../x' }));
  });

  it('requires fork-gate to be green on the tagged commit', () => {
    assert.equal(evaluateForkGate([]).ok, false);
    assert.equal(evaluateForkGate([{ name: 'fork-gate', status: 'in_progress', app: ACTIONS }]).ok, false);
    const ok = { name: 'fork-gate', status: 'completed', conclusion: 'success', completed_at: '2026-10-02T00:00:00Z', app: ACTIONS };
    const bad = { name: 'fork-gate', status: 'completed', conclusion: 'failure', completed_at: '2026-10-01T00:00:00Z', app: ACTIONS };
    assert.equal(evaluateForkGate([bad, ok]).ok, true);
    assert.equal(evaluateForkGate([ok, { ...bad, completed_at: '2026-10-03T00:00:00Z' }]).ok, false);
    assert.equal(evaluateForkGate([{ ...ok, name: 'self-test' }]).ok, false);
  });

  it('counts only the fork-gate check runs that GitHub Actions created (negative: a same-name run from another app)', () => {
    const other = { slug: 'some-other-app' };
    const realRed = { name: 'fork-gate', status: 'completed', conclusion: 'failure', completed_at: '2026-10-01T00:00:00Z', app: ACTIONS };
    const fakeGreen = { name: 'fork-gate', status: 'completed', conclusion: 'success', completed_at: '2026-10-02T00:00:00Z', app: other };
    // A newer green run from another app does not hide the red GitHub Actions run.
    const masked = evaluateForkGate([realRed, fakeGreen]);
    assert.equal(masked.ok, false);
    assert.match(masked.detail, /conclusion is failure; 1 same-name check run\(s\) from other apps ignored/);
    // Only impostors (or runs without app information): no fork-gate at all.
    for (const runs of [[fakeGreen], [{ ...fakeGreen, app: undefined }]]) {
      const r = evaluateForkGate(runs);
      assert.equal(r.ok, false);
      assert.match(r.detail, /no fork-gate check run from GitHub Actions/);
    }
    // Another app's run still in progress does not hold up a green GitHub Actions run, nor does its failure.
    const realGreen = { ...realRed, conclusion: 'success' };
    assert.equal(evaluateForkGate([realGreen, { ...fakeGreen, status: 'in_progress' }]).ok, true);
    assert.equal(evaluateForkGate([realGreen, { ...fakeGreen, conclusion: 'failure', completed_at: '2026-10-09T00:00:00Z' }]).ok, true);
  });

  it('validates a tag build: name, version, on dev, fork-gate', () => {
    const green = [{ name: 'fork-gate', status: 'completed', conclusion: 'success', completed_at: 'x', app: ACTIONS }];
    const good = validateBuild({ cmakeVersion: '1.8.0', tag: 'synchain-test/v1.8.0-ctl.1', sha: SHA, checkRuns: green, isAncestorOfDev: () => true });
    assert.equal(good.mode, 'release');
    assert.equal(good.name, 'OpenTune-1.8.0-ctl.1-unofficial-win-x64');
    assert.ok(good.checks.every((c) => c.ok));
    const wrongVersion = validateBuild({ cmakeVersion: '1.8.1', tag: 'synchain-test/v1.8.0-ctl.1', sha: SHA, checkRuns: green, isAncestorOfDev: () => true });
    assert.equal(wrongVersion.checks.find((c) => c.name === 'version').ok, false);
    const offDev = validateBuild({ cmakeVersion: '1.8.0', tag: 'synchain-test/v1.8.0-ctl.1', sha: SHA, checkRuns: green, isAncestorOfDev: () => false });
    assert.equal(offDev.checks.find((c) => c.name === 'on dev').ok, false);
    const rehearsal = validateBuild({ cmakeVersion: '1.8.0', tag: '', sha: SHA, checkRuns: [], isAncestorOfDev: () => assert.fail('not called') });
    assert.equal(rehearsal.mode, 'rehearsal');
    assert.equal(rehearsal.label, 'rehearsal-aaaaaaa');
  });
});

describe('package allow-list', () => {
  it('accepts exactly the allow-list', () => {
    assert.deepEqual(checkPackageEntries(entries(ALLOWED)), []);
  });

  it('fails on one extra file (negative case)', () => {
    const problems = checkPackageEntries(entries([...ALLOWED, 'notes.txt']));
    assert.deepEqual(problems, ['not on the allow-list: notes.txt']);
  });

  it('fails on a missing file, a subdirectory or a second ONNX Runtime DLL', () => {
    assert.ok(checkPackageEntries(entries(ALLOWED.filter((n) => n !== 'INSTALL.txt'))).includes('missing: INSTALL.txt'));
    assert.ok(checkPackageEntries([...entries(ALLOWED), { path: 'docs', isDir: true }]).some((p) => p.startsWith('unexpected directory')));
    assert.deepEqual(checkPackageEntries(entries([...ALLOWED, 'OpenTuneOnnxRuntime_1_20_0.dll'])), [
      `more than one file matches ${PACKAGE_FILES.find((f) => typeof f !== 'string').source}: ${ORT}, OpenTuneOnnxRuntime_1_20_0.dll`,
    ]);
  });

  it('fails on a duplicate entry, also one that differs only in case; messages name the file', () => {
    assert.deepEqual(checkPackageEntries(entries([...ALLOWED, 'OpenTune.exe'])), ['duplicate entry: OpenTune.exe']);
    assert.deepEqual(checkPackageEntries(entries([...ALLOWED, 'install.TXT'])), ['duplicate entry: install.TXT (differs from INSTALL.txt only in case)']);
    for (const p of checkPackageEntries(entries([...ALLOWED, 'OpenTune.exe', 'SHA256SUMS', 'x.txt']))) assert.doesNotMatch(p, /undefined/);
  });

  it('fails on model weights, models/, D3D12*, d3dconfig.exe, STATEMENTS.txt (recursive, any case)', () => {
    for (const bad of ['fcpe.ONNX', 'Models/fcpe.txt', 'sub/models/x', 'D3D12/D3D12Core.dll', 'd3d12core.dll', 'x/D3DConfig.exe', 'statements.TXT']) {
      const problems = checkPackageEntries(entries([...ALLOWED, bad]));
      assert.ok(problems.some((p) => p.startsWith('forbidden:')), `${bad}: ${problems.join('; ')}`);
    }
  });

  it('fails on a Git LFS pointer even under an allowed name', () => {
    const list = entries(ALLOWED);
    list.find((e) => e.path === 'OpenTune.exe').head = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:00\n');
    assert.ok(checkPackageEntries(list).some((p) => p.includes('Git LFS pointer')));
  });
});

describe('SHA256SUMS', () => {
  const hashes = new Map([['b.txt', sha256Hex(Buffer.from('b'))], ['A.exe', sha256Hex(Buffer.from('a'))]]);

  it('round-trips, sorted bytewise, two spaces', () => {
    const text = formatSha256Sums(hashes);
    assert.equal(text.split('\n')[0], `${hashes.get('A.exe')}  A.exe`);
    assert.deepEqual(parseSha256Sums(text), hashes);
    assert.deepEqual(verifySha256Sums(text, hashes), []);
  });

  it('reports a wrong hash, an unlisted file and a listed file that does not exist', () => {
    const text = formatSha256Sums(hashes);
    assert.deepEqual(verifySha256Sums(text, new Map([...hashes, ['b.txt', sha256Hex(Buffer.from('x'))]])), ['SHA256SUMS mismatch for b.txt']);
    assert.deepEqual(verifySha256Sums(text, new Map([...hashes, ['c.txt', '0'.repeat(64)]])), ['SHA256SUMS does not list c.txt']);
    assert.deepEqual(verifySha256Sums(text, new Map([['A.exe', hashes.get('A.exe')]])), ['SHA256SUMS lists b.txt, which is not in the package']);
    assert.match(verifySha256Sums('nonsense\n', hashes)[0], /malformed/);
  });
});

describe('opentune-control.json', () => {
  const d3d12 = { agilityVersion: '1.619.5', sdkVersion: 619, files: [{ name: 'D3D12Core.dll', sha256: 'b'.repeat(64) }] };
  const make = (over = {}) => ({ ...buildControlJson({ protocolMajor: 1, appVersion: '1.8.0', commit: SHA, tag: 'synchain-test/v1.8.0-ctl.1', label: 'ctl.1', date: '2026-10-15', sourceUrl: 'https://example.invalid/tree/x', officialRepositoryUrl: 'https://github.com/YuFeng926/OpenTune', d3d12 }), ...over });
  const bytes = (o) => Buffer.from(JSON.stringify(o));

  it('is valid for the MCP reader and for this package', () => {
    assert.deepEqual(validateControlJson(bytes(make())), []);
    assert.deepEqual(validateControlJson(bytes(make({ build: { ...make().build, tag: null } }))), []);
  });

  it('applies the reader rules: object, <= 8 KiB, no BOM, positive integers containing 1', () => {
    assert.ok(validateControlJson(bytes(make({ protocolMajors: [2] }))).includes('protocolMajors must contain 1'));
    assert.ok(validateControlJson(bytes(make({ protocolMajors: [1, 0] }))).some((p) => p.includes('positive integers')));
    assert.ok(validateControlJson(bytes(make({ protocolMajors: '1' }))).some((p) => p.includes('positive integers')));
    assert.ok(validateControlJson(bytes(make({ pad: 'x'.repeat(9000) }))).some((p) => p.includes('larger than')));
    assert.ok(validateControlJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(make())])).some((p) => p.includes('BOM')));
    assert.deepEqual(validateControlJson(Buffer.from('[1]')), ['not a JSON object']);
    assert.ok(validateControlJson(bytes(make({ modelsBundled: true }))).includes('modelsBundled must be false'));
  });
});

describe('templates', () => {
  it('renders placeholders and rejects missing or malformed ones', () => {
    assert.equal(renderTemplate('a {{X}} b {{X}}', { X: 1 }), 'a 1 b 1');
    assert.throws(() => renderTemplate('{{X}} {{Y}}', { X: 1 }), /Y/);
    assert.throws(() => renderTemplate('{{ X }}', { X: 1 }), /malformed/);
    assert.equal(renderTemplate('<!--\nSPDX\n-->\n# T {{X}}', { X: 2 }, { stripLeadingComment: true }), '# T 2');
  });

  it('OpenTune-AI.cmd: only comments are non-ASCII, each ends in ASCII; packaged with CRLF', () => {
    // A Windows checkout with core.autocrlf=true has CRLF in the working tree; compare the normalised text.
    const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'templates', 'OpenTune-AI.cmd'), 'utf8').replace(/\r\n/g, '\n');
    for (const line of text.split('\n')) {
      // cmd.exe parses batch files in the console code page: keep non-ASCII text in rem lines and end
      // them in ASCII, so that a multi-byte character can never swallow the line end.
      if (/[^\x00-\x7f]/.test(line)) assert.match(line, /^rem .*[\x21-\x7e]$/, line);
    }
    assert.match(text, /--control-api %\*/);
    const crlf = toCrlf(text);
    assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);
  });

  it('README-UNOFFICIAL lists every file of the package (both languages)', () => {
    for (const t of ['README-UNOFFICIAL.txt', 'README-UNOFFICIAL.zh-CN.txt']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'templates', t), 'utf8');
      for (const f of PACKAGE_FILES) if (typeof f === 'string') assert.ok(text.includes(f), `${t} does not mention ${f}`);
      assert.ok(text.includes('{{ORT_DLL}}'));
    }
  });
});

describe('modifications summary', () => {
  it('lists changed upstream files and added directories; fork-only files are counted apart', () => {
    const added = ['Source/Control/A.cpp', 'Source/Control/B.cpp', 'Source/Control/Ops/C.cpp', 'Source/Control/D.h', 'cmake/OpenTuneControl.cmake'];
    const s = summarizeModifications(['M\tSource/PluginProcessor.cpp', ...added.map((f) => `A\t${f}`), 'A\t.github/x.yml', 'A\tCLAUDE.md', 'D\tOld.txt', 'M\tCMakeLists.txt'].join('\n'));
    assert.deepEqual(s.modified, ['CMakeLists.txt', 'Source/PluginProcessor.cpp']);
    assert.deepEqual(s.deleted, ['Old.txt']);
    assert.deepEqual(s.added, [{ dir: 'Source/Control/', count: 4 }, { dir: 'cmake/OpenTuneControl.cmake', count: 1 }]);
    assert.equal(s.forkOnly, 2);
  });
});

describe('zip', () => {
  const files = [{ name: 'P/' }, { name: 'P/a.txt', data: Buffer.from('hello hello hello hello hello') }, { name: 'P/b.bin', data: Buffer.from([1, 2, 3]) }];

  it('round-trips (deflated and stored) and is deterministic', () => {
    const z1 = createZip(files, { date: '2026-10-15T12:00:00Z' });
    const z2 = createZip(files, { date: '2026-10-15T12:00:00Z' });
    assert.ok(z1.equals(z2));
    const back = readZip(z1);
    assert.deepEqual(back.map((e) => e.name), ['P/', 'P/a.txt', 'P/b.bin']);
    assert.equal(back[1].data.toString(), 'hello hello hello hello hello');
    assert.deepEqual([...back[2].data], [1, 2, 3]);
  });

  it('detects corrupted data', () => {
    const z = createZip([{ name: 'x', data: Buffer.from([9, 9, 9, 9]) }]);
    z[30 + 1] ^= 0xff; // first byte of the stored data, after the 30-byte local header and the name
    assert.throws(() => readZip(z), /CRC/);
  });

  it('refuses an entry name that occurs twice instead of keeping one copy', () => {
    const z = createZip([...files, { name: 'P/a.txt', data: Buffer.from('another copy') }]);
    assert.throws(() => readZip(z), /zip: duplicate entry P\/a\.txt/);
  });
});

describe('Ninja build graph and ARA link check', () => {
  const ninja = [
    '# comment',
    'build CMakeFiles\\S.dir\\Release\\Src\\Main.cpp.obj: CXX_COMPILER__App_unscanned_Release C$:\\src\\Source\\Main.cpp || order',
    '  DEFINES = -DJUCE_ASIO=1 -DJucePlugin_Enable_ARA=0 -DOPENTUNE_VERSION=\\"1.8.0\\"',
    '  INCLUDES = -IC:\\src\\ThirdParty\\r8brain-free-src-master -I"C:\\Program Files\\x"',
    'build CMakeFiles\\Lib.dir\\Release\\JUCE-master\\modules\\juce_core\\juce_core.cpp.obj: CXX_COMPILER__Lib_unscanned_Release C$:\\src\\JUCE-master\\modules\\juce_core\\juce_core.cpp',
    '  DEFINES = -DJUCE_ASIO=1',
    'build CMakeFiles\\Lib.dir\\Release\\JUCE-master\\modules\\juce_audio_formats\\juce_audio_formats.cpp.obj: CXX_COMPILER__Lib_unscanned_Release C$:\\src\\JUCE-master\\modules\\juce_audio_formats\\juce_audio_formats.cpp',
    '  DEFINES = -DJUCE_USE_FLAC=0',
    'build Release\\Lib.lib: CXX_STATIC_LIBRARY_LINKER__Lib_Release CMakeFiles\\Lib.dir\\Release\\JUCE-master\\modules\\juce_core\\juce_core.cpp.obj CMakeFiles\\Lib.dir\\Release\\JUCE-master\\modules\\juce_audio_formats\\juce_audio_formats.cpp.obj',
    'build Release\\Unused.obj: CXX_COMPILER__Other_unscanned_Release C$:\\src\\ThirdParty\\ARA_SDK-releases-2.3.0\\ARA_Library\\X.cpp',
    'build App_artefacts\\Release\\App.exe: CXX_EXECUTABLE_LINKER__App_Release CMakeFiles\\S.dir\\Release\\Src\\Main.cpp.obj | Release\\Lib.lib',
    '  LINK_FLAGS = /machine:x64 /DELAYLOAD:OpenTuneOnnxRuntime_1_24_4.dll',
    '  LINK_LIBRARIES = Release\\Lib.lib  kernel32.lib  "C:\\Program Files (x86)\\d3d12.lib"',
  ].join('\r\n');

  it('follows the executable through static libraries, with sources, macros and include paths', () => {
    const c = linkClosure(parseNinja(ninja), { target: 'App', config: 'Release' });
    assert.equal(c.exe, 'App_artefacts/Release/App.exe');
    assert.deepEqual(c.objects.map((o) => o.source), ['C:/src/Source/Main.cpp', 'C:/src/JUCE-master/modules/juce_core/juce_core.cpp', 'C:/src/JUCE-master/modules/juce_audio_formats/juce_audio_formats.cpp']);
    assert.equal(c.objects[0].defines.OPENTUNE_VERSION, '1.8.0');
    assert.ok(c.objects[0].includes.includes('C:/Program Files/x'));
    assert.match(c.linkFlags, /DELAYLOAD:OpenTuneOnnxRuntime_1_24_4\.dll/);
    assert.throws(() => linkClosure(parseNinja(ninja), { target: 'Missing', config: 'Release' }), /no CXX_EXECUTABLE_LINKER__Missing_Release/);
  });

  it('ARA is not linked unless an ARA source, an ARA library or an ARA macro is in the closure', () => {
    const c = linkClosure(parseNinja(ninja), { target: 'App', config: 'Release' });
    assert.deepEqual(araLinkStatus(c), { linked: false, reasons: [] });
    const withMacro = linkClosure(parseNinja(ninja.replace('JucePlugin_Enable_ARA=0', 'JucePlugin_Enable_ARA=1')), { target: 'App', config: 'Release' });
    assert.equal(araLinkStatus(withMacro).linked, true);
    const withSource = linkClosure(parseNinja(ninja.replace('CMakeFiles\\S.dir\\Release\\Src\\Main.cpp.obj | Release', 'CMakeFiles\\S.dir\\Release\\Src\\Main.cpp.obj Release\\Unused.obj | Release')), { target: 'App', config: 'Release' });
    assert.ok(araLinkStatus(withSource).reasons.some((r) => r.startsWith('ARA SDK source')));
  });

  it('parses -D tokens', () => {
    assert.deepEqual(parseDefines('-DA=1 /DB "-DC=x y" -DD= -DE=\\"1.8.0\\"'), { A: '1', B: '1', C: 'x y', D: '', E: '1.8.0' });
  });

  it('selects JUCE-vendored packages by linked module and switch (JUCE defaults for unset macros)', () => {
    const c = linkClosure(parseNinja(ninja), { target: 'App', config: 'Release' });
    const sbom = {
      packages: [
        { SPDXID: 'core', name: 'juce_core' }, { SPDXID: 'af', name: 'juce_audio_formats' }, { SPDXID: 'gfx', name: 'juce_graphics' },
        { SPDXID: 'z', name: 'zlib', versionInfo: '1', licenseConcluded: 'Zlib', sourceInfo: 'Vendored at modules/juce_core/zip/zlib in the JUCE source tree' },
        { SPDXID: 'f', name: 'FLAC', versionInfo: '1', licenseConcluded: 'BSD-3-Clause' },
        { SPDXID: 'o', name: 'Opus', versionInfo: '1', licenseConcluded: 'BSD-3-Clause' },
        { SPDXID: 'png', name: 'libpng', versionInfo: '1', licenseConcluded: 'libpng-2.0' },
      ],
      relationships: [
        { spdxElementId: 'core', relationshipType: 'CONTAINS', relatedSpdxElement: 'z' },
        { spdxElementId: 'af', relationshipType: 'CONTAINS', relatedSpdxElement: 'f' },
        { spdxElementId: 'af', relationshipType: 'CONTAINS', relatedSpdxElement: 'o' },
        { spdxElementId: 'gfx', relationshipType: 'CONTAINS', relatedSpdxElement: 'png' },
      ],
    };
    const conditions = { FLAC: { anyMacro: [{ name: 'JUCE_USE_FLAC', default: '1' }] }, Opus: { anyMacro: [{ name: 'JUCE_USE_OPUS', default: '1' }] } };
    const sel = selectJuceVendored(sbom, c, conditions);
    assert.deepEqual(sel.included.map((p) => p.name), ['Opus', 'zlib']);
    assert.equal(sel.included.find((p) => p.name === 'zlib').location, 'modules/juce_core/zip/zlib');
    assert.deepEqual(sel.excluded.map((p) => p.name), ['FLAC', 'libpng']);
    assert.equal(evaluateWhen({ never: 'Android only' }, []).ok, false);
  });
});

describe('notices collector', () => {
  const roots = { repo: REPO_ROOT, juce: '/nonexistent', deps: '/nonexistent' };
  const closure = { exe: 'App.exe', linkFlags: '', libraries: [], objects: [{ output: 'a.obj', source: 'C:/src/ThirdParty/soundtouch-2.3.3/source/SoundTouch/AAFilter.cpp', defines: {}, includes: [] }] };
  const catalogue = {
    components: [
      { id: 'opentune', name: 'OpenTune', license: 'AGPL-3.0', probe: { kind: 'always' } },
      { id: 'soundtouch', name: 'SoundTouch', license: 'LGPL-2.1', probe: { kind: 'source', pattern: '/ThirdParty/soundtouch-[^/]+/' }, licenseFiles: [{ root: 'repo', path: 'LICENSES/soundtouch.LGPL-2.1.txt' }] },
      { id: 'font', name: 'Font', probe: { kind: 'embedded', files: 'Resources/Fonts/HONORSansCN-Medium.ttf' }, redistribution: 'unverified', unverifiedReason: 'no license file' },
      { id: 'cursors', name: 'Cursors', probe: { kind: 'embedded', files: 'Resources/UI/cursors/*.png' }, needsGpl3: true },
      // Embedded data whose terms ask for nothing (like the CC0 piano samples).
      { id: 'icon', name: 'Icon', probe: { kind: 'embedded', files: 'Resources/UI/cursors/adwaita_dragging.png' } },
      { id: 'r8brain', name: 'r8brain', license: 'MIT', probe: { kind: 'include', pattern: '/ThirdParty/r8brain-free-src[^/]*$', repoFiles: 'ThirdParty/r8brain-free-src-master/*.h' }, licenseFiles: [{ root: 'repo', path: 'ThirdParty/r8brain-free-src-master/LICENSE' }] },
      { id: 'ara-sdk', name: 'ARA', probe: { kind: 'ara' }, requireOneLicenseFile: true },
      { id: 'dml', name: 'DirectML', probe: { kind: 'appFile', pattern: '^DirectML\\.dll$' } },
    ],
  };
  const font = fs.readFileSync(path.join(REPO_ROOT, 'Resources', 'Fonts', 'HONORSansCN-Medium.ttf'));
  const mid = Math.floor(font.length / 2);
  const cursor = fs.readFileSync(path.join(REPO_ROOT, 'Resources', 'UI', 'cursors', 'adwaita_crosshair.png'));
  const r8brainInclude = { output: 'b.obj', source: 'C:/src/Source/Resampler.cpp', defines: {}, includes: ['C:/src/ThirdParty/r8brain-free-src-master/'] };
  const collect = (over) => collectComponents({ catalogue, closure, exeBuf: Buffer.from('MZ'), appFiles: ['DirectML.dll'], roots, lock: { deps: [] }, sbom: {}, ...over });

  it('keeps an unverified component out of the notices and reports it as a release blocker', () => {
    const exeBuf = Buffer.concat([Buffer.from('MZ'), font.subarray(mid - 4096, mid + 4096), cursor]);
    assert.ok(containsSample(exeBuf, font));
    const got = collect({ exeBuf, appFiles: ['OpenTune.exe'], closure: { ...closure, objects: [...closure.objects, r8brainInclude] } });
    assert.deepEqual(got.included, ['opentune', 'soundtouch', 'cursors', 'r8brain']);
    assert.deepEqual(got.blockers.map((b) => b.id), ['font']);
    assert.match(got.blockers[0].why, /is in the build .* redistribution terms are unverified: no license file/);
    assert.deepEqual(got.excluded.map((x) => x.id).sort(), ['ara-sdk', 'dml', 'font', 'icon']);
    assert.equal(got.needsGpl3, true);
    const text = renderNotices({ header: { title: 'T', intro: ['no model weights'] }, sections: got.sections, gpl3Text: null });
    assert.match(text, /1\. OpenTune/);
    assert.match(text, /GNU LESSER GENERAL PUBLIC LICENSE/);
    assert.doesNotMatch(text, /Font|HONOR/);
  });

  it('fails closed: a probe that finds nothing of a component the repository has keeps it a release blocker (negative case)', () => {
    // As if upstream changed how the font and the cursor images are embedded, and how r8brain is
    // included: the repository still has their files, the probes find nothing in the build.
    const got = collect();
    assert.deepEqual(got.blockers.map((b) => b.id), ['font', 'cursors', 'r8brain']);
    for (const b of got.blockers) assert.match(b.why, /the repository has \d+ file\(s\) matching .*, but the probe found none in the build/);
    assert.match(got.blockers.find((b) => b.id === 'font').why, /redistribution terms are unverified/);
    assert.match(got.blockers.find((b) => b.id === 'cursors').why, /its notice would be dropped/);
    for (const id of ['font', 'cursors', 'r8brain']) assert.match(got.excluded.find((x) => x.id === id).why, /^release blocker: /);
    assert.ok(!got.included.some((id) => ['font', 'cursors', 'r8brain'].includes(id)));
    // Terms that ask for nothing, or no repository evidence (ARA: not linked by design): simply left out.
    assert.ok(!got.blockers.some((b) => ['icon', 'ara-sdk'].includes(b.id)));
    assert.deepEqual(got.included, ['opentune', 'soundtouch', 'dml']);
  });

  it('absentOk with a reason accepts the absence; an empty reason is refused', () => {
    const withAbsentOk = (reason) => ({ components: catalogue.components.map((c) => (c.id === 'cursors' ? { ...c, absentOk: reason } : c)) });
    const got = collect({ catalogue: withAbsentOk('the cursor images are no longer compiled in') });
    assert.deepEqual(got.blockers.map((b) => b.id), ['font', 'r8brain']);
    assert.match(got.excluded.find((x) => x.id === 'cursors').why, /absence accepted: the cursor images are no longer compiled in$/);
    assert.throws(() => collect({ catalogue: withAbsentOk('  ') }), /cursors: absentOk must be a non-empty reason/);
    assert.throws(() => collect({ catalogue: withAbsentOk(true) }), /absentOk must be a non-empty reason/);
  });

  it('a source / include probe whose repository files are absent is not a blocker', () => {
    const gone = { id: 'gone', name: 'Gone', license: 'MIT', probe: { kind: 'source', pattern: '/ThirdParty/gone/', repoFiles: 'ThirdParty/gone-1.0/*.cpp' }, licenseFiles: [{ root: 'repo', path: 'LICENSE' }] };
    const got = collect({ catalogue: { components: [gone] } });
    assert.deepEqual(got.blockers, []);
    assert.deepEqual(got.excluded, [{ id: 'gone', why: '0 compiled sources match /ThirdParty/gone/' }]);
  });

  it('mustAppear: a probe that misses the component blocks the build; without the field a component with no obligations stays omittable', () => {
    const embedded = { kind: 'embedded', files: 'Resources/Fonts/HONORSansCN-Medium.ttf' };
    const only = (extra) => ({ components: [{ id: 'f', name: 'F', license: 'L', probe: embedded, ...extra }] });
    const missed = collect({ catalogue: only({ mustAppear: true }) });
    assert.deepEqual(missed.blockers.map((b) => b.id), ['f']);
    assert.match(missed.blockers[0].why, /the repository has 1 file\(s\) matching .*, but the probe found none in the build .* its notice would be dropped/);
    assert.deepEqual(missed.included, []);
    const omitted = collect({ catalogue: only({}) });
    assert.deepEqual(omitted.blockers, []);
    assert.deepEqual(omitted.included, []);
    assert.match(omitted.excluded[0].why, /^0 of 1 files of /);
    // When the probe does find it, the notice is written and nothing blocks.
    const found = collect({ catalogue: only({ mustAppear: true }), exeBuf: Buffer.concat([Buffer.from('MZ'), font]) });
    assert.deepEqual(found.blockers, []);
    assert.deepEqual(found.included, ['f']);
    assert.equal(mustNotDropSilently({ mustAppear: true }), true);
    assert.equal(mustNotDropSilently({}), false);
  });

  it('the real catalogue ships HONOR Sans like the official build: not unverified, written into the notices, still not droppable silently', () => {
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'notices.json'), 'utf8'));
    const honor = real.components.find((c) => c.id === 'honor-sans');
    assert.notEqual(honor.redistribution, 'unverified');
    assert.equal(honor.unverifiedReason, undefined);
    assert.equal(honor.mustAppear, true);
    assert.match(honor.license, /HONOR font license \(commercial \/ personal use within OpenTune\)/);
    assert.ok(honor.copyright);
    const credits = fs.readFileSync(path.join(REPO_ROOT, 'Resources', 'About', 'credits.md'), 'utf8');
    assert.ok(credits.includes('HONOR font license (commercial / personal use within OpenTune)'));
    const got = collectComponents({
      catalogue: { components: [honor] },
      closure,
      exeBuf: Buffer.concat([Buffer.from('MZ'), font]),
      appFiles: [],
      roots,
      lock: { deps: [] },
      sbom: {},
    });
    assert.deepEqual(got.blockers, []);
    assert.deepEqual(got.included, ['honor-sans']);
    assert.match(got.sections[0].license, /HONOR font license/);
    // Dropping the field must turn the guard red: an entry without it is omittable again.
    assert.equal(mustNotDropSilently(honor), true);
    const { mustAppear, ...withoutField } = honor;
    assert.equal(mustNotDropSilently(withoutField), false);
  });

  it('the real catalogue uses known probe kinds and names repository files for fail-closed probes', () => {
    const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'notices.json'), 'utf8'));
    const kinds = new Set(['always', 'juce', 'source', 'include', 'embedded', 'appFile', 'ara']);
    for (const c of real.components) assert.ok(kinds.has(c.probe.kind), c.id);
    for (const id of ['honor-sans', 'cursors', 'soundtouch', 'r8brain']) assert.ok(mustNotDropSilently(real.components.find((c) => c.id === id)), id);
    for (const c of real.components) {
      if (['source', 'include'].includes(c.probe.kind) && mustNotDropSilently(c)) assert.match(c.probe.repoFiles ?? '', /^ThirdParty\//, `${c.id}: probe.repoFiles`);
    }
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github', 'release', 'licenses', 'GPL-3.0.txt')));
  });
});

describe('release-package.mjs build and verify (end to end on synthetic inputs)', () => {
  function makeInputs(dir, { blockers = [] } = {}) {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'OpenTune.exe'), Buffer.from('MZ placeholder executable'));
    fs.writeFileSync(path.join(dir, 'app', ORT), Buffer.from('MZ placeholder ort'));
    fs.writeFileSync(path.join(dir, 'app', 'DirectML.dll'), Buffer.from('MZ placeholder dml'));
    fs.writeFileSync(path.join(dir, 'licenses', 'DirectML-LICENSE.txt'), 'license terms\n');
    fs.writeFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), 'notices\r\n');
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({
      schema: 1, controlApi: true, ortDll: ORT, ara: { linked: false, reasons: [] }, blockers,
      d3d12: { agilityVersion: '1.619.5', sdkVersion: 619, files: [{ name: 'D3D12Core.dll', sha256: 'c'.repeat(64) }] },
      commands: [{ step: 'Build', argv: ['cmake', '--build', '<build>'] }],
    }));
    fs.writeFileSync(path.join(dir, 'name-status.txt'), 'M\tSource/PluginProcessor.cpp\nA\tSource/Control/X.cpp\nA\t.github/x.yml\n');
  }
  const version = () => readCmakeProjectVersion(fs.readFileSync(path.join(REPO_ROOT, 'CMakeLists.txt'), 'utf8'));
  const run = (args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'release-package.mjs'), ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const buildArgs = (dir, extra = []) => [
    'build', '--inputs', dir, '--out', path.join(dir, 'out'), '--commit', SHA, '--date', '2026-10-15T08:00:00Z',
    '--repository', 'example/OpenTune', '--server-url', 'https://github.invalid', '--name-status', path.join(dir, 'name-status.txt'),
    '--upstream-tag', 'upstream/20261008-abcdef0', '--upstream-commit', 'b'.repeat(40), ...extra,
  ];

  it('builds a rehearsal package that passes its own checks; one extra file in the zip fails', () => {
    const dir = makeTempDir('ot-release-test-');
    try {
      makeInputs(dir);
      const r = run(buildArgs(dir, ['--label', 'rehearsal-aaaaaaa']));
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const name = packageName({ version: version(), label: 'rehearsal-aaaaaaa' });
      const zip = fs.readFileSync(path.join(dir, 'out', `${name}.zip`));
      const v = verifyZipBuffer(zip, name);
      assert.deepEqual(v.problems, []);
      assert.equal(v.files.length, PACKAGE_FILES.length);
      const inner = new Map(readZip(zip).map((e) => [e.name.slice(name.length + 1), e.data]));
      assert.deepEqual(validateControlJson(inner.get('opentune-control.json')), []);
      assert.match(inner.get('OpenTune-AI.cmd').toString('utf8'), /\r\n/);
      assert.match(inner.get('INSTALL.txt').toString('utf8'), /c{64}/);
      assert.match(inner.get('MODIFICATIONS.md').toString('utf8'), /`Source\/PluginProcessor\.cpp`/);
      const body = fs.readFileSync(path.join(dir, 'out', 'release-body.md'), 'utf8');
      assert.doesNotMatch(body, /\{\{|SPDX/);
      assert.ok(body.includes(sha256Hex(zip)));
      assert.equal(run(['verify', '--zip', path.join(dir, 'out', `${name}.zip`), '--name', name]).status, 0);

      // Negative case: the same zip plus one extra file is red.
      const extra = createZip([...readZip(zip).map((e) => ({ name: e.name, data: e.isDir ? undefined : e.data })), { name: `${name}/extra.txt`, data: Buffer.from('x') }]);
      const bad = path.join(dir, 'out', 'extra.zip');
      fs.writeFileSync(bad, extra);
      const rv = run(['verify', '--zip', bad, '--name', name]);
      assert.equal(rv.status, 1);
      assert.match(rv.stderr, /not on the allow-list: extra\.txt/);

      // Negative cases: a second OpenTune.exe under the same name, or under a name that differs only in
      // case (the two collide when extracted on Windows), is red; neither copy is silently dropped.
      const same = readZip(zip).map((e) => ({ name: e.name, data: e.isDir ? undefined : e.data }));
      for (const [dupName, re] of [['OpenTune.exe', /zip: duplicate entry .*\/OpenTune\.exe/], ['opentune.EXE', /duplicate entry: opentune\.EXE \(differs from OpenTune\.exe only in case\)/]]) {
        const dupZip = path.join(dir, 'out', 'dup.zip');
        fs.writeFileSync(dupZip, createZip([...same, { name: `${name}/${dupName}`, data: Buffer.from('MZ another executable') }]));
        const rd = run(['verify', '--zip', dupZip, '--name', name]);
        assert.equal(rd.status, 1, dupName);
        assert.match(rd.stderr, re);
        assert.doesNotMatch(rd.stderr, /undefined/);
      }
    } finally {
      removeDir(dir);
    }
  });

  it('fail closed end to end: blockers from a probe miss stop a tag build; a rehearsal only warns', () => {
    const catalogue = {
      components: [
        { id: 'honor-sans', name: 'HONOR Sans', probe: { kind: 'embedded', files: 'Resources/Fonts/HONORSansCN-Medium.ttf' }, redistribution: 'unverified', unverifiedReason: 'no license file' },
        { id: 'cursors', name: 'Cursor images', license: 'LGPL-3.0', probe: { kind: 'embedded', files: 'Resources/UI/cursors/*.png' }, licenseFiles: [{ root: 'repo', path: 'LICENSES/cursors.LGPL-3.0.txt' }], needsGpl3: true },
      ],
    };
    // An executable in which neither probe finds anything, although the repository has both.
    const got = collectComponents({
      catalogue, closure: { exe: 'App.exe', linkFlags: '', libraries: [], objects: [] }, exeBuf: Buffer.from('MZ'), appFiles: [],
      roots: { repo: REPO_ROOT, juce: '/nonexistent', deps: '/nonexistent' }, lock: { deps: [] }, sbom: {},
    });
    assert.deepEqual(got.blockers.map((b) => b.id), ['honor-sans', 'cursors']);
    const dir = makeTempDir('ot-release-test-');
    try {
      makeInputs(dir, { blockers: got.blockers });
      const r = run(buildArgs(dir, ['--label', 'ctl.1', '--tag', `synchain-test/v${version()}-ctl.1`]));
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /2 release blocker\(s\); a tagged release cannot be packaged/);
      assert.match(r.stdout, /::error title=release blocker::HONOR Sans: the repository has 1 file\(s\) matching Resources\/Fonts\/HONORSansCN-Medium\.ttf, but the probe found none/);
      const rh = run(buildArgs(dir, ['--label', 'rehearsal-aaaaaaa']));
      assert.equal(rh.status, 0, rh.stderr);
      assert.match(rh.stdout, /::warning title=release blocker::Cursor images: the repository has \d+ file\(s\) matching Resources\/UI\/cursors\/\*\.png, but the probe found none/);
      assert.doesNotMatch(rh.stdout, /::error/);
    } finally {
      removeDir(dir);
    }
  });

  it('a tag build stops on a release blocker; a rehearsal only warns', () => {
    const dir = makeTempDir('ot-release-test-');
    try {
      makeInputs(dir, { blockers: [{ id: 'honor-sans', why: 'terms unverified' }] });
      const tag = `synchain-test/v${version()}-ctl.1`;
      const r = run(buildArgs(dir, ['--label', 'ctl.1', '--tag', tag]));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /release blocker/);
      const rh = run(buildArgs(dir, ['--label', 'rehearsal-aaaaaaa']));
      assert.equal(rh.status, 0, rh.stderr);
      assert.match(rh.stdout, /::warning title=release blocker::terms unverified/);
    } finally {
      removeDir(dir);
    }
  });
});

describe('release-package.mjs control-json (used by the e2e workflow)', () => {
  const run = (args) => spawnSync(process.execPath, [path.join(SCRIPTS, 'release-package.mjs'), ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  it('writes the same valid opentune-control.json the package carries, and fails on an invalid d3d12 block', () => {
    const dir = makeTempDir('ot-control-json-');
    try {
      const info = { schema: 1, controlApi: true, d3d12: { agilityVersion: '1.619.5', sdkVersion: 619, files: [{ name: 'D3D12Core.dll', sha256: 'c'.repeat(64) }] } };
      fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(info));
      const out = path.join(dir, 'opentune-control.json');
      const args = ['control-json', '--inputs', dir, '--out', out, '--commit', SHA, '--date', '2026-10-16T08:00:00Z', '--repository', 'example/OpenTune', '--server-url', 'https://github.invalid'];
      const r = run(args);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const buf = fs.readFileSync(out);
      assert.deepEqual(validateControlJson(buf), []);
      const o = JSON.parse(buf.toString('utf8'));
      assert.deepEqual(o.protocolMajors, [1]);
      assert.equal(o.build.commit, SHA);
      assert.equal(o.build.tag, null);
      assert.equal(o.build.label, `rehearsal-${SHA.slice(0, 7)}`);
      assert.equal(o.sourceUrl, `https://github.invalid/example/OpenTune/tree/${SHA}`);
      assert.equal(o.officialRepository, 'https://github.invalid/YuFeng926/OpenTune');
      // Missing build-info d3d12 data: refused, nothing written.
      fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ ...info, d3d12: { agilityVersion: '', sdkVersion: 0, files: [] } }));
      fs.rmSync(out);
      const bad = run(args);
      assert.notEqual(bad.status, 0);
      assert.equal(fs.existsSync(out), false);
      assert.equal(run(args.slice(0, 3)).status, 1); // missing options
    } finally {
      removeDir(dir);
    }
  });
});
