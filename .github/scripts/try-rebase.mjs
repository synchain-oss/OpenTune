#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// try-rebase: a read-only dry run of the final rebase. It rebases "our delta" (fork-delta.mjs: the commits
// that are not part of the locked upstream snapshot) onto a newer upstream revision inside a throw-away
// local clone, and reports what that would cost:
//   - how many delta commits applied cleanly and how many stopped with conflicts,
//   - conflicted files and conflict blocks (a block is one `<<<<<<<` marker),
//   - files that both upstream and the delta changed,
//   - mirrored upstream functions (.github/drift-pins/*.txt, drift-pins.mjs) whose text changed upstream.
// Nothing in the current repository is touched: no branch is created or moved, nothing is checked out, and
// nothing is ever pushed (the clone has no remote and runs with no hooks). The clone is deleted at the end.
// Conflicts are resolved by taking our side so that later commits can still be counted.
//
// CLI: node try-rebase.mjs [--upstream <rev>] [--head <rev>] [--mirror <ref>] [--summary <file>] [--json] [--keep]
//      --upstream  newest upstream revision to rebase onto (default: the locked mirror itself, which gives a
//                  no-op run and is handy for checking the tooling)
//      --summary   write the Markdown report to this file (the workflow appends it to the job summary)
//      exit 0 = the dry run finished (conflicts are a result, not a failure),
//           1 = not based on a tagged upstream snapshot, 2 = usage / git error
import fs from 'node:fs';
import path from 'node:path';
import { checkPins } from './drift-pins.mjs';
import { computeDelta } from './fork-delta.mjs';
import { ALLOWED_AUTHOR_EMAILS, git, isMainModule, makeTempDir, parseArgs, removeDir, repoTop, short, tryResolveCommit } from './fork-lib.mjs';

const IDENTITY = { name: 'DLsnows', email: ALLOWED_AUTHOR_EMAILS[0] };
const CLEAN_ENV = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' };

function g(clone, args, extra = {}) {
  return git(args, { cwd: clone, env: CLEAN_ENV, ...extra });
}

/** Number of conflict blocks in a working-tree file, or null for a binary file. */
function countBlocks(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return 0;
  }
  if (buf.includes(0)) return null;
  return (buf.toString('utf8').match(/^<{7}(?: |$)/gm) ?? []).length;
}

function unmergedPaths(clone) {
  return g(clone, ['diff', '--name-only', '--diff-filter=U', '-z']).split('\0').filter(Boolean);
}

/** Stage numbers present in the index for an unmerged path (1 base, 2 upstream side, 3 our commit). */
function stagesOf(clone, file) {
  const out = g(clone, ['ls-files', '-u', '-z', '--', file]);
  return new Set(out.split('\0').filter(Boolean).map((l) => Number(l.split(/\s+/)[2])));
}

/**
 * @param {{cwd?: string, head?: string, mirror?: string, upstream?: string, keep?: boolean}} opts
 * @returns {{ok: boolean, error?: string, code?: number, ...}}
 */
export function tryRebase(opts = {}) {
  const top = repoTop(opts.cwd ?? process.cwd());
  const delta = computeDelta({ cwd: top, head: opts.head, mirror: opts.mirror });
  if (!delta.ok) return { ok: false, code: 1, error: delta.error };
  const upstreamSha = tryResolveCommit(top, opts.upstream ?? delta.mirrorSha);
  if (!upstreamSha) return { ok: false, code: 2, error: `无法解析上游版本 ${opts.upstream}（工作流需要先 fetch 上游）` };

  const report = {
    ok: true,
    head: delta.head,
    base: delta.base,
    upstream: upstreamSha,
    upstreamFrom: opts.upstream ?? `${delta.mirrorRef}（锁定的镜像）`,
    commits: delta.commits.length,
    deltaFiles: delta.files.length,
    applied: 0,
    conflictedCommits: [],
    conflictFiles: [],
    conflictBlocks: 0,
    binaryConflicts: 0,
    overlapFiles: [],
    complete: true,
    notes: [],
    drift: null,
  };

  // Files that both sides changed since the common base: the rebase has to reconcile them.
  const upstreamChanged = new Set(g(top, ['diff', '--name-only', '-z', delta.base, upstreamSha]).split('\0').filter(Boolean));
  report.overlapFiles = delta.files.map((f) => f.path).filter((p) => upstreamChanged.has(p));

  const work = makeTempDir('try-rebase');
  try {
    const clone = path.join(work, 'clone');
    // --template= : no hooks are copied into the clone.
    git(['clone', '--quiet', '--local', '--no-checkout', '--template=', top, clone], { env: CLEAN_ENV });
    g(clone, ['remote', 'remove', 'origin']);
    for (const [k, v] of [
      ['user.name', IDENTITY.name],
      ['user.email', IDENTITY.email],
      ['core.autocrlf', 'false'],
      ['core.longpaths', 'true'],
      ['commit.gpgsign', 'false'],
      ['rebase.updateRefs', 'false'],
      ['gc.auto', '0'],
    ]) g(clone, ['config', k, v]);
    // Never run the LFS clean/smudge filters in the clone (pointers stay pointers); info/attributes wins over .gitattributes.
    fs.mkdirSync(path.join(clone, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'info', 'attributes'), '* -filter\n');
    for (const sha of [delta.head, upstreamSha]) {
      if (git(['cat-file', '-e', `${sha}^{commit}`], { cwd: clone, allowFail: true }).status !== 0) {
        return { ok: false, code: 2, error: `提交 ${short(sha)} 不在临时克隆里` };
      }
    }
    g(clone, ['checkout', '--quiet', '--detach', delta.head]);

    let r = g(clone, ['rebase', '--onto', upstreamSha, delta.base, '--empty=drop'], { allowFail: true });
    let guard = delta.commits.length * 3 + 10;
    while (r.status !== 0) {
      if (--guard < 0) {
        g(clone, ['rebase', '--abort'], { allowFail: true });
        report.complete = false;
        report.notes.push('变基循环超过上限，已中止；下面的数字只覆盖已处理的部分');
        break;
      }
      const files = unmergedPaths(clone);
      if (!files.length) {
        // Nothing to resolve (for example a commit that became empty): skip it and go on.
        r = g(clone, ['rebase', '--skip'], { allowFail: true });
        if (r.status !== 0 && !fs.existsSync(path.join(clone, '.git', 'rebase-merge'))) break;
        continue;
      }
      const commitSha = String(g(clone, ['rev-parse', '--verify', 'REBASE_HEAD'], { allowFail: true }).stdout ?? '').trim();
      const subject = commitSha ? g(clone, ['log', '-1', '--format=%s', commitSha]).trim() : '';
      const entry = { commit: commitSha, subject, files: [], blocks: 0 };
      for (const f of files) {
        const blocks = countBlocks(path.join(clone, f));
        if (blocks === null) report.binaryConflicts++;
        else {
          entry.blocks += blocks;
          report.conflictBlocks += blocks;
        }
        entry.files.push(f);
        if (!report.conflictFiles.includes(f)) report.conflictFiles.push(f);
        // Take our commit's side; when the commit deleted the file, delete it.
        if (stagesOf(clone, f).has(3)) {
          g(clone, ['checkout', '--theirs', '--', f]);
          g(clone, ['add', '--', f]);
        } else {
          g(clone, ['rm', '--quiet', '--force', '--', f]);
        }
      }
      report.conflictedCommits.push(entry);
      r = g(clone, ['rebase', '--continue'], { allowFail: true });
    }
    if (r.status === 0) {
      report.applied = Number(g(clone, ['rev-list', '--count', `${upstreamSha}..HEAD`]).trim());
    }
  } finally {
    if (!opts.keep) removeDir(work);
  }

  try {
    report.drift = checkPins({ cwd: top, rev: upstreamSha, pinsRev: delta.head });
  } catch (e) {
    report.notes.push(`镜像漂移检查失败：${e.message}`);
  }
  return report;
}

/** Markdown for the job summary. */
export function formatSummary(r) {
  if (!r.ok) return `### 试 rebase：失败\n\n${r.error}\n`;
  const L = [];
  L.push('### 试 rebase（只读，永不推送）', '');
  L.push(`- 我们的增量：${r.commits} 个提交，${r.deltaFiles} 个文件（HEAD ${short(r.head)}，上游基点 ${short(r.base)}）`);
  L.push(`- 目标上游：${short(r.upstream)}（${r.upstreamFrom}）`);
  L.push(`- 上游与增量都改过的文件：${r.overlapFiles.length} 个`);
  L.push(`- 变基结果：${r.complete ? '完成' : '未完成'}；干净应用 ${r.commits - r.conflictedCommits.length} 个提交，遇到冲突 ${r.conflictedCommits.length} 个提交`);
  L.push(`- 冲突文件 ${r.conflictFiles.length} 个，冲突块 ${r.conflictBlocks} 个${r.binaryConflicts ? `，另有 ${r.binaryConflicts} 个二进制冲突` : ''}`);
  for (const n of r.notes) L.push(`- 注意：${n}`);
  if (r.conflictedCommits.length) {
    L.push('', '| 提交 | 主题 | 冲突文件 | 冲突块 |', '|---|---|---|---|');
    for (const c of r.conflictedCommits.slice(0, 30)) L.push(`| ${short(c.commit)} | ${c.subject.replace(/\|/g, '\\|')} | ${c.files.slice(0, 5).join('、')}${c.files.length > 5 ? ` 等 ${c.files.length} 个` : ''} | ${c.blocks} |`);
    if (r.conflictedCommits.length > 30) L.push('', `（只列出前 30 个，共 ${r.conflictedCommits.length} 个）`);
  }
  if (r.overlapFiles.length) {
    L.push('', `上游与增量都改过的文件（前 20 个）：${r.overlapFiles.slice(0, 20).map((f) => `\`${f}\``).join('、')}${r.overlapFiles.length > 20 ? ' 等' : ''}`);
  }
  L.push('', '#### 镜像漂移（.github/drift-pins/）', '');
  if (!r.drift) L.push('未能检查。');
  else if (!r.drift.pins) L.push('目前没有登记的镜像条目（目录里只有说明文件）。');
  else {
    const changed = r.drift.entries.filter((e) => e.status !== 'unchanged');
    L.push(`${r.drift.pins} 个条目，${changed.length} 个需要复审。`);
    if (changed.length) {
      L.push('', '| 组 | 文件 | 函数 | 状态 |', '|---|---|---|---|');
      for (const e of changed) L.push(`| ${e.group} | ${e.path} | ${e.symbol} | ${{ changed: '文本已变化', 'missing-file': '文件不存在', 'missing-symbol': '找不到函数' }[e.status]} |`);
    }
  }
  for (const p of r.drift?.problems ?? []) L.push('', `- 锁清单格式问题：${p}`);
  return `${L.join('\n')}\n`;
}

function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { upstream: 'string', head: 'string', mirror: 'string', summary: 'string', json: 'bool', keep: 'bool', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`try-rebase: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write('usage: try-rebase.mjs [--upstream <rev>] [--head <rev>] [--mirror <ref>] [--summary <file>] [--json] [--keep]\n');
    return 2;
  }
  let r;
  try {
    r = tryRebase({ upstream: o.upstream, head: o.head, mirror: o.mirror, keep: o.keep });
  } catch (e) {
    process.stderr.write(`try-rebase: ${e.message}\n`);
    return 2;
  }
  const md = formatSummary(r);
  if (o.summary) fs.writeFileSync(o.summary, md);
  process.stdout.write(o.json ? `${JSON.stringify(r, null, 2)}\n` : md);
  return r.ok ? 0 : r.code ?? 2;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
