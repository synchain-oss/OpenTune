#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fork-delta: compute "our delta", the only part of the history the fork gates look at.
//
//   delta commits = git rev-list --no-merges <head> --not --tags='upstream/*' <upstream-mirror>
//   delta files   = git diff --name-status <merge-base(head, upstream-mirror)> <head>
//
// The branch must contain a tagged upstream snapshot (refs/tags/upstream/*) and the delta must not
// exceed 150 commits; otherwise it was not built on the locked upstream base and every gate fails.
//
// Library: import { computeDelta } from './fork-delta.mjs'
// CLI:     node fork-delta.mjs [--head <rev>] [--mirror <ref>] [--max-commits N] [--index] [--json]
//          exit 0 = delta ok, 1 = not based on a tagged upstream snapshot, 2 = usage / git error
import {
  DEFAULT_MIRROR_REFS,
  MAX_DELTA_COMMITS,
  NOT_BASED_MESSAGE,
  UPSTREAM_TAG_PATTERN,
  git,
  isAncestor,
  isMainModule,
  listCommitPaths,
  listCommits,
  mergeBase,
  parseArgs,
  parseNameStatusZ,
  repoTop,
  short,
  tryResolveCommit,
} from './fork-lib.mjs';

function upstreamTags(cwd, pattern) {
  const prefix = `refs/tags/${pattern.replace(/\*.*$/, '')}`;
  const out = git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)', prefix], { cwd });
  const tags = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, obj, peeled] = line.split('\0');
    tags.push({ name: ref.replace(/^refs\/tags\//, ''), sha: peeled || obj });
  }
  return tags;
}

/**
 * @param {{cwd?: string, head?: string, mirror?: string, maxCommits?: number, index?: boolean,
 *          tagPattern?: string}} [opts]
 *   index: compare the upstream base with the index (staged state) instead of <head>.
 * @returns {{ok: boolean, error?: string, top: string, head?: string, mirrorRef?: string,
 *            mirrorSha?: string, base?: string, tags?: {name: string, sha: string}[],
 *            revArgs?: string[], commits?: object[], files?: {status: string, path: string}[],
 *            historyPaths?: Map<string, {status: string, path: string}[]>, index: boolean}}
 */
export function computeDelta(opts = {}) {
  const top = repoTop(opts.cwd ?? process.cwd());
  const index = Boolean(opts.index);
  const maxCommits = opts.maxCommits ?? MAX_DELTA_COMMITS;
  const tagPattern = opts.tagPattern ?? UPSTREAM_TAG_PATTERN;
  const fail = (error, extra = {}) => ({ ok: false, error, top, index, ...extra });

  const headRev = opts.head ?? 'HEAD';
  const head = tryResolveCommit(top, headRev);
  if (!head) return fail(`无法解析提交 ${headRev}`);

  const mirrorRefs = opts.mirror ? [opts.mirror] : DEFAULT_MIRROR_REFS;
  let mirrorRef = null;
  let mirrorSha = null;
  for (const ref of mirrorRefs) {
    const sha = tryResolveCommit(top, ref);
    if (sha) {
      mirrorRef = ref;
      mirrorSha = sha;
      break;
    }
  }
  if (!mirrorSha) {
    return fail(`找不到上游镜像分支（试过 ${mirrorRefs.join('、')}）；请先 git fetch origin upstream-mirror`, { head });
  }

  const tags = upstreamTags(top, tagPattern);
  const based = tags.filter((t) => isAncestor(top, t.sha, head));
  if (!based.length) {
    const why = tags.length ? `HEAD 不包含任何 ${tagPattern} tag` : `本地没有任何 ${tagPattern} tag（CI 需显式 fetch refs/tags/upstream/*）`;
    return fail(`${NOT_BASED_MESSAGE}（${why}）`, { head, mirrorRef, mirrorSha, tags });
  }

  const revArgs = ['--no-merges', head, '--not', `--tags=${tagPattern}`, mirrorSha];
  const commits = listCommits(top, revArgs);
  if (commits.length > maxCommits) {
    return fail(`${NOT_BASED_MESSAGE}（增量有 ${commits.length} 个提交，上限 ${maxCommits}）`, { head, mirrorRef, mirrorSha, tags: based });
  }

  const base = mergeBase(top, head, mirrorSha);
  if (!base) return fail(`HEAD 与 ${mirrorRef} 没有共同祖先`, { head, mirrorRef, mirrorSha, tags: based });

  const diffArgs = index
    ? ['diff', '--cached', '--name-status', '-z', '--no-renames', base]
    : ['diff', '--name-status', '-z', '--no-renames', base, head];
  const files = parseNameStatusZ(git(diffArgs, { cwd: top }));
  const historyPaths = commits.length ? listCommitPaths(top, revArgs) : new Map();

  return { ok: true, top, index, head, mirrorRef, mirrorSha, base, tags: based, revArgs, commits, files, historyPaths };
}

/**
 * The change set of one PR: files changed between merge-base(head, baseRef) and head, and the PR's
 * own non-merge commits (head --not baseRef, as GitHub lists them).
 */
export function computePrRange({ cwd, head, baseRef }) {
  const top = repoTop(cwd ?? process.cwd());
  const headSha = tryResolveCommit(top, head ?? 'HEAD');
  const baseSha = tryResolveCommit(top, baseRef);
  if (!headSha || !baseSha) return { ok: false, error: `无法解析 ${!headSha ? head ?? 'HEAD' : baseRef}` };
  const mb = mergeBase(top, headSha, baseSha);
  if (!mb) return { ok: false, error: `HEAD 与 ${baseRef} 没有共同祖先` };
  const files = parseNameStatusZ(git(['diff', '--name-status', '-z', '--no-renames', mb, headSha], { cwd: top }));
  const commits = listCommits(top, ['--no-merges', headSha, '--not', baseSha]);
  return { ok: true, baseRef, mergeBase: mb, head: headSha, files, commits };
}

function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { head: 'string', mirror: 'string', 'max-commits': 'string', index: 'bool', json: 'bool', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`fork-delta: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write('usage: fork-delta.mjs [--head <rev>] [--mirror <ref>] [--max-commits N] [--index] [--json]\n');
    return 2;
  }
  let d;
  try {
    d = computeDelta({ head: o.head, mirror: o.mirror, maxCommits: o['max-commits'] ? Number(o['max-commits']) : undefined, index: o.index });
  } catch (e) {
    process.stderr.write(`fork-delta: ${e.message}\n`);
    return 2;
  }
  if (o.json) {
    const out = { ...d, historyPaths: undefined, commits: d.commits?.map((c) => ({ sha: c.sha, authorEmail: c.authorEmail, subject: c.message.split('\n')[0] })) };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else if (!d.ok) {
    process.stderr.write(`fork-delta: FAIL ${d.error}\n`);
  } else {
    process.stdout.write(`head ${short(d.head)}  base ${short(d.base)} (${d.tags.map((t) => t.name).join(', ')})  mirror ${d.mirrorRef}\n`);
    process.stdout.write(`${d.commits.length} commit(s), ${d.files.length} file(s)${d.index ? ' (index)' : ''}\n`);
    for (const c of d.commits) process.stdout.write(`  ${short(c.sha)} ${c.message.split('\n')[0]}\n`);
    for (const f of d.files) process.stdout.write(`  ${f.status} ${f.path}\n`);
  }
  return d.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
