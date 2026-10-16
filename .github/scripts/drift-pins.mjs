#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// drift-pins: the normalised hash (fn-v1 for functions, stmt-v1 for declarations) of upstream code that the
// control API deliberately mirrors, and the check of the locked list (.github/drift-pins/<group>.txt, format
// in that directory's README) against any upstream revision. The daily dry-run rebase uses it to say which
// mirrored functions changed. The pin files are generated from Source/Control/mirror-map.json; the same
// script keeps the three places (pin files, mirror-map.json, MIRRORS.md) consistent.
//
// CLI:
//   node drift-pins.mjs --write [--pinned-at <tag>]
//       regenerates .github/drift-pins/<group>.txt from mirror-map.json (never edit the files by hand)
//   node drift-pins.mjs --check [--json] [--advisory] [--event <name> --base <ref> [--changed-files <file>]]
//       pin files, mirror-map.json and MIRRORS.md agree (working tree, no git needed); exit 1 when not.
//       --advisory (or --event, which applies decideEnforcement) reports a mismatch but exits 0
//   node drift-pins.mjs check --rev <rev> [--pins-rev <rev>] [--json]
//       --rev        revision that holds the upstream files to hash (for example the newest upstream commit)
//       --pins-rev   revision that holds the pin files (default HEAD)
//   node drift-pins.mjs hash --rev <rev> --path <file> --symbol <qualified name>
//       prints the fn-v1 sha256 of one function (use it to create a pin entry)
//   exit 0 = done (changed entries are reported, not an error), 2 = usage / git / malformed pin file
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, isMainModule, listTreeFiles, parseArgs, readBlobs, repoTop, tryResolveCommit } from './fork-lib.mjs';

export const PIN_DIR = '.github/drift-pins';
export const MIRROR_MAP = 'Source/Control/mirror-map.json';
export const MIRRORS_MD = 'Source/Control/MIRRORS.md';
export const NORMALIZATION = 'fn-v1';
export const NORMALIZATIONS = ['fn-v1', 'stmt-v1'];
/** upstream.kind of mirror-map.json picks the extraction (as in Tests/Control/ControlMirrorHash.h); normalization only has to agree. */
export const NORMALIZATION_OF_KIND = { function: 'fn-v1', statement: 'stmt-v1' };

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
      else if (c === ')') {
        depth--;
        // An unmatched ')' means the name was a call argument, not a definition.
        if (depth < 0) break;
      }
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

/**
 * Locate a declaration (stmt-v1): the line that holds `anchor` outside comments and literals (as a whole word
 * where the anchor starts or ends with an identifier character), up to the first ';' outside brackets.
 * The text starts at the beginning of that line. Same rules as ControlMirror::extractStatement.
 * @returns {{startLine: number, endLine: number, text: string} | null}  1-based inclusive lines
 */
export function extractStatement(text, anchor) {
  if (!anchor) return null;
  for (let i = 0; i < text.length; ) {
    const j = skipTrivia(text, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (!text.startsWith(anchor, i)) {
      i++;
      continue;
    }
    const leftOpen = isIdent(anchor[0]) && i > 0 && isIdent(text[i - 1]);
    const rightOpen = isIdent(anchor[anchor.length - 1]) && isIdent(text[i + anchor.length]);
    if (leftOpen || rightOpen) {
      i++;
      continue;
    }
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    let depth = 0;
    for (let k = i; k < text.length; ) {
      const s = skipTrivia(text, k);
      if (s !== k) {
        k = s;
        continue;
      }
      const c = text[k];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth <= 0) {
        return {
          startLine: text.slice(0, i).split('\n').length,
          endLine: text.slice(0, k).split('\n').length,
          text: text.slice(lineStart, k + 1),
        };
      }
      k++;
    }
    return null;
  }
  return null;
}

/** fn-v1 / stmt-v1: trim each line, drop empty lines, collapse blanks inside a line, join with LF, sha256 hex. */
export function hashFunctionText(fnText) {
  const body = fnText
    .split('\n')
    .map((l) => l.trim().replace(/[ \t]+/g, ' '))
    .filter(Boolean)
    .join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * @param {string} [normalization]  'fn-v1' (a function, located by its qualified name) or 'stmt-v1' (a
 *   declaration, located by the text it holds)
 * @returns {{sha256: string, startLine: number, endLine: number} | null}
 */
export function hashSymbol(sourceBuf, symbol, normalization = NORMALIZATION) {
  const text = normalizeSource(sourceBuf);
  const fn = normalization === 'stmt-v1' ? extractStatement(text, symbol) : extractFunction(text, symbol);
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
    if (!NORMALIZATIONS.includes(normalization)) return out.problems.push(`${fileName}:${n}：不支持的规范化方式 ${normalization}`);
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
      const h = hashSymbol(src, e.symbol, e.normalization);
      if (!h) entries.push({ ...base, status: 'missing-symbol' });
      else entries.push({ ...base, status: h.sha256 === e.sha256 ? 'unchanged' : 'changed', current: h.sha256, currentAnchor: `L${h.startLine}-L${h.endLine}` });
    }
  }
  return { pins: entries.length, groups: parsed.map((p) => p.group), entries, problems };
}

// ---------------------------------------------------------------------------------------------
// Generation (--write) and the three-way consistency check (--check)
// ---------------------------------------------------------------------------------------------

const GROUP_RE = /^[a-z0-9-]+$/;
const TAG_RE = /^upstream\/\d{8}-[0-9a-f]{7}$/;
const ANCHOR_RE = /^L\d+-L\d+$/;
export const FIX_HINT =
  '先运行 OpenTuneControlMirrorDriftTests --update（刷新 mirror-map.json 与 MIRRORS.md），再运行 node .github/scripts/drift-pins.mjs --write（重新生成 .github/drift-pins/）';

/** The mirrors of mirror-map.json as the pin files need them: one record per upstream function or declaration. */
export function readMirrors(mapText) {
  const map = JSON.parse(mapText);
  if (!Array.isArray(map.mirrors)) throw new Error(`${MIRROR_MAP} 缺少 mirrors 数组`);
  return map.mirrors.map((m) => ({
    id: String(m.id),
    group: String(m.group),
    path: String(m.upstream?.file),
    symbol: String(m.upstream?.symbol),
    kind: String(m.upstream?.kind),
    normalization: String(m.upstream?.normalization),
    sha256: String(m.upstream?.sha256),
    controlFiles: (m.control ?? []).map((c) => String(c.file)),
  }));
}

/** Mirrors by group, in the order of mirror-map.json. */
function groupMirrors(mirrors) {
  const groups = new Map();
  for (const m of mirrors) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  return groups;
}

/** The control files of a group, in order of first appearance. */
const portedTo = (list) => [...new Set(list.flatMap((m) => m.controlFiles))];

/**
 * The content of every pin file, deterministic for the same input.
 * @param {object[]} mirrors  from readMirrors()
 * @param {{pinnedAt: string, anchorOf: (m: object) => string}} opts
 * @returns {Map<string, string>}  file name (`<group>.txt`) to content
 */
export function renderPinFiles(mirrors, { pinnedAt, anchorOf }) {
  const files = new Map();
  for (const [group, list] of groupMirrors(mirrors)) {
    const lines = [
      '# SPDX-FileCopyrightText: Copyright (c) 2026 Synchain',
      '# SPDX-License-Identifier: AGPL-3.0-or-later',
      '#',
      `# group: ${group}`,
      `# pinned-at: ${pinnedAt}`,
      ...portedTo(list).map((f) => `# ported-to: ${f}`),
      '#',
      `# Generated from ${MIRROR_MAP} by .github/scripts/drift-pins.mjs --write. Do not edit by hand.`,
      ...list.map((m) => [m.path, m.symbol, anchorOf(m), m.normalization, m.sha256].join('\t')),
    ];
    files.set(`${group}.txt`, `${lines.join('\n')}\n`);
  }
  return files;
}

/** The (id, sha256) rows of the generated table in MIRRORS.md. */
export function parseMirrorsMd(text) {
  const begin = text.indexOf('<!-- mirror-table:begin');
  const end = text.indexOf('<!-- mirror-table:end');
  if (begin < 0 || end < begin) return null;
  const rows = [];
  for (const line of text.slice(begin, end).split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+)`\s*\|.*\|\s*`([0-9a-f]{64})`\s*\|[^|]*\|\s*$/.exec(line);
    if (m) rows.push({ id: m[1], sha256: m[2] });
  }
  return rows;
}

/**
 * Pin files, mirror-map.json and MIRRORS.md must agree. MIRRORS.md is only compared as a set of ids and hashes.
 * @param {{mirrors: object[], pinFiles: Map<string, string>, mirrorsMd: string}} input
 * @returns {string[]}  problems, each saying what differs and where (empty = consistent)
 */
export function verifyConsistency({ mirrors, pinFiles, mirrorsMd }) {
  const problems = [];
  const keyOf = (path_, symbol) => `${path_}\t${symbol}`;
  const seen = new Set();
  for (const m of mirrors) {
    if (!GROUP_RE.test(m.group)) problems.push(`${MIRROR_MAP}：${m.id} 的 group「${m.group}」不是 [a-z0-9-]+`);
    if (!NORMALIZATIONS.includes(m.normalization)) problems.push(`${MIRROR_MAP}：${m.id} 的规范化方式「${m.normalization}」不受支持`);
    if (!(m.kind in NORMALIZATION_OF_KIND)) problems.push(`${MIRROR_MAP}：${m.id} 的 kind「${m.kind}」应为 function 或 statement`);
    else if (NORMALIZATIONS.includes(m.normalization) && NORMALIZATION_OF_KIND[m.kind] !== m.normalization) {
      problems.push(`${MIRROR_MAP}：${m.id} 的 kind「${m.kind}」应配 ${NORMALIZATION_OF_KIND[m.kind]}，实际是 ${m.normalization}`);
    }
    if (!/^[0-9a-f]{64}$/.test(m.sha256)) problems.push(`${MIRROR_MAP}：${m.id} 的 sha256 不是 64 位小写十六进制`);
    const k = keyOf(m.path, m.symbol);
    if (seen.has(k)) problems.push(`${MIRROR_MAP}：${m.path} 的 ${m.symbol} 登记了不止一次（${m.id}）`);
    seen.add(k);
  }
  const groups = groupMirrors(mirrors);
  for (const group of groups.keys()) {
    if (!pinFiles.has(`${group}.txt`)) problems.push(`${PIN_DIR}/${group}.txt 缺失：${MIRROR_MAP} 有 ${group} 组（${groups.get(group).length} 条）`);
  }
  const pinnedAts = new Map();
  for (const [name, text] of pinFiles) {
    const where = `${PIN_DIR}/${name}`;
    const group = name.replace(/\.txt$/, '');
    const list = groups.get(group);
    if (!list) {
      problems.push(`${where} 多余：${MIRROR_MAP} 没有 ${group} 组`);
      continue;
    }
    const p = parsePinFile(text, where);
    problems.push(...p.problems);
    if (p.group !== group) problems.push(`${where}：# group: 是「${p.group}」，应为 ${group}`);
    if (!TAG_RE.test(p.pinnedAt)) problems.push(`${where}：# pinned-at: 应是 upstream/YYYYMMDD-<sha7>，实际「${p.pinnedAt}」`);
    pinnedAts.set(name, p.pinnedAt);
    const wantPorted = portedTo(list);
    if (JSON.stringify(p.portedTo) !== JSON.stringify(wantPorted)) {
      problems.push(`${where}：# ported-to: 是 [${p.portedTo.join(', ')}]，与 ${MIRROR_MAP} 的接口层文件 [${wantPorted.join(', ')}] 不一致`);
    }
    const byKey = new Map();
    for (const e of p.entries) {
      const k = keyOf(e.path, e.symbol);
      if (byKey.has(k)) problems.push(`${where}:${e.line}：${e.path} 的 ${e.symbol} 出现了不止一行`);
      byKey.set(k, e);
    }
    for (const m of list) {
      const e = byKey.get(keyOf(m.path, m.symbol));
      if (!e) {
        problems.push(`${where} 缺少条目：${m.path} 的 ${m.symbol}（${m.id}）`);
        continue;
      }
      if (e.normalization !== m.normalization) problems.push(`${where}:${e.line}：${m.id} 的规范化方式是 ${e.normalization}，${MIRROR_MAP} 是 ${m.normalization}`);
      if (e.sha256 !== m.sha256) problems.push(`${where}:${e.line}：${m.id} 的 sha256 与 ${MIRROR_MAP} 不一致（pin ${e.sha256.slice(0, 12)}…，mirror-map ${m.sha256.slice(0, 12)}…）`);
      if (!ANCHOR_RE.test(e.anchor)) problems.push(`${where}:${e.line}：${m.id} 的 anchor「${e.anchor}」应形如 L10-L20`);
      byKey.delete(keyOf(m.path, m.symbol));
    }
    for (const e of byKey.values()) problems.push(`${where}:${e.line} 多余条目：${e.path} 的 ${e.symbol} 不在 ${MIRROR_MAP} 的 ${group} 组里`);
  }
  if (new Set(pinnedAts.values()).size > 1) {
    problems.push(`${PIN_DIR}/ 的 pinned-at 不一致：${[...pinnedAts].map(([n, t]) => `${n} ${t}`).join('、')}（重新运行 --write 让各组用同一个 tag）`);
  }
  const rows = parseMirrorsMd(mirrorsMd);
  if (!rows) problems.push(`${MIRRORS_MD}：找不到 mirror-table:begin / mirror-table:end 标记`);
  else {
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== rows.length) problems.push(`${MIRRORS_MD}：表里有重复的 id`);
    for (const m of mirrors) {
      const r = byId.get(m.id);
      if (!r) problems.push(`${MIRRORS_MD} 缺少 ${m.id}`);
      else if (r.sha256 !== m.sha256) problems.push(`${MIRRORS_MD}：${m.id} 的 sha256 与 ${MIRROR_MAP} 不一致`);
      byId.delete(m.id);
    }
    for (const id of byId.keys()) problems.push(`${MIRRORS_MD} 多余的行：${id} 不在 ${MIRROR_MAP} 里`);
  }
  return problems;
}

const PIN_PATH_RE = /^(\.github\/drift-pins\/|\.github\/scripts\/drift-pins\.mjs$)/;
const BLOCKING_BASE_RE = /^(dev|review-base\/.+|sync\/.+)$/;

/**
 * Whether an inconsistency fails the CI step or is only reported. Blocking: pushes (dev, feature/control-api), pull
 * requests into dev, review-base/** or sync/**, and any pull request that touches the pin files or this script.
 * Not blocking: a sub-PR into feature/** that touches neither; the manager's follow-up regenerates the pin files.
 * @param {{event: string, baseRef?: string, changedFiles?: string[]}} input
 * @returns {{blocking: boolean, reason: string}}
 */
export function decideEnforcement({ event, baseRef = '', changedFiles = [] }) {
  if (event !== 'pull_request') return { blocking: true, reason: '不是 pull_request（push 到 dev 或主支线），照常阻塞' };
  const base = String(baseRef).replace(/^refs\/heads\//, '');
  if (BLOCKING_BASE_RE.test(base)) return { blocking: true, reason: `PR 的 base 是 ${base}，阻塞` };
  const touched = changedFiles.find((f) => PIN_PATH_RE.test(f));
  if (touched) return { blocking: true, reason: `PR 改了 ${touched}，阻塞` };
  if (/^feature\/.+/.test(base)) return { blocking: false, reason: `PR 的 base 是 ${base} 且没改 ${PIN_DIR}/ 与 drift-pins.mjs：只报告，由 manager 的 L0 跟进补齐` };
  return { blocking: true, reason: `PR 的 base ${base} 不在可放行范围内，阻塞` };
}

/** Read the three places from the working tree of `root`. */
function readWorkingTree(root) {
  const mirrors = readMirrors(fs.readFileSync(path.join(root, MIRROR_MAP), 'utf8'));
  const mirrorsMd = fs.readFileSync(path.join(root, MIRRORS_MD), 'utf8');
  const dir = path.join(root, PIN_DIR);
  const pinFiles = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (/\.txt$/i.test(f)) pinFiles.set(f, fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  return { mirrors, mirrorsMd, pinFiles };
}

/** --check on the working tree of `root`. */
export function checkWorkingTree(root) {
  const { mirrors, mirrorsMd, pinFiles } = readWorkingTree(root);
  return { mirrors: mirrors.length, groups: pinFiles.size, problems: verifyConsistency({ mirrors, pinFiles, mirrorsMd }) };
}

/**
 * --write: regenerate the pin files of `root` from mirror-map.json. The anchors are the line ranges of the
 * mirrored code in the upstream snapshot `pinnedAt`; the hashes come from mirror-map.json, never from here.
 * @returns {{written: string[], removed: string[], warnings: string[]}}
 */
export function writePins(root, { pinnedAt }) {
  if (!TAG_RE.test(pinnedAt)) throw new Error(`pinned-at 应是 upstream/YYYYMMDD-<sha7> 形式的 tag，实际「${pinnedAt}」`);
  const { mirrors } = readWorkingTree(root);
  const kindProblems = mirrors.filter((m) => NORMALIZATION_OF_KIND[m.kind] !== m.normalization);
  if (kindProblems.length) {
    throw new Error(`${MIRROR_MAP} 的 kind 与规范化方式不配（function 配 fn-v1，statement 配 stmt-v1）：${kindProblems.map((m) => `${m.id}（${m.kind}/${m.normalization}）`).join('、')}`);
  }
  const warnings = [];
  const sources = new Map();
  const anchorOf = (m) => {
    if (!sources.has(m.path)) {
      const r = git(['show', `${pinnedAt}:${m.path}`], { cwd: root, raw: true, allowFail: true });
      sources.set(m.path, r.status === 0 ? r.stdout : null);
    }
    const buf = sources.get(m.path);
    const h = buf?.length ? hashSymbol(buf, m.symbol, NORMALIZATION_OF_KIND[m.kind]) : null;
    if (!h) throw new Error(`${pinnedAt} 里找不到 ${m.path} 的 ${m.symbol}（${m.id}）`);
    if (h.sha256 !== m.sha256) warnings.push(`${m.id}：${pinnedAt} 上的哈希与 ${MIRROR_MAP} 不同；mirror-map 的值照写，请确认 pinned-at 是否正确`);
    return `L${h.startLine}-L${h.endLine}`;
  };
  const files = renderPinFiles(mirrors, { pinnedAt, anchorOf });
  const dir = path.join(root, PIN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    if (/\.txt$/i.test(f) && !files.has(f)) {
      fs.rmSync(path.join(dir, f));
      removed.push(f);
    }
  }
  for (const [name, content] of files) fs.writeFileSync(path.join(dir, name), content, { encoding: 'utf8' });
  return { written: [...files.keys()], removed, warnings };
}

/** The newest upstream snapshot tag that HEAD contains. */
function newestSnapshotTag(root) {
  const r = git(['tag', '--merged', 'HEAD', '--list', 'upstream/*'], { cwd: root, allowFail: true });
  return String(r.stdout ?? '').split('\n').map((t) => t.trim()).filter((t) => TAG_RE.test(t)).sort().pop() ?? '';
}

function mainPins(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, { write: 'bool', check: 'bool', json: 'bool', advisory: 'bool', event: 'string', base: 'string', 'changed-files': 'string', 'pinned-at': 'string' }));
  } catch (e) {
    process.stderr.write(`drift-pins: ${e.message}\n`);
    return 2;
  }
  if (o.write === o.check) {
    process.stderr.write('usage: drift-pins.mjs --write [--pinned-at <tag>] | --check [--json]\n');
    return 2;
  }
  const root = repoTop(process.cwd());
  try {
    if (o.write) {
      const pinnedAt = o['pinned-at'] ?? newestSnapshotTag(root);
      const r = writePins(root, { pinnedAt });
      for (const w of r.warnings) process.stderr.write(`drift-pins: 警告：${w}\n`);
      process.stdout.write(`${r.written.length} 个文件已写入 ${PIN_DIR}/（pinned-at ${pinnedAt}）${r.removed.length ? `，删除了多余的 ${r.removed.join('、')}` : ''}\n`);
      return 0;
    }
    const r = checkWorkingTree(root);
    let advisory = Boolean(o.advisory);
    let why = '本地 gates 的非 L0 层只报告';
    if (o.event) {
      const changedFiles = o['changed-files'] ? fs.readFileSync(o['changed-files'], 'utf8').split(/\r?\n/).filter(Boolean) : [];
      const d = decideEnforcement({ event: o.event, baseRef: o.base ?? '', changedFiles });
      advisory = !d.blocking;
      why = d.reason;
    }
    if (o.json) process.stdout.write(`${JSON.stringify({ ...r, advisory, fix: r.problems.length ? FIX_HINT : null }, null, 2)}\n`);
    else if (r.problems.length) {
      const head = `drift-pins：${PIN_DIR}/、${MIRROR_MAP} 与 ${MIRRORS_MD} 不一致（${r.problems.length} 处）${advisory ? '（仅报告，不阻塞）' : ''}：\n`;
      const lines = r.problems.map((p) => `  - ${p}\n`).join('');
      process.stderr.write(`${head}${lines}修复：${FIX_HINT}。\n`);
      if (advisory) {
        process.stderr.write(`${why}。\n`);
        if (process.env.GITHUB_ACTIONS) {
          process.stdout.write(`::warning title=drift-pins::三处不一致（${r.problems.length} 处），不阻塞此 PR；由 manager 的 L0 跟进用 node .github/scripts/drift-pins.mjs --write 补齐\n`);
        }
        if (process.env.GITHUB_STEP_SUMMARY) {
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### drift-pins：不一致（仅报告）\n\n${why}。由 manager 的 L0 跟进用 \`node .github/scripts/drift-pins.mjs --write\` 补齐。\n\n${r.problems.map((p) => `- ${p}`).join('\n')}\n`);
        }
      }
    } else process.stdout.write(`drift-pins：${r.mirrors} 条镜像、${r.groups} 个组，三处一致\n`);
    return r.problems.length && !advisory ? 1 : 0;
  } catch (e) {
    process.stderr.write(`drift-pins: ${e.message}\n`);
    return 2;
  }
}

function main(argv) {
  if (argv[0]?.startsWith('--') && argv[0] !== '--help') return mainPins(argv);
  const [cmd, ...rest] = argv;
  let o;
  try {
    ({ opts: o } = parseArgs(rest, { rev: 'string', 'pins-rev': 'string', path: 'string', symbol: 'string', normalization: 'string', json: 'bool' }));
  } catch (e) {
    process.stderr.write(`drift-pins: ${e.message}\n`);
    return 2;
  }
  if (o.normalization && !NORMALIZATIONS.includes(o.normalization)) {
    process.stderr.write(`drift-pins: --normalization 应为 ${NORMALIZATIONS.join(' 或 ')}，实际「${o.normalization}」\n`);
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
    const h = blob && o.symbol ? hashSymbol(blob, o.symbol, o.normalization ?? NORMALIZATION) : null;
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
