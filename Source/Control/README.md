<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OpenTune control API (OTCP v1)

> **概述（中文）**：本目录是 OpenTune Standalone 的本机控制接口（OTCP v1）。它只监听 `127.0.0.1`，编译期由 CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`（默认 OFF）控制，运行期默认关闭，只有设置 `OPENTUNE_CONTROL_API=1` 或传入 `--control-api` 才会启动。接口关闭时 OpenTune 的行为与没有本目录时完全相同。对上游已有文件的改动只有下文「Hooks」一节列出的几处接入钩子，每处都带 `// OpenTune Control API hook:` 标记。本文件面向 OpenTune 的维护者及其 AI agent：文件地图、线程规则、生命周期、钩子清单、请求处理流程（dispatcher）、job 模式、写结果（写信封）的构建、撤销描述与还原、撤销历史（撤销识别、ControlOriginAction、没有撤销条目的写入）、ContentEditTransaction 与它镜像的上游函数、音符编辑与移调（content.editNotes、content.setPitchShift、AUTO 的 SNAP，修正段按钢琴卷帘的步骤重建，令牌扣除移调步骤）、内容写入的就绪门、忙碌检查、编辑器 bridge、导入、导出（界面与接口共用的导出锁、逐内容的就绪判定、等待伸缩重建、临时文件与最终改名）、时间网格（照时间工具的两轮夹紧移动手柄、整段平移、以 job 种子锚点、TimeGridEditAction 撤销步、它镜像的上游函数）、对话框与首次引导（ui.getState、ui.dismiss：模态窗口的分类、照 Esc 关闭、系统文件选择器、阻止或关闭首次引导、不能压下的 F0 诊断）、镜像登记（MIRRORS.md、mirror-map.json、ControlMirrorDriftTests）、AI agent 快速规则、如何新增方法与方法表；其余章节随后续实现补全。规范在 `Tests/Control/spec/otcp/v1/`。

This directory holds the local control API of OpenTune Standalone: a JSON-RPC protocol over a loopback
TCP connection (OTCP v1, specified in `Tests/Control/spec/otcp/v1/PROTOCOL.md`), with which another
program on the same machine, for example an assistant, can read and edit the open project the way the
UI does. It is compiled only with the CMake option `OPENTUNE_ENABLE_CONTROL_API` (default OFF) and runs
only when enabled at run time. With the option OFF, or ON but not enabled, OpenTune behaves exactly as
without this directory.

**Review / 审核.** [`REVIEW-CHECKLIST.md`](REVIEW-CHECKLIST.md) is the checklist for reviewing a change of the control API, and the common basis on which OpenTune's maintainers and the API's contributors review it; each item says which file to read, which test to run or what to grep.
[`REVIEW-CHECKLIST.md`](REVIEW-CHECKLIST.md) 是控制接口改动的审核清单，也是 OpenTune 维护者与接口贡献者双方审核的共同依据；每一条都写明看哪个文件、跑哪个测试、grep 什么。

## Quick rules for AI agents / AI agent 快速规则

Copy these into your own `CLAUDE.md` or `AGENTS.md` if you want your assistant to keep the control API intact.
如果希望你的 AI agent 不破坏控制接口，可以原样粘进你自己的 `CLAUDE.md` 或 `AGENTS.md`。

1. If you change an upstream function that is listed in `MIRRORS.md`, you must run `ControlMirrorDriftTests` and bring the mirrored code in `Source/Control` in line as `MIRRORS.md` says before you update the hash. The test exists only in a build configured with `-DOPENTUNE_ENABLE_CONTROL_API=ON -DOPENTUNE_BUILD_TESTS=ON` (both are OFF by default), for example `cmake -S . -B build-control -G Ninja -DOPENTUNE_ENABLE_CONTROL_API=ON -DOPENTUNE_BUILD_TESTS=ON`, then build it and run `ctest --test-dir build-control -C RelWithDebInfo -R ControlMirrorDrift --no-tests=error`; in a default build `ctest -R Control` finds no test, and without `--no-tests=error` that still exits 0. / 改了 `MIRRORS.md` 里列出的上游函数，必须运行 `ControlMirrorDriftTests`，并按 `MIRRORS.md` 同步 `Source/Control` 里的镜像代码，然后才能更新哈希。这个测试只存在于用 `-DOPENTUNE_ENABLE_CONTROL_API=ON -DOPENTUNE_BUILD_TESTS=ON` configure 的构建里（两者默认都是 OFF），例如 `cmake -S . -B build-control -G Ninja -DOPENTUNE_ENABLE_CONTROL_API=ON -DOPENTUNE_BUILD_TESTS=ON`，构建后运行 `ctest --test-dir build-control -C RelWithDebInfo -R ControlMirrorDrift --no-tests=error`；默认构建里 `ctest -R Control` 找不到任何测试，不加 `--no-tests=error` 时退出码仍是 0。
2. Do not delete or move code marked `// OpenTune Control API hook`; the list is in "Hooks". / 不要删除或挪动标有 `// OpenTune Control API hook` 的代码，清单见「Hooks」。
3. With `OPENTUNE_ENABLE_CONTROL_API` OFF, or ON but not enabled at run time, OpenTune must behave as before. / 选项关闭，或开启但运行时未启用时，OpenTune 的行为必须与原来一致。
4. The control API reads and writes content only on the message thread, through `ControlMessageThread`: `post()` queues a function for the message thread and returns at once, `call()` runs it there and waits for it to return (the dispatcher uses `call()`); never from the network thread. / 控制接口只在消息线程、经 `ControlMessageThread` 读写内容：`post()` 把函数排到消息线程上就返回，`call()`在那里执行它并等它返回（dispatcher 用的是 `call()`）；绝不在网络线程。

## File map

| File | Role |
|---|---|
| `ControlApiOptions.*` | Run-time switch and options (`OPENTUNE_CONTROL_API`, `--control-api*`, `OPENTUNE_DATA_DIR`); pure functions. |
| `ControlPathPolicy.*` | Checks of absolute paths given to the API (PROTOCOL.md section 20.1). |
| `SecureRandom.*` | Token, server proof and instance id from the operating system's CSPRNG; constant-time comparison. |
| `ControlJson.*` | Strict JSON parser and writer (UTF-8, depth limit, duplicate keys, exact number literals). |
| `ControlProtocol.*` | JSON-RPC framing rules, request ids, fixed responses, the `session.hello` checks. |
| `ControlSocket.*` | Non-blocking loopback sockets, not inherited by child processes. |
| `ControlDiscovery.*` | Discovery directory and file, ready file, private file writes. |
| `ControlServer.*` | The listener: rules before authentication, sessions, limits, the stop sequence. |
| `ControlMessageThread.*` | The only way to the message thread: `post()` and `call()`, guarded by a liveness token. |
| `ControlService.*` | Facade owned by the processor: options, start and stop, listener, marshalling, editor bridge pointer. |
| `ControlUiBridge.h` | Interface to what only the editor owns; every function defaults to "not supported". |
| `ControlDataDirectory.*` | `OPENTUNE_DATA_DIR` for the preference and log hooks. |
| `ContentHandles.*` | `contentId` / `placementId` handles, revision tokens (64-bit FNV-1a) and pagination cursors; standard library only. |
| `ControlDispatcher.*` | The request handler of the listener: parameter checks, execution on the message thread (or on the connection thread for `mainThread: false` methods), timeout, stop, error mapping. |
| `Ops/OpsRegistry.*` | The method table (one registration line per group), the operation context with its thread check, the error mapping. |
| `Ops/OpsSupport.*` | What the operations share: parameter reader, handle resolution, the world revision vector and `asOf`, number and text output. |
| `ControlJobs.*` | The jobs of the instance: registry, the tick that advances running jobs on the message thread, the long poll of `job.get`, cancellation, retention. |
| `Ops/WriteEnvelope.*` | What every write shares: the busy checks, the dirty flag, revert recipes, the UI snapshot, `revisionDiff` and the write envelope builder. |
| `Ops/SessionOps.*`, `Ops/ProjectReadOps.*`, `Ops/ContentReadOps.*`, `Ops/ContentDetailsOps.*`, `Ops/AppReadOps.*`, `Ops/JobOps.*`, `Ops/ImportOps.*`, `Ops/ExportOps.*`, `Ops/UndoOps.*`, `Ops/ContentTuneOps.*`, `Ops/ContentEditOps.*`, `Ops/TimingOps.*`, `Ops/ProjectOps.*`, `Ops/UiOps.*`, `Ops/PrefsOps.*`, `Ops/AudioDeviceOps.*` | The methods, one file per group (see "Method table"). |
| `Edit/TimeGridOps.*` | The handle moves of OpenTune's time tool without the piano roll: the two passes of its limits, and the commit of a grid as the piano roll commits one (see "Time grid"). |
| `Ops/EditSupport.*` | What the content edits and the undo steps share: params forms of tokens and keys, the readiness gate, the expected-token checks, note references, `reRenderQueued`, and the description of an undo step's effect from two snapshots. |
| `Edit/ControlOriginAction.*` | The undo entry of a change made through the API (upstream undo actions wrapped with an `undoId`), and `ControlHistory`: undoIds, the API's entries, the undoIds of UI entries, changes without an undo entry. |
| `Edit/ContentEditTransaction.*` | Undo entries built from snapshots around a commit of the content commands, as the piano roll builds them (see "ContentEditTransaction"). |
| `Edit/NoteCorrection.*` | The correction segments the piano roll rebuilds after an edit of notes, and SNAP (AUTO in the openDyne scheme), computed as the piano roll computes them and committed into a ContentEditTransaction (see "Note edits and the pitch shift"). |
| `Ops/ReferenceOps.*`, `Edit/ReferenceAlignment.*` | `content.analyzeReference` and the job of `content.autoTune` in mode `reference`; the alignment of OpenTune's AUTO button with its undo action handed back instead of pushed (see "Reference alignment"). |
| `Ops/SelectionOps.*`, `../Standalone/ControlEditorBridgeSelection.cpp` | `ui.setSelection`: the effects of a click on a clip predicted, then the click and double click through the arrangement view's hook, and the effects observed (see "Selection"). |
| `Edit/PitchShiftLedger.*` | The steps of OpenTune's pitch shifts that the `revision` token leaves out (see "Note edits and the pitch shift"). |
| `mirror-map.json`, `MIRRORS.md` | The upstream functions that the API mirrors, with a hash of each (machine-readable source of truth and the table generated from it); checked by `Tests/Control/ControlMirrorDriftTests.cpp` (see "Mirrors"). |
| `ControlFileIdentity.*` | File identity (volume and file id, `st_dev` and `st_ino`), "same file" by identity, and the final rename that never replaces (PROTOCOL.md sections 20.3 and 20.4); standard library and operating system only. |
| `Ops/OpsJson.*` | Wire forms that several reads share (key, pitch shift, language tag, editing scheme, the processing object of `session.info` and `prefs.get`). |
| `ControlLogTail.*` | The tail of the log file and the redaction of its lines for `app.getLog`; standard library only. |
| `Ops/TransportOps.*`, `Ops/TrackOps.*`, `Ops/TrackSupport.*` | `transport.control`, `transport.setTempo`, `transport.setLoop`; `track.set`, `track.add`, `track.duplicate`, `track.delete`; and what the track methods share (slot checks, the state of a track, the shown-track count; reusable by the clip methods). See "Transport and tracks". |
| `Ops/ArrangementOps.*` | `arrangement.edit` (move, trim, gain, fades, split, merge, delete, reference binding) and `arrangement.copy`, through the arrangement's setters and the processor's split, merge, delete and copy functions with the arrangement view's undo actions. See "Arrangement". |
| `../Standalone/ControlEditorBridgeTracks.cpp` | The steps of the bridge for the track panel, the arrangement and the transport bar (shown tracks, mix, play state, tempo). |
| `../Standalone/ControlEditorBridge.*`, `../Standalone/ControlEditorBridgeProject.cpp`, `../Standalone/ControlEditorBridgeModals.cpp`, `../Standalone/ControlEditorBridgePrefs.cpp` | The editor's side of `ControlUiBridge`, a friend of the Standalone editor (the project flows in the second file, the dialogs and the onboarding in the third, the preferences and the audio device in the fourth); compiled into the application wrapper only. |

The channel files (options to server) use only the standard library and the operating system; the
unit tests (`Tests/Control/ControlUnitTests.cpp`) compile them on their own. The service files and every
later part use JUCE and the processor. `cmake/OpenTuneControl.cmake` lists all files in order.

## Threading rules

- Project content is read and changed only on the message thread. The control API reaches it only
  through `ControlMessageThread` (`post()`, or `call()` from a network thread).
- A network thread that waits for the message thread holds no lock or lease of the processor
  (in particular no `ProcessRenderRuntime::CompletionCallbackLease`) while it waits.
- Everything posted to the message thread captures the liveness token of the marshalling and does
  nothing once the service has stopped or is destroyed. `stop()` wakes every waiting thread.
- A function run through `ControlMessageThread::call()` must not stop the control service
  synchronously (for example an operation that closes the application or destroys the processor):
  `ControlService::stop()` joins the connection thread that waits for that function, so the join would
  only end at its bounded timeout. Such an operation posts the stop with `post()` from the function and
  returns.
- Methods run only through `ControlDispatcher`: every access of an operation to the processor or the
  editor bridge goes through `ControlOpContext`, which refuses any other thread than the message thread,
  in every build type.
- The exception to "methods run on the message thread" are the methods whose schema says
  `x-otcp.mainThread: false`: `app.getLog`, `job.get` and `job.cancel`. They run on their connection
  thread and never wait for the message thread, so they never answer `TIMEOUT`, and they get no
  `ControlOpContext`.
- `app.getLog` gets only the immutable facts snapshot (`ControlInstanceFacts`: instance id, limits,
  redaction secrets, home directory spellings) and its params. It must not read or change project
  content, the processor or the bridge, may call only OpenTune functions that are thread-safe by their own
  contract (`AppLogger::getCurrentLogFile()` copies the path under the logger's lock), and reads files only
  within a fixed bound.
- `job.get` and `job.cancel` run with the jobs registry only. A `job.get` that waits holds its response
  on the registry's waiter thread, so the connection keeps serving the session's other requests (for
  example a `job.cancel`).
- The work of a job runs only on the message thread, one short step per tick. Long work (decoding a
  file, writing an export) runs on a thread that the work owns and joins in its destructor;
  `ControlJobs::stop()` destroys every work on the message thread, so no such thread outlives the
  processor. OpenTune's export cannot be interrupted, so a stop during an export waits for the write.
  This is a known exception to the bounded joins: the destructor of the export's writer joins a thread
  that runs OpenTune's own export function, as the editor's export thread is joined. The worst case is
  the time that the render worker needs to drain the render queue of the whole process (every pending
  render of every content, `drainRenderWorker`) plus the time to write the file, so it depends on the
  number and length of the pending renders and on the speed of the disk. Closing the application during
  an export therefore waits for OpenTune's own export to finish, as it does without the control API.
- The listener runs one accepting thread and one thread per connection; every network wait is a poll of
  at most 250 ms that also checks the stop flag.
- Logging goes through `AppLogger` only and never contains the token, the server proof or request
  content. The listener's sink is gated: after `ControlService::stop()` no connection thread can reach
  `AppLogger` through it, not even one that had to be detached.
- Nothing of the control API runs on the audio thread.

## Lifecycle

**Enabling.** Build with `-DOPENTUNE_ENABLE_CONTROL_API=ON`. At run time set `OPENTUNE_CONTROL_API=1`
or pass `--control-api`; only then are `--control-api-dir=`, `--control-api-ready-file=` and
`--control-api-launch-nonce=` read. `OPENTUNE_DATA_DIR=<absolute directory>` redirects the preferences,
the logs and the default discovery directory, whether or not the API is enabled, so that tests never
touch the user's real settings.

**Start.** The processor constructor creates the `ControlService` (it only reads the options) and calls
`scheduleStart()`. When the API is enabled, that posts the start to the message thread, guarded by the
liveness token; nothing is posted otherwise. The start runs after the constructor has returned: it calls
`OpenTuneAudioProcessor::ensureRuntimeInitialized()` (the same sequence as `createEditor()` and
`prepareToPlay()`, and it works without an audio device or a window), and only if that succeeds starts
the listener. The listener writes the discovery file once it accepts connections, then the ready file if
requested. Every failure is logged and leaves the API off; nothing is thrown to the processor.

**Stop.** The processor destructor calls `ControlService::stop()` as its first statement. In order: the
stop flag is set (requests get `SHUTTING_DOWN`); the liveness token dies, which wakes every thread
waiting for the message thread and turns every queued function into a no-op; the jobs stop (every waiting
`job.get` is answered with `SHUTTING_DOWN` at once, no job work runs again, and every work is destroyed,
joining the threads it owns); the listener stops (new
requests get `SHUTTING_DOWN`, sessions answer what already arrived and close, the listener closes,
threads are joined with a bounded wait) and deletes the discovery file; the ready file is deleted if it
still holds this instance's content; the log gate closes. `stop()` is idempotent.

## Hooks

These are all the changes to files that exist upstream. Each place carries the marker
`OpenTune Control API hook: <purpose>, see Source/Control/README.md#hooks`. All code of the hooks is
inside `#if JucePlugin_Build_Standalone && defined(OPENTUNE_ENABLE_CONTROL_API)` (C++) or the CMake
option, so a build with the option OFF compiles exactly the upstream code.

| File | Hook | Purpose | If it is removed |
|---|---|---|---|
| `CMakeLists.txt` (end) | `option(OPENTUNE_ENABLE_CONTROL_API …)` and `include(cmake/OpenTuneControl.cmake)` | Build option, control sources and their tests. | The control API is never built. |
| `Source/PluginProcessor.h` | Forward declaration of `ControlService` | Lets the processor hold the service without including its header. | The header no longer compiles with the option ON. |
| `Source/PluginProcessor.h` (end of the class) | Public `ensureRuntimeInitialized()`; `getControlService()`; member `controlService_` | Runtime initialisation the API can call (`initializeRuntimeState()`, then `replayDeferredState()`, as the host entry points do); access to the service. | The service cannot initialise the runtime or be reached; the processor does not own it. |
| `Source/PluginProcessor.cpp` (includes) | `#include "Control/ControlService.h"` | Complete type for the constructor and destructor. | Does not compile with the option ON. |
| `Source/PluginProcessor.cpp` (end of the constructor) | Create the service, `scheduleStart()` | Starts the API after the constructor, guarded by the liveness token. | The API never starts. |
| `Source/PluginProcessor.cpp` (first statement of the destructor) | `controlService_->stop()` | Stops the listener and the queued work before any processor state is torn down. | Network threads and queued functions could touch a processor that is being destroyed. |
| `Source/Utils/AppPreferences.cpp` (include, `resolveSettingsDirectory`) | `OPENTUNE_DATA_DIR` replaces the per-user OpenTune folder | Preferences of tests stay in the test's directory. | Tests read and write the user's real preferences. |
| `Source/Utils/AppLogger.cpp` (include, `initialize`) | `OPENTUNE_DATA_DIR` replaces the per-user OpenTune folder | Logs of tests stay in the test's directory. | Tests write into the user's real log folder. |
| `Source/Content/StandaloneContentRepository.h` (end of the class) | Member `contentEpoch_` and public `getContentEpoch()` | The content epoch of the handles (PROTOCOL.md section 9). | Handles cannot tell the contents of a project opened later from earlier ones. |
| `Source/PluginProcessor.h` (the control block at the end of the class, after `getControlService()`; 6 lines: one marker comment, `getReferenceFeatureProducer()`, `getContentF0FailureReason()`, `recordF0FailureReason()`, members `contentF0FailureReasons_` and `contentF0FailureEpoch_`) | Read-only reference feature producer; the last F0 failure reason per content | The reference feature producer this instance would use (`resolveReferenceFeatureProducer()`), and the reason the pitch analysis of a content failed, for `content.getDetails`. The reasons belong to one content epoch: the first record after a project was opened forgets the old ones, and the getter reports nothing for an older epoch, because clip ids restart at 1. | `content.getDetails` cannot tell why an analysis failed (it reports `f0_failed`) nor whether reference alignment data is current. |
| `Source/PluginProcessor.cpp` (43 lines: one `#if` block of 25 lines with the two definitions, just before `resolveReferenceFeatureProducer()`; six calls in `requestContentRefresh`, each 3 lines with its own `#if`/`#endif`) | `recordF0FailureReason(key, reason)` where the analysis starts (clear: the Standalone clip case of the state switch), fails (the extractor's failure: `f0_empty` for its unvoiced result, else `f0_failed`; the commit of the curve; the dispatcher-failure callback; a rejected submit: `f0_failed`) and succeeds (clear, before the state becomes Ready) | Remembers the last failure reason per content on the message thread (all six places are message-thread callbacks or the caller itself). | As above. |
| `Source/Content/StandaloneContentRepository.cpp` (`clear()`) | `contentEpoch_` is incremented | `clear()` discards every content when a project is opened (`ProjectSession::commitPreparedOpen`) and clip ids restart at 1, so handles from before become `NOT_FOUND(stale_handle)` instead of naming new contents. | Old handles would silently name the contents of the newly opened project. |
| `Source/Standalone/PluginEditor.h` (end of the class) | `friend class ControlEditorBridge;` and member `controlEditorBridge_` | The bridge reads the editor's state and calls its functions while the editor keeps its members private. | The control API cannot reach the editor: results report `no_editor`, busy checks cannot see the UI. |
| `Source/Standalone/PluginEditor.cpp` (includes) | `#include "ControlEditorBridge.h"` | Complete type for the constructor and destructor. | Does not compile with the option ON. |
| `Source/Standalone/PluginEditor.cpp` (end of the constructor) | Create the bridge, which registers itself with `ControlService::setUiBridge()` | The API reaches the editor only once it is complete. | No bridge is registered. |
| `Source/Standalone/PluginEditor.cpp` (first statement of the destructor) | `controlEditorBridge_.reset()`, which unregisters it | The API never reaches an editor that is being torn down. | Requests could reach a half-destroyed editor. |
| `Source/Standalone/UI/ArrangementViewComponent.h` (end of the public section; 4 lines: `#if`, marker, declaration, `#endif`) | Public `commitControlSelection(trackId, placementId)` | The editor bridge selects a clip (`ui.setSelection`) as a plain click on it does, so that the view's own selection (the highlight and the target of its keyboard commands, private members) follows. No data member, so the class layout is the same with the option OFF. | A selection through the API would leave the view highlighting, and its Delete, split and nudge keys acting on, the clips selected before. |
| `Source/Standalone/UI/ArrangementViewComponent.cpp` (after `commitEmptyPlacementSelection()`; 17 lines) | The definition: with a clip, the steps of `mouseDown` for a click on a clip that is not selected (only that clip in the view's selection, the shift anchor, `commitPlacementSelection()`); with 0, `commitEmptyPlacementSelection()`, as a click on an empty area | Calls only the view's own private functions in the order its mouse handler calls them; the listener (the editor) is told as after a click. | As above. |
| `Source/PluginProcessor.h` (the control block at the end of the class; 5 lines: one marker comment, `tryAcquireExportLock()`, `releaseExportLock()`, `isExportLockHeld()`, member `exportLockHeld_`) | The export lock that the editor's export and `export.start` share (an atomic flag; any thread) | One export at a time, whoever starts it: `export.start` and every other write answer `BUSY(export_in_progress)` while it is held, also without an editor. | The API could export while the UI exports (both write through `OpenTuneAudioProcessor::export*Audio` and its `lastExportError_`), and writes would not see an export of the other side. |
| `Source/Standalone/PluginEditor.cpp` (`exportAudioRequested`: 11 lines before `exportInProgress_` is set, 4 lines in the export thread before the result is posted) | The editor takes the lock when it starts its export thread, with its own "An export task is already in progress" message when the lock is taken, and releases it once the file is written | The UI and the API share the lock; the UI shows what it always shows when an export runs. | As above. |
| `Source/Utils/UndoManager.h` (public section; 8 lines: `#if`, marker, five inline functions, `#endif`) | `peekUndo()`, `peekRedo()`, `size()`, `cursor()` and `clearRedo()` | Reads the tops and the counts of OpenTune's history (`edit.getHistory`, the entry checks of `edit.undo` and `edit.redo`); `clearRedo()` discards the redo history after a change without an undo entry (PROTOCOL.md section 15.3 rule 9), as `addAction()` discards it. No data member, so the class layout is the same with the option OFF. | The API cannot tell which entry is on top, so it cannot refuse a step the client did not expect; a change without an undo entry leaves older redo steps that would write over it. |
| `Source/Standalone/PluginEditor.cpp` (`performUndoRedoAction`; 8 lines) | The steps after an undo or redo moved into `afterUndoRedo()` (a pure refactor: with the option OFF the function reads as upstream) | The editor bridge runs the same steps after an undo or redo applied through the API (`ControlUiBridge::onUndoRedoApplied()`): mark the project as changed, redraw the arrangement, refresh the reference context. | After an API undo the editor would not redraw or refresh until the next user action. |
| `Source/Standalone/PluginEditor.h` (the control block at the end of the class; 2 lines: marker and declaration) | Private `afterUndoRedo()`, reached by the friend `ControlEditorBridge` | As above. | As above. |
| `Source/PluginProcessor.h` (the control block at the end of the class; 8 lines: marker comment, the comment and getter `isReferenceAnalysisWorkerStalled()`, the member `referenceAnalysisWorkerStalled_` and its comment) | Read-only stall state of OpenTune's reference analysis worker (message thread) | The reference jobs end at once with `NOT_READY(reference_analysis_stalled)` when a content still lacks alignment data and the worker will take no further synchronous analysis; see "Reference alignment". | A stalled job would wait its 120 s limit and report `NOT_READY(reference_analysis_timeout)`, hiding that only a restart helps. |
| `Source/PluginProcessor.cpp` (the completion lambda of `preheatReferenceAlignmentFeatures()`; 6 lines inside the control option) | Set `referenceAnalysisWorkerStalled_` when a synchronous reference analysis completes | `ReferenceAnalysisService::workerLoop()` leaves the finished job engaged in `activeJob` (a moved-from optional), so no second synchronous analysis runs; the completion is the moment that becomes true. An asynchronous GAME completion resets `activeJob` and does not set the flag. | The getter above would always say false. |

## Request handling

`ControlDispatcher` is the listener's request handler (`ControlServerConfig::handler`) and the only
entry point of every method on the C++ side. The listener has already applied PROTOCOL.md section 3.3
rule 5 cases 1 to 11 (framing, ids, in-flight limit, unknown method, unreported capability, repeated
hello). For each request the dispatcher then:

1. answers `SHUTTING_DOWN` once `serverStopping()` began. A request can pass the listener's own stop
   check just before its flag is set and reach the handler afterwards; it must not start a wait that
   nothing will end.
2. looks the method up in the method table. A defined method of a reported capability that this build
   does not implement yet gets `UNSUPPORTED(capability_missing)` with `executed` false.
3. checks `params` on the connection thread against the method's params schema: shape and ranges only,
   never OpenTune state (case 12, `INVALID_ARGUMENT(invalid_params)`). Handles get their form check
   here; whether they name something is decided on the message thread.
4. runs the method on the message thread through `ControlMessageThread::call()` with
   `limits.dispatchTimeoutMs` (10 s). A request that has not started by then is abandoned under the
   mutex that its start takes and is answered with `TIMEOUT(dispatch_timeout)`, `executed` false; it
   never runs later (section 13.1 rule 2). A request that `stop()` overtakes before it started gets
   `SHUTTING_DOWN`. The waiting connection thread holds no lock or lease of the processor. A read with
   `mainThread` false in its schema (`ControlMethod::runOffMainThread`, `app.getLog`) instead runs right
   here on the connection thread with the facts snapshot (section 13.3 rule 2): no dispatch timeout, no
   `TIMEOUT`. The redaction secrets are set right after the listener started; such a method waits for
   them (bounded by the dispatch timeout) so that it never answers without them.
5. maps the method's `Result<JsonValue>` to the response. Operations return OpenTune's `Error`
   (`Utils/Error.h`); `controlOpError()` puts the protocol kind and reason into `Error::context`, and
   `controlMapError()`, called by the dispatcher, is the only place where errors become protocol errors.
   Other OpenTune errors are mapped by their `ErrorCode` with the code's fixed text as `detail`, never the
   error's own message, which can contain paths or names from the project.

A request occupies its connection thread while it waits, so the requests of one session start on the
message thread in the order they arrived (section 3.3 rule 6), and sessions do not wait for each other.
Reads finish within one message-thread step.

The jobs methods, whose schema says `mainThread: false` too (`job.get`, `job.cancel`), skip step 4:
they run on the connection thread with the jobs registry (`ControlMethod::runWithoutMessageThread`), never return
`TIMEOUT` and never `BUSY` because of the UI; `job.get` answers later from the registry's waiter thread.

`executed` of an error (section 17.4): an operation returns `controlOpError()` only from its checks,
before its first change, and the response says `executed: false`. A write that fails after it began to
change state and did not take the change back returns `controlOpErrorAfterChange()`: `executed: true`, so
that the client reads the state again. Any other failure of a write (an exception, an OpenTune error
that is not one of these) is answered with `executed: true` as well.

Reads share these conventions (section 16):

- every value comes from one message-thread step; `asOf` carries the `arrangementRevision` and the
  tokens (`revision`, `gridRevision`, `keyRevision`) of the contents the result describes;
- `derived` lists the members the API computed rather than read (for example `tracks[].label`);
- a value the API cannot know is `null`, and the enclosing object's `nullReasons` names why (for example
  `no_editor` when no editor bridge is registered); members are never omitted;
- reads are never gated on the pitch analysis: before it is ready the arrays are empty and `f0State`
  says why (section 11);
- cursors are `<letter>1.<offset>.<paramsHash>.<tokensHash>`: bound to the selection params of the
  method (other params give `INVALID_ARGUMENT(invalid_params)`) and to the tokens of the read that issued
  them (changed tokens give `REVISION_CONFLICT(cursor_stale)`). The cursors of `content.getNotes` and
  `content.getPitchCurve` are bound to the content's pitch shift as well, because a pitch shift moves every
  target and every `correctedMidi` without changing `revision` ("Note edits and the pitch shift"): after a
  shift (or its undo) the old cursor is stale and the client reads again.

Handles are `c:<instanceIdShort>:<contentEpoch>:<objectId>` and
`p:<instanceIdShort>:<contentEpoch>:<placementId>`. A handle of another instance or another content epoch
is `NOT_FOUND(stale_handle)`; a current one that names nothing live (also a retired content or placement)
is `NOT_FOUND(unknown_handle)`.

`controlCaptureWorldVersions()` (`Ops/OpsSupport.*`) captures the world revision vector of section 14.4
(arrangement, track states, and per content notes, pitch, content, grid, key, pitch shift and reference)
from one consistent state on the message thread. Reads build `asOf` from the same components; the write
envelopes of the editing methods compare two captures for `revisionDiff`.

## Jobs

`ControlJobs` (section 12) holds the jobs of the instance; every session can read and cancel every job.

- A method that starts a job checks everything it can before it creates the job, then calls
  `ControlJobs::start(kind, cancellable, work)` and answers at once with the write envelope in the state
  "handed to a job" (`job: {jobId, kind, state}`). `BUSY(job_limit)` when 64 jobs are retained and all are
  active.
- The work is a function called once per tick (20 ms) on the message thread while the job is not
  terminal. It reads `ControlJobStep::cancelRequested()`, reports progress, and ends the job with exactly
  one of `succeed(result)`, `fail(error, result)` or `cancel(result)`. The result of a job that changes
  project state is a write envelope (built with `ControlWriteEnvelope`, below). The work makes a
  `ControlOpContext` for each step from the `ControlOpEnvironment` the starting operation kept
  (`ControlOpContext::environment()`), because the bridge can come and go between steps.
- A step must return quickly and should not run a nested message loop (a modal dialog,
  `runDispatchLoopUntil`). If one does, the registry stays consistent: the timer that fires inside the
  loop calls no work, and `ControlJobs::stop()` called inside the loop stops the timer without destroying
  it under its own callback; no work is called after the stop. The registry itself must not be destroyed
  inside such a loop (for example the application quitting while a step shows a modal dialog): the
  interrupted tick would return into a destroyed registry. Debug builds assert it in `~ControlJobs()`.
- A job created cancellable stays so until it ends, until its work calls `endCancellability()` (the
  point of no return of its kind, section 12.3), or until `job.cancel` requested cancellation. The work
  stops at its next step.
- Retention (section 12.4): terminal jobs stay at least 30 minutes after they finished; beyond 64 jobs
  the terminal job that finished first is evicted first; active jobs are never evicted. Retention is
  measured with a monotonic clock, so a change of the system time never evicts a job early; the
  `*AtMs` timestamps of the job object are wall-clock time.
- `job.get` with `waitMs` (at most 30 s) holds its response on the registry's waiter thread until the
  job is terminal or the time passed; `ControlJobs::stop()` answers every waiting request with
  `SHUTTING_DOWN` at once. The waiting holds no lock or lease of the processor.
- Repeated requests: `ControlJobs::findByKey()` finds a retained job by its idempotency key and the
  digest of its params, for methods whose repeated calls must return the same job (section 12.5).

## Write results

Every write builds its result with `ControlWriteEnvelope` (`Ops/WriteEnvelope.*`, section 14), on the
message thread:

1. Check, in this order (section 13.1 rule 4): handles; busy state (`controlCheckBusy`, below); the
   readiness gate; expected tokens; the method's own validation. Each check returns `controlOpError`.
2. Create the envelope immediately before the change. It captures the world revision vector and the
   editor's dirty flag.
3. Change state, and record each change (`addChange`, `addCreated`, `addRemoved`, `addIdMapEntry`), the
   contents and placements touched (`touchContent`, `touchPlacement`: their tokens are read back after
   the write), side effects (`addSideEffect`, each with its `revert`), warnings and the undo descriptor.
   After a change that is saved with the project call `controlMarkDirty` (section 15.5), also where the
   UI does not mark the project.
4. End with `committed()`, `predicted()` (dryRun) or `handedToJob(jobRef)`. The envelope captures the
   vector again and computes `revisionDiff`, reads `dirty` and the UI snapshot after the call, and admits
   exactly the four states of section 14.2. A committed write without recorded changes or side effects
   and with an empty `revisionDiff` is `noOp`; its undo descriptor is the one the method set (an
   `edit.undo` step that changed nothing, section 15.3 rule 5), otherwise reason `no_op`. A job's envelope
   may report only the contents it touched (`limitDiffToTouchedContents`), because the user can change
   other contents while the job runs. A method that hands its work to a job changes nothing before it
   does: the envelope of that state lists no changes or side effects, so nothing could explain a
   `revisionDiff` (debug builds assert that it is empty).

The UI snapshot (`ui`) comes from the bridge: `{workspace, pianoRollContentId, activeTrackId,
selectedPlacementIds, visibleTrackCount}`, or null with `nullReasons.ui` `no_editor` (no editor) or
`unavailable` (the bridge cannot tell).

## Undo and revert

- An undoable change is one entry of OpenTune's undo history: `setUndoable(undoId, description,
  innerActions)`. The editing methods create these entries with the same undo action classes as the UI.
- A change without an undo entry gets `setNotUndoable(reason, revert)`: a reason of the `undo` scope of
  `registry/reasons.json` (`ui_parity` when the UI creates no entry either) and a revert recipe
  (`controlRevertRecipe(method, params, requiresConsent)`) whenever a request of this instance can restore
  the state; a recipe whose method needs a capability the instance does not report cannot, so revert is
  null then (`controlReportsCapability`). Recipes never carry consent members; `requiresConsent` marks
  those the client may send only after the end user agreed (section 15.2 rule 4).
- A change that is neither undoable nor revertible gets the warning `IRREVERSIBLE` from the envelope,
  except view state (reason `not_persisted_state`, section 15.2 rule 6) and a call that changed nothing
  itself (reason `no_op`, or a `noOp` result).

## Undo history

OpenTune has one undo history, the processor's `UndoManager`, which the UI's Ctrl+Z and the API share. The
API reads it through the hook `peekUndo` / `peekRedo` / `size` / `cursor` and applies steps with
`UndoManager::undo()` / `redo()`, exactly as the UI does (`Ops/UndoOps.cpp`).

- **Entries made through the API** are `ControlOriginAction`s (`Edit/ControlOriginAction.*`): the upstream
  undo actions the UI would push for the same change (every upstream `UndoAction` class has a public
  constructor), wrapped with the entry's `undoId` (`u:<instanceIdShort>:<seq>`) and, per inner action, the
  content and the aspect it puts back (notes with the corrected pitch, key, pitch shift, time grid). The
  user can undo them in the UI like their own; `edit.undo` recognises them by their wrapper.
- **Undo identification.** `edit.undo` and `edit.redo` apply the top entry only when it is the entry the
  client names (`expectedUndoId`), else `UNDO_CONFLICT(top_mismatch)` and nothing changes, so a client never
  undoes the user's edit by accident; `force` (only on the end user's explicit request) applies whatever is
  on top. An empty history is `UNDO_CONFLICT(history_empty)`; a clip split, merge or delete on top is
  `UNSUPPORTED(undo_unsafe_build)`, also with `force` (OpenTune frees what their undo needs).
- **Entries made in the UI** have no `undoId` until a call with `force` applies one; `ControlHistory` then
  gives it one and recognises it by its object, class, description and position in the history. OpenTune's
  history has no identity of its own for entries: if the user discards such an entry in the UI and makes
  the same kind of edit at the same position, the new entry can take the old one's memory and inherit its
  undoId. Opening a project clears OpenTune's history and these ids. A full history (500 entries, the
  `UndoManager`'s capacity) drops its oldest entry on each new one and moves every entry down by one
  position, which the read hook cannot tell from an undo followed by a new entry: whenever the history is
  found full and changed since the API last looked at it, `ControlHistory` forgets the undoIds of UI
  entries, so a call that names one gets `UNDO_CONFLICT(top_mismatch)` rather than a step on another entry.
  Steps the API applies itself move no entry and keep them.
- **After a step** the project is marked as changed (also when the step changed nothing, as in the UI) and
  the editor runs its own steps after an undo (`afterUndoRedo()` through `ControlUiBridge::
  onUndoRedoApplied()`). The result describes the effect from snapshots before and after the step
  (`controlDescribeEffect`: contents, keys, pitch shifts, clips, tracks), so it also covers entries the
  API cannot inspect; an empty `revisionDiff` gives `noOp` and `UNDO_NO_EFFECT`. The step's own revert
  recipe is the opposite step with the entry's `undoId`, never with `force`.
- **Changes without an undo entry** (`content.setKey`, `content.autoTune` mode `notesOnly`,
  `content.editTimeGrid` op `seed`; section 15.3 rule 9) are never taken back:
  `ControlHistory::onChangeWithoutEntry()` masks that aspect of that content in every entry the API recorded
  before (their undo then skips it) and clears the redo history with the hook's `clearRedo()`. UI entries are
  applied as OpenTune applies them. A pitch shift recorded through the API is the exception: OpenTune's
  `PitchShiftEditAction` puts back the notes it saved together with the settings, so once `notesOnly`
  replaced the notes of its content, the entry puts back the settings only,
  through `ContentEditCommands::commitPitchShiftEdit()` (which scales the notes the content has now, as the
  pitch-shift dialog does; the action that call returns is discarded). That call applies nothing when the
  content has no pitch curve or already has a shift of the same total cents: the step is used up, changes
  nothing and gives `noOp` and `UNDO_NO_EFFECT` (`ControlOriginAction::lastStepTookEffect()`), and the log
  records it.
- **Track deletion barrier** (section 15.3 rule 6; `ControlHistory::onTrackDeleted()`, called by `track.delete`).
  OpenTune keys clip entries by track position, so an entry recorded before a deletion may address a track that
  moved. Only the shown tracks after the deleted one move (`removeTrackAndShift()` leaves the hidden slots, their
  clips and their mix where they are). An entry made through the API knows two lists of tracks, set by the methods
  that record clip changes: `ControlOriginAction::Inner::tracks`, the slots the wrapped OpenTune actions are keyed by
  (they are fixed inside the actions, so undo and redo write to them whatever was deleted since; never changed), and
  `Inner::followed`, where the clips are now, as an approximation (renumbered when a deletion moves their shown track down; after an undo or redo that took effect the slots of `tracks` are merged into it). The entry
  becomes `possiblyStale` when the deleted track or a later shown track is in either list (the union: an entry is
  reported too often rather than too rarely), and an entry that addresses no track (a note edit addresses its
  content), only earlier tracks or only hidden tracks does not.
  `edit.getHistory` reports `possiblyStale`; `edit.undo` and `edit.redo` refuse such an entry with
  `UNDO_CONFLICT(stale_entry)` unless `force` is true, and a call with `force` applies it and confirms it
  (`ControlHistory::confirmStale()`: no warning, `possiblyStale` false) until another deletion makes it stale again. An
  entry of the UI cannot be inspected, so every one recorded before a deletion is possibly stale; without `force`
  the step is applied with the warning `UNDO_ENTRY_POSSIBLY_STALE`. `track.delete` reports the entries it made
  possibly stale on each side (`possiblyStaleEntries`, warning `UNDO_HISTORY_POSSIBLY_STALE`).
  The hook gives no access to an entry by position (only the two tops, `size()` and `cursor()`), so an entry of the
  UI is told by its position: every position below the size the history had at the deletion holds an entry
  recorded before it, and a position that a later entry took over after an undo keeps counting as possibly stale
  until the history is observed shorter (`ControlHistory::prune()`). That can report an entry too many, never one too
  few. An entry of the API knows whether it sits on the redo side (it sees its own `undo()` and `redo()`), which
  gives the two counts. A deletion made in the OpenTune UI itself is not observed (there is no hook for it), so
  entries recorded before it are not marked.
  When a deletion removed the content an entry of the API addresses (the deleted track held every clip that showed
  it), the entry is applied as the UI applies it: the step is used up and changes nothing, so the result is a
  `noOp` with `UNDO_NO_EFFECT` (the content is no longer live, `ControlHistory::isContentRemoved()`).

## ContentEditTransaction

A content edit through the API records its undo entry the way the piano roll does, without the piano roll
(`PianoRollComponent` stays untouched): `Edit/ContentEditTransaction.*` captures the notes and correction
segments before a commit of OpenTune's content commands, and after it keeps, for the affected frame range,
the notes and segments before and after, cut to the range, in a `PianoRollEditAction` with the UI's
description. Several commits of one call (the ranges of `content.autoTune`) are one `ControlOriginAction`,
so one call is one undo step. The actions use the processor's own `ContentEditCommands`, the instance the
piano roll uses.

The upstream functions it and the AUTO method follow. A change of these functions upstream needs the same
change here; they are registered in `MIRRORS.md` (see "Mirrors") and `ControlMirrorDriftTests` fails when one
changes:

| Upstream function | Followed in |
|---|---|
| `PianoRollComponent::captureBeforeUndoSnapshot()` | `ContentEditTransaction::captureBefore()` |
| `PianoRollComponent::recordUndoAction()` | `ContentEditTransaction::recordRange()`, `notesInRange()`, `segmentsInRange()` |
| `PianoRollComponent::applyAutoTuneToSelection()`, the openTune scheme | `content.autoTune` mode `regenerate` (`Ops/ContentTuneOps.cpp`): range resolution, capture, commit, undo range |
| `OpenTuneAudioProcessor::autoTuneContentRangeByContentKey()` and `commitAutoTuneGeneratedNotesByContentKey()` | the `dryRun` prediction of `regenerate` and the removed / dropped notes of its result |
| `OpenTuneAudioProcessor::generateNotesOnlyByContentKey()` | the `dryRun` prediction of `notesOnly` |
| `OpenTuneAudioProcessorEditor::scaleChanged()` | `content.setKey`: the manual key, the no-op, the dirty flag |

## Note edits and the pitch shift

`content.editNotes` (`Ops/ContentEditOps.cpp`) edits existing notes the way the piano roll's gestures do, without
the piano roll:

- The selection of every op is resolved against the notes at `expectedRevision` (an index beyond them is
  `NOT_FOUND(unknown_handle)`); editing never adds or removes notes or moves them in time, so later ops address the
  same notes. `setTargetPitch` sets the target with no cent offset (the base pitch moves, `pitchOffset` becomes 0);
  `shiftCents` adds to `pitchOffset`, as the pitch move of the piano roll does; `snapToScale` sets the target to the
  nearest pitch of the key's scale, an exact tie going up (within the 1e-4 semitones the reads resolve), with no
  cent offset (`snapToScale` on a content without a key is `INVALID_ARGUMENT(content_key_unset)`, as is a `clipKey` on
  such a content); `setParams` sets the given note parameters. These are explicit ops: the snapping modes of the UI's
  pitch drag (the active scale, the pitch grid, the whole-note preference) do not apply, so the editing scheme
  does not change what an op does.
- Targets convert as OpenTune converts note pitches: the base pitch of a target is `PitchUtils::midiToFreq()`,
  and a target read back is `PitchUtils::freqToMidi()` of `Note::getAdjustedPitch()`. `midiToFreq()` gives 0 Hz
  for MIDI 0, so `setTargetPitch` with `targetMidi` 0 leaves the note without a base pitch: it reads as MIDI 0,
  `shiftCents` then changes only its `offsetCents` (the adjusted pitch of a note without a base pitch stays 0, as
  in the piano roll's pitch drag), and a later `setTargetPitch` gives it a base pitch again.
- Each op that changes notes is one gesture of the piano roll: the frame range of the notes it changed
  (`controlNotesFrameRange()`, as `noteDragEditRange()`), the correction rebuilt over all notes in that range with
  the content's pitch-shift ratio (`controlNoteBasedCorrection()`), the commit of the affected range through
  `ContentEditCommands::commitNotesAndSegments()` and a `PianoRollEditAction` with the UI's description
  (`controlCommitCorrection()`). One call is one `ControlOriginAction`; its description is that of the first op
  that committed. An op whose frame range is empty commits nothing, as in the piano roll.
- The fallback parameters of `PitchCurve::applyCorrectionToRange()` are `NoteGeneratorParams{}`, never the UI's
  knob positions; each note uses its own retune speed, vibrato and drift, so they end up only in the segments'
  parameter snapshot.
- `dryRun` runs the same ops on a copy of the notes and lists the same `changes` and `sideEffects` as the commit;
  only the revision the notes are referenced at differs (section 14.3).
- The `changes` of a commit come from the notes read back after it (`controlReadCommittedNotes()`), never from the
  prediction, and before and after are each counted in `content.getNotes` order (`controlNoteIndexOrder()`), so that
  every `after` is what a read that follows returns. The range commit stores the notes through
  `normalizeStoredNotes()`, which sorts them and drops notes without duration; a project can bring them otherwise,
  as opening it applies them as the file holds them (`StandaloneClipContent::applyNotes()`). When the content then
  holds another number of notes, the changes cannot be described note by note: the call fails after the change
  (`INTERNAL`, `executed` true) and its undo entry stays. The SNAP of `content.autoTune` reports its changes the
  same way.
- The commit also trims the end of a note that overlaps its successor (`normalizeStoredNotes()`). The note count does
  not change and there is no error, so the write lists the trimmed note in `changes` with `startContentSec` and
  `endContentSec` (unit `sec`, as `content.getNotes` reports them). A `dryRun` does not predict the trimming, and it
  predicts a note without duration as stored although the commit drops it and fails with `INTERNAL`.
  The same limit applies to SNAP over several ranges: when overlapping notes lie at the boundary of a range, the
  `dryRun` can select one more note than the commit does, because the commit has already trimmed the notes (and
  stored them sorted) before it resolves the next range, which the prediction does not do.
- `content.autoTune` counts note indexes in `content.getNotes` order, whatever order the notes are stored in:
  `removed[]`, `created[]` and the `index` of `DROPPED_BOUNDARY_NOTES` use the index of the note in the list before
  and after the call respectively. Each pass of `snapNotes` with `ranges` picks its target notes by time on the notes
  as they are at that pass, because the first commit stores them sorted.

`content.autoTune` mode `snapNotes` (`Ops/ContentTuneOps.cpp`) is SNAP, the AUTO button in the openDyne scheme,
ported in `controlPlanAutoSnap()`: each target note's `pitchOffset` becomes the scale's quantization of its base
pitch minus the base pitch, then the correction of the targets is rebuilt; a note without a base pitch is MIDI 0
there (`PitchUtils::freqToMidi()` of 0 Hz), so its offset becomes the quantization of MIDI 0, as the button sets
it. Without ranges every note is a target
(the button without a note selection: the new segments cover the whole affected range); each range is one pass over
the notes that overlap it (the button with those notes selected: the new segments are cut to their frames, every
other frame keeps its segments). Every pass that changes something is one commit; the call is one undo step.

`content.setPitchShift` (`Ops/ContentEditOps.cpp`) calls `ContentEditCommands::commitPitchShiftEdit()`, as the
pitch-shift dialog does, and pushes the `PitchShiftEditAction` in a `ControlOriginAction`; the result describes the
effect from two captures, as for an undo step, with `KEY_NOT_TRANSPOSED`.

**`revision` and pitch shifts.** A pitch shift must not change `revision` (PROTOCOL.md section 10 rule 2), but
OpenTune's `applyPitchShiftState()` scales the stored notes and segments and advances the notes and pitch counters
the token is made of. `ControlPitchShiftLedger` (`Edit/PitchShiftLedger.*`, owned by `ControlHistory`) observes each
content whenever the API computes its tokens (`controlContentVersions()`), counts a pitch-shift step between two
observations (the settings changed and both counters advanced; `applyPitchShiftState()` is the only change of a
Standalone content that changes the settings) and leaves those steps out. The API's own steps (`setPitchShift`,
`edit.undo`, `edit.redo`) are always between two observations, since the write envelope observes every content
before and after a write; a step of the UI (the dialog, Ctrl+Z) is counted by the next read. Two such steps between
two reads count once, so `revision` changes once without a change of the notes; the ledger never hides a change of
the notes. It only reads; OpenTune's counters stay as they are. A counter lower than at the last observation means
that the content object was built anew under the same `contentId`; the ledger then starts that content over. Because
OpenTune scales the stored notes and segments and renders the original F0 with the shift's gain, `content.getNotes`
reports the targets and `content.getPitchCurve` the `correctedMidi` moved by the shift, at the same `revision`; the
cursors of both are therefore bound to the pitch shift as well, so a page is never continued across a shift.

The upstream functions these follow (lines of the locked upstream base). A change of these functions upstream
needs the same change here; they are registered in `MIRRORS.md` (see "Mirrors") and `ControlMirrorDriftTests`
fails when one changes:

| Upstream function | Followed in |
|---|---|
| `buildNoteBasedCorrectionState()` and `commitNoteBasedCorrection()` (`Source/Standalone/UI/PianoRoll/PianoRollToolHandler.cpp:189-240`) | `controlNoteBasedCorrection()` (`Edit/NoteCorrection.cpp`) |
| `PianoRollToolHandler::noteDragEditRange()`, `dragNotePitch()`, `endNotePitchDrag()` (`PianoRollToolHandler.cpp:1912-2217`) | `controlNotesFrameRange()`; ops `setTargetPitch` and `shiftCents` (`Ops/ContentEditOps.cpp`), description |
| `PianoRollToolHandler::handlePitchToolDoubleClick()` (`PianoRollToolHandler.cpp:2269-2359`) | op `snapToScale` (description), the drift and modulation descriptions of `setParams` |
| `PianoRollComponent::editParameter()`, the selected-notes target (`Source/Standalone/UI/PianoRollComponent.cpp:2645-2903`) | op `setParams` (`Edit note parameter`) |
| `PianoRollComponent::commitEditedContentNotesAndSegments()` (`PianoRollComponent.cpp:1007-1116`) | `controlCommitCorrection()` |
| `PianoRollComponent::applyAutoSnapToAllNotes()` and `isFullyCorrectedInRange()` (`PianoRollComponent.cpp:5344-5524`, `:49-61`) | `controlPlanAutoSnap()`; `content.autoTune` mode `snapNotes` |
| `OpenTuneAudioProcessorEditor::pitchShiftRequested()` (`Source/Standalone/PluginEditor.cpp:3532-3581`) | `content.setPitchShift`: the no-op, the undo entry, the dirty flag |
| `OpenTuneAudioProcessor::commitPitchShiftEdit()` and `StandaloneClipContent::applyPitchShiftState()` (`Source/PluginProcessor.cpp:5328-5368`, `Source/Content/StandaloneClipContent.cpp:127-139`) | `ControlPitchShiftLedger`: the counters a pitch-shift step advances |

Known OpenTune behaviours, reported as they are:

- SNAP finds its targets "fully corrected" only when every one of their frames has a correction segment, and
  unvoiced frames never get one (`PitchCurve::applyCorrectionToRange()` inserts voiced pieces only). A target note
  with unvoiced frames is therefore never "no change": every SNAP over it commits again and pushes an undo entry,
  also when no note moves. The result then lists no changes but is not a no-op (`revisionDiff` and
  `reRenderQueued`).
- A pitch shift whose total cents equal the current ones (for example −1 semitone +50 cents and 0 semitones −50
  cents) is refused by `commitPitchShiftEdit()`; `content.setPitchShift` reports a no-op, as the dialog commits
  nothing.
- The piano roll passes the Chinese undo texts of its AUTO entry and of the button's SNAP through `TRANS()`, whose
  `juce::String(const char*)` reads the UTF-8 bytes as Latin-1, so OpenTune's own entries carry mojibake. The API
  builds the same texts from UTF-8 (`content.autoTune` regenerate and snapNotes); `edit.getHistory` lists entries
  made in the UI with OpenTune's text as it is.

## Readiness gate

A content write (capability `edit.v1` or `timing.v1`) checks, after the handle and the busy state and
before the expected tokens, that the content's pitch analysis is ready with voiced frames
(`controlCheckContentReady`, PROTOCOL.md section 11): `NOT_READY(f0_not_ready)` (retryable) while it was
not requested or runs, `NOT_READY(f0_empty)` when it found no voiced frame and `NOT_READY(f0_failed)` when it
failed otherwise (both not retryable; the processor's failure-reason hook tells the two apart). OpenTune
generates the notes of an analysis in the message-thread step that marks it ready, so `notes_generating`
never applies in this build.

## Busy checks

`controlCheckBusy(context)` refuses a write with `BUSY` while the user is in the middle of something
(section 13.2), in this order: a mouse or pen gesture (`pointer_down`), a modal dialog (`modal_open`;
not for `ui.dismiss`), an import of the UI (`import_in_progress`), an export (`export_in_progress`), a
project save or open (`project_operation`). The bridge reports these from the editor's own flags. An
export is also busy while the processor's export lock is held (`isExportLockHeld()`: an export of the
editor or of `export.start`), with or without an editor; without an editor nothing else is busy. Reads,
`session.*` and `job.*` never call it. A job that commits in several steps (`import.start`) checks again
before each commit and waits while the UI is busy, also while an export holds the lock.

## Editor bridge

`ControlUiBridge` is the narrow interface to what only the Standalone editor owns. The editor
implements it in `Source/Standalone/ControlEditorBridge.*`, a friend adapter that reads the editor's state
and calls the editor's own functions without adding behaviour. Its general part provides the project file
and dirty flag (`ProjectSession`), the busy state, structure-change notifications, the editor's steps after
an undo or redo (`afterUndoRedo()`), the refresh after a time-grid edit (`onTimeGridChanged()`: the piano roll's
`onTimeGridRevisionChanged()`, as its own commit of a grid does, and a redraw of the arrangement), the view (workspace,
piano roll clip, selection, visible track count), the focus of an imported clip
(`applyPlacementSelectionContext`), revealing tracks, the note generation parameters of the piano roll,
the project session and its worker pool, and the audio device manager. The project flows are in
`ControlEditorBridgeProject.cpp` (see "Project files"), the dialogs and the onboarding in
`ControlEditorBridgeModals.cpp` (see "Dialogs and onboarding"), the preferences and the audio device in
`ControlEditorBridgePrefs.cpp` (see "Preferences and audio device"). Tracks follow in files of their own.
The headless tests use `Tests/Control/TestUiBridge.h`, which owns a real `ProjectSession` and a worker pool of one
thread when a test asks for them.

## Import

`import.start` (`Ops/ImportOps.cpp`) follows the editor's import (`importAudioRequested`,
`startPendingImport`, `processNextImportInQueue` in `Source/Standalone/PluginEditor.cpp`) and calls the
same processor functions:

- before the job: the idempotency key, the track handle, the busy state, every path (section 20.1, on the
  raw text before any file access) and its extension, the track capacity of the layout;
- per file, on a thread of the job: the format reader (`AudioFormatRegistry::registerImportFormats`) and
  `OpenTuneAudioProcessor::prepareImport()`; a file that fails gets its item error and the others go on;
- per file, on the message thread: `commitPreparedImportAsPlacement()` at the start the layout gives (the
  end of the last clip on the track, as `computeTrackAppendStartSeconds`, without `startTimelineSec`);
  the project is marked as changed and hidden tracks that now hold a clip are revealed. The commit waits
  while the UI is busy; a cancellation does not wait: it stops before the next commit, and while the UI
  is busy it focuses no clip;
- after the last commit: the last clip is focused (`focus`), and `requestContentRefresh()` asks for every
  analysis, with note generation for `generateNotes` (OpenTune's default parameters) or, in the openDyne
  scheme, for the focused clip (with the editor's parameters); the job ends when every analysis has
  finished.

Where the method's specification differs from the editor's import, the job follows the specification
(`methods/import.start.schema.json`):

- In the openDyne scheme the editor generates notes for every clip it imports; the job generates them
  only for the focused clip (the specification: focus "generates notes for it").
- The editor's import into separate tracks places every file at 0 s on its track; the job appends each
  file after the last clip on its track (or places it at `startTimelineSec`), as the specification
  requires for every layout.

The result has no undo entry (reason `ui_parity`, as the UI). Its revert recipe would delete the clips
with `arrangement.edit`; while the instance does not report `arrangement.v1`, no request can delete them,
so `revert` is null and the result carries `IRREVERSIBLE`. An import that committed no clip is a no-op
(reason `no_op`).

Known OpenTune behaviours, reported as they are:

- After a project was opened, OpenTune gives a new clip an id that a clip of the project may already use, and the commit
  fails; each failed attempt uses up that id, so the import fails once per id in use. The job repeats the commit, at
  most once per clip whose id OpenTune can still hand out, and logs it; the result carries the warning
  `IMPORT_COMMIT_REPEATED` (subject: the placement, `data.repeatCount`: the number of repeated commits). The UI's import
  fails in this situation. The commit consumes the prepared audio, so an attempt that may be repeated commits a copy;
  the job copies only when a project was opened (the content epoch is not 0) and a clip has an id above the highest one
  the instance's imports received since, and it never repeats a failure that the clip id cannot have caused. Otherwise
  it commits once without a copy, as the UI.
- `commitPreparedImportAsPlacement()` selects every clip it commits and makes its track the active
  track, as the editor's import does. The job puts back the selection it found after each commit, so
  that `focus` alone decides the selection: with `focus: false` the selection does not change, and
  `focus: true` selects the last clip after the commits. Without that, the editor's heartbeat would
  load the selected clip into the piano roll, which in the openDyne scheme generates the notes of a
  content it shows: a request with `focus: false` would generate notes it does not report (section 21
  rule 2). The result's `ui` snapshot shows the selection after the call. The job puts the selection back
  also when a commit fails. With `focus: true` and `separateTracks` (several target tracks), only the track
  of the last clip ends up with its new clip selected; the other target tracks keep the clip that was
  selected before the import. The editor's own import differs: it leaves each target track on its new
  clip. This is deliberate (the selection is decided by `focus` alone), not a regression.
- The editor does not mark the project as changed after its own import; the job does (section 15.5).

## Export

`export.start` (`Ops/ExportOps.cpp`, PROTOCOL.md section 19) writes a WAV file of a clip, a track or the
master mix with the processor functions of the editor's export (`exportAudioRequested` in
`Source/Standalone/PluginEditor.cpp`): `exportPlacementAudio`, `exportTrackAudio` and
`exportMasterMixAudio`, which wait for the render worker and write 44.1 kHz 32-bit float WAV, mono for a
clip or track and stereo for the master mix.

- Before the job, in this order: an export job that still runs with the same params (after defaults) is returned;
  handles; the busy state, with the export lock; the path's text (section 20.1) and its `.wav` extension; that the
  export holds a clip with audio (`INVALID_ARGUMENT(nothing_to_export)` otherwise, not retryable: OpenTune exports
  nothing then; the job returns the same when every clip is deleted while it waits); the loaded media (below); that the
  target's directory exists (`IO_ERROR(write_failed)`); with `ifExists` `error`, that no file exists at the target
  (`ALREADY_EXISTS(target_exists)`). Then the job takes the export lock until it ends.
- Loaded media are the source files of every source OpenTune holds (`SourceStore`, active or retired,
  since an undo step can bring a retired one back). The target is compared with each by file identity
  (`ControlFileIdentity`, section 20.3), not by its spelling: the same file with other letter case, a
  hard link or a link is refused with `INVALID_ARGUMENT(target_is_loaded_media)`; an identity that cannot
  be determined is `IO_ERROR(read_failed)`. The job checks every name again right before its rename.
- While it waits, each tick of the job builds again what the file is made of (the clips whose content has a playback
  source with audio, as the processor's export functions choose them: for the master mix only the soloed tracks while
  one is soloed, otherwise the tracks that are not muted) and decides per content (section 19 rule 6): analysis not
  finished: wait; no voiced frame (an analysis that failed with `f0_empty`, or that ended ready with no F0 frame above 0
  Hz, the test of `controlCheckContentReady`): export it uncorrected and list it in `dryContents` as `unvoiced`, before
  anything about its render; another failure of the analysis: `ANALYSIS_FAILED(f0_failed)`, or with `allowDry`
  uncorrected (`analysisFailed`); no render block, or only blank ones: uncorrected, `nothingToRender`; render work
  pending or running: wait; then a failed render block: one more `requestFullContentRender()` (its reconcile retries a
  failed block of the same revision), then `RENDER_FAILED(render_chunk_failed)`; ready once the render cache is settled
  at its revision (`RenderCache::isCanonicalSettled`). The job never asks again while blocks are pending: upstream
  `RenderCache::reconcileFullPlanAndRequest` keeps a block that is still pending at an unchanged revision pending but
  out of its set of blocks to claim, the worker's queue drops it, and it is rendered only after the content changes. A
  content without render blocks (its render was never requested) is dry at once when it has nothing to render (no
  correction segment, the identity pitch shift, no note with an active EQ: OpenTune's render would mark every block
  blank) and its time grid is the identity; the job then neither asks for a render nor waits for the render worker. Such
  a content is dry as well when its only render work is blocks out of the worker's reach (pending, none running, none to
  claim, for 0.5 s) and no block holds the rendered audio of an earlier version; any other content waits for those
  blocks until the wait limit. Any other content without render blocks gets one render request. A content whose time
  grid is not the identity is played and exported from its time-stretch output (the Stage2 rebuild), which OpenTune's
  export reads only when it was built at the content's current content and time-grid revisions
  (`readExportPlaybackAudio`); otherwise the content would be silent in the file. Such a content is ready, or exported
  dry, only once that output is current (`TimeStretchCache:: sliceCanonicalForOutputRange`, the export's own read).
  OpenTune queues the rebuild when the grid changes while the render is settled and when a render block settles; when
  the render is settled, no output is current and the render worker is idle, the job queues it as `setContentTimeGrid()`
  does (`ContentRenderService::enqueueStage2RebuildWhenCanonicalSettled`). The worker can drop a rebuild (it gives up
  when the published playback source changed meanwhile), so once the worker has been idle for 0.5 s with still no
  current output, the job queues it again, at most 3 times for the same revisions (`kControlExportMaxStretchRequests`),
  then fails with `NOT_READY(export_stretch_dropped)` (retryable). The rebuild needs a settled render: a content the job
  would export dry (failed or unvoiced analysis, nothing to render) whose grid is not the identity and that has no
  settled render has no audio OpenTune could put in the file, and waiting does not change that, so the job ends at once
  with `NOT_READY(export_dry_stretched)`, not retryable (it succeeds again once the grid is the identity), whatever made
  the content dry (unvoiced, nothing to render, or a failed analysis with `allowDry`; `allowDry` cannot help). After 120
  s: `NOT_READY(export_wait_timeout)`. A clip export whose clip is deleted meanwhile fails with
  `REVISION_CONFLICT(changed_during_export)`.
- In the tick that finds every content ready, the job records a token of the inputs (each clip's track,
  position, length, source window, gain and fades, its track's volume, and per content the revision, time
  grid and pitch shift) and the revisions it reports, and starts the writer on a thread of its own with a
  temporary file in the target directory. Once the file is written: a changed input token is
  `REVISION_CONFLICT(changed_during_export)`; then cancellability ends, loaded media are checked again,
  and the file is moved into place with one rename (`ifExists` `error` and `rename` with a rename that
  never replaces, trying `<stem> (2).wav` to `<stem> (999).wav` for `rename`; `overwrite` with one that
  replaces).
- Every failure and every cancellation deletes the temporary file, leaves the target untouched
  (`executed` false) and releases the lock. A cancellation while the file is written waits for the write.
- The result reports what the file holds: path, sample rate, channel count and sample format read back
  from the file's header, its duration, the timeline start (the clip's start, 0 for a track or the master
  mix), the recorded revisions (`contents`), `dryContents`, and `processing` (vocoder weight, hybrid
  mode, inference backend and `tuningHz`, as `session.info` reports them).

Hooks: the processor's export lock (`tryAcquireExportLock`, `releaseExportLock`, `isExportLockHeld`) and
the editor's use of it (see "Hooks"). The clip of a clip export is found by its placement id with
`StandaloneArrangement::findPlacementIndexById()` right before `exportPlacementAudio()`, so no hook is
needed for it; the input token catches a change of the clips while the file is written.

Known OpenTune behaviours, reported as they are:

- `exportMasterMixAudio()` sets no error text (`getLastExportError()` keeps the text of an earlier export),
  and every failure of the processor's export functions is reported as `IO_ERROR(write_failed)` with a
  fixed detail: the API never forwards OpenTune's texts.
- The processor's export functions wait for every render work of the process (`drainRenderWorker`), not
  only for the exported contents.
- With hybrid mode on (OpenTune's default), a render block whose corrected F0 stays within 75 cents of the
  original on every voiced frame renders through the AutoTune cycle resampler instead of the vocoder
  (`ProcessRenderRuntime`, `chunkNeedsVocoder()`). On sung vocals that path can leave such a block close to the
  uncorrected audio although the block was rendered again at the current revision, so small corrections (an AUTO
  pass, a shift of a few dozen cents) may be missing from the file in some blocks while others, past 75 cents,
  follow their targets. The block is current, not old: the export writes it as rendered and reports `hybridMode`
  true in `processing`; with hybrid mode off every block renders through the vocoder. When every note of a content
  has retune speed 1, the cycle resampler locks onto the target without smoothing, so a period the detector gets
  wrong goes straight into the block.
- A second render request for a content at the same content revision, while blocks it covers are still pending,
  drops those blocks from the render cache's pending set (`RenderCache::reconcileFullPlanAndRequest()` keeps a
  pending block of an unchanged revision without queuing it again): they stay pending and are never rendered until
  the content changes, and an export of the content waits until its limit.

## Time grid

A content's time grid (`Utils/TimeGrid.h`) maps the source audio (the `content` clock) to what plays (the
`output` clock) through handles between ClipStart and ClipEnd; OpenTune's time tool (an experimental tool of
the piano roll) places, drags, inserts and deletes them. The API reports the handles between the end points
(`content.getDetails` `timeGrid`, with each handle's stable id as `handleId`) and edits them with
`content.shiftTiming` and `content.editTimeGrid` (`Ops/TimingOps.cpp`, capability `timing.v1`). The grid has its
own token, `gridRevision` (`expectedGridRevision`, `REVISION_CONFLICT(grid_changed)`); a grid change never
changes the content's `revision`.

- **Checks**, in order: the handle, the busy state, the readiness gate, `expectedGridRevision`, a grid with
  handles (`NOT_READY(grid_not_seeded)`, not retryable: waiting does not seed it), then each handle named once
  (`INVALID_ARGUMENT(duplicate_handle)`) and an inner handle of this grid (`NOT_FOUND(unknown_handle)`; the end
  points, which the API does not report, are no handles of the API).
- **Moves** follow the time tool's drag (`PianoRollToolHandler::handleTimeToolMouseDrag`), computed by
  `Edit/TimeGridOps.cpp` without the piano roll, in two passes: a moved handle is limited to its neighbours plus
  and minus 30 ms (`TimeGridSnapshot::kMinOutputSpacingSeconds`; the time tool drops the spacing only while Alt
  is held, which the API has no equivalent of); when several handles move, every inner handle is then limited
  from left to right to its limited left neighbour plus the spacing and its right neighbour minus the spacing,
  as the time tool's group drag does. When a handle has no room between its neighbours (a grid the time tool
  made tighter than 30 ms), nothing moves, as the time tool keeps the grid as it was. A limited move is applied
  as far as allowed and reported in `clamped` and with the warning `CLAMPED`; a call that moves nothing is a
  no-op.
  - `content.shiftTiming` moves every handle whose output time lies in the range (a content range is mapped
    through the current grid with `tauForward`) by `deltaSec`: a group drag whose dragged handle is the one
    that leads in the direction of the move, so that the section stops at its neighbour and moves as a whole.
  - `content.editTimeGrid` op `moveHandles` moves each named handle to its output time; with several moves the
    first pass limits each one by its neighbours' targets (for one move these are the neighbours as they are,
    exactly the time tool's drag).
- **Commit and undo**, as the piano roll's `commitTimeGrid`: a `TimeGridEditAction` with the grid before and
  after, `ContentEditCommands::setTimeGrid()` (the processor's `setContentTimeGrid()`, which publishes the grid
  for playback and queues the time-stretch rebuild), and one undo entry per call, wrapped in a
  `ControlOriginAction` (aspect time grid). The description is "拖动时间手柄" ("drag time handle"), the text the
  time tool means for its drag (see "Known OpenTune behaviours" below). The project is marked as changed (the
  UI does not mark it after a time-grid edit), `reRenderQueued` names the content, and the editor is told
  through `ControlUiBridge::onTimeGridChanged()`.
- **Seed** (`content.editTimeGrid` op `seed`) places the initial handles as OpenTune does when the time tool is picked
  (`PianoRollComponent::setCurrentTool` calls `OpenTuneAudioProcessor::ensureTimeToolAnchorSeed()`). That function seeds
  from the content's timing analysis (the reference feature analysis) and, while that analysis is not ready, starts it
  and registers the content for a seeding of its own once it finishes. The API runs the seed as a job of kind
  `timeGridSeed` instead: the job asks for the analysis with `preheatReferenceAlignmentFeatures()` (which does nothing
  while it runs or is ready), waits, and calls `ensureTimeToolAnchorSeed()` only once the analysis is ready, which then
  seeds at once. So a cancelled job leaves no deferred seeding behind. Every step checks that the content still exists
  (`NOT_FOUND (unknown_handle)`) and that its pitch analysis is still ready; the first step and the seeding step check
  the busy state; an analysis that failed or found no onset (the time tool then places no handle) ends the job with
  `ANALYSIS_FAILED(timing_analysis_failed)`; after 120 s it ends with `NOT_READY(timing_analysis_timeout)` (retryable;
  the test seam `controlSetSeedWaitLimitForTesting` shortens the limit). A grid that has handles by then is left as it
  is (a no-op). Seeding has no undo entry, as in the UI (`ui_parity`, no revert recipe, `IRREVERSIBLE`); like every
  change without an undo entry it masks the grid in earlier entries of the API and clears the redo history (PROTOCOL.md
  section 15.3 rule 9). The seeded handles have output equal to content, so the content sounds the same and nothing is
  rendered again.
- **Export**: a content whose grid is not the identity is exported only once its time-stretch output is
  current (see "Export").
- Inserting and deleting handles, and setting or resetting a whole grid, are not part of this build.

The upstream functions it follows, registered in `mirror-map.json` (see "Mirrors"; `ControlMirrorDriftTests` fails
when one of them changes). A change of these functions upstream needs the same change here:

| Upstream function | Followed in | Mirror id |
|---|---|---|
| `PianoRollToolHandler::handleTimeToolMouseDrag()` (`Source/Standalone/UI/PianoRoll/PianoRollToolHandler.cpp`) | `TimeGridOps::planShift()`, `planMoves()`: the limit of the dragged handle, the uniform distance of a group, the second pass | `time-tool-drag` |
| `PianoRollToolHandler::handleTimeToolMouseUp()` (same file) | the commit of a moved grid and its description (`applyPlan` in `Ops/TimingOps.cpp`) | `time-tool-mouse-up` |
| the piano roll's `toolCtx.commitTimeGrid` (`Source/Standalone/UI/PianoRollComponent.cpp`) | `TimeGridOps::commit()` and the undo entry of `Ops/TimingOps.cpp` | `time-grid-commit` |
| `PianoRollComponent::setCurrentTool()` (same file) | the seed job's call of `ensureTimeToolAnchorSeed()` | `time-tool-pick` |
| `OpenTuneAudioProcessor::ensureTimeToolAnchorSeed()` (`Source/PluginProcessor.cpp`) | the seed job's condition for seeding at once (a grid without handles, `featuresReady`) | `time-seed-anchors` |
| `OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures()` (same file) | the seed job's reading of `AlreadyReady` as the producer and fingerprint part of `featuresReady` | `time-seed-preheat` |
| `OpenTuneAudioProcessor::setContentTimeGrid()` (same file) | the export's request of the time-stretch rebuild (`ExportJob::stretchState` in `Ops/ExportOps.cpp`) | `time-grid-publish` |

Known OpenTune behaviours, reported as they are:

- The time tool's own description literal of its drag ("拖动时间手柄") is stored in
  `PianoRollToolHandler.cpp` with a broken encoding, so the UI's entries carry garbled text; the API's entries
  carry the intended text. The UI never shows the description.
- The UI does not mark the project as changed after a time-grid edit or a seed; the API does (section 15.5).
- `ensureTimeToolAnchorSeed()` replaces a grid whose handles are all of kind `UserAdded` and that is the identity;
  the API never calls it for a grid that has handles.
- The reference analysis service runs only one synchronous analysis (the standard producer, which the time tool's
  seeding uses by default) per session: `ReferenceAnalysisService::workerLoop` moves its finished job out of `activeJob`
  with `std::move`, which leaves the optional engaged, so the worker never takes the next job. A later seed of another
  content, from the UI or the API, waits for an analysis that never finishes; the seed job ends with
  `NOT_READY(timing_analysis_timeout)` after its wait limit, or when it is cancelled, and never seeds without the
  analysis. `TimeGridSeed` shows it.

## Reference alignment

`content.analyzeReference` and `content.autoTune` in mode `reference` (capability `reference.v1`, `Ops/ReferenceOps.cpp`).
The capability is reported because its one method is registered; the `arrangement.edit` op that binds a clip to a
reference clip belongs to another part, so a binding is made in the editor's menu (or, in tests,
`StandaloneArrangement::setPlacementReferencePlacement()`).

- **Analysis** (`content.analyzeReference`): a job of kind `referenceAnalysis`. The call resolves the placement
  (`NOT_FOUND`), its binding (`INVALID_ARGUMENT(reference_not_bound)`) and the readiness of both pitch analyses
  (`NOT_READY`), and a call for a placement whose analysis job is not terminal returns that job (never the job of
  `content.autoTune`, which has another result). The job asks OpenTune for the alignment features of both contents with
  `preheatReferenceAlignmentFeatures()` (what the editor asks for when such a clip is selected), waits, and reports
  `{placementId, referencePlacementId, alignmentReady}`. It changes no edit: no undo entry, no dirty mark.
- **Alignment** (`content.autoTune` mode `reference`): the call checks the capability, the content, the busy state, the
  readiness gate, the tokens, that the placement shows the content (`placement_content_mismatch`) and the binding, then
  hands the work to the same kind of job. The job computes the data the binding lacks, then aligns the whole content
  (`controlAlignToReference()`) and returns the write envelope. The alignment is one undo step: a
  `PianoRollEditAction` described `AUTO (Ref)` in one `ControlOriginAction`. The project is marked as changed, as the
  editor does after AUTO. When the reference gives nothing to change (`AlignmentPatch::ErrorCode::NoMutation`) the job
  succeeds as a no-op, without an undo entry.
- **Checks made again**: every step resolves the binding again (placement exists, same binding, both analyses ready); the
  first step and the commit of the aligning job also check the busy state. The tokens are compared twice: by the call,
  and again in the message-thread step of the commit, just before the alignment (PROTOCOL.md section 10 rule 3), with
  the `expectedRevision` and, when given, the `expectedKeyRevision` the call checked. A change of the notes, pitch,
  audio or key made while the job waited fails it with `REVISION_CONFLICT(content_changed)` or `(key_changed)`. The
  alignment data the job waits for is no such change: OpenTune stores it in the content's `referenceFeatures` alone
  (`setContentReferenceFeatures()` advances no notes, pitch or audio revision and leaves the key), which only the
  `reference` component of the revision vector covers. A job that fails writes nothing. They are
  cancellable until the alignment is committed; cancelling stops the wait and cannot withdraw an analysis OpenTune has
  already started (its result is stored, as when the editor asks for it).
- **Wait limit and reasons**: a job that has to wait ends at once with `NOT_READY(reference_analysis_stalled)` (not
  retryable) when OpenTune's reference analysis worker has already completed its one synchronous analysis of the
  session and a content still lacks its data: no further analysis can finish without a restart of OpenTune. The
  processor's read-only `isReferenceAnalysisWorkerStalled()` records that completion (see Hooks); a binding whose both
  contents already have data is not affected. Otherwise the job waits 120 s
  (`controlSetReferenceWaitLimitForTesting`), then ends with `NOT_READY(reference_analysis_timeout)` (retryable; the
  analysis is still running). An analysis that failed ends the job with `ANALYSIS_FAILED(reference_analysis_failed)`,
  and so does one that found no notes to align with. These three reasons are the rc.4 additions; the locked copy of
  the specification in this fork is rc.3 and has none of them for this wait.

  | Reason | Kind | retryable | Meaning |
  |---|---|---|---|
  | `reference_analysis_stalled` | `NOT_READY` | no | OpenTune's analysis worker will take no further synchronous analysis in this session; restart OpenTune. |
  | `reference_analysis_timeout` | `NOT_READY` | yes | the analysis is still running; the job waited past its limit. |
  | `reference_analysis_failed` | `ANALYSIS_FAILED` | no | OpenTune's analysis failed or found no notes to align with. |
- **Mirror**: `controlAlignToReference()` follows `OpenTuneAudioProcessor::executeReferenceAlignmentForPlacement()`
  (`reference-align-commit`) step by step, because that function pushes its undo action itself and the API needs the
  action inside its own entry. It starts no analysis (the job did) and returns the action instead of pushing it.

Known OpenTune behaviour, reported as it is: `ReferenceAnalysisService::workerLoop` moves its finished synchronous job
out of `activeJob` with `std::move`, which leaves the optional engaged, so the worker never takes the next job. The
standard producer therefore completes one analysis per session, while a binding needs two (the clip and its reference
clip). The first `content.analyzeReference` job of a new binding itself uses that one completion for one of the two
contents (the job preheats both; the worker picks the pending job with the lowest content key, not the submission
order, and the other stays queued). If both contents already have their data (for example loaded with the project, or
prepared before this session) the job completes without the worker. Once a synchronous analysis has finished in this
session, a content that still lacks data cannot get it, so the job ends as soon as the completion is seen with
`NOT_READY(reference_analysis_stalled)`, and the detail says that OpenTune has to be restarted. The analysis with the
GAME producer is asynchronous and unaffected. `ReferenceAnalysisLimit` shows both cases. The API does not fix the
defect.

## Project files

`project.save`, `project.saveAs`, `project.open` and `project.clearRecent` (`Ops/ProjectOps.cpp`, capability
`project.io`, reported only because all four are registered). The project session and its worker pool belong to the
editor (`ProjectSession` stays inside it, as the processor takes over no project state), so the methods reach them
through `ControlUiBridge::projectSession()` and `projectWorkerPool()`; without an editor the save and open methods
answer `UNSUPPORTED(capability_missing)`, and `project.clearRecent`, which is a preference, still works.

The editor's own flows (`saveProject`, `startOpenProject`) show a dialog when they fail and have no way to report
their end, so the jobs do not call them. They run the same steps on `ProjectSession`'s two-phase calls and hand the
editor's UI steps to the bridge: `onProjectSaved()` (recent-projects menu and title), `onProjectReloaded()` (menu,
title and `refreshAllUIFromProject()`), `onRecentProjectsChanged()` and `setProjectOperationRunning()`, the editor's
`projectOperationBusy_` flag. The two editor functions are registered as mirrors (`project-save-flow`,
`project-open-flow`).

- **Save (`projectSave`, not cancellable).** The request takes the snapshot on the message thread
  (`ProjectSession::prepareSave()`), a worker of the editor's pool writes the project and copies the media
  (`ProjectSession::executeSaveToFile()`), but into a temporary file in the target directory. When the worker is done,
  the job decides again, by file identity (PROTOCOL.md sections 20.2 rule 4 and 20.3 rule 5), whether the target is the
  project's file, another existing file or none, and moves the temporary file into place with the final rename of
  section 20.4: it replaces the target only for the project's own file or with `confirm`; otherwise a file that appeared
  meanwhile ends the job with `INVALID_ARGUMENT(confirm_required)` and is not touched. Then, as the editor does, the
  file becomes the project's file, the unsaved-changes flag is cleared unless the project changed meanwhile (dirty
  generation), the file is pushed to the recent projects, and the editor updates its menu and title. The result is
  never a no-op (`ControlWriteEnvelope::markEffective()`), carries `IRREVERSIBLE` (the file's earlier content cannot be
  brought back), `OVERWROTE_OTHER_PROJECT` for another project file that was replaced, and `NOT_SAVED_IN_PROJECT`.
- **Open (`projectOpen`, cancellable until the file is prepared).** A worker reads the project and its media
  (`ProjectSession::prepareOpen()`); the job then commits it in one message-thread step
  (`ProjectSession::commitPreparedOpen()`), which clears the content repository (a new content epoch: the handles of the
  project before are stale), OpenTune's undo history and the render state. The request refuses with
  `UNSAVED_CHANGES(project_dirty)` unless `discardUnsaved` is true; the job checks the flag once more right before the
  commit (changes made while the file was prepared are not discarded unasked) and never saves. Tracks that hold clips
  are shown. The result lists the previous clips and contents as removed and the new ones as created (at most 200
  entries each, `omittedCount` counts the rest), what was restored and skipped (media files that do not exist or
  cannot be read, with `MEDIA_MISSING` for the missing ones), and how many undo and redo entries were cleared. The
  revert recipe opens the previous file again when the previous project had one and no unsaved changes.
- **Busy.** A job sets the editor's project-operation flag for its whole run, so that the editor's file commands and
  every other write answer `BUSY(project_operation)` meanwhile (the checks use `queryBusy()` as for every write).
- **Recent projects.** `project.clearRecent` calls `AppPreferences::clearRecentProjects()`, which is what the editor's
  command (`ProjectSession::clearRecentProjects()`) does on the same preferences.

Tests: `Tests/Control/ControlProjectTests.cpp` (`ProjectRoundTrip`, `ProjectJobs`, `ProjectWithoutEditor`,
`ProjectVectors`). `ProjectVectors` runs the specification's `project/*` vectors of `project.io` and requires an
explicit list to pass; `project/get-ok` is a read and runs in `Vectors`, and `project/save-as-no-access` is skipped
because the runner cannot make a file whose identity is unreadable on Windows.

## Transport and tracks

The transport (`Ops/TransportOps.cpp`, capability `transport.v1`) and the tracks (`Ops/TrackOps.cpp`, capability
`tracks.v1`; the helpers that clip methods share are in `Ops/TrackSupport.*`). Both capabilities are reported:
all their methods are registered.

**Transport.** `transport.control` calls the processor's Standalone transport functions (`play`, `pause`, `stop`,
`pauseAtPosition`, `setPosition`) and records the call with `recordControlCall()`, as the editor's listener functions
do, so `transport.get` reports it as `lastControl`. `playFromLastStart` and `pauseAtLastStart` are the two branches of
the editor's play-from-start button (`playFromStartToggleRequested`). "Last start" is the position of the last play
**or seek** (`getPlayStartPosition()`), not 0: `play` and `seek` set it, and so does a seek in the UI. A `play` during
playback, a `pause` or `pauseAtLastStart` while stopped, and any call that leaves the play state, position and play
start as they are, change nothing and are `noOp`. The audio callback carries the commands out a block later. `stop`
freezes the presented position at once (`OpenTuneAudioProcessor::stop()`) and the callback fades the transport out and
lands it on 0 when the fade completes (`kTransportRampDurationSeconds`, 0.2 s on the audio thread), so the result and
`transport.get` right after the call report the frozen presented position, and a read after the fade reports 0; a
`pauseAtLastStart` that runs while playing reports the last start it is about to land on. Without a device the position
does not advance, nothing carries a command out, and `play` and `playFromLastStart` carry `NO_AUDIO_DEVICE`. The play
state and the position are view state (`not_persisted_state`,
no revert, no `IRREVERSIBLE`, the project is not marked as changed). `transport.setTempo` calls `setBpm()` and
`setTimeSignature()` and marks the project as changed (the UI does too); there is no undo entry (`ui_parity`) and the
revert recipe sets the previous values. Only a numerator up to 32 and a denominator that is a power of two up to 32
are accepted: the processor's setter would silently ignore other denominators. `transport.setLoop` sets the flag,
which has no audible effect in the Standalone (`LOOP_NO_EFFECT_STANDALONE` when it is turned on, `NOT_PERSISTED`). The
editor refreshes its transport bar and piano roll through `ControlUiBridge::onTransportChanged()` and
`onTempoChanged()`.

**Tracks.** OpenTune identifies a track by its position and has `MAX_TRACKS` slots; the editor shows the first few
(`ControlUiBridge::visibleTrackCount()`, `setVisibleTrackCount()`), and a project that was opened can have clips in
hidden slots. The methods that change the number of shown tracks need the editor (`UNSUPPORTED(capability_missing)`
without one); `track.set` works on the arrangement alone.

- `track.set` sets mute, solo, volume and colour through the arrangement's setters (the ones behind the panel's
  controls). The volume knob covers linear 0 to 4: more is limited and reported with `CLAMPED`. The colour is set
  directly, without the colour dialog. `changes` lists every track whose members changed, `audible` too, which follows
  the solo flags of the other tracks. The revert recipe sets the previous values of the members that changed (the
  volume in dB, or linearly when it was silent).
- `track.add` follows the panel's + button (`TrackPanelComponent::showMoreTracks`): it shows more slots, which is view
  state (`NOT_PERSISTED`, the project is not marked as changed). The panel's context menu entry (`trackAddRequested`)
  also marks the project as changed; the schema follows the button.
- `track.duplicate` follows `trackDuplicateRequested`: mix state and a copy of every clip go to the first hidden slot.
  Mode `share` is what the UI does (the copies show the same contents, `SHARED_CONTENT`); mode `clone` first gives every
  clip a content of its own with `OpenTuneAudioProcessor::cloneContent()`. A clip that waits to be reclaimed
  (`isRetired`) is not copied, where the UI would copy it as well. The reference binding of a clip is copied, as the UI
  copies it.
- `track.delete` follows `trackDeleteRequested`: `StandaloneArrangement::removeTrackAndShift()`, then the panel shows
  the mix of the arrangement and one track fewer. It needs `confirm`, the revision of the arrangement, and a shown
  track that is not the only one. `trackIdMap` lists the deleted track and the shown tracks after it (hidden slots
  keep their position and clips, so they are not listed). `removed` (the clips, then the contents that left with their last
  clip), `danglingReferences` and `possiblyStaleEntries` describe the effect; see "Undo history" for the barrier.

OpenTune behaviours that the methods report and do not fix:

- `removeTrackAndShift()` drops the placements without retiring them or their contents, so the content repository still
  lists the contents of the removed clips as live (and their audio stays in memory until the project is closed). The
  control API does not show such a content any more: `ControlHistory::markContentsRemoved()` keeps them out of
  `controlLiveContents()` and `controlLiveSnapshot()`, so `project.get` does not list them and their handles are
  `NOT_FOUND(unknown_handle)`. The leak itself stays.
- A clip of another track whose reference binding names a removed clip keeps the binding in OpenTune; `track.delete`
  clears it with `setPlacementReferencePlacement(..., 0)` and reports it in `danglingReferences` and `changes`.
- Earlier clip undo steps address tracks by position: after a deletion they may do nothing, while the UI still uses the
  step up and marks the project as changed. The API reports it (`noOp`, `UNDO_NO_EFFECT`).

Mirrors: `track-add`, `track-duplicate`, `track-delete`, `transport-play-from-start` and `track-volume-range`.

Tests: `Tests/Control/ControlTracksTests.cpp` (`Transport`, `Tracks`, `TrackBarrier`, `TrackVectors`).

## Arrangement

`arrangement.edit` and `arrangement.copy` (`Ops/ArrangementOps.cpp`, capability `arrangement.v1`, reported since both
methods are registered). They call the functions behind the arrangement view's mouse and key actions and push the undo
actions the view pushes (`Utils/PlacementActions.h`), wrapped in one `ControlOriginAction` per call.

**arrangement.edit.** The checks run in the order of PROTOCOL.md section 9: every handle (the clips, the reference clip,
the trailing clip of a merge, the slot of `toTrackId`), then busy, then `expectedArrangementRevision`, then the ops.
`split`, `merge` and `delete` stand alone in a call; `confirm` is accepted only with `delete`.

- `move`, `trim`, `setGain`, `setFade` and `setReference` are planned in order on a copy of the arrangement first, so a
  call whose later op fails changes nothing; then each is applied through the arrangement's setter
  (`applyPlacementMoves()`, `setPlacementTrimAndTimelineStart()` / `setPlacementTrim()`, `setPlacementGain()`,
  `setPlacementFade()`, `setPlacementReferencePlacement()`) and recorded with the view's action
  (`MultiMovePlacementAction`, `TrimPlacementAction`, `GainChangeAction`, `FadeChangeAction`, `ReferenceBindingAction`).
  The whole call is one undo entry; `changes` holds one entry per clip with every field that changed.
- `trim` computes the start edge as the edge drag does, through the content's time grid (mirror
  `arrangement-trim-left`), and refuses an edge beyond the content's audio, past the other edge or shorter than 0.01 s
  (`trim_out_of_range`); the drag clamps instead. Fades that the new length cuts are reported with `FADES_RECLAMPED`, and
  a `FadeChangeAction` before the `TrimPlacementAction` keeps the old fades, so undo restores them.
- `setFade` limits a fade to 90 % of the clip, as `setPlacementFade()` does, and reports `CLAMPED`. `setGain` takes dB or
  a linear factor and limits it to the interface's gain range, linear 0 to 4 (the volume knob's
  `setRange(0.0, 4.0, 0.001)`, `TrackPanelComponent.h`; the clip-gain drag itself has no bound,
  `ArrangementViewComponent.cpp`), with `CLAMPED` in the unit the caller named and the limited value in `changes`;
  `dryRun` predicts the same. Zero is the lower end.
- `setReference` accepts what `validateReferenceBindingUnlocked()` accepts, checked on the arrangement as the earlier
  ops of the call leave it (`reference_ineligible`), and warns `EXPERIMENTAL_FEATURE`.
- A clip moved to a hidden track shows the hidden tracks up to it (`ControlUiBridge::revealTracks()`,
  `TRACK_AUTO_REVEALED`, side effect `tracksRevealed`); a clip that ends up overlapping another on its track carries
  `OVERLAPS_CLIP`.
- `split` checks what `splitPlacementAtSeconds()` checks, in its order (mirror `arrangement-split`): a position more
  than 0.1 s inside the clip (`split_out_of_range`), a ready analysis (`NOT_READY`), an unedited time grid and an
  analysis frame boundary on the sample grid (OpenTune refuses the other cases silently: `UNSUPPORTED(upstream_absent)`).
  The cut snaps to the nearest frame boundary (`SPLIT_SNAPPED`). `merge` checks what `mergePlacements()` checks before
  it changes anything (`merge_not_possible`, `NOT_READY` while an analysis runs) and reports its later refusals the same
  way. `delete` needs `confirm` (`confirm_required`) and removes the clips with `deletePlacement()`, in one undo entry.
- `dryRun` predicts the changes and warnings without changing anything; a split or merge prediction names the clips it
  replaces, since the new clips get their placementIds when they are made.

**arrangement.copy.** Mode `window` is the view's paste (`copyContentRange()`: a new content of the part the clip
shows, a clip that shows all of it), mode `full` is its duplicate (`cloneContent()`: a copy of the whole content, the
clip as it is). The contents are made first, so a failure leaves the arrangement as it was. Several sources keep their
distances from the earliest one. As in the UI there is no undo entry (`ui_parity`); the revert recipe deletes the
copies with `arrangement.edit` and `requiresConsent`. A copy at the source's own start carries `STACKED_ON_SOURCE`.

OpenTune behaviours that the methods report and do not fix:

- The undo actions of split, merge and delete (`SplitPlacementAction`, `MergePlacementAction`,
  `DeletePlacementAction`) do not bring the clips back: the clips they would restore are reclaimed on the next message
  turn. The API marks these entries unsafe (`edit.undo` refuses them with `UNSUPPORTED(undo_unsafe_build)`), reports
  `UPSTREAM_UNDO_DEFECT` and gives a revert recipe instead: merge the two parts of a split, split a merged clip at the
  former boundary. A delete has no revert recipe (`IRREVERSIBLE`).
- `deletePlacement()` retires the content of a deleted clip even when another clip still shows it; `removed` lists the
  contents that left the project.
- A copy keeps the source's reference binding without checking it; a window copy elsewhere on the timeline may name a
  reference clip it does not overlap.
- The editor's reference context and piano roll are not refreshed after a binding changes through the API; the
  arrangement view redraws (`onStructureChanged()`).

Mirrors: `arrangement-trim-left`, `arrangement-trim-fades`, `arrangement-fade-limit`, `arrangement-split`,
`arrangement-merge` and `arrangement-reference-binding`.

Tests: `Tests/Control/ControlArrangementTests.cpp` (`Arrangement`, `ArrangementUndo`, `ArrangementCopy`,
`ArrangementVectors`).

## Dialogs and onboarding

`ui.getState` and `ui.dismiss` (`Ops/UiOps.cpp`, capability `ui.bridge`). The third method of `ui.bridge`,
`ui.setSelection`, is described in "Selection"; with it registered the instance reports `ui.bridge`.
`ui.onboardingClose`, a capability without methods of its own, is reported right after `ui.bridge`
(`kFeatureCapabilities` in `Ops/OpsRegistry.cpp`), because every build with the editor bridge can close an overlay that
is showing. Both methods describe the editor window and answer `UNSUPPORTED(capability_missing)` without an editor.

The editor's side is `Source/Standalone/ControlEditorBridgeModals.cpp`. It reads the open windows through JUCE's
`ModalComponentManager` (index 0 is the window in front; `openDialogs()` lists them from the bottom) and calls only
what the dialogs and the overlay offer publicly, so it needs no hook in their classes. The reserved hook "public
`dismiss()` on `OnboardingOverlayComponent`" is not needed: the overlay's public `keyPressed()` finishes it on Escape.

**Classification** (`classify()`). A window it does not know is `unknown` with `closeCommits` true, as the protocol asks.

| Modal window | Recognised by | kind | closeCommits | What closing it as Escape does |
|---|---|---|---|---|
| Track colour (`OpenTuneAudioProcessorEditor::trackColorChangeRequested`) | a `DialogWindow` named `Track <n> Color` whose content holds a `juce::ColourSelector`; `trackId` is n - 1 | `trackColour` | true | The content's destructor sets the track's colour to the one shown, refreshes the track panel and the arrangement, and marks the project as changed. |
| `ConfirmDialogContent::showMessage`, `showDiagnostic` (also the OriginalF0 and render-failure diagnostics) | a `ConfirmDialogContent` with one button, or with Copy then OK | `message` | false | Its dismiss path: the window closes, no button action runs. |
| Any other `ConfirmDialogContent` (unsaved changes, overwrite, the onboarding's workflow choice, ...) | a `ConfirmDialogContent` | `confirm` | false | Its dismiss callback, which cancels the action it asked about; the onboarding's choice dialog finishes the overlay. |
| Pitch shift (`pitchShiftRequested`) | `PitchShiftDialogContent` | `pitchShift` | false | The window hides; only its confirm and reset buttons commit. |
| Preferences | `TabbedPreferencesDialog` | `preferences` | false | The window hides; the pages apply each setting when it changes. |
| Shortcut capture (in the preferences) | `ShortcutCaptureDialogContent` | `unknown` | true | Escape would become the new shortcut, so `ui.dismiss` closes it with its window's close button, which cancels. |
| Popup menus and any other window (also the audio settings of the Standalone wrapper) | anything else | `unknown` | true | Escape, else the window's close button, else `exitModalState`. |
| File chooser | `juce::FileChooser`'s modal component (`FileChooser::Native`, told apart only by its type name) or a `FileChooserDialogBox` | not listed | - | Not closed: only the user can close it. |

Titles are the window's name (`DialogWindow::getName()`). `ConfirmDialogContent` and the shortcut dialog draw their
title themselves and keep it private, so their title is empty.

**Closing** (`closeTopDialog()`). Escape goes to the content first and then to the window (`Component::keyPressed`,
public there), as when the dialog has the keyboard focus. A dialog that ignores Escape closes with its window's close
button, any other modal component with `exitModalState`. Then the window's content is deleted at once
(`ResizableWindow::clearContentComponent()`), while the modal manager deletes the empty window later as always: what the
dialog does when it closes has happened when the call returns (the colour is committed before the result is built), and
the content stops listening to its window before the window goes.

`ui.dismiss` with target `dialogs` checks before it closes anything. A file chooser above a listed dialog refuses the
call with `BUSY(modal_open)`; a dialog whose `closeCommits` is true refuses it without `confirm`
(`INVALID_ARGUMENT(dialog_commits_on_close)`). It then closes from the top down and stops early when closing a dialog
opened another (the new one is left open, unchecked). A committed colour is a change of the track (`changes`,
`sideEffects.dialogCommitted`, `DIALOG_CLOSE_COMMITTED`) without an undo entry (`ui_parity`), as in OpenTune; its revert
recipe is `track.set`, which is null, with `IRREVERSIBLE`, while the instance does not report `tracks.v1`. A colour
dialog that shows the track's own colour still commits it (the project is marked as changed, `dialogCommitted` is
reported) but lists no change. Dialogs that commit nothing are view state: `not_persisted_state`, revert null, no
warning.

**Busy.** `ui.getState` is a read and never answers BUSY. `ui.dismiss` checks with `ControlBusyScope::DialogDismiss`:
an open dialog does not refuse it, a gesture, an import of the UI, an export or a project operation does. A file
chooser of the operating system is a modal component of JUCE while it is open (on Windows `FileChooser` makes its own
component modal while the system dialog runs), so `queryBusy()` reports `modalOpen` and every other write answers
`BUSY(modal_open)`; `ui.getState` counts it in `busy.modalOpen` but does not list it. This follows from JUCE's code and
is checked headlessly only; whether a native chooser on macOS appears in the modal stack is still to be confirmed in a
real window.

**Onboarding.** `onboarding.shown` is the preference `onboardingShown` (`AppPreferences`), which the editor's timer
checks before it starts the overlay; `onboarding.showing` is `OnboardingOverlayComponent::isActive()`. With target
`onboarding`:
- Not showing and never shown: sets the preference, which keeps the overlay from starting (`no_upstream_undo`,
  `IRREVERSIBLE`). Preventing it is the client's call before the work that the overlay would interrupt; the API never
  sets the preference by itself.
- Showing (needs `ui.onboardingClose`): does what pressing Escape until the overlay is gone does. The dialogs above it
  close first (the workflow choice is a `ConfirmDialogContent` whose dismissal finishes the overlay; a dialog that
  commits on close refuses the call), then the overlay's own `keyPressed()` finishes it, as its exit button does.
  OpenTune sets `onboardingShown` when the overlay shows its choice, so in the real window the preference is already
  true and the result lists no change: undo `not_persisted_state`, not a no-op. The vector `ui/dismiss-onboarding-close`
  describes an overlay that has not set the preference yet; the test bridge plays that, and the change of
  `onboardingShown` from false to true is reported.
- Shown before and not showing: a no-op.

**F0 diagnostic.** The OriginalF0 diagnostic is shown by the editor's heartbeat (`timerCallback`) whenever the
processor's F0 failure generation changes, for any content, and nothing tells it which analysis the API started; the
render-failure diagnostic is posted by `ProcessRenderRuntime::notifyApplicationRenderFailure()`, which knows no editor.
Suppressing either for work the API started would need a hook in upstream logic, so the API does not: both are
`message` dialogs, which `ui.getState` lists and `ui.dismiss` closes.

**uiScale** is the scale the editor last applied for the selected clip (`lastResolvedScaleRootNote_`,
`lastResolvedScaleType_`, set by `applyResolvedScaleForPlacementContent()`), which the transport bar shows and AUTO,
SNAP and the pitch tool use. A scale picked in the transport bar while no clip is selected changes only the UI and is
not reflected.

**Deviations from the vectors.** OpenTune always has an active track (track 0 in a new project), so the UI snapshot
reports `activeTrackId` 0 where `ui/get-state-ok` expects null; its runner checks 0 instead. The titles of
`ConfirmDialogContent` dialogs are empty (above). `ui/dismiss-confirm-commit` needs `tracks.v1` for its revert recipe
and is skipped until that capability is reported; `UiDismiss` covers the same commit without it.

Tests: `Tests/Control/ControlUiTests.cpp` (`UiState`, `UiDismiss`, `UiOnboardingWithheld`, `UiVectors`) against the
test bridge's dialogs and overlay (`TestUiBridge`); `UiVectors` requires an explicit list of `ui/*` vectors to pass and
leaves the vectors of `ui.setSelection` to `SelectionVectors`. The classification and the closing of the real windows
run only in the Standalone application.

## Selection

`ui.setSelection` (`Ops/SelectionOps.cpp`, capability `ui.bridge`) selects a clip (`placementId`) or a track
(`trackId`) through `ControlUiBridge::select()`. The editor's side, `Source/Standalone/ControlEditorBridgeSelection.cpp`,
does what the arrangement view does when the user clicks:

- a clip: `ArrangementViewComponent::commitControlSelection()` (the view's hook, see "Hooks"), the steps of a plain click
  on a clip that is not selected: the clip alone in the view's selection, which it highlights and which its keyboard
  commands act on, then `commitPlacementSelection()`, which selects it in the arrangement and tells the editor
  (`placementSelectionChanged`: `applyPlacementSelectionContext`, which makes its track the active track, shows the clip
  in the piano roll and the clip's key in the transport bar, then `refreshReferenceContext`). With `openEditor`
  `placementDoubleClicked()` follows, as with a double click, which switches to the piano roll when the arrangement is
  shown. The clip becomes the only selected clip even when it was part of a multi-selection (a click there keeps the
  others for a drag).
- a track: `applyPlacementSelectionContext(trackId, 0)` (the active track, no clip selected on it, the piano roll
  empty), then the hook with no clip, which runs `commitEmptyPlacementSelection()` as a click on an empty area does (the
  view drops its selection; the editor refreshes its reference context for no clip). The scale of the transport bar
  stays. The track panel's own click (`trackSelected`) would select the track's remembered clip instead; the schema
  asks for no clip.

Selecting can change more than the selection (PROTOCOL.md section 21 rule 3). The method predicts these effects from
the state before (dryRun returns the prediction and changes nothing, the selection included), then selects and reports
what it observed; a difference from the prediction is logged (`AppLogger`), and the result says what happened:

| Effect | Predicted from (mirrored) | Observed as |
|---|---|---|
| `notesGenerated`, warnings `SELECTION_GENERATED_NOTES` and `IRREVERSIBLE`, project marked as changed | The openDyne scheme applied (`editingSchemeApplied`), the piano roll getting another clip (`setEditedContentAndProjection` returns early otherwise), notes never generated (`noteTopologyInitialized` false) and a ready pitch analysis (`ensureOpenDyneNotesIfNeeded`); the count from `LegacyNoteGenerator` with the editor's parameters, merged as `generateNotesOnlyByContentKey` merges | `noteTopologyInitialized` false before, true after; the count of the content's notes |
| `referenceAnalysisQueued` (the clip's content and the bound clip's), warning `REFERENCE_ANALYSIS_QUEUED` | A reference binding that resolves, experimental features on, not openDyne (`evaluateAutoRefUiState` reports no binding there), then per content what `preheatReferenceAlignmentFeatures` would do: request the pitch analysis when it was never requested, or start the alignment analysis unless data of the current producer and audio are ready, failed or being made | The pitch analysis requested, or the alignment data set to `Extracting` with a new analysis revision |
| `uiScaleChanged {before, after}` (`{root, scale}`, as `ui.getState` reports `uiScale`) | `ControlUiBridge::scaleForSelection()`: the editor's own `resolveScaleForPlacementContent()` | `uiScale()` before and after |
| `workspaceSwitched {from, to}` | `openEditor` with the arrangement shown | the workspace of `viewState()` before and after |

The selection itself is the change `{entity: "selection", ref: {singleton: "selection"}}` with `activeTrackId` and
`selectedPlacementIds` (the selected clip of the active track, as the UI snapshot reports it), each only when it
changed. It is view state: the undo reason is `not_persisted_state`, and the revert recipe is `ui.setSelection` with the
clip that was selected on the active track before, or with that track when none was; it never takes back notes or
switches the window back. Generated notes have no undo entry (as in OpenTune), so they carry `IRREVERSIBLE` themselves.
Selecting what is selected, with no other effect, is a no-op. The order of the checks: the editor (`UNSUPPORTED`
without one), the handle (`NOT_FOUND`), busy (also for dryRun).

**Deviations from the vectors.** OpenTune always has an active track (track 0 in a new project), so where the vectors
start with "no track active" the runner starts with track 0 active and no clip selected: selecting a clip on track 0
lists no `activeTrackId` (it did not change), and the revert recipe selects track 0 where the vectors expect null. In
the openDyne scheme OpenTune's reference context reports no binding, so `ui/set-selection-generates-notes` (openDyne, a
binding, experimental features on) queues no reference analysis; the runner leaves `referenceAnalysisQueued` and
`REFERENCE_ANALYSIS_QUEUED` out of that vector's expectation. A selection that queues reference analysis lists the
`reference` component (and the `content` component when the pitch analysis was requested) of both contents in
`revisionDiff`.

Tests: `Tests/Control/ControlSelectionTests.cpp` with a test bridge that selects as the editor does on the real
processor (`generateNotesOnlyByContentKey` for the piano roll's notes, `preheatReferenceAlignmentFeatures` for the
reference context). `Selection` checks the capability, the params, `NOT_FOUND`, `UNSUPPORTED`, busy, dryRun leaving the
state as it was, a clip, `openEditor`, the scale with `ui.getState`, the no-op, the revert recipe sent back and a
track. `SelectionMatrix` runs both schemes with a clip with and without notes and with and without a reference binding:
the prediction of dryRun equals the committed result, and dryRun leaves every field of the state as it was. The test
bridge and the prediction follow the same rules, so this shows that the two copies agree, not that the prediction agrees
with the real editor; drift of the real editor is caught by the drift pins ("Mirrors") and by checks in the real
Standalone. `SelectionVectors` runs the vectors `ui/set-selection-*` (adjusted as above). The view's highlight and
keyboard target, and the real piano roll, run only in the Standalone application.

## Preferences and audio device

`prefs.set` (`Ops/PrefsOps.cpp`, capability `prefs.write`) and `audio.get` / `audio.set` (`Ops/AudioDeviceOps.cpp`,
capability `audio.device`). Each capability is reported because all its methods are registered. Both settings are
user-global: results carry the warning `GLOBAL_PREFERENCE`, there is no undo entry (OpenTune has none; reason
`ui_parity`), and the revert recipe is the same call with the previous values.

**prefs.set** changes the four processing preferences that the schema lists: `tuningHz` (A4), `editingScheme`,
`hybridMode` and `experimentalFeatures`. The vocoder weight, the rendering priority, the pitch model and the reference
alignment mode cannot be set in this version, and no cosmetic preference can be; the params schema is closed, so
they are `INVALID_ARGUMENT(invalid_params)`. Each change repeats what the preferences window does for its control
(the `AppPreferences` setter, for the hybrid switch also `invalidateAllContentCaches()`, which is why the result
carries `reRenderQueued`) and then calls `ControlUiBridge::onPreferencesChanged()`, which is the editor's
`syncSharedAppPreferences()`. Values equal to the current ones change nothing (a no-op when none differs). The tuning
does not recompute existing results (`NOT_RETROACTIVE`).

- **Editing scheme: a job.** A call that changes the editing scheme changes nothing itself and returns a job of kind
  `prefsApply` (not cancellable). The job's first step makes every change of the call, the following steps wait until
  `ControlUiBridge::editingSchemeApplied()` says the editor applied the scheme (the editor does so synchronously when
  it is told, and again on its heartbeat), and the last step ends the job with the write envelope. Switching to
  openDyne makes the piano roll generate the notes of the clip it shows when none were ever generated
  (`PianoRollComponent::ensureOpenDyneNotesIfNeeded`); the job compares the clip's note topology flag before and after and
  reports `sideEffects.notesGenerated` with `SCHEME_GENERATED_NOTES` and `IRREVERSIBLE`, and marks the project as
  changed. If the editor has not applied the scheme within the limit (10 s, `controlSetPrefsApplyTimeoutForTesting()`
  in tests), the job takes its changes back, tells the editor again and fails with `INTERNAL`; a job that the registry
  destroys before it ended (the control API is stopping) takes them back as well. The restore goes preference by
  preference: only a preference that still holds the value the job wrote gets its previous value back. One that a
  later `prefsApply` job, still waiting, changed from that value is left to that job, whose own restore then writes the
  first job's previous value; so two jobs that time out one after the other leave the preferences as they were before
  both. Any other preference that changed while the job waited (another `prefs.set`, the preferences window) keeps its
  new value; the error's detail names it and `executed` is true. Otherwise `executed` is false: no half-applied set of
  preferences stays.
- **Everything else is applied at once** and returns the envelope.
- **Busy.** Like every write, `prefs.set` answers `BUSY` first (`modal_open` while the preferences window is open).

**audio.get / audio.set** work on the Standalone application's `juce::AudioDeviceManager`, which only the editor owns
(`ControlUiBridge::audioDevice()`), and repeat the steps of the audio settings page (`AudioDeviceSettingsContent` in
`StandalonePreferencePages.cpp`; the `audio-*` mirrors). Nothing but the manager and the device it opens is called.

- `audio.get` reports the running device (a device that is open and playing) and what the page offers: the device
  types, the output devices of the current type (after a scan, as the page's `refresh()`), and the sample rates, buffer
  sizes and output channel pairs of the open device (the Standalone application is configured for at most two output
  channels, so one pair). Without a running device the members of `device` other than `running` are null with
  `no_audio_device`; without an editor (`no_editor`) or without a device manager (`unavailable`) nothing is
  offered.
- `audio.set` replaces the given members of the setup and opens the device again, in the order the page's selectors
  work: the device type, the output device, then the sample rate, buffer size and output channel pair together (one
  reopen). The type and the output device are checked against the lists before anything changes; the values of the device
  are checked once the device that will run is open. A value that is not on offer is
  `INVALID_ARGUMENT(audio_setting_unavailable)`.
- **Rollback.** A step that fails to open the device puts the setup from before the whole call back (the device type
  first, then the setup, as the page does for one change) and the call fails with `IO_ERROR(device_open_failed)` and
  `executed` false. If the previous setup cannot be opened either, `executed` is true and no device runs
  (`audio.get` reports it). If no device ran before the call, none runs after a failed one. The ASIO restore of the
  system sample rate that the page makes before it closes an ASIO device for another type or output device is the
  bridge's `prepareAudioDeviceSwitch()`; when it cannot be verified the current device stays.
- Without an editor or a device manager `audio.set` answers `UNSUPPORTED(capability_missing)`. The revert recipe
  needs a device that ran before the call (a setup cannot be set to "no device"); without one the result says
  `IRREVERSIBLE`.

Tests: `Tests/Control/ControlPrefsTests.cpp` (`PrefsRoundTrip`, `PrefsSchemeJob`, `PrefsVectors`, `AudioDevice`,
`AudioVectors`). The audio tests never open, list or change a real device: the device manager has two fake device types
whose devices open or fail to open on request, and they run only with the test's `OPENTUNE_DATA_DIR`. `PrefsVectors`
runs `prefs/set-scheme-job` with the piano roll opened on the test bridge instead of sending the vector's first request,
`ui.setSelection`, whose test bridge is in `ControlSelectionTests.cpp`. Behaviour on a real device (listing, switching type and output, ASIO) cannot be
tested headless and is checked by hand on a real installation.

## Dirty flag and revision tokens

The dirty flag belongs to the editor's `ProjectSession`; without an editor it is false. Revision tokens
are described in "Request handling"; write results return them read back after the commit. The `notes` and
`pitch` components leave out the steps of pitch shifts ("Note edits and the pitch shift").

## Mirrors

Some of what the UI does is written in UI classes that the API must not change (the piano roll, the editor,
the processor's export functions). The API repeats those steps in `Source/Control/**` and calls only the
lower-level functions that exist. The repeated code is a **mirror**; the upstream function it follows is
*mirrored*. A change of that function upstream, without the same change here, makes the API differ from the
UI without any test noticing. So every mirror is registered:

- `mirror-map.json` (the source of truth) lists, for each mirrored upstream function or constant, its file and
  symbol, the hash of its normalised text, the Control files and symbols that follow it, the tests that cover
  it, and a one-line note.
- `MIRRORS.md` is the same information for people: change X upstream, bring Y in line, run Z, record the
  new hash. Its table is generated from `mirror-map.json`.
- `Tests/Control/ControlMirrorDriftTests.cpp` hashes the same text in the source tree and fails when a hash
  differs, printing the function you changed, the file to bring in line, the tests to run and the command
  that records the new hash (`--update`). It also fails when `MIRRORS.md` differs from `mirror-map.json`,
  when a Control file, symbol or test named there does not exist, and (self-test) if a change inside a mirrored
  function would not turn the check red. It is registered as `ControlMirrorDriftTests`, so `ctest -R Control`
  runs it.

When you add code that repeats the steps of an upstream function, register it in the same change ("Adding a
mirror" in `MIRRORS.md`) and name the upstream function in a comment of the mirrored code.

## Adding a method

1. Find the method's schema in `Tests/Control/spec/otcp/v1/methods/<method>.schema.json`: params,
   result, `x-otcp` (capability, `write`, `mainThread`, error kinds).
2. Write the operation in the `Ops/<Group>Ops.*` file of its domain (one file per group, see the method
   table): a params struct with a parse function that checks the closed params schema with
   `ControlParamReader` (connection thread, no OpenTune state), and a run function that gets a
   `ControlOpContext` on the message thread and returns `Result<JsonValue>`. Reach the processor and the
   bridge only through the context. Return errors with `controlOpError(kind, reason, detail)`; `detail`
   is printable ASCII and never contains secrets or text from files or projects. Note in a comment which
   upstream function the operation calls and why. If the operation repeats the steps of an upstream
   function instead of calling it, register that function in `mirror-map.json` (see "Mirrors").
3. Register it with `controlReadMethod<Params>(name, parse, run)`, `controlWriteMethod<Params>` for a
   write (see "Write results") or `controlJobMethod<Params>` for a method that works with the jobs
   registry and never waits for the message thread, in the group's `register<Group>Ops()`. A read whose
   schema says `mainThread: false` and that needs no jobs registry is registered with
   `controlOffMainThreadReadMethod<Params>(name, parse, run)`, whose run gets `const ControlInstanceFacts&`
   instead of a context and runs on the connection thread: it must not read or write content, the
   processor or the bridge (it has no way to reach them), may call only OpenTune functions documented as
   thread-safe, and must return within a fixed bound. `ControlProcessorTests.OffMainThread` checks that
   every registered method's `mainThread` matches its schema. A new group gets its line in
   `registerControlMethods()` (`Ops/OpsRegistry.cpp`), where the groups of later parts already have a
   placeholder line. The capability of a registered method is reported by `session.hello` and
   `session.info`.
4. Add the files to `cmake/OpenTuneControl.cmake` in the part's block.
5. Test it in `Tests/Control/` (a scenario of `OpenTuneControlProcessorTests`, one process per scenario)
   and add it to the methods whose vectors `ControlProcessorTests.Vectors` runs.
6. Add a row to the method table below.

## Tests

`Tests/Control/ControlUnitTests.cpp` tests the channel, the handles, the tokens and the cursors with the
standard library only.
`Tests/Control/ControlProcessorTests.cpp` runs the real Standalone processor without a window or an audio
device: one process per scenario, each with its own `OPENTUNE_DATA_DIR`, the lifecycle scenarios under
the upstream `Tests/LifecycleWatchdog.h`. Its target copies the SharedCode's compile definitions and
include directories, because `PluginProcessor.h` changes its class layout with them, and pumps messages
with `juce::detail::dispatchNextMessageOnSystemQueue` rather than `runDispatchLoop()`, whose stop latches
for the rest of the process in JUCE 9.0.3. Run them with `ctest -R Control`.

A request of a scenario (`ApiSession::request`) waits `kReadTimeoutMs` for the line with its own id. One
without a response in time fails the scenario with the longest single message dispatch on the message thread
meanwhile and the open modal windows, which tell a message thread kept busy by another message from a slow
method; its response, if it comes later, is discarded with a note on how late it was, so later requests read
their own responses. Without the models (as on the build machines) the render that an import requests fails,
and upstream `ProcessRenderRuntime::notifyApplicationRenderFailure()` builds a diagnostic dialog on the message
thread; a scenario whose first requests must not race with that calls `settleBackgroundWork()` after its
setup (render work idle, then the messages posted until then dispatched).

Every scenario process has a watchdog that ends it with a failure naming the scenario a margin before its own
ctest `TIMEOUT`, so that a scenario blocked in a wait without a bound fails with a message instead of being
killed by ctest without one. The rule: `cmake/OpenTuneControl.cmake` passes each scenario test's `TIMEOUT` to
its process as `OPENTUNE_SCENARIO_TIMEOUT_SEC` (one loop after every `TIMEOUT` of the scenarios is set, so a
scenario given a longer `TIMEOUT` gets a longer watchdog without anything else to change), and the watchdog
fires `kScenarioBoundMarginMs` (5 s) before it; a process started without the variable uses 55 s.

`startedProcessor()` takes one owner of the process-wide `ProcessRenderRuntime` for the rest of the process
before it constructs the first processor. The runtime would otherwise shut down at every processor's
destruction and start again with the next one, and that shutdown can miss the control worker's notification
(it is sent without the waiter's mutex) and never return. As a consequence, the destruction times that the
lifecycle scenarios measure no longer include the runtime's shutdown. The scenarios that construct a processor
without the API (`Disabled` and the others in `ControlProcessorTests.cpp`) do not take that owner: starting the
runtime initialises the logger, and they check that nothing was initialised.

`Tests/Control/ControlMirrorDriftTests.cpp` (standard library and the JSON reader only) compares the hashes of
`mirror-map.json` with the source tree; see "Mirrors". `ControlMirrorDriftTests` is its ctest name.

`Tests/Control/ControlDispatcherTests.cpp` holds the scenarios of the dispatcher and the read methods. Its
contents get a pitch analysis made of synthetic F0, committed the way OpenTune commits a finished
analysis, so no model is needed. `Reads` covers the methods with and without an editor bridge, pagination
and cursors, every analysis state, the errors and a reopened project; `ThreadProbe` the message-thread
check; `DispatchShutdown` and `DispatchTimeout` a request that waits for the message thread when the
service stops or its dispatch timeout passes; `Details` covers `content.getDetails` (time grid, reference
binding, AUTO modes, analysis failures), `transport.get`, `prefs.get` and `app.getLog` including the
redaction of a log with the session token, the server proof and the home directory planted in it;
`Completeness` checks that every method of every reported capability is registered (an exemption list
exists and must be empty before dev is merged; `read.v1` may never be on it); `Vectors` runs the
specification's vectors of the implemented methods against the real dispatcher and requires every vector of
an explicit list (`kMustRunVectors`) to run and pass, instead of counting; the others are listed as
skipped, with the reason. `OffMainThread` checks that each registered method runs on or off the message
thread as its schema's `mainThread` says, and that `app.getLog` answers while the message thread is held
(no `TIMEOUT`, nothing queued for the message thread). `ControlUnitTests` also tests the log redaction and
the log tail on files.

`Tests/Control/ControlJobTests.cpp` holds the scenarios of the jobs, the write envelope and the import.
Imported clips get their synthetic analysis through the import's test seam
(`controlSetImportAnalysisForTesting`). `Jobs` covers `job.get` without the message thread, the long poll
while the session sends other requests, cancellation in every state, retention with injected wall and
monotonic clocks, `stop()` from a nested message loop inside a step, and `executed`; `JobShutdown`
destroys the processor while a `job.get` waits for a job whose work owns a thread; `WriteEnvelope` the
four states, the no-op rules, `IRREVERSIBLE`, the UI snapshot, the busy checks and the environment of a
job's steps; `Import` both editing schemes, all layouts, focus and note generation (with `focus: false` leaving the
selection as it was, also on the active track and its selected clip),
revealed tracks, item failures, the checks before the job, busy, idempotency and commits without a copy
of the audio; `ImportAfterOpen` the import after a project was opened and when its commit copies the
audio; `ImportCancel` a cancellation after the first of three commits while the UI is busy;
`JobVectors` the specification's vectors of `job/` and `import/`.

`Tests/Control/ControlExportTests.cpp` holds the scenarios of `export.start`. Without a vocoder model
OpenTune cannot render, so the scenarios drive the render cache of a content themselves while OpenTune's
render worker is paused (`pauseRenderWorker`): they publish its blocks as a finished render would, or
fail them as a failing vocoder would, through the cache's public functions. `Export` covers a clip, a
track and the master mix (format, duration, timeline start, revisions, dry contents), `ifExists`, the
checks before the job (paths, loaded media by identity: other letter case, a hard link), the name that
`rename` uses being loaded media, the export lock held by the UI, the busy checks of other writes and a
second export while one waits, and cancellation; `ExportFailures` `ANALYSIS_FAILED` (and `allowDry`),
`RENDER_FAILED` after the retry, `REVISION_CONFLICT` while OpenTune writes the file (the writer waits for
the paused render worker while the clip's notes change), `NOT_READY` with a short wait limit
(`controlSetExportWaitLimitForTesting`), a deleted clip, and the identity and rename functions;
`ExportVectors` the specification's vectors of `export/` (an explicit list must pass; the vector of a
directory whose files' identity cannot be read is skipped, because on Windows that identity stays
readable through the rights of the parent directories).

`Tests/Control/ControlEditTests.cpp` holds the scenarios of the undo history, the key, AUTO, the note edits and the
pitch shift, with a test bridge for the dirty flag and the selection; entries the user would make in the UI are pushed
as the UI pushes them (the upstream actions, unwrapped). `Undo` covers undo and redo of an API entry back to the exact
states (also with OpenTune's own `UndoManager::undo()`, as the UI's Ctrl+Z), `top_mismatch` with the user's edit left
intact, `force` and the undoIds of UI entries, the redo through the revert recipe, changes without an undo entry
(`UNDO_NO_EFFECT`, the cleared redo history, the later key kept), a full history whose entries moved (the undoId of a UI
entry is no longer confirmed), a clip split on top and a project opened since; `SetKey` the key aspect only, the revert
recipe round trip, `key_changed`, the no-op, the UI's scale and the readiness gate; `AutoTune` the hand-computed removed
and dropped notes, created notes inside the range and in key, several ranges as one step, `dryRun` (its `sideEffects`
equal those of the commit, for `regenerate` and `notesOnly`), the params defaults and the checks before the change (also
`clipKey` on a content without a key: `INVALID_ARGUMENT(content_key_unset)`); `EditNotes` a table of hand-computed ops
(every op, selections by index, range and all, several ops in one call, an exact tie of the snap, `targetMidi` 0 and the
ops on a note without a base pitch), each checked for its prediction equal to its commit, its tokens equal to a fresh
read, and undo and redo back to the exact states, through the API and through OpenTune's own `UndoManager`; then the
checks before the change, the no-ops and the params, values on a rounding boundary whose `after` equals the value read
back byte for byte, and commits that store other notes than the prediction (notes stored out of start-time order, for
the ops and for SNAP; a note without duration, which the commit drops, answered with `INTERNAL` and `executed` true);
`EditMultiNoteRender`, a scenario of its own for its render time, on a clip of sine bursts with one render block per
note, that edits of several notes (one op over all, one op per note, AUTO regenerate, a shift after it, SNAP) leave
every block of an edited note pending right after the commit and that the render and an export of the clip hold every
burst at its new target (through the light pitch path, so without models); the undo descriptions of every edit are the
UI's texts in clean UTF-8; `SetPitchShift` that `revision` stays while the `pitchShift` component changes (also after
the undo, the redo, the user's Ctrl+Z and a shift in the UI's dialog), `KEY_NOT_TRANSPOSED`, the no-ops, the exact state
after the undo, the undo of a shift after `notesOnly` (the shift goes back, the generated notes stay), an undo and a
redo of such a shift that have nothing to set (`UNDO_NO_EFFECT`), a `content.getNotes` and a `content.getPitchCurve`
cursor made stale by a shift and by its undo (with the curve's second page two semitones up after the shift), a pitch
shift and a `content.shiftTiming` of one content as separate aspects (each changes only its own component, each undo
takes back only its own), and the ledger starting a content over when its counters go back; `SnapNotes` the
hand-computed SNAP of every note, ranges as selections, one undo step for several ranges, the no-op of a second SNAP
over corrected notes, `clipKey`, and a note without a base pitch; `EditCapability` that `edit.v1` is reported with its
four methods; `EditVectors` the specification's vectors of `edit/`, `content/set-key-*`, `content/auto-tune-*`,
`content/edit-notes-*` and `content/set-pitch-shift-*` (`given.history` is established with the same actions, a running
export of `given.jobs` holds the export lock; vectors of later parts are listed as skipped, with the reason). The shared
contents with synthetic F0 are in `ControlContentFixtures.h`, defined in `ControlDispatcherTests.cpp`.

`Tests/Control/ControlTimingTests.cpp` holds the scenarios of the time grid, on contents with synthetic F0 whose
grids are applied as OpenTune's content owner applies one. `Timing` runs a table of `content.shiftTiming` and
`moveHandles` writes with hand-computed handle positions (a handle and a section moved freely, up to a
neighbour, up to ClipStart and ClipEnd, a content range, several moves the same way and across each other), each
checked against its result (changes, `clamped`, `CLAMPED`, one undo entry, only the grid aspect, `reRenderQueued`,
dirty, the editor's notification, tokens equal to a fresh read, `revision` unchanged) and undone back to the exact
grid before; OpenTune's own undo and redo; `grid_changed`, `grid_not_seeded`, `duplicate_handle`,
`unknown_handle` (also for an end point), no-ops, `dryRun`, a handle without room, the readiness gate, busy, a stale
handle and the params. `TimeGridSeed` seeds from a timing analysis with known onsets (hand-computed handles), from
OpenTune's own analysis (the same handles as `ensureTimeToolAnchorSeed()` gives the UI for that analysis), leaves a
seeded grid alone, and covers cancellation and the failures of the job's checks (content removed, a dialog opened,
the pitch analysis running again, an analysis that failed or found no onset), which write no handle.
`TimingVectors` runs the specification's vectors `content/shift-timing-*` and `content/edit-time-grid-*`.
`ControlExportTests.cpp` (`ExportTimeStretch`) exports a clip with a stretched grid while its time-stretch rebuild
is held back (the job waits and writes nothing), one whose rebuild nothing had queued (the job queues it), and one
whose rebuild the render worker drops (the job asks again); the files hold the stretched render, not silence. It
also covers a job whose every rebuild is dropped (`NOT_READY(export_stretch_dropped)` after
`kControlExportMaxStretchRequests` requests) and contents to export dry with a stretched grid and no render (a failed
analysis with `allowDry`, an unvoiced one: `NOT_READY(export_dry_stretched)`), which end at once without a file.

`Tests/Control/ControlTracksTests.cpp` holds the scenarios of the transport and the tracks, with a test bridge that
follows the editor in the number of shown tracks and the notifications, and a fake audio device in a real
`juce::AudioDeviceManager` (running, or none open). `Transport` runs every `transport.control` action and the
play-from-start rules, the no-ops, `NO_AUDIO_DEVICE`, the tempo (with its revert recipe sent unchanged), the loop flag,
the params, busy, and the answer without an editor. `Tracks` runs `track.set` (values, `CLAMPED`, solo and `audible`,
the colour, the revert recipe, hidden tracks, the checks), `track.add` (the limit), `track.duplicate` (both modes, the
mix and reference binding copied, `target_track_occupied`, `track_limit`), `track.delete` (the checks in order,
`trackIdMap`, the removed clip and content, a content that another clip still shows, the dangling reference binding,
the mix that moves down, a hidden track's mix and clip that stay) and the three methods that need the editor without
one. `TrackBarrier` runs the barrier of a track deletion with undo entries of the API that address tracks (OpenTune's
`MultiMovePlacementAction` in a `ControlOriginAction`), entries of the UI, `force` and its confirmation, the second
deletion (the entry's clip was followed down by the first), a clip move across tracks followed by two deletions (the
second removes the slot the action is keyed by, which the followed positions no longer name), the same move undone and redone with `force` between deletions (the merged slots keep `followed` covering the clip), an entry that addresses a
hidden track (not stale), and a note edit whose content left the project (`UNDO_NO_EFFECT`). `TrackVectors` runs the
specification's `transport/*` and `track/*` vectors and the six `edit/` vectors that need a deletion's barrier
(`given.history` with clip moves is established with the same actions); `track/delete-arrangement-changed` needs
`arrangement.edit` and runs in `ArrangementVectors`.

`Tests/Control/ControlArrangementTests.cpp` holds the scenarios of the arrangement methods, with the test bridge (shown
tracks, busy flags, dirty flag, notifications). `Arrangement` runs every op of `arrangement.edit`: moves (overlap, a
hidden track, a no-op), trims (both edges, the refusals, `FADES_RECLAMPED`), gain and fades (`CLAMPED`), reference
bindings (the refusals, a move earlier in the call), several ops in one undo entry, a failing later op that changes
nothing, `dryRun`, the order of the checks, an unrelated change that keeps the revision, the params, split (the
refusals, `SPLIT_SNAPPED`) with its revert recipe and the merge's, the merge refusals, and delete (`confirm`, the
removed contents, a binding that goes with the clip, the refused undo). `ArrangementUndo` undoes and redoes a trim that
shortened the fades, undoes a call of several ops and a binding, and checks the refused undo of a split and its revert
recipe. `ArrangementCopy` runs both modes (gain, fades and binding copied, the revert recipe sent with consent, a hidden
track, several sources), the tokens and the checks. `ArrangementVectors` runs every `arrangement/*` vector and
`track/delete-arrangement-changed`; all of them must pass.

`Tests/Control/ControlUiTests.cpp` holds the scenarios of `ui.getState` and `ui.dismiss`, against the dialogs and the
onboarding overlay of `TestUiBridge`. `UiState` checks the capabilities (`ui.onboardingClose` right after `ui.bridge`,
every method of `ui.bridge` registered, `UNSUPPORTED` without an editor), the busy flags, the dialog stack from the bottom without file choosers, the onboarding, the UI
snapshot, the scale and a bridge without dialogs. `UiDismiss` closes view-state dialogs (`not_persisted_state`), a
track colour without and with `confirm` (the colour, `dialogCommitted`, `DIALOG_CLOSE_COMMITTED`, the revert recipe,
dirty, an unchanged colour), a stack with a file chooser on top or in the middle, a dialog that opens another or will
not close, prevents and closes the onboarding (with the dialogs above it), the no-ops, busy and the params.
`UiOnboardingWithheld` runs an instance without `ui.onboardingClose`. `UiVectors` runs the specification's `ui/*`
vectors; a fixed list of them must pass, and those of `ui.setSelection` run in `SelectionVectors` (see "Selection").

`Tests/Control/ControlReferenceTests.cpp` holds the scenarios of the reference alignment. The alignment data of the reference
clip is given to its content as the processor stores a finished analysis, with notes two semitones above the target's;
the target's own analysis runs through OpenTune's service. `Reference` runs the analysis job, the alignment (hand-checked
pitches, the write envelope, one undo step, undo and redo, dirty) and the no-op of a second alignment; `ReferenceAnalysisLimit`
shows the wait limit with a reference analysis that never finishes, the one job per placement, cancellation, the
failures the jobs find when they check again (binding removed, analysis running again, clip deleted, a dialog opened,
the notes or the key changed while the job waited, all without a change), the checks of the call, and the upstream
service that completes one analysis per session;
`ReferenceVectors` runs the vectors `content/analyze-reference-*`, `content/auto-tune-reference*`,
`content/auto-tune-placement-content-mismatch` and `content/get-details-reference-binding` (the refusal without `reference.v1`
runs against the facts of an instance without it).

## Capabilities and protocol versions

The instance serves protocol 1.0 (`kControlProtocolVersion`). The capabilities it reports come from the
method table: `session.v1` always, and the capability of every registered method (now `read.v1`,
`jobs.v1`, `import.v1`, `export.v1`, `ui.bridge` with `ui.onboardingClose`, `edit.v1`, `history.v1`, `timing.v1`, `transport.v1`, `arrangement.v1`, `reference.v1`, `tracks.v1`, `project.io`, `prefs.write` and `audio.device`). The listener answers a method of an unreported capability itself with
`UNSUPPORTED(capability_missing)`; the dispatcher answers the same for a method of a reported capability
that is not registered yet. PROTOCOL.md section 3.3 rule 5 case 10 expects an instance to implement every
method of a capability it reports: `read.v1` is complete (all eight reads are registered), and
`ControlProcessorTests.Completeness` fails when a reported capability has a method that is not registered.

A capability of which only some methods are registered is not reported (`controlCapabilityIsIncomplete`); its
methods are refused by the listener until the last one is registered, and the headless tests report it with the
test seam `controlSetReportIncompleteCapabilitiesForTesting()` to run them. `edit.v1` is reported since all four of
its methods are registered, and `ui.bridge` since `ui.setSelection` joined `ui.getState` and `ui.dismiss`; none is
incomplete now (`controlSetWithheldCapabilitiesForTesting()` leaves a reported capability out, for the vectors'
precondition `withoutCapabilities`). The mechanism stays for the method
groups that are still placeholder lines in `registerControlMethods()`, whose capabilities may be registered in more
than one step.

## Method table

| Method | Capability | Ops file | Tests | Schema |
|---|---|---|---|---|
| `session.hello` | `session.v1` | answered by `ControlServer` | `ControlUnitTests` | `methods/session.hello.schema.json` |
| `session.info` | `session.v1` | `Ops/SessionOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/session.info.schema.json` |
| `project.get` | `read.v1` | `Ops/ProjectReadOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/project.get.schema.json` |
| `content.getNotes` | `read.v1` | `Ops/ContentReadOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/content.getNotes.schema.json` |
| `content.getPitchCurve` | `read.v1` | `Ops/ContentReadOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/content.getPitchCurve.schema.json` |
| `content.segmentNotes` | `read.v1` | `Ops/ContentReadOps.cpp` | `ControlProcessorTests.Reads`, `.Vectors` | `methods/content.segmentNotes.schema.json` |
| `content.getDetails` | `read.v1` | `Ops/ContentDetailsOps.cpp` | `ControlProcessorTests.Details`, `.Vectors` | `methods/content.getDetails.schema.json` |
| `transport.get` | `read.v1` | `Ops/ProjectReadOps.cpp` | `ControlProcessorTests.Details`, `.Vectors` | `methods/transport.get.schema.json` |
| `prefs.get` | `read.v1` | `Ops/AppReadOps.cpp` | `ControlProcessorTests.Details`, `.Vectors` | `methods/prefs.get.schema.json` |
| `app.getLog` | `read.v1` | `Ops/AppReadOps.cpp` (tail and redaction in `ControlLogTail.cpp`; off the message thread) | `ControlProcessorTests.Details`, `.OffMainThread`, `ControlUnitTests` | `methods/app.getLog.schema.json` |
| `job.get` | `jobs.v1` | `Ops/JobOps.cpp` | `ControlProcessorTests.Jobs`, `.JobShutdown`, `.JobVectors` | `methods/job.get.schema.json` |
| `job.cancel` | `jobs.v1` | `Ops/JobOps.cpp` | `ControlProcessorTests.Jobs`, `.ImportCancel`, `.JobVectors` | `methods/job.cancel.schema.json` |
| `import.start` | `import.v1` | `Ops/ImportOps.cpp` | `ControlProcessorTests.Import`, `.ImportAfterOpen`, `.ImportCancel`, `.JobVectors` | `methods/import.start.schema.json` |
| `export.start` | `export.v1` | `Ops/ExportOps.cpp` (identity and rename in `ControlFileIdentity.cpp`) | `ControlProcessorTests.Export`, `.ExportFailures`, `.ExportVectors`, `.ExportTimeStretch` | `methods/export.start.schema.json` |
| `ui.getState` | `ui.bridge` | `Ops/UiOps.cpp` (editor side in `../Standalone/ControlEditorBridgeModals.cpp`) | `ControlProcessorTests.UiState`, `.UiVectors` | `methods/ui.getState.schema.json` |
| `ui.dismiss` | `ui.bridge`; closing a showing overlay also `ui.onboardingClose` | `Ops/UiOps.cpp` (editor side in `../Standalone/ControlEditorBridgeModals.cpp`) | `ControlProcessorTests.UiDismiss`, `.UiOnboardingWithheld`, `.UiVectors` | `methods/ui.dismiss.schema.json` |
| `ui.setSelection` | `ui.bridge` | `Ops/SelectionOps.cpp` (editor side in `../Standalone/ControlEditorBridgeSelection.cpp`, hook in `../Standalone/UI/ArrangementViewComponent.*`) | `ControlProcessorTests.Selection`, `.SelectionMatrix`, `.SelectionVectors` | `methods/ui.setSelection.schema.json` |
| `edit.getHistory` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.EditVectors` | `methods/edit.getHistory.schema.json` |
| `edit.undo` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.AutoTune`, `.EditVectors` | `methods/edit.undo.schema.json` |
| `edit.redo` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.EditVectors` | `methods/edit.redo.schema.json` |
| `content.setKey` | `edit.v1` | `Ops/ContentTuneOps.cpp` | `ControlProcessorTests.SetKey`, `.Undo`, `.EditVectors` | `methods/content.setKey.schema.json` |
| `content.autoTune` (modes `regenerate`, `snapNotes`, `notesOnly`, `reference`) | `edit.v1` (`reference.v1` for mode `reference`) | `Ops/ContentTuneOps.cpp` (undo entries in `Edit/ContentEditTransaction.cpp`, SNAP in `Edit/NoteCorrection.cpp`; mode `reference` in `Ops/ReferenceOps.cpp`, `Edit/ReferenceAlignment.cpp`) | `ControlProcessorTests.AutoTune`, `.SnapNotes`, `.Undo`, `.EditVectors`, `.Reference`, `.ReferenceVectors` | `methods/content.autoTune.schema.json` |
| `content.editNotes` | `edit.v1` | `Ops/ContentEditOps.cpp` (correction rebuild in `Edit/NoteCorrection.cpp`) | `ControlProcessorTests.EditNotes`, `.EditVectors` | `methods/content.editNotes.schema.json` |
| `content.setPitchShift` | `edit.v1` | `Ops/ContentEditOps.cpp` (tokens: `Edit/PitchShiftLedger.cpp`) | `ControlProcessorTests.SetPitchShift`, `.EditVectors` | `methods/content.setPitchShift.schema.json` |
| `content.shiftTiming` | `timing.v1` | `Ops/TimingOps.cpp` (moves in `Edit/TimeGridOps.cpp`) | `ControlProcessorTests.Timing`, `.TimingVectors` | `methods/content.shiftTiming.schema.json` |
| `content.editTimeGrid` (ops `seed`, `moveHandles`) | `timing.v1` | `Ops/TimingOps.cpp` (moves in `Edit/TimeGridOps.cpp`) | `ControlProcessorTests.Timing`, `.TimeGridSeed`, `.TimingVectors` | `methods/content.editTimeGrid.schema.json` |
| `content.analyzeReference` | `reference.v1` | `Ops/ReferenceOps.cpp` | `ControlProcessorTests.Reference`, `.ReferenceAnalysisLimit`, `.ReferenceVectors` | `methods/content.analyzeReference.schema.json` |
| `project.save` | `project.io` | `Ops/ProjectOps.cpp` | `ControlProcessorTests.ProjectRoundTrip`, `.ProjectJobs`, `.ProjectVectors` | `methods/project.save.schema.json` |
| `project.saveAs` | `project.io` | `Ops/ProjectOps.cpp` | `ControlProcessorTests.ProjectRoundTrip`, `.ProjectJobs`, `.ProjectVectors` | `methods/project.saveAs.schema.json` |
| `project.open` | `project.io` | `Ops/ProjectOps.cpp` | `ControlProcessorTests.ProjectRoundTrip`, `.ProjectJobs`, `.ProjectVectors` | `methods/project.open.schema.json` |
| `project.clearRecent` | `project.io` | `Ops/ProjectOps.cpp` | `ControlProcessorTests.ProjectRoundTrip`, `.ProjectJobs`, `.ProjectVectors`, `.ProjectWithoutEditor` | `methods/project.clearRecent.schema.json` |
| `prefs.set` | `prefs.write` | `Ops/PrefsOps.cpp` (a job of kind `prefsApply` for a change of the editing scheme) | `ControlProcessorTests.PrefsRoundTrip`, `.PrefsSchemeJob`, `.PrefsVectors` | `methods/prefs.set.schema.json` |
| `audio.get` | `audio.device` | `Ops/AudioDeviceOps.cpp` | `ControlProcessorTests.AudioDevice`, `.AudioVectors` | `methods/audio.get.schema.json` |
| `audio.set` | `audio.device` | `Ops/AudioDeviceOps.cpp` | `ControlProcessorTests.AudioDevice`, `.AudioVectors` | `methods/audio.set.schema.json` |
| `transport.control` | `transport.v1` | `Ops/TransportOps.cpp` | `ControlProcessorTests.Transport`, `.TrackVectors` | `methods/transport.control.schema.json` |
| `transport.setTempo` | `transport.v1` | `Ops/TransportOps.cpp` | `ControlProcessorTests.Transport`, `.TrackVectors` | `methods/transport.setTempo.schema.json` |
| `transport.setLoop` | `transport.v1` | `Ops/TransportOps.cpp` | `ControlProcessorTests.Transport`, `.TrackVectors` | `methods/transport.setLoop.schema.json` |
| `arrangement.edit` (ops `move`, `trim`, `setGain`, `setFade`, `split`, `merge`, `delete`, `setReference`) | `arrangement.v1` | `Ops/ArrangementOps.cpp` | `ControlProcessorTests.Arrangement`, `.ArrangementUndo`, `.ArrangementVectors` | `methods/arrangement.edit.schema.json` |
| `arrangement.copy` (modes `window`, `full`) | `arrangement.v1` | `Ops/ArrangementOps.cpp` | `ControlProcessorTests.ArrangementCopy`, `.ArrangementVectors` | `methods/arrangement.copy.schema.json` |
| `track.set` | `tracks.v1` | `Ops/TrackOps.cpp` | `ControlProcessorTests.Tracks`, `.TrackVectors` | `methods/track.set.schema.json` |
| `track.add` | `tracks.v1` | `Ops/TrackOps.cpp` | `ControlProcessorTests.Tracks`, `.TrackVectors` | `methods/track.add.schema.json` |
| `track.duplicate` | `tracks.v1` | `Ops/TrackOps.cpp` | `ControlProcessorTests.Tracks`, `.TrackVectors` | `methods/track.duplicate.schema.json` |
| `track.delete` | `tracks.v1` | `Ops/TrackOps.cpp` (barrier in `Edit/ControlOriginAction.cpp`) | `ControlProcessorTests.Tracks`, `.TrackBarrier`, `.TrackVectors` | `methods/track.delete.schema.json` |
