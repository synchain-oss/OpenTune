// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the unofficial test builds (Windows x64 and macOS arm64; prerelease.yml,
// release-notices.mjs, release-package.mjs): tag and version rules, the package allow-lists, SHA256SUMS,
// the opentune-control.json side-car file, template rendering, a deterministic zip writer/reader, a
// Mach-O header reader (minimum macOS version, architectures, dependencies of the macOS binaries), and
// the Ninja build-graph analysis behind THIRD-PARTY-NOTICES (what is really linked into the executable).
// Fork-only tooling: lives under .github/ and never goes upstream. Node >= 22, no dependencies.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Tags and versions
// ---------------------------------------------------------------------------------------------

/** Test build tags: synchain-test/v<CMake VERSION>-ctl.<n>. Never v* or OpenTune* (CLAUDE.md section 4). */
export const TEST_TAG_RE = /^synchain-test\/v(\d+\.\d+\.\d+)-ctl\.([1-9]\d{0,3})$/;

/** @returns {{version: string, n: number, label: string} | null} */
export function parseTestTag(tag) {
  const m = TEST_TAG_RE.exec(String(tag ?? ''));
  return m ? { version: m[1], n: Number(m[2]), label: `ctl.${m[2]}` } : null;
}

/** VERSION of `project(OpenTune VERSION x.y.z ...)` in CMakeLists.txt. */
export function readCmakeProjectVersion(text) {
  const m = /^\s*project\s*\(\s*OpenTune\s+VERSION\s+(\d+\.\d+\.\d+)\b/im.exec(String(text));
  if (!m) throw new Error('CMakeLists.txt: no "project(OpenTune VERSION x.y.z" line');
  return m[1];
}

/** kControlProtocolMajor of Source/Control/ControlProtocol.h. */
export function readProtocolMajor(text) {
  const m = /\bkControlProtocolMajor\s*=\s*(\d+)\s*;/.exec(String(text));
  if (!m) throw new Error('ControlProtocol.h: kControlProtocolMajor not found');
  return Number(m[1]);
}

/** The platforms a test build is made for; the id is the last segment of the package name. */
export const PLATFORMS = Object.freeze({
  'win-x64': Object.freeze({ id: 'win-x64', os: 'windows', title: 'Windows x64' }),
  'macos-arm64': Object.freeze({ id: 'macos-arm64', os: 'macos', title: 'macOS (Apple silicon, arm64)' }),
});

/**
 * Package name (also the zip's top-level folder): OpenTune-<version>-ctl.<n>-unofficial-<platform> for a
 * tag, OpenTune-<version>-rehearsal-<sha7>-unofficial-<platform> for a rehearsal. The platform is win-x64
 * (the default) or macos-arm64.
 */
export function packageName({ version, label, platform = 'win-x64' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version ${version}`);
  if (!/^(ctl\.[1-9]\d*|rehearsal-[0-9a-f]{7})$/.test(label)) throw new Error(`bad build label ${label}`);
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`bad platform ${platform}`);
  return `OpenTune-${version}-${label}-unofficial-${platform}`;
}

/** The platform a package name is for (its last segment), or null. */
export function platformOfPackageName(name) {
  const m = /-unofficial-(win-x64|macos-arm64)$/.exec(String(name ?? ''));
  return m ? m[1] : null;
}

/** The GitHub App that creates the real fork-gate check run (the fork-gate.yml workflow). */
export const FORK_GATE_APP_SLUG = 'github-actions';

/**
 * fork-gate must be green on the tagged commit: among the check runs named "fork-gate" that GitHub
 * Actions created (GitHub check-runs API objects), the most recently completed one has conclusion
 * "success", and none is still running. A same-name check run from any other app is ignored: an app
 * or token with checks: write could otherwise post a green "fork-gate" of its own.
 * @returns {{ok: boolean, detail: string}}
 */
export function evaluateForkGate(checkRuns) {
  const named = (Array.isArray(checkRuns) ? checkRuns : []).filter((r) => r?.name === 'fork-gate');
  const runs = named.filter((r) => r?.app?.slug === FORK_GATE_APP_SLUG);
  const ignored = named.length - runs.length;
  const note = ignored ? `; ${ignored} same-name check run(s) from other apps ignored` : '';
  if (!runs.length) return { ok: false, detail: `no fork-gate check run from GitHub Actions on this commit${note}` };
  if (runs.some((r) => r.status !== 'completed')) return { ok: false, detail: `fork-gate is still running on this commit${note}` };
  const latest = [...runs].sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0];
  return latest.conclusion === 'success'
    ? { ok: true, detail: `fork-gate success (${latest.html_url ?? latest.id})${note}` }
    : { ok: false, detail: `latest fork-gate conclusion is ${latest.conclusion}${note}` };
}

// ---------------------------------------------------------------------------------------------
// The package allow-list
// ---------------------------------------------------------------------------------------------

/** The renamed ONNX Runtime DLL (CMakeLists.txt OPENTUNE_ORT_DLL_NAME), e.g. OpenTuneOnnxRuntime_1_24_4.dll. */
export const ORT_DLL_RE = /^OpenTuneOnnxRuntime_\d+_\d+_\d+\.dll$/;

/** Every file of the package, flat in one folder. Nothing else may be in it. */
export const PACKAGE_FILES = [
  'OpenTune.exe',
  ORT_DLL_RE,
  'DirectML.dll',
  'DirectML-LICENSE.txt',
  'LICENSE.txt',
  'THIRD-PARTY-NOTICES.txt',
  'README-UNOFFICIAL.txt',
  'README-UNOFFICIAL.zh-CN.txt',
  'MODIFICATIONS.md',
  'INSTALL.txt',
  'INSTALL.zh-CN.txt',
  'opentune-control.json',
  'OpenTune-AI.cmd',
  'SHA256SUMS',
];

/** The folder name of the app bundle in the macOS package: not OpenTune.app, so that it never replaces the official app. */
export const MACOS_APP_FOLDER = 'OpenTune-ctl.app';
/** The ONNX Runtime library the macOS build bundles (CMakeLists.txt: libonnxruntime.<OPENTUNE_ONNXRUNTIME_VERSION>.dylib). */
export const ORT_DYLIB_RE = /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Every file of the macOS package, with '/'-separated paths relative to the package folder: the files of
 * the folder itself, and the files of the app bundle (nested). Nothing else may be in it. The bundle's
 * Contents/Resources has no models and no docs folder (both are deleted when the package is assembled).
 */
export const MACOS_PACKAGE_FILES = [
  'OpenTune-AI.command',
  'opentune-control.json',
  'LICENSE.txt',
  'THIRD-PARTY-NOTICES.txt',
  'README-UNOFFICIAL.txt',
  'README-UNOFFICIAL.zh-CN.txt',
  'MODIFICATIONS.md',
  'INSTALL.txt',
  'INSTALL.zh-CN.txt',
  'SHA256SUMS',
  `${MACOS_APP_FOLDER}/Contents/Info.plist`,
  `${MACOS_APP_FOLDER}/Contents/MacOS/OpenTune`,
  new RegExp(`^${escapeRegExp(MACOS_APP_FOLDER)}/Contents/Frameworks/${ORT_DYLIB_RE.source.slice(1)}`),
  `${MACOS_APP_FOLDER}/Contents/_CodeSignature/CodeResources`,
];

/** Files the macOS app bundle may have besides MACOS_PACKAGE_FILES (JUCE puts them there; a missing one is fine). */
export const MACOS_OPTIONAL_FILES = [
  `${MACOS_APP_FOLDER}/Contents/PkgInfo`,
  `${MACOS_APP_FOLDER}/Contents/Resources/Icon.icns`,
  `${MACOS_APP_FOLDER}/Contents/Resources/RecentFilesMenuTemplate.nib`,
];

/** The files of the macOS package that must be executable. */
export const MACOS_EXECUTABLES = ['OpenTune-AI.command', `${MACOS_APP_FOLDER}/Contents/MacOS/OpenTune`];

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/';

/**
 * Reasons a path (relative, '/'-separated) or its content is forbidden, checked recursively and
 * case-insensitively: model weights, the POST_BUILD models directory, LFS pointers, the DirectX 12
 * Agility runtime (D3D12*), d3dconfig.exe and upstream's STATEMENTS.txt.
 */
export function forbiddenReasons(relPath, head) {
  const out = [];
  const segments = relPath.split('/').filter(Boolean);
  const lower = segments.map((s) => s.toLowerCase());
  if (lower.some((s) => s.endsWith('.onnx'))) out.push('model weights (*.onnx)');
  if (lower.includes('models')) out.push('models directory');
  if (lower.some((s) => s.startsWith('d3d12'))) out.push('DirectX 12 Agility runtime (D3D12*)');
  if (lower.includes('d3dconfig.exe')) out.push('d3dconfig.exe');
  if (lower.includes('statements.txt')) out.push('STATEMENTS.txt');
  if (head && Buffer.from(head).subarray(0, LFS_POINTER_PREFIX.length).toString('latin1') === LFS_POINTER_PREFIX) out.push('Git LFS pointer');
  return out;
}

/**
 * Check a package listing against the allow-list.
 * @param {{path: string, isDir?: boolean, head?: Buffer, mode?: number | null}[]} entries  paths relative to the
 *   package folder, '/'-separated; head: the first bytes of a file (for the LFS pointer check); mode: the Unix
 *   mode of the entry when the archive records one (macOS: symbolic links are refused)
 * @param {{platform?: 'win-x64' | 'macos-arm64'}} [options]  win-x64 (default): one flat folder of files;
 *   macos-arm64: the files of MACOS_PACKAGE_FILES, with the app bundle nested below its folder
 * @returns {string[]} problems; empty means the package is exactly the allow-list
 */
export function checkPackageEntries(entries, { platform = 'win-x64' } = {}) {
  const nested = platform === 'macos-arm64';
  const required = nested ? MACOS_PACKAGE_FILES : PACKAGE_FILES;
  const optional = nested ? MACOS_OPTIONAL_FILES : [];
  const problems = [];
  const files = [];
  const dirs = [];
  // Two entries with the same name (or names that differ only in case, which collide when the zip is
  // extracted on Windows or on a default macOS volume) are an error: which copy an extractor keeps is not
  // defined, so the checked copy might not be the one a user gets.
  const seen = new Map();
  for (const e of entries) {
    const p = String(e.path).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const key = p.toLowerCase();
    if (seen.has(key)) {
      const first = seen.get(key);
      problems.push(first === p ? `duplicate entry: ${p}` : `duplicate entry: ${p} (differs from ${first} only in case)`);
      continue;
    }
    seen.set(key, p);
    for (const why of forbiddenReasons(p, e.head)) problems.push(`forbidden: ${p} (${why})`);
    if (Number.isInteger(e.mode) && (e.mode & 0o170000) === 0o120000) problems.push(`symbolic link: ${p}`);
    if (e.isDir) dirs.push(p);
    else if (!nested && p.includes('/')) problems.push(`unexpected file in a subdirectory: ${p}`);
    else files.push(p);
  }
  const matches = (want, f) => (typeof want === 'string' ? f === want : want.test(f));
  const used = new Set();
  for (const want of required) {
    const label = typeof want === 'string' ? want : want.source;
    const hits = files.filter((f) => matches(want, f));
    if (!hits.length) problems.push(`missing: ${label}`);
    if (hits.length > 1) problems.push(`more than one file matches ${label}: ${hits.join(', ')}`);
    for (const h of hits) used.add(h);
  }
  for (const want of optional) for (const f of files) if (matches(want, f)) used.add(f);
  for (const f of files) if (!used.has(f)) problems.push(`not on the allow-list: ${f}`);
  // Directories: none in a flat package; in a nested one only the parents of the files that are kept.
  for (const d of dirs) {
    if (nested && files.some((f) => used.has(f) && f.startsWith(`${d}/`))) continue;
    problems.push(`unexpected directory: ${d}`);
  }
  return problems;
}

/** Problems with the Unix modes of the macOS package: the launcher script and the app's executable must be executable. */
export function checkMacosModes(entries) {
  const problems = [];
  const byPath = new Map(entries.map((e) => [String(e.path).replace(/\\/g, '/'), e]));
  for (const p of MACOS_EXECUTABLES) {
    const e = byPath.get(p);
    if (!e) continue; // reported as missing by checkPackageEntries
    if (!Number.isInteger(e.mode)) problems.push(`${p}: the archive records no Unix mode`);
    else if ((e.mode & 0o111) !== 0o111) problems.push(`${p}: not executable (mode ${(e.mode & 0o7777).toString(8)})`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// SHA256SUMS
// ---------------------------------------------------------------------------------------------

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** `<sha256>  <name>` per line (sha256sum text format), names sorted bytewise, LF line ends. */
export function formatSha256Sums(hashes) {
  const entries = hashes instanceof Map ? [...hashes] : Object.entries(hashes);
  return entries.sort(([a], [b]) => byteOrder(a, b)).map(([name, hex]) => `${hex}  ${name}\n`).join('');
}

/** @returns {Map<string, string>} name -> lowercase hex; throws on a malformed or duplicate line */
export function parseSha256Sums(text) {
  const out = new Map();
  for (const [i, line] of String(text).split('\n').entries()) {
    if (!line.trim()) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''));
    if (!m) throw new Error(`SHA256SUMS line ${i + 1} is malformed`);
    if (out.has(m[2])) throw new Error(`SHA256SUMS lists ${m[2]} twice`);
    out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/**
 * SHA256SUMS must list every other file of the package exactly once, with the right hash.
 * @param {string} text  content of SHA256SUMS
 * @param {Map<string, string>} actual  name -> sha256 of every file except SHA256SUMS
 */
export function verifySha256Sums(text, actual) {
  let listed;
  try {
    listed = parseSha256Sums(text);
  } catch (e) {
    return [e.message];
  }
  const problems = [];
  for (const [name, hex] of actual) {
    if (!listed.has(name)) problems.push(`SHA256SUMS does not list ${name}`);
    else if (listed.get(name) !== hex) problems.push(`SHA256SUMS mismatch for ${name}`);
  }
  for (const name of listed.keys()) if (!actual.has(name)) problems.push(`SHA256SUMS lists ${name}, which is not in the package`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// opentune-control.json (read by OpenTune MCP Server next to OpenTune.exe)
// ---------------------------------------------------------------------------------------------

/** OpenTune MCP Server reads at most this many bytes of opentune-control.json. */
export const CONTROL_JSON_MAX_BYTES = 8192;

/** Build the side-car object. Field meanings: .github/release/README.md. */
export function buildControlJson({ protocolMajor, appVersion, commit, tag, label, date, sourceUrl, officialRepositoryUrl, d3d12, platform = 'win-x64' }) {
  if (!Object.hasOwn(PLATFORMS, platform)) throw new Error(`bad platform ${platform}`);
  const mac = platform === 'macos-arm64';
  if (!mac && !d3d12) throw new Error('buildControlJson: d3d12 is required for win-x64');
  return {
    schema: 1,
    protocolMajors: [protocolMajor],
    flavor: 'standalone',
    appVersion,
    unofficial: true,
    // The Windows file has no platform member (it predates the macOS package); a macOS file says so.
    ...(mac ? { platform } : {}),
    build: { commit, tag: tag || null, label, date, controlApi: true },
    sourceUrl,
    officialRepository: officialRepositoryUrl,
    modelsBundled: false,
    // The DirectX 12 Agility runtime is a Windows matter; the macOS file has no d3d12 member.
    ...(mac
      ? {}
      : {
          d3d12: {
            bundled: false,
            directory: 'D3D12',
            agilityVersion: d3d12.agilityVersion,
            sdkVersion: d3d12.sdkVersion,
            files: d3d12.files.map((f) => ({ name: f.name, sha256: f.sha256 })),
          },
        }),
  };
}

/**
 * Validate the bytes of opentune-control.json: the rules OpenTune MCP Server applies (UTF-8 JSON object
 * of at most 8 KiB whose protocolMajors is an array of positive integers containing 1) and this
 * package's own fields.
 */
export function validateControlJson(buf) {
  const bytes = Buffer.from(buf);
  const problems = [];
  if (bytes.length > CONTROL_JSON_MAX_BYTES) problems.push(`larger than ${CONTROL_JSON_MAX_BYTES} bytes (${bytes.length})`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('starts with a UTF-8 BOM');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [...problems, 'not valid UTF-8'];
  }
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return [...problems, `not JSON: ${e.message}`];
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [...problems, 'not a JSON object'];
  const pm = o.protocolMajors;
  if (!Array.isArray(pm) || !pm.length || !pm.every((v) => Number.isInteger(v) && v > 0)) problems.push('protocolMajors must be a non-empty array of positive integers');
  else if (!pm.includes(1)) problems.push('protocolMajors must contain 1');
  if (o.schema !== 1) problems.push('schema must be 1');
  if (o.flavor !== 'standalone') problems.push('flavor must be "standalone"');
  if (o.unofficial !== true) problems.push('unofficial must be true');
  if (typeof o.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(o.appVersion)) problems.push('appVersion must be x.y.z');
  if (!/^[0-9a-f]{40}$/.test(o.build?.commit ?? '')) problems.push('build.commit must be a 40-digit commit SHA');
  if (o.build?.tag !== null && !parseTestTag(o.build?.tag)) problems.push('build.tag must be null or synchain-test/v<x.y.z>-ctl.<n>');
  if (o.modelsBundled !== false) problems.push('modelsBundled must be false');
  if (o.platform !== undefined && o.platform !== 'macos-arm64') problems.push('platform, when present, must be "macos-arm64"');
  if (o.platform === 'macos-arm64') {
    if (o.d3d12 !== undefined) problems.push('a macOS file has no d3d12 member');
  } else {
    if (o.d3d12?.bundled !== false) problems.push('d3d12.bundled must be false');
    for (const f of o.d3d12?.files ?? []) if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? '')) problems.push(`d3d12.files: bad sha256 for ${f?.name}`);
    if (!(o.d3d12?.files ?? []).length) problems.push('d3d12.files must list D3D12Core.dll');
  }
  for (const k of ['sourceUrl', 'officialRepository']) if (!/^https:\/\//.test(o[k] ?? '')) problems.push(`${k} must be an https URL`);
  return problems;
}

/** Value of a <key>…</key><string>…</string> pair of an XML property list, or null. */
export function plistString(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(String(xml));
  return m ? m[1] : null;
}

/**
 * Content checks of the macOS package that need the bytes of a few files.
 * @param {Map<string, Buffer>} files  path relative to the package folder -> content (at least the files below)
 * @param {{bundleIdentifier: string, bundleName: string}} bundle  what the Info.plist must say
 * @returns {string[]} problems: the program and the ONNX Runtime dylib are Mach-O files with an arm64 slice, the
 *   Info.plist names the renamed bundle and still starts the program OpenTune, and opentune-control.json is a valid
 *   macOS side-car file
 */
export function macosContentProblems(files, { bundleIdentifier, bundleName }) {
  const problems = [];
  const app = MACOS_APP_FOLDER;
  const machos = [`${app}/Contents/MacOS/OpenTune`, ...[...files.keys()].filter((p) => p.startsWith(`${app}/Contents/Frameworks/`))];
  for (const p of machos) {
    const buf = files.get(p);
    if (!buf) continue; // reported as missing by checkPackageEntries
    try {
      const info = machoInfo(buf);
      if (!info.slices.some((s) => s.arch === 'arm64')) problems.push(`${p}: no arm64 slice (${info.slices.map((s) => s.arch).join(', ')})`);
    } catch (e) {
      problems.push(`${p}: not a readable Mach-O file (${e.message})`);
    }
  }
  const plist = files.get(`${app}/Contents/Info.plist`);
  if (plist) {
    const text = plist.toString('latin1');
    if (text.startsWith('bplist')) {
      // A binary property list stores ASCII strings as they are: look for the expected values.
      for (const v of [bundleIdentifier, bundleName]) if (!text.includes(v)) problems.push(`Info.plist: ${v} not found`);
    } else {
      const want = { CFBundleIdentifier: bundleIdentifier, CFBundleName: bundleName, CFBundleDisplayName: bundleName, CFBundleExecutable: 'OpenTune' };
      for (const [k, v] of Object.entries(want)) {
        const got = plistString(text, k);
        if (got !== v) problems.push(`Info.plist: ${k} is ${got === null ? 'missing' : JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
      }
    }
  }
  const control = files.get('opentune-control.json');
  if (control) {
    problems.push(...validateControlJson(control).map((p) => `opentune-control.json: ${p}`));
    try {
      if (JSON.parse(control.toString('utf8')).platform !== 'macos-arm64') problems.push('opentune-control.json: platform must be "macos-arm64"');
    } catch {
      // reported by validateControlJson
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

/**
 * Replace every {{NAME}} with vars[NAME]. A placeholder without a value, or a malformed one such as
 * "{{ name }}", is an error, so a template and its caller cannot drift apart silently.
 * stripLeadingComment drops a leading <!-- ... --> block
 * (the SPDX header of Markdown templates that are not files of the package, such as the release body).
 */
export function renderTemplate(text, vars, { stripLeadingComment = false } = {}) {
  let src = String(text).replace(/^﻿/, '');
  if (stripLeadingComment) src = src.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  const missing = new Set();
  const out = src.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(vars, name)) {
      missing.add(name);
      return '';
    }
    return String(vars[name]);
  });
  if (missing.size) throw new Error(`template placeholders without a value: ${[...missing].join(', ')}`);
  const malformed = src.match(/\{\{(?![A-Z0-9_]+\}\})[^}\n]{0,40}\}?\}?/g);
  if (malformed) throw new Error(`malformed template placeholders: ${malformed.join(', ')}`);
  return out;
}

/** Convert LF / CRLF line ends to CRLF (cmd.exe needs them for batch files with non-ASCII comments). */
export function toCrlf(text) {
  return String(text).replace(/\r?\n/g, '\r\n');
}

// ---------------------------------------------------------------------------------------------
// MODIFICATIONS.md: what changed relative to the upstream snapshot
// ---------------------------------------------------------------------------------------------

/** Paths that exist only in the fork repository (governance, CI) and are not part of the program. */
export const FORK_ONLY_PATTERNS = [/^\.github\//, /^CLAUDE\.md$/, /^Tests\/ControlFork\//, /^Source\/Control\/\.clang-format$/, /^docs\/control-api(\.en)?\.md$/];

/**
 * Summarise `git diff --name-status --no-renames <upstream snapshot> HEAD`. Added files are grouped by
 * their first two path segments ("Source/Control/"); a group of at most three files is listed file by
 * file instead (dir is then the file path and count 1).
 * @returns {{modified: string[], deleted: string[], added: {dir: string, count: number}[], forkOnly: number}}
 */
export function summarizeModifications(nameStatusText) {
  const modified = [];
  const deleted = [];
  const addedGroups = new Map();
  let forkOnly = 0;
  for (const line of String(nameStatusText).split('\n')) {
    const m = /^([AMDT])\t(.+)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const [, st, file] = m;
    if (FORK_ONLY_PATTERNS.some((re) => re.test(file))) {
      forkOnly++;
      continue;
    }
    if (st === 'A') {
      const parts = file.split('/');
      const group = parts.length > 2 ? `${parts.slice(0, 2).join('/')}/` : parts.length === 2 ? `${parts[0]}/` : file;
      (addedGroups.get(group) ?? addedGroups.set(group, []).get(group)).push(file);
    } else if (st === 'D') deleted.push(file);
    else modified.push(file);
  }
  const sort = (a, b) => byteOrder(a, b);
  const added = [];
  for (const [group, files] of addedGroups) {
    if (files.length > 3) added.push({ dir: group, count: files.length });
    else for (const f of files) added.push({ dir: f, count: 1 });
  }
  return {
    modified: modified.sort(sort),
    deleted: deleted.sort(sort),
    added: added.sort((a, b) => sort(a.dir, b.dir)),
    forkOnly,
  };
}

// ---------------------------------------------------------------------------------------------
// Zip (deterministic writer, verifying reader)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Create a zip archive. Entries are written in the given order with one fixed timestamp, so the same
 * inputs always give the same bytes. Names ending in '/' are directories.
 * An entry with a `mode` (Unix permission bits, e.g. 0o755; 0o40755 for a directory) is recorded as made on
 * Unix with that mode, which is how a macOS package keeps its executable bits; one without is a FAT entry.
 * @param {{name: string, data?: Buffer, mode?: number}[]} entries
 */
export function createZip(entries, { date = '1980-01-01T00:00:00Z' } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : Buffer.from(e.data ?? Buffer.alloc(0));
    const deflated = isDir ? data : zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = !isDir && deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('zip64 is not supported');
    const flags = /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0;
    const unix = Number.isInteger(e.mode);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(unix ? (3 << 8) | 20 : 20, 4); // made by: Unix (3) or MS-DOS / FAT (0), spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // External attributes: the Unix mode in the high 16 bits (plus the FAT directory bit), or the FAT attribute.
    central.writeUInt32LE(unix ? (((e.mode & 0xffff) << 16) | (isDir ? 0x10 : 0)) >>> 0 : isDir ? 0x10 : 0x20, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Read every entry of a zip archive (stored or deflated), checking sizes and CRC-32. An entry name
 * that occurs twice is an error (extractors differ on which copy wins).
 * @returns {{name: string, isDir: boolean, data: Buffer, mode: number | null}[]}  mode: the Unix mode when the
 *   entry was made on Unix (its type bits tell a symbolic link from a file), else null
 */
export function readZip(buf) {
  const zip = Buffer.from(buf);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const madeBy = zip.readUInt16LE(p + 4) >>> 8;
    const external = zip.readUInt32LE(p + 38);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const xlen = zip.readUInt16LE(p + 30);
    const clen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (names.has(name)) throw new Error(`zip: duplicate entry ${name}`);
    names.add(name);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: ${name} uses unsupported method ${method}`);
    if (data.length !== usize) throw new Error(`zip: size mismatch for ${name}`);
    if (crc32(data) !== crc) throw new Error(`zip: CRC mismatch for ${name}`);
    out.push({ name, isDir: name.endsWith('/'), data, mode: madeBy === 3 ? external >>> 16 : null });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mach-O reader (macOS binaries: minimum macOS version, architectures, dependencies)
// ---------------------------------------------------------------------------------------------

const MACHO_CPU = new Map([
  [0x0100000c, 'arm64'],
  [0x0200000c, 'arm64_32'],
  [0x01000007, 'x86_64'],
  [0x00000007, 'i386'],
]);
const MACHO_FILETYPE = new Map([
  [1, 'object'],
  [2, 'executable'],
  [6, 'dylib'],
  [8, 'bundle'],
]);
const LC_ID_DYLIB = 0x0d;
const LC_LOAD_DYLIBS = new Map([
  [0x0c, false], // LC_LOAD_DYLIB
  [0x80000018, true], // LC_LOAD_WEAK_DYLIB
  [0x8000001f, false], // LC_REEXPORT_DYLIB
  [0x80000023, true], // LC_LOAD_UPWARD_DYLIB
  [0x20, true], // LC_LAZY_LOAD_DYLIB
]);
const LC_RPATH = 0x8000001c;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const LC_CODE_SIGNATURE = 0x1d;
const MACHO_PLATFORM = new Map([[1, 'macos'], [2, 'ios'], [3, 'tvos'], [4, 'watchos'], [6, 'maccatalyst'], [7, 'iossimulator']]);

/** 0x000d0300-style packed version (xxxx.yy.zz) -> "13.3" (patch only when not 0). */
export function formatMachoVersion(v) {
  const major = v >>> 16;
  const minor = (v >>> 8) & 0xff;
  const patch = v & 0xff;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/** Compare dotted versions ("12.0" < "13.3" < "13.3.1"); returns a negative, zero or positive number. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function readMachoSlice(buf, start, length) {
  if (length < 32) throw new Error('Mach-O: slice too small');
  const magic = buf.readUInt32LE(start);
  if (magic !== 0xfeedfacf && magic !== 0xfeedface) throw new Error(`Mach-O: unknown magic ${magic.toString(16)} (only little-endian slices are supported)`);
  const is64 = magic === 0xfeedfacf;
  const cputype = buf.readUInt32LE(start + 4);
  const filetype = buf.readUInt32LE(start + 12);
  const ncmds = buf.readUInt32LE(start + 16);
  let p = start + (is64 ? 32 : 28);
  const end = start + length;
  const info = {
    arch: MACHO_CPU.get(cputype) ?? `cpu-0x${cputype.toString(16)}`,
    filetype: MACHO_FILETYPE.get(filetype) ?? `type-${filetype}`,
    platform: null,
    minos: null,
    sdk: null,
    installName: null,
    dependencies: [],
    rpaths: [],
    hasCodeSignature: false,
  };
  const cstr = (at, max) => {
    const e = buf.indexOf(0, at);
    return buf.toString('utf8', at, e < 0 || e > max ? max : e);
  };
  for (let i = 0; i < ncmds; i++) {
    if (p + 8 > end) throw new Error('Mach-O: load commands run past the slice');
    const cmd = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > end) throw new Error('Mach-O: bad load command size');
    if (cmd === LC_BUILD_VERSION) {
      info.platform = MACHO_PLATFORM.get(buf.readUInt32LE(p + 8)) ?? `platform-${buf.readUInt32LE(p + 8)}`;
      info.minos = formatMachoVersion(buf.readUInt32LE(p + 12));
      info.sdk = formatMachoVersion(buf.readUInt32LE(p + 16));
    } else if (cmd === LC_VERSION_MIN_MACOSX && info.minos === null) {
      info.platform = 'macos';
      info.minos = formatMachoVersion(buf.readUInt32LE(p + 8));
      info.sdk = formatMachoVersion(buf.readUInt32LE(p + 12));
    } else if (cmd === LC_ID_DYLIB) {
      info.installName = cstr(p + buf.readUInt32LE(p + 8), p + size);
    } else if (LC_LOAD_DYLIBS.has(cmd)) {
      info.dependencies.push({ name: cstr(p + buf.readUInt32LE(p + 8), p + size), weak: LC_LOAD_DYLIBS.get(cmd) });
    } else if (cmd === LC_RPATH) {
      info.rpaths.push(cstr(p + buf.readUInt32LE(p + 8), p + size));
    } else if (cmd === LC_CODE_SIGNATURE) info.hasCodeSignature = true;
    p += size;
  }
  return info;
}

/**
 * Read the facts of a Mach-O file that matter for a macOS test build: for each architecture slice (a thin
 * file has one, a universal binary several) the architecture, the file type, the minimum macOS version
 * (LC_BUILD_VERSION, else LC_VERSION_MIN_MACOSX), the dylibs it links, its rpaths and, for a dylib, its
 * install name. Only little-endian slices (arm64, x86_64) are supported.
 * @returns {{universal: boolean, slices: ReturnType<typeof readMachoSlice>[]}}
 */
export function machoInfo(input) {
  const buf = Buffer.from(input);
  if (buf.length < 8) throw new Error('Mach-O: file too small');
  const magicBE = buf.readUInt32BE(0);
  if (magicBE === 0xcafebabe || magicBE === 0xcafebabf) {
    const wide = magicBE === 0xcafebabf;
    const n = buf.readUInt32BE(4);
    if (n < 1 || n > 16) throw new Error(`Mach-O: ${n} architectures in a universal binary`);
    const slices = [];
    for (let i = 0; i < n; i++) {
      const at = 8 + i * (wide ? 32 : 20);
      const offset = wide ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      const size = wide ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12);
      if (offset + size > buf.length) throw new Error('Mach-O: a universal slice runs past the end of the file');
      slices.push(readMachoSlice(buf, offset, size));
    }
    return { universal: true, slices };
  }
  return { universal: false, slices: [readMachoSlice(buf, 0, buf.length)] };
}

/** The highest minimum macOS version over the given arm64-capable Mach-O infos, or null when none states one. */
export function minMacosOf(infos, arch = 'arm64') {
  let best = null;
  for (const info of infos) {
    for (const s of info.slices) {
      if (s.arch !== arch || s.minos === null) continue;
      if (best === null || compareVersions(s.minos, best) > 0) best = s.minos;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Ninja build graph: what is linked into the Standalone executable
// ---------------------------------------------------------------------------------------------

function unescapeNinja(s) {
  return s.replace(/\$([ :$])/g, '$1');
}

/** Split a `build` line (after the keyword) into outputs, rule, explicit/implicit/order-only inputs. */
function parseBuildLine(rest) {
  const tokens = [];
  let cur = '';
  let seenColon = false;
  const push = () => {
    if (cur) tokens.push(cur);
    cur = '';
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '$' && i + 1 < rest.length) {
      cur += c + rest[i + 1];
      i++;
    } else if (c === ' ') push();
    else if (c === ':' && !seenColon) {
      push();
      tokens.push(':');
      seenColon = true;
    } else cur += c;
  }
  push();
  const colon = tokens.indexOf(':');
  if (colon < 0) return null;
  const outs = tokens.slice(0, colon).filter((t) => t !== '|').map(unescapeNinja);
  const rule = tokens[colon + 1];
  const explicit = [];
  const implicit = [];
  let mode = 'explicit';
  for (const t of tokens.slice(colon + 2)) {
    if (t === '|') mode = 'implicit';
    else if (t === '||' || t === '|@') mode = 'other';
    else if (mode === 'explicit') explicit.push(unescapeNinja(t));
    else if (mode === 'implicit') implicit.push(unescapeNinja(t));
  }
  return { outs, rule, explicit, implicit };
}

export const normPath = (p) => String(p).replace(/\\/g, '/');

/**
 * Parse the build statements of a Ninja file (CMake's impl-<config>.ninja).
 * @returns {Map<string, {rule: string, explicit: string[], implicit: string[], vars: Record<string,string>}>}
 *   keyed by every output path, normalised to '/' and lower case
 */
export function parseNinja(text) {
  const lines = String(text).split(/\r?\n/);
  const joined = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (/(^|[^$])(\$\$)*\$$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '');
    joined.push(line);
  }
  const builds = new Map();
  let current = null;
  for (const line of joined) {
    if (line.startsWith('build ')) {
      const b = parseBuildLine(line.slice(6));
      current = b ? { rule: b.rule, explicit: b.explicit, implicit: b.implicit, vars: {}, outs: b.outs } : null;
      if (current) for (const o of b.outs) builds.set(normPath(o).toLowerCase(), current);
    } else if (current && /^\s+\S/.test(line)) {
      const m = /^\s+([A-Za-z0-9_.-]+)\s*=\s?(.*)$/.exec(line);
      if (m) current.vars[m[1]] = unescapeNinja(m[2]);
    } else if (line.trim() && !line.startsWith('#')) current = null;
  }
  return builds;
}

/**
 * Split a command-line fragment on whitespace. Double quotes group (and are removed), \" is a literal
 * quote, other backslashes are kept (Windows paths).
 */
export function splitCommandLine(s) {
  const str = String(s ?? '');
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && str[i + 1] === '"') {
      cur += '"';
      has = true;
      i++;
    } else if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(c) && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** -DNAME=VALUE / /DNAME / -DNAME="x" tokens of a DEFINES variable -> {NAME: VALUE} ('1' when no value). */
export function parseDefines(s) {
  const out = {};
  for (const tok of splitCommandLine(s)) {
    const m = /^[-/]D([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(tok);
    if (m) out[m[1]] = m[2] === undefined ? '1' : m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/**
 * Every object file linked into an executable target, following static libraries built in the same
 * Ninja file.
 * @returns {{exe: string, linkFlags: string, libraries: string[], objects: {output: string, source: string, defines: Record<string,string>, includes: string[]}[]}}
 */
export function linkClosure(builds, { target, config }) {
  const linkRule = `CXX_EXECUTABLE_LINKER__${target}_${config}`;
  let exe = null;
  for (const b of new Set(builds.values())) {
    if (b.rule === linkRule) {
      if (exe && exe !== b) throw new Error(`more than one ${linkRule} statement`);
      exe = b;
    }
  }
  if (!exe) throw new Error(`no ${linkRule} statement in the Ninja file (target ${target}, config ${config})`);
  const libraries = splitCommandLine(exe.vars.LINK_LIBRARIES).filter((t) => /\.(lib|a)$/i.test(t));
  const objects = [];
  const seen = new Set();
  const visit = (file) => {
    const key = normPath(file).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const b = builds.get(key);
    if (!b) return; // a system library or an input that is not built here
    if (/^(C|CXX|OBJC|OBJCXX)_COMPILER__/.test(b.rule)) {
      objects.push({
        output: normPath(file),
        source: normPath(b.explicit[0] ?? ''),
        defines: parseDefines(b.vars.DEFINES),
        includes: splitCommandLine(b.vars.INCLUDES).map((t) => normPath(t.replace(/^[-/]I/, ''))),
      });
    } else if (/_STATIC_LIBRARY_LINKER__/.test(b.rule)) {
      for (const i of b.explicit) visit(i);
    }
  };
  for (const i of [...exe.explicit, ...libraries]) visit(i);
  return { exe: normPath(exe.outs[0]), linkFlags: exe.vars.LINK_FLAGS ?? '', libraries: libraries.map(normPath), objects };
}

/** The effective value of a macro in one object: its -D value, else the given default. */
export function macroValue(obj, name, dflt = '0') {
  return Object.hasOwn(obj.defines, name) ? obj.defines[name] : dflt;
}

const truthy = (v) => v !== '0' && v !== '' && v !== 'false';

/** JUCE module of a compiled source (".../modules/juce_core/..."), or null. */
export function juceModuleOf(source) {
  const m = /(?:^|\/)modules\/(juce_[a-z0-9_]+)\//i.exec(source);
  return m ? m[1] : null;
}

/**
 * Is the ARA SDK linked into the executable? Yes when any ARA SDK source is compiled into it, any
 * object enables ARA (JucePlugin_Enable_ARA or JUCE_PLUGINHOST_ARA, both default 0 in JUCE), or an ARA
 * library is linked.
 */
export function araLinkStatus(closure) {
  const reasons = [];
  for (const o of closure.objects) {
    if (/(?:^|\/)ARA_(?:SDK|Library|API)[^/]*\//i.test(o.source)) reasons.push(`ARA SDK source compiled in: ${o.source}`);
    for (const macro of ['JucePlugin_Enable_ARA', 'JUCE_PLUGINHOST_ARA']) {
      if (truthy(macroValue(o, macro, '0'))) reasons.push(`${macro}=${o.defines[macro]} in ${o.source}`);
    }
  }
  for (const lib of closure.libraries) if (/(?:^|\/)(?:lib)?ara[^/]*\.(?:lib|a)$/i.test(lib)) reasons.push(`ARA library linked: ${lib}`);
  return { linked: reasons.length > 0, reasons: [...new Set(reasons)].slice(0, 20) };
}

/**
 * Evaluate a catalogue condition ("when") against the objects of one JUCE module.
 *   undefined / "always"                      -> true
 *   {"never": "<reason>"}                      -> false
 *   {"anyMacro": [{"name", "default"}...]}     -> true when any macro is non-zero in any of the objects
 */
export function evaluateWhen(when, objects) {
  if (when === undefined || when === 'always') return { ok: true, why: 'module linked' };
  if (when && typeof when === 'object' && 'never' in when) return { ok: false, why: String(when.never) };
  if (when && typeof when === 'object' && Array.isArray(when.anyMacro)) {
    for (const { name, default: dflt = '0' } of when.anyMacro) {
      for (const o of objects) {
        const v = macroValue(o, name, String(dflt));
        if (truthy(v)) return { ok: true, why: `${name}=${v}${Object.hasOwn(o.defines, name) ? '' : ' (JUCE default)'}` };
      }
    }
    return { ok: false, why: `${when.anyMacro.map((m) => m.name).join(' / ')} off in the linked objects` };
  }
  throw new Error(`unknown condition ${JSON.stringify(when)}`);
}

/**
 * Third-party packages vendored inside JUCE (from JUCE.spdx.json) that end up in the executable: the
 * containing module is linked, and the package's condition holds. Packages without a condition are
 * included whenever their module is linked (a notice too many is harmless; one too few is not).
 * @returns {{included: object[], excluded: {name: string, why: string}[]}}
 */
export function selectJuceVendored(sbom, closure, conditions = {}) {
  const pkgs = new Map((sbom.packages ?? []).map((p) => [p.SPDXID, p]));
  const byModule = new Map();
  for (const o of closure.objects) {
    const mod = juceModuleOf(o.source);
    if (mod) (byModule.get(mod) ?? byModule.set(mod, []).get(mod)).push(o);
  }
  const included = [];
  const excluded = [];
  for (const r of sbom.relationships ?? []) {
    if (r.relationshipType !== 'CONTAINS') continue;
    const parent = pkgs.get(r.spdxElementId);
    const child = pkgs.get(r.relatedSpdxElement);
    if (!parent || !child || !/^juce_/.test(parent.name)) continue;
    const objects = byModule.get(parent.name);
    if (!objects) {
      excluded.push({ name: child.name, why: `${parent.name} is not linked` });
      continue;
    }
    const verdict = evaluateWhen(conditions[child.name], objects);
    const location = /Vendored at (\S+)/.exec(child.sourceInfo ?? '')?.[1] ?? null;
    const entry = { name: child.name, version: child.versionInfo, license: child.licenseConcluded ?? child.licenseDeclared, supplier: child.supplier, module: parent.name, location, url: child.downloadLocation, why: verdict.why };
    if (verdict.ok) included.push(entry);
    else excluded.push({ name: child.name, why: verdict.why });
  }
  const order = (a, b) => byteOrder(a.name.toLowerCase(), b.name.toLowerCase());
  return { included: included.sort(order), excluded: excluded.sort(order), modules: [...byModule.keys()].sort() };
}

/** Does `haystack` contain a sample of `needle` (a 128-byte window from its middle, or all of it if shorter)? */
export function containsSample(haystack, needle) {
  if (!needle.length) return false;
  const len = Math.min(128, needle.length);
  const start = Math.max(0, Math.floor((needle.length - len) / 2));
  return haystack.indexOf(needle.subarray(start, start + len)) >= 0;
}
