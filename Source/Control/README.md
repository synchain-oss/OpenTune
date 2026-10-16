<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OpenTune control API (OTCP v1)

> **概述（中文）**：本目录是 OpenTune Standalone 的本机控制接口（OTCP v1）。它只监听 `127.0.0.1`，编译期由 CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`（默认 OFF）控制，运行期默认关闭，只有设置 `OPENTUNE_CONTROL_API=1` 或传入 `--control-api` 才会启动。接口关闭时 OpenTune 的行为与没有本目录时完全相同。对上游已有文件的改动只有下文「Hooks」一节列出的几处接入钩子，每处都带 `// OpenTune Control API hook:` 标记。本文件面向 OpenTune 的维护者及其 AI agent：文件地图、线程规则、生命周期、钩子清单、请求处理流程（dispatcher）、job 模式、写结果（写信封）的构建、撤销描述与还原、撤销历史（撤销识别、ControlOriginAction、没有撤销条目的写入）、ContentEditTransaction 与它镜像的上游函数、内容写入的就绪门、忙碌检查、编辑器 bridge、导入、导出（界面与接口共用的导出锁、逐内容的就绪判定、临时文件与最终改名）、如何新增方法与方法表；其余章节随后续实现补全。规范在 `Tests/Control/spec/otcp/v1/`。

This directory holds the local control API of OpenTune Standalone: a JSON-RPC protocol over a loopback
TCP connection (OTCP v1, specified in `Tests/Control/spec/otcp/v1/PROTOCOL.md`), with which another
program on the same machine, for example an assistant, can read and edit the open project the way the
UI does. It is compiled only with the CMake option `OPENTUNE_ENABLE_CONTROL_API` (default OFF) and runs
only when enabled at run time. With the option OFF, or ON but not enabled, OpenTune behaves exactly as
without this directory.

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
| `Ops/SessionOps.*`, `Ops/ProjectReadOps.*`, `Ops/ContentReadOps.*`, `Ops/ContentDetailsOps.*`, `Ops/AppReadOps.*`, `Ops/JobOps.*`, `Ops/ImportOps.*`, `Ops/ExportOps.*`, `Ops/UndoOps.*`, `Ops/ContentTuneOps.*` | The methods, one file per group (see "Method table"). |
| `Ops/EditSupport.*` | What the content edits and the undo steps share: params forms of tokens and keys, the readiness gate, the expected-token checks, note references, `reRenderQueued`, and the description of an undo step's effect from two snapshots. |
| `Edit/ControlOriginAction.*` | The undo entry of a change made through the API (upstream undo actions wrapped with an `undoId`), and `ControlHistory`: undoIds, the API's entries, the undoIds of UI entries, changes without an undo entry. |
| `Edit/ContentEditTransaction.*` | Undo entries built from snapshots around a commit of the content commands, as the piano roll builds them (see "ContentEditTransaction"). |
| `ControlFileIdentity.*` | File identity (volume and file id, `st_dev` and `st_ino`), "same file" by identity, and the final rename that never replaces (PROTOCOL.md sections 20.3 and 20.4); standard library and operating system only. |
| `Ops/OpsJson.*` | Wire forms that several reads share (key, pitch shift, language tag, editing scheme, the processing object of `session.info` and `prefs.get`). |
| `ControlLogTail.*` | The tail of the log file and the redaction of its lines for `app.getLog`; standard library only. |
| `../Standalone/ControlEditorBridge.*` | The editor's side of `ControlUiBridge`, a friend of the Standalone editor; compiled into the application wrapper only. |

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
| `Source/PluginProcessor.h` (the control block at the end of the class; 5 lines: one marker comment, `tryAcquireExportLock()`, `releaseExportLock()`, `isExportLockHeld()`, member `exportLockHeld_`) | The export lock that the editor's export and `export.start` share (an atomic flag; any thread) | One export at a time, whoever starts it: `export.start` and every other write answer `BUSY(export_in_progress)` while it is held, also without an editor. | The API could export while the UI exports (both write through `OpenTuneAudioProcessor::export*Audio` and its `lastExportError_`), and writes would not see an export of the other side. |
| `Source/Standalone/PluginEditor.cpp` (`exportAudioRequested`: 11 lines before `exportInProgress_` is set, 4 lines in the export thread before the result is posted) | The editor takes the lock when it starts its export thread, with its own "An export task is already in progress" message when the lock is taken, and releases it once the file is written | The UI and the API share the lock; the UI shows what it always shows when an export runs. | As above. |
| `Source/Utils/UndoManager.h` (public section; 8 lines: `#if`, marker, five inline functions, `#endif`) | `peekUndo()`, `peekRedo()`, `size()`, `cursor()` and `clearRedo()` | Reads the tops and the counts of OpenTune's history (`edit.getHistory`, the entry checks of `edit.undo` and `edit.redo`); `clearRedo()` discards the redo history after a change without an undo entry (PROTOCOL.md section 15.3 rule 9), as `addAction()` discards it. No data member, so the class layout is the same with the option OFF. | The API cannot tell which entry is on top, so it cannot refuse a step the client did not expect; a change without an undo entry leaves older redo steps that would write over it. |
| `Source/Standalone/PluginEditor.cpp` (`performUndoRedoAction`; 8 lines) | The steps after an undo or redo moved into `afterUndoRedo()` (a pure refactor: with the option OFF the function reads as upstream) | The editor bridge runs the same steps after an undo or redo applied through the API (`ControlUiBridge::onUndoRedoApplied()`): mark the project as changed, redraw the arrangement, refresh the reference context. | After an API undo the editor would not redraw or refresh until the next user action. |
| `Source/Standalone/PluginEditor.h` (the control block at the end of the class; 2 lines: marker and declaration) | Private `afterUndoRedo()`, reached by the friend `ControlEditorBridge` | As above. | As above. |

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
  them (changed tokens give `REVISION_CONFLICT(cursor_stale)`).

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
- **Changes without an undo entry** (`content.setKey`, `content.autoTune` mode `notesOnly`; section 15.3
  rule 9) are never taken back: `ControlHistory::onChangeWithoutEntry()` masks that aspect of that content
  in every entry the API recorded before (their undo then skips it) and clears the redo history with the
  hook's `clearRedo()`. UI entries are applied as OpenTune applies them.
- Track deletion barriers (`possiblyStale`, `UNDO_CONFLICT(stale_entry)`, `UNDO_ENTRY_POSSIBLY_STALE`)
  come with the track methods; until then no entry is possibly stale.

## ContentEditTransaction

A content edit through the API records its undo entry the way the piano roll does, without the piano roll
(`PianoRollComponent` stays untouched): `Edit/ContentEditTransaction.*` captures the notes and correction
segments before a commit of OpenTune's content commands, and after it keeps, for the affected frame range,
the notes and segments before and after, cut to the range, in a `PianoRollEditAction` with the UI's
description. Several commits of one call (the ranges of `content.autoTune`) are one `ControlOriginAction`,
so one call is one undo step. The actions use the processor's own `ContentEditCommands`, the instance the
piano roll uses.

The upstream functions it and the AUTO method follow (lines of the locked upstream base). A change of these
functions upstream needs the same change here; the drift guard over them is registered in a later part:

| Upstream function | Followed in |
|---|---|
| `PianoRollComponent::captureBeforeUndoSnapshot()` (`Source/Standalone/UI/PianoRollComponent.cpp:1182-1187`) | `ContentEditTransaction::captureBefore()` |
| `PianoRollComponent::recordUndoAction()` (`PianoRollComponent.cpp:1189-1267`) | `ContentEditTransaction::recordRange()`, `notesInRange()`, `segmentsInRange()` |
| `PianoRollComponent::applyAutoTuneToSelection()`, the openTune scheme (`PianoRollComponent.cpp:5288-5341`) | `content.autoTune` mode `regenerate` (`Ops/ContentTuneOps.cpp`): range resolution, capture, commit, undo range |
| `OpenTuneAudioProcessor::autoTuneContentRangeByContentKey()` and `commitAutoTuneGeneratedNotesByContentKey()` (`Source/PluginProcessor.cpp:5375-5493`) | the `dryRun` prediction of `regenerate` and the removed / dropped notes of its result |
| `OpenTuneAudioProcessor::generateNotesOnlyByContentKey()` (`PluginProcessor.cpp:5334-5373`) | the `dryRun` prediction of `notesOnly` |
| `OpenTuneAudioProcessorEditor::scaleChanged()` (`Source/Standalone/PluginEditor.cpp:3040-3078`) | `content.setKey`: the manual key, the no-op, the dirty flag |

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
an undo or redo (`afterUndoRedo()`), the view (workspace,
piano roll clip, selection, visible track count), the focus of an imported clip
(`applyPlacementSelectionContext`), revealing tracks, the note generation parameters of the piano roll,
the project session and its worker pool, and the audio device manager. Dialogs, tracks, project flows and
preferences follow in files of their own. The headless tests use `Tests/Control/TestUiBridge.h`.

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

- After a project was opened, OpenTune gives a new clip an id that a clip of the project may already
  use, and the commit fails; each failed attempt uses up that id, so the import fails once per id in
  use. The job repeats the commit, at most once per clip whose id OpenTune can still hand out, and logs
  it; the result carries no warning, because the protocol defines no warning code for it. The UI's
  import fails in this situation. The commit consumes the prepared audio, so an attempt that may be
  repeated commits a copy; the job copies only when a project was opened (the content epoch is not 0)
  and a clip has an id above the highest one the instance's imports received since, and it never repeats
  a failure that the clip id cannot have caused. Otherwise it commits once without a copy, as the UI.
- `commitPreparedImportAsPlacement()` selects every clip it commits and makes its track the active
  track, also with `focus: false`. The job does not undo that; the result's `ui` snapshot
  (`activeTrackId`, `selectedPlacementIds`) shows it. `focus` decides only whether the editor shows the
  last clip, and with it whether the openDyne scheme generates its notes.
- The editor does not mark the project as changed after its own import; the job does (section 15.5).

## Export

`export.start` (`Ops/ExportOps.cpp`, PROTOCOL.md section 19) writes a WAV file of a clip, a track or the
master mix with the processor functions of the editor's export (`exportAudioRequested` in
`Source/Standalone/PluginEditor.cpp`): `exportPlacementAudio`, `exportTrackAudio` and
`exportMasterMixAudio`, which wait for the render worker and write 44.1 kHz 32-bit float WAV, mono for a
clip or track and stereo for the master mix.

- Before the job, in this order: an export job that still runs with the same params (after defaults) is
  returned; handles; the busy state, with the export lock; the path's text (section 20.1) and its `.wav`
  extension; that the export holds a clip with audio (`INVALID_ARGUMENT` without a reason otherwise: the
  protocol has no reason for it, and OpenTune exports nothing then); the loaded media (below); that the
  target's directory exists (`IO_ERROR(write_failed)`); with `ifExists` `error`, that no file exists at the
  target (`ALREADY_EXISTS(target_exists)`). Then the job takes the export lock until it ends.
- Loaded media are the source files of every source OpenTune holds (`SourceStore`, active or retired,
  since an undo step can bring a retired one back). The target is compared with each by file identity
  (`ControlFileIdentity`, section 20.3), not by its spelling: the same file with other letter case, a
  hard link or a link is refused with `INVALID_ARGUMENT(target_is_loaded_media)`; an identity that cannot
  be determined is `IO_ERROR(read_failed)`. The job checks every name again right before its rename.
- While it waits, each tick of the job builds again what the file is made of (the clips whose content has
  a playback source with audio, as the processor's export functions choose them: for the master mix only
  the soloed tracks while one is soloed, otherwise the tracks that are not muted) and decides per content
  (section 19 rule 6): analysis not finished: wait; analysis failed with no voiced frame (`f0_empty`), no
  usable pitch, or no render block: export it uncorrected and list it in `dryContents` (`unvoiced`,
  `nothingToRender`); another failure of the analysis: `ANALYSIS_FAILED(f0_failed)`, or with `allowDry`
  uncorrected (`analysisFailed`); a failed render block: one more `requestFullContentRender()` (its
  reconcile retries a failed block of the same revision), then `RENDER_FAILED(render_chunk_failed)`;
  render work pending: wait; ready once the render cache is settled at its revision
  (`RenderCache::isCanonicalSettled`). A content whose render was never requested gets one request. After
  120 s: `NOT_READY(export_wait_timeout)`. A clip export whose clip is deleted meanwhile fails with
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

## Dirty flag and revision tokens

The dirty flag belongs to the editor's `ProjectSession`; without an editor it is false. Revision tokens
are described in "Request handling"; write results return them read back after the commit.

## Adding a method

1. Find the method's schema in `Tests/Control/spec/otcp/v1/methods/<method>.schema.json`: params,
   result, `x-otcp` (capability, `write`, `mainThread`, error kinds).
2. Write the operation in the `Ops/<Group>Ops.*` file of its domain (one file per group, see the method
   table): a params struct with a parse function that checks the closed params schema with
   `ControlParamReader` (connection thread, no OpenTune state), and a run function that gets a
   `ControlOpContext` on the message thread and returns `Result<JsonValue>`. Reach the processor and the
   bridge only through the context. Return errors with `controlOpError(kind, reason, detail)`; `detail`
   is printable ASCII and never contains secrets or text from files or projects. Note in a comment which
   upstream function the operation calls and why.
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
job's steps; `Import` both editing schemes, all layouts, focus and note generation,
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

`Tests/Control/ControlEditTests.cpp` holds the scenarios of the undo history, the key and AUTO, with a test
bridge for the dirty flag and the selection; entries the user would make in the UI are pushed as the UI
pushes them (the upstream actions, unwrapped). `Undo` covers undo and redo of an API entry back to the exact
states (also with OpenTune's own `UndoManager::undo()`, as the UI's Ctrl+Z), `top_mismatch` with the user's
edit left intact, `force` and the undoIds of UI entries, the redo through the revert recipe, changes without
an undo entry (`UNDO_NO_EFFECT`, the cleared redo history, the later key kept), a full history whose
entries moved (the undoId of a UI entry is no longer confirmed), a clip split on top and a project opened
since; `SetKey` the key aspect only, the revert recipe round trip, `key_changed`, the no-op, the UI's scale
and the readiness gate; `AutoTune` the hand-computed removed and dropped notes, created notes inside the
range and in key, several ranges as one step, `dryRun` (its `sideEffects` equal those of the commit, for
`regenerate` and `notesOnly`), the params defaults and the checks before the change (also `clipKey` on a
content without a key); `IncompleteCapability` that `edit.v1` is not reported yet; `EditVectors` the specification's
vectors of `edit/`, `content/set-key-*` and `content/auto-tune-*` (`given.history` is established with the
same actions; vectors of later parts are listed as skipped, with the reason). The shared contents with
synthetic F0 are in `ControlContentFixtures.h`, defined in `ControlDispatcherTests.cpp`.

## Capabilities and protocol versions

The instance serves protocol 1.0 (`kControlProtocolVersion`). The capabilities it reports come from the
method table: `session.v1` always, and the capability of every registered method (now `read.v1`,
`jobs.v1`, `import.v1`, `export.v1` and `history.v1`). The listener answers a method of an unreported capability itself with
`UNSUPPORTED(capability_missing)`; the dispatcher answers the same for a method of a reported capability
that is not registered yet. PROTOCOL.md section 3.3 rule 5 case 10 expects an instance to implement every
method of a capability it reports: `read.v1` is complete (all eight reads are registered), and
`ControlProcessorTests.Completeness` fails when a reported capability has a method that is not registered.

A capability of which only some methods are registered is not reported (`controlCapabilityIsIncomplete`):
now `edit.v1`, whose `content.setKey` and `content.autoTune` exist while `content.editNotes` and
`content.setPitchShift` follow. Its methods are refused by the listener until then; the headless tests
report it with the test seam `controlSetReportIncompleteCapabilitiesForTesting()` to run them.

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
| `export.start` | `export.v1` | `Ops/ExportOps.cpp` (identity and rename in `ControlFileIdentity.cpp`) | `ControlProcessorTests.Export`, `.ExportFailures`, `.ExportVectors` | `methods/export.start.schema.json` |
| `edit.getHistory` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.EditVectors` | `methods/edit.getHistory.schema.json` |
| `edit.undo` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.AutoTune`, `.EditVectors` | `methods/edit.undo.schema.json` |
| `edit.redo` | `history.v1` | `Ops/UndoOps.cpp` | `ControlProcessorTests.Undo`, `.EditVectors` | `methods/edit.redo.schema.json` |
| `content.setKey` | `edit.v1` (not reported yet) | `Ops/ContentTuneOps.cpp` | `ControlProcessorTests.SetKey`, `.Undo`, `.EditVectors` | `methods/content.setKey.schema.json` |
| `content.autoTune` (modes `regenerate`, `notesOnly`) | `edit.v1` (not reported yet) | `Ops/ContentTuneOps.cpp` (undo entries in `Edit/ContentEditTransaction.cpp`) | `ControlProcessorTests.AutoTune`, `.Undo`, `.EditVectors` | `methods/content.autoTune.schema.json` |
