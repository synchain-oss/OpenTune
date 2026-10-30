// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests of the macOS test build packaging: the Mach-O reader, the nested allow-list, the Unix modes of the
// zip, the macOS side-car file, the notices collector with a platform, and release-macos.mjs end to end with
// a fake for the programs that only exist on a Mac (tar, PlistBuddy, xattr, codesign, ditto).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir, removeDir } from '../fork-lib.mjs';
import {
  buildControlJson,
  checkMacosModes,
  checkPackageEntries,
  compareVersions,
  createZip,
  formatMachoVersion,
  linkClosure,
  MACOS_APP_FOLDER,
  MACOS_EXECUTABLES,
  MACOS_OPTIONAL_FILES,
  MACOS_PACKAGE_FILES,
  machoInfo,
  macosContentProblems,
  minMacosOf,
  packageName,
  parseNinja,
  platformOfPackageName,
  plistString,
  readZip,
  validateControlJson,
} from '../release-lib.mjs';
import { buildMacosPackage, setPlistString, walkTree } from '../release-macos.mjs';
import { collectComponents } from '../release-notices.mjs';
import { composeBody, validateBuild, verifyZipBuffer } from '../release-package.mjs';
import { REPO_ROOT } from './helpers.mjs';

// ---------------------------------------------------------------------------------------------
// Synthetic Mach-O files
// ---------------------------------------------------------------------------------------------

const CPU = { arm64: 0x0100000c, x86_64: 0x01000007 };
const pack = (major, minor, patch = 0) => ((major << 16) | (minor << 8) | patch) >>> 0;
const pad8 = (n) => Math.ceil(n / 8) * 8;

function pathCommand(cmd, headerSize, text) {
  const size = pad8(headerSize + Buffer.byteLength(text) + 1);
  const b = Buffer.alloc(size);
  b.writeUInt32LE(cmd, 0);
  b.writeUInt32LE(size, 4);
  b.writeUInt32LE(headerSize, 8);
  b.write(text, headerSize, 'utf8');
  return b;
}

/** A little-endian 64-bit Mach-O header with the load commands the reader looks at. */
function makeMacho({ arch = 'arm64', filetype = 2, minos = [13, 3], legacyMinos = null, deps = [], weakDeps = [], rpaths = [], id = null, signature = false } = {}) {
  const cmds = [];
  if (minos) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x32, 0);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(1, 8); // PLATFORM_MACOS
    b.writeUInt32LE(pack(...minos), 12);
    b.writeUInt32LE(pack(15, 0), 16);
    cmds.push(b);
  }
  if (legacyMinos) {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0x24, 0);
    b.writeUInt32LE(16, 4);
    b.writeUInt32LE(pack(...legacyMinos), 8);
    b.writeUInt32LE(pack(14, 0), 12);
    cmds.push(b);
  }
  if (id) cmds.push(Buffer.concat([pathCommand(0x0d, 24, id)]));
  for (const d of deps) cmds.push(pathCommand(0x0c, 24, d));
  for (const d of weakDeps) cmds.push(pathCommand(0x80000018, 24, d));
  for (const r of rpaths) cmds.push(pathCommand(0x8000001c, 12, r));
  if (signature) {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0x1d, 0);
    b.writeUInt32LE(16, 4);
    cmds.push(b);
  }
  const body = Buffer.concat(cmds);
  const h = Buffer.alloc(32);
  h.writeUInt32LE(0xfeedfacf, 0);
  h.writeUInt32LE(CPU[arch], 4);
  h.writeUInt32LE(0, 8);
  h.writeUInt32LE(filetype, 12);
  h.writeUInt32LE(cmds.length, 16);
  h.writeUInt32LE(body.length, 20);
  return Buffer.concat([h, body, Buffer.alloc(64, 0x90)]);
}

function makeFat(slices) {
  const head = Buffer.alloc(8 + 20 * slices.length);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  let offset = 4096;
  const parts = [];
  slices.forEach(({ arch, data }, i) => {
    const at = 8 + 20 * i;
    head.writeUInt32BE(CPU[arch], at);
    head.writeUInt32BE(0, at + 4);
    head.writeUInt32BE(offset, at + 8);
    head.writeUInt32BE(data.length, at + 12);
    head.writeUInt32BE(14, at + 16);
    parts.push({ offset, data });
    offset += Math.ceil(data.length / 4096) * 4096;
  });
  const out = Buffer.alloc(offset);
  head.copy(out, 0);
  for (const p of parts) p.data.copy(out, p.offset);
  return out;
}

describe('Mach-O reader', () => {
  it('reads the architecture, minimum macOS, dependencies and rpaths of a thin binary', () => {
    const buf = makeMacho({ minos: [13, 3], deps: ['@rpath/libonnxruntime.1.20.0.dylib', '/usr/lib/libSystem.B.dylib'], weakDeps: ['/usr/lib/libweak.dylib'], rpaths: ['@executable_path/../Frameworks'], signature: true });
    const info = machoInfo(buf);
    assert.equal(info.universal, false);
    assert.equal(info.slices.length, 1);
    const s = info.slices[0];
    assert.equal(s.arch, 'arm64');
    assert.equal(s.filetype, 'executable');
    assert.equal(s.platform, 'macos');
    assert.equal(s.minos, '13.3');
    assert.equal(s.sdk, '15.0');
    assert.deepEqual(s.dependencies, [
      { name: '@rpath/libonnxruntime.1.20.0.dylib', weak: false },
      { name: '/usr/lib/libSystem.B.dylib', weak: false },
      { name: '/usr/lib/libweak.dylib', weak: true },
    ]);
    assert.deepEqual(s.rpaths, ['@executable_path/../Frameworks']);
    assert.equal(s.hasCodeSignature, true);
  });

  it('reads a dylib install name and the older LC_VERSION_MIN_MACOSX command', () => {
    const s = machoInfo(makeMacho({ filetype: 6, minos: null, legacyMinos: [12, 0], id: '@rpath/libonnxruntime.1.20.0.dylib' })).slices[0];
    assert.equal(s.filetype, 'dylib');
    assert.equal(s.installName, '@rpath/libonnxruntime.1.20.0.dylib');
    assert.equal(s.minos, '12.0');
  });

  it('reads every slice of a universal binary', () => {
    const fat = makeFat([
      { arch: 'x86_64', data: makeMacho({ arch: 'x86_64', minos: [12, 0] }) },
      { arch: 'arm64', data: makeMacho({ arch: 'arm64', minos: [13, 3] }) },
    ]);
    const info = machoInfo(fat);
    assert.equal(info.universal, true);
    assert.deepEqual(info.slices.map((s) => `${s.arch} ${s.minos}`), ['x86_64 12.0', 'arm64 13.3']);
    assert.equal(minMacosOf([info]), '13.3');
    assert.equal(minMacosOf([info], 'x86_64'), '12.0');
  });

  it('takes the highest minimum over the binaries of the bundle', () => {
    const a = machoInfo(makeMacho({ minos: [12, 0] }));
    const b = machoInfo(makeMacho({ minos: [13, 3, 1] }));
    assert.equal(minMacosOf([a, b]), '13.3.1');
    assert.equal(minMacosOf([machoInfo(makeMacho({ minos: null }))]), null);
  });

  it('rejects files that are not Mach-O or are cut short (negative cases)', () => {
    assert.throws(() => machoInfo(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)])), /unknown magic/);
    assert.throws(() => machoInfo(Buffer.from('abc')), /too small/);
    const good = makeMacho({ deps: ['/usr/lib/libSystem.B.dylib'] });
    assert.throws(() => machoInfo(good.subarray(0, 40)), /past the slice|bad load command/);
    const fat = makeFat([{ arch: 'arm64', data: makeMacho({}) }]);
    assert.throws(() => machoInfo(fat.subarray(0, 4200)), /past the end/);
  });

  it('formats and compares versions', () => {
    assert.equal(formatMachoVersion(pack(13, 3)), '13.3');
    assert.equal(formatMachoVersion(pack(12, 0, 5)), '12.0.5');
    assert.ok(compareVersions('13.3', '12.0') > 0);
    assert.ok(compareVersions('13.3', '13.3.0') === 0);
    assert.ok(compareVersions('13.3', '13.3.1') < 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Names, the nested allow-list and the modes
// ---------------------------------------------------------------------------------------------

const ORT_DYLIB = 'libonnxruntime.1.20.0.dylib';
const APP = MACOS_APP_FOLDER;
const MAC_FILES = MACOS_PACKAGE_FILES.map((f) => (typeof f === 'string' ? f : `${APP}/Contents/Frameworks/${ORT_DYLIB}`));
const macEntries = (names, extra = {}) => names.map((n) => ({ path: n, head: Buffer.from('xx'), mode: MACOS_EXECUTABLES.includes(n) ? 0o100755 : 0o100644, ...extra }));
const parentsOf = (names) => [...new Set(names.flatMap((n) => n.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].map((d) => ({ path: d, isDir: true, mode: 0o40755 }));

describe('macOS package names', () => {
  it('names the package after the version, the label and the platform', () => {
    assert.equal(packageName({ version: '1.8.0', label: 'ctl.3', platform: 'macos-arm64' }), 'OpenTune-1.8.0-ctl.3-unofficial-macos-arm64');
    assert.equal(packageName({ version: '1.8.0', label: 'rehearsal-abcdef0', platform: 'macos-arm64' }), 'OpenTune-1.8.0-rehearsal-abcdef0-unofficial-macos-arm64');
    assert.throws(() => packageName({ version: '1.8.0', label: 'ctl.3', platform: 'linux' }));
    assert.equal(platformOfPackageName('OpenTune-1.8.0-ctl.3-unofficial-macos-arm64'), 'macos-arm64');
    assert.equal(platformOfPackageName('OpenTune-1.8.0-ctl.3-unofficial-win-x64'), 'win-x64');
    assert.equal(platformOfPackageName('something'), null);
  });

  it('validate reports the macOS name next to the Windows one', () => {
    const r = validateBuild({ cmakeVersion: '1.8.0', tag: '', sha: 'a'.repeat(40), checkRuns: [], isAncestorOfDev: () => assert.fail('not called') });
    assert.equal(r.name, 'OpenTune-1.8.0-rehearsal-aaaaaaa-unofficial-win-x64');
    assert.equal(r.nameMacos, 'OpenTune-1.8.0-rehearsal-aaaaaaa-unofficial-macos-arm64');
  });
});

describe('macOS allow-list', () => {
  const opt = { platform: 'macos-arm64' };

  it('accepts exactly the allow-list, with or without the optional JUCE files and their folders', () => {
    assert.deepEqual(checkPackageEntries([...macEntries(MAC_FILES), ...parentsOf(MAC_FILES)], opt), []);
    const withOptional = [...MAC_FILES, ...MACOS_OPTIONAL_FILES];
    assert.deepEqual(checkPackageEntries([...macEntries(withOptional), ...parentsOf(withOptional)], opt), []);
  });

  it('fails on one extra file, a missing file or a second ONNX Runtime dylib (negative cases)', () => {
    assert.deepEqual(checkPackageEntries(macEntries([...MAC_FILES, `${APP}/Contents/Resources/extra.dat`]), opt), [`not on the allow-list: ${APP}/Contents/Resources/extra.dat`]);
    assert.ok(checkPackageEntries(macEntries(MAC_FILES.filter((n) => n !== 'INSTALL.txt')), opt).includes('missing: INSTALL.txt'));
    const two = checkPackageEntries(macEntries([...MAC_FILES, `${APP}/Contents/Frameworks/libonnxruntime.1.19.0.dylib`]), opt);
    assert.ok(two.some((p) => p.startsWith('more than one file matches')), two.join('; '));
  });

  it('fails on models, ONNX files, LFS pointers and a Windows-style flat layout', () => {
    const models = checkPackageEntries([...macEntries(MAC_FILES), { path: `${APP}/Contents/Resources/models/fcpe.onnx`, head: Buffer.from('x'), mode: 0o100644 }], opt);
    assert.ok(models.some((p) => p.includes('model weights')), models.join('; '));
    assert.ok(models.some((p) => p.includes('models directory')), models.join('; '));
    const lfs = checkPackageEntries(macEntries(MAC_FILES).map((e) => (e.path === 'LICENSE.txt' ? { ...e, head: Buffer.from('version https://git-lfs.github.com/spec/v1\n') } : e)), opt);
    assert.ok(lfs.some((p) => p.includes('Git LFS pointer')), lfs.join('; '));
    // The Windows rule still refuses any subdirectory.
    assert.ok(checkPackageEntries([{ path: 'dir/file.txt', head: Buffer.from('x') }]).some((p) => p.includes('subdirectory')));
  });

  it('refuses symbolic links, unknown folders and same names that differ only in case', () => {
    const link = checkPackageEntries([...macEntries(MAC_FILES), { path: `${APP}/Contents/MacOS/link`, mode: 0o120777, head: Buffer.from('x') }], opt);
    assert.ok(link.includes(`symbolic link: ${APP}/Contents/MacOS/link`), link.join('; '));
    const dir = checkPackageEntries([...macEntries(MAC_FILES), ...parentsOf(MAC_FILES), { path: `${APP}/Contents/Plugins`, isDir: true }], opt);
    assert.deepEqual(dir, [`unexpected directory: ${APP}/Contents/Plugins`]);
    const dup = checkPackageEntries(macEntries([...MAC_FILES, 'install.TXT']), opt);
    assert.ok(dup.includes('duplicate entry: install.TXT (differs from INSTALL.txt only in case)'), dup.join('; '));
  });

  it('wants the launcher script and the program to be executable', () => {
    assert.deepEqual(checkMacosModes(macEntries(MAC_FILES)), []);
    const bad = checkMacosModes(macEntries(MAC_FILES).map((e) => (e.path === 'OpenTune-AI.command' ? { ...e, mode: 0o100644 } : e)));
    assert.deepEqual(bad, ['OpenTune-AI.command: not executable (mode 644)']);
    const none = checkMacosModes(macEntries(MAC_FILES).map((e) => (e.path === `${APP}/Contents/MacOS/OpenTune` ? { ...e, mode: null } : e)));
    assert.deepEqual(none, [`${APP}/Contents/MacOS/OpenTune: the archive records no Unix mode`]);
  });

  it('every file the templates mention is on the allow-list', () => {
    for (const t of ['README-UNOFFICIAL.txt', 'README-UNOFFICIAL.zh-CN.txt']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'templates', 'macos', t), 'utf8');
      for (const f of MACOS_PACKAGE_FILES) {
        const base = typeof f === 'string' ? path.posix.basename(f) : '{{ORT_DYLIB}}';
        // Info.plist and the signature are details of the bundle that the README does not list.
        if (base === 'CodeResources' || base === 'Info.plist') continue;
        assert.ok(text.includes(base), `${t} does not mention ${base}`);
      }
    }
  });
});

describe('zip entries with Unix modes', () => {
  it('records the mode of an entry and reads it back; FAT entries have none', () => {
    const zip = createZip([
      { name: 'P/', mode: 0o40755 },
      { name: 'P/run.command', data: Buffer.from('#!/bin/sh\n'), mode: 0o100755 },
      { name: 'P/readme.txt', data: Buffer.from('hello'), mode: 0o100644 },
      { name: 'P/fat.txt', data: Buffer.from('x') },
    ]);
    const back = readZip(zip);
    assert.deepEqual(back.map((e) => e.mode === null ? null : (e.mode & 0o7777).toString(8)), ['755', '755', '644', null]);
    assert.equal(back[0].isDir, true);
    assert.equal((back[0].mode & 0o170000), 0o040000);
    assert.equal((back[1].mode & 0o170000), 0o100000);
  });
});

describe('opentune-control.json for macOS', () => {
  const base = {
    protocolMajor: 1,
    appVersion: '1.8.0',
    commit: 'a'.repeat(40),
    tag: 'synchain-test/v1.8.0-ctl.1',
    label: 'ctl.1',
    date: '2026-10-30',
    sourceUrl: 'https://github.com/synchain-oss/OpenTune/tree/x',
    officialRepositoryUrl: 'https://github.com/YuFeng926/OpenTune',
  };
  const bytes = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);

  it('has a platform member and no d3d12 member, and passes the validation', () => {
    const o = buildControlJson({ ...base, platform: 'macos-arm64' });
    assert.equal(o.platform, 'macos-arm64');
    assert.equal('d3d12' in o, false);
    assert.deepEqual(validateControlJson(bytes(o)), []);
  });

  it('keeps the Windows file as it was: no platform member, d3d12 required', () => {
    const d3d12 = { agilityVersion: '1.619.5', sdkVersion: 619, files: [{ name: 'D3D12Core.dll', sha256: 'b'.repeat(64) }] };
    const o = buildControlJson({ ...base, d3d12 });
    assert.equal('platform' in o, false);
    assert.equal(o.d3d12.directory, 'D3D12');
    assert.deepEqual(validateControlJson(bytes(o)), []);
    assert.throws(() => buildControlJson({ ...base }), /d3d12 is required/);
  });

  it('fails a macOS file with a d3d12 member or another platform (negative cases)', () => {
    const o = buildControlJson({ ...base, platform: 'macos-arm64' });
    assert.deepEqual(validateControlJson(bytes({ ...o, d3d12: { bundled: false, files: [] } })), ['a macOS file has no d3d12 member']);
    assert.deepEqual(validateControlJson(bytes({ ...o, platform: 'linux' })), ['platform, when present, must be "macos-arm64"', 'd3d12.bundled must be false', 'd3d12.files must list D3D12Core.dll']);
    assert.throws(() => buildControlJson({ ...base, platform: 'linux' }), /bad platform/);
  });
});

// ---------------------------------------------------------------------------------------------
// Ninja graph of a macOS build
// ---------------------------------------------------------------------------------------------

const NINJA_MAC = `
rule CXX_COMPILER__OpenTuneStandalone_Standalone_unscanned_Release
  command = c++
rule OBJCXX_COMPILER__OpenTuneStandalone_Standalone_unscanned_Release
  command = c++ -x objective-c++
build CMakeFiles/OpenTuneStandalone_Standalone.dir/Source/Main.cpp.o: CXX_COMPILER__OpenTuneStandalone_Standalone_unscanned_Release /src/Source/Main.cpp
  DEFINES = -DJUCE_USE_FLAC=0
  INCLUDES = -I/src/ThirdParty/r8brain-free-src-master
build CMakeFiles/OpenTuneStandalone_Standalone.dir/juce_core.mm.o: OBJCXX_COMPILER__OpenTuneStandalone_Standalone_unscanned_Release /src/JUCE-master/modules/juce_core/juce_core.mm
  DEFINES = -DJUCE_USE_FLAC=0
build libSoundTouch.a: CXX_STATIC_LIBRARY_LINKER__SoundTouch_Release CMakeFiles/SoundTouch.dir/SoundTouch.cpp.o
build CMakeFiles/SoundTouch.dir/SoundTouch.cpp.o: CXX_COMPILER__SoundTouch_unscanned_Release /src/ThirdParty/soundtouch-2.3.3/source/SoundTouch/SoundTouch.cpp
build OpenTuneStandalone_artefacts/Release/Standalone/OpenTune.app/Contents/MacOS/OpenTune: CXX_EXECUTABLE_LINKER__OpenTuneStandalone_Standalone_Release CMakeFiles/OpenTuneStandalone_Standalone.dir/Source/Main.cpp.o CMakeFiles/OpenTuneStandalone_Standalone.dir/juce_core.mm.o | libSoundTouch.a
  LINK_FLAGS = -Wl,-dead_strip
  LINK_LIBRARIES = libSoundTouch.a -framework CoreAudio /src/ThirdParty/onnx/lib/libonnxruntime.1.20.0.dylib
`;

describe('Ninja graph of a macOS build', () => {
  it('follows Objective-C++ objects and static libraries named lib*.a into the executable', () => {
    const c = linkClosure(parseNinja(NINJA_MAC), { target: 'OpenTuneStandalone_Standalone', config: 'Release' });
    assert.equal(c.exe, 'OpenTuneStandalone_artefacts/Release/Standalone/OpenTune.app/Contents/MacOS/OpenTune');
    assert.deepEqual(c.objects.map((o) => o.source), ['/src/Source/Main.cpp', '/src/JUCE-master/modules/juce_core/juce_core.mm', '/src/ThirdParty/soundtouch-2.3.3/source/SoundTouch/SoundTouch.cpp']);
    assert.deepEqual(c.libraries, ['libSoundTouch.a']);
  });
});

// ---------------------------------------------------------------------------------------------
// The notices collector with a platform
// ---------------------------------------------------------------------------------------------

describe('notices collector (macOS)', () => {
  const closure = { objects: [{ source: '/src/Source/Main.cpp', defines: {}, includes: [] }], libraries: [], linkFlags: '' };
  const lock = { deps: [{ name: 'onnxruntime-osx-arm64-1.20.0', platforms: ['macos'] }, { name: 'onnxruntime-dml-1.24.4', platforms: ['windows'] }] };

  it('keeps Windows-only components out, writes the macOS ONNX Runtime with its license from the macOS dependency', () => {
    const deps = makeTempDir('mac-deps');
    try {
      fs.mkdirSync(path.join(deps, 'onnxruntime-osx-arm64-1.20.0'));
      fs.writeFileSync(path.join(deps, 'onnxruntime-osx-arm64-1.20.0', 'LICENSE'), 'MIT License text\n');
      const catalogue = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'notices.json'), 'utf8'));
      const only = { ...catalogue, components: catalogue.components.filter((c) => ['opentune', 'onnxruntime', 'directml', 'onnxruntime-macos'].includes(c.id)) };
      const got = collectComponents({ catalogue: only, closure, exeBuf: Buffer.alloc(16), appFiles: [ORT_DYLIB], roots: { repo: REPO_ROOT, deps, juce: deps }, lock, sbom: {}, platform: 'macos' });
      assert.deepEqual(got.included, ['opentune', 'onnxruntime-macos']);
      assert.deepEqual(got.excluded.map((x) => x.id), ['onnxruntime', 'directml']);
      const ort = got.sections.find((s) => s.id === 'onnxruntime-macos');
      assert.equal(ort.name, 'ONNX Runtime (macOS arm64 build) 1.20.0');
      assert.equal(ort.usedIn, `${ORT_DYLIB} (the official prebuilt onnxruntime-osx-arm64 release, unmodified)`);
      assert.equal(ort.texts[0].text, 'MIT License text');
      assert.equal(got.sections.find((s) => s.id === 'opentune').usedIn, 'OpenTune');
    } finally {
      removeDir(deps);
    }
  });

  it('refuses an unknown platform in the catalogue (negative case)', () => {
    const catalogue = { components: [{ id: 'x', name: 'X', platforms: ['plan9'], probe: { kind: 'always' } }] };
    assert.throws(() => collectComponents({ catalogue, closure, exeBuf: Buffer.alloc(0), appFiles: [], roots: {}, lock: { deps: [] }, sbom: {}, platform: 'macos' }), /platforms must be a non-empty list/);
  });

  it('the real catalogue marks the DirectML build Windows-only and the macOS runtime macOS-only', () => {
    const catalogue = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'release', 'notices.json'), 'utf8'));
    const platforms = Object.fromEntries(catalogue.components.map((c) => [c.id, c.platforms ?? null]));
    assert.deepEqual(platforms.onnxruntime, ['windows']);
    assert.deepEqual(platforms.directml, ['windows']);
    assert.deepEqual(platforms['onnxruntime-macos'], ['macos']);
    assert.equal(platforms.juce, null);
    assert.ok(catalogue.juceVendored.conditionsByPlatform.macos.AudioUnitSDK.anyMacro.length);
  });
});

// ---------------------------------------------------------------------------------------------
// release-macos.mjs end to end, with a fake for the programs of a Mac
// ---------------------------------------------------------------------------------------------

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>OpenTune</string>
  <key>CFBundleIdentifier</key>
  <string>com.daya.opentune</string>
  <key>CFBundleName</key>
  <string>OpenTune</string>
</dict>
</plist>
`;

function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** The bundle that the build job would have tarred: with the POST_BUILD models, the user guide and one more file when asked. */
function makeFixtureApp(dir, { extra = null, arch = 'arm64' } = {}) {
  const app = path.join(dir, 'OpenTune.app');
  writeFile(path.join(app, 'Contents', 'Info.plist'), PLIST);
  writeFile(path.join(app, 'Contents', 'PkgInfo'), 'APPL????');
  writeFile(path.join(app, 'Contents', 'MacOS', 'OpenTune'), makeMacho({ arch, deps: [`@rpath/${ORT_DYLIB}`], rpaths: ['@executable_path/../Frameworks'] }));
  writeFile(path.join(app, 'Contents', 'Frameworks', ORT_DYLIB), makeMacho({ filetype: 6, id: `@rpath/${ORT_DYLIB}` }));
  writeFile(path.join(app, 'Contents', 'Resources', 'AppIcon.icns'), 'icns');
  writeFile(path.join(app, 'Contents', 'Resources', 'models', 'fcpe.onnx'), 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n');
  writeFile(path.join(app, 'Contents', 'Resources', 'models', 'hifigan.onnx'), '');
  writeFile(path.join(app, 'Contents', 'Resources', 'docs', 'UserGuide.html'), '<html></html>');
  if (extra) writeFile(path.join(app, ...extra.split('/')), 'extra');
}

/** The few PlistBuddy commands that the packaging uses, on a plist file. */
function fakePlistBuddy(args) {
  const [flag, command, file] = args;
  assert.equal(flag, '-c');
  let text = fs.readFileSync(file, 'utf8');
  const [verb, key, ...rest] = command.split(' ');
  const k = key.replace(/^:/, '');
  const re = new RegExp(`(<key>${k}</key>\\s*<string>)([^<]*)(</string>)`);
  if (verb === 'Print') {
    const m = re.exec(text);
    if (!m) throw new Error(`Print: Entry, ":${k}", Does Not Exist`);
    return { stdout: `${m[2]}\n`, stderr: '' };
  }
  if (verb === 'Set') {
    if (!re.test(text)) throw new Error(`Set: Entry, ":${k}", Does Not Exist`);
    text = text.replace(re, (_, a, _b, c) => `${a}${rest.join(' ')}${c}`);
  } else if (verb === 'Add') {
    assert.equal(rest[0], 'string');
    text = text.replace('</dict>', `  <key>${k}</key>\n  <string>${rest.slice(1).join(' ')}</string>\n</dict>`);
  } else throw new Error(`unexpected PlistBuddy command ${command}`);
  fs.writeFileSync(file, text);
  return { stdout: '', stderr: '' };
}

/** A fake exec for tar, PlistBuddy, xattr, codesign and ditto. `calls` records what ran; `hooks` can break a program. */
function makeFakeExec({ fixture = {}, hooks = {} } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const name = path.basename(cmd);
    if (hooks[name]) return hooks[name](args) ?? { stdout: '', stderr: '' };
    if (name === 'tar') {
      assert.equal(args[0], '-xf');
      makeFixtureApp(args[3], fixture);
      return { stdout: '', stderr: '' };
    }
    if (name === 'PlistBuddy') return fakePlistBuddy(args);
    if (name === 'xattr') return { stdout: '', stderr: '' };
    if (name === 'codesign') {
      if (args.includes('--verify')) return { stdout: '', stderr: '' };
      if (args[0] === '-dv') {
        const plist = fs.readFileSync(path.join(args[args.length - 1], 'Contents', 'Info.plist'), 'utf8');
        const id = /CFBundleIdentifier<\/key>\s*<string>([^<]*)/.exec(plist)[1];
        return { stdout: '', stderr: `Executable=x\nIdentifier=${id}\nFormat=app bundle with Mach-O thin (arm64)\nSignature=adhoc\nTeamIdentifier=not set\n` };
      }
      const target = args[args.length - 1];
      if (target.endsWith('.app')) writeFile(path.join(target, 'Contents', '_CodeSignature', 'CodeResources'), 'sealed');
      return { stdout: '', stderr: '' };
    }
    if (name === 'ditto') {
      const [, , , , folder, zipPath] = args;
      const top = path.basename(folder);
      const entries = [{ name: `${top}/`, mode: 0o40755 }];
      for (const e of walkTree(folder)) {
        const exec755 = MACOS_EXECUTABLES.includes(e.path);
        entries.push(e.isDir ? { name: `${top}/${e.path}/`, mode: 0o40755 } : { name: `${top}/${e.path}`, data: fs.readFileSync(e.abs), mode: exec755 ? 0o100755 : 0o100644 });
      }
      fs.writeFileSync(zipPath, createZip(entries));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected program ${cmd}`);
  };
  return { exec, calls };
}

const SHA = 'c'.repeat(40);

function makeInputs(dir, infoOverrides = {}) {
  const inputs = path.join(dir, 'inputs');
  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, 'app.tar'), 'placeholder');
  fs.writeFileSync(path.join(inputs, 'THIRD-PARTY-NOTICES.txt'), 'notices\n');
  fs.writeFileSync(
    path.join(inputs, 'build-info.json'),
    JSON.stringify({ schema: 1, platform: 'macos-arm64', config: 'Release', controlApi: true, ortDylib: ORT_DYLIB, minMacos: '13.3', ara: { linked: false, reasons: [] }, blockers: [], commands: [{ step: 'Build', argv: ['cmake', '--build', '<build>'] }], ...infoOverrides }),
  );
  fs.writeFileSync(path.join(dir, 'name-status.txt'), 'A\tSource/Control/A.cpp\nM\tSource/PluginProcessor.cpp\n');
  return inputs;
}

function options(dir, inputs, extra = {}) {
  return {
    inputs,
    out: path.join(dir, 'out'),
    label: `rehearsal-${SHA.slice(0, 7)}`,
    commit: SHA,
    date: '2026-10-30T08:00:00Z',
    repository: 'synchain-oss/OpenTune',
    'name-status': path.join(dir, 'name-status.txt'),
    'upstream-tag': 'upstream/v1.8.0',
    'upstream-commit': 'd'.repeat(40),
    'run-url': 'https://github.com/synchain-oss/OpenTune/actions/runs/1',
    smoke: 'passed in the tests',
    ...extra,
  };
}

/** Run buildMacosPackage with the repository root as the working directory (it reads CMakeLists.txt, release.json and the templates). */
function withRepoCwd(fn) {
  const before = process.cwd();
  const write = process.stdout.write;
  process.chdir(REPO_ROOT);
  process.stdout.write = () => true; // the build prints its report; the tests only look at what it returns
  try {
    return fn();
  } finally {
    process.stdout.write = write;
    process.chdir(before);
  }
}

describe('release-macos.mjs build (fake programs)', () => {
  it('assembles, signs, hashes and zips the package; the zip passes its own checks', () => {
    const dir = makeTempDir('macpkg');
    try {
      const inputs = makeInputs(dir);
      const { exec, calls } = makeFakeExec();
      const manifest = withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec }));
      const name = manifest.name;
      assert.match(name, /^OpenTune-\d+\.\d+\.\d+-rehearsal-ccccccc-unofficial-macos-arm64$/);
      const zipBuf = fs.readFileSync(path.join(dir, 'out', `${name}.zip`));
      const problems = withRepoCwd(() => verifyZipBuffer(zipBuf, name).problems);
      assert.deepEqual(problems, []);

      const names = readZip(zipBuf).map((e) => e.name.slice(name.length + 1)).filter((n) => n && !n.endsWith('/'));
      assert.ok(names.includes('opentune-control.json'));
      assert.ok(!names.some((n) => n.startsWith(`${APP}/Contents/MacOS/`) && n !== `${APP}/Contents/MacOS/OpenTune`), 'only the program may be in Contents/MacOS: codesign treats every file there as code');
      assert.ok(names.includes(`${APP}/Contents/_CodeSignature/CodeResources`));
      assert.ok(!names.some((n) => /models|\.onnx|UserGuide|docs\//i.test(n)), names.join(', '));
      assert.deepEqual(manifest.files.map((f) => f.name), [...manifest.files.map((f) => f.name)].sort());
      assert.equal(manifest.minMacos, '13.3');
      assert.equal(manifest.signature.identifier, 'ca.synchain.opentune.ctltest');

      // The Info.plist of the package says what release.json says, and CFBundleExecutable is untouched.
      const plist = fs.readFileSync(path.join(dir, 'out', name, APP, 'Contents', 'Info.plist'), 'utf8');
      assert.equal(plistString(plist, 'CFBundleName'), 'OpenTune-ctl');
      assert.equal(plistString(plist, 'CFBundleDisplayName'), 'OpenTune-ctl');
      assert.equal(plistString(plist, 'CFBundleIdentifier'), 'ca.synchain.opentune.ctltest');
      assert.equal(plistString(plist, 'CFBundleExecutable'), 'OpenTune');

      // The side-car file: valid, for macOS, next to OpenTune-AI.command (not inside the app, which codesign would reject).
      const control = JSON.parse(fs.readFileSync(path.join(dir, 'out', name, 'opentune-control.json'), 'utf8'));
      assert.equal(control.platform, 'macos-arm64');
      assert.equal(control.modelsBundled, false);
      assert.equal('d3d12' in control, false);

      // Signing order: the dylib, then the app, then verify; all after the last change to the bundle.
      const signs = calls.filter((c) => c[0] === 'codesign').map((c) => c.slice(1).map((a) => path.basename(a)).join(' '));
      assert.deepEqual(signs, [`--force --sign - ${ORT_DYLIB}`, `--force --sign - ${APP}`, `--verify --deep --strict --verbose=2 ${APP}`, `-dv --verbose=2 ${APP}`]);
      const order = calls.map((c) => path.basename(c[0]));
      assert.ok(order.lastIndexOf('PlistBuddy') < order.indexOf('xattr') && order.indexOf('xattr') < order.indexOf('codesign') && order.lastIndexOf('codesign') < order.indexOf('ditto'), order.join(' '));
      const ditto = calls.find((c) => c[0] === 'ditto');
      assert.deepEqual(ditto.slice(1, 5), ['-c', '-k', '--sequesterRsrc', '--keepParent']);

      // The release section lists the zip and the exact commands.
      const body = fs.readFileSync(path.join(dir, 'out', 'release-body-macos.md'), 'utf8');
      assert.ok(body.includes(`${name}.zip`));
      assert.match(body, /codesign --force --sign - <package>[\\/]OpenTune-ctl\.app\n/);
      assert.match(body, /ditto -c -k --sequesterRsrc --keepParent <package> <package>\.zip\n/);
      assert.ok(!body.includes(dir), 'the body must not carry local paths');
      assert.ok(fs.existsSync(path.join(dir, 'out', 'manifest-macos.json')));
    } finally {
      removeDir(dir);
    }
  });

  it('stops on one file that is not on the allow-list (negative case)', () => {
    const dir = makeTempDir('macpkg');
    try {
      const inputs = makeInputs(dir);
      const { exec } = makeFakeExec({ fixture: { extra: 'Contents/Resources/notes.txt' } });
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec })), /package check failed[\s\S]*not on the allow-list: OpenTune-ctl\.app\/Contents\/Resources\/notes\.txt/);
    } finally {
      removeDir(dir);
    }
  });

  it('stops when the signature does not verify, or is not ad hoc (negative cases)', () => {
    const dir = makeTempDir('macpkg');
    try {
      const inputs = makeInputs(dir);
      const verifyFails = makeFakeExec({ hooks: { codesign: (args) => { if (args.includes('--verify')) throw new Error('a sealed resource is missing or invalid'); return undefined; } } });
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec: verifyFails.exec })), /sealed resource is missing/);
      const base = makeFakeExec();
      const notAdhoc = (cmd, args) => (path.basename(cmd) === 'codesign' && args[0] === '-dv' ? { stdout: '', stderr: 'Identifier=ca.synchain.opentune.ctltest\nSignature size=9000\nAuthority=Developer ID\n' } : base.exec(cmd, args));
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec: notAdhoc })), /not signed ad hoc/);
    } finally {
      removeDir(dir);
    }
  });

  it('stops when the program has no arm64 slice or the bundle changes its executable name (negative cases)', () => {
    const dir = makeTempDir('macpkg');
    try {
      const inputs = makeInputs(dir);
      const intel = makeFakeExec({ fixture: { arch: 'x86_64' } });
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec: intel.exec })), /no arm64 slice/);
      const base = makeFakeExec();
      const renamed = (cmd, args) => {
        const r = base.exec(cmd, args);
        if (path.basename(cmd) === 'tar') {
          const plist = path.join(args[3], 'OpenTune.app', 'Contents', 'Info.plist');
          fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('<string>OpenTune</string>\n  <key>CFBundleIdentifier', '<string>Other</string>\n  <key>CFBundleIdentifier'));
        }
        return r;
      };
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec: renamed })), /CFBundleExecutable is "Other"/);
    } finally {
      removeDir(dir);
    }
  });

  it('refuses inputs for another platform, a release blocker in a tag build and a wrong tag (negative cases)', () => {
    const dir = makeTempDir('macpkg');
    try {
      const { exec } = makeFakeExec();
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, makeInputs(dir, { platform: undefined })), { exec })), /is for no platform/);
      const blocked = makeInputs(dir, { blockers: [{ id: 'font', why: 'terms unverified' }] });
      const version = /VERSION (\d+\.\d+\.\d+)/.exec(fs.readFileSync(path.join(REPO_ROOT, 'CMakeLists.txt'), 'utf8'))[1];
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, blocked, { tag: `synchain-test/v${version}-ctl.1`, label: 'ctl.1' }), { exec })), /1 release blocker/);
      assert.throws(() => withRepoCwd(() => buildMacosPackage(options(dir, makeInputs(dir), { tag: 'synchain-test/v0.0.1-ctl.1', label: 'ctl.1' }), { exec })), /does not match version/);
    } finally {
      removeDir(dir);
    }
  });

  it('adds a missing Info.plist entry with Add and checks the value it wrote', () => {
    const dir = makeTempDir('macplist');
    try {
      const plist = path.join(dir, 'Info.plist');
      fs.writeFileSync(plist, PLIST);
      const { exec } = makeFakeExec();
      setPlistString(exec, plist, 'CFBundleDisplayName', 'OpenTune-ctl');
      setPlistString(exec, plist, 'CFBundleName', 'OpenTune-ctl');
      assert.equal(plistString(fs.readFileSync(plist, 'utf8'), 'CFBundleDisplayName'), 'OpenTune-ctl');
      assert.equal(plistString(fs.readFileSync(plist, 'utf8'), 'CFBundleName'), 'OpenTune-ctl');
      const liar = () => ({ stdout: 'something else\n', stderr: '' });
      assert.throws(() => setPlistString(liar, plist, 'CFBundleName', 'x'), /after the change/);
    } finally {
      removeDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Verifying a finished zip
// ---------------------------------------------------------------------------------------------

describe('verifying a macOS zip', () => {
  /** A zip built by hand from the files that the fake build produced, so single faults can be planted. */
  function builtEntries() {
    const dir = makeTempDir('macverify');
    try {
      const inputs = makeInputs(dir);
      const { exec } = makeFakeExec();
      const manifest = withRepoCwd(() => buildMacosPackage(options(dir, inputs), { exec }));
      return { name: manifest.name, entries: readZip(fs.readFileSync(path.join(dir, 'out', `${manifest.name}.zip`))) };
    } finally {
      removeDir(dir);
    }
  }
  const rebuild = (entries) => createZip(entries.map((e) => (e.isDir ? { name: e.name, mode: e.mode } : { name: e.name, data: e.data, mode: e.mode })));
  const verify = (zip, name) => withRepoCwd(() => verifyZipBuffer(zip, name).problems);

  it('accepts the package and rejects single planted faults', () => {
    const { name, entries } = builtEntries();
    assert.deepEqual(verify(rebuild(entries), name), []);

    const noExec = entries.map((e) => (e.name.endsWith('/OpenTune-AI.command') ? { ...e, mode: 0o100644 } : e));
    assert.ok(verify(rebuild(noExec), name).includes('OpenTune-AI.command: not executable (mode 644)'));

    const link = [...entries, { name: `${name}/${APP}/Contents/MacOS/lnk`, isDir: false, data: Buffer.from('OpenTune'), mode: 0o120755 }];
    assert.ok(verify(rebuild(link), name).some((p) => p.includes('symbolic link')));

    const extraTop = [...entries, { name: '__MACOSX/._x', isDir: false, data: Buffer.from('x'), mode: 0o100644 }];
    assert.ok(verify(rebuild(extraTop), name).some((p) => p.includes('expected one top-level folder')));

    const tampered = entries.map((e) => (e.name.endsWith('/INSTALL.txt') ? { ...e, data: Buffer.from('changed') } : e));
    assert.ok(verify(rebuild(tampered), name).includes('SHA256SUMS mismatch for INSTALL.txt'));

    const intel = entries.map((e) => (e.name.endsWith('/Contents/MacOS/OpenTune') ? { ...e, data: makeMacho({ arch: 'x86_64' }) } : e));
    assert.ok(verify(rebuild(intel), name).some((p) => p.includes('no arm64 slice')));

    const oldId = entries.map((e) => (e.name.endsWith('/Contents/Info.plist') ? { ...e, data: Buffer.from(e.data.toString('utf8').replace('ca.synchain.opentune.ctltest', 'com.daya.opentune')) } : e));
    assert.ok(verify(rebuild(oldId), name).some((p) => p.includes('CFBundleIdentifier is "com.daya.opentune"')));

    const models = [...entries, { name: `${name}/${APP}/Contents/Resources/models/fcpe.onnx`, isDir: false, data: Buffer.from('x'), mode: 0o100644 }];
    assert.ok(verify(rebuild(models), name).some((p) => p.includes('model weights')));
  });

  it('macosContentProblems tells a bundle with the old identifier from a renamed one', () => {
    const files = new Map([[`${APP}/Contents/Info.plist`, Buffer.from(PLIST)]]);
    const problems = macosContentProblems(files, { bundleIdentifier: 'ca.synchain.opentune.ctltest', bundleName: 'OpenTune-ctl' });
    assert.deepEqual(problems, [
      'Info.plist: CFBundleIdentifier is "com.daya.opentune", expected "ca.synchain.opentune.ctltest"',
      'Info.plist: CFBundleName is "OpenTune", expected "OpenTune-ctl"',
      'Info.plist: CFBundleDisplayName is missing, expected "OpenTune-ctl"',
    ]);
  });
});

describe('release body of both platforms', () => {
  it('puts the macOS section after the Windows body, each with its own download line', () => {
    const win = 'body\n`OpenTune-1.8.0-ctl.1-unofficial-win-x64.zip`\n';
    const mac = '## macOS\n`OpenTune-1.8.0-ctl.1-unofficial-macos-arm64.zip`\n';
    const r = composeBody({ windowsBody: win, macosSection: mac, windowsZip: 'OpenTune-1.8.0-ctl.1-unofficial-win-x64.zip', macosZip: 'OpenTune-1.8.0-ctl.1-unofficial-macos-arm64.zip' });
    assert.deepEqual(r.problems, []);
    assert.ok(r.body.startsWith(win.trimEnd()));
    assert.ok(r.body.endsWith(`${mac.trim()}\n`));
    assert.ok(r.body.includes('\n---\n'));
  });

  it('fails when a section is missing or swapped (negative cases)', () => {
    const w = 'OpenTune-1.8.0-ctl.1-unofficial-win-x64.zip';
    const m = 'OpenTune-1.8.0-ctl.1-unofficial-macos-arm64.zip';
    assert.equal(composeBody({ windowsBody: 'nothing', macosSection: m, windowsZip: w, macosZip: m }).problems.length, 1);
    assert.equal(composeBody({ windowsBody: w, macosSection: 'nothing', windowsZip: w, macosZip: m }).problems.length, 1);
    assert.equal(composeBody({ windowsBody: w, macosSection: `${m} ${w}`, windowsZip: w, macosZip: m }).problems.length, 1);
  });
});
