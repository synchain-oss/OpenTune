#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// detect-native: decide what build-windows compiles for one event.
//
//   PR -> dev                full build (control API option ON)
//   PR -> review-base/**     two builds, option ON and OFF
//   PR -> feature/**         build only when the PR's change set (computePrRange: merge-base of the
//                            base branch and HEAD .. HEAD) touches native code or the build pipeline
//                            itself (NATIVE_PATTERNS); otherwise no build, and the aggregate job
//                            reports a skipped success
//   anything else            full build (push, workflow_dispatch, or a caller of workflow_call)
//
// CLI: node detect-native.mjs --event <github.event_name> [--base <github.base_ref>] [--head <rev>]
//      [--github-output <file>]   writes build=, variants= and reason= for $GITHUB_OUTPUT
//      exit 0 = decided (stdout: JSON), 2 = usage / git error
import fs from 'node:fs';
import { computePrRange } from './fork-delta.mjs';
import { isMainModule, matchesAny, parseArgs } from './fork-lib.mjs';

/** A change to any of these paths means "compile and test". */
export const NATIVE_PATTERNS = [
  'Source/**',
  'Tests/**',
  'cmake/**',
  'CMakeLists.txt',
  // The build pipeline itself: a PR that changes how we build must prove the build still works.
  '.github/workflows/build-windows.yml',
  '.github/scripts/bootstrap-deps.ps1',
  '.github/scripts/deps.lock.json',
  '.github/scripts/detect-native.mjs',
  '.github/scripts/run-ctest.ps1',
  '.github/scripts/with-build-slot.ps1',
  '.github/scripts/tools.lock.json',
];

/**
 * @param {{event: string, base?: string, files?: string[]}} input  files: the PR's changed paths
 *   (only needed for PRs into feature/**)
 * @returns {{build: boolean, variants: string[], reason: string}}
 */
export function decide({ event, base = '', files = [] }) {
  const isPr = event === 'pull_request';
  if (isPr && base.startsWith('review-base/')) return { build: true, variants: ['ON', 'OFF'], reason: `PR → ${base}：控制接口选项 ON 与 OFF 各编译、测试一次` };
  if (isPr && base.startsWith('feature/')) {
    const hits = files.filter((f) => matchesAny(f, NATIVE_PATTERNS));
    if (!hits.length) return { build: false, variants: ['ON'], reason: `PR → ${base} 的 ${files.length} 个改动文件都不涉及原生代码或构建流水线，跳过编译` };
    const shown = hits.slice(0, 10).join('、') + (hits.length > 10 ? ` 等 ${hits.length} 个` : '');
    return { build: true, variants: ['ON'], reason: `PR → ${base} 改到原生代码或构建流水线：${shown}` };
  }
  return { build: true, variants: ['ON'], reason: `${event}${base ? ` → ${base}` : ''}：完整编译与测试` };
}

function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { event: 'string', base: 'string', head: 'string', 'github-output': 'string', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`detect-native: ${e.message}\n`);
    return 2;
  }
  if (o.help || !o.event) {
    process.stderr.write('usage: detect-native.mjs --event <name> [--base <branch>] [--head <rev>] [--github-output <file>]\n');
    return 2;
  }
  const base = o.base ?? '';
  let files = [];
  if (o.event === 'pull_request' && base.startsWith('feature/')) {
    const r = computePrRange({ head: o.head ?? 'HEAD', baseRef: `origin/${base}` });
    if (!r.ok) {
      process.stderr.write(`detect-native: ${r.error}\n`);
      return 2;
    }
    files = r.files.map((f) => f.path);
  }
  const d = decide({ event: o.event, base, files });
  // One line per output: never let a path break the key=value format.
  const reason = d.reason.replace(/[\r\n]+/g, ' ');
  if (o['github-output']) {
    fs.appendFileSync(o['github-output'], `build=${d.build}\nvariants=${JSON.stringify(d.variants)}\nreason=${reason}\n`);
  }
  process.stdout.write(`${JSON.stringify({ ...d, reason }, null, 2)}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
