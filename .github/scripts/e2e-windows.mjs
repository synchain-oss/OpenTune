#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e-windows helper: the checks and reports around the e2e-windows workflow, kept in one testable
// place instead of inline workflow script.
//
//   check-installer --pin <json> --file <Setup.exe> [--version <x.y.z>]
//                                                             sha256 and size of the downloaded installer; --version picks
//                                                             one of olderInstallers[] instead of the main installer
//   models-dir      --pin <json> [--version <x.y.z>] [--app <install dir>]
//                                                             print where that installer puts the models ({app}, %VAR% expanded)
//   check-models    --pin <json> --dir <models dir>           every pinned model exists with the pinned sha256
//                   (the ::error:: lines of these two show the first 12 hex digits of each hash: a full hash would
//                   be redacted like a token, and both sides would read <redacted-hex>)
//   check-log       (--log-dir <dir> | --data-root <dir>) --models-dir <dir> --out-dir <dir> --report <json>
//                                                             --data-root: every *.log below it (one sub-directory per launch)
//                                                             scrub the OpenTune logs (tokens, serverProof,
//                                                             user names), copy them to --out-dir, assert that the
//                                                             F0 model was loaded from --models-dir, record the backend
//   scrub           --dir <dir>                               redact tokens, serverProof and user names in every json/log/md/txt file there
//   prune-screenshots --dir <dir> [--keep <n>]                keep the newest n (default 8) *.png there, delete the rest
//   has-scenario    --dir <dir> --scenario <name>             prints present or absent (exit 0 either way): is there a report of that scenario;
//                                                             any other exit code is a script error, which the workflow treats as a failure
//   record          --file <json> --step <name> --seconds <n> append one step timing
//   summary         --timings <json> [--contract <vitest json>] [--smoke <json>] [--scenarios-dir <dir>] [--log <report json>]
//                   [--mcp-ref <ref>] [--out <md>]            PASS / FAIL / SKIP / FLAKY-SKIP table; exit 1 on any FAIL.
//                   --scenarios-dir: one row per report there whose schema starts with opentune-mcp-e2e- (smoke excluded);
//                   a SKIP or FLAKY-SKIP in any scenario fails the run, except a SKIP that the ENVIRONMENT_SKIPS register
//                   below excuses (scenario, step and reason all match): it is counted as "environment SKIP", listed under
//                   the table with its register note, and does not fail. FLAKY-SKIP and the smoke scenario get no exception.
//                   manualChecks[] are listed under the table
//
// Exit codes: 0 = ok, 1 = a check failed, 2 = usage error.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, parseArgs } from './fork-lib.mjs';

/** Marker a skipped test carries in its name when it was skipped because of a known flaky environment. */
export const FLAKY_SKIP_MARKER = 'FLAKY-SKIP';

/** Schema prefix of the scenario reports the MCP repository's e2e runner writes. */
export const SCENARIO_SCHEMA_PREFIX = 'opentune-mcp-e2e-';

/**
 * Register of scenario steps whose SKIP is caused by the runner's environment, not by the build under test.
 * Only a SKIP step that matches an entry on all three keys is counted as an "environment SKIP" instead of a
 * failure: `scenario` is the scenario name of the report (its `scenario` field, or the file name without .json),
 * `step` is the exact step name, and `reason` is the fixed beginning of the step's `note`. If the runner
 * reports a different reason for the same step, the SKIP is not excused. FLAKY-SKIP is never excused.
 * `why` is the explanation of the entry (Chinese, shown in the job summary). It must say why the runner,
 * and not OpenTune, is the cause. Add an entry only for such a reason, one step at a time.
 * The smoke scenario and the contract vectors do not use this register.
 */
export const ENVIRONMENT_SKIPS = Object.freeze([
  Object.freeze({
    scenario: 'effects',
    step: 'vocoder weight: +30 cents, 2 weights',
    reason: 'only one vocoder weight is installed, so there is nothing to switch to',
    why: 'runner 上的官方安装只带一个声码器权重，没有第二个权重可以切换；这是 runner 的安装内容，不是 OpenTune 的行为',
  }),
  Object.freeze({
    scenario: 'wave-b-tour',
    step: 'audio.get and audio.set',
    reason: 'no audio device runs in the instance, so no audio setting can be changed',
    why: 'runner 是没有音频设备的虚拟机，实例里没有音频设备在运行，所以无法修改音频设置；这是 runner 的硬件条件，不是 OpenTune 的行为',
  }),
]);

/**
 * The register entry that excuses one scenario step, or null: the step has to be a SKIP (not FLAKY-SKIP, not
 * any other result) and its scenario name, step name and the beginning of its note all have to match.
 * @param {string|null} scenario scenario name; null (the smoke scenario) never matches
 * @param {{name?: string, result?: string, note?: string}} step
 */
export function findEnvironmentSkip(scenario, step) {
  if (!scenario || String(step?.result ?? '').toUpperCase() !== 'SKIP') return null;
  const note = String(step.note ?? '');
  return ENVIRONMENT_SKIPS.find((e) => e.scenario === scenario && e.step === step.name && note.startsWith(e.reason)) ?? null;
}

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

/**
 * First 12 hex digits of a hash, for problem lines: short enough to survive the hex redaction of scrubLog
 * (32 digits and more), long enough to tell two hashes apart.
 */
export const hashPrefix = (hex) => `${String(hex).slice(0, 12)}...`;

/**
 * The pinned installer of a version: the main `installer` when no version is given or it matches,
 * otherwise the entry of `olderInstallers[]` with that version; null when there is none.
 * platform 'macos': the entry of `macos.installers[]` with that version (the first one when no version is given).
 */
export function pinnedInstaller(pin, version, platform = 'windows') {
  if (platform === 'macos') {
    const list = pin.macos?.installers ?? [];
    return (version ? list.find((i) => i?.version === version) : list[0]) ?? null;
  }
  if (!version || pin.installer?.version === version) return pin.installer ?? null;
  return (pin.olderInstallers ?? []).find((i) => i?.version === version) ?? null;
}

/**
 * Where the pinned installer of a version puts the models: its own `modelsDir`, else the top-level one.
 * `{app}` stands for the install folder (official 1.7.9 installs the models there; 1.8.1 uses the shared
 * %ProgramData% folder), `%NAME%` for an environment variable. Null when the version is not pinned.
 */
export function pinnedModelsDir(pin, version, { appDir = '', env = process.env, platform = 'windows' } = {}) {
  const inst = pinnedInstaller(pin, version, platform);
  if (!inst) return null;
  const raw = String(inst.modelsDir ?? (platform === 'macos' ? pin.macos?.modelsDir : pin.modelsDir) ?? '');
  return raw.replace(/\{app\}/gi, appDir.replace(/[\\/]+$/, '')).replace(/%([A-Za-z0-9_()]+)%/g, (m, name) => env[name] ?? m);
}

/** Problems (strings) with the installer file against the pin; empty when it matches. */
export function checkInstaller(pin, file, version, platform = 'windows') {
  const problems = [];
  const inst = pinnedInstaller(pin, version, platform);
  if (!inst) return [`no pinned installer for version ${version}`];
  if (!fs.existsSync(file)) return [`installer not found: ${path.basename(file)}`];
  const size = fs.statSync(file).size;
  if (inst.size && size !== inst.size) problems.push(`installer size ${size}, pinned ${inst.size}`);
  const sha = sha256File(file);
  if (sha !== inst.sha256) problems.push(`installer sha256 ${hashPrefix(sha)}, pinned ${hashPrefix(inst.sha256)}`);
  return problems;
}

/** Problems with the installed models against the pin; empty when every model matches. A macOS section may list its own models. */
export function checkModels(pin, dir, platform = 'windows') {
  const problems = [];
  for (const m of (platform === 'macos' ? pin.macos?.models : null) ?? pin.models) {
    const file = path.join(dir, ...m.path.split('/'));
    if (!fs.existsSync(file)) {
      problems.push(`missing model: ${m.path}`);
      continue;
    }
    const size = fs.statSync(file).size;
    if (m.size && size !== m.size) {
      problems.push(`${m.path}: size ${size}, pinned ${m.size}`);
      continue;
    }
    const sha = sha256File(file);
    if (sha !== m.sha256) problems.push(`${m.path}: sha256 ${hashPrefix(sha)}, pinned ${hashPrefix(m.sha256)}`);
  }
  return problems;
}

const SECRET_PATTERNS = [
  [/(bearer\s+)[A-Za-z0-9_\-+/=.]{8,}/gi, '$1<redacted>'],
  [/((?:session[-_ ]?)?token|server[-_ ]?proof|authorization|secret)(\\*["']?\s*[:=]\s*\\*["']?)[A-Za-z0-9_\-+/=.]{8,}/gi, '$1$2<redacted>'],
  // Field-name independent: any 32-128 digit hex run (tokens, proofs, hashes, 40-digit commit ids; vitest prints
  // `expected '<hex>' to be '<hex>'` with no field name). The reports do not need commit ids.
  [/(?<![0-9A-Za-z])[0-9a-fA-F]{32,128}(?![0-9A-Za-z])/g, '<redacted-hex>'],
];

/** Redact session tokens, serverProof values and Windows and macOS user profile names from log text. */
export function scrubLog(text) {
  let out = String(text);
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1<user>');
  // macOS: /Users/<name>/... (but not the shared folder /Users/Shared)
  return out.replace(/(^|[^A-Za-z0-9_.-])(\/Users\/)(?!Shared(?:[\/\s"']|$))(?!<user>)[^\/\s"']+/g, '$1$2<user>');
}

/** Like scrubLog, and also folds a user profile directory (`C:\Users\<name>`) into `<home>`; for paths in errors and reports. */
export function scrubPath(text) {
  return scrubLog(text).replace(/[A-Za-z]:[\\/]+Users[\\/]+<user>/gi, '<home>').replace(/(^|[^A-Za-z0-9_.-])\/Users\/<user>/g, '$1<home>');
}

/** Text files that are scrubbed: known text extensions, plus files without an extension (preferences). */
const TEXT_FILE = /(\.(json|log|md|txt|xml|settings|ini|cfg|conf|properties|ya?ml)|^[^.]+)$/i;

/** Redact every json / log / md / txt / preferences file under a directory in place, so the uploaded artifact carries no secrets. Returns the files visited. */
export function scrubDir(dir) {
  const done = [];
  if (!fs.existsSync(dir)) return done;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !TEXT_FILE.test(e.name)) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const raw = fs.readFileSync(file, 'utf8');
    const out = scrubPath(raw);
    if (out !== raw) fs.writeFileSync(file, out);
    done.push(file);
  }
  return done;
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

/**
 * Tally the smoke scenario report `{result, counts: {PASS, FAIL, SKIP, 'FLAKY-SKIP'}, steps: [{name, result, ms, note}]}`.
 * The top-level `counts` win when present; the failed step names always come from `steps`.
 */
export function countSmoke(report) {
  const c = { pass: 0, fail: 0, skip: 0, flakySkip: 0, failed: [] };
  const top = report.counts && typeof report.counts === 'object' ? report.counts : null;
  for (const s of report.steps ?? []) {
    const st = String(s.result ?? '').toUpperCase();
    if (st === 'PASS') c.pass += 1;
    else if (st === 'FAIL') {
      c.fail += 1;
      c.failed.push(s.name);
    } else if (st === 'FLAKY-SKIP') c.flakySkip += 1;
    else c.skip += 1;
  }
  if (top) {
    const n = (k) => (Number.isFinite(Number(top[k])) ? Number(top[k]) : 0);
    c.pass = n('PASS');
    c.fail = Math.max(n('FAIL'), c.fail); // the larger of the top-level count and the steps tally
    c.skip = n('SKIP');
    c.flakySkip = n('FLAKY-SKIP');
  }
  if (String(report.result ?? '').toUpperCase() === 'FAIL' && c.fail === 0) {
    c.fail = 1;
    c.failed.push('report result is FAIL');
  }
  return c;
}

/**
 * Tally a scenario report like countSmoke, then move the SKIP steps that the ENVIRONMENT_SKIPS register excuses out of
 * `skip` into `envSkip` (listed in `envSkips`). `unexcused` names the other skipped steps (SKIP or any result that is
 * not PASS / FAIL / FLAKY-SKIP): they stay in `skip` and the caller fails the run. The number of remaining SKIPs is the
 * larger of the top-level count minus the excused steps and the number of unexcused steps, so a report whose
 * `counts` disagree with its `steps` cannot hide a skipped step.
 * @param {object} report scenario report
 * @param {string|null} scenario scenario name; null (the smoke scenario) excuses nothing
 */
export function countScenario(report, scenario) {
  const c = countSmoke(report);
  c.envSkips = [];
  c.unexcused = [];
  for (const s of report.steps ?? []) {
    const st = String(s.result ?? '').toUpperCase();
    if (st === 'PASS' || st === 'FAIL' || st === 'FLAKY-SKIP') continue;
    const entry = findEnvironmentSkip(scenario, s);
    if (entry) c.envSkips.push({ scenario, step: String(s.name ?? ''), note: String(s.note ?? ''), why: entry.why });
    else c.unexcused.push(String(s.name ?? ''));
  }
  c.envSkip = c.envSkips.length;
  c.skip = Math.max(c.skip - c.envSkip, c.unexcused.length);
  return c;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Render the job summary. A missing result (null) counts as a failure: a step that produced nothing
 * must not look like a pass.
 * @returns {{markdown: string, failed: boolean}}
 */
export function renderSummary({ timings = [], contract = null, smoke = null, scenarios = [], log = null, mcpRef = '' }) {
  const lines = ['### e2e-windows', ''];
  let failed = false;
  const rows = [];
  const envRows = [];
  const add = (name, c) => {
    if (c === null) {
      rows.push(`| ${name} | - | - | - | - | - | 没有结果文件（该步骤未运行或没有产出） |`);
      failed = true;
      return;
    }
    const envSkip = c.envSkip ?? 0;
    if (c.pass + c.fail + c.skip + c.flakySkip + envSkip === 0) {
      c.fail = 1;
      c.failed = ['没有任何测试或步骤'];
    }
    if (c.fail > 0) failed = true;
    rows.push(`| ${name} | ${c.pass} | ${c.fail} | ${c.skip} | ${c.flakySkip} | ${envSkip} | ${c.failed.length ? cell(c.failed.slice(0, 5).join('；')) : ''} |`);
    for (const e of c.envSkips ?? []) envRows.push(`| ${cell(e.scenario)} | ${cell(e.step)} | ${cell(e.note)} | ${cell(e.why)} |`);
  };
  add('契约向量', contract ? countVitest(contract) : null);
  // Unlike contract vectors (vectors with a `given` do not apply to the exe), a skipped scenario step is a step that did not run,
  // unless the ENVIRONMENT_SKIPS register excuses it (scenario != null). The smoke scenario passes null: nothing is excused there.
  const strict = (report, label, scenario) => {
    const c = countScenario(report, scenario);
    if (c.skip + c.flakySkip > 0) {
      if (c.fail === 0) c.fail = 1;
      c.failed.unshift(`${label}有未运行的步骤${c.unexcused.length ? `（未登记为环境原因，或原因与登记不符）：${c.unexcused.join('、')}` : ''}`);
    }
    return c;
  };
  add('冒烟场景', smoke ? strict(smoke, '冒烟', null) : null);
  const manual = [];
  for (const sc of scenarios) {
    const name = String(sc.scenario ?? sc.name ?? sc.file ?? '场景');
    add(`场景 ${name}`, strict(sc.report ?? sc, '场景', name));
    for (const m of (sc.report ?? sc).manualChecks ?? []) manual.push(`- ${name}：${typeof m === 'string' ? m : cell(JSON.stringify(m))}`);
  }
  lines.push(
    '契约向量的 SKIP 不计为失败：带 given 的向量在 exe 上不适用。冒烟与其他场景（边界、多实例、真实启动等）的 SKIP / FLAKY-SKIP 计为失败。',
    '唯一的例外是登记表（脚本里的 `ENVIRONMENT_SKIPS`）：场景步骤是 SKIP，且场景名、步骤名与原因都与登记项一致时，计入「环境原因 SKIP」，不算失败，并在表下逐条列出；同一步骤换了原因、未登记的步骤、冒烟场景与所有 FLAKY-SKIP 仍然失败。',
    '',
  );
  lines.push(`MCP 仓库 ref：\`${mcpRef || '(未记录)'}\``, '', '| 项目 | PASS | FAIL | SKIP | FLAKY-SKIP | 环境原因 SKIP | 失败项（至多 5 个） |', '|---|---|---|---|---|---|---|', ...rows, '');
  if (envRows.length) {
    lines.push('#### 环境原因 SKIP（已登记，不计为失败）', '', '| 场景 | 步骤 | 原因（报告原文） | 登记说明 |', '|---|---|---|---|', ...envRows, '');
  }
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
    for (const s of smokeSteps) lines.push(`| ${cell(s.name)} | ${cell(s.result)} | ${s.ms ?? ''} |`);
  }
  if (manual.length) lines.push('', '### 需要人工核对', '', ...manual);
  lines.push('', failed ? '结果：**FAIL**' : '结果：**PASS**', '');
  return { markdown: scrubPath(lines.join('\n')), failed };
}

/**
 * Scenario reports in a directory: every top-level *.json whose `schema` starts with `opentune-mcp-e2e-`
 * (boundary, instances, launch-real, effects, ...), except the files in `exclude` (the smoke report, which has its own row).
 */
export function loadScenarioReports(dir, exclude = []) {
  if (!dir || !fs.existsSync(dir)) return [];
  const skip = new Set(exclude.filter(Boolean).map((f) => path.resolve(f).toLowerCase()));
  const out = [];
  for (const n of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, n);
    if (!n.toLowerCase().endsWith('.json') || skip.has(path.resolve(full).toLowerCase()) || !fs.statSync(full).isFile()) continue;
    let report;
    try {
      report = readJson(full);
    } catch {
      continue; // other json files (timings, vitest report) have other shapes
    }
    if (report && typeof report.schema === 'string' && report.schema.startsWith(SCENARIO_SCHEMA_PREFIX)) out.push({ scenario: report.scenario ?? path.basename(n, '.json'), report, file: n });
  }
  return out;
}

/**
 * Whether the MCP runner wrote a report for the named scenario into dir: a scenario report (schema opentune-mcp-e2e-*)
 * whose `scenario` is the name or whose schema starts with opentune-mcp-e2e-<name>, or a file called <name>.json.
 */
export function hasScenarioReport(dir, name) {
  if (!dir || !name || !fs.existsSync(dir)) return false;
  const byContent = loadScenarioReports(dir).some((x) => x.scenario === name || x.report.schema.startsWith(`${SCENARIO_SCHEMA_PREFIX}${name}`));
  if (byContent) return true;
  const full = path.join(dir, `${name}.json`);
  return fs.existsSync(full) && fs.statSync(full).isFile();
}

/** How many desktop screenshots the diagnostics keep for upload (they are raw images and cannot be scrubbed). */
export const DEFAULT_KEEP_SCREENSHOTS = 8;

/**
 * Keep only the newest `keep` *.png files directly in dir (by modification time, ties broken by name) and delete the
 * rest, so the uploaded artifact stays small. Returns the deleted file names, oldest first.
 */
export function pruneScreenshots(dir, keep = DEFAULT_KEEP_SCREENSHOTS) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a positive integer, got ${keep}`);
  if (!dir || !fs.existsSync(dir)) return [];
  const shots = fs.readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.png'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  const doomed = shots.slice(keep).reverse().map((s) => s.n);
  for (const n of doomed) fs.rmSync(path.join(dir, n));
  return doomed;
}

/** *.log files directly in one directory. */
function listLogs(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.log')).map((n) => ({ full: path.join(dir, n), rel: n }));
}

/** Every *.log below root (a per-launch data directory holds them in Logs/), sorted by relative path. */
export function findLogs(root) {
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.name.toLowerCase().endsWith('.log')) out.push({ full: path.join(dir, e.name), rel: r });
    }
  };
  walk(root, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function usage(msg) {
  process.stderr.write(`e2e-windows: ${msg}\n`);
  process.exit(2);
}

const CLI_SPEC = {
  pin: 'string',
  platform: 'string',
  file: 'string',
  version: 'string',
  app: 'string',
  dir: 'string',
  'log-dir': 'string',
  'data-root': 'string',
  'models-dir': 'string',
  'out-dir': 'string',
  report: 'string',
  step: 'string',
  seconds: 'string',
  timings: 'string',
  contract: 'string',
  smoke: 'string',
  'scenarios-dir': 'string',
  log: 'string',
  'mcp-ref': 'string',
  scenario: 'string',
  keep: 'string',
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
  const platformOpt = () => {
    if (opts.platform !== undefined && opts.platform !== 'windows' && opts.platform !== 'macos') usage('--platform must be windows or macos');
    return opts.platform ?? 'windows';
  };
  const report = (problems, okText) => {
    if (problems.length) {
      for (const p of problems) process.stdout.write(`::error::${scrubPath(p)}\n`);
      process.exit(1);
    }
    process.stdout.write(`${okText}\n`);
  };
  switch (cmd) {
    case 'check-installer':
      need('pin', 'file');
      report(checkInstaller(readJson(opts.pin), opts.file, opts.version, platformOpt()), 'installer sha256 and size match the pin');
      break;
    case 'models-dir': {
      need('pin');
      const dir = pinnedModelsDir(readJson(opts.pin), opts.version, { appDir: opts.app ?? '', platform: platformOpt() });
      if (!dir) {
        process.stdout.write(`::error::no pinned installer for version ${opts.version}\n`);
        process.exit(1);
      }
      process.stdout.write(`${dir}\n`);
      break;
    }
    case 'check-models': {
      need('pin', 'dir');
      const pin = readJson(opts.pin);
      const platform = platformOpt();
      report(checkModels(pin, opts.dir, platform), `${((platform === 'macos' ? pin.macos?.models : null) ?? pin.models).length} models match the pinned sha256`);
      break;
    }
    case 'check-log': {
      need('models-dir', 'out-dir', 'report');
      if (!opts['log-dir'] && !opts['data-root']) usage('--log-dir or --data-root is required for check-log');
      const files = opts['data-root'] ? findLogs(opts['data-root']) : listLogs(opts['log-dir']);
      const names = files.map((f) => f.rel);
      fs.mkdirSync(opts['out-dir'], { recursive: true });
      let all = '';
      for (const f of files) {
        const raw = fs.readFileSync(f.full, 'utf8');
        all += `${raw}\n`;
        fs.writeFileSync(path.join(opts['out-dir'], f.rel.replace(/[\\/]+/g, '__')), scrubLog(raw));
      }
      const res = names.length ? inspectLog(all, opts['models-dir']) : { ok: false, backend: 'unknown', f0ModelPath: null, problems: ['no OpenTune log files found'] };
      res.problems = res.problems.map(scrubPath);
      if (res.f0ModelPath !== null) res.f0ModelPath = scrubPath(res.f0ModelPath);
      fs.writeFileSync(opts.report, `${JSON.stringify(res, null, 2)}\n`);
      report(res.problems, `F0 model loaded from the official models directory; backend ${res.backend}; ${names.length} log file(s) scrubbed`);
      break;
    }
    case 'scrub': {
      need('dir');
      process.stdout.write(`scrubbed ${scrubDir(opts.dir).length} file(s)\n`);
      break;
    }
    case 'prune-screenshots': {
      need('dir');
      const keep = opts.keep === undefined ? DEFAULT_KEEP_SCREENSHOTS : Number(opts.keep);
      if (!Number.isInteger(keep) || keep < 1) usage('--keep must be a positive integer');
      process.stdout.write(`kept the newest ${keep} screenshot(s), deleted ${pruneScreenshots(opts.dir, keep).length}\n`);
      break;
    }
    case 'has-scenario':
      need('dir', 'scenario');
      process.stdout.write(hasScenarioReport(opts.dir, opts.scenario) ? 'present\n' : 'absent\n');
      break;
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
        scenarios: loadScenarioReports(opts['scenarios-dir'], [opts.smoke]),
        log: opt(opts.log),
        mcpRef: opts['mcp-ref'] ?? '',
      });
      if (opts.out) fs.appendFileSync(opts.out, markdown);
      else process.stdout.write(markdown);
      process.exit(failed ? 1 : 0);
      break;
    }
    default:
      usage('unknown command (check-installer | models-dir | check-models | check-log | scrub | prune-screenshots | record | summary | has-scenario)');
  }
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
