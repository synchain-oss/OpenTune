<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OpenTune control API (OTCP v1)

> **概述（中文）**：本目录是 OpenTune Standalone 的本机控制接口（OTCP v1）。它只监听 `127.0.0.1`，编译期由 CMake 选项 `OPENTUNE_ENABLE_CONTROL_API`（默认 OFF）控制，运行期默认关闭，只有设置 `OPENTUNE_CONTROL_API=1` 或传入 `--control-api` 才会启动。接口关闭时 OpenTune 的行为与没有本目录时完全相同。对上游已有文件的改动只有下文「Hooks」一节列出的几处接入钩子，每处都带 `// OpenTune Control API hook:` 标记。本文件面向 OpenTune 的维护者及其 AI agent：文件地图、线程规则、生命周期、钩子清单、请求处理流程（dispatcher）、job 模式、写结果（写信封）的构建、撤销描述与还原、忙碌检查、如何新增方法与方法表；其余章节随后续实现补全。规范在 `Tests/Control/spec/otcp/v1/`。

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
| `Ops/SessionOps.*`, `Ops/ProjectReadOps.*`, `Ops/ContentReadOps.*`, `Ops/ContentDetailsOps.*`, `Ops/AppReadOps.*`, `Ops/JobOps.*` | The methods, one file per group (see "Method table"). |
| `Ops/OpsJson.*` | Wire forms that several reads share (key, pitch shift, language tag, editing scheme, the processing object of `session.info` and `prefs.get`). |
| `ControlLogTail.*` | The tail of the log file and the redaction of its lines for `app.getLog`; standard library only. |

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
  file) runs on a thread that the work owns and joins in its destructor; `ControlJobs::stop()` destroys
  every work on the message thread, so no such thread outlives the processor.
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
- A job created cancellable stays so until it ends, until its work calls `endCancellability()` (the
  point of no return of its kind, section 12.3), or until `job.cancel` requested cancellation. The work
  stops at its next step.
- Retention (section 12.4): terminal jobs stay at least 30 minutes after they finished; beyond 64 jobs
  the terminal job that finished first is evicted first; active jobs are never evicted.
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
   exactly the four states of section 14.2. A committed write without recorded changes and with an empty
   `revisionDiff` is `noOp` (undo reason `no_op`). A job's envelope may report only the contents it
   touched (`limitDiffToTouchedContents`), because the user can change other contents while the job runs.

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
  except view state (reason `not_persisted_state`, section 15.2 rule 6).

## Busy checks

`controlCheckBusy(context)` refuses a write with `BUSY` while the user is in the middle of something
(section 13.2), in this order: a mouse or pen gesture (`pointer_down`), a modal dialog (`modal_open`;
not for `ui.dismiss`), an import of the UI (`import_in_progress`), an export (`export_in_progress`), a
project save or open (`project_operation`). The bridge reports these from the editor's own flags. Without
an editor nothing is busy. Reads, `session.*` and `job.*` never call it. A job that commits in several
steps checks again before each commit and waits while the UI is busy. The editor's side of the bridge
(`Source/Standalone/ControlEditorBridge.*`) is not built yet; until it is, only the headless tests'
`TestUiBridge` reports these flags.

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

`Tests/Control/ControlJobTests.cpp` holds the scenarios of the jobs and the write envelope. `Jobs` covers
`job.get` without the message thread, the long poll while the session sends other requests, cancellation
in every state, retention with an injected clock and `executed`; `JobShutdown` destroys the processor while
a `job.get` waits for a job whose work owns a thread; `WriteEnvelope` the four states, `IRREVERSIBLE`, the
UI snapshot, the busy checks and the environment of a job's steps; `JobVectors` the specification's
vectors of `job/`.

## Capabilities and protocol versions

The instance serves protocol 1.0 (`kControlProtocolVersion`). The capabilities it reports come from the
method table: `session.v1` always, and the capability of every registered method (now `read.v1` and
`jobs.v1`). The listener answers a method of an unreported capability itself with
`UNSUPPORTED(capability_missing)`; the dispatcher answers the same for a method of a reported capability
that is not registered yet. PROTOCOL.md section 3.3 rule 5 case 10 expects an instance to implement every
method of a capability it reports: `read.v1` is complete (all eight reads are registered), and
`ControlProcessorTests.Completeness` fails when a reported capability has a method that is not registered.

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
| `job.cancel` | `jobs.v1` | `Ops/JobOps.cpp` | `ControlProcessorTests.Jobs`, `.JobVectors` | `methods/job.cancel.schema.json` |
