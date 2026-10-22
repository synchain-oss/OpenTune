// SPDX-FileCopyrightText: Copyright (c) 2026 Synchain
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small, consistent documentation + code tree for the doc-consistency tests: the README of the control API
// (method table, capabilities sentence, hook list, test names), the hook table of CLAUDE.md, two Ops groups with
// the registry that calls them, the protocol table, three spec schemas, hook markers in three files, the CMake
// test registrations and the mirror files. Each test copies it and plants one difference.
import { readMirrors, renderPinFiles } from '../drift-pins.mjs';

const h = (c) => c.repeat(64);

const MARKER = (purpose) => `// OpenTune Control API hook: ${purpose}, see Source/Control/README.md#hooks`;
const ON = '#if JucePlugin_Build_Standalone && defined(OPENTUNE_ENABLE_CONTROL_API)';

export const FIXTURE_README = [
  '<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->',
  '',
  '# OpenTune control API (OTCP v1)',
  '',
  '## Hooks',
  '',
  'These are all the changes to files that exist upstream.',
  '',
  '| File | Hook | Purpose | If it is removed |',
  '|---|---|---|---|',
  '| `CMakeLists.txt` (end) | `option(OPENTUNE_ENABLE_CONTROL_API …)` and `include(cmake/OpenTuneControl.cmake)` | Build option. | Never built. |',
  '| `Source/Foo.h` (end of the class) | Public `ensureRuntime()`; member `service_` | Runtime. | Gone. |',
  '| `Source/Foo.cpp` (includes) | `#include "Control/Service.h"` | Type. | No compile. |',
  '| `Source/Foo.cpp` (end of the constructor) | Create the service, `scheduleStart()` | Starts it. | Never starts. |',
  '| `Source/Foo.cpp` (first statement of the destructor) | `service_->stop()` | Stops it. | Crash. |',
  '',
  '## Method table',
  '',
  '| Method | Capability | Ops file | Tests | Schema |',
  '|---|---|---|---|---|',
  '| `session.hello` | `session.v1` | answered by `ControlServer` | `ControlUnitTests` | `methods/session.hello.schema.json` |',
  '| `session.info` | `session.v1` | `Ops/AlphaOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/session.info.schema.json` |',
  '| `content.getNotes` | `read.v1` | `Ops/AlphaOps.cpp` | `ControlProcessorTests.Reads` | `methods/content.getNotes.schema.json` |',
  '| `track.add` | `tracks.v1` | `Ops/BetaOps.cpp` (barrier in `Edit/X.cpp`) | `ControlProcessorTests.Tracks` | `methods/track.add.schema.json` |',
  '',
  '## Capabilities and protocol versions',
  '',
  'The instance serves protocol 1.0. The capabilities it reports come from the',
  'method table: `session.v1` always, and the capability of every registered method (now `read.v1`',
  'and `tracks.v1`). The listener answers the rest itself.',
  '',
  '## Tests',
  '',
  '`Tests/Control/ControlUnitTests.cpp` tests the channel. Run them with `ctest -R Control`.',
  '`ControlMirrorDriftTests` is the ctest name of the mirror test.',
  '',
].join('\n');

export const FIXTURE_CLAUDE = [
  '<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->',
  '',
  '# CLAUDE.md',
  '',
  '- **已声明的钩子**：这是对上游已有文件的全部改动。',
  '',
  '| 钩子 | 文件 | 约行数 |',
  '|---|---|---|',
  '| `option()` + `include(cmake/OpenTuneControl.cmake)` | `CMakeLists.txt` | 2–5 |',
  '| `ensureRuntime()`；`service_` 成员；构造末尾 `scheduleStart()`；析构第一句 `stop()` | `Source/Foo.h/.cpp` | 约 20 |',
  '',
  '- 表外的上游文件一律不改。',
  '',
].join('\n');

const FOO_H = [
  '#pragma once',
  'class Foo',
  '{',
  'public:',
  '    void run();',
  ON,
  `    ${MARKER('runtime init and the service')}`,
  '    void ensureRuntime();',
  '    std::unique_ptr<Service> service_;',
  '#endif',
  '};',
  '',
].join('\n');

const FOO_CPP = [
  '#include "Foo.h"',
  `#include "Control/Service.h"  ${MARKER('service type')}`,
  '',
  'Foo::Foo()',
  '{',
  '    int a = 0;',
  ON,
  `    ${MARKER('the service starts after this constructor')}`,
  '    service_ = std::make_unique<Service>(*this);',
  '    service_->scheduleStart();',
  '#endif',
  '}',
  '',
  'Foo::~Foo()',
  '{',
  ON,
  `    ${MARKER('stop the service first')}`,
  '    service_->stop();',
  '#endif',
  '    int b = 0;',
  '}',
  '',
].join('\n');

const ROOT_CMAKE = [
  'cmake_minimum_required(VERSION 3.22)',
  'project(Upstream)',
  '',
  MARKER('build option and control sources').replace('//', '#'),
  'option(OPENTUNE_ENABLE_CONTROL_API "Build the control API" OFF)',
  'include(cmake/OpenTuneControl.cmake)',
  '',
].join('\n');

const CONTROL_CMAKE = [
  'add_test(NAME ControlUnitTests COMMAND OpenTuneControlUnitTests)',
  'add_test(NAME ControlMirrorDriftTests COMMAND OpenTuneControlMirrorDriftTests)',
  'set(_opentune_control_scenarios',
  '    "Reads|--control-api"',
  '    "Vectors|--control-api"',
  ')',
  '# Transport and tracks.',
  'list(APPEND _opentune_control_scenarios',
  '    "Tracks|--control-api"',
  ')',
  'foreach(_opentune_control_scenario IN LISTS _opentune_control_scenarios)',
  '    string(REPLACE "|" ";" _opentune_control_scenario "${_opentune_control_scenario}")',
  '    list(GET _opentune_control_scenario 0 _opentune_control_name)',
  '    set(_opentune_control_test "ControlProcessorTests.${_opentune_control_name}")',
  '    add_test(NAME ${_opentune_control_test} COMMAND OpenTuneControlProcessorTests)',
  'endforeach()',
  '',
].join('\n');

const ALPHA_OPS = [
  'namespace OpenTune {',
  'void registerAlphaOps(ControlMethodTable& table)',
  '{',
  '    table.add(controlReadMethod<ControlNoParams>("session.info", controlParseNoParams, runInfo));',
  '    // table.add(controlReadMethod<X>("never.registered", parseX, runX));',
  '    table.add(controlReadMethod<NotesParams>("content.getNotes", parseNotes, runNotes));',
  '}',
  '} // namespace OpenTune',
  '',
].join('\n');

const BETA_OPS = [
  'namespace OpenTune {',
  'void registerBetaOps(ControlMethodTable& table)',
  '{',
  '    table.add(controlWriteMethod<AddParams>("track.add", parseAdd, runAdd));',
  '}',
  '} // namespace OpenTune',
  '',
].join('\n');

const OPS_REGISTRY = [
  'namespace OpenTune {',
  'struct FeatureCapability',
  '{',
  '    const char* capability;',
  '    const char* extends;',
  '};',
  'constexpr FeatureCapability kFeatureCapabilities[] = {',
  '    {"ui.onboardingClose", "ui.bridge"},',
  '};',
  '',
  'void registerControlMethods(ControlMethodTable& table)',
  '{',
  '    registerAlphaOps(table); // session.info (ControlServer answers session.hello itself), content.getNotes',
  '    registerBetaOps(table);  // track.add',
  '}',
  '} // namespace OpenTune',
  '',
].join('\n');

const PROTOCOL_CPP = [
  'namespace {',
  'constexpr MethodCapability kMethods[] = {',
  '    {"session.hello", "session.v1"},',
  '    {"session.info", "session.v1"},',
  '    {"content.getNotes", "read.v1"},',
  '    {"track.add", "tracks.v1"},',
  '    {"track.delete", "tracks.v1"},',
  '};',
  '}',
  '',
].join('\n');

export const schemaText = (method, capability) => `${JSON.stringify({ title: method, 'x-otcp': { method, capability, write: 'no' } }, null, 2)}\n`;

const entry = (id, group, symbol, sha, normalization = 'fn-v1') => ({
  id,
  group,
  upstream: { file: 'Source/Up.cpp', symbol, kind: normalization === 'stmt-v1' ? 'statement' : 'function', normalization, sha256: sha },
  control: [{ file: `Source/Control/${group}.cpp`, symbols: ['x'] }],
});

export const FIXTURE_MIRRORS = [entry('one', 'alpha', 'A::one', h('1')), entry('two', 'alpha', 'A::two', h('2')), entry('three', 'beta', 'B::three', h('3'), 'stmt-v1')];

export const mirrorMapText = (mirrors = FIXTURE_MIRRORS) => `${JSON.stringify({ schema: 1, mirrors }, null, 2)}\n`;

export const mirrorsMdText = (rows = FIXTURE_MIRRORS.map((m) => [m.id, m.upstream.sha256])) =>
  [
    '# Mirrors',
    '<!-- mirror-table:begin (generated) -->',
    '| Id | a | b | c | sha256 | Note |',
    '|---|---|---|---|---|---|',
    ...rows.map(([id, sha]) => `| \`${id}\` | \`f\`<br>\`s\` (fn-v1) | \`c\` | \`T\` | \`${sha}\` | note |`),
    '<!-- mirror-table:end -->',
    '',
  ].join('\n');

/** The consistent tree as { path: text }. */
export function docFixture() {
  const files = {
    'Source/Control/README.md': FIXTURE_README,
    'CLAUDE.md': FIXTURE_CLAUDE,
    'CMakeLists.txt': ROOT_CMAKE,
    'cmake/OpenTuneControl.cmake': CONTROL_CMAKE,
    'Source/Foo.h': FOO_H,
    'Source/Foo.cpp': FOO_CPP,
    'Source/Control/Ops/OpsRegistry.cpp': OPS_REGISTRY,
    'Source/Control/Ops/AlphaOps.cpp': ALPHA_OPS,
    'Source/Control/Ops/BetaOps.cpp': BETA_OPS,
    'Source/Control/ControlProtocol.cpp': PROTOCOL_CPP,
    'Tests/Control/ControlUnitTests.cpp': '// test\n',
    'Source/Control/mirror-map.json': mirrorMapText(),
    'Source/Control/MIRRORS.md': mirrorsMdText(),
  };
  for (const [method, capability] of [['session.hello', 'session.v1'], ['session.info', 'session.v1'], ['content.getNotes', 'read.v1'], ['track.add', 'tracks.v1'], ['track.delete', 'tracks.v1']]) {
    files[`Tests/Control/spec/otcp/v1/methods/${method}.schema.json`] = schemaText(method, capability);
  }
  files['Tests/Control/spec/otcp/v1/methods/index.json'] = '{"methods": []}\n';
  const pins = renderPinFiles(readMirrors(mirrorMapText()), { pinnedAt: 'upstream/20261008-addb4f4', anchorOf: () => 'L1-L2' });
  for (const [name, text] of pins) files[`.github/drift-pins/${name}`] = text;
  return files;
}

/** Replace the first occurrence of `from` in one file of the fixture (throws when it is not there). */
export function patch(files, file, from, to) {
  const text = files[file];
  if (text == null || !text.includes(from)) throw new Error(`${file} does not contain ${JSON.stringify(from)}`);
  return { ...files, [file]: text.replace(from, () => to) };
}
