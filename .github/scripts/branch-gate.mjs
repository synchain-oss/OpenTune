#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// branch-gate: checks for pull requests into dev (run by .github/workflows/branch-gate.yml).
//   branch-name   dev accepts only feature/*, feat/*, spec-sync/*, sync/* from this repository;
//                 a PR from another repository may not use any protected branch name
//   dco-identity  every non-merge commit of the PR is signed off; same-repository PRs also use only
//                 the allowed identities (shared with fork-checks)
//   attribution   no AI attribution in the commit messages, the PR title or the PR body
// The PR title/body come from the environment (PR_TITLE, PR_BODY) and are untrusted: they are only
// matched against fixed patterns.
//
// CLI: node branch-gate.mjs --base <branch> --head-branch <branch> --head-repo <owner/name>
//                           --this-repo <owner/name> --base-ref <rev> [--head <rev>] [--pr] [--json|--ci]
import { checkAttributionTexts, checkCommitIdentities, loadAttribution } from './fork-checks.mjs';
import {
  SCRIPTS_DIR,
  formatMarkdown,
  isMainModule,
  listCommits,
  matchesAny,
  overallStatus,
  parseArgs,
  repoTop,
  reportToGitHub,
  result,
  short,
  tryResolveCommit,
} from './fork-lib.mjs';

/** Head branches that may open a PR into dev from this repository. */
export const DEV_SOURCES = ['feature/**', 'feat/**', 'spec-sync/**', 'sync/**'];
/** Branch names a PR from another repository may not use. */
export const PROTECTED_NAMES = ['dev', 'upstream-mirror', 'feature/**', 'feat/**', 'spec-sync/**', 'sync/**', 'upstream-pr/**', 'review-base/**'];

/** Branch naming rule. Returns a result object. */
export function checkBranchName({ base, headBranch, headRepo, thisRepo }) {
  const id = 'branch-name';
  const title = '分支命名';
  if (!base || !headBranch) return result(id, title, 'FAIL', '缺少 base 或 head 分支名');
  const external = Boolean(headRepo && thisRepo && headRepo.toLowerCase() !== thisRepo.toLowerCase());
  if (external) {
    return matchesAny(headBranch, PROTECTED_NAMES)
      ? result(id, title, 'FAIL', `外部仓库的 PR 不得使用受保护的分支名 ${headBranch}`)
      : result(id, title, 'PASS', `外部仓库的 PR（${headBranch} → ${base}），不套用命名规则`);
  }
  if (base === 'dev' && !matchesAny(headBranch, DEV_SOURCES)) {
    return result(id, title, 'FAIL', `dev 只接受 feature/*、feat/*、spec-sync/*、sync/*，当前为 ${headBranch}`);
  }
  return result(id, title, 'PASS', `${headBranch} → ${base}`);
}

/** All branch-gate checks. */
export async function runBranchGate({ cwd, base, headBranch, headRepo, thisRepo, baseRef, head = 'HEAD', pr = null, attributionDir = SCRIPTS_DIR }) {
  const results = [checkBranchName({ base, headBranch, headRepo, thisRepo })];
  const external = Boolean(headRepo && thisRepo && headRepo.toLowerCase() !== thisRepo.toLowerCase());
  const top = repoTop(cwd ?? process.cwd());
  const headSha = tryResolveCommit(top, head);
  const baseSha = baseRef ? tryResolveCommit(top, baseRef) : null;
  const attr = await loadAttribution(attributionDir);
  if (!headSha || !baseSha) {
    const why = `无法解析 ${!headSha ? head : baseRef ?? '(未给 --base-ref)'}`;
    results.push(result('dco-identity', 'DCO 与身份', 'FAIL', why), result('attribution', '无 AI 署名', 'FAIL', why));
    return { meta: { head: headSha }, results };
  }
  const commits = listCommits(top, ['--no-merges', headSha, '--not', baseSha]);
  const idProblems = checkCommitIdentities(commits, { external });
  results.push(idProblems.length
    ? result('dco-identity', 'DCO 与身份', 'FAIL', `${idProblems.length} 处 DCO/身份问题`, idProblems)
    : result('dco-identity', 'DCO 与身份', 'PASS', `PR 的 ${commits.length} 个非合并提交${external ? '都有与作者一致的 Signed-off-by（外部 PR）' : '的身份与 Signed-off-by 都在允许清单内'}`));
  if (!attr.ok) {
    results.push(result('attribution', '无 AI 署名', 'FAIL', '署名规则副本校验失败', attr.problems));
  } else {
    const problems = checkAttributionTexts(attr, commits, pr);
    results.push(problems.length
      ? result('attribution', '无 AI 署名', 'FAIL', '提交信息或 PR 文本中有 AI 署名', problems)
      : result('attribution', '无 AI 署名', 'PASS', `${commits.length} 条提交信息${pr ? '与 PR 标题、正文' : ''}无 AI 署名`));
  }
  return { meta: { head: headSha }, results };
}

async function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, {
      base: 'string', 'head-branch': 'string', 'head-repo': 'string', 'this-repo': 'string', 'base-ref': 'string', head: 'string', pr: 'bool', json: 'bool', ci: 'bool', help: 'bool',
    }));
  } catch (e) {
    process.stderr.write(`branch-gate: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write('usage: branch-gate.mjs --base B --head-branch H --head-repo R --this-repo R --base-ref REV [--head REV] [--pr] [--json|--ci]\n');
    return 2;
  }
  let out;
  try {
    out = await runBranchGate({
      base: o.base,
      headBranch: o['head-branch'],
      headRepo: o['head-repo'],
      thisRepo: o['this-repo'],
      baseRef: o['base-ref'],
      head: o.head || 'HEAD',
      pr: o.pr ? { title: process.env.PR_TITLE ?? '', body: process.env.PR_BODY ?? '' } : null,
    });
  } catch (e) {
    process.stderr.write(`branch-gate: ${e.stack ?? e.message}\n`);
    return 2;
  }
  const status = overallStatus(out.results);
  if (o.json) process.stdout.write(JSON.stringify({ status, ...out }, null, 2) + '\n');
  else {
    const md = formatMarkdown(`branch-gate · ${short(out.meta.head) || '?'} · ${status}`, out.results);
    process.stdout.write(md);
    if (o.ci) reportToGitHub(md, out.results);
  }
  return status === 'FAIL' ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
