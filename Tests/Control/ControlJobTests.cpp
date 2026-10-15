// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of the jobs (job.get, job.cancel, retention, shutdown) and of the write envelope with the busy
// checks, against the real processor without a window or an audio device. Registered with the other
// processor scenarios in ControlProcessorTests.cpp.

#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Control/ControlDispatcher.h"
#include "Control/ControlJobs.h"
#include "Control/Ops/OpsRegistry.h"
#include "Control/Ops/WriteEnvelope.h"

#include <algorithm>
#include <set>
#include <vector>

namespace OpenTune {
namespace ControlTest {

namespace {

/** The longest hold of job.get, used where a job must end first. */
constexpr int kJobWaitMs = 30000;
/** A short hold of job.get, and the slack of its response time. */
constexpr int kShortWaitMs = 300;
constexpr int kWaitSlackMs = 1000;
/** Bound of a client exchange that includes a job of these tests. */
constexpr int kJobExchangeMs = 60000;
/** How often the thread of a work checks whether it should end. */
constexpr int kWorkerPollMs = 5;

// ---- Requests and results --------------------------------------------------------------------------

JsonValue json(const std::string& text)
{
    auto parsed = parseJson(text);
    CONTROL_CHECK(parsed.ok);
    return parsed.value;
}

std::string quoted(const std::string& text)
{
    std::string out;
    appendJsonQuoted(out, text);
    return out;
}

/** The job of jobId once it is terminal (job.get with the longest hold), or null. */
JsonValue waitJob(ApiSession& api, const std::string& jobId)
{
    const auto result = api.result("job.get", json(R"({"jobId":)" + quoted(jobId) + R"(,"waitMs":30000})"));
    return memberOf(result, "job");
}

std::vector<std::string> warningCodes(const JsonValue& result)
{
    std::vector<std::string> codes;
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        codes.push_back(memberOf(warnings.at(i), "code").text());
    return codes;
}

const JsonValue& errorKindOf(const JsonValue& errorObject)
{
    return memberOf(memberOf(errorObject, "data"), "kind");
}

const JsonValue& errorReasonOf(const JsonValue& errorObject)
{
    return memberOf(memberOf(errorObject, "data"), "reason");
}

/** A job of the fixture: runs until released, then succeeds; ends cancelled when cancellation was
    requested; counts its steps. */
struct FixtureJob
{
    std::atomic<bool> release{false};
    std::atomic<int> steps{0};
};

ControlJobWork fixtureWork(std::shared_ptr<FixtureJob> fixture)
{
    return [fixture](ControlJobStep& step) {
        ++fixture->steps;
        if (step.cancelRequested())
            step.cancel();
        else if (fixture->release.load())
            step.succeed(JsonValue::object());
    };
}

/** The work of a job that owns a thread, as work that decodes a file does: its destructor ends and joins
    the thread. Counts its steps and records its destruction. */
struct ThreadedJob
{
    std::atomic<int> steps{0};
    std::atomic<bool> destroyed{false};
    std::atomic<bool> threadRunning{false};
};

ControlJobWork threadedWork(std::shared_ptr<ThreadedJob> record)
{
    struct Owner
    {
        explicit Owner(std::shared_ptr<ThreadedJob> recordIn) : record(std::move(recordIn))
        {
            thread = std::thread([this] {
                record->threadRunning = true;
                while (!stop.load())
                    sleepMs(kWorkerPollMs);
                record->threadRunning = false;
            });
        }
        ~Owner()
        {
            stop = true;
            thread.join();
            record->destroyed = true;
        }
        std::shared_ptr<ThreadedJob> record;
        std::atomic<bool> stop{false};
        std::thread thread;
    };
    auto owner = std::make_shared<Owner>(std::move(record));
    return [owner](ControlJobStep&) { ++owner->record->steps; };
}

} // namespace

// ---- Jobs ------------------------------------------------------------------------------------------

void scenarioJobs()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    const auto jobs = service.jobs();
    ApiSession api;
    if (!service.isRunning() || !CONTROL_CHECK(jobs != nullptr) || !api.open(service))
        return;
    const auto instanceShort = memberOf(api.discovery(), "instanceId").text().substr(0, 8);

    auto running = std::make_shared<FixtureJob>();
    const auto runningId = jobs->start("export", true, fixtureWork(running)).jobId;
    CONTROL_CHECK(runningId == "j:" + instanceShort + ":1");
    CONTROL_CHECK(pumpMessagesUntil([&running] { return running->steps.load() > 0; }, kReadTimeoutMs));

    // job.get never needs the message thread: this thread does not pump while it is answered.
    {
        std::optional<std::string> line;
        std::thread client([&] {
            if (api.client().sendLine(R"({"jsonrpc":"2.0","id":1,"method":"job.get","params":{"jobId":)"
                                      + quoted(runningId) + "}}"))
                line = api.client().readLine();
        });
        client.join();
        if (CONTROL_CHECK(line.has_value())) {
            const auto job = memberOf(memberOf(json(*line), "result"), "job");
            CONTROL_CHECK(memberOf(job, "jobId").text() == runningId && memberOf(job, "kind").text() == "export");
            CONTROL_CHECK(memberOf(job, "state").text() == "running" && memberOf(job, "cancellable").asBoolean());
            CONTROL_CHECK(memberOf(job, "finishedAtMs").isNull() && memberOf(job, "result").isNull()
                          && memberOf(job, "error").isNull() && memberOf(job, "progress").isObject());
        }
    }

    // A short hold returns the running job once waitMs passed.
    {
        const auto started = Clock::now();
        const auto result = api.result(
            "job.get", json(R"({"jobId":)" + quoted(runningId) + R"(,"waitMs":)" + std::to_string(kShortWaitMs) + "}"));
        const auto elapsed = millisecondsSince(started);
        note("job.get with waitMs " + std::to_string(kShortWaitMs) + " answered after " + std::to_string(elapsed)
             + " ms");
        CONTROL_CHECK(elapsed >= kShortWaitMs && elapsed <= kShortWaitMs + kWaitSlackMs);
        CONTROL_CHECK(memberOf(memberOf(result, "job"), "state").text() == "running");
    }

    // A long poll holds its response on the registry's thread: the same session is served meanwhile, and
    // the response comes as soon as the job ends.
    {
        std::optional<std::string> first;
        std::optional<std::string> second;
        long long heldMs = 0;
        runWhilePumping(
            [&] {
                auto& connection = api.client();
                const auto started = Clock::now();
                connection.sendLine(R"({"jsonrpc":"2.0","id":10,"method":"job.get","params":{"jobId":)"
                                    + quoted(runningId) + R"(,"waitMs":30000}})");
                connection.sendLine(R"({"jsonrpc":"2.0","id":11,"method":"job.get","params":{"jobId":)"
                                    + quoted(runningId) + "}}");
                first = connection.readLine();
                running->release = true;
                second = connection.readLine();
                heldMs = millisecondsSince(started);
            },
            kJobExchangeMs);
        CONTROL_CHECK(first && responseIdText(first) == "11");
        if (CONTROL_CHECK(second && responseIdText(second) == "10")) {
            const auto job = memberOf(memberOf(json(*second), "result"), "job");
            CONTROL_CHECK(memberOf(job, "state").text() == "succeeded" && !memberOf(job, "cancellable").asBoolean());
            CONTROL_CHECK(memberOf(job, "finishedAtMs").isNumber() && memberOf(job, "result").isObject()
                          && memberOf(job, "error").isNull());
        }
        CONTROL_CHECK(heldMs < kJobWaitMs);
    }

    // Unknown and malformed ids, a hold beyond the limit.
    CONTROL_CHECK(api.fails("job.get", json(R"({"jobId":"j:00000000:999999"})"), "NOT_FOUND", "job_not_found"));
    CONTROL_CHECK(
        api.fails("job.get", json(R"({"jobId":"j:)" + instanceShort + R"(:999"})"), "NOT_FOUND", "job_not_found"));
    CONTROL_CHECK(api.fails("job.cancel", json(R"({"jobId":"j:00000000:999999"})"), "NOT_FOUND", "job_not_found"));
    CONTROL_CHECK(api.fails("job.get", json(R"({"jobId":"u:00000000:1"})"), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("job.get", json(R"({"jobId":"j:00000000:01"})"), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("job.get", json(R"({"jobId":)" + quoted(runningId) + R"(,"waitMs":45000})"),
                            "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("job.cancel", json(R"({"jobId":)" + quoted(runningId) + R"(,"waitMs":0})"),
                            "INVALID_ARGUMENT", "invalid_params"));

    // Cancellation (PROTOCOL.md section 12.3): a terminal job is a no-op success.
    {
        const auto result = api.result("job.cancel", json(R"({"jobId":)" + quoted(runningId) + "}"));
        CONTROL_CHECK(!memberOf(result, "cancelRequested").asBoolean()
                      && memberOf(memberOf(result, "job"), "state").text() == "succeeded");
    }
    // A job that cannot be cancelled continues unchanged.
    auto saving = std::make_shared<FixtureJob>();
    const auto savingId = jobs->start("projectSave", false, fixtureWork(saving)).jobId;
    CONTROL_CHECK(pumpMessagesUntil([&saving] { return saving->steps.load() > 0; }, kReadTimeoutMs));
    CONTROL_CHECK(
        api.fails("job.cancel", json(R"({"jobId":)" + quoted(savingId) + "}"), "UNSUPPORTED", "job_not_cancellable"));
    CONTROL_CHECK(
        memberOf(memberOf(api.result("job.get", json(R"({"jobId":)" + quoted(savingId) + "}")), "job"), "state").text()
        == "running");
    // A cancellable job: requested at once (cancellable turns false), idempotent, then cancelled at its
    // next step.
    auto analysing = std::make_shared<FixtureJob>();
    const auto analysingId = jobs->start("referenceAnalysis", true, fixtureWork(analysing)).jobId;
    {
        const auto first = api.result("job.cancel", json(R"({"jobId":)" + quoted(analysingId) + "}"));
        CONTROL_CHECK(memberOf(first, "cancelRequested").asBoolean()
                      && !memberOf(memberOf(first, "job"), "cancellable").asBoolean());
        const auto again = api.result("job.cancel", json(R"({"jobId":)" + quoted(analysingId) + "}"));
        CONTROL_CHECK(memberOf(again, "cancelRequested").asBoolean());
        const auto job = waitJob(api, analysingId);
        CONTROL_CHECK(memberOf(job, "state").text() == "cancelled" && !memberOf(job, "cancellable").asBoolean());
        CONTROL_CHECK(errorKindOf(memberOf(job, "error")).text() == "CANCELLED"
                      && errorReasonOf(memberOf(job, "error")).text() == "cancelled_by_request");
        CONTROL_CHECK(!memberOf(memberOf(memberOf(job, "error"), "data"), "executed").asBoolean());
    }
    saving->release = true;
    CONTROL_CHECK(memberOf(waitJob(api, savingId), "state").text() == "succeeded");

    // Retention (section 12.4) on a registry of its own with an injected clock: 64 retained jobs at most;
    // terminal jobs that finished first are evicted first; active jobs never; terminal jobs leave after
    // jobRetentionMs.
    {
        const ControlLimits limits;
        ControlJobs registry(limits);
        registry.setInstanceShort("0123abcd");
        std::int64_t nowMs = 1000000;
        registry.setClockForTesting([&nowMs] { return nowMs; });
        auto hold = std::make_shared<FixtureJob>();
        auto done = std::make_shared<FixtureJob>();
        done->release = true;
        std::vector<std::string> ids;
        for (int i = 0; i < limits.jobRetentionCount; ++i)
            ids.push_back(registry.start("import", true, fixtureWork(i < 2 ? done : hold)).jobId);
        CONTROL_CHECK(std::none_of(ids.begin(), ids.end(), [](const std::string& id) { return id.empty(); }));
        CONTROL_CHECK(registry.start("import", true, fixtureWork(hold)).refusal == "job_limit");
        CONTROL_CHECK(pumpMessagesUntil(
            [&registry, &limits] {
                return registry.activeCount() == static_cast<std::size_t>(limits.jobRetentionCount - 2);
            },
            kReadTimeoutMs));
        const auto next = registry.start("import", true, fixtureWork(hold));
        CONTROL_CHECK(!next.jobId.empty()
                      && registry.retainedCount() == static_cast<std::size_t>(limits.jobRetentionCount));
        JsonValue job;
        CONTROL_CHECK(registry.get(ids[0], job) == ControlJobs::Lookup::NotFound);
        CONTROL_CHECK(registry.get(ids[1], job) == ControlJobs::Lookup::Found);
        nowMs += limits.jobRetentionMs;
        CONTROL_CHECK(registry.get(ids[1], job) == ControlJobs::Lookup::NotFound);
        CONTROL_CHECK(registry.get(ids[2], job) == ControlJobs::Lookup::Found);
        registry.stop();
        CONTROL_CHECK(registry.start("import", true, fixtureWork(hold)).refusal == "stopping");
        std::optional<ControlJobs::Lookup> lookup;
        registry.waitAsync(ids[2], kJobWaitMs, [&lookup](ControlJobs::Lookup result, JsonValue) { lookup = result; });
        CONTROL_CHECK(lookup == ControlJobs::Lookup::Stopped);
    }

    // `executed` of errors (section 17.4): an operation states it; other errors of a write may have
    // changed state.
    CONTROL_CHECK(controlMapError(controlOpError("BUSY", "pointer_down", "busy")).executed
                  == std::optional<bool>(false));
    const auto afterChange = controlMapError(controlOpErrorAfterChange("IO_ERROR", "write_failed", "partly written"));
    CONTROL_CHECK(afterChange.executed == std::optional<bool>(true) && afterChange.kind == "IO_ERROR"
                  && afterChange.reason == "write_failed" && afterChange.detail == "partly written");
    CONTROL_CHECK(!controlMapError(Error(ErrorCode::UnknownError, "a message")).executed.has_value());
    // A job's error object: code, message, retryability of the kind.
    const auto busy = controlErrorObjectJson({"BUSY", "job_limit", "full", false});
    CONTROL_CHECK(memberOf(busy, "code").asDouble() == -32000 && memberOf(busy, "message").text() == "BUSY");
    CONTROL_CHECK(memberOf(memberOf(busy, "data"), "retryable").asBoolean());
    CONTROL_CHECK(
        memberOf(controlErrorObjectJson({"INVALID_ARGUMENT", "audio_too_long", "long", false}), "code").asDouble()
        == -32602);
}

void scenarioJobShutdown()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    const auto jobs = service.jobs();
    ApiSession api;
    if (!service.isRunning() || !CONTROL_CHECK(jobs != nullptr) || !api.open(service))
        return;
    // A running job whose work owns a thread, and a job.get that waits for it.
    auto record = std::make_shared<ThreadedJob>();
    const auto jobId = jobs->start("export", true, threadedWork(record)).jobId;
    CONTROL_CHECK(pumpMessagesUntil([&record] { return record->steps.load() > 0 && record->threadRunning.load(); },
                                    kReadTimeoutMs));
    std::optional<std::string> response;
    std::thread client([&] {
        if (api.client().sendLine(R"({"jsonrpc":"2.0","id":7,"method":"job.get","params":{"jobId":)" + quoted(jobId)
                                  + R"(,"waitMs":30000}})"))
            response = api.client().readLine(kJobWaitMs);
    });
    CONTROL_CHECK(waitUntil([&jobs] { return jobs->waitingCount() == 1; }, kWaiterSettleMs));

    const auto started = Clock::now();
    processor.reset();
    const auto elapsed = millisecondsSince(started);
    note("processor destroyed in " + std::to_string(elapsed) + " ms");
    CONTROL_CHECK(elapsed <= kShutdownBoundMs);
    client.join();
    if (CONTROL_CHECK(response.has_value())) {
        note("response: " + *response);
        CONTROL_CHECK(isError(response, "SHUTTING_DOWN", ""));
        const JsonValue* data = errorData(json(*response));
        CONTROL_CHECK(data != nullptr && !memberOf(*data, "executed").asBoolean());
    }
    // The work was destroyed during the stop, its thread joined; no work runs afterwards.
    CONTROL_CHECK(record->destroyed.load() && !record->threadRunning.load());
    CONTROL_CHECK(jobs->isStopped() && jobs->waitingCount() == 0);
    JsonValue job;
    CONTROL_CHECK(jobs->get(jobId, job) == ControlJobs::Lookup::Stopped);
    const int stepsAtStop = record->steps.load();
    pumpMessagesFor(kQuietPumpMs);
    CONTROL_CHECK(record->steps.load() == stepsAtStop);
}

// ---- The write envelope ---------------------------------------------------------------------------

void scenarioWriteEnvelope()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    ApiSession api;
    if (!service.isRunning() || !api.open(service))
        return;
    TestUiBridge bridge;
    ControlThreadProbe probe;
    ControlInstanceFacts facts;
    facts.instanceId = memberOf(api.discovery(), "instanceId").text();
    facts.capabilities = {"session.v1", "read.v1"};
    ControlOpContext context(*processor, &bridge, facts, probe);
    auto* arrangement = processor->getStandaloneArrangement();

    const char* const members[] = {"applied", "revisionDiff", "tokens", "undo",     "dirty",
                                   "ui",      "sideEffects",  "noOp",   "dryRun",   "changes",
                                   "created", "removed",      "idMap",  "warnings", "job"};
    const auto hasEveryMember = [&members](const JsonValue& envelope) {
        return std::all_of(std::begin(members), std::end(members),
                           [&envelope](const char* member) { return envelope.find(member) != nullptr; });
    };

    // Committed without changes: noOp, undo no_op, no IRREVERSIBLE.
    {
        ControlWriteEnvelope envelope(context);
        envelope.setNotUndoable("ui_parity");
        const auto result = envelope.committed(context);
        CONTROL_CHECK(hasEveryMember(result));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && memberOf(result, "noOp").asBoolean()
                      && !memberOf(result, "dryRun").asBoolean() && memberOf(result, "job").isNull());
        CONTROL_CHECK(memberOf(memberOf(result, "undo"), "reason").text() == "no_op" && warningCodes(result).empty());
        CONTROL_CHECK(memberOf(memberOf(result, "revisionDiff"), "trackState").isNull());
        CONTROL_CHECK(memberOf(result, "ui").isObject() && memberOf(result, "nullReasons").isNull());
    }
    // Committed with a change that a recipe reverts: revisionDiff shows it, dirty after the mark.
    {
        ControlWriteEnvelope envelope(context);
        CONTROL_CHECK(arrangement->setTrackMuted(0, true));
        controlMarkDirty(context);
        auto ref = JsonValue::object();
        ref.appendMember("trackId", JsonValue::integer(0));
        auto fields = json(R"({"muted":{"before":false,"after":true,"unit":null}})");
        envelope.addChange("track", ref, JsonValue::string("Track 1"), fields);
        envelope.setNotUndoable("no_upstream_undo",
                                controlRevertRecipe("track.set", json(R"({"trackId":0,"mute":false})")));
        const auto result = envelope.committed(context);
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
        CONTROL_CHECK(memberOf(memberOf(result, "revisionDiff"), "trackState").isObject());
        CONTROL_CHECK(memberOf(result, "changes").size() == 1 && warningCodes(result).empty());
        CONTROL_CHECK(memberOf(memberOf(memberOf(result, "undo"), "revert"), "method").text() == "track.set");
        CONTROL_CHECK(!memberOf(memberOf(result, "dirty"), "before").asBoolean()
                      && memberOf(memberOf(result, "dirty"), "after").asBoolean());
    }
    // Neither undoable nor revertible: IRREVERSIBLE, once.
    {
        ControlWriteEnvelope envelope(context);
        CONTROL_CHECK(arrangement->setTrackMuted(0, false));
        envelope.addWarning("IRREVERSIBLE");
        envelope.setNotUndoable("ui_parity");
        const auto result = envelope.committed(context);
        CONTROL_CHECK(warningCodes(result) == std::vector<std::string>{"IRREVERSIBLE"});
        CONTROL_CHECK(memberOf(memberOf(result, "undo"), "revert").isNull());
    }
    // View state is exempt from IRREVERSIBLE; an undoable change carries its descriptor.
    {
        ControlWriteEnvelope envelope(context);
        CONTROL_CHECK(arrangement->setTrackSolo(0, true));
        envelope.setNotUndoable("not_persisted_state");
        CONTROL_CHECK(warningCodes(envelope.committed(context)).empty());
        ControlWriteEnvelope undoable(context);
        CONTROL_CHECK(arrangement->setTrackSolo(0, false));
        undoable.setUndoable("u:" + facts.instanceId.substr(0, 8) + ":1", "Solo", {"TrackStateAction"});
        const auto result = undoable.committed(context);
        const auto& undo = memberOf(result, "undo");
        CONTROL_CHECK(memberOf(undo, "undoable").asBoolean() && memberOf(undo, "steps").asDouble() == 1
                      && memberOf(undo, "innerActions").size() == 1 && warningCodes(result).empty());
    }
    // A prediction and a job hand-over change nothing.
    {
        ControlWriteEnvelope envelope(context);
        envelope.addChange("track", json(R"({"trackId":0})"), JsonValue(),
                           json(R"({"muted":{"before":false,"after":true,"unit":null}})"));
        const auto predicted = envelope.predicted(context);
        CONTROL_CHECK(!memberOf(predicted, "applied").asBoolean() && memberOf(predicted, "dryRun").asBoolean()
                      && memberOf(predicted, "undo").isNull() && memberOf(predicted, "changes").size() == 1);
        ControlWriteEnvelope handed(context);
        const auto result =
            handed.handedToJob(context, json(R"({"jobId":"j:01234567:1","kind":"import","state":"queued"})"));
        CONTROL_CHECK(!memberOf(result, "applied").asBoolean() && !memberOf(result, "dryRun").asBoolean()
                      && memberOf(memberOf(result, "job"), "kind").text() == "import"
                      && memberOf(result, "undo").isNull());
    }
    // Without an editor the UI snapshot is null with its reason.
    {
        ControlOpContext withoutEditor(*processor, nullptr, facts, probe);
        ControlWriteEnvelope envelope(withoutEditor);
        const auto result = envelope.committed(withoutEditor);
        CONTROL_CHECK(memberOf(result, "ui").isNull()
                      && memberOf(memberOf(result, "nullReasons"), "ui").text() == "no_editor");
        CONTROL_CHECK(!controlCheckBusy(withoutEditor).has_value());
    }
    // The busy checks (section 13.2), in their order; ui.dismiss ignores modal dialogs.
    {
        CONTROL_CHECK(!controlCheckBusy(context).has_value());
        const auto reasonOf = [&context](ControlBusyScope scope) {
            const auto busy = controlCheckBusy(context, scope);
            return busy ? controlMapError(*busy).reason : std::string();
        };
        bridge.busy.operationRunning = true;
        CONTROL_CHECK(reasonOf(ControlBusyScope::Write) == "project_operation");
        bridge.busy.exportRunning = true;
        CONTROL_CHECK(reasonOf(ControlBusyScope::Write) == "export_in_progress");
        bridge.busy.importRunning = true;
        CONTROL_CHECK(reasonOf(ControlBusyScope::Write) == "import_in_progress");
        bridge.busy.modalOpen = true;
        CONTROL_CHECK(reasonOf(ControlBusyScope::Write) == "modal_open");
        CONTROL_CHECK(reasonOf(ControlBusyScope::DialogDismiss) == "import_in_progress");
        bridge.busy.pointerDown = true;
        CONTROL_CHECK(reasonOf(ControlBusyScope::Write) == "pointer_down");
        const auto busy = controlCheckBusy(context);
        CONTROL_CHECK(busy && controlMapError(*busy).kind == "BUSY"
                      && controlMapError(*busy).executed == std::optional<bool>(false));
    }
    // A job keeps the environment of the operation that started it and makes a context for each step.
    {
        const auto environment = context.environment();
        ControlOpContext step(environment);
        CONTROL_CHECK(&step.processor() == processor.get() && step.bridge() == &bridge && step.jobs() == nullptr);
        CONTROL_CHECK(step.instanceShort() == facts.instanceId.substr(0, 8));
    }
    CONTROL_CHECK(probe.otherThreadAccesses.load() == 0);
}
// ---- The specification's vectors -------------------------------------------------------------------

namespace {

const std::set<std::string> kVectorMethods = {"job.get", "job.cancel"};
const std::set<std::string> kVectorCapabilities = {"session.v1", "read.v1", "jobs.v1"};

std::string jobVectorSkipReason(const JsonValue& vector)
{
    if (kVectorCapabilities.count(memberOf(vector, "capability").text()) == 0)
        return "needs capability " + memberOf(vector, "capability").text() + ", which a later part implements";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (kVectorCapabilities.count(extra.at(i).text()) == 0)
            return "needs capability " + extra.at(i).text() + ", which a later part implements";
    if (memberOf(vector, "session").text() != "authenticated" || memberOf(vector, "type").text() != "request")
        return "only authenticated request vectors are run here";
    const auto method = memberOf(memberOf(vector, "request"), "method").text();
    if (kVectorMethods.count(method) == 0)
        return "uses " + method + ", which this runner does not cover";
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i)
        if (given.keyAt(i) != "jobs")
            return "precondition given." + given.keyAt(i) + " is not established by this runner";
    const auto& jobs = memberOf(given, "jobs");
    for (std::size_t j = 0; j < jobs.size(); ++j)
        if (memberOf(jobs.at(j), "state").text() == "queued")
            return "a queued job is not established by this runner";
    return {};
}

/** Establishes given.jobs: each job in its state, its id bound to its name. */
bool establishJobs(ControlJobs& jobs, const JsonValue& given, VectorMatcher& matcher,
                   std::vector<std::shared_ptr<FixtureJob>>& fixtures)
{
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& spec = given.at(i);
        const auto state = memberOf(spec, "state").text();
        const auto& error = memberOf(spec, "error");
        auto fixture = std::make_shared<FixtureJob>();
        ControlJobWork work = fixtureWork(fixture);
        if (state == "succeeded") {
            work = [](ControlJobStep& step) { step.succeed(JsonValue::object()); };
        } else if (state == "failed") {
            ControlJobError failure{error.isObject() ? memberOf(error, "kind").text() : "INTERNAL",
                                    error.isObject() ? memberOf(error, "reason").text() : "",
                                    "a failed job of the fixture", false};
            work = [failure](ControlJobStep& step) { step.fail(failure); };
        } else if (state == "cancelled") {
            work = [](ControlJobStep& step) { step.cancel(); };
        }
        const bool cancellable = memberOf(spec, "cancellable").asBoolean() || state != "running";
        const auto started = jobs.start(memberOf(spec, "kind").text(), cancellable, work);
        if (started.jobId.empty())
            return false;
        matcher.bindings[memberOf(spec, "bind").text()] = JsonValue::string(started.jobId);
        const std::string jobId = started.jobId;
        const bool reached = pumpMessagesUntil(
            [&jobs, jobId, state] {
                JsonValue job;
                return jobs.get(jobId, job) == ControlJobs::Lookup::Found && memberOf(job, "state").text() == state;
            },
            kReadTimeoutMs);
        if (!reached)
            return false;
        fixtures.push_back(std::move(fixture));
    }
    return true;
}

/** Runs one request vector of job.get or job.cancel against a fresh processor. Empty on success. */
std::string runJobVector(const JsonValue& vector)
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    VectorMatcher matcher;
    std::vector<std::shared_ptr<FixtureJob>> fixtures;
    if (!establishJobs(*service.jobs(), memberOf(memberOf(vector, "given"), "jobs"), matcher, fixtures))
        return "given.jobs could not be established";
    ApiSession api;
    if (!api.open(service))
        return "session.hello failed";
    const auto& discovery = api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);

    std::string failure;
    runWhilePumping(
        [&] {
            auto& connection = api.client();
            const auto request = matcher.substitute(memberOf(vector, "request"), failure);
            if (!failure.empty())
                return;
            if (!connection.sendLine(toJsonString(request))) {
                failure = "cannot send the request";
                return;
            }
            failure = matcher.expectLine(connection, memberOf(vector, "response"));
            if (failure.empty() && memberOf(vector, "connectionAfter").text() == "open"
                && !connection.staysQuiet(kOpenCheckMs))
                failure = "the connection closed or sent more";
        },
        kJobExchangeMs);
    for (const auto& fixture : fixtures)
        fixture->release = true;
    return failure;
}

} // namespace

void scenarioJobVectors()
{
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root / "job"))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    int passed = 0;
    int skipped = 0;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto& vector = parsed.value;
        const auto id = memberOf(vector, "id").text();
        if (const auto reason = jobVectorSkipReason(vector); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runJobVector(vector);
        if (CONTROL_CHECK(failure.empty()))
            ++passed;
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    // Every vector of job/ runs headless.
    CONTROL_CHECK(skipped == 0 && passed >= 7);
    note(std::to_string(passed) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace ControlTest
} // namespace OpenTune
