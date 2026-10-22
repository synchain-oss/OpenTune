#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// doc-consistency: the developer documentation of the control API (Source/Control/README.md and the hook
// table of CLAUDE.md) must say what the code does. Four groups are compared; any difference is a problem
// and names the file and line to change:
//
//   methods  README method table <=> the methods the dispatcher registers (OpsRegistry.cpp and the
//            register<Group>Ops functions it calls, read statically) <=> the locked spec copy
//            (Tests/Control/spec/otcp/v1/methods/*.schema.json). Spec methods that nothing registers are listed
//            as "not implemented" (information, not a problem); a registered method the spec does not know is.
//   hooks    README hook list <=> the `// OpenTune Control API hook` markers in the code <=> the hook table of
//            CLAUDE.md: the files, the number of entries per file, and the identifiers a row names.
//   mirrors  MIRRORS.md <=> mirror-map.json <=> .github/drift-pins/* (the rules of drift-pins.mjs --check, called
//            as a library; whether a difference blocks follows its decideEnforcement).
//   tests    the test names README.md, CLAUDE.md and REVIEW-CHECKLIST.md (when it exists) mention <=> the ctest
//            names cmake/OpenTuneControl.cmake registers (add_test names and ControlProcessorTests.<Scenario>).
//
// fork-checks.mjs runs it as check `doc-consistency` (fork-gate and the local gates call fork-checks); it can also
// be run alone:
//   node doc-consistency.mjs [--rev <rev> | --index] [--json]
//       default: the working tree of the repository containing the current directory.
//       exit 0 = consistent, 1 = at least one problem, 2 = usage / git error
import fs from 'node:fs';
import path from 'node:path';
import { FIX_HINT, MIRRORS_MD, MIRROR_MAP, PIN_DIR, readMirrors, verifyConsistency } from './drift-pins.mjs';
import { isMainModule, listTreeFiles, parseArgs, readBlobs, repoTop, tryResolveCommit } from './fork-lib.mjs';

export const README = 'Source/Control/README.md';
export const CLAUDE_MD = 'CLAUDE.md';
export const REVIEW_CHECKLIST = 'Source/Control/REVIEW-CHECKLIST.md';
export const OPS_REGISTRY = 'Source/Control/Ops/OpsRegistry.cpp';
export const PROTOCOL_CPP = 'Source/Control/ControlProtocol.cpp';
export const SPEC_METHODS_DIR = 'Tests/Control/spec/otcp/v1/methods';
export const CONTROL_CMAKE = 'cmake/OpenTuneControl.cmake';
export const ROOT_CMAKE = 'CMakeLists.txt';
export const HOOK_MARKER = 'OpenTune Control API hook';
/** Methods that no register<Group>Ops function adds because the listener answers them itself. */
export const ANSWERED_ELSEWHERE = new Set(['session.hello']);
/** The ctest group of the processor scenarios: add_test(NAME ControlProcessorTests.<Scenario>). */
export const SCENARIO_PREFIX = 'ControlProcessorTests';
/** Where the hook markers are not hooks: the new code itself, the tests and the fork's own files. */
const MARKER_SCAN_EXCLUDE = ['Source/Control/', 'Source/Standalone/ControlEditorBridge'];

const METHOD_RE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const CAPABILITY_RE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;

// ---------------------------------------------------------------------------------------------
// Sources: the same reading interface over the working tree, a git revision (or the index) and memory
// ---------------------------------------------------------------------------------------------

/**
 * A source reads repository files by '/'-separated path.
 * @typedef {{ read(p: string): string | null, list(dir: string): string[], readMany(ps: string[]): Map<string, string | null> }} DocSource
 */

/** Source over an object { path: text } (tests). */
export function memorySource(files) {
  const map = new Map(Object.entries(files));
  return {
    read: (p) => (map.has(p) ? String(map.get(p)) : null),
    list: (dir) => [...map.keys()].filter((p) => p === dir || p.startsWith(`${dir.replace(/\/+$/, '')}/`)).sort(),
    readMany: (ps) => new Map(ps.map((p) => [p, map.has(p) ? String(map.get(p)) : null])),
  };
}

/** Source over the working tree below `root`. */
export function fsSource(root) {
  const read = (p) => {
    try {
      return fs.readFileSync(path.join(root, ...p.split('/')), 'utf8').replace(/^\uFEFF/, '');
    } catch {
      return null;
    }
  };
  const walk = (rel, out) => {
    const abs = path.join(root, ...rel.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(child, out);
      } else out.push(child);
    }
  };
  return {
    read,
    list: (dir) => {
      const out = [];
      const rel = dir.replace(/\/+$/, '');
      if (fs.existsSync(path.join(root, ...rel.split('/'))) && fs.statSync(path.join(root, ...rel.split('/'))).isFile()) return [rel];
      walk(rel, out);
      return out.sort();
    },
    readMany: (ps) => new Map(ps.map((p) => [p, read(p)])),
  };
}

/** Source over a commit of the repository at `top`; rev null/'' reads the index. */
export function gitSource(top, rev) {
  const spec = (p) => (rev ? `${rev}:${p}` : `:${p}`);
  const cache = new Map();
  const readMany = (ps) => {
    const need = ps.filter((p) => !cache.has(p));
    if (need.length) {
      const blobs = readBlobs(top, need.map(spec));
      for (const p of need) {
        const buf = blobs.get(spec(p));
        cache.set(p, buf ? buf.toString('utf8').replace(/^\uFEFF/, '') : null);
      }
    }
    return new Map(ps.map((p) => [p, cache.get(p)]));
  };
  return {
    read: (p) => readMany([p]).get(p),
    list: (dir) => listTreeFiles(top, rev || null, dir.replace(/\/+$/, '')),
    readMany,
  };
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

const splitLines = (text) => String(text).split(/\r?\n/);

/** Line number (1-based) of a character index, from a precomputed table of line starts. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (idx) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Lines of the section that starts at the first heading matching `heading` and ends at the next heading of the same or a higher level. */
export function sectionOf(text, heading) {
  const lines = splitLines(text);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return { headingLine: start + 1, lines: lines.slice(start + 1, end).map((t, i) => ({ n: start + 2 + i, text: t })) };
}

/** Cells of one markdown table row; a `|` inside backticks or written `\|` does not split. */
export function splitRow(line) {
  const t = line.trim();
  const cells = [];
  let cur = '';
  let tick = false;
  const body = t.replace(/^\|/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '`') tick = !tick;
    if (c === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|' && !tick) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' || !/\|\s*$/.test(t)) cells.push(cur.trim());
  return cells;
}

/** The data rows of the first markdown table in `lines` ([{n, text}]); the header and the separator are skipped. */
export function tableRows(lines) {
  const rows = [];
  let seenSeparator = false;
  let inTable = false;
  for (const { n, text } of lines) {
    if (!/^\s*\|/.test(text)) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = splitRow(text);
    if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      seenSeparator = true;
      continue;
    }
    if (!seenSeparator) continue; // header
    rows.push({ n, cells });
  }
  return rows;
}

/** Backticked code spans of a cell. */
export const codeSpans = (cell) => [...String(cell ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------
// C++ helpers (static, comment-aware)
// ---------------------------------------------------------------------------------------------

/** Comments become spaces (newlines stay), so indexes and line numbers are those of the original text. */
export function stripCppComments(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  const blank = (s) => s.replace(/[^\r\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      const stop = e < 0 ? n : e;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const stop = e < 0 ? n : e + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '"') {
      const stop = stringEnd(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else if (c === "'" && !/[0-9A-Za-z]/.test(text[i - 1] ?? '')) {
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, n);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just after the string literal that starts at `i` (a `"`), raw strings included. */
function stringEnd(text, i) {
  if (text[i - 1] === 'R') {
    const open = text.indexOf('(', i);
    if (open > 0) {
      const close = text.indexOf(`)${text.slice(i + 1, open)}"`, open);
      if (close > 0) return close + (open - i - 1) + 2;
    }
  }
  let j = i + 1;
  while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

/** Index of the bracket that closes the one at `open` in comment-stripped text, or -1. */
export function matchClose(text, open) {
  const o = text[open];
  const c = { '(': ')', '{': '}', '[': ']' }[o];
  let depth = 0;
  for (let i = open; i < text.length; ) {
    if (text[i] === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (text[i] === "'" && !/[0-9A-Za-z]/.test(text[i - 1] ?? '')) {
      let j = i + 1;
      while (j < text.length && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
    i++;
  }
  return -1;
}

/**
 * The register<Group>Ops(ControlMethodTable& table) functions of one C++ file: each with the methods it adds
 * (the first string literal of every `table.add(...)`) and the register functions it calls.
 * @returns {Map<string, {line: number, adds: {method: string|null, line: number}[], calls: {name: string, line: number}[]}>}
 */
export function parseRegisterFunctions(source) {
  const text = stripCppComments(source);
  const lineAt = lineIndex(text);
  const found = new Map();
  const re = /\bvoid\s+(register\w+)\s*\(\s*ControlMethodTable\s*&\s*(\w+)\s*\)\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open);
    if (close < 0) continue;
    const body = text.slice(open, close);
    const base = open;
    const table = m[2];
    const adds = [];
    const addRe = new RegExp(`\\b${table}\\s*\\.\\s*add\\s*\\(`, 'g');
    for (let a = addRe.exec(body); a; a = addRe.exec(body)) {
      const argOpen = base + a.index + a[0].length - 1;
      const argClose = matchClose(text, argOpen);
      const args = argClose < 0 ? '' : text.slice(argOpen, argClose);
      const lit = /"([^"\\]*)"/.exec(args);
      adds.push({ method: lit ? lit[1] : null, line: lineAt(base + a.index) });
    }
    const calls = [];
    const callRe = new RegExp(`\\b(register\\w+)\\s*\\(\\s*${table}\\s*\\)\\s*;`, 'g');
    for (let c = callRe.exec(body); c; c = callRe.exec(body)) calls.push({ name: c[1], line: lineAt(base + c.index) });
    found.set(m[1], { line: lineAt(m.index), adds, calls });
  }
  return found;
}

/** Entries { a, b, line } of a constexpr table `name[] = { {"a", "b"}, ... };`. */
export function parsePairTable(source, name) {
  const text = stripCppComments(source);
  const lineAt = lineIndex(text);
  const at = new RegExp(`\\b${name}\\s*\\[\\s*\\]\\s*=\\s*\\{`).exec(text);
  if (!at) return null;
  const open = at.index + at[0].length - 1;
  const close = matchClose(text, open);
  if (close < 0) return null;
  const body = text.slice(open, close);
  const out = [];
  for (const m of body.matchAll(/\{\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\}/g)) out.push({ a: m[1], b: m[2], line: lineAt(open + m.index) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Group 1: methods
// ---------------------------------------------------------------------------------------------

/** Rows of the README method table. */
export function parseMethodTable(readme) {
  const problems = [];
  const sec = sectionOf(readme, /^##\s+Method table\s*$/);
  if (!sec) return { rows: [], problems: [`${README}：找不到「## Method table」小节`] };
  const rows = [];
  for (const { n, cells } of tableRows(sec.lines)) {
    const method = codeSpans(cells[0])[0];
    if (!method || !METHOD_RE.test(method)) {
      problems.push(`${README}:${n}：方法表第一列应以 \`<方法名>\` 开头，实际是「${(cells[0] ?? '').slice(0, 40)}」`);
      continue;
    }
    // Any .cpp path under Source/Control that registerMethods scans (subdirectories and `-` in file names included).
    const ops = codeSpans(cells[2]).find((s) => /^[\w/.-]+\.cpp$/.test(s)) ?? null;
    const schema = codeSpans(cells[4])[0] ?? null;
    rows.push({
      n,
      method,
      capability: codeSpans(cells[1])[0] ?? null,
      ops,
      answeredElsewhere: /^answered by\b/i.test(cells[2] ?? ''),
      schema,
      testsCell: cells[3] ?? '',
    });
  }
  return { rows, problems };
}

/**
 * The methods the dispatcher registers: OpsRegistry.cpp's registerControlMethods calls (comments ignored)
 * register<Group>Ops functions, defined anywhere under Source/Control, whose table.add calls name the methods.
 * @returns {{ methods: Map<string, {file: string, line: number}>, problems: string[], notes: string[] }}
 */
export function registeredMethods(src) {
  const problems = [];
  const notes = [];
  const methods = new Map();
  const registry = src.read(OPS_REGISTRY);
  if (registry == null) return { methods, problems: [`${OPS_REGISTRY} 不存在，无法读出已注册的方法`], notes };
  const defs = new Map(); // function name -> {file, ...}
  const files = src.list('Source/Control').filter((f) => /\.cpp$/.test(f));
  const texts = src.readMany(files);
  for (const f of files) {
    for (const [name, info] of parseRegisterFunctions(texts.get(f) ?? '')) {
      if (defs.has(name) && name !== 'registerControlMethods') problems.push(`${f}:${info.line}：${name} 在 ${defs.get(name).file} 里也定义了`);
      defs.set(name, { file: f, ...info });
    }
  }
  const root = defs.get('registerControlMethods');
  if (!root || root.file !== OPS_REGISTRY) {
    return { methods, problems: [...problems, `${OPS_REGISTRY}：找不到 void registerControlMethods(ControlMethodTable& table) 的定义`], notes };
  }
  const visited = new Set(['registerControlMethods']);
  const visit = (name, from) => {
    const def = defs.get(name);
    if (!def) {
      problems.push(`${from.file}:${from.line}：调用了 ${name}(table)，但 Source/Control 下找不到它的定义`);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    for (const add of def.adds) {
      if (add.method == null) {
        problems.push(`${def.file}:${add.line}：table.add(...) 里找不到字符串形式的方法名，无法核对`);
        continue;
      }
      if (methods.has(add.method)) {
        const first = methods.get(add.method);
        problems.push(`${def.file}:${add.line}：${add.method} 已在 ${first.file}:${first.line} 注册过`);
        continue;
      }
      methods.set(add.method, { file: def.file, line: add.line });
    }
    for (const call of def.calls) visit(call.name, { file: def.file, line: call.line });
  };
  for (const call of root.calls) visit(call.name, { file: OPS_REGISTRY, line: call.line });
  const unwired = [...defs.keys()].filter((n) => n !== 'registerControlMethods' && !visited.has(n));
  if (unwired.length) notes.push(`未接线的注册函数（定义了但 ${OPS_REGISTRY} 没有调用）：${unwired.map((n) => `${n}（${defs.get(n).file}:${defs.get(n).line}）`).join('、')}`);
  // The comment at the end of each call line says which methods the group registers.
  const registryLines = splitLines(registry);
  const registryCalls = root.calls.map((call) => {
    const line = registryLines[call.line - 1] ?? '';
    const at = line.indexOf('//');
    return {
      ...call,
      comment: at >= 0 ? line.slice(at + 2) : '',
      methods: new Set((defs.get(call.name)?.adds ?? []).map((a) => a.method).filter((m) => m != null)),
    };
  });
  return { methods, problems, notes, registryCalls };
}

/** The spec copy's method schemas: Map method -> {file, capability}. */
export function specMethods(src) {
  const problems = [];
  const out = new Map();
  const files = src.list(SPEC_METHODS_DIR).filter((f) => /\.schema\.json$/.test(f));
  const texts = src.readMany(files);
  if (!files.length) problems.push(`${SPEC_METHODS_DIR}/ 下没有 *.schema.json，无法核对规范里的方法`);
  for (const f of files) {
    const name = path.posix.basename(f).replace(/\.schema\.json$/, '');
    let tag = null;
    try {
      tag = JSON.parse(texts.get(f) ?? '')['x-otcp'] ?? null;
    } catch (e) {
      problems.push(`${f}：不是合法的 JSON（${e.message}）`);
      continue;
    }
    if (!tag || tag.method !== name) problems.push(`${f}：x-otcp.method 是「${tag?.method}」，与文件名 ${name} 不一致`);
    out.set(name, { file: f, capability: tag?.capability ?? null });
  }
  return { methods: out, problems };
}

/** The capabilities sentence of the README: `capability of every registered method (now `a`, `b` and `c`)`. */
export function parseCapabilitySentence(readme) {
  const sec = sectionOf(readme, /^##\s+Capabilities and protocol versions\s*$/);
  if (!sec) return null;
  const flat = sec.lines.map((l) => l.text).join(' ');
  const m = /capability of every registered method \(now ([^)]*)\)/.exec(flat);
  if (!m) return { line: sec.headingLine, capabilities: null };
  const line = sec.lines.find((l) => l.text.includes('capability of every registered method'))?.n ?? sec.headingLine;
  return { line, capabilities: new Set(codeSpans(m[1])) };
}

function checkMethods(src, texts) {
  const problems = [];
  const notes = [];
  const readme = texts.readme;
  const table = parseMethodTable(readme);
  problems.push(...table.problems);
  const reg = registeredMethods(src);
  problems.push(...reg.problems);
  notes.push(...reg.notes);
  const spec = specMethods(src);
  problems.push(...spec.problems);

  // The comment at the end of a registration line of OpsRegistry.cpp lists the group's methods: when it names
  // methods at all, it names the ones the group registers.
  const prefixes = new Set([...spec.methods.keys(), ...reg.methods.keys()].map((m) => m.split('.')[0]));
  for (const call of reg.registryCalls ?? []) {
    const claimed = new Set(
      [...call.comment.matchAll(/\b([a-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)\b/g)]
        .filter((m) => prefixes.has(m[1]))
        .map((m) => m[0])
        .filter((m) => !ANSWERED_ELSEWHERE.has(m)),
    );
    if (!claimed.size) continue;
    const extra = [...claimed].filter((m) => !call.methods.has(m));
    const missing = [...call.methods].filter((m) => !claimed.has(m));
    if (extra.length || missing.length) {
      problems.push(`${OPS_REGISTRY}:${call.line}：${call.name} 这一行的注释与它实际注册的方法不一致（注释多写：${extra.join('、') || '无'}；注释漏写：${missing.join('、') || '无'}）`);
    }
  }

  const protocolText = src.read(PROTOCOL_CPP);
  const kMethods = protocolText == null ? null : parsePairTable(protocolText, 'kMethods');
  if (!kMethods) problems.push(`${PROTOCOL_CPP}：找不到 kMethods[] 表，无法核对方法的能力位`);
  const capabilityOf = new Map((kMethods ?? []).map((e) => [e.a, { capability: e.b, line: e.line }]));

  // README <=> registered
  const rowOf = new Map();
  for (const row of table.rows) {
    if (rowOf.has(row.method)) problems.push(`${README}:${row.n}：方法表里 ${row.method} 列了两次（另一行是 ${rowOf.get(row.method).n}）`);
    else rowOf.set(row.method, row);
  }
  for (const [method, where] of reg.methods) {
    if (!rowOf.has(method)) problems.push(`${README}：方法表缺少 ${method}（${where.file}:${where.line} 已注册）；在「## Method table」末尾加一行`);
  }
  for (const row of table.rows) {
    if (reg.methods.has(row.method)) continue;
    if (ANSWERED_ELSEWHERE.has(row.method)) continue;
    problems.push(`${README}:${row.n}：方法表列了 ${row.method}，但 ${OPS_REGISTRY} 没有注册它；方法实现后再列，或删掉这一行`);
  }

  // registered / README rows <=> spec, protocol table
  for (const [method, where] of reg.methods) {
    if (spec.methods.size && !spec.methods.has(method)) problems.push(`${where.file}:${where.line}：注册了 ${method}，但锁定的规范副本里没有 ${SPEC_METHODS_DIR}/${method}.schema.json`);
    if (kMethods && !capabilityOf.has(method)) problems.push(`${where.file}:${where.line}：注册了 ${method}，但 ${PROTOCOL_CPP} 的 kMethods 里没有它（运行时 table.add 会断言失败）`);
  }
  for (const e of kMethods ?? []) {
    if (spec.methods.size && !spec.methods.has(e.a)) problems.push(`${PROTOCOL_CPP}:${e.line}：kMethods 里的 ${e.a} 不在规范副本里`);
    const s = spec.methods.get(e.a);
    if (s && s.capability && s.capability !== e.b) problems.push(`${PROTOCOL_CPP}:${e.line}：${e.a} 的能力位是 ${e.b}，规范（${s.file}）是 ${s.capability}`);
  }
  const unimplemented = [...spec.methods.keys()].filter((m) => !reg.methods.has(m) && !ANSWERED_ELSEWHERE.has(m)).sort();

  // README columns
  for (const row of table.rows) {
    const known = capabilityOf.get(row.method);
    if (known && row.capability !== known.capability) {
      problems.push(`${README}:${row.n}：${row.method} 的能力列是 ${row.capability ?? '(空)'}，${PROTOCOL_CPP}:${known.line} 的 kMethods 是 ${known.capability}`);
    }
    if (!known && row.capability && !CAPABILITY_RE.test(row.capability)) problems.push(`${README}:${row.n}：${row.method} 的能力列「${row.capability}」不像能力位`);
    const where = reg.methods.get(row.method);
    if (where) {
      const want = where.file.replace(/^Source\/Control\//, '');
      if (!row.ops) problems.push(`${README}:${row.n}：${row.method} 的 Ops 文件列应以 \`${want}\` 开头（${where.file}:${where.line} 注册）`);
      else if (row.ops !== want) problems.push(`${README}:${row.n}：${row.method} 的 Ops 文件列是 ${row.ops}，但它在 ${where.file}:${where.line} 注册`);
    } else if (ANSWERED_ELSEWHERE.has(row.method) && !row.answeredElsewhere) {
      problems.push(`${README}:${row.n}：${row.method} 由监听端自己回答，Ops 文件列应写 "answered by ..."`);
    }
    const want = `methods/${row.method}.schema.json`;
    if (row.schema !== want) problems.push(`${README}:${row.n}：${row.method} 的 Schema 列是「${row.schema ?? '(空)'}」，应为 \`${want}\``);
    else if (spec.methods.size && !spec.methods.has(row.method)) problems.push(`${README}:${row.n}：${row.method} 的 Schema 列指向 ${want}，规范副本里没有这个文件`);
  }

  // capability list sentence
  const sentence = parseCapabilitySentence(readme);
  if (!sentence) problems.push(`${README}：找不到「## Capabilities and protocol versions」小节`);
  else if (!sentence.capabilities) {
    problems.push(`${README}:${sentence.line}：找不到「capability of every registered method (now \`a\`, \`b\` ...)」这句话，无法核对能力清单；保持这个写法`);
  } else {
    const expected = new Set();
    for (const method of reg.methods.keys()) {
      const c = capabilityOf.get(method)?.capability;
      if (c) expected.add(c);
    }
    const registry = src.read(OPS_REGISTRY) ?? '';
    for (const e of parsePairTable(registry, 'kFeatureCapabilities') ?? []) if (expected.has(e.b)) expected.add(e.a);
    expected.delete('session.v1');
    const listed = new Set(sentence.capabilities);
    listed.delete('session.v1');
    for (const c of [...expected].sort()) if (!listed.has(c)) problems.push(`${README}:${sentence.line}：能力清单缺少 ${c}（有已注册的方法用它）`);
    for (const c of [...listed].sort()) if (!expected.has(c)) problems.push(`${README}:${sentence.line}：能力清单列了 ${c}，但没有已注册的方法用它`);
  }

  return { problems, notes, stats: { readme: table.rows.length, registered: reg.methods.size, spec: spec.methods.size }, unimplemented };
}

// ---------------------------------------------------------------------------------------------
// Group 2: hooks
// ---------------------------------------------------------------------------------------------

/** Files a hook-table cell names; `X.h/.cpp`, `X.*` and a bare `Y.cpp` after a path (same folder) are expanded. */
export function hookFilesOf(cell) {
  const files = [];
  let dir = '';
  for (const t of codeSpans(cell)) {
    let m;
    if ((m = /^(.+)\.\*$/.exec(t))) {
      files.push(`${m[1]}.h`, `${m[1]}.cpp`);
      dir = path.posix.dirname(m[1]);
    } else if ((m = /^(.+)\.(h|hpp)\/\.(cpp|cc|mm)$/.exec(t))) {
      files.push(`${m[1]}.${m[2]}`, `${m[1]}.${m[3]}`);
      dir = path.posix.dirname(m[1]);
    } else if (/\.(h|hpp|cpp|cc|mm|txt|cmake)$/.test(t) && /^[\w./-]+$/.test(t)) {
      if (t.includes('/')) {
        files.push(t);
        dir = path.posix.dirname(t);
      } else if (t === ROOT_CMAKE) files.push(t);
      else if (dir) files.push(`${dir}/${t}`);
    }
  }
  return [...new Set(files)];
}

/** Identifier segments a code span names (`a->b()` gives a and b); null for spans that are not checked. */
export function identifiersOf(span) {
  if (/^#include\b/.test(span)) return { literal: span };
  if (/^friend class \w+;?$/.test(span)) return { literal: span };
  if (/\//.test(span) || /^#/.test(span)) return null;
  const head = /^[A-Za-z_][\w]*(?:(?:->|::|\.)[A-Za-z_]\w*)*/.exec(span);
  if (!head) return null;
  const segments = head[0].split(/->|::|\./).filter((s) => s.length >= 3);
  return segments.length ? { segments } : null;
}

/**
 * Where a hook sits, as the File column of the README list says it in words, and how a marker proves it
 * (see scanHookMarkers). The wording is the one the list uses; a row with none of these words claims nothing.
 */
export const POSITION_CLAIMS = [
  { key: 'include', re: /\bincludes?\b/i, says: 'include', holds: (m) => m.isInclude },
  { key: 'destructor', re: /first statement of the destructor/i, says: 'first statement of the destructor', holds: (m) => m.afterDestructor },
  { key: 'constructor', re: /end of the constructor/i, says: 'end of the constructor', holds: (m) => m.beforeFunctionEnd && !m.afterDestructor },
  { key: 'class', re: /end of the class/i, says: 'end of the class', holds: (m) => m.nearClassEnd },
  { key: 'public', re: /end of the public section/i, says: 'end of the public section', holds: (m) => m.nearSectionEnd },
  { key: 'file', re: /\(end\)/i, says: '(end)', holds: (m) => m.nearFileEnd },
];

/** README hook rows: [{n, files, spans, claims, text}] */
export function parseReadmeHooks(readme) {
  const sec = sectionOf(readme, /^##\s+Hooks\s*$/);
  if (!sec) return { rows: [], text: '', problems: [`${README}：找不到「## Hooks」小节`] };
  const rows = [];
  for (const { n, cells } of tableRows(sec.lines)) {
    const files = codeSpans(cells[0]).filter((s) => /^(Source\/[\w./-]+|CMakeLists\.txt|cmake\/[\w.-]+)$/.test(s));
    rows.push({
      n,
      files,
      spans: [...codeSpans(cells[0]).filter((s) => !files.includes(s)), ...codeSpans(cells[1])],
      claims: POSITION_CLAIMS.filter((c) => c.re.test((cells[0] ?? '').replace(/`[^`]*`/g, ''))),
      text: cells.join(' | '),
    });
  }
  return { rows, text: sec.lines.map((l) => l.text).join('\n'), problems: [], headingLine: sec.headingLine };
}

/** CLAUDE.md hook table rows: [{n, files, spans}] — the table after the line "已声明的钩子". */
export function parseClaudeHooks(claude) {
  const lines = splitLines(claude).map((text, i) => ({ n: i + 1, text }));
  const at = lines.findIndex((l) => /已声明的钩子/.test(l.text));
  if (at < 0) return { rows: [], problems: [`${CLAUDE_MD}：找不到「已声明的钩子」（钩子表前的说明行）`] };
  const rows = [];
  for (const { n, cells } of tableRows(lines.slice(at + 1))) {
    rows.push({ n, files: hookFilesOf(cells[1]), spans: codeSpans(cells[0]) });
  }
  return { rows, problems: [] };
}

/** Words of a hook marker's purpose that carry the meaning: the English words, without the stop words. */
const PURPOSE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'its', 'not', 'are', 'but', 'all', 'can', 'own', 'one', 'two',
  'six', 'seven', 'once', 'here', 'them', 'then', 'than', 'into', 'only', 'also', 'each', 'per', 'use', 'used', 'when',
  'which', 'have', 'has', 'was', 'were', 'been', 'they', 'their', 'there', 'after', 'before', 'under', 'over', 'some',
  'any', 'other', 'such', 'more', 'most', 'much', 'many', 'same', 'both', 'few', 'out', 'off', 'too', 'very', 'just',
  'now', 'new', 'old', 'see', 'let', 'via', 'yet', 'still', 'down', 'back', 'well', 'way', 'even', 'take', 'make',
  'call', 'run', 'add', 'part', 'place', 'kind', 'state', 'open', 'close', 'stop', 'start', 'first', 'last', 'name',
  'names', 'called', 'code', 'line', 'lines', 'member', 'members', 'true', 'false', 'null', 'class', 'public',
  'private', 'include', 'includes', 'hook', 'opentune', 'control', 'api', 'type',
]);

/** The purpose a hook marker states: the text between the marker and the "see ...#hooks" part. */
export function purposeOf(joined) {
  return joined
    .replace(new RegExp(`^\\s*(?://|#)\\s*${HOOK_MARKER}:\\s*`), '')
    .replace(/,\s*see Source\/Control\/README\.md#hooks\s*$/, '')
    .trim();
}

/** The meaningful words of a purpose, lower case, without duplicates. */
export function purposeWords(purpose) {
  return [...new Set((String(purpose ?? '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !PURPOSE_STOP_WORDS.has(w)))];
}

/**
 * The hook markers in the code: lines of `// OpenTune Control API hook` (or `# ...` in CMake) in upstream files.
 * A marker that spans several comment lines is joined until the "see Source/Control/README.md#hooks" part.
 */
export function scanHookMarkers(src) {
  const candidates = [ROOT_CMAKE, ...src.list('cmake'), ...src.list('Source')]
    .filter((f) => /\.(h|hpp|cpp|cc|mm|inl|txt|cmake)$/.test(f))
    .filter((f) => !MARKER_SCAN_EXCLUDE.some((p) => f.startsWith(p)));
  const texts = src.readMany([...new Set(candidates)]);
  const markers = [];
  for (const [file, text] of texts) {
    if (text == null || !text.includes(HOOK_MARKER)) continue;
    const lines = splitLines(text);
    lines.forEach((line, i) => {
      if (!new RegExp(`(?://|#)\\s*${HOOK_MARKER}\\b`).test(line)) return;
      let joined = line;
      for (let k = 1; k <= 4 && !/README\.md#hooks/.test(joined); k++) {
        const next = lines[i + k];
        if (next == null || !/^\s*(\/\/|#)/.test(next)) break;
        joined += ` ${next.replace(/^\s*(\/\/|#)\s*/, '')}`;
      }
      const before = lines.slice(Math.max(0, i - 4), i).join('\n');
      const after = lines.slice(i + 1, i + 61);
      const within = (n, re) => after.slice(0, n).some((l) => re.test(l));
      markers.push({
        file,
        line: i + 1,
        wellFormed: /OpenTune Control API hook:\s*\S[\s\S]*,\s*see Source\/Control\/README\.md#hooks/.test(joined),
        purpose: purposeOf(joined),
        // Position facts (the README says where each hook is in words; POSITION_CLAIMS maps the words to these).
        // These are loose heuristics (end of class, end of file, first statement of the destructor are judged by
        // nearby lines only): they catch clearly wrong positions and can miss a wrong one, but never flag a right one.
        isInclude: /^\s*#\s*include\b/.test(line),
        afterDestructor: /::~\w+\s*\(/.test(before),
        beforeFunctionEnd: within(6, /^\}/),
        nearClassEnd: within(60, /^\};/),
        nearSectionEnd: within(12, /^\s*(?:private|protected)\s*:|^\};/),
        nearFileEnd: i + 1 > lines.length - 40,
      });
    });
  }
  return markers;
}

function checkHooks(src, texts) {
  const problems = [];
  const readmeHooks = parseReadmeHooks(texts.readme);
  problems.push(...readmeHooks.problems);
  const claudeHooks = texts.claude == null ? { rows: [], problems: [`${CLAUDE_MD} 不存在，无法核对钩子表`] } : parseClaudeHooks(texts.claude);
  problems.push(...claudeHooks.problems);
  const markers = scanHookMarkers(src);

  const markersByFile = new Map();
  for (const m of markers) markersByFile.set(m.file, [...(markersByFile.get(m.file) ?? []), m]);
  for (const m of markers) {
    if (!m.wellFormed) problems.push(`${m.file}:${m.line}：钩子标记应写成「// ${HOOK_MARKER}: <用途>, see Source/Control/README.md#hooks」`);
  }
  const rowsByFile = (rows) => {
    const map = new Map();
    for (const r of rows) for (const f of r.files) map.set(f, [...(map.get(f) ?? []), r]);
    return map;
  };
  const readmeByFile = rowsByFile(readmeHooks.rows);
  const claudeByFile = rowsByFile(claudeHooks.rows);
  const where = (rows) => rows.map((r) => r.n).join('、');

  for (const r of readmeHooks.rows) if (!r.files.length) problems.push(`${README}:${r.n}：钩子清单这一行的 File 列里没有文件路径（\`Source/...\` 或 \`CMakeLists.txt\`）`);
  for (const r of claudeHooks.rows) if (!r.files.length) problems.push(`${CLAUDE_MD}:${r.n}：钩子表这一行的「文件」列里没有文件路径`);

  const allFiles = new Set([...markersByFile.keys(), ...readmeByFile.keys(), ...claudeByFile.keys()]);
  for (const file of [...allFiles].sort()) {
    const ms = markersByFile.get(file) ?? [];
    const rr = readmeByFile.get(file) ?? [];
    const cr = claudeByFile.get(file) ?? [];
    if (ms.length && !rr.length) problems.push(`${README}：钩子清单缺少 ${file}（代码里有 ${ms.length} 处标记，第 ${ms.map((m) => m.line).join('、')} 行）；在「## Hooks」表加一行`);
    if (ms.length && claudeHooks.rows.length && !cr.length) problems.push(`${CLAUDE_MD}：钩子表缺少 ${file}（代码里有 ${ms.length} 处标记，第 ${ms.map((m) => m.line).join('、')} 行）；在 §1 钩子表加一行或并入已有的行`);
    if (!ms.length && rr.length) problems.push(`${README}:${where(rr)}：钩子清单列了 ${file}，但文件里没有「${HOOK_MARKER}」标记`);
    if (!ms.length && cr.length) problems.push(`${CLAUDE_MD}:${where(cr)}：钩子表列了 ${file}，但文件里没有「${HOOK_MARKER}」标记`);
    // Entries: every listed entry stands for at least one marker, so there are never more rows than markers.
    if (ms.length && rr.length > ms.length) problems.push(`${README}:${where(rr)}：${file} 在钩子清单里有 ${rr.length} 条，代码里只有 ${ms.length} 处标记（第 ${ms.map((m) => m.line).join('、')} 行）；多出的条目没有对应的标记`);
    if (ms.length && cr.length > ms.length) problems.push(`${CLAUDE_MD}:${where(cr)}：${file} 在钩子表里有 ${cr.length} 条，代码里只有 ${ms.length} 处标记（第 ${ms.map((m) => m.line).join('、')} 行）`);
    // Position: a row that says where its hook is (includes, end of the constructor, ...) needs a marker there.
    for (const r of rr) {
      for (const claim of r.claims) {
        if (ms.length && !ms.some(claim.holds)) problems.push(`${README}:${r.n}：${file} 的钩子清单写了「${claim.says}」，但 ${file} 里没有这个位置的钩子标记（标记在第 ${ms.map((m) => m.line).join('、')} 行）`);
      }
    }
    const includeMarker = ms.find((m) => m.isInclude);
    if (includeMarker && rr.length && !rr.some((r) => r.claims.some((c) => c.key === 'include'))) {
      problems.push(`${README}:${where(rr)}：${file}:${includeMarker.line} 的钩子标记在 #include 行上，钩子清单里 ${file} 的行没有写 include`);
    }
    // Purpose keywords, the other way round: what a marker says the hook is for has to be described in the README
    // rows of that file. At least one word of the purpose has to occur there; the rest of the wording is free.
    if (rr.length) {
      const readmeText = rr.map((r) => r.text).join('\n').toLowerCase();
      for (const m of ms) {
        const words = purposeWords(m.purpose);
        if (!words.length) continue;
        if (!words.some((w) => readmeText.includes(w))) {
          problems.push(`${file}:${m.line}：钩子标记的用途「${m.purpose}」在 ${README} 钩子清单里 ${file} 的行中一个词都没有；这一行要说明同一件事`);
        }
      }
    }
  }

  // Purpose keywords. What a row names has to exist: a file must be in the tree, an identifier must occur in the
  // files with markers or in the control sources (a row may name what the bridge calls, for example
  // ControlService::setUiBridge). And a row of CLAUDE.md has to be about something the README list describes for
  // the same files: at least one name of the row occurs in the README rows of those files.
  const corpusFiles = [...new Set([...allFiles, ...src.list('Source/Control'), ...src.list('Source').filter((f) => f.startsWith('Source/Standalone/ControlEditorBridge'))])].filter((f) => /\.(h|hpp|cpp|cc|mm|inl|txt|cmake)$/.test(f));
  const corpus = [...src.readMany(corpusFiles).values()].filter((x) => x != null);
  const inCorpus = (needle) => corpus.some((x) => x.includes(needle));
  const namesOf = (span) => {
    const id = identifiersOf(span);
    return id ? (id.literal ? [id.literal] : id.segments) : [];
  };
  const checkNames = (docFile, row, label) => {
    for (const span of row.spans) {
      if (/^Source\/[\w./-]+\.(h|hpp|cpp|cc|mm)$/.test(span)) {
        if (src.read(span) == null) problems.push(`${docFile}:${row.n}：${label}提到的文件 ${span} 不存在`);
        continue;
      }
      for (const needle of namesOf(span)) {
        if (!inCorpus(needle)) problems.push(`${docFile}:${row.n}：${label}提到 \`${span}\`，但钩子文件和 Source/Control 里都没有「${needle}」；改名或删除了的话更新这一行`);
      }
    }
  };
  for (const r of readmeHooks.rows) checkNames(README, r, '钩子清单这一行');
  for (const r of claudeHooks.rows) {
    checkNames(CLAUDE_MD, r, '钩子表这一行');
    const names = r.spans.flatMap(namesOf);
    const readmeText = r.files.flatMap((f) => (readmeByFile.get(f) ?? []).map((x) => x.text)).join('\n');
    if (names.length && readmeText && !names.some((nm) => readmeText.includes(nm))) {
      problems.push(`${CLAUDE_MD}:${r.n}：钩子表这一行提到的名字（${names.slice(0, 4).map((s) => `\`${s}\``).join('、')}）在 ${README} 钩子清单里 ${r.files.join('、')} 的行中一个都没有；两边说的是不是同一处钩子`);
    }
  }

  return {
    problems,
    stats: { files: [...markersByFile.keys()].length, markers: markers.length, readmeRows: readmeHooks.rows.length, claudeRows: claudeHooks.rows.length },
  };
}

// ---------------------------------------------------------------------------------------------
// Group 3: mirrors (drift-pins.mjs as a library)
// ---------------------------------------------------------------------------------------------

function checkMirrors(src) {
  const mapText = src.read(MIRROR_MAP);
  const md = src.read(MIRRORS_MD);
  if (mapText == null) return { problems: [`${MIRROR_MAP} 不存在`], stats: {} };
  if (md == null) return { problems: [`${MIRRORS_MD} 不存在`], stats: {} };
  let mirrors;
  try {
    mirrors = readMirrors(mapText);
  } catch (e) {
    return { problems: [`${MIRROR_MAP}：读不出 mirrors（${e.message}）`], stats: {} };
  }
  const pinNames = src.list(PIN_DIR).filter((f) => /\.txt$/i.test(f));
  const pinTexts = src.readMany(pinNames);
  const pinFiles = new Map(pinNames.map((f) => [path.posix.basename(f), pinTexts.get(f) ?? '']));
  const problems = verifyConsistency({ mirrors, pinFiles, mirrorsMd: md });
  return { problems, stats: { mirrors: mirrors.length, groups: pinFiles.size }, fix: problems.length ? FIX_HINT : null };
}

// ---------------------------------------------------------------------------------------------
// Group 4: test names
// ---------------------------------------------------------------------------------------------

/** The text inside the parentheses of every CMake command that `startRe` (a global regex ending inside the call) matches. */
function cmakeCallBodies(text, startRe) {
  const bodies = [];
  for (let m = startRe.exec(text); m; m = startRe.exec(text)) {
    let depth = 1;
    let quoted = false;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
      else if (!quoted && c === '(') depth++;
      else if (!quoted && c === ')') depth--;
    }
    bodies.push(text.slice(from, depth === 0 ? i - 1 : i));
  }
  return bodies;
}

/** The ctest names cmake/OpenTuneControl.cmake registers: add_test names and ControlProcessorTests.<Scenario>. */
export function registeredTests(src) {
  const problems = [];
  const names = new Set();
  const scenarios = new Set();
  const cmake = src.read(CONTROL_CMAKE);
  if (cmake == null) return { names, problems: [`${CONTROL_CMAKE} 不存在，无法读出注册的测试`], scenarios };
  const stripped = cmake.replace(/^\s*#.*$/gm, '');
  for (const m of stripped.matchAll(/\badd_test\s*\(\s*NAME\s+([A-Za-z][\w.]*)/g)) names.add(m[1]);
  for (const body of cmakeCallBodies(stripped, /\b(?:set|list)\s*\(\s*(?:APPEND\s+)?_opentune_control_scenarios\b/g)) {
    for (const s of body.matchAll(/"([A-Za-z][A-Za-z0-9]*)(?:\|[^"]*)?"/g)) scenarios.add(s[1]);
  }
  if (!scenarios.size) problems.push(`${CONTROL_CMAKE}：找不到 _opentune_control_scenarios 列表，无法读出 ${SCENARIO_PREFIX}.<场景> 的名字`);
  if (!stripped.includes(`${SCENARIO_PREFIX}.\${`)) problems.push(`${CONTROL_CMAKE}：测试名前缀不是 ${SCENARIO_PREFIX}.<场景>，检查脚本需要同步`);
  const rootCmake = src.read(ROOT_CMAKE) ?? '';
  for (const m of rootCmake.replace(/^\s*#.*$/gm, '').matchAll(/\badd_test\s*\(\s*NAME\s+([A-Za-z][\w.]*)/g)) names.add(m[1]);
  for (const s of scenarios) names.add(`${SCENARIO_PREFIX}.${s}`);
  return { names, scenarios, problems };
}

const FILE_SUFFIXES = new Set(['cpp', 'h', 'hpp', 'md', 'json', 'txt', 'cmake']);

/**
 * Test names a markdown file mentions: `ControlUnitTests`, `ControlProcessorTests.Reads`, a `.Vectors` that follows
 * one of them in the same table row or paragraph, and the pattern of `ctest ... -R <pattern>`.
 * @returns {{ names: {name: string, line: number}[], files: {file: string, line: number}[], patterns: {pattern: string, line: number}[], problems: string[] }}
 */
export function scanTestNames(text, docFile) {
  const names = [];
  const files = [];
  const patterns = [];
  const problems = [];
  let prefix = null;
  splitLines(text).forEach((line, i) => {
    const n = i + 1;
    if (/^\s*\|/.test(line) || /^\s*$/.test(line) || /^#/.test(line)) prefix = null;
    const re = /(?<![A-Za-z0-9_.])(Control[A-Za-z]*Tests?)(?:\.([A-Za-z][A-Za-z0-9]*))?(?![A-Za-z0-9_])|`\.([A-Z][A-Za-z0-9]*)`/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (m[3]) {
        if (!prefix) problems.push(`${docFile}:${n}：\`.${m[3]}\` 前面没有可以补全的测试名（写成 ControlProcessorTests.${m[3]}）`);
        else names.push({ name: `${prefix}.${m[3]}`, line: n });
      } else if (m[2] && FILE_SUFFIXES.has(m[2])) {
        files.push({ file: `Tests/Control/${m[1]}.${m[2]}`, line: n });
      } else {
        prefix = m[1];
        names.push({ name: m[2] ? `${m[1]}.${m[2]}` : m[1], line: n });
      }
    }
    for (const c of line.matchAll(/\bctest\b[^`\n]*?\s-R\s+([^\s`]+)/g)) patterns.push({ pattern: c[1], line: n });
  });
  return { names, files, patterns, problems };
}

function checkTests(src, texts) {
  const problems = [];
  const reg = registeredTests(src);
  problems.push(...reg.problems);
  const docs = [[README, texts.readme], [CLAUDE_MD, texts.claude], [REVIEW_CHECKLIST, texts.checklist]];
  const notes = [];
  if (texts.checklist == null) notes.push(`${REVIEW_CHECKLIST} 还不存在：只检查 README 与 CLAUDE.md 引用的测试名`);
  let mentioned = 0;
  for (const [file, text] of docs) {
    if (text == null) continue;
    const scan = scanTestNames(text, file);
    problems.push(...scan.problems);
    const seen = new Set();
    for (const { name, line } of scan.names) {
      mentioned++;
      if (reg.names.has(name) || name === SCENARIO_PREFIX) continue;
      const key = `${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const group = name.split('.')[0];
      const hint = name.startsWith(`${SCENARIO_PREFIX}.`)
        ? `${CONTROL_CMAKE} 的场景列表里没有 ${name.slice(SCENARIO_PREFIX.length + 1)}`
        : `${CONTROL_CMAKE} 里没有 add_test(NAME ${group} ...)`;
      problems.push(`${file}:${line}：引用的测试名 ${name} 没有注册（${hint}）`);
    }
    for (const { file: ref, line } of scan.files) {
      if (src.read(ref) == null) problems.push(`${file}:${line}：引用的测试文件 ${ref} 不存在`);
    }
    for (const { pattern, line } of scan.patterns) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        problems.push(`${file}:${line}：ctest -R ${pattern} 不是合法的正则`);
        continue;
      }
      if (reg.names.size && ![...reg.names].some((nm) => re.test(nm))) problems.push(`${file}:${line}：ctest -R ${pattern} 匹配不到任何注册的测试`);
    }
  }
  return { problems, notes, stats: { registered: reg.names.size, mentioned } };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export const GROUPS = [
  { id: 'methods', title: '方法' },
  { id: 'hooks', title: '钩子' },
  { id: 'mirrors', title: '镜像' },
  { id: 'tests', title: '测试名' },
];

/**
 * Compare the documentation with the code in `src`.
 * @param {DocSource} src
 * @param {{ mirrorsBlocking?: boolean, claudeBlocking?: boolean }} [opts]  mirrorsBlocking false: the mirror group is only
 *   reported (advisory). claudeBlocking false: hook and test-name problems that come from CLAUDE.md (an L0 file that a
 *   sub-PR of upstreamable code cannot change) are only reported; the ones that come from the README, the code or the
 *   spec copy stay blocking.
 * @returns {{ applicable: boolean, problems: {group: string, text: string, advisory: boolean, source?: string}[], notes: string[], unimplemented: string[], stats: object, fix: string | null }}
 */
export function checkDocConsistency(src, opts = {}) {
  const readme = src.read(README);
  if (readme == null) return { applicable: false, problems: [], notes: [], unimplemented: [], stats: {}, fix: null };
  const texts = { readme, claude: src.read(CLAUDE_MD), checklist: src.read(REVIEW_CHECKLIST) };
  const out = { applicable: true, problems: [], notes: [], unimplemented: [], stats: {}, fix: null };
  const add = (group, list, advisory = false) => {
    for (const text of list) {
      const fromClaude = opts.claudeBlocking === false && (group === 'hooks' || group === 'tests') && text.startsWith(CLAUDE_MD);
      out.problems.push({ group, text, advisory: advisory || fromClaude, source: fromClaude ? 'claude' : advisory ? 'mirrors' : undefined });
    }
  };
  const methods = checkMethods(src, texts);
  add('methods', methods.problems);
  out.notes.push(...methods.notes);
  out.unimplemented = methods.unimplemented;
  out.stats.methods = methods.stats;
  const hooks = checkHooks(src, texts);
  add('hooks', hooks.problems);
  out.stats.hooks = hooks.stats;
  const mirrors = checkMirrors(src);
  add('mirrors', mirrors.problems, opts.mirrorsBlocking === false);
  out.stats.mirrors = mirrors.stats;
  out.fix = mirrors.fix ?? null;
  const tests = checkTests(src, texts);
  add('tests', tests.problems);
  out.notes.push(...tests.notes);
  out.stats.tests = tests.stats;
  return out;
}

/** One-line description of what was compared, for the PASS detail. */
export function describeStats(r) {
  const m = r.stats.methods ?? {};
  const h = r.stats.hooks ?? {};
  const k = r.stats.mirrors ?? {};
  const t = r.stats.tests ?? {};
  const parts = [
    `方法：README ${m.readme} 行 = 已注册 ${m.registered}（+ 监听端回答的 ${ANSWERED_ELSEWHERE.size}）= 规范 ${m.spec}`,
    `钩子：${h.files} 个文件 ${h.markers} 处标记 = README ${h.readmeRows} 行 = CLAUDE.md ${h.claudeRows} 行`,
    `镜像：${k.mirrors ?? '?'} 条、${k.groups ?? '?'} 个组`,
    `测试名：${t.mentioned} 处引用 / ${t.registered} 个已注册`,
  ];
  if (r.unimplemented.length) parts.push(`规范里有、dispatcher 未注册（未实现）：${r.unimplemented.join('、')}`);
  return parts.join('；');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { rev: 'string', index: 'bool', json: 'bool', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`doc-consistency: ${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stderr.write('usage: doc-consistency.mjs [--rev <rev> | --index] [--json]\n');
    return 2;
  }
  let src;
  try {
    const top = repoTop(process.cwd());
    if (o.index) src = gitSource(top, null);
    else if (o.rev) {
      const rev = tryResolveCommit(top, o.rev);
      if (!rev) throw new Error(`cannot resolve ${o.rev}`);
      src = gitSource(top, rev);
    } else src = fsSource(top);
  } catch (e) {
    process.stderr.write(`doc-consistency: ${e.message}\n`);
    return 2;
  }
  const r = checkDocConsistency(src);
  if (!r.applicable) {
    process.stdout.write(`doc-consistency: 没有 ${README}，不适用\n`);
    return 0;
  }
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.problems.length) {
    process.stderr.write(`doc-consistency：文档与代码不一致（${r.problems.length} 处）：\n`);
    for (const g of GROUPS) {
      const list = r.problems.filter((p) => p.group === g.id);
      if (list.length) process.stderr.write(`[${g.title}]\n${list.map((p) => `  - ${p.text}\n`).join('')}`);
    }
    if (r.fix) process.stderr.write(`镜像修复：${r.fix}。\n`);
    if (r.unimplemented.length) process.stderr.write(`未实现的规范方法：${r.unimplemented.join('、')}\n`);
  } else {
    process.stdout.write(`doc-consistency：${describeStats(r)}\n`);
    for (const n of r.notes) process.stdout.write(`  注：${n}\n`);
  }
  return r.problems.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
