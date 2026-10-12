#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// fetch-tool: download a pinned binary tool listed in tools.lock.json, verify it and print the path
// of the executable on stdout (logs go to stderr).
//
//   archive tools (gitleaks): download the platform asset, compare its sha256 with the lock, extract
//     only the executable into <dest>/<tool>-<version>-<platform>/ and record a stamp with the
//     archive and executable hashes. A cached executable is reused only when both still match.
//   pip tools (clang-format): pip install --require-hashes --only-binary :all: --no-deps --target
//     <dest>/<tool>-<version>-<platform>/ -r <requirements with hashes>.
// Then the executable's version output must contain the locked version.
//
// CLI: node fetch-tool.mjs <tool> [--dest <dir>] [--lock <file>] [--platform <os-arch>] [--python <exe>]
//      exit 0 = path printed, 1 = verification failed, 2 = usage / download / install error
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCRIPTS_DIR, isMainModule, parseArgs, sha256Hex } from './fork-lib.mjs';

export const DEFAULT_LOCK = path.join(SCRIPTS_DIR, 'tools.lock.json');
export const DEFAULT_DEST = path.join(os.tmpdir(), 'ot-tools');

export class VerificationError extends Error {}

function log(msg) {
  process.stderr.write(`[fetch-tool] ${msg}\n`);
}

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function exeName(name, platform) {
  return platform.startsWith('win32') && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}

function fileSha256(file) {
  return sha256Hex(fs.readFileSync(file));
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const partial = `${file}.partial`;
  fs.writeFileSync(partial, buf);
  fs.renameSync(partial, file);
}

function tarCommand() {
  // Windows ships bsdtar (handles .zip and .tar.gz); Git Bash's GNU tar earlier on PATH cannot read zip.
  if (process.platform === 'win32') return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return 'tar';
}

function extractMember(archive, member, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(tarCommand(), ['-xf', archive, '-C', outDir, member], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`cannot extract ${member} from ${path.basename(archive)}: ${String(r.stderr ?? r.error).trim()}`);
  const out = path.join(outDir, member);
  if (!fs.existsSync(out)) throw new Error(`${member} not found in ${path.basename(archive)}`);
  if (process.platform !== 'win32') fs.chmodSync(out, 0o755);
  return out;
}

function checkVersion(exe, tool, name) {
  if (!tool.versionArgs) return;
  const r = spawnSync(exe, tool.versionArgs, { encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error || r.status !== 0) throw new VerificationError(`${name}: cannot run ${path.basename(exe)} ${tool.versionArgs.join(' ')}`);
  if (!out.includes(tool.version)) throw new VerificationError(`${name}: version output does not contain ${tool.version}: ${out.trim().slice(0, 200)}`);
}

async function ensureArchiveTool(name, tool, dest, plat) {
  const asset = tool.assets?.[plat];
  if (!asset) throw new Error(`${name}: no asset for platform ${plat}`);
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) throw new Error(`${name}: lock has no valid sha256 for ${plat}`);
  const toolDir = path.join(dest, `${name}-${tool.version}-${plat}`);
  const exe = path.join(toolDir, exeName(tool.binary, plat));
  const stampFile = path.join(toolDir, '.ot-tool.json');
  if (fs.existsSync(exe) && fs.existsSync(stampFile)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
      if (stamp.archiveSha256 === asset.sha256 && stamp.binarySha256 === fileSha256(exe)) {
        checkVersion(exe, tool, name);
        log(`${name} ${tool.version} (cached, verified)`);
        return exe;
      }
      log(`${name}: cached copy does not match the lock; fetching again`);
    } catch (e) {
      if (e instanceof VerificationError) throw e;
      log(`${name}: unreadable stamp; fetching again`);
    }
  }
  const dlDir = path.join(dest, '_downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  const archive = path.join(dlDir, path.basename(asset.name));
  if (!fs.existsSync(archive) || fileSha256(archive) !== asset.sha256) {
    log(`downloading ${asset.url}`);
    await download(asset.url, archive);
  }
  const got = fileSha256(archive);
  if (got !== asset.sha256) {
    fs.rmSync(archive, { force: true });
    throw new VerificationError(`${name}: sha256 mismatch for ${asset.name}: got ${got}, lock says ${asset.sha256}`);
  }
  fs.rmSync(toolDir, { recursive: true, force: true });
  const out = extractMember(archive, exeName(tool.binary, plat), toolDir);
  checkVersion(out, tool, name);
  fs.writeFileSync(stampFile, JSON.stringify({ tool: name, version: tool.version, asset: asset.name, archiveSha256: got, binarySha256: fileSha256(out) }, null, 2));
  log(`${name} ${tool.version} verified (sha256 ${got.slice(0, 12)}...)`);
  return out;
}

function ensurePipTool(name, tool, dest, plat, lockDir, python) {
  const toolDir = path.join(dest, `${name}-${tool.version}-${plat}`);
  const exe = path.join(toolDir, ...exeName(tool.binary, plat).split('/'));
  const stampFile = path.join(toolDir, '.ot-tool.json');
  if (fs.existsSync(exe) && fs.existsSync(stampFile)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
      if (stamp.binarySha256 === fileSha256(exe)) {
        checkVersion(exe, tool, name);
        log(`${name} ${tool.version} (cached, verified)`);
        return exe;
      }
      log(`${name}: cached copy changed since install; reinstalling`);
    } catch {
      log(`${name}: cached copy failed verification; reinstalling`);
    }
  }
  const req = path.join(lockDir, tool.requirements);
  if (!fs.existsSync(req)) throw new Error(`${name}: requirements file missing: ${req}`);
  fs.rmSync(toolDir, { recursive: true, force: true });
  const py = python ?? (process.platform === 'win32' ? 'python' : 'python3');
  const args = ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--quiet', '--require-hashes',
    '--only-binary', ':all:', '--no-deps', '--target', toolDir, '-r', req];
  log(`${py} ${args.join(' ')}`);
  const r = spawnSync(py, args, { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${name}: pip install failed: ${String(r.stderr || r.error).trim().slice(-800)}`);
  if (!fs.existsSync(exe)) throw new Error(`${name}: ${exe} missing after install`);
  checkVersion(exe, tool, name);
  fs.writeFileSync(stampFile, JSON.stringify({ tool: name, version: tool.version, requirements: tool.requirements, binarySha256: fileSha256(exe) }, null, 2));
  log(`${name} ${tool.version} installed (pip --require-hashes)`);
  return exe;
}

/** Ensure the tool is present and verified; returns the executable path. */
export async function ensureTool(name, { dest = DEFAULT_DEST, lock = DEFAULT_LOCK, platform = platformKey(), python } = {}) {
  const lockData = JSON.parse(fs.readFileSync(lock, 'utf8'));
  const tool = lockData.tools?.[name];
  if (!tool) throw new Error(`unknown tool ${name} (lock: ${Object.keys(lockData.tools ?? {}).join(', ')})`);
  fs.mkdirSync(dest, { recursive: true });
  if (tool.kind === 'archive') return ensureArchiveTool(name, tool, dest, platform);
  if (tool.kind === 'pip') return ensurePipTool(name, tool, dest, platform, path.dirname(lock), python);
  throw new Error(`${name}: unknown kind ${tool.kind}`);
}

async function main(argv) {
  let o;
  let positional;
  try {
    ({ opts: o, positional } = parseArgs(argv, { dest: 'string', lock: 'string', platform: 'string', python: 'string', help: 'bool' }));
  } catch (e) {
    process.stderr.write(`fetch-tool: ${e.message}\n`);
    return 2;
  }
  if (o.help || positional.length !== 1) {
    process.stderr.write('usage: fetch-tool.mjs <tool> [--dest DIR] [--lock FILE] [--platform OS-ARCH] [--python EXE]\n');
    return 2;
  }
  try {
    const exe = await ensureTool(positional[0], { dest: o.dest ? path.resolve(o.dest) : undefined, lock: o.lock ? path.resolve(o.lock) : undefined, platform: o.platform, python: o.python });
    process.stdout.write(`${exe}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`fetch-tool: ${e.message}\n`);
    return e instanceof VerificationError ? 1 : 2;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
