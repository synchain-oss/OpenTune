// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helpers: build throw-away git repositories in the system temp dir with `git commit-tree`, so
// the commits planted by the tests (bad identities, attribution trailers, ...) never enter this
// repository's history. Strings that the attribution rules or secret scanners would flag are only
// assembled at runtime, so this file itself contains none of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeTempDir, removeDir } from '../fork-lib.mjs';

export const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SCRIPTS, '..', '..');

export const FORK = { name: 'DLsnows', email: 'noreply@synchain.ca' };
export const WEB = { name: 'DLsnows', email: '140901583+DLsnows@users.noreply.github.com' };
export const GITHUB = { name: 'GitHub', email: 'noreply@github.com' };
export const UPSTREAM = { name: 'Upstream Author', email: 'upstream@example.invalid' };
export const STRANGER = { name: 'Someone Else', email: 'someone@example.invalid' };

export const SIGNOFF = `Signed-off-by: ${FORK.name} <${FORK.email}>`;
export const msg = (subject, ...trailers) => `${subject}\n\n${[...trailers, SIGNOFF].join('\n')}\n`;

/** An AI co-author trailer, assembled at runtime. */
export function aiTrailer() {
  const tool = ['Cla', 'ude'].join('');
  const vendor = ['anth', 'ropic'].join('');
  return `Co-Authored-By: ${tool} <noreply@${vendor}.com>`;
}

/** A "generated with" line, assembled at runtime. */
export function aiGeneratedLine() {
  return `Generated ${'with'} [${['Cla', 'ude'].join('')} Code](https://${['cla', 'ude'].join('')}.ai/code)`;
}

const PTR = 'version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 1234\n';
const BOM = '\uFEFF';

/** Files of the synthetic upstream snapshot. */
export const UPSTREAM_FILES = {
  '.gitignore': [
    'build-*/', 'models/*', '!models/fcpe.onnx', '!models/GAME/', 'docs/', '.*/', '*.exe', '*.dll', '*.onnx',
    '!models/fcpe.onnx', 'JUCE-master/', 'AGENTS.md', 'CLAUDE.md', 'ThirdParty/', 'tools/', '',
  ].join('\n'),
  '.gitattributes': '*.onnx filter=lfs diff=lfs merge=lfs -text\n',
  'README.md': '# Upstream\n',
  'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.22)\nproject(Upstream)\n',
  'Source/PluginProcessor.cpp': `${BOM}#include "PluginProcessor.h"\n\nnamespace OpenTune {\n\nvoid f()\n{\n    int a = 1;\n}\n\n} // namespace OpenTune\n`,
  'Source/Utils/AppLogger.cpp': 'void log()\r\n{\r\n    int x = 0;\r\n}\r\n',
  'Source/Utils/Foo.cpp': 'void foo()\n{\n    int y = 0;\n}\n',
  'models/fcpe.onnx': PTR,
  'ThirdParty/lib/a.h': '#pragma once\n',
};

export const PINNED_WORKFLOW = [
  '# SPDX-License-Identifier: AGPL-3.0-or-later',
  'name: ok',
  'on:',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  a:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          lfs: false',
  '      - run: |',
  '          echo "never use pull_request_target; lfs: true is forbidden"',
  '',
].join('\n');

/** Files of the fork's first commit on top of the snapshot. */
export function forkBaseFiles() {
  return {
    '.github/README.md': '<!--\nSPDX-License-Identifier: AGPL-3.0-or-later\n-->\n\n# Fork\n',
    'CLAUDE.md': '<!--\nSPDX-License-Identifier: AGPL-3.0-or-later\n-->\n\n# Rules\n',
    '.github/workflows/ok.yml': PINNED_WORKFLOW,
    'Source/Control/.clang-format': fs.readFileSync(path.join(REPO_ROOT, 'Source', 'Control', '.clang-format')),
  };
}

let dateCounter = 0;

export class TestRepo {
  constructor(dir) {
    this.dir = dir;
    this.indexCounter = 0;
  }

  /** Empty repository with local settings that keep the tests independent of the user's config. */
  static create(label = 'fc-test') {
    const dir = makeTempDir(label);
    git(['init', '-q', dir]);
    const repo = new TestRepo(dir);
    const empty = path.join(dir, '.git', 'ot-empty-excludes');
    fs.writeFileSync(empty, '');
    repo.git(['config', 'core.autocrlf', 'false']);
    repo.git(['config', 'core.excludesFile', empty]);
    return repo;
  }

  /**
   * Snapshot (tagged, mirrored) + fork base commit; origin/feature/control-api points at the fork base.
   * Returns the repo with .upstream and .forkBase set.
   */
  static withForkBase(label) {
    const repo = TestRepo.create(label);
    repo.upstream = repo.commit({ files: UPSTREAM_FILES, message: 'upstream snapshot\n', author: UPSTREAM });
    repo.ref('refs/tags/upstream/20260101-0000000', repo.upstream);
    repo.ref('refs/remotes/origin/upstream-mirror', repo.upstream);
    repo.forkBase = repo.commit({ parent: repo.upstream, files: forkBaseFiles(), message: msg('chore(fork): base') });
    repo.ref('refs/remotes/origin/feature/control-api', repo.forkBase);
    repo.ref('refs/heads/main', repo.forkBase);
    return repo;
  }

  git(args, opts = {}) {
    return git(args, { cwd: this.dir, ...opts });
  }

  /**
   * Create a commit without touching any working tree.
   * files: { path: string | Buffer | null }  (null deletes the path)
   */
  commit({ parent, parents, files = {}, message = msg('test: change'), author = FORK, committer }) {
    const ps = parents ?? (parent ? [parent] : []);
    const index = path.join(this.dir, '.git', `ot-index-${++this.indexCounter}`);
    const env = { GIT_INDEX_FILE: index };
    if (ps.length) this.git(['read-tree', ps[0]], { env });
    for (const [p, content] of Object.entries(files)) {
      if (content === null) {
        this.git(['update-index', '--force-remove', '--', p], { env });
        continue;
      }
      const sha = this.git(['hash-object', '-w', '--stdin'], { input: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') }).trim();
      this.git(['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`], { env });
    }
    const tree = this.git(['write-tree'], { env }).trim();
    fs.rmSync(index, { force: true });
    const c = committer ?? author;
    const date = `${1767225600 + ++dateCounter * 60} +0000`;
    const args = ['commit-tree', tree];
    for (const p of ps) args.push('-p', p);
    return this.git(args, {
      input: message,
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: c.name,
        GIT_COMMITTER_EMAIL: c.email,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
  }

  /** One commit on top of the fork base (or `parent`). */
  change(files, opts = {}) {
    return this.commit({ parent: opts.parent ?? this.forkBase, files, ...opts });
  }

  ref(name, sha) {
    this.git(['update-ref', name, sha]);
  }

  /** Check out `sha` into the working tree (detached), never smudging LFS pointers. */
  checkout(sha) {
    this.git(['checkout', '-q', '--detach', '-f', sha], { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  }

  write(rel, content) {
    const file = path.join(this.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  dispose() {
    removeDir(this.dir);
  }
}

/** A fake clang-format (node script): "formats" by stripping trailing whitespace; prints `version`. */
export function fakeClangFormat(dir, version = '18.1.8') {
  const file = path.join(dir, 'fake-clang-format.mjs');
  fs.writeFileSync(file, [
    "if (process.argv.includes('--version')) { console.log('clang-format version " + version + "'); process.exit(0); }",
    "const chunks = []; process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => { process.stdout.write(Buffer.concat(chunks).toString('utf8').replace(/[ \\t]+$/gm, '')); });",
    '',
  ].join('\n'));
  return [process.execPath, file];
}

/** Real tool paths when the environment provides them (CI sets these; locally use fetch-tool.mjs). */
export function realTool(envName) {
  const p = process.env[envName];
  return p && fs.existsSync(p) ? p : null;
}

export function byId(results, id) {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}: ${results.map((x) => x.id).join(', ')}`);
  return r;
}
