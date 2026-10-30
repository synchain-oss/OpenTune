#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// release-notices: write THIRD-PARTY-NOTICES.txt and build-info.json for the unofficial Windows and
// macOS test builds from what is really in the build. Runs in build-windows.yml's and build-macos.yml's
// release-package mode, right after the Release build of the Standalone (the build tree, the JUCE
// checkout and the dependencies are still there).
//
//   - The Ninja graph (Windows: CMakeFiles/impl-<config>.ninja; macOS: build.ninja) gives every object
//     linked into the executable (OpenTune.exe, or Contents/MacOS/OpenTune of the app bundle), with its
//     source and -D macros: JUCE modules, SoundTouch, r8brain, the ARA link check.
//   - Data embedded in the executable (font, cursor images, piano samples) is found by searching the
//     executable for a sample of each repository file.
//   - Packages vendored inside JUCE come from JUCE.spdx.json, filtered by module and switches.
//   - The catalogue is .github/release/notices.json.
//
// Release blockers (fail closed): a component with unverified redistribution terms that is in the
// build, and a component that the repository has but whose probe finds nothing in the build while its
// terms ask for something (unverified terms, license text, the GPL-3.0 appendix). A probe can stop
// matching after an upstream change while the component is still compiled in; dropping its notice
// silently would be wrong, so a person has to look (fix the probe, or record "absentOk" with a reason).
// Catalogue fields that steer this: "redistribution": "unverified", "mustAppear": true (a boolean; puts a
// component in the fail-closed class although its terms ask for no license text) and "absentOk": "<reason>".
//
// CLI: node release-notices.mjs --build <dir> --deps <dir> --out-notices <file> --out-info <file>
//        [--platform windows|macos] [--config Release] [--target OpenTuneStandalone_Standalone]
//        [--repo <dir>] [--juce <dir>] [--catalogue <file>] [--commands <json file>]
//   exit 0 = written (release blockers are listed in build-info.json and printed as warnings;
//   release-package.mjs refuses a tagged release while any is listed),
//   1 = the build does not qualify (control API off, a required file is missing), 2 = usage error
import fs from 'node:fs';
import path from 'node:path';
import { isMainModule, parseArgs, repoTop } from './fork-lib.mjs';
import {
  araLinkStatus,
  containsSample,
  juceModuleOf,
  linkClosure,
  machoInfo,
  minMacosOf,
  ORT_DLL_RE,
  ORT_DYLIB_RE,
  parseNinja,
  selectJuceVendored,
  sha256Hex,
} from './release-lib.mjs';

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);
const LICENSE_FILE_RE = /^(?:licen[cs]e|copying|[^/]*licen[cs]e[^/]*)(?:\.(?:txt|md))?$/i;

/** Read `NAME:TYPE=VALUE` entries of CMakeCache.txt. */
export function readCmakeCache(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+):[A-Z_]+=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Simple glob for one directory level: "dir/*.png" or an exact relative path. */
function expandRepoGlob(repo, pattern) {
  const dir = path.posix.dirname(pattern);
  const base = path.posix.basename(pattern);
  const abs = path.join(repo, dir);
  if (!fs.existsSync(abs)) return [];
  if (!base.includes('*')) return fs.existsSync(path.join(abs, base)) ? [`${dir}/${base}`] : [];
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`);
}

function depDir(depsRoot, lock, prefix, platform = 'windows') {
  const hits = lock.deps.filter((d) => d.name.startsWith(prefix) && !d.optional && (!d.platforms || d.platforms.includes(platform)));
  if (hits.length !== 1) throw new Error(`deps.lock.json: expected one dependency named ${prefix}*, found ${hits.length}`);
  return { dir: path.join(depsRoot, hits[0].name), version: hits[0].name.slice(prefix.length) };
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd();
}

/**
 * Does a catalogue component oblige the package to carry something (license text, the GPL-3.0
 * appendix), are its redistribution terms unverified, or does the catalogue say "mustAppear"? Such a
 * component must not drop out of the notices just because its probe missed it.
 */
export function mustNotDropSilently(c) {
  return c.redistribution === 'unverified' || Boolean(c.mustAppear) || Boolean(c.needsGpl3) || Boolean(c.requireOneLicenseFile) || (c.licenseFiles ?? []).some((lf) => !lf.optional);
}

/**
 * Evaluate the probes of the catalogue components and gather their license texts.
 * @returns {{sections: object[], included: string[], excluded: {id, why}[], blockers: {id, why}[], needsGpl3: boolean, vendored: object}}
 */
export function collectComponents({ catalogue, closure, exeBuf, appFiles, roots, lock, sbom, platform = 'windows' }) {
  const mac = platform === 'macos';
  const exeName = mac ? 'OpenTune' : 'OpenTune.exe';
  const where = mac ? 'next to the executable in Contents/Frameworks' : 'next to OpenTune.exe';
  const conditions = { ...(catalogue.juceVendored?.conditions ?? {}), ...(catalogue.juceVendored?.conditionsByPlatform?.[platform] ?? {}) };
  const sections = [];
  const included = [];
  const excluded = [];
  const blockers = [];
  let needsGpl3 = false;
  const ortDll = appFiles.find((f) => (mac ? ORT_DYLIB_RE : ORT_DLL_RE).test(f)) ?? (mac ? 'libonnxruntime.*.dylib' : 'OpenTuneOnnxRuntime_*.dll');
  const ara = araLinkStatus(closure);
  const modules = new Set(closure.objects.map((o) => juceModuleOf(o.source)).filter(Boolean));
  let vendored = { included: [], excluded: [], modules: [...modules].sort() };

  for (const c of catalogue.components) {
    const p = c.probe ?? { kind: 'always' };
    if (c.platforms !== undefined && !(Array.isArray(c.platforms) && c.platforms.length && c.platforms.every((x) => x === 'windows' || x === 'macos'))) throw new Error(`${c.id}: platforms must be a non-empty list of windows / macos`);
    if (c.platforms && !c.platforms.includes(platform)) {
      excluded.push({ id: c.id, why: `not part of the ${platform} build` });
      continue;
    }
    if (c.absentOk !== undefined && !(typeof c.absentOk === 'string' && c.absentOk.trim())) throw new Error(`${c.id}: absentOk must be a non-empty reason`);
    if (c.mustAppear !== undefined && typeof c.mustAppear !== 'boolean') throw new Error(`${c.id}: mustAppear must be true or false`);
    let found;
    let evidence;
    // Repository files of the component (embedded data, or probe.repoFiles of a source / include
    // probe): when they exist but the probe finds nothing, the fail-closed rule below applies.
    let repoFiles = [];
    let repoPattern = null;
    switch (p.kind) {
      case 'always':
        found = true;
        evidence = 'always';
        break;
      case 'juce':
        found = modules.size > 0;
        evidence = `${modules.size} JUCE modules linked`;
        break;
      case 'source': {
        const re = new RegExp(p.pattern, 'i');
        const hits = closure.objects.filter((o) => re.test(o.source));
        found = hits.length > 0;
        evidence = `${hits.length} compiled sources match ${p.pattern}`;
        if (p.repoFiles) [repoFiles, repoPattern] = [expandRepoGlob(roots.repo, p.repoFiles), p.repoFiles];
        break;
      }
      case 'include': {
        const re = new RegExp(p.pattern, 'i');
        found = closure.objects.some((o) => o.includes.some((i) => re.test(i.replace(/\/+$/, ''))));
        evidence = found ? `include path matches ${p.pattern}` : `no include path matches ${p.pattern}`;
        if (p.repoFiles) [repoFiles, repoPattern] = [expandRepoGlob(roots.repo, p.repoFiles), p.repoFiles];
        break;
      }
      case 'embedded': {
        const files = expandRepoGlob(roots.repo, p.files);
        if (!files.length) throw new Error(`${c.id}: no repository file matches ${p.files}`);
        const present = files.filter((f) => containsSample(exeBuf, fs.readFileSync(path.join(roots.repo, f))));
        found = present.length > 0;
        evidence = `${present.length} of ${files.length} files of ${p.files} embedded in ${exeName}`;
        [repoFiles, repoPattern] = [files, p.files];
        break;
      }
      case 'appFile': {
        const re = new RegExp(p.pattern);
        const hits = appFiles.filter((f) => re.test(f));
        found = hits.length > 0;
        evidence = found ? `${hits.join(', ')} ${where}` : `no file matching ${p.pattern} ${where}`;
        break;
      }
      case 'ara':
        found = ara.linked;
        evidence = ara.linked ? ara.reasons.join('; ') : 'not linked: no ARA SDK source, no ARA library, JucePlugin_Enable_ARA and JUCE_PLUGINHOST_ARA are 0 in every linked object';
        break;
      default:
        throw new Error(`${c.id}: unknown probe kind ${p.kind}`);
    }
    if (!found) {
      if (repoFiles.length && mustNotDropSilently(c)) {
        const inRepo = `${repoFiles.length} file(s) matching ${repoPattern}`;
        if (c.absentOk) {
          excluded.push({ id: c.id, why: `${evidence}; the repository has ${inRepo}; absence accepted: ${c.absentOk}` });
          continue;
        }
        // Fail closed: the repository has the component and its terms ask for something, but the probe
        // found nothing. The probe may simply have stopped matching (another embedding, a changed file,
        // a moved path) while the component is still in the build.
        const terms = c.redistribution === 'unverified' ? 'its redistribution terms are unverified' : 'its notice would be dropped';
        blockers.push({
          id: c.id,
          why: `${c.name}: the repository has ${inRepo}, but the probe found none in the build (${evidence}) and ${terms}. Fix the probe, or set "absentOk": "<reason>" in notices.json once it is confirmed that the build no longer contains it.`,
        });
        excluded.push({ id: c.id, why: `release blocker: the probe found nothing although the repository has ${inRepo} (${evidence})` });
        continue;
      }
      excluded.push({ id: c.id, why: evidence });
      continue;
    }
    if (c.redistribution === 'unverified') {
      blockers.push({ id: c.id, why: `${c.name} is in the build (${evidence}), but its redistribution terms are unverified: ${c.unverifiedReason}` });
      excluded.push({ id: c.id, why: `redistribution terms unverified (${evidence})` });
      continue;
    }
    let version = null;
    if (c.versionFromDep) version = depDir(roots.deps, lock, c.versionFromDep, platform).version;
    const texts = [];
    for (const lf of c.licenseFiles ?? []) {
      const base = lf.root === 'repo' ? roots.repo : lf.root === 'juce' ? roots.juce : lf.root === 'dep' ? depDir(roots.deps, lock, lf.dep, platform).dir : null;
      if (!base) throw new Error(`${c.id}: unknown license file root ${lf.root}`);
      const file = path.join(base, lf.path);
      if (!fs.existsSync(file)) {
        if (lf.optional) continue;
        throw new Error(`${c.id}: license file missing: ${lf.root}:${lf.path}`);
      }
      texts.push({ title: path.posix.basename(lf.path), text: readText(file) });
    }
    if (c.requireOneLicenseFile && !texts.length) throw new Error(`${c.id}: none of its license files exists`);
    if (c.needsGpl3) needsGpl3 = true;
    if (c.id === 'juce-vendored') {
      vendored = selectJuceVendored(sbom, closure, conditions);
      for (const v of vendored.included) {
        const vTexts = [];
        const loc = v.location ? path.join(roots.juce, v.location) : null;
        if (loc && fs.existsSync(loc) && fs.statSync(loc).isDirectory()) {
          for (const f of fs.readdirSync(loc).sort()) {
            if (LICENSE_FILE_RE.test(f) && fs.statSync(path.join(loc, f)).isFile()) vTexts.push({ title: f, text: readText(path.join(loc, f)) });
          }
        }
        const extra = catalogue.juceVendored?.extraText?.[v.name];
        if ((catalogue.juceVendored?.needsGpl3 ?? []).includes(v.name)) needsGpl3 = true;
        sections.push({
          id: `juce-vendored:${v.name}`,
          name: `${v.name} ${v.version ?? ''}`.trim(),
          license: v.license,
          url: v.url,
          usedIn: `${exeName}, as part of the JUCE module ${v.module} (${v.why})`,
          notes: [
            ...(extra ? [extra] : []),
            ...(vTexts.length ? [] : [`The license text is in the vendored source files at ${v.location ?? v.module} in the JUCE ${sbom.packages?.[0]?.versionInfo ?? ''} source tree.`]),
            ...(v.location ? [`Source: ${v.location} in the JUCE source tree.`] : []),
          ],
          texts: vTexts,
        });
      }
      included.push(c.id);
      continue;
    }
    sections.push({
      id: c.id,
      name: version ? `${c.name} ${version}` : c.name,
      license: c.license,
      copyright: c.copyright,
      url: c.url,
      usedIn: String(c.usedIn ?? '').replace('{{ORT_DLL}}', ortDll).replaceAll('OpenTune.exe', exeName),
      notes: c.notes ?? [],
      texts,
    });
    included.push(c.id);
  }
  // Sections follow the catalogue order; the JUCE-vendored packages sit where juce-vendored is listed.
  return { sections, included, excluded, blockers, needsGpl3, vendored, ara };
}

/** Render THIRD-PARTY-NOTICES.txt. */
export function renderNotices({ header, sections, gpl3Text }) {
  const out = [];
  out.push(RULE, 'THIRD-PARTY NOTICES', header.title, RULE, '');
  for (const line of header.intro) out.push(line);
  out.push('', 'Contents', '');
  sections.forEach((s, i) => out.push(`  ${String(i + 1).padStart(2)}. ${s.name}`));
  if (gpl3Text) out.push('   A. GNU General Public License, version 3');
  out.push('');
  sections.forEach((s, i) => {
    out.push(RULE, `${i + 1}. ${s.name}`, RULE);
    if (s.license) out.push(`License: ${s.license}`);
    if (s.copyright) out.push(s.copyright);
    if (s.url) out.push(`Project: ${s.url}`);
    if (s.usedIn) out.push(`Used in: ${s.usedIn}`);
    for (const n of s.notes ?? []) out.push('', n);
    for (const t of s.texts ?? []) out.push('', THIN, t.title, THIN, '', t.text);
    out.push('');
  });
  if (gpl3Text) out.push(RULE, 'A. GNU General Public License, version 3', RULE, '', gpl3Text, '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

const WINDOWS_INTRO = [
  'This file lists the third-party components that are part of this build, as found in the',
  'build itself, with their licenses. OpenTune\'s own license is in LICENSE.txt.',
  '',
  'This package contains no model weights. The AI models are used from your own installation of',
  'official OpenTune and are not distributed with this build. The DirectX 12 Agility runtime',
  '(D3D12Core.dll) is not included either; INSTALL.txt explains how to copy it from your official',
  'installation.',
];
const MACOS_INTRO = [
  'This file lists the third-party components that are part of this build, as found in the',
  'build itself, with their licenses. OpenTune\'s own license is in LICENSE.txt.',
  '',
  'This package contains no model weights. The AI models are used from your own installation of',
  'official OpenTune (OpenTune.app) and are not distributed with this build.',
];

/**
 * The facts of a Windows build: the ONNX Runtime DLL next to the executable and the Agility runtime.
 * @returns {{appFiles: string[], extra: object}}
 */
function windowsFacts({ exe, closure, cache }) {
  const exeDir = path.dirname(exe);
  const appFiles = fs.readdirSync(exeDir).filter((f) => fs.statSync(path.join(exeDir, f)).isFile());
  const delayLoaded = /\/DELAYLOAD:(\S+\.dll)/i.exec(closure.linkFlags)?.[1];
  if (!delayLoaded || !ORT_DLL_RE.test(delayLoaded) || !appFiles.includes(delayLoaded)) throw new Error(`ONNX Runtime DLL not found next to OpenTune.exe (delay-loaded: ${delayLoaded ?? 'none'})`);
  const d3d12Core = path.join(exeDir, 'D3D12', 'D3D12Core.dll');
  if (!fs.existsSync(d3d12Core)) throw new Error('D3D12\\D3D12Core.dll missing from the build output (needed for its hash; it is never packaged)');
  const sdkVersions = new Set(closure.objects.map((x) => x.defines.OPENTUNE_D3D12_AGILITY_SDK_VERSION).filter(Boolean));
  if (sdkVersions.size !== 1) throw new Error(`expected one OPENTUNE_D3D12_AGILITY_SDK_VERSION in the linked objects, found ${[...sdkVersions].join(', ') || 'none'}`);
  return {
    appFiles,
    extra: {
      ortDll: delayLoaded,
      d3d12: {
        agilityVersion: cache.OPENTUNE_D3D12_AGILITY_VERSION ?? null,
        sdkVersion: Number([...sdkVersions][0]),
        files: [{ name: 'D3D12Core.dll', sha256: sha256Hex(fs.readFileSync(d3d12Core)) }],
      },
      directmlVersion: cache.OPENTUNE_DIRECTML_VERSION ?? null,
    },
  };
}

/**
 * The facts of a macOS build: the executable is Contents/MacOS/OpenTune of the .app bundle and the ONNX
 * Runtime dylib sits in Contents/Frameworks. The Mach-O headers give the architectures and the minimum
 * macOS version the binaries ask for (the highest of them is what the package states as its minimum).
 * @returns {{appFiles: string[], extra: object}}
 */
function macosFacts({ exe, exeBuf, cache }) {
  const frameworks = path.join(path.dirname(exe), '..', 'Frameworks');
  if (!fs.existsSync(frameworks)) throw new Error(`${frameworks} does not exist: the app bundle has no Frameworks folder`);
  const appFiles = fs.readdirSync(frameworks).filter((f) => fs.statSync(path.join(frameworks, f)).isFile());
  const ortDylibs = appFiles.filter((f) => ORT_DYLIB_RE.test(f));
  if (ortDylibs.length !== 1) throw new Error(`expected one libonnxruntime.<x.y.z>.dylib in ${frameworks}, found ${ortDylibs.join(', ') || 'none'}`);
  const exeInfo = machoInfo(exeBuf);
  const ortInfo = machoInfo(fs.readFileSync(path.join(frameworks, ortDylibs[0])));
  for (const [what, info] of [['OpenTune', exeInfo], ['the ONNX Runtime dylib', ortInfo]]) {
    const archs = info.slices.map((s) => s.arch);
    if (!archs.includes('arm64')) throw new Error(`${what} has no arm64 slice (${archs.join(', ')})`);
  }
  return {
    appFiles,
    extra: {
      ortDylib: ortDylibs[0],
      ortDylibIsLinked: exeInfo.slices.some((s) => s.dependencies.some((d) => d.name.endsWith(`/${ortDylibs[0]}`))),
      architectures: cache.CMAKE_OSX_ARCHITECTURES ?? null,
      deploymentTarget: cache.CMAKE_OSX_DEPLOYMENT_TARGET ?? null,
      minMacos: minMacosOf([exeInfo, ortInfo]),
      macho: {
        executable: { universal: exeInfo.universal, slices: exeInfo.slices.map((s) => ({ arch: s.arch, minos: s.minos, sdk: s.sdk, rpaths: s.rpaths })) },
        [ortDylibs[0]]: { universal: ortInfo.universal, slices: ortInfo.slices.map((s) => ({ arch: s.arch, minos: s.minos, sdk: s.sdk, installName: s.installName })) },
      },
    },
  };
}

function main(argv) {
  let o;
  try {
    ({ opts: o } = parseArgs(argv, {
      build: 'string', deps: 'string', platform: 'string', config: 'string', target: 'string', repo: 'string', juce: 'string',
      catalogue: 'string', commands: 'string', 'out-notices': 'string', 'out-info': 'string', help: 'bool',
    }));
  } catch (e) {
    process.stderr.write(`release-notices: ${e.message}\n`);
    return 2;
  }
  if (o.help || !o.build || !o.deps || !o['out-notices'] || !o['out-info'] || (o.platform !== undefined && o.platform !== 'windows' && o.platform !== 'macos')) {
    process.stderr.write('usage: release-notices.mjs --build <dir> --deps <dir> --out-notices <file> --out-info <file> [--platform windows|macos] [--config Release] [--target <t>] [--repo <dir>] [--juce <dir>] [--catalogue <file>] [--commands <json>]\n');
    return 2;
  }
  const platform = o.platform ?? 'windows';
  const mac = platform === 'macos';
  const config = o.config ?? 'Release';
  const target = o.target ?? 'OpenTuneStandalone_Standalone';
  const repo = path.resolve(o.repo ?? repoTop(process.cwd()));
  const roots = { repo, juce: path.resolve(o.juce ?? path.join(repo, 'JUCE-master')), deps: path.resolve(o.deps) };
  const build = path.resolve(o.build);
  try {
    const cache = readCmakeCache(fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'));
    if (!/^(ON|TRUE|1|YES)$/i.test(cache.OPENTUNE_ENABLE_CONTROL_API ?? '')) throw new Error('the build was configured with OPENTUNE_ENABLE_CONTROL_API off; a test build needs it on');
    // Windows builds with Ninja Multi-Config (one impl-<config>.ninja per configuration); macOS with plain Ninja.
    const ninjaFile = mac ? path.join(build, 'build.ninja') : path.join(build, 'CMakeFiles', `impl-${config}.ninja`);
    const closure = linkClosure(parseNinja(fs.readFileSync(ninjaFile, 'utf8')), { target, config });
    const exe = path.join(build, closure.exe);
    const exeBuf = fs.readFileSync(exe);
    const facts = mac ? macosFacts({ exe, exeBuf, cache }) : windowsFacts({ exe, closure, cache });
    const { appFiles } = facts;
    const lock = JSON.parse(fs.readFileSync(path.join(repo, '.github', 'scripts', 'deps.lock.json'), 'utf8'));
    const sbom = JSON.parse(fs.readFileSync(path.join(roots.juce, 'JUCE.spdx.json'), 'utf8'));
    const catalogue = JSON.parse(fs.readFileSync(o.catalogue ?? path.join(repo, '.github', 'release', 'notices.json'), 'utf8'));
    const got = collectComponents({ catalogue, closure, exeBuf, appFiles, roots, lock, sbom, platform });
    const gpl3Text = got.needsGpl3 ? readText(path.join(repo, '.github', 'release', 'licenses', 'GPL-3.0.txt')) : null;
    const notices = renderNotices({
      header: {
        title: mac ? 'OpenTune with the local control API - unofficial test build for macOS (Apple silicon, arm64)' : 'OpenTune with the local control API - unofficial test build for Windows x64',
        intro: mac ? MACOS_INTRO : WINDOWS_INTRO,
      },
      sections: got.sections,
      gpl3Text,
    });
    // Windows text files use CRLF (Notepad); the macOS ones use LF.
    const noticesText = mac ? notices : notices.replace(/\n/g, '\r\n');
    fs.writeFileSync(o['out-notices'], noticesText);
    const info = {
      schema: 1,
      ...(mac ? { platform: 'macos-arm64' } : {}),
      config,
      target,
      controlApi: true,
      ...facts.extra,
      linkedObjects: closure.objects.length,
      juceModules: got.vendored.modules,
      ara: got.ara,
      notices: {
        included: got.included,
        juceVendored: got.vendored.included.map((v) => `${v.name} ${v.version}`),
        excluded: got.excluded,
        juceVendoredExcluded: got.vendored.excluded,
        gpl3Appendix: Boolean(gpl3Text),
        sha256: sha256Hex(Buffer.from(noticesText)),
      },
      blockers: got.blockers,
      commands: o.commands ? JSON.parse(fs.readFileSync(o.commands, 'utf8')) : null,
    };
    fs.writeFileSync(o['out-info'], `${JSON.stringify(info, null, 2)}\n`);
    process.stdout.write(`release-notices: ${got.sections.length} sections (${got.vendored.included.length} vendored in JUCE); ARA ${got.ara.linked ? 'LINKED' : 'not linked'}; excluded: ${got.excluded.map((x) => x.id).join(', ') || 'none'}\n`);
    for (const b of got.blockers) process.stdout.write(`::warning title=release blocker::${b.why}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`release-notices: ${e.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
