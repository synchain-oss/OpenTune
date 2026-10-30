#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// release-macos: assemble the unofficial macOS (Apple silicon, arm64) test build from the artifact of
// build-macos.yml's release-package mode (prerelease.yml, job package-macos on a macOS runner). Never
// publishes anything. The Windows package is assembled by release-package.mjs; the zip of both is
// checked by `release-package.mjs verify` (the platform comes from the package name).
//
//   build  --inputs <dir> --out <dir> --label <ctl.N|rehearsal-sha7> --commit <sha> --date <ISO 8601>
//          --repository <owner/name> --name-status <file> --upstream-tag <tag> --upstream-commit <sha>
//          [--tag <name>] [--server-url https://github.com] [--run-url <url>] [--smoke <text>]
//          <inputs> is the build job's artifact: app.tar (the OpenTune.app bundle, packed with tar to keep modes),
//          THIRD-PARTY-NOTICES.txt and build-info.json. Writes <out>/<package>.zip, <out>/<package>/ (the same
//          files), <out>/release-body-macos.md and <out>/manifest-macos.json. A tag build stops on any release
//          blocker.
//
// What it does, in this order (each step is also written into the release body as a build command):
//   1. unpack app.tar and rename OpenTune.app to OpenTune-ctl.app (the official OpenTune.app is never replaced);
//   2. delete Contents/Resources/models and Contents/Resources/docs (the POST_BUILD copies: LFS pointers and a
//      0-byte vocoder placeholder that would hide the official models; the user guide);
//   3. PlistBuddy: CFBundleName / CFBundleDisplayName / CFBundleIdentifier from release.json (the macos section);
//      CFBundleExecutable stays OpenTune;
//   4. add opentune-control.json next to OpenTune-AI.command (not inside the app: codesign treats every file in
//      Contents/MacOS as code), the documents, LICENSE.txt and THIRD-PARTY-NOTICES.txt;
//   5. sign ad hoc, after every change: the dylib first, then the app; codesign --verify --deep --strict must pass;
//   6. SHA256SUMS over every file (after signing), the allow-list check, ditto -c -k --sequesterRsrc --keepParent,
//      and the same checks again on the zip as it will be published.
//
// exit 0 = ok, 1 = check failed, 2 = usage error
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkText, formatViolations, loadPatterns } from './check-attribution.mjs';
import { isMainModule, parseArgs, repoTop } from './fork-lib.mjs';
import {
  checkPackageEntries,
  formatSha256Sums,
  MACOS_APP_FOLDER,
  ORT_DYLIB_RE,
  packageName,
  parseTestTag,
  readCmakeProjectVersion,
  renderTemplate,
  sha256Hex,
  verifySha256Sums,
} from './release-lib.mjs';
import { commonTemplateVars, composeControlJson, formatCommands, verifyZipBuffer } from './release-package.mjs';

const PLATFORM = 'macos-arm64';
const PLIST_BUDDY = '/usr/libexec/PlistBuddy';

/** Template files of the macOS package (.github/release/templates/macos/, same names in the package). */
export const MACOS_TEMPLATE_FILES = ['README-UNOFFICIAL.txt', 'README-UNOFFICIAL.zh-CN.txt', 'INSTALL.txt', 'INSTALL.zh-CN.txt', 'MODIFICATIONS.md', 'OpenTune-AI.command'];

const fail = (msg) => {
  const e = new Error(msg);
  e.exitCode = 1;
  throw e;
};

const out = (line = '') => process.stdout.write(`${line}\n`);

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Run a program and return {stdout, stderr}; a non-zero exit is an error that carries the program's output. */
export function realExec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) fail(`${[cmd, ...args].join(' ')} exited with ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`.trim());
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Set a string entry of a property list with PlistBuddy (added when missing) and read it back. */
export function setPlistString(exec, plist, key, value) {
  try {
    exec(PLIST_BUDDY, ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    exec(PLIST_BUDDY, ['-c', `Add :${key} string ${value}`, plist]);
  }
  const got = exec(PLIST_BUDDY, ['-c', `Print :${key}`, plist]).stdout.trim();
  if (got !== value) fail(`Info.plist: ${key} is ${JSON.stringify(got)} after the change, expected ${JSON.stringify(value)}`);
}

/**
 * Every entry below a folder, depth first, sorted by name; paths are relative and '/'-separated. A symbolic
 * link is reported as such (it has no place in this package).
 * @returns {{path: string, abs: string, isDir: boolean, symlink?: boolean, size?: number}[]}
 */
export function walkTree(root) {
  const entries = [];
  const visit = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort(byteOrder)) {
      const p = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) entries.push({ path: r, abs: p, isDir: false, symlink: true });
      else if (st.isDirectory()) {
        entries.push({ path: r, abs: p, isDir: true });
        visit(p, r);
      } else entries.push({ path: r, abs: p, isDir: false, size: st.size });
    }
  };
  visit(root, '');
  return entries;
}

/** Remove empty folders below `root` (not `root` itself). */
function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    if (fs.lstatSync(p).isDirectory()) {
      pruneEmptyDirs(p);
      if (!fs.readdirSync(p).length) fs.rmdirSync(p);
    }
  }
}

function readMacosInputs(dir) {
  const need = (rel) => {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) fail(`build: input missing: ${rel}`);
    return f;
  };
  const info = JSON.parse(fs.readFileSync(need('build-info.json'), 'utf8'));
  if (info.platform !== PLATFORM) fail(`build: build-info.json is for ${info.platform ?? 'no platform'}, not ${PLATFORM}`);
  if (!ORT_DYLIB_RE.test(info.ortDylib ?? '')) fail(`build: build-info.json has no valid ortDylib (${info.ortDylib})`);
  if (!/^\d+\.\d+(\.\d+)?$/.test(info.minMacos ?? '')) fail(`build: build-info.json has no minimum macOS version (${info.minMacos})`);
  if (info.controlApi !== true) fail('build: the build was not made with the control API option on');
  if (info.ara?.linked) out(`note: the ARA SDK is linked (${info.ara.reasons.join('; ')}); THIRD-PARTY-NOTICES.txt includes it`);
  return { info, tar: need('app.tar'), notices: fs.readFileSync(need('THIRD-PARTY-NOTICES.txt')) };
}

/**
 * Assemble the macOS package. `exec` runs the system programs (tar, PlistBuddy, xattr, codesign, ditto); tests
 * pass a fake. Returns the manifest.
 */
export function buildMacosPackage(o, { exec = realExec } = {}) {
  for (const k of ['inputs', 'out', 'label', 'commit', 'date', 'repository', 'name-status', 'upstream-tag', 'upstream-commit']) if (!o[k]) fail(`build: --${k} is required`);
  const top = repoTop(process.cwd());
  const release = path.join(top, '.github', 'release');
  const templates = path.join(release, 'templates', 'macos');
  const cfg = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
  if (!cfg.macos?.minOfficialVersion || !cfg.macos?.bundleName || !cfg.macos?.bundleIdentifier) fail('build: release.json needs minOfficialVersion, bundleName and bundleIdentifier in its macos section');
  const bundle = { bundleName: cfg.macos.bundleName, bundleIdentifier: cfg.macos.bundleIdentifier };
  const lock = JSON.parse(fs.readFileSync(path.join(top, '.github', 'scripts', 'deps.lock.json'), 'utf8'));
  const version = readCmakeProjectVersion(fs.readFileSync(path.join(top, 'CMakeLists.txt'), 'utf8'));
  const tag = o.tag ?? '';
  const mode = tag ? 'release' : 'rehearsal';
  if (tag) {
    const p = parseTestTag(tag);
    if (!p || p.version !== version || p.label !== o.label) fail(`build: tag ${tag} does not match version ${version} and label ${o.label}`);
  } else if (o.label !== `rehearsal-${o.commit.slice(0, 7)}`) fail(`build: a rehearsal needs --label rehearsal-${o.commit.slice(0, 7)}`);
  const name = packageName({ version, label: o.label, platform: PLATFORM });
  const inputsDir = path.resolve(o.inputs);
  const { info, tar, notices } = readMacosInputs(inputsDir);

  for (const b of info.blockers ?? []) out(`${mode === 'release' ? '::error' : '::warning'} title=release blocker::${b.why}`);
  if (mode === 'release' && (info.blockers ?? []).length) fail(`build: ${info.blockers.length} release blocker(s); a tagged release cannot be packaged until they are resolved`);

  const server = (o['server-url'] ?? 'https://github.com').replace(/\/+$/, '');
  const forkUrl = `${server}/${o.repository}`;
  const date = new Date(o.date);
  if (Number.isNaN(date.getTime())) fail(`build: --date ${o.date} is not a date`);
  const day = date.toISOString().slice(0, 10);
  const vars = {
    ...commonTemplateVars({ cfg, lock, version, name, tag, o }),
    MIN_OFFICIAL_VERSION: cfg.macos.minOfficialVersion,
    MIN_MACOS: info.minMacos,
    ORT_DYLIB: info.ortDylib,
  };

  const outDir = path.resolve(o.out);
  const folder = path.join(outDir, name);
  const app = path.join(folder, MACOS_APP_FOLDER);
  const zipName = `${name}.zip`;
  const zipPath = path.join(outDir, zipName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.mkdirSync(folder, { recursive: true });

  // Every program run is recorded for the "exact build commands" of the release body.
  const executed = [];
  const place = (s) => String(s).split(folder).join('<package>').split(inputsDir).join('<artifact>').split(outDir).join('<out>');
  const run = (step, cmd, args) => {
    executed.push({ step, argv: [cmd, ...args.map(place)] });
    return exec(cmd, args);
  };

  // 1. the app bundle, renamed
  run('Unpack the app bundle of the build', 'tar', ['-xf', path.join(inputsDir, 'app.tar'), '-C', folder]);
  if (!fs.existsSync(path.join(folder, 'OpenTune.app'))) fail('build: app.tar does not contain OpenTune.app');
  fs.renameSync(path.join(folder, 'OpenTune.app'), app);

  // 2. no models, no user guide
  const resources = path.join(app, 'Contents', 'Resources');
  for (const d of ['models', 'docs']) fs.rmSync(path.join(resources, d), { recursive: true, force: true });
  pruneEmptyDirs(resources);
  executed.push({ step: 'Delete the models and docs folders that the POST_BUILD step copied into the bundle', argv: ['rm', '-rf', '<package>/OpenTune-ctl.app/Contents/Resources/models', '<package>/OpenTune-ctl.app/Contents/Resources/docs'] });

  // 3. Info.plist
  const plist = path.join(app, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) fail('build: the bundle has no Contents/Info.plist');
  const exeName = run('Read CFBundleExecutable', PLIST_BUDDY, ['-c', 'Print :CFBundleExecutable', plist]).stdout.trim();
  if (exeName !== 'OpenTune') fail(`build: CFBundleExecutable is ${JSON.stringify(exeName)}, expected OpenTune`);
  for (const [key, value] of [['CFBundleName', bundle.bundleName], ['CFBundleDisplayName', bundle.bundleName], ['CFBundleIdentifier', bundle.bundleIdentifier]]) {
    executed.push({ step: `Info.plist: ${key}`, argv: [PLIST_BUDDY, '-c', `Set :${key} ${value}`, '<package>/OpenTune-ctl.app/Contents/Info.plist'] });
    setPlistString(exec, plist, key, value);
  }

  // 4. the files that are not part of the build
  const pkg = new Map();
  pkg.set('LICENSE.txt', fs.readFileSync(path.join(top, 'LICENSE')));
  pkg.set('THIRD-PARTY-NOTICES.txt', notices);
  for (const t of MACOS_TEMPLATE_FILES) pkg.set(t, Buffer.from(renderTemplate(fs.readFileSync(path.join(templates, t), 'utf8').replace(/\r\n/g, '\n'), vars), 'utf8'));
  for (const [n, b] of pkg) fs.writeFileSync(path.join(folder, n), b, { mode: n === 'OpenTune-AI.command' ? 0o755 : 0o644 });
  fs.chmodSync(path.join(folder, 'OpenTune-AI.command'), 0o755);
  const controlBuf = composeControlJson({ top, cfg, info, commit: o.commit, tag, label: o.label, day, server, forkUrl, platform: PLATFORM });
  // Next to OpenTune-AI.command, not inside the app: codesign treats every file in Contents/MacOS as code and refuses an app that has a JSON file there.
  fs.writeFileSync(path.join(folder, 'opentune-control.json'), controlBuf, { mode: 0o644 });

  // 5. sign ad hoc, after every change: nested code first, then the app
  run('Remove extended attributes', 'xattr', ['-cr', folder]);
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  const dylibs = fs.existsSync(frameworks) ? fs.readdirSync(frameworks).filter((f) => fs.statSync(path.join(frameworks, f)).isFile()).sort(byteOrder) : [];
  if (dylibs.length !== 1 || dylibs[0] !== info.ortDylib) fail(`build: Contents/Frameworks should hold exactly ${info.ortDylib}, found ${dylibs.join(', ') || 'nothing'}`);
  for (const d of dylibs) run(`Sign ${d} (ad hoc)`, 'codesign', ['--force', '--sign', '-', path.join(frameworks, d)]);
  run('Sign the app (ad hoc)', 'codesign', ['--force', '--sign', '-', app]);
  const verifyRun = run('Verify the signature', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const display = run('Show the signature', 'codesign', ['-dv', '--verbose=2', app]);
  const signature = `${display.stdout}\n${display.stderr}`;
  if (!/^Signature=adhoc$/m.test(signature)) fail(`build: the app is not signed ad hoc:\n${signature.trim()}`);
  const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1] ?? null;
  if (identifier !== bundle.bundleIdentifier) fail(`build: the signature identifier is ${identifier}, expected ${bundle.bundleIdentifier}`);

  // 6. SHA256SUMS (after signing), the allow-list, attribution
  const tree = walkTree(folder);
  const hashes = new Map();
  for (const e of tree) if (!e.isDir && !e.symlink && e.path !== 'SHA256SUMS') hashes.set(e.path, sha256Hex(fs.readFileSync(e.abs)));
  fs.writeFileSync(path.join(folder, 'SHA256SUMS'), formatSha256Sums(hashes), { mode: 0o644 });

  const patterns = loadPatterns();
  const textViolations = [];
  for (const [n, b] of [...pkg, ['opentune-control.json', controlBuf]]) {
    if (!/\.(txt|md|command|json)$/i.test(n) || n === 'THIRD-PARTY-NOTICES.txt') continue;
    textViolations.push(...checkText(b.toString('utf8'), { patterns, source: n }).violations);
  }
  if (textViolations.length) fail(`build: attribution check failed:\n${formatViolations(textViolations)}`);

  const finalTree = walkTree(folder);
  const problems = [
    ...checkPackageEntries(
      finalTree.map((e) => ({ path: e.path, isDir: e.isDir, mode: e.symlink ? 0o120777 : null, head: e.isDir || e.symlink ? undefined : fs.readFileSync(e.abs).subarray(0, 64) })),
      { platform: PLATFORM },
    ),
    ...verifySha256Sums(fs.readFileSync(path.join(folder, 'SHA256SUMS'), 'utf8'), hashes),
  ];
  if (problems.length) fail(`build: package check failed:\n  ${problems.join('\n  ')}`);

  // 7. zip with ditto, then check the zip as it will be published
  run('Zip the folder', 'ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', folder, zipPath]);
  const zipBuf = fs.readFileSync(zipPath);
  const zv = verifyZipBuffer(zipBuf, name, { platform: PLATFORM, bundle });
  if (zv.problems.length) fail(`build: zip check failed:\n  ${zv.problems.join('\n  ')}`);
  const zipSha = sha256Hex(zipBuf);

  const names = [...hashes.keys(), 'SHA256SUMS'].sort(byteOrder);
  const fileInfo = (n) => {
    const b = fs.readFileSync(path.join(folder, ...n.split('/')));
    return { name: n, size: b.length, sha256: sha256Hex(b) };
  };
  const manifest = {
    name,
    platform: PLATFORM,
    mode,
    tag: tag || null,
    commit: o.commit,
    minMacos: info.minMacos,
    bundle: { ...bundle, executable: exeName },
    signature: { adhoc: true, identifier, verify: (verifyRun.stderr || verifyRun.stdout || 'passed').trim() },
    zip: { name: zipName, size: zipBuf.length, sha256: zipSha },
    files: names.map(fileInfo),
    blockers: info.blockers ?? [],
    ara: info.ara ?? null,
  };
  fs.writeFileSync(path.join(outDir, 'manifest-macos.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const fileTable = ['| File | Size (bytes) | SHA-256 |', '|---|---:|---|', ...manifest.files.map((f) => `| \`${f.name}\` | ${f.size} | \`${f.sha256}\` |`)].join('\n');
  const self = ['node', '.github/scripts/release-macos.mjs', 'build', '--inputs', '<artifact>', '--out', '<out>', '--label', o.label, ...(tag ? ['--tag', tag] : []), '--commit', o.commit, '--date', o.date, '--repository', o.repository, '--name-status', '<git diff --name-status --no-renames upstream-snapshot HEAD>', '--upstream-tag', o['upstream-tag'], '--upstream-commit', o['upstream-commit']];
  const body = renderTemplate(
    fs.readFileSync(path.join(templates, 'RELEASE-BODY-MACOS.md'), 'utf8').replace(/\r\n/g, '\n'),
    {
      ...vars,
      ZIP_NAME: zipName,
      ZIP_SIZE: String(zipBuf.length),
      ZIP_SHA256: zipSha,
      FILE_TABLE: fileTable,
      BUILD_COMMANDS: formatCommands([
        ...(info.commands ?? []),
        { step: 'Package the build artifact (this script; the programs it runs follow)', argv: self },
        ...executed,
      ]),
    },
    { stripLeadingComment: true },
  );
  const bodyCheck = checkText(body, { patterns, source: 'release-body-macos.md' });
  if (!bodyCheck.ok) fail(`build: release body attribution check failed:\n${formatViolations(bodyCheck.violations)}`);
  fs.writeFileSync(path.join(outDir, 'release-body-macos.md'), body);

  const report = [`### macOS 测试版产物：${zipName}（${mode === 'release' ? '正式出包' : '演练'}）`, '', `zip sha256 \`${zipSha}\`，${zipBuf.length} 字节；白名单与 SHA256SUMS 已复核，ad hoc 签名 \`codesign --verify --deep --strict\` 通过，不含模型与 LFS 指针；最低 macOS ${info.minMacos}。`, '', fileTable];
  if ((info.blockers ?? []).length) report.push('', '> [!WARNING]', `> 发布阻断项 ${info.blockers.length} 个（正式出包会失败）：`, ...info.blockers.map((b) => `> - ${b.id}：${b.why}`));
  summary(report.join('\n'));
  out(report.join('\n'));
  return manifest;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let o;
  try {
    ({ opts: o } = parseArgs(rest, {
      inputs: 'string', out: 'string', label: 'string', commit: 'string', date: 'string', repository: 'string',
      'name-status': 'string', 'upstream-tag': 'string', 'upstream-commit': 'string', tag: 'string', 'server-url': 'string',
      'run-url': 'string', smoke: 'string',
    }));
  } catch (e) {
    process.stderr.write(`release-macos: ${e.message}\n`);
    return 2;
  }
  try {
    if (cmd !== 'build') {
      process.stderr.write('usage: release-macos.mjs build [options] (see the header of this file)\n');
      return 2;
    }
    buildMacosPackage(o);
    return 0;
  } catch (e) {
    process.stderr.write(`release-macos: ${e.message}\n`);
    return e.exitCode ?? 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
