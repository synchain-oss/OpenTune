// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared helpers for the fork gates (fork-delta, fork-checks, branch-gate, gitleaks-delta).
// Fork-only tooling: lives under .github/ and never goes upstream. Node >= 22, no dependencies.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Repository policy (mirrors CLAUDE.md; keep the two in sync)
// ---------------------------------------------------------------------------------------------

/** Mirror branch refs tried in order when --mirror is not given. */
export const DEFAULT_MIRROR_REFS = ['origin/upstream-mirror', 'upstream-mirror'];
/** Upstream snapshot tags: upstream/YYYYMMDD-<sha7>. */
export const UPSTREAM_TAG_PATTERN = 'upstream/*';
/** More delta commits than this means the branch is not based on a tagged upstream snapshot. */
export const MAX_DELTA_COMMITS = 150;
export const NOT_BASED_MESSAGE = '未基于已标记的上游快照，请 rebase 到 dev';

/** Commit author identities allowed in the delta (local commits; GitHub web merges). */
export const ALLOWED_AUTHOR_EMAILS = ['noreply@synchain.ca', '140901583+dlsnows@users.noreply.github.com'];
/** Committers additionally allowed (GitHub itself commits web merges). */
export const ALLOWED_COMMITTER_EMAILS = [...ALLOWED_AUTHOR_EMAILS, 'noreply@github.com'];
/** The identity every local commit is made and signed off with. */
export const LOCAL_IDENTITY_EMAIL = 'noreply@synchain.ca';

/** Fork-only (L0) paths: never leave the fork. */
export const L0_PATTERNS = [
  '.github/**',
  'CLAUDE.md',
  'Tests/ControlFork/**',
  'Source/Control/.clang-format',
  'docs/control-api.md',
  'docs/control-api.en.md',
];

/** Upstream files that carry the declared integration hooks (CLAUDE.md section 1 table). */
export const HOOK_FILES = [
  'Source/PluginProcessor.h',
  'Source/PluginProcessor.cpp',
  'Source/Utils/AppPreferences.cpp',
  'Source/Utils/AppLogger.cpp',
  'Source/Content/StandaloneContentRepository.h',
  'Source/Content/StandaloneContentRepository.cpp',
  'Source/Standalone/PluginEditor.h',
  'Source/Standalone/PluginEditor.cpp',
  'Source/Utils/UndoManager.h',
  'Source/Utils/UndoManager.cpp',
  'Source/Editor/OnboardingOverlayComponent.h',
  'Source/Editor/OnboardingOverlayComponent.cpp',
  'Source/Standalone/UI/ArrangementViewComponent.h',
  'Source/Standalone/UI/ArrangementViewComponent.cpp',
];

/** Paths that may be contributed upstream (checked after L0, so Source/Control/.clang-format stays L0). */
export const UPSTREAMABLE_PATTERNS = [
  'Source/Control/**',
  'Source/Standalone/ControlEditorBridge*',
  'Tests/Control/**',
  'cmake/OpenTuneControl.cmake',
  'CMakeLists.txt',
  'BUILDING.md',
  'BUILDING.en.md',
  ...HOOK_FILES,
];

/** Verbatim copy of the OTCP specification and its lock: only spec-sync branches change them. */
export const SPEC_PATTERNS = ['Tests/Control/spec/**', '.github/spec.lock'];
export const SPEC_COPY_PATTERNS = ['Tests/Control/spec/**'];

/** Paths the delta may never add, modify or delete (model weights, vendored deps, D3D12 runtime). */
export const GUARDED_PATTERNS = [
  'models/**',
  '**/*.onnx',
  '**/pc_nsf_hifigan*/**',
  'ThirdParty/**',
  '**/D3D12/**',
  '**/D3D12*.dll',
  '**/d3dconfig.exe',
];

/** Paths ignored by the upstream .gitignore that the fork force-adds on purpose. */
export const IGNORED_ALLOWLIST = ['.github/**', 'CLAUDE.md', 'docs/control-api.md', 'docs/control-api.en.md'];

/** New C++ files under these paths are formatted with Source/Control/.clang-format. */
export const CLANG_FORMAT_PATTERNS = ['Source/Control/**', 'Tests/Control/**', 'Source/Standalone/ControlEditorBridge*'];
export const CLANG_FORMAT_EXCLUDE = ['Tests/Control/spec/**'];
export const CLANG_FORMAT_STYLE_PATH = 'Source/Control/.clang-format';
export const CLANG_FORMAT_VERSION = '18.1.8';
export const CPP_EXTENSIONS = ['.h', '.hh', '.hpp', '.hxx', '.c', '.cc', '.cpp', '.cxx', '.inl', '.ipp', '.mm'];

/** Words that must not appear in upstreamable paths (the upstream review would reject them). */
export const FORBIDDEN_UPSTREAM_WORDS = /synchain|dlsnows|opentune-mcp/i;

/** Actions allowed by the organisation policy (GitHub official + a short list). */
export const ALLOWED_ACTION_OWNERS = ['actions/', 'github/'];
export const ALLOWED_ACTIONS = [
  'anthropics/claude-code-action',
  'qodo-ai/pr-agent',
  'softprops/action-gh-release',
  'oven-sh/setup-bun',
];
/**
 * The organisation's shared CI repository. Only its reusable workflows may be called (job-level
 * `uses: <repo>/.github/workflows/<file>.yml@<40-hex SHA> # v<version>`), pinned like every other action.
 */
export const ALLOWED_REUSABLE_WORKFLOW_REPOS = ['Synchain-oss/ci-workflows'];

export const LAYERS = ['L0', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
export const DEFERRED_LAYERS = ['L7'];

// ---------------------------------------------------------------------------------------------
// Globs and path classes
// ---------------------------------------------------------------------------------------------

const globCache = new Map();

/** Convert a repository glob (`*`, `?`, `**`) to an anchored RegExp. */
export function globToRegExp(glob, { nocase = false } = {}) {
  const key = `${nocase ? 'i' : 's'}:${glob}`;
  if (globCache.has(key)) return globCache.get(key);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (atSegmentStart && glob[i + 2] === '/') {
        re += '(?:[^/]+/)*';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const out = new RegExp(`^${re}$`, nocase ? 'i' : '');
  globCache.set(key, out);
  return out;
}

export function matchesAny(file, patterns, opts) {
  return patterns.some((p) => globToRegExp(p, opts).test(file));
}

/** 'L0' | 'upstreamable' | 'other' */
export function classifyPath(file) {
  if (matchesAny(file, L0_PATTERNS)) return 'L0';
  if (matchesAny(file, UPSTREAMABLE_PATTERNS)) return 'upstreamable';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/**
 * Run git without a shell. Returns stdout (string, or Buffer with raw:true); throws on a non-zero
 * exit unless allowFail, in which case the whole spawnSync result is returned.
 */
export function git(args, { cwd, input, env, allowFail = false, raw = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input: typeof input === 'string' ? Buffer.from(input, 'utf8') : input,
    env: { ...process.env, ...GIT_ENV, ...(env ?? {}) },
    encoding: raw ? 'buffer' : 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (allowFail) return r;
  if (r.status !== 0) {
    const msg = String(r.stderr ?? '').trim();
    const err = new Error(`git ${args.join(' ')} failed (exit ${r.status})${msg ? `: ${msg}` : ''}`);
    err.exitCode = r.status;
    throw err;
  }
  return r.stdout;
}

export function repoTop(cwd) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

export function tryResolveCommit(cwd, rev) {
  const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { cwd, allowFail: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

export function isAncestor(cwd, ancestor, descendant) {
  const r = git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd, allowFail: true });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed: ${String(r.stderr).trim()}`);
}

export function mergeBase(cwd, a, b) {
  const r = git(['merge-base', a, b], { cwd, allowFail: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

export function currentBranch(cwd) {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, allowFail: true });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/** Parse `git diff --name-status -z --no-renames` output into [{status, path}]. */
export function parseNameStatusZ(out) {
  const toks = out.split('\0');
  const files = [];
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const status = toks[i].trim();
    if (!status) break;
    files.push({ status: status[0], path: toks[i + 1] });
  }
  return files;
}

/**
 * Commits selected by `revArgs` (passed to git log), newest first:
 * [{sha, authorName, authorEmail, committerName, committerEmail, parents, message}].
 */
export function listCommits(cwd, revArgs) {
  const fmt = '%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%P%x1f%B';
  const out = git(['log', '-z', `--format=${fmt}`, ...revArgs], { cwd });
  const commits = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const [sha, authorName, authorEmail, committerName, committerEmail, parents, ...rest] = rec.split('\x1f');
    commits.push({
      sha,
      authorName,
      authorEmail: authorEmail.toLowerCase(),
      committerName,
      committerEmail: committerEmail.toLowerCase(),
      parents: parents ? parents.split(' ') : [],
      message: rest.join('\x1f'),
    });
  }
  return commits;
}

/** Paths touched by each commit selected by `revArgs`: Map sha -> [{status, path}]. */
export function listCommitPaths(cwd, revArgs) {
  const out = git(['log', '--no-renames', '--name-status', '-z', '--format=%x01%H', ...revArgs], { cwd });
  const map = new Map();
  let cur = null;
  const toks = out.split('\0');
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i];
    if (t.startsWith('\x01')) {
      cur = t.slice(1).trim();
      map.set(cur, []);
      continue;
    }
    t = t.replace(/^\n+/, '');
    if (!t || !cur) continue;
    if (/^[ACDMRTUX][0-9]*$/.test(t) && i + 1 < toks.length) {
      map.get(cur).push({ status: t[0], path: toks[i + 1] });
      i += 1;
    }
  }
  return map;
}

/**
 * Read several blobs at once. `specs` are object names such as `<sha>:<path>` or `:<path>` (index).
 * Returns Map spec -> Buffer, or null when missing / not a blob.
 */
export function readBlobs(cwd, specs) {
  const result = new Map();
  const unique = [...new Set(specs)].filter((s) => !/[\r\n]/.test(s));
  if (!unique.length) return result;
  const out = git(['cat-file', '--batch'], { cwd, input: unique.join('\n') + '\n', raw: true });
  let pos = 0;
  for (const spec of unique) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) {
      result.set(spec, null);
      continue;
    }
    const size = Number(m[3]);
    const body = out.subarray(pos, pos + size);
    pos += size + 1;
    result.set(spec, m[2] === 'blob' ? Buffer.from(body) : null);
  }
  return result;
}

/** Files under `dir` at `rev` (or the index when rev is null). */
export function listTreeFiles(cwd, rev, dir) {
  const out = rev
    ? git(['ls-tree', '-r', '-z', '--name-only', rev, '--', dir], { cwd })
    : git(['ls-files', '-z', '--', dir], { cwd });
  return out.split('\0').filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

export function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** 'lf' | 'crlf' | 'mixed' | 'none' */
export function eolStyle(buf) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > 0 && buf[i - 1] === 0x0d) crlf++;
      else lf++;
    }
  }
  if (crlf && lf) return 'mixed';
  if (crlf) return 'crlf';
  if (lf) return 'lf';
  return 'none';
}

const SIGNOFF_RE = /^\s*signed-off-by\s*:\s*(.*?)\s*<([^<>\s]+)>\s*$/i;

/** Signed-off-by trailers of a commit message: [{name, email}] (email lower-cased). */
export function findSignoffs(message) {
  const res = [];
  for (const line of String(message ?? '').normalize('NFKC').split(/\r?\n/)) {
    const m = SIGNOFF_RE.exec(line);
    if (m) res.push({ name: m[1], email: m[2].toLowerCase() });
  }
  return res;
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function short(sha) {
  return String(sha ?? '').slice(0, 7);
}

/** A fresh private directory under the system temp dir (always prefixed ot-). */
export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ot-${prefix}-`));
}

export function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best effort: a leftover temp dir is harmless
  }
}

// ---------------------------------------------------------------------------------------------
// Results and reporting
// ---------------------------------------------------------------------------------------------

export function result(id, title, status, detail, problems = []) {
  return { id, title, result: status, detail, problems };
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

/** Markdown summary table plus a details section listing every problem of failed checks. */
export function formatMarkdown(title, results) {
  const lines = [`### ${title}`, '', '| 检查 | 结果 | 说明 |', '|---|---|---|'];
  for (const r of results) lines.push(`| ${escapeCell(`${r.id} ${r.title}`)} | ${r.result} | ${escapeCell(r.detail)} |`);
  const failed = results.filter((r) => r.problems.length && r.result !== 'PASS');
  if (failed.length) {
    lines.push('');
    for (const r of failed) {
      lines.push(`- **${r.id}**（${r.result}）：`);
      for (const p of r.problems.slice(0, 50)) lines.push(`  - ${escapeCell(p)}`);
      if (r.problems.length > 50) lines.push(`  - ……另有 ${r.problems.length - 50} 项`);
    }
  }
  return lines.join('\n') + '\n';
}

function escapeAnnotation(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Emit GitHub annotations for failed checks and append the table to the job summary. */
export function reportToGitHub(markdown, results) {
  for (const r of results) {
    if (r.result !== 'FAIL') continue;
    const first = r.problems[0] ? `：${r.problems[0]}` : '';
    process.stdout.write(`::error title=${escapeAnnotation(r.id)}::${escapeAnnotation(`${r.detail}${first}`)}\n`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, markdown + '\n');
}

export function overallStatus(results) {
  return results.some((r) => r.result === 'FAIL') ? 'FAIL' : 'PASS';
}

// ---------------------------------------------------------------------------------------------
// Tiny argv parser shared by the CLIs
// ---------------------------------------------------------------------------------------------

/**
 * spec: { name: 'string' | 'bool' | 'list' }. Returns { opts, positional }. Throws on unknown options.
 */
export function parseArgs(argv, spec) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const kind = spec[name];
    if (!kind) throw new Error(`unknown option --${name}`);
    if (kind === 'bool') {
      opts[name] = true;
      continue;
    }
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      if (i + 1 >= argv.length) throw new Error(`missing value for --${name}`);
      value = argv[++i];
    }
    if (kind === 'list') (opts[name] ??= []).push(...value.split(',').map((s) => s.trim()).filter(Boolean));
    else opts[name] = value;
  }
  return { opts, positional };
}

export function isMainModule(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
