#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e-windows helper: the checks and reports around the e2e-windows workflow, kept in one testable
// place instead of inline workflow script.
//
//   check-installer --pin <json> --file <Setup.exe>          sha256 and size of the downloaded installer
//   check-models    --pin <json> --dir <models dir>           every pinned model exists with the pinned sha256
//   check-log       --log-dir <dir> --models-dir <dir> --out-dir <dir> --report <json>
//                                                             scrub the OpenTune logs (tokens, serverProof,
//                                                             user names), copy them to --out-dir, assert that the
//                                                             F0 model was loaded from --models-dir, record the backend
//   record          --file <json> --step <name> --seconds <n> append one step timing
//   summary         --timings <json> [--contract <vitest json>] [--smoke <json>] [--log <report json>]
//                   [--mcp-ref <ref>] [--out <md>]            PASS / FAIL / SKIP / FLAKY-SKIP table; exit 1 on any FAIL
//
// Exit codes: 0 = ok, 1 = a check failed, 2 = usage error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, parseArgs } from './fork-lib.mjs';

/** Marker a skipped test carries in its name when it was skipped because of a known flaky environment. */
export const FLAKY_SKIP_MARKER = 'FLAKY-SKIP';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** sha256 of a file, streamed so the 230 MB installer is not read into one buffer. */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Problems (strings) with the installer file against the pin; empty when it matches. */
export function checkInstaller(pin, file) {
  const problems = [];
  if (!fs.existsSync(file)) return [`installer not found: ${path.basename(file)}`];
  const size = fs.statSync(file).size;
  if (pin.installer.size && size !== pin.installer.size) problems.push(`installer size ${size}, pinned ${pin.installer.size}`);
  const sha = sha256File(file);
  if (sha !== pin.installer.sha256) problems.push(`installer sha256 ${sha}, pinned ${pin.installer.sha256}`);
  return problems;
}

/** Problems with the installed models against the pin; empty when every model matches. */
export function checkModels(pin, dir) {
  const problems = [];
  for (const m of pin.models) {
    const file = path.join(dir, ...m.path.split('/'));
    if (!fs.existsSync(file)) {
      problems.push(`missing model: ${m.path}`);
      continue;
    }
    const sha = sha256File(file);
    if (sha !== m.sha256) problems.push(`${m.path}: sha256 ${sha}, pinned ${m.sha256}`);
  }
  return problems;
}

const SECRET_PATTERNS = [
  [/(bearer\s+)[A-Za-z0-9_\-+/=.]{8,}/gi, '$1<redacted>'],
  [/((?:session[-_ ]?)?token|server[-_ ]?proof|authorization|secret)(["']?\s*[:=]\s*["']?)[A-Za-z0-9_\-+/=.]{8,}/gi, '$1$2<redacted>'],
];

/** Redact session tokens, serverProof values and Windows user profile names from log text. */
export function scrubLog(text) {
  let out = String(text);
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out.replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/gi, '$1<user>');
}

const normPath = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The F0 model load line written by ModelFactory: `Loaded F0 model (<backend>): <path>`. */
export function parseModelLoad(text) {
  const loads = [];
  for (const m of String(text).matchAll(/Loaded F0 model \(([^)\r\n]*)\):\s*([^\r\n]+)/g)) loads.push({ backend: m[1].trim(), path: m[2].trim() });
  return loads;
}

/**
 * Inspect the (raw) log text: did the F0 model come from the official models directory, and which backend ran?
 * @returns {{ok: boolean, backend: string, f0ModelPath: string|null, problems: string[]}}
 */
export function inspectLog(text, modelsDir) {
  const loads = parseModelLoad(text);
  const problems = [];
  if (!loads.length) {
    return { ok: false, backend: 'unknown', f0ModelPath: null, problems: ['no "Loaded F0 model" line in the OpenTune log: the F0 model was never loaded'] };
  }
  const root = normPath(modelsDir);
  for (const l of loads) {
    const p = normPath(l.path);
    if (!p.startsWith(`${root}\\`)) problems.push(`F0 model loaded from ${l.path}, not from the official models directory`);
  }
  const last = loads[loads.length - 1];
  return { ok: problems.length === 0, backend: last.backend || 'unknown', f0ModelPath: last.path, problems };
}

/** Count vitest JSON-reporter results as PASS / FAIL / SKIP / FLAKY-SKIP. */
export function countVitest(report) {
  const c = { pass: 0, fail: 0, skip: 0, flakySkip: 0, failed: [] };
  for (const file of report.testResults ?? []) {
    const tests = file.assertionResults ?? [];
    if (!tests.length && file.status === 'failed') {
      c.fail += 1;
      c.failed.push(path.basename(String(file.name ?? 'test file')));
    }
    for (const t of tests) {
      const name = t.fullName ?? t.title ?? '';
      if (t.status === 'passed') c.pass += 1;
      else if (t.status === 'failed') {
        c.fail += 1;
        c.failed.push(name);
      } else if (name.includes(FLAKY_SKIP_MARKER)) c.flakySkip += 1;
      else c.skip += 1; // pending, skipped, todo, disabled
    }
  }
  return c;
}

/** Tally the smoke scenario report `{steps: [{name, status, ms}]}` the same way. */
export function countSmoke(report) {
  const c = { pass: 0, fail: 0, skip: 0, flakySkip: 0, failed: [] };
  for (const s of report.steps ?? []) {
    const st = String(s.status ?? '').toUpperCase();
    if (st === 'PASS') c.pass += 1;
    else if (st === 'FAIL') {
      c.fail += 1;
      c.failed.push(s.name);
    } else if (st === 'FLAKY-SKIP') c.flakySkip += 1;
    else c.skip += 1;
  }
  return c;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Render the job summary. A missing result (null) counts as a failure: a step that produced nothing
 * must not look like a pass.
 * @returns {{markdown: string, failed: boolean}}
 */
export function renderSummary({ timings = [], contract = null, smoke = null, log = null, mcpRef = '' }) {
  const lines = ['### e2e-windows', ''];
  let failed = false;
  const rows = [];
  const add = (name, c) => {
    if (c === null) {
      rows.push(`| ${name} | - | - | - | - | 没有结果文件（该步骤未运行或没有产出） |`);
      failed = true;
      return;
    }
    if (c.fail > 0) failed = true;
    rows.push(`| ${name} | ${c.pass} | ${c.fail} | ${c.skip} | ${c.flakySkip} | ${c.failed.length ? cell(c.failed.slice(0, 5).join('；')) : ''} |`);
  };
  add('契约向量', contract ? countVitest(contract) : null);
  add('冒烟场景', smoke ? countSmoke(smoke) : null);
  lines.push(`MCP 仓库 ref：\`${mcpRef || '(未记录)'}\``, '', '| 项目 | PASS | FAIL | SKIP | FLAKY-SKIP | 失败项（至多 5 个） |', '|---|---|---|---|---|---|', ...rows, '');
  if (log) {
    if (!log.ok) failed = true;
    lines.push(`后端：**${log.backend}**；F0 模型路径：\`${log.f0ModelPath ?? '(无)'}\`；modelsDir 指向官方安装：${log.ok ? 'PASS' : 'FAIL'}`);
    for (const p of log.problems ?? []) lines.push(`- ${cell(p)}`);
    lines.push('');
  } else {
    failed = true;
    lines.push('后端：未知（没有日志检查结果）', '');
  }
  lines.push('| 步骤 | 耗时（秒） |', '|---|---|');
  for (const t of timings) lines.push(`| ${cell(t.step)} | ${Number(t.seconds).toFixed(1)} |`);
  const smokeSteps = smoke?.steps ?? [];
  if (smokeSteps.length) {
    lines.push('', '冒烟场景分步耗时：', '', '| 步骤 | 结果 | 耗时（毫秒） |', '|---|---|---|');
    for (const s of smokeSteps) lines.push(`| ${cell(s.name)} | ${cell(s.status)} | ${s.ms ?? ''} |`);
  }
  lines.push('', failed ? '结果：**FAIL**' : '结果：**PASS**', '');
  return { markdown: lines.join('\n'), failed };
}

function usage(msg) {
  process.stderr.write(`e2e-windows: ${msg}\n`);
  process.exit(2);
}

const CLI_SPEC = {
  pin: 'string',
  file: 'string',
  dir: 'string',
  'log-dir': 'string',
  'models-dir': 'string',
  'out-dir': 'string',
  report: 'string',
  step: 'string',
  seconds: 'string',
  timings: 'string',
  contract: 'string',
  smoke: 'string',
  log: 'string',
  'mcp-ref': 'string',
  out: 'string',
};

function main(argv) {
  const [cmd, ...rest] = argv;
  let opts;
  try {
    opts = parseArgs(rest, CLI_SPEC).opts;
  } catch (e) {
    usage(e.message);
  }
  const need = (...names) => names.forEach((n) => opts[n] ?? usage(`--${n} is required for ${cmd}`));
  const report = (problems, okText) => {
    if (problems.length) {
      for (const p of problems) process.stdout.write(`::error::${p}\n`);
      process.exit(1);
    }
    process.stdout.write(`${okText}\n`);
  };
  switch (cmd) {
    case 'check-installer':
      need('pin', 'file');
      report(checkInstaller(readJson(opts.pin), opts.file), 'installer sha256 and size match the pin');
      break;
    case 'check-models': {
      need('pin', 'dir');
      const pin = readJson(opts.pin);
      report(checkModels(pin, opts.dir), `${pin.models.length} models match the pinned sha256`);
      break;
    }
    case 'check-log': {
      need('log-dir', 'models-dir', 'out-dir', 'report');
      const names = fs.existsSync(opts['log-dir']) ? fs.readdirSync(opts['log-dir']).filter((n) => n.toLowerCase().endsWith('.log')) : [];
      fs.mkdirSync(opts['out-dir'], { recursive: true });
      let all = '';
      for (const n of names) {
        const raw = fs.readFileSync(path.join(opts['log-dir'], n), 'utf8');
        all += `${raw}\n`;
        fs.writeFileSync(path.join(opts['out-dir'], n), scrubLog(raw));
      }
      const res = names.length ? inspectLog(all, opts['models-dir']) : { ok: false, backend: 'unknown', f0ModelPath: null, problems: ['no OpenTune log files found'] };
      fs.writeFileSync(opts.report, `${JSON.stringify(res, null, 2)}\n`);
      report(res.problems, `F0 model loaded from the official models directory; backend ${res.backend}; ${names.length} log file(s) scrubbed`);
      break;
    }
    case 'record': {
      need('file', 'step', 'seconds');
      const list = fs.existsSync(opts.file) ? readJson(opts.file) : [];
      list.push({ step: opts.step, seconds: Number(opts.seconds) });
      fs.writeFileSync(opts.file, `${JSON.stringify(list, null, 2)}\n`);
      break;
    }
    case 'summary': {
      need('timings');
      const opt = (f) => (f && fs.existsSync(f) ? readJson(f) : null);
      const { markdown, failed } = renderSummary({
        timings: opt(opts.timings) ?? [],
        contract: opt(opts.contract),
        smoke: opt(opts.smoke),
        log: opt(opts.log),
        mcpRef: opts['mcp-ref'] ?? '',
      });
      if (opts.out) fs.appendFileSync(opts.out, markdown);
      else process.stdout.write(markdown);
      process.exit(failed ? 1 : 0);
      break;
    }
    default:
      usage('unknown command (check-installer | check-models | check-log | record | summary)');
  }
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
