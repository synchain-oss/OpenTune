#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fork-checks: the machine checks for "our delta" (see fork-delta.mjs). One implementation shared by
// the fork-gate workflow, branch-gate (identity / attribution part) and the local gates.
// Every check reports PASS / FAIL / SKIP with a reason; the process exits 1 when any check FAILs.
//
// CLI:
//   node fork-checks.mjs [options]
//     --layer <L0|L2..L8>    layer of the change (locally); in CI it is read from the PR body.
//                            Same-repository PRs of feature/** or sync/* into dev, and spec-sync/*
//                            PRs, carry several layers: without --layer their layer check is SKIP
//     --pr                   CI pull request: read PR_TITLE / PR_BODY from the environment
//                            (untrusted text: only matched against fixed patterns, never executed)
//     --base <ref>           base branch of the PR (layer and spec checks look at this range only);
//                            locally defaults to origin/feature/control-api when it exists; with --ci
//                            and no --base (push to dev) those two checks are SKIP
//     --head <rev>           default HEAD
//     --head-branch <name>   branch name of the change (default: current branch)
//     --mirror <ref>         upstream mirror ref (default origin/upstream-mirror, then upstream-mirror)
//     --external             PR from another repository: its own commits (needs --base) only need a
//                            sign-off by their author; the rest of the delta keeps the allow-list
//     --index                check the staged state instead of <head> (path checks only)
//     --only <id,...>        run only these checks
//     --clang-format <path>  clang-format 18.1.8 binary (or env CLANG_FORMAT)
//     --require-tools        a missing tool is FAIL instead of SKIP (CI)
//     --max-commits N        delta size limit (default 150)
//     --json | --ci          machine output | GitHub annotations + job summary
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { computeDelta, computePrRange } from './fork-delta.mjs';
import {
  ALLOWED_ACTIONS,
  ALLOWED_ACTION_OWNERS,
  ALLOWED_AUTHOR_EMAILS,
  ALLOWED_COMMITTER_EMAILS,
  CLANG_FORMAT_EXCLUDE,
  CLANG_FORMAT_PATTERNS,
  CLANG_FORMAT_STYLE_PATH,
  CLANG_FORMAT_VERSION,
  CPP_EXTENSIONS,
  DEFERRED_LAYERS,
  FORBIDDEN_UPSTREAM_WORDS,
  GUARDED_PATTERNS,
  IGNORED_ALLOWLIST,
  LAYERS,
  LOCAL_IDENTITY_EMAIL,
  SCRIPTS_DIR,
  SPEC_COPY_PATTERNS,
  SPEC_PATTERNS,
  classifyPath,
  currentBranch,
  eolStyle,
  findSignoffs,
  formatMarkdown,
  git,
  hasBom,
  isBinary,
  isMainModule,
  listTreeFiles,
  makeTempDir,
  matchesAny,
  overallStatus,
  parseArgs,
  readBlobs,
  removeDir,
  reportToGitHub,
  result,
  sha256Hex,
  short,
  tryResolveCommit,
} from './fork-lib.mjs';

export const DEFAULT_BASE_REF = 'origin/feature/control-api';

// ---------------------------------------------------------------------------------------------
// Attribution rules: verified verbatim copies of the maintainer's canonical files
// ---------------------------------------------------------------------------------------------

/** The two verbatim copies (in .github/scripts/) whose sha256 is recorded in attribution.sha256. */
export const VERBATIM_COPIES = ['check-attribution.mjs', 'attribution-patterns.txt'];

/** Parse a sha256sum-style file: Map fileName -> hex. */
export function parseSha256File(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m) map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

/**
 * Verify check-attribution.mjs and attribution-patterns.txt against attribution.sha256, then load the
 * checker. Returns { ok, problems, checkText?, patterns? }.
 */
export async function loadAttribution(dir = SCRIPTS_DIR) {
  const problems = [];
  const lockFile = path.join(dir, 'attribution.sha256');
  if (!fs.existsSync(lockFile)) return { ok: false, problems: ['缺少 attribution.sha256'] };
  const expected = parseSha256File(fs.readFileSync(lockFile, 'utf8'));
  for (const name of VERBATIM_COPIES) {
    const want = expected.get(name);
    const file = path.join(dir, name);
    if (!want) problems.push(`attribution.sha256 未记录 ${name}`);
    else if (!fs.existsSync(file)) problems.push(`缺少 ${name}`);
    else {
      const got = sha256Hex(fs.readFileSync(file));
      if (got !== want) problems.push(`${name} 与维护者正本不一致（sha256 ${got.slice(0, 12)}…，应为 ${want.slice(0, 12)}…）`);
    }
  }
  if (problems.length) return { ok: false, problems };
  const mod = await import(pathToFileURL(path.join(dir, 'check-attribution.mjs')).href);
  const patterns = mod.loadPatterns(path.join(dir, 'attribution-patterns.txt'));
  return { ok: true, problems, checkText: mod.checkText, patterns };
}

// ---------------------------------------------------------------------------------------------
// Commit checks (shared with branch-gate)
// ---------------------------------------------------------------------------------------------

/**
 * DCO and identity of every commit.
 * external: a pull request from another repository. Its own commits only need a sign-off by their
 * author (standard DCO); `externalShas` names them (all commits when omitted, as in branch-gate,
 * which only lists the PR's commits). Every other commit, e.g. the fork's own history that the
 * cumulative delta also contains, keeps the identity allow-list.
 */
export function checkCommitIdentities(commits, { external = false, externalShas = null } = {}) {
  const problems = [];
  const authors = new Set(ALLOWED_AUTHOR_EMAILS);
  const committers = new Set(ALLOWED_COMMITTER_EMAILS);
  for (const c of commits) {
    const id = `${short(c.sha)} ${c.message.split('\n')[0].slice(0, 60)}`;
    const signoffs = findSignoffs(c.message);
    if (external && (!externalShas || externalShas.has(c.sha))) {
      if (!signoffs.length) problems.push(`${id}：缺少 Signed-off-by（git commit -s）`);
      else if (!signoffs.some((s) => s.email === c.authorEmail)) problems.push(`${id}：Signed-off-by 与作者 <${c.authorEmail}> 不一致`);
      continue;
    }
    if (!authors.has(c.authorEmail)) problems.push(`${id}：作者 <${c.authorEmail}> 不在允许的身份内`);
    if (!committers.has(c.committerEmail)) problems.push(`${id}：提交者 <${c.committerEmail}> 不在允许的身份内`);
    if (!signoffs.length) problems.push(`${id}：缺少 Signed-off-by（git commit -s）`);
    else if (!signoffs.some((s) => authors.has(s.email))) {
      problems.push(`${id}：Signed-off-by <${signoffs.map((s) => s.email).join(', ')}> 不是允许的身份`);
    } else if (c.authorEmail === LOCAL_IDENTITY_EMAIL && !signoffs.some((s) => s.email === LOCAL_IDENTITY_EMAIL)) {
      problems.push(`${id}：本地提交的 Signed-off-by 必须与作者同一身份 <${LOCAL_IDENTITY_EMAIL}>`);
    }
  }
  return problems;
}

/** Attribution check over commit messages and (CI) PR title/body. */
export function checkAttributionTexts(attr, commits, pr) {
  const problems = [];
  const fmt = (v) => `${v.line ? `第 ${v.line} 行 ` : ''}[${v.rule}] ${v.text}`;
  for (const c of commits) {
    for (const v of attr.checkText(c.message, { patterns: attr.patterns }).violations) problems.push(`提交 ${short(c.sha)}：${fmt(v)}`);
  }
  if (pr) {
    for (const [label, text] of [['PR 标题', pr.title], ['PR 正文', pr.body]]) {
      for (const v of attr.checkText(text ?? '', { patterns: attr.patterns }).violations) problems.push(`${label}：${fmt(v)}`);
    }
  }
  return problems;
}

/**
 * Heading of the layer section in the PR template ("## 层（单选；…）"): the heading text must start
 * with 层 followed by a bracket, a space or the end of the line, so headings such as "层次说明" or
 * "分层设计" elsewhere in the body are not taken for it.
 */
export const LAYER_HEADING = /^#{1,6}\s*层(?:[（(]|\s|$)/;

/**
 * Layer from the PR body: the checked box in the "层" section (`- [x] L0 ...`), i.e. between the first
 * LAYER_HEADING and the next heading. HTML comments are ignored; the rest of the body is never
 * scanned. Returns { layer } or { error }.
 */
export function parseLayerFromBody(body) {
  const text = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => LAYER_HEADING.test(l));
  if (start < 0) return { error: 'PR 正文缺少「层」小节（模板中的「## 层（单选；…）」标题）' };
  const next = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  const end = next > 0 ? next : lines.length;
  const checked = [];
  for (const line of lines.slice(start + 1, end)) {
    const m = /^\s*[-*+]\s*\[([xX])\]\s*(L\d+)\b/.exec(line);
    if (m) checked.push(m[2].toUpperCase());
  }
  if (!checked.length) return { error: 'PR 正文的「层」小节未勾选' };
  if (checked.length > 1) return { error: `PR 正文勾选了多个层（${checked.join('、')}），只能单选` };
  return { layer: checked[0] };
}

/** Branch name of a base ref such as origin/dev or refs/remotes/origin/dev. */
export function branchOfRef(ref) {
  return String(ref ?? '').replace(/^refs\/(?:remotes\/origin|heads)\//, '').replace(/^origin\//, '');
}

/**
 * Same-repository PRs that are not one card and so have no single layer: the main line or a sync
 * candidate into dev (they carry every merged card, L0 and upstreamable alike), and spec-sync PRs
 * (the spec copy is upstreamable, .github/spec.lock is L0). The layer choice is skipped for them;
 * the cumulative scope check still limits what they may touch.
 */
export function isMultiLayerPr({ baseBranch, headBranch, external }) {
  if (external || !headBranch) return false;
  if (matchesAny(headBranch, ['spec-sync/*'])) return true;
  return baseBranch === 'dev' && matchesAny(headBranch, ['feature/**', 'sync/*']);
}

// ---------------------------------------------------------------------------------------------
// Workflow YAML helpers (no YAML library: line-based, comment-aware)
// ---------------------------------------------------------------------------------------------

/** Remove a YAML comment from one line, respecting quotes. */
export function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Text of the top-level `on:` mapping (inline value plus the indented block), comments removed. */
export function workflowTriggerBlock(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:on|"on"|'on'|true)\s*:(.*)$/.exec(lines[i]);
    if (!m) continue;
    out.push(stripYamlComment(m[1]));
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\S/.test(l) && !/^#/.test(l)) break;
      out.push(stripYamlComment(l));
    }
  }
  return out.join('\n');
}

/** Lines of a workflow outside block scalars (`key: |` / `key: >`), comments removed, with line numbers. */
export function workflowCodeLines(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = raw.length - raw.trimStart().length;
    if (blockIndent >= 0) {
      if (raw.trim() === '' || indent > blockIndent) continue;
      blockIndent = -1;
    }
    const code = stripYamlComment(raw);
    out.push({ n: i + 1, code, raw });
    if (/:\s*[|>][-+0-9]*\s*$/.test(code)) blockIndent = indent;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const SPDX_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.inl', '.ipp', '.m', '.mm',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.py', '.ps1', '.psm1', '.psd1', '.sh', '.bash',
  '.cmd', '.bat', '.cmake', '.yml', '.yaml', '.toml', '.md',
]);
const SPDX_NAMES = new Set(['CMakeLists.txt', 'CODEOWNERS', '.clang-format', '.clang-tidy', '.gitattributes', '.gitignore', '.editorconfig', 'Dockerfile', 'Makefile']);

export function needsSpdx(file) {
  const base = path.posix.basename(file);
  return SPDX_NAMES.has(base) || SPDX_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

/** null when the header is fine, otherwise the reason. */
export function spdxProblem(file, buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (path.posix.extname(file).toLowerCase() === '.md') {
    const trimmed = text.replace(/^\s+/, '');
    if (!trimmed.startsWith('<!--')) return 'Markdown 首部应为含 SPDX-License-Identifier 的 HTML 注释';
    const end = trimmed.indexOf('-->');
    const comment = end >= 0 ? trimmed.slice(0, end) : '';
    return /SPDX-License-Identifier:\s*\S/.test(comment) ? null : '首部 HTML 注释里缺少 SPDX-License-Identifier';
  }
  const head = text.split(/\r?\n/).slice(0, 10).join('\n');
  return /SPDX-License-Identifier:\s*\S/.test(head) ? null : '前 10 行内缺少 SPDX-License-Identifier';
}

function addedLinesOf(top, base, headSpec, file) {
  const args = headSpec
    ? ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base, headSpec, '--', file]
    : ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base, '--', file];
  const out = git(args, { cwd: top });
  const added = [];
  let inHunk = false;
  let lineNo = 0;
  for (const line of out.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      inHunk = true;
      lineNo = Number(h[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      added.push({ n: lineNo, text: line.slice(1) });
      lineNo++;
    } else if (line.startsWith(' ')) lineNo++;
  }
  return added;
}

function resolveClangFormat(opts) {
  const fromOpt = opts.clangFormat ?? (process.env.CLANG_FORMAT ? [process.env.CLANG_FORMAT] : null);
  const cmd = Array.isArray(fromOpt) ? fromOpt : fromOpt ? [fromOpt] : ['clang-format'];
  const r = spawnSync(cmd[0], [...cmd.slice(1), '--version'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return { cmd, error: `未找到 clang-format（${cmd[0]}）` };
  const version = /clang-format version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown';
  if (version !== CLANG_FORMAT_VERSION) return { cmd, error: `clang-format 版本是 ${version}，需要 ${CLANG_FORMAT_VERSION}` };
  return { cmd, version };
}

/**
 * Run the checks. Returns { meta, results }.
 * @param {object} opts see the CLI options; pr = {title, body} when running for a pull request.
 */
export async function runChecks(opts = {}) {
  const only = opts.only?.length ? new Set(opts.only) : null;
  const want = (id) => !only || only.has(id);
  const results = [];
  const add = (r) => {
    if (want(r.id)) results.push(r);
  };

  const delta = computeDelta({ cwd: opts.cwd, head: opts.head, mirror: opts.mirror, maxCommits: opts.maxCommits, index: opts.index });
  const top = delta.top;
  const headBranch = opts.headBranch ?? currentBranch(top);
  const meta = { head: delta.head ?? null, base: delta.base ?? null, headBranch, index: Boolean(opts.index) };

  add(delta.ok
    ? result('delta', '增量识别', 'PASS', `${delta.commits.length} 个提交、${delta.files.length} 个文件；上游基点 ${short(delta.base)}（${delta.tags.map((t) => t.name).join('、')}）`)
    : result('delta', '增量识别', 'FAIL', delta.error));

  const deltaIds = ['dco-identity', 'attribution', 'path-guard', 'ignored-paths', 'scope', 'spdx', 'whitespace', 'clang-format', 'upstream-words'];
  const prIds = ['layer', 'spec-copy'];

  // The PR range (merge-base(head, base)..head) is the change set of this pull request. The default
  // base is a local convenience only: in CI a run without --base (push to dev) has no PR range.
  let rangeMemo;
  const prRange = () => {
    if (rangeMemo !== undefined) return rangeMemo;
    let baseRef = opts.base;
    let note = '';
    if (!baseRef && !opts.index && opts.defaultBase !== false && tryResolveCommit(top, DEFAULT_BASE_REF)) {
      baseRef = DEFAULT_BASE_REF;
      note = '（默认）';
    }
    rangeMemo = baseRef && !opts.index ? { note, ...computePrRange({ cwd: top, head: delta.head ?? opts.head, baseRef }), baseRef } : null;
    return rangeMemo;
  };

  // --- attribution copy (independent of the delta)
  let attr = null;
  if (want('attribution-copy') || want('attribution')) {
    attr = await loadAttribution(opts.attributionDir ?? SCRIPTS_DIR);
    add(attr.ok
      ? result('attribution-copy', '署名规则副本', 'PASS', 'check-attribution.mjs 与 attribution-patterns.txt 的 sha256 与记录一致')
      : result('attribution-copy', '署名规则副本', 'FAIL', '署名规则副本校验失败', attr.problems));
  }

  if (!delta.ok) {
    for (const id of deltaIds) add(result(id, titleOf(id), 'SKIP', '增量不可用（见 delta）'));
  } else {
    const headSpec = opts.index ? '' : delta.head;
    const blobAt = (rev, file) => `${rev}:${file}`;
    const present = delta.files.filter((f) => f.status !== 'D');
    const added = delta.files.filter((f) => f.status === 'A');
    const modified = delta.files.filter((f) => f.status === 'M' || f.status === 'T');
    const external = Boolean(opts.external);

    // --- DCO and identity
    if (want('dco-identity')) {
      if (opts.index) add(result('dco-identity', titleOf('dco-identity'), 'SKIP', '暂存检查不涉及提交'));
      else {
        // An external PR relaxes the identity rule for its own commits only; the rest of the
        // cumulative delta (the fork's history, including GitHub web merges) keeps the allow-list.
        let externalShas = null;
        const problems = [];
        if (external) {
          const range = prRange();
          externalShas = new Set(range?.ok ? range.commits.map((c) => c.sha) : []);
          if (!range?.ok) problems.push(`外部 PR 需要可用的 PR 范围（--base）来区分 PR 自己的提交：${range ? range.error : '未给 --base'}`);
        }
        problems.push(...checkCommitIdentities(delta.commits, { external, externalShas }));
        const own = externalShas ? delta.commits.filter((c) => externalShas.has(c.sha)).length : 0;
        add(problems.length
          ? result('dco-identity', titleOf('dco-identity'), 'FAIL', `${problems.length} 处 DCO/身份问题`, problems)
          : result('dco-identity', titleOf('dco-identity'), 'PASS', external
            ? `外部 PR 的 ${own} 个提交都有与作者一致的 Signed-off-by；其余 ${delta.commits.length - own} 个增量提交的作者、提交者与 Signed-off-by 均为允许的身份`
            : `${delta.commits.length} 个提交的作者、提交者与 Signed-off-by 均为允许的身份`));
      }
    }

    // --- attribution
    if (want('attribution')) {
      if (!attr?.ok) add(result('attribution', titleOf('attribution'), 'FAIL', '署名规则副本未通过校验，无法检查'));
      else if (opts.index) add(result('attribution', titleOf('attribution'), 'SKIP', '暂存检查不涉及提交'));
      else {
        const problems = checkAttributionTexts(attr, delta.commits, opts.pr);
        const scope = `${delta.commits.length} 条提交信息${opts.pr ? '与 PR 标题、正文' : ''}`;
        add(problems.length
          ? result('attribution', titleOf('attribution'), 'FAIL', `${scope}中有 AI 署名`, problems)
          : result('attribution', titleOf('attribution'), 'PASS', `${scope}无 AI 署名`));
      }
    }

    // --- path guard
    if (want('path-guard')) {
      const problems = [];
      const seen = new Set();
      const guard = (file, where) => {
        if (matchesAny(file, GUARDED_PATTERNS, { nocase: true }) && !seen.has(`${file}|${where}`)) {
          seen.add(`${file}|${where}`);
          problems.push(`${where}：${file}`);
        }
      };
      for (const f of delta.files) guard(f.path, `${statusWord(f.status)}（相对上游基点）`);
      for (const [sha, files] of delta.historyPaths) for (const f of files) guard(f.path, `提交 ${short(sha)} ${statusWord(f.status)}`);
      // lfs: true anywhere in a workflow
      const wfFiles = listTreeFiles(top, opts.index ? null : delta.head, '.github/workflows').filter((f) => /\.ya?ml$/i.test(f));
      const wfBlobs = readBlobs(top, wfFiles.map((f) => blobAt(headSpec, f)));
      for (const f of wfFiles) {
        const buf = wfBlobs.get(blobAt(headSpec, f));
        if (!buf) continue;
        for (const { n, code } of workflowCodeLines(buf.toString('utf8'))) {
          const m = /(?:^|[\s{,])lfs\s*:\s*([^,}\s]+)/.exec(code);
          if (m && m[1].replace(/^['"]|['"]$/g, '').toLowerCase() !== 'false') problems.push(`${f}:${n}：checkout 必须 lfs: false（现为 ${m[1]}）`);
        }
      }
      add(problems.length
        ? result('path-guard', titleOf('path-guard'), 'FAIL', '增量触碰了受保护路径或 workflow 开启了 LFS', problems)
        : result('path-guard', titleOf('path-guard'), 'PASS', `未触碰 models/、*.onnx、pc_nsf_hifigan*/、ThirdParty/、D3D12 运行库；${wfFiles.length} 个 workflow 均未开启 LFS`));
    }

    // --- ignored paths
    if (want('ignored-paths')) {
      const ignored = upstreamIgnored(top, delta.base, present.map((f) => f.path));
      const problems = [];
      for (const [file, pattern] of ignored) {
        if (!matchesAny(file, IGNORED_ALLOWLIST)) problems.push(`${file}（上游 .gitignore 规则 ${pattern}）`);
      }
      add(problems.length
        ? result('ignored-paths', titleOf('ignored-paths'), 'FAIL', '增量含有被上游 .gitignore 忽略、且不在允许清单内的文件', problems)
        : result('ignored-paths', titleOf('ignored-paths'), 'PASS', `${ignored.size} 个被上游忽略的文件均在允许清单内（.github/**、CLAUDE.md、docs/control-api*.md）`));
    }

    // --- scope: the cumulative delta only touches L0 paths and the upstreamable allow-list
    if (want('scope')) {
      const problems = delta.files.filter((f) => classifyPath(f.path) === 'other').map((f) => `${statusWord(f.status)}：${f.path}`);
      add(problems.length
        ? result('scope', titleOf('scope'), 'FAIL', '增量改动了钩子表与白名单之外的路径', problems)
        : result('scope', titleOf('scope'), 'PASS', '增量只涉及 L0 路径与可上游路径白名单'));
    }

    const presentBlobs = readBlobs(top, present.map((f) => blobAt(headSpec, f.path)));
    const headBlob = (file) => presentBlobs.get(blobAt(headSpec, file)) ?? null;

    // --- SPDX on new files
    if (want('spdx')) {
      const copies = verbatimCopies(top, headSpec);
      const problems = [];
      let checked = 0;
      for (const f of added) {
        if (!needsSpdx(f.path) || matchesAny(f.path, SPEC_COPY_PATTERNS) || copies.has(f.path)) continue;
        const buf = headBlob(f.path);
        if (!buf || isBinary(buf)) continue;
        checked++;
        const why = spdxProblem(f.path, buf);
        if (why) problems.push(`${f.path}：${why}`);
      }
      add(problems.length
        ? result('spdx', titleOf('spdx'), 'FAIL', `${problems.length} 个新文件缺少 SPDX 头`, problems)
        : result('spdx', titleOf('spdx'), 'PASS', `${checked} 个新增源码/脚本/workflow/文档文件都有 SPDX 头${copies.size ? `（逐字节副本 ${copies.size} 个豁免）` : ''}`));
    }

    // --- whitespace, EOL style and BOM of modified upstream files
    if (want('whitespace')) {
      const problems = [];
      const baseBlobs = readBlobs(top, modified.map((f) => blobAt(delta.base, f.path)));
      let checked = 0;
      for (const f of modified) {
        const before = baseBlobs.get(blobAt(delta.base, f.path));
        const after = headBlob(f.path);
        if (!before || !after || isBinary(before) || isBinary(after)) continue;
        checked++;
        if (hasBom(before) !== hasBom(after)) problems.push(`${f.path}：${hasBom(before) ? '删除了' : '添加了'} UTF-8 BOM`);
        const eb = eolStyle(before);
        const ea = eolStyle(after);
        if ((eb === 'lf' || eb === 'crlf') && ea !== eb && ea !== 'none') problems.push(`${f.path}：换行符从 ${eb} 变成了 ${ea}`);
        const tabIndented = /^\t/m.test(before.toString('utf8'));
        for (const { n, text } of addedLinesOf(top, delta.base, opts.index ? null : delta.head, f.path)) {
          const line = text.replace(/\r$/, '');
          if (/[ \t]+$/.test(line)) problems.push(`${f.path}:${n}：新增行有行尾空白`);
          const indent = /^[ \t]*/.exec(line)[0];
          if (indent.includes(' ') && indent.includes('\t')) problems.push(`${f.path}:${n}：新增行缩进混用制表符与空格`);
          else if (indent.includes('\t') && !tabIndented) problems.push(`${f.path}:${n}：新增行用制表符缩进，原文件用空格`);
        }
      }
      add(problems.length
        ? result('whitespace', titleOf('whitespace'), 'FAIL', '上游文件的改动带入了空白、换行符或 BOM 变化', problems)
        : result('whitespace', titleOf('whitespace'), 'PASS', checked ? `${checked} 个被修改的上游文件：新增行无行尾空白/混合缩进，换行符与 BOM 未变` : '没有被修改的上游文件'));
    }

    // --- clang-format 18.1.8 on our C++ files
    if (want('clang-format')) {
      const candidates = present.filter((f) => matchesAny(f.path, CLANG_FORMAT_PATTERNS) && !matchesAny(f.path, CLANG_FORMAT_EXCLUDE)
        && CPP_EXTENSIONS.includes(path.posix.extname(f.path).toLowerCase()));
      if (!candidates.length) add(result('clang-format', titleOf('clang-format'), 'PASS', '增量中没有需要检查的 C++ 文件'));
      else add(clangFormatCheck(top, headSpec, candidates.map((f) => f.path), headBlob, opts));
    }

    // --- forbidden words in upstreamable paths
    if (want('upstream-words')) {
      const problems = [];
      let checked = 0;
      for (const f of present) {
        if (classifyPath(f.path) !== 'upstreamable' || matchesAny(f.path, SPEC_COPY_PATTERNS)) continue;
        checked++;
        if (FORBIDDEN_UPSTREAM_WORDS.test(f.path)) problems.push(`${f.path}：路径含禁用字样`);
        if (f.status === 'A') {
          const buf = headBlob(f.path);
          if (!buf || isBinary(buf)) continue;
          buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
            const m = FORBIDDEN_UPSTREAM_WORDS.exec(line);
            if (m) problems.push(`${f.path}:${i + 1}：含「${m[0]}」`);
          });
        } else {
          for (const { n, text } of addedLinesOf(top, delta.base, opts.index ? null : delta.head, f.path)) {
            const m = FORBIDDEN_UPSTREAM_WORDS.exec(text);
            if (m) problems.push(`${f.path}:${n}：新增行含「${m[0]}」`);
          }
        }
      }
      add(problems.length
        ? result('upstream-words', titleOf('upstream-words'), 'FAIL', '可上游路径中出现了 fork 专用字样', problems)
        : result('upstream-words', titleOf('upstream-words'), 'PASS', checked ? `${checked} 个可上游路径文件无 Synchain/DLsnows/opentune-mcp 字样` : '增量未触碰可上游路径'));
    }
  }

  // --- PR range checks: layer and spec copy protection
  if (want('layer') || want('spec-copy')) {
    const range = prRange();
    if (!range) {
      for (const id of prIds) add(result(id, titleOf(id), 'SKIP', opts.index ? '暂存检查不涉及 PR 范围' : '没有 PR 范围（未给 --base，例如 push 到 dev）'));
    } else if (!range.ok) {
      for (const id of prIds) add(result(id, titleOf(id), 'FAIL', range.error));
    } else {
      const rangeNote = `${range.baseRef}${range.note}…HEAD 共 ${range.files.length} 个文件`;
      const multi = { baseBranch: branchOfRef(range.baseRef), headBranch, external: Boolean(opts.external) };
      if (want('layer')) add(layerCheck(opts, range.files, rangeNote, isMultiLayerPr(multi) ? multi : null));
      if (want('spec-copy')) add(specCheck(opts, multi, range.files, rangeNote, { top, head: opts.index ? null : delta.head ?? tryResolveCommit(top, opts.head ?? 'HEAD') }));
    }
  }

  // --- workflows: triggers and pinned actions (whole tree at head, not only the delta)
  if (want('workflow-triggers') || want('actions-pinned')) {
    const headRev = opts.index ? null : delta.head ?? tryResolveCommit(top, opts.head ?? 'HEAD');
    const spec = opts.index ? '' : headRev;
    const wfFiles = listTreeFiles(top, headRev, '.github/workflows').filter((f) => /\.ya?ml$/i.test(f));
    const actionFiles = listTreeFiles(top, headRev, '.github/actions').filter((f) => /(^|\/)action\.ya?ml$/i.test(f));
    const blobs = readBlobs(top, [...wfFiles, ...actionFiles].map((f) => `${spec}:${f}`));
    const triggerProblems = [];
    const pinProblems = [];
    let uses = 0;
    for (const f of [...wfFiles, ...actionFiles]) {
      const text = blobs.get(`${spec}:${f}`)?.toString('utf8');
      if (text == null) continue;
      if (wfFiles.includes(f) && /\bpull_request_target\b/.test(workflowTriggerBlock(text))) {
        triggerProblems.push(`${f}：on: 中出现 pull_request_target`);
      }
      for (const { n, code, raw } of workflowCodeLines(text)) {
        const m = /^\s*(?:-\s+)?uses\s*:\s*(\S+)/.exec(code);
        if (!m) continue;
        uses++;
        const why = actionRefProblem(m[1].replace(/^['"]|['"]$/g, ''), raw);
        if (why) pinProblems.push(`${f}:${n}：${why}`);
      }
    }
    add(triggerProblems.length
      ? result('workflow-triggers', titleOf('workflow-triggers'), 'FAIL', '有 workflow 使用 pull_request_target', triggerProblems)
      : result('workflow-triggers', titleOf('workflow-triggers'), 'PASS', `${wfFiles.length} 个 workflow 的触发器均不含 pull_request_target`));
    add(pinProblems.length
      ? result('actions-pinned', titleOf('actions-pinned'), 'FAIL', 'action 引用未固定到 40 位 SHA 或不在允许清单内', pinProblems)
      : result('actions-pinned', titleOf('actions-pinned'), 'PASS', `${uses} 处 uses: 均固定到 40 位 SHA 并注明版本`));
  }

  results.sort((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id));
  meta.layer = opts.layer ?? null;
  return { meta, results };
}

const TITLES = {
  delta: '增量识别',
  'attribution-copy': '署名规则副本',
  'dco-identity': 'DCO 与身份',
  attribution: '无 AI 署名',
  'path-guard': '路径守卫',
  'ignored-paths': '忽略路径越界',
  scope: '改动范围',
  layer: '层与可上游路径',
  'spec-copy': '规范副本保护',
  spdx: '新文件 SPDX',
  whitespace: '上游文件新增行空白',
  'clang-format': 'clang-format 18.1.8',
  'upstream-words': '可上游路径禁用字样',
  'workflow-triggers': 'pull_request_target 零命中',
  'actions-pinned': 'action 固定 SHA',
};

export const CHECK_IDS = Object.keys(TITLES);

function titleOf(id) {
  return TITLES[id] ?? id;
}

function statusWord(s) {
  return { A: '新增', M: '修改', D: '删除', T: '类型变化' }[s] ?? s;
}

/** Map path -> pattern for paths ignored by the upstream .gitignore at `base`. */
export function upstreamIgnored(top, base, files) {
  const ignored = new Map();
  if (!files.length) return ignored;
  const gi = readBlobs(top, [`${base}:.gitignore`]).get(`${base}:.gitignore`);
  if (!gi) return ignored;
  const dir = makeTempDir('ignore');
  try {
    git(['init', '-q', dir]);
    fs.writeFileSync(path.join(dir, '.gitignore'), gi);
    const empty = path.join(dir, '.git', 'ot-no-global-excludes');
    fs.writeFileSync(empty, '');
    git(['config', 'core.excludesFile', empty], { cwd: dir });
    const r = git(['check-ignore', '--no-index', '--stdin', '-z', '-v', '-n'], { cwd: dir, input: files.join('\0') + '\0', allowFail: true });
    if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${String(r.stderr).trim()}`);
    const toks = String(r.stdout).split('\0');
    for (let i = 0; i + 3 < toks.length; i += 4) {
      const [, , pattern, file] = toks.slice(i, i + 4);
      if (pattern && !pattern.startsWith('!')) ignored.set(file, pattern);
    }
  } finally {
    removeDir(dir);
  }
  return ignored;
}

/**
 * The verbatim copies of the maintainer's files (exempt from the SPDX header: the canonical files
 * have none). Only the fixed names in VERBATIM_COPIES count, and only when attribution.sha256
 * records them, since that record is what the attribution-copy check verifies.
 */
function verbatimCopies(top, headSpec) {
  const spec = `${headSpec}:.github/scripts/attribution.sha256`;
  const buf = readBlobs(top, [spec]).get(spec);
  if (!buf) return new Set();
  const recorded = parseSha256File(buf.toString('utf8'));
  return new Set(VERBATIM_COPIES.filter((n) => recorded.has(n)).map((n) => `.github/scripts/${n}`));
}

function clangFormatCheck(top, headSpec, files, headBlob, opts) {
  const id = 'clang-format';
  const tool = resolveClangFormat(opts);
  if (tool.error) {
    const status = opts.requireTools ? 'FAIL' : 'SKIP';
    return result(id, titleOf(id), status, `${tool.error}；${files.length} 个文件未检查`, files);
  }
  const styleSpec = `${headSpec}:${CLANG_FORMAT_STYLE_PATH}`;
  const style = readBlobs(top, [styleSpec]).get(styleSpec);
  if (!style) return result(id, titleOf(id), 'FAIL', `缺少 ${CLANG_FORMAT_STYLE_PATH}`);
  const dir = makeTempDir('clang-format');
  const problems = [];
  try {
    const styleFile = path.join(dir, '.clang-format');
    fs.writeFileSync(styleFile, style);
    for (const f of files) {
      const content = headBlob(f);
      if (!content) continue;
      const r = spawnSync(tool.cmd[0], [...tool.cmd.slice(1), `--style=file:${styleFile}`, `--assume-filename=${f}`], {
        input: content,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
      if (r.error || r.status !== 0) problems.push(`${f}：clang-format 运行失败 ${String(r.stderr ?? r.error).trim().slice(0, 200)}`);
      // The style file must be named explicitly: Tests/Control/** and ControlEditorBridge* are not
      // under Source/Control/, so a plain `clang-format -i` would fall back to the LLVM default.
      else if (!Buffer.from(r.stdout).equals(content)) problems.push(`${f}：格式与 ${CLANG_FORMAT_STYLE_PATH} 不一致（用 clang-format ${CLANG_FORMAT_VERSION} 运行 clang-format --style=file:${CLANG_FORMAT_STYLE_PATH} -i ${f} 后提交）`);
    }
  } finally {
    removeDir(dir);
  }
  return problems.length
    ? result(id, titleOf(id), 'FAIL', `${problems.length} 个文件格式不一致`, problems)
    : result(id, titleOf(id), 'PASS', `${files.length} 个文件与 clang-format ${tool.version} 输出一致`);
}

function layerCheck(opts, files, rangeNote, multi) {
  const id = 'layer';
  let layer = opts.layer?.toUpperCase();
  let source = '参数';
  if (!layer && multi) {
    return result(id, titleOf(id), 'SKIP', `集成或规范同步 PR（${multi.headBranch} → ${multi.baseBranch}）不属于单一层，不做层的单选；${rangeNote}，累计改动范围由 scope 检查把关`);
  }
  if (!layer && opts.pr) {
    const parsed = parseLayerFromBody(opts.pr.body);
    if (parsed.error) return result(id, titleOf(id), 'FAIL', parsed.error);
    layer = parsed.layer;
    source = 'PR 正文';
  }
  if (!layer) return result(id, titleOf(id), 'FAIL', '未指定层（本地用 --layer，CI 从 PR 正文勾选读取）');
  if (!LAYERS.includes(layer)) return result(id, titleOf(id), 'FAIL', `未知的层 ${layer}（可选 ${LAYERS.filter((l) => !DEFERRED_LAYERS.includes(l)).join('、')}）`);
  if (DEFERRED_LAYERS.includes(layer)) return result(id, titleOf(id), 'FAIL', `${layer} 属于推迟的范围，暂不接受`);
  const problems = [];
  for (const f of files) {
    const cls = classifyPath(f.path);
    if (layer === 'L0' && cls !== 'L0') problems.push(`L0 改动不得触碰${cls === 'upstreamable' ? '可上游路径' : '白名单之外的上游路径'}：${f.path}`);
    if (layer !== 'L0' && cls === 'other') problems.push(`白名单之外的上游路径：${f.path}`);
  }
  return problems.length
    ? result(id, titleOf(id), 'FAIL', `层 ${layer}（来自${source}）与改动路径不符`, problems)
    : result(id, titleOf(id), 'PASS', `层 ${layer}（来自${source}）；${rangeNote}均符合`);
}

/**
 * May this pull request change the spec copy and .github/spec.lock? Only spec-sync/* introduces spec
 * changes, into any base. The manager's integration PRs only carry spec changes that were already
 * merged through spec-sync/*: the main line (feature/**) or a sync candidate (sync/*) into dev, and
 * an upstream PR (upstream-pr/*) into its review base (review-base/*). The same branches into any
 * other base, every other branch (feat/* included) and any PR from another repository may not.
 */
export function mayChangeSpec({ headBranch, baseBranch, external }) {
  if (external || !headBranch) return false;
  if (matchesAny(headBranch, ['spec-sync/*'])) return true;
  if (matchesAny(headBranch, ['feature/**', 'sync/*'])) return baseBranch === 'dev';
  if (matchesAny(headBranch, ['upstream-pr/*'])) return Boolean(baseBranch) && matchesAny(baseBranch, ['review-base/*']);
  return false;
}

/**
 * Recompute what .github/spec.lock records about the spec copy and return the mismatches (empty = the
 * lock is consistent with the copy at `rev`). Read-only: sha256 per file from the blobs, the tree id from
 * `git rev-parse <rev>:<copy>` (the same id `git write-tree --prefix=<copy>/` would give), the file count
 * from `git ls-tree`. The sha256 follows lock.sha256Method: the sha256 of the `sha256sum` listing
 * ("<hex>  <relative path>" per line, each line ended by LF, paths sorted bytewise; the binary-mode
 * separator " *" is accepted too).
 */
export function verifySpecLock(top, rev) {
  const lockBlob = readBlobs(top, [`${rev}:.github/spec.lock`]).get(`${rev}:.github/spec.lock`);
  if (!lockBlob) return ['.github/spec.lock 不存在'];
  let lock;
  try {
    lock = JSON.parse(lockBlob.toString('utf8'));
  } catch (e) {
    return [`.github/spec.lock 不是合法的 JSON：${e.message}`];
  }
  const copy = typeof lock.copy === 'string' ? lock.copy.replace(/\/+$/, '') : '';
  if (!copy || copy.startsWith('/') || copy.split('/').includes('..')) return [`.github/spec.lock 的 copy 字段无效：${JSON.stringify(lock.copy)}`];
  const paths = listTreeFiles(top, rev, copy);
  const problems = [];
  if (!paths.length) return [`规范副本目录 ${copy} 在 HEAD 中没有文件`];
  const entries = paths.map((full) => ({ full, rel: full.slice(copy.length + 1) }));
  const blobs = readBlobs(top, entries.map((e) => `${rev}:${e.full}`));
  const lines = [];
  for (const e of entries) {
    const blob = blobs.get(`${rev}:${e.full}`);
    if (!blob) {
      problems.push(`${e.full} 不是普通文件`);
      continue;
    }
    lines.push({ rel: Buffer.from(e.rel, 'utf8'), hex: sha256Hex(blob), name: e.rel });
  }
  lines.sort((a, b) => Buffer.compare(a.rel, b.rel));
  // `sha256sum` writes "<hex>  <path>" in text mode and "<hex> *<path>" in binary mode (the default of
  // GNU coreutils on Windows). Both formats are accepted: the rc.1 lock was produced in binary mode (space + asterisk); from rc.2 on the lock
  // uses the two-space format named by its sha256Method field.
  const listing = (sep) => sha256Hex(Buffer.from(lines.map((l) => `${l.hex}${sep}${l.name}\n`).join(''), 'utf8'));
  const candidates = [listing('  '), listing(' *')];
  const sha256 = candidates.includes(lock.sha256) ? lock.sha256 : candidates[0];
  const tree = git(['rev-parse', '--verify', '--quiet', `${rev}:${copy}`], { cwd: top, allowFail: true });
  const gitTree = tree.status === 0 ? String(tree.stdout).trim() : '(none)';
  if (lock.sha256 !== sha256) problems.push(`sha256：lock 记录 ${lock.sha256}，按 sha256Method 复算得 ${sha256}`);
  if (lock.gitTree !== gitTree) problems.push(`gitTree：lock 记录 ${lock.gitTree}，副本目录的 tree 是 ${gitTree}`);
  if (lock.files !== paths.length) problems.push(`files：lock 记录 ${lock.files}，副本目录有 ${paths.length} 个文件`);
  return problems;
}

function specCheck(opts, { headBranch, baseBranch }, files, rangeNote, repo = null) {
  const id = 'spec-copy';
  const touched = files.filter((f) => matchesAny(f.path, SPEC_PATTERNS)).map((f) => f.path);
  if (!touched.length) return result(id, titleOf(id), 'PASS', `${rangeNote}，未改动规范副本与 .github/spec.lock`);
  const external = Boolean(opts.external);
  const pr = `${external ? '外部 PR ' : ''}${headBranch ?? '未知分支'} → ${baseBranch || '未知 base'}`;
  if (mayChangeSpec({ headBranch, baseBranch, external })) {
    // The branch may change the spec; the lock still has to describe the copy it ships with.
    if (repo?.head) {
      const lockProblems = verifySpecLock(repo.top, repo.head);
      if (lockProblems.length) return result(id, titleOf(id), 'FAIL', `${pr} 改动了规范副本或 .github/spec.lock，但 lock 与副本不一致`, lockProblems);
      return result(id, titleOf(id), 'PASS', `${pr} 可以更新规范副本（${touched.length} 个文件）；.github/spec.lock 已按 sha256Method、git tree 与文件数复算，三项一致`);
    }
    return result(id, titleOf(id), 'PASS', `${pr} 可以更新规范副本（${touched.length} 个文件）；暂存检查不复算 lock`);
  }
  return result(id, titleOf(id), 'FAIL', `只有 spec-sync/* 可以改规范副本与 .github/spec.lock；feature/**、sync/* 只在合入 dev、upstream-pr/* 只在合入 review-base/* 时可以带入已合入的规范变更（当前 ${pr}）`, touched);
}

/** null when `uses:` is acceptable, otherwise the reason. */
export function actionRefProblem(ref, rawLine) {
  if (ref.startsWith('./')) return null;
  if (ref.startsWith('docker://')) return /@sha256:[0-9a-f]{64}$/.test(ref) ? null : `${ref}：docker 镜像必须用 @sha256: 摘要`;
  const m = /^([^@\s]+)@([^\s]+)$/.exec(ref);
  if (!m) return `${ref}：无法识别的 action 引用`;
  const [, name, version] = m;
  const repo = name.split('/').slice(0, 2).join('/');
  if (!ALLOWED_ACTION_OWNERS.some((o) => repo.startsWith(o)) && !ALLOWED_ACTIONS.includes(repo)) return `${repo} 不在组织允许的 action 清单内`;
  if (!/^[0-9a-f]{40}$/.test(version)) return `${ref}：必须固定到 40 位 commit SHA`;
  if (!/#\s*v?\d+(\.\d+)*/.test(rawLine)) return `${ref}：SHA 后面要用注释写明版本号（如 # v7.0.1）`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const CLI_SPEC = {
  layer: 'string',
  pr: 'bool',
  base: 'string',
  head: 'string',
  'head-branch': 'string',
  mirror: 'string',
  external: 'bool',
  index: 'bool',
  only: 'list',
  'clang-format': 'string',
  'require-tools': 'bool',
  'max-commits': 'string',
  json: 'bool',
  ci: 'bool',
  help: 'bool',
};

async function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, CLI_SPEC));
  } catch (e) {
    process.stderr.write(`fork-checks: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write(`usage: fork-checks.mjs [--layer L] [--pr] [--base REF] [--head REV] [--head-branch NAME] [--external] [--index] [--only ID,...] [--clang-format PATH] [--require-tools] [--json|--ci]\nchecks: ${CHECK_IDS.join(', ')}\n`);
    return 2;
  }
  const unknown = (o.only ?? []).filter((id) => !CHECK_IDS.includes(id));
  if (unknown.length) {
    process.stderr.write(`fork-checks: unknown check id(s): ${unknown.join(', ')}\n`);
    return 2;
  }
  let out;
  try {
    out = await runChecks({
      layer: o.layer,
      pr: o.pr ? { title: process.env.PR_TITLE ?? '', body: process.env.PR_BODY ?? '' } : null,
      base: o.base,
      defaultBase: !o.ci,
      head: o.head,
      headBranch: o['head-branch'] || undefined,
      mirror: o.mirror,
      external: o.external,
      index: o.index,
      only: o.only,
      clangFormat: o['clang-format'] || undefined,
      requireTools: o['require-tools'],
      maxCommits: o['max-commits'] ? Number(o['max-commits']) : undefined,
    });
  } catch (e) {
    process.stderr.write(`fork-checks: ${e.stack ?? e.message}\n`);
    return 2;
  }
  const status = overallStatus(out.results);
  if (o.json) {
    process.stdout.write(JSON.stringify({ status, ...out }, null, 2) + '\n');
  } else {
    const title = `fork-checks · ${short(out.meta.head) || '?'} · ${out.meta.headBranch ?? '(detached)'}${out.meta.index ? ' · 暂存区' : ''} · ${status}`;
    const md = formatMarkdown(title, out.results);
    process.stdout.write(md);
    if (o.ci) reportToGitHub(md, out.results);
  }
  return status === 'FAIL' ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
