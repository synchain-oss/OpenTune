#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// drift-pins: the fn-v1 normalised hash of upstream functions that the control API deliberately mirrors,
// and the check of the locked list (.github/drift-pins/<group>.txt, format in that directory's README)
// against any upstream revision. The daily dry-run rebase uses it to say which mirrored functions changed.
//
// CLI:
//   node drift-pins.mjs check --rev <rev> [--pins-rev <rev>] [--json]
//       --rev        revision that holds the upstream files to hash (for example the newest upstream commit)
//       --pins-rev   revision that holds the pin files (default HEAD)
//   node drift-pins.mjs hash --rev <rev> --path <file> --symbol <qualified name>
//       prints the fn-v1 sha256 of one function (use it to create a pin entry)
//   exit 0 = done (changed entries are reported, not an error), 2 = usage / git / malformed pin file
import { createHash } from 'node:crypto';
import { isMainModule, listTreeFiles, parseArgs, readBlobs, repoTop, tryResolveCommit } from './fork-lib.mjs';

export const PIN_DIR = '.github/drift-pins';
export const NORMALIZATION = 'fn-v1';

/** Text of a blob as the normalisation reads it: no UTF-8 BOM, LF line endings. */
export function normalizeSource(buf) {
  let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, '\n');
}

const isIdent = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/**
 * If a comment, string literal (including raw strings) or character literal starts at `i`, return the
 * index just after it; otherwise `i`. Braces and parentheses inside these never count.
 */
function skipTrivia(text, i) {
  const c = text[i];
  const n = text[i + 1];
  if (c === '/' && n === '/') {
    const e = text.indexOf('\n', i);
    return e < 0 ? text.length : e;
  }
  if (c === '/' && n === '*') {
    const e = text.indexOf('*/', i + 2);
    return e < 0 ? text.length : e + 2;
  }
  if (c === '"') {
    // raw string: R"delim( ... )delim", the R may carry an encoding prefix (u8R, LR, ...)
    if (text[i - 1] === 'R' && (text[i - 2] === undefined || !isIdent(text[i - 2]) || /[uUL8]/.test(text[i - 2]))) {
      const open = text.indexOf('(', i);
      if (open > 0) {
        const close = text.indexOf(`)${text.slice(i + 1, open)}"`, open);
        if (close > 0) return close + (open - i - 1) + 2;
      }
    }
    let j = i + 1;
    while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === "'") {
    // A digit separator (1'000) is not a character literal.
    if (/[0-9A-Fa-f]/.test(text[i - 1] ?? '') && /[0-9A-Fa-f]/.test(n ?? '')) return i;
    let j = i + 1;
    while (j < text.length && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** Index of the bracket that closes the one at `open` (same kind), or -1. */
function matchClose(text, open) {
  const o = text[open];
  const c = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < text.length; ) {
    const j = skipTrivia(text, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
    i++;
  }
  return -1;
}

const stripWs = (s) => s.replace(/\s+/g, '');

/** Split a parameter list at top-level commas (not inside <>, (), [] or {}). */
function splitParams(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of list) {
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() || out.length) out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p.length);
}

/** Does the source parameter list match the types given in the pin's symbol? Names and defaults are ignored. */
function paramsMatch(sourceList, wantedList) {
  const src = splitParams(sourceList);
  const want = splitParams(wantedList).map(stripWs);
  if (src.length !== want.length) return false;
  return src.every((p, i) => {
    const noDefault = p.replace(/\s*=[^]*$/, '');
    const withoutName = noDefault.replace(/([\s&*>])[A-Za-z_]\w*$/, '$1').trim();
    return stripWs(noDefault) === want[i] || stripWs(withoutName) === want[i];
  });
}

/**
 * Locate the definition of `symbol` in `text` (already normalised). `symbol` is the qualified name, with
 * the parameter types in parentheses when an overload has to be told apart. The definition is the first
 * occurrence of `<name>(` whose parameter list is followed by a `{` before any `;`.
 * @returns {{startLine: number, endLine: number, text: string} | null}  1-based inclusive lines
 */
export function extractFunction(text, symbol) {
  const paren = symbol.indexOf('(');
  const name = (paren < 0 ? symbol : symbol.slice(0, paren)).trim();
  const params = paren < 0 ? null : symbol.slice(paren + 1, symbol.lastIndexOf(')'));
  if (!name) return null;
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const prev = text[m.index - 1];
    if (isIdent(prev) || prev === ':' || prev === '~') continue;
    // inside a comment or a string: the scan from the line start tells
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    let inTrivia = false;
    for (let i = lineStart; i < m.index; ) {
      const j = skipTrivia(text, i);
      if (j > m.index) { inTrivia = true; break; }
      i = j !== i ? j : i + 1;
    }
    if (inTrivia) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open);
    if (close < 0) continue;
    if (params !== null && !paramsMatch(text.slice(open + 1, close), params)) continue;
    // after the parameter list: qualifiers, trailing return type, constructor initialisers ... up to { or ;
    let i = close + 1;
    let bodyOpen = -1;
    let depth = 0;
    while (i < text.length) {
      const j = skipTrivia(text, i);
      if (j !== i) {
        i = j;
        continue;
      }
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === '{') {
        bodyOpen = i;
        break;
      }
      i++;
    }
    if (bodyOpen < 0) continue;
    const bodyClose = matchClose(text, bodyOpen);
    if (bodyClose < 0) continue;
    const lines = text.split('\n');
    const startLine = text.slice(0, m.index).split('\n').length;
    const endLine = text.slice(0, bodyClose).split('\n').length;
    return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
  }
  return null;
}

/** fn-v1: trim each line, drop empty lines, collapse blanks inside a line, join with LF, sha256 hex. */
export function hashFunctionText(fnText) {
  const body = fnText
    .split('\n')
    .map((l) => l.trim().replace(/[ \t]+/g, ' '))
    .filter(Boolean)
    .join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** @returns {{sha256: string, startLine: number, endLine: number} | null} */
export function hashSymbol(sourceBuf, symbol) {
  const fn = extractFunction(normalizeSource(sourceBuf), symbol);
  return fn ? { sha256: hashFunctionText(fn.text), startLine: fn.startLine, endLine: fn.endLine } : null;
}

/**
 * Parse one pin file.
 * @returns {{group: string, pinnedAt: string, portedTo: string[], entries: object[], problems: string[]}}
 */
export function parsePinFile(text, fileName) {
  const out = { group: '', pinnedAt: '', portedTo: [], entries: [], problems: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    if (!raw.trim()) return;
    if (raw.startsWith('#')) {
      const meta = /^#\s*(group|pinned-at|ported-to):\s*(.+?)\s*$/.exec(raw);
      if (meta?.[1] === 'group') out.group = meta[2];
      else if (meta?.[1] === 'pinned-at') out.pinnedAt = meta[2];
      else if (meta?.[1] === 'ported-to') out.portedTo.push(meta[2]);
      return;
    }
    const f = raw.split('\t');
    if (f.length !== 5) return out.problems.push(`${fileName}:${n}：需要 5 个以 TAB 分隔的字段，实际 ${f.length} 个`);
    const [file, symbol, anchor, normalization, sha256] = f;
    if (normalization !== NORMALIZATION) return out.problems.push(`${fileName}:${n}：不支持的规范化方式 ${normalization}`);
    if (!/^[0-9a-f]{64}$/.test(sha256)) return out.problems.push(`${fileName}:${n}：sha256 不是 64 位小写十六进制`);
    out.entries.push({ path: file, symbol, anchor, normalization, sha256, line: n });
  });
  if (!out.group) out.problems.push(`${fileName}：缺少 # group: 元数据`);
  return out;
}

/**
 * Check every pin against the files at `rev`.
 * @returns {{pins: number, groups: string[], entries: object[], problems: string[]}}
 *   entries: {group, path, symbol, status: 'unchanged' | 'changed' | 'missing-file' | 'missing-symbol',
 *             pinned, current, anchor, currentAnchor}
 */
export function checkPins({ cwd, rev, pinsRev = 'HEAD' }) {
  const top = repoTop(cwd ?? process.cwd());
  const pinFiles = listTreeFiles(top, pinsRev, PIN_DIR).filter((f) => /\.txt$/i.test(f));
  const blobs = readBlobs(top, pinFiles.map((f) => `${pinsRev}:${f}`));
  const parsed = [];
  const problems = [];
  for (const f of pinFiles) {
    const blob = blobs.get(`${pinsRev}:${f}`);
    if (!blob) continue;
    const p = parsePinFile(blob.toString('utf8'), f);
    problems.push(...p.problems);
    parsed.push(p);
  }
  const sources = readBlobs(top, [...new Set(parsed.flatMap((p) => p.entries.map((e) => `${rev}:${e.path}`)))]);
  const entries = [];
  for (const p of parsed) {
    for (const e of p.entries) {
      const src = sources.get(`${rev}:${e.path}`);
      const base = { group: p.group, path: e.path, symbol: e.symbol, pinned: e.sha256, anchor: e.anchor };
      if (!src) {
        entries.push({ ...base, status: 'missing-file' });
        continue;
      }
      const h = hashSymbol(src, e.symbol);
      if (!h) entries.push({ ...base, status: 'missing-symbol' });
      else entries.push({ ...base, status: h.sha256 === e.sha256 ? 'unchanged' : 'changed', current: h.sha256, currentAnchor: `L${h.startLine}-L${h.endLine}` });
    }
  }
  return { pins: entries.length, groups: parsed.map((p) => p.group), entries, problems };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let o;
  try {
    ({ opts: o } = parseArgs(rest, { rev: 'string', 'pins-rev': 'string', path: 'string', symbol: 'string', json: 'bool' }));
  } catch (e) {
    process.stderr.write(`drift-pins: ${e.message}\n`);
    return 2;
  }
  const top = repoTop(process.cwd());
  const rev = o.rev && tryResolveCommit(top, o.rev);
  if (!['check', 'hash'].includes(cmd) || !rev) {
    process.stderr.write('usage: drift-pins.mjs check --rev <rev> [--pins-rev <rev>] [--json] | hash --rev <rev> --path <file> --symbol <name>\n');
    return 2;
  }
  if (cmd === 'hash') {
    const blob = readBlobs(top, [`${rev}:${o.path}`]).get(`${rev}:${o.path}`);
    const h = blob && o.symbol ? hashSymbol(blob, o.symbol) : null;
    if (!h) {
      process.stderr.write(`drift-pins: ${o.symbol} not found in ${o.path} at ${o.rev}\n`);
      return 2;
    }
    process.stdout.write(`${h.sha256}\tL${h.startLine}-L${h.endLine}\n`);
    return 0;
  }
  const r = checkPins({ cwd: top, rev, pinsRev: o['pins-rev'] ?? 'HEAD' });
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    for (const e of r.entries) process.stdout.write(`${e.status.padEnd(15)} ${e.group}  ${e.path} ${e.symbol}\n`);
    for (const p of r.problems) process.stderr.write(`drift-pins: ${p}\n`);
    process.stdout.write(`${r.pins} pin(s) in ${r.groups.length} group(s)\n`);
  }
  return r.problems.length ? 2 : 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
