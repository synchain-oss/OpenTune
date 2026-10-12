#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// gitleaks-delta: scan only "our delta" for secrets. Content that came with the upstream base is
// upstream's business; the fork answers for what it adds.
//   1. gitleaks git --log-opts="--no-merges <head> --not --tags=upstream/* <mirror>"   (delta commits)
//   2. gitleaks dir over a copy of the delta files as they are in the working tree      (files)
// No allowlist is needed today. If one becomes necessary it goes in .github/gitleaks.toml, which is
// passed with --config, rather than a root .gitleaks.toml: fork-only files live under .github/ (L0),
// and a new file at the repository root would be an upstream path outside the allow-list (the scope
// check rejects it). Every allowlist entry must name the exact path and rule, with the reason in a
// comment next to it.
//
// CLI: node gitleaks-delta.mjs [--gitleaks <exe>] [--fetch] [--tools-dir <dir>] [--head <rev>]
//                              [--mirror <ref>] [--config <file>] [--json] [--ci]
//      exit 0 = clean, 1 = findings or scan failure, 2 = usage error
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureTool } from './fetch-tool.mjs';
import { computeDelta } from './fork-delta.mjs';
import {
  formatMarkdown,
  isMainModule,
  makeTempDir,
  overallStatus,
  parseArgs,
  removeDir,
  reportToGitHub,
  result,
  short,
} from './fork-lib.mjs';

function runGitleaks(exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, error: r.error, stderr: String(r.stderr ?? '') };
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? [];
  } catch {
    return null;
  }
}

function describe(findings, root) {
  return findings.map((f) => {
    const file = root ? path.relative(root, f.File ?? '').split(path.sep).join('/') : f.File;
    return `${f.RuleID} ${file}:${f.StartLine}${f.Commit ? ` @${short(f.Commit)}` : ''}`;
  });
}

/** Run both scans; returns { meta, results }. */
export function scanDelta({ cwd, gitleaks, head, mirror, config }) {
  const delta = computeDelta({ cwd, head, mirror });
  const meta = { head: delta.head ?? null, base: delta.base ?? null };
  if (!delta.ok) {
    return { meta, results: [result('gitleaks-git', 'gitleaks 增量提交', 'FAIL', delta.error), result('gitleaks-dir', 'gitleaks 增量文件', 'FAIL', delta.error)] };
  }
  const top = delta.top;
  const cfg = config ?? (fs.existsSync(path.join(top, '.github', 'gitleaks.toml')) ? path.join(top, '.github', 'gitleaks.toml') : null);
  const common = ['--no-banner', '--no-color', '--redact', '--exit-code', '1', '--log-level', 'warn', '--report-format', 'json'];
  if (cfg) common.push('--config', cfg);
  const tmp = makeTempDir('gitleaks');
  const results = [];
  try {
    // 1. delta commits
    if (!delta.commits.length) {
      results.push(result('gitleaks-git', 'gitleaks 增量提交', 'PASS', '增量没有提交'));
    } else {
      const report = path.join(tmp, 'git.json');
      const logOpts = `--no-merges ${delta.head} --not --tags=upstream/* ${delta.mirrorSha}`;
      const r = runGitleaks(gitleaks, ['git', ...common, '--report-path', report, `--log-opts=${logOpts}`, top]);
      const findings = readReport(report);
      if (r.error || findings == null || (r.status !== 0 && !findings.length)) {
        results.push(result('gitleaks-git', 'gitleaks 增量提交', 'FAIL', `gitleaks git 运行失败（exit ${r.status}）`, [r.stderr.trim().slice(-500) || String(r.error)]));
      } else if (findings.length) {
        results.push(result('gitleaks-git', 'gitleaks 增量提交', 'FAIL', `${delta.commits.length} 个增量提交中发现 ${findings.length} 处疑似密钥`, describe(findings)));
      } else {
        results.push(result('gitleaks-git', 'gitleaks 增量提交', 'PASS', `${delta.commits.length} 个增量提交无发现`));
      }
    }

    // 2. delta files in the working tree
    const treeDir = path.join(tmp, 'tree');
    let copied = 0;
    for (const f of delta.files) {
      if (f.status === 'D') continue;
      const src = path.join(top, ...f.path.split('/'));
      let st;
      try {
        st = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const dst = path.join(treeDir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    }
    if (!copied) {
      results.push(result('gitleaks-dir', 'gitleaks 增量文件', 'PASS', '工作树中没有增量文件'));
    } else {
      const report = path.join(tmp, 'dir.json');
      const r = runGitleaks(gitleaks, ['dir', ...common, '--report-path', report, treeDir]);
      const findings = readReport(report);
      if (r.error || findings == null || (r.status !== 0 && !findings.length)) {
        results.push(result('gitleaks-dir', 'gitleaks 增量文件', 'FAIL', `gitleaks dir 运行失败（exit ${r.status}）`, [r.stderr.trim().slice(-500) || String(r.error)]));
      } else if (findings.length) {
        results.push(result('gitleaks-dir', 'gitleaks 增量文件', 'FAIL', `${copied} 个增量文件中发现 ${findings.length} 处疑似密钥`, describe(findings, treeDir)));
      } else {
        results.push(result('gitleaks-dir', 'gitleaks 增量文件', 'PASS', `工作树中 ${copied} 个增量文件无发现`));
      }
    }
  } finally {
    removeDir(tmp);
  }
  return { meta, results };
}

async function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { gitleaks: 'string', fetch: 'bool', 'tools-dir': 'string', head: 'string', mirror: 'string', config: 'string', json: 'bool', ci: 'bool', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`gitleaks-delta: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write('usage: gitleaks-delta.mjs [--gitleaks EXE | --fetch [--tools-dir DIR]] [--head REV] [--mirror REF] [--config FILE] [--json|--ci]\n');
    return 2;
  }
  let exe = o.gitleaks || process.env.GITLEAKS || null;
  try {
    if (!exe && o.fetch) exe = await ensureTool('gitleaks', { dest: o['tools-dir'] ? path.resolve(o['tools-dir']) : undefined });
  } catch (e) {
    process.stderr.write(`gitleaks-delta: ${e.message}\n`);
    return 1;
  }
  if (!exe) {
    process.stderr.write('gitleaks-delta: no gitleaks binary (pass --gitleaks, set GITLEAKS or use --fetch)\n');
    return 1;
  }
  let out;
  try {
    out = scanDelta({ gitleaks: exe, head: o.head, mirror: o.mirror, config: o.config ? path.resolve(o.config) : undefined });
  } catch (e) {
    process.stderr.write(`gitleaks-delta: ${e.stack ?? e.message}\n`);
    return 1;
  }
  const status = overallStatus(out.results);
  if (o.json) process.stdout.write(JSON.stringify({ status, ...out }, null, 2) + '\n');
  else {
    const md = formatMarkdown(`gitleaks（增量）· ${short(out.meta.head) || '?'} · ${status}`, out.results);
    process.stdout.write(md);
    if (o.ci) reportToGitHub(md, out.results);
  }
  return status === 'FAIL' ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
