#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// release-package: validate a test build tag and assemble the unofficial Windows test build
// (prerelease.yml). Never publishes anything: creating the draft pre-release is a separate workflow
// step that runs only for a pushed synchain-test/* tag, and publishing it is a manual step.
//
//   validate  --event <github.event_name> [--tag <name>] [--checks <check-runs.json>] [--dev-ref origin/dev]
//             [--sha <commit>] [--github-output <file>]
//             Tag build (--tag given): the tag is synchain-test/v<x.y.z>-ctl.<n>, x.y.z equals the CMake
//             project VERSION, the commit is an ancestor of dev, and fork-gate is green on it.
//             Anything else is a rehearsal (label rehearsal-<sha7>): build, package and check, no release.
//   build     --inputs <dir> --out <dir> --label <ctl.N|rehearsal-sha7> --commit <sha> --date <ISO 8601>
//             --repository <owner/name> --name-status <file> --upstream-tag <tag> --upstream-commit <sha>
//             [--tag <name>] [--server-url https://github.com] [--run-url <url>] [--smoke <text>]
//             <inputs> is the build job's artifact (app/, licenses/, THIRD-PARTY-NOTICES.txt,
//             build-info.json). Writes <out>/<package>.zip, <out>/<package>/ (the same files),
//             <out>/release-body.md and <out>/manifest.json. A tag build stops on any release blocker.
//   verify    --zip <file> [--name <package>]   allow-list, forbidden content and SHA256SUMS of a zip
//
// exit 0 = ok, 1 = check failed, 2 = usage error
import fs from 'node:fs';
import path from 'node:path';
import { checkText, formatViolations, loadPatterns } from './check-attribution.mjs';
import { isAncestor, isMainModule, parseArgs, repoTop } from './fork-lib.mjs';
import {
  buildControlJson,
  checkPackageEntries,
  createZip,
  evaluateForkGate,
  formatSha256Sums,
  ORT_DLL_RE,
  PACKAGE_FILES,
  packageName,
  parseTestTag,
  readCmakeProjectVersion,
  readProtocolMajor,
  readZip,
  renderTemplate,
  sha256Hex,
  summarizeModifications,
  toCrlf,
  validateControlJson,
  verifySha256Sums,
} from './release-lib.mjs';

/** Template files rendered into the package (same names in .github/release/templates/). */
export const TEMPLATE_FILES = ['README-UNOFFICIAL.txt', 'README-UNOFFICIAL.zh-CN.txt', 'INSTALL.txt', 'INSTALL.zh-CN.txt', 'MODIFICATIONS.md', 'OpenTune-AI.cmd'];

const fail = (msg) => {
  const e = new Error(msg);
  e.exitCode = 1;
  throw e;
};

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// ---------------------------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------------------------

/**
 * Decide the build mode and check a tag. Pure apart from the injected `isAncestorOfDev`.
 * @returns {{mode: 'release'|'rehearsal', version: string, label: string, tag: string, name: string, checks: {name, ok, detail}[]}}
 */
export function validateBuild({ cmakeVersion, tag, sha, checkRuns, isAncestorOfDev }) {
  const checks = [];
  if (!tag) {
    const label = `rehearsal-${sha.slice(0, 7)}`;
    checks.push({ name: 'mode', ok: true, detail: 'rehearsal: build, package and check; no release' });
    return { mode: 'rehearsal', version: cmakeVersion, label, tag: '', name: packageName({ version: cmakeVersion, label }), checks };
  }
  const parsed = parseTestTag(tag);
  checks.push({ name: 'tag name', ok: Boolean(parsed), detail: parsed ? `${tag}` : `${tag} is not synchain-test/v<x.y.z>-ctl.<n>` });
  if (parsed) checks.push({ name: 'version', ok: parsed.version === cmakeVersion, detail: `tag ${parsed.version}, CMakeLists.txt ${cmakeVersion}` });
  const anc = isAncestorOfDev();
  checks.push({ name: 'on dev', ok: anc, detail: anc ? `${sha.slice(0, 7)} is an ancestor of dev` : `${sha.slice(0, 7)} is not an ancestor of dev` });
  const fg = evaluateForkGate(checkRuns);
  checks.push({ name: 'fork-gate', ok: fg.ok, detail: fg.detail });
  const label = parsed ? parsed.label : 'ctl.0';
  return { mode: 'release', version: cmakeVersion, label, tag, name: parsed ? packageName({ version: cmakeVersion, label }) : '', checks };
}

function cmdValidate(o) {
  const top = repoTop(process.cwd());
  const sha = o.sha ?? process.env.GITHUB_SHA;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) fail('validate: --sha (or GITHUB_SHA) must be a 40-digit commit SHA');
  const cmakeVersion = readCmakeProjectVersion(fs.readFileSync(path.join(top, 'CMakeLists.txt'), 'utf8'));
  const tag = o.event === 'push' ? (o.tag ?? '') : '';
  if (o.event === 'push' && !tag) fail('validate: a push run needs --tag (only synchain-test/* tags trigger this workflow)');
  const checkRuns = tag ? JSON.parse(fs.readFileSync(o.checks ?? fail('validate: a tag build needs --checks'), 'utf8')).check_runs : [];
  const r = validateBuild({ cmakeVersion, tag, sha, checkRuns, isAncestorOfDev: () => isAncestor(top, sha, o['dev-ref'] ?? 'origin/dev') });
  const lines = ['### 测试版构建校验', '', `模式：${r.mode === 'release' ? '正式出包（草稿预发布）' : '演练（不建 release）'}`, '', '| 检查 | 结果 | 说明 |', '|---|---|---|'];
  for (const c of r.checks) lines.push(`| ${c.name} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail} |`);
  summary(lines.join('\n'));
  out(JSON.stringify(r, null, 2));
  if (o['github-output']) fs.appendFileSync(o['github-output'], `mode=${r.mode}\nversion=${r.version}\nlabel=${r.label}\ntag=${r.tag}\nname=${r.name}\n`);
  if (r.checks.some((c) => !c.ok)) fail(`validate: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------

const quoteArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Markdown list of the changes relative to the upstream snapshot. */
export function modificationVars(nameStatusText) {
  const s = summarizeModifications(nameStatusText);
  const list = (items, fmt) => (items.length ? items.map(fmt).join('\n') : '- (none)');
  return {
    MODIFIED_UPSTREAM_FILES: list(s.modified, (f) => `- \`${f}\``),
    DELETED_UPSTREAM_FILES: list(s.deleted, (f) => `- \`${f}\``),
    ADDED_PATHS: list(s.added, (a) => (a.dir.endsWith('/') ? `- \`${a.dir}\` (${a.count} files)` : `- \`${a.dir}\``)),
    FORK_ONLY_COUNT: String(s.forkOnly),
  };
}

/**
 * Check a zip: one top-level folder, the allow-list inside it, nothing forbidden, no duplicate entry
 * (readZip throws on a repeated name; checkPackageEntries reports names that differ only in case),
 * SHA256SUMS right.
 */
export function verifyZipBuffer(zipBuf, expectedName) {
  const problems = [];
  const entries = readZip(zipBuf);
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  if (tops.size !== 1) problems.push(`expected one top-level folder, found ${[...tops].join(', ')}`);
  const top = [...tops][0] ?? '';
  if (expectedName && top !== expectedName) problems.push(`top-level folder is ${top}, expected ${expectedName}`);
  const inner = [];
  const hashes = new Map();
  let sums = null;
  for (const e of entries) {
    const rel = e.name.slice(top.length + 1);
    if (!rel) continue; // the folder entry itself
    inner.push({ path: rel.replace(/\/$/, ''), isDir: e.isDir, head: e.data.subarray(0, 64) });
    if (e.isDir) continue;
    if (rel === 'SHA256SUMS') sums = e.data.toString('utf8');
    else hashes.set(rel, sha256Hex(e.data));
  }
  problems.push(...checkPackageEntries(inner));
  if (sums === null) problems.push('SHA256SUMS missing');
  else problems.push(...verifySha256Sums(sums, hashes));
  return { problems, files: inner.filter((e) => !e.isDir).map((e) => e.path) };
}

function readInputs(dir) {
  const need = (rel) => {
    const f = path.join(dir, rel);
    if (!fs.existsSync(f)) fail(`build: input missing: ${rel}`);
    return fs.readFileSync(f);
  };
  const info = JSON.parse(need('build-info.json').toString('utf8'));
  if (!ORT_DLL_RE.test(info.ortDll ?? '')) fail(`build: build-info.json has no valid ortDll (${info.ortDll})`);
  if (info.controlApi !== true) fail('build: the build was not made with the control API option on');
  if (info.ara?.linked) out(`note: the ARA SDK is linked (${info.ara.reasons.join('; ')}); THIRD-PARTY-NOTICES.txt includes it`);
  return {
    info,
    files: {
      'OpenTune.exe': need('app/OpenTune.exe'),
      [info.ortDll]: need(`app/${info.ortDll}`),
      'DirectML.dll': need('app/DirectML.dll'),
      'DirectML-LICENSE.txt': need('licenses/DirectML-LICENSE.txt'),
      'THIRD-PARTY-NOTICES.txt': need('THIRD-PARTY-NOTICES.txt'),
    },
  };
}

function formatCommands(commands) {
  if (!Array.isArray(commands) || !commands.length) return '(not recorded)';
  return commands.map((c) => `# ${c.step}\n${(c.argv ?? []).map(String).map(quoteArg).join(' ')}`).join('\n\n');
}

function cmdBuild(o) {
  for (const k of ['inputs', 'out', 'label', 'commit', 'date', 'repository', 'name-status', 'upstream-tag', 'upstream-commit']) if (!o[k]) fail(`build: --${k} is required`);
  const top = repoTop(process.cwd());
  const release = path.join(top, '.github', 'release');
  const cfg = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(top, '.github', 'scripts', 'deps.lock.json'), 'utf8'));
  const version = readCmakeProjectVersion(fs.readFileSync(path.join(top, 'CMakeLists.txt'), 'utf8'));
  const protocolMajor = readProtocolMajor(fs.readFileSync(path.join(top, 'Source', 'Control', 'ControlProtocol.h'), 'utf8'));
  const tag = o.tag ?? '';
  const mode = tag ? 'release' : 'rehearsal';
  if (tag) {
    const p = parseTestTag(tag);
    if (!p || p.version !== version || p.label !== o.label) fail(`build: tag ${tag} does not match version ${version} and label ${o.label}`);
  } else if (o.label !== `rehearsal-${o.commit.slice(0, 7)}`) fail(`build: a rehearsal needs --label rehearsal-${o.commit.slice(0, 7)}`);
  const name = packageName({ version, label: o.label });
  const { info, files } = readInputs(path.resolve(o.inputs));

  for (const b of info.blockers ?? []) out(`${mode === 'release' ? '::error' : '::warning'} title=release blocker::${b.why}`);
  if (mode === 'release' && (info.blockers ?? []).length) fail(`build: ${info.blockers.length} release blocker(s); a tagged release cannot be packaged until they are resolved`);

  const server = (o['server-url'] ?? 'https://github.com').replace(/\/+$/, '');
  const forkUrl = `${server}/${o.repository}`;
  const date = new Date(o.date);
  if (Number.isNaN(date.getTime())) fail(`build: --date ${o.date} is not a date`);
  const day = date.toISOString().slice(0, 10);
  const ref = tag || o.commit;
  const d3d12Core = info.d3d12.files.find((f) => f.name === 'D3D12Core.dll');
  const mirror = lock.mirror?.baseUrl ? lock.mirror.baseUrl.replace('/releases/download/', '/releases/tag/') : '(none)';
  const vars = {
    APP_VERSION: version,
    BUILD_LABEL: o.label,
    PACKAGE_NAME: name,
    TAG: tag || '(none: rehearsal build)',
    COMMIT: o.commit,
    DATE: day,
    FORK_REPO_URL: forkUrl,
    SOURCE_URL: `${forkUrl}/tree/${ref}`,
    SOURCE_ARCHIVE_URL: tag ? `${forkUrl}/archive/refs/tags/${tag}.zip` : `${forkUrl}/archive/${o.commit}.zip`,
    DEPS_MIRROR_URL: mirror,
    OFFICIAL_REPO_URL: `${server}/${cfg.officialRepository}`,
    OFFICIAL_RELEASES_URL: `${server}/${cfg.officialRepository}/releases`,
    ISSUES_URL: cfg.issuesUrl,
    MCP_REPO_URL: `${server}/${cfg.mcpRepository}`,
    MIN_OFFICIAL_VERSION: cfg.minOfficialVersion,
    D3D12_AGILITY_VERSION: info.d3d12.agilityVersion,
    D3D12CORE_SHA256: d3d12Core?.sha256 ?? fail('build: build-info.json has no D3D12Core.dll hash'),
    ORT_DLL: info.ortDll,
    UPSTREAM_BASE_TAG: o['upstream-tag'],
    UPSTREAM_BASE_COMMIT: o['upstream-commit'],
    RUN_URL: o['run-url'] ?? '(local run)',
    SMOKE_STATUS: o.smoke ?? 'not run',
    ...modificationVars(fs.readFileSync(o['name-status'], 'utf8')),
  };

  // Assemble the package in memory.
  const pkg = new Map(Object.entries(files));
  pkg.set('LICENSE.txt', fs.readFileSync(path.join(top, 'LICENSE')));
  for (const t of TEMPLATE_FILES) {
    const text = renderTemplate(fs.readFileSync(path.join(release, 'templates', t), 'utf8'), vars);
    pkg.set(t, Buffer.from(/\.(cmd|txt)$/i.test(t) ? toCrlf(text) : text, 'utf8'));
  }
  const control = buildControlJson({
    protocolMajor,
    appVersion: version,
    commit: o.commit,
    tag,
    label: o.label,
    date: day,
    sourceUrl: vars.SOURCE_URL,
    officialRepositoryUrl: vars.OFFICIAL_REPO_URL,
    d3d12: info.d3d12,
  });
  const controlBuf = Buffer.from(`${JSON.stringify(control, null, 2)}\n`, 'utf8');
  const cj = validateControlJson(controlBuf);
  if (cj.length) fail(`build: opentune-control.json: ${cj.join('; ')}`);
  pkg.set('opentune-control.json', controlBuf);
  const hashes = new Map([...pkg].map(([n, b]) => [n, sha256Hex(b)]));
  pkg.set('SHA256SUMS', Buffer.from(formatSha256Sums(hashes), 'utf8'));

  // Text files of the package must not carry AI attribution either.
  const patterns = loadPatterns();
  const textViolations = [];
  for (const [n, b] of pkg) {
    if (!/\.(txt|md|cmd|json)$/i.test(n) || n === 'THIRD-PARTY-NOTICES.txt') continue;
    textViolations.push(...checkText(b.toString('utf8'), { patterns, source: n }).violations);
  }
  if (textViolations.length) fail(`build: attribution check failed:\n${formatViolations(textViolations)}`);

  const problems = [
    ...checkPackageEntries([...pkg].map(([n, b]) => ({ path: n, head: b.subarray(0, 64) }))),
    ...verifySha256Sums(pkg.get('SHA256SUMS').toString('utf8'), hashes),
  ];
  if (problems.length) fail(`build: package check failed:\n  ${problems.join('\n  ')}`);

  // Write the folder and the zip (deterministic: sorted names, the commit date as timestamp), then
  // check the zip as it will be published.
  const outDir = path.resolve(o.out);
  const folder = path.join(outDir, name);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const names = [...pkg.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const n of names) fs.writeFileSync(path.join(folder, n), pkg.get(n));
  const zipBuf = createZip([{ name: `${name}/` }, ...names.map((n) => ({ name: `${name}/${n}`, data: pkg.get(n) }))], { date });
  const zipName = `${name}.zip`;
  fs.writeFileSync(path.join(outDir, zipName), zipBuf);
  const zv = verifyZipBuffer(fs.readFileSync(path.join(outDir, zipName)), name);
  if (zv.problems.length) fail(`build: zip check failed:\n  ${zv.problems.join('\n  ')}`);
  const zipSha = sha256Hex(zipBuf);

  const manifest = {
    name,
    mode,
    tag: tag || null,
    commit: o.commit,
    zip: { name: zipName, size: zipBuf.length, sha256: zipSha },
    files: names.map((n) => ({ name: n, size: pkg.get(n).length, sha256: n === 'SHA256SUMS' ? sha256Hex(pkg.get(n)) : hashes.get(n) })),
    blockers: info.blockers ?? [],
    ara: info.ara ?? null,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const fileTable = ['| File | Size (bytes) | SHA-256 |', '|---|---:|---|', ...manifest.files.map((f) => `| \`${f.name}\` | ${f.size} | \`${f.sha256}\` |`)].join('\n');
  const body = renderTemplate(fs.readFileSync(path.join(release, 'templates', 'RELEASE-BODY.md'), 'utf8'), {
    ...vars,
    ZIP_NAME: zipName,
    ZIP_SIZE: String(zipBuf.length),
    ZIP_SHA256: zipSha,
    FILE_TABLE: fileTable,
    BUILD_COMMANDS: formatCommands([
      ...(info.commands ?? []),
      { step: 'package (on the build job artifact)', argv: ['node', '.github/scripts/release-package.mjs', 'build', '--inputs', '<artifact>', '--out', '<out>', '--label', o.label, ...(tag ? ['--tag', tag] : []), '--commit', o.commit, '--date', o.date, '--repository', o.repository, '--name-status', '<git diff --name-status --no-renames upstream-snapshot HEAD>', '--upstream-tag', o['upstream-tag'], '--upstream-commit', o['upstream-commit']] },
    ]),
  }, { stripLeadingComment: true });
  const bodyCheck = checkText(body, { patterns, source: 'release-body.md' });
  if (!bodyCheck.ok) fail(`build: release body attribution check failed:\n${formatViolations(bodyCheck.violations)}`);
  fs.writeFileSync(path.join(outDir, 'release-body.md'), body);

  const report = [`### 测试版产物：${zipName}（${mode === 'release' ? '正式出包' : '演练'}）`, '', `zip sha256 \`${zipSha}\`，${zipBuf.length} 字节；白名单 ${PACKAGE_FILES.length} 项完全一致，SHA256SUMS 已复核，不含模型、LFS 指针与 D3D12 文件。`, '', fileTable];
  if ((info.blockers ?? []).length) report.push('', `> [!WARNING]`, `> 发布阻断项 ${info.blockers.length} 个（正式出包会失败）：`, ...info.blockers.map((b) => `> - ${b.id}：${b.why}`));
  summary(report.join('\n'));
  out(report.join('\n'));
}


function cmdVerify(o) {
  if (!o.zip) fail('verify: --zip is required');
  const r = verifyZipBuffer(fs.readFileSync(o.zip), o.name);
  if (r.problems.length) fail(`verify: ${o.zip}:\n  ${r.problems.join('\n  ')}`);
  out(`verify: ${path.basename(o.zip)} OK (${r.files.length} files, sha256 ${sha256Hex(fs.readFileSync(o.zip))})`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let o;
  try {
    ({ opts: o } = parseArgs(rest, {
      event: 'string', tag: 'string', checks: 'string', 'dev-ref': 'string', sha: 'string', 'github-output': 'string',
      inputs: 'string', out: 'string', label: 'string', commit: 'string', date: 'string', repository: 'string',
      'name-status': 'string', 'upstream-tag': 'string', 'upstream-commit': 'string', 'server-url': 'string',
      'run-url': 'string', smoke: 'string', zip: 'string', name: 'string',
    }));
  } catch (e) {
    process.stderr.write(`release-package: ${e.message}\n`);
    return 2;
  }
  try {
    if (cmd === 'validate') cmdValidate(o);
    else if (cmd === 'build') cmdBuild(o);
    else if (cmd === 'verify') cmdVerify(o);
    else {
      process.stderr.write('usage: release-package.mjs validate|build|verify [options] (see the header of this file)\n');
      return 2;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`release-package: ${e.message}\n`);
    return e.exitCode ?? 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
