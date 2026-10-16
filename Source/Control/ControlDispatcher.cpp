// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ControlDispatcher.h"

#include "ContentHandles.h"
#include "ControlJobs.h"
#include "ControlLogTail.h"
#include "ControlMessageThread.h"

#include "Utils/AppLogger.h"

#include <juce_events/juce_events.h>

#include <chrono>
#include <optional>
#include <utility>

namespace OpenTune {

/** What execute() produced on the message thread, read by the waiting connection thread after call()
    returned Done. */
struct ControlDispatcher::Outcome
{
    std::optional<JsonValue> result;
    ControlErrorReply error;
    /** `executed` of the error: whether state may have changed. */
    bool executed = false;
};

namespace {

void logFailure(const std::string& method, const char* what)
{
    // The method name is one of the registered protocol names; nothing of the request is logged.
    AppLogger::logNoThrow(juce::String("control API: ") + juce::String(method) + " " + what);
}

} // namespace

ControlDispatcher::ControlDispatcher(Setup setup) : setup_(std::move(setup))
{
    jassert(setup_.processor != nullptr && setup_.messageThread != nullptr);
    registerControlMethods(methods_);
    capabilities_ = methods_.capabilities();
    auto facts = std::make_shared<ControlInstanceFacts>();
    facts->limits = setup_.limits;
    facts->build = setup_.build;
    facts->capabilities = capabilities_;
    // juce::File::getSpecialLocation(userHomeDirectory): the user's home directory, taken once here on the
    // message thread, so that app.getLog, which runs on connection threads, only reads a copy.
    facts->homeDirectorySpellings = controlHomeDirectorySpellings(
        juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName().toStdString());
    facts_ = std::move(facts);
}

std::vector<std::string> ControlDispatcher::capabilities() const
{
    return capabilities_;
}

void ControlDispatcher::setInstanceId(std::string instanceId)
{
    if (setup_.jobs != nullptr)
        setup_.jobs->setInstanceShort(controlInstanceShort(instanceId));
    std::lock_guard<std::mutex> lock(factsMutex_);
    auto facts = std::make_shared<ControlInstanceFacts>(*facts_);
    facts->instanceId = std::move(instanceId);
    facts_ = std::move(facts);
}

void ControlDispatcher::setRedactionSecrets(std::vector<std::string> secrets)
{
    {
        std::lock_guard<std::mutex> lock(factsMutex_);
        auto facts = std::make_shared<ControlInstanceFacts>(*facts_);
        facts->redactionSecrets = std::move(secrets);
        facts_ = std::move(facts);
        redactionSecretsSet_ = true;
    }
    factsChanged_.notify_all();
}

std::shared_ptr<const ControlInstanceFacts> ControlDispatcher::currentFacts() const
{
    std::lock_guard<std::mutex> lock(factsMutex_);
    return facts_;
}

void ControlDispatcher::serverStopping()
{
    // Requests that reach handleRequest() from now on answer themselves with SHUTTING_DOWN (they may have
    // passed the listener's stop check just before its flag was set). Functions already queued for the
    // message thread check the flag before they start; ControlService::stop() has woken their waiters
    // already by stopping the message-thread marshalling. A method off the message thread that waits for
    // the redaction secrets is woken here.
    {
        std::lock_guard<std::mutex> lock(factsMutex_);
        stopping_ = true;
    }
    factsChanged_.notify_all();
}

void ControlDispatcher::handleRequest(ControlRequest request, ControlCompletion completion)
{
    if (stopping_.load()) {
        completion.respondError("SHUTTING_DOWN", {}, "the control API is stopping", false);
        return;
    }
    const ControlMethod* method = methods_.find(request.method);
    if (method == nullptr) {
        // A defined method of a capability this instance reports but does not implement yet; an
        // instance that does not report the capability never gets here (ControlServer answers first).
        const char* capability = controlMethodCapability(request.method);
        completion.respondError("UNSUPPORTED", "capability_missing",
                                request.method + " (capability " + (capability != nullptr ? capability : "?")
                                    + ") is not implemented by this build",
                                false);
        return;
    }
    // Network thread: the shape of params only.
    std::shared_ptr<const void> parsed;
    std::string why;
    if (!method->parse(request.params, parsed, why)) {
        completion.respondError("INVALID_ARGUMENT", "invalid_params", why, false);
        return;
    }
    if (!method->mainThread && method->runWithoutMessageThread) {
        // job.get and job.cancel: the jobs registry only, never the message thread (PROTOCOL.md section 13.3
        // rule 2). The reply may come later from the registry's thread; it captures only the completion.
        if (setup_.jobs == nullptr) {
            completion.respondError("INTERNAL", {}, "the method is not available", false);
            return;
        }
        method->runWithoutMessageThread(*setup_.jobs, parsed.get(), [completion](Result<JsonValue> result) {
            if (result.ok()) {
                completion.respondResult(result.value());
                return;
            }
            const auto reply = controlMapError(result.error());
            completion.respondError(reply.kind, reply.reason, reply.detail, reply.executed.value_or(false));
        });
        return;
    }

    auto outcome = std::make_shared<Outcome>();
    if (!method->mainThread) {
        // x-otcp.mainThread false without the jobs registry (app.getLog): runs here, on the connection
        // thread, and never waits for the message thread, so a busy main thread never delays it and it
        // never answers TIMEOUT.
        executeOffMainThread(*method, parsed.get(), *outcome);
        respond(*outcome, completion);
        return;
    }
    // `this` and `method` stay valid: call() returns only after the function finished or once it can no
    // longer start (TimedOut, Stopped), and the dispatcher outlives the request it is handling. The
    // waiting thread holds no lock and no lease of the processor.
    const auto callResult = setup_.messageThread->call(
        [this, method, parsed, outcome] { execute(*method, parsed.get(), *outcome); }, setup_.limits.dispatchTimeoutMs);
    switch (callResult) {
        case ControlMessageThread::CallResult::Done:
            respond(*outcome, completion);
            return;
        case ControlMessageThread::CallResult::Failed:
            logFailure(method->name, "failed on the message thread");
            completion.respondError("INTERNAL", {}, "the method failed", method->write);
            return;
        case ControlMessageThread::CallResult::TimedOut:
            // Abandoned before it started: it never runs (ControlMessageThread::call()).
            completion.respondError("TIMEOUT", "dispatch_timeout",
                                    "the request did not start on the main thread within dispatchTimeoutMs", false);
            return;
        case ControlMessageThread::CallResult::Stopped:
        case ControlMessageThread::CallResult::NotPosted:
            // The marshalling stopped, or the message loop accepts no more work (OpenTune quits).
            completion.respondError("SHUTTING_DOWN", {}, "the control API is stopping", false);
            return;
    }
}

void ControlDispatcher::execute(const ControlMethod& method, const void* parsed, Outcome& outcome)
{
    // Always on: only the message thread may run methods (call() guarantees it; this check proves it).
    if (!juce::MessageManager::existsAndIsCurrentThread()) {
        ++probe_.otherThreadAccesses;
        jassertfalse;
        outcome.error = {"INTERNAL", "", "the method was not run on the main thread"};
        return;
    }
    if (stopping_.load()) {
        outcome.error = {"SHUTTING_DOWN", "", "the control API is stopping"};
        return;
    }
    ++executed_;
    const auto facts = currentFacts();
    try {
        ControlOpContext context(*setup_.processor, setup_.uiBridge ? setup_.uiBridge() : nullptr, *facts, probe_,
                                 setup_.jobs.get(), setup_.uiBridge, setup_.history);
        auto result = method.run(context, parsed);
        if (result.ok()) {
            outcome.result = std::move(result).value();
        } else {
            outcome.error = controlMapError(result.error());
            // As the operation stated it: controlOpError fails before any change, controlOpErrorAfterChange
            // after one. Another error of a write may have changed state.
            outcome.executed = outcome.error.executed.value_or(method.write);
        }
    } catch (const ControlThreadViolation&) {
        outcome.error = {"INTERNAL", "", "OpenTune state was reached from a thread other than the main thread"};
        outcome.executed = false;
    } catch (...) {
        logFailure(method.name, "failed with an exception");
        outcome.error = {"INTERNAL", "", "the method failed"};
        outcome.executed = method.write;
    }
}

void ControlDispatcher::executeOffMainThread(const ControlMethod& method, const void* parsed, Outcome& outcome)
{
    if (!method.runOffMainThread) {
        outcome.error = {"INTERNAL", "", "the method is not available"};
        return;
    }
    std::shared_ptr<const ControlInstanceFacts> facts;
    {
        // ControlService sets the secrets right after ControlServer::start() returned, so a request can
        // only arrive before them by a moment; the bound is a safety net, not a wait anyone should see.
        std::unique_lock<std::mutex> lock(factsMutex_);
        factsChanged_.wait_for(lock, std::chrono::milliseconds(setup_.limits.dispatchTimeoutMs),
                               [this] { return redactionSecretsSet_ || stopping_.load(); });
        if (redactionSecretsSet_)
            facts = facts_;
    }
    if (stopping_.load()) {
        outcome.error = {"SHUTTING_DOWN", "", "the control API is stopping"};
        return;
    }
    if (facts == nullptr) {
        // Without the secrets nothing could be redacted; never answer without them.
        logFailure(method.name, "found the instance facts incomplete");
        outcome.error = {"INTERNAL", "", "the instance is not ready"};
        return;
    }
    ++offMainThread_;
    try {
        auto result = method.runOffMainThread(*facts, parsed);
        if (result.ok()) {
            outcome.result = std::move(result).value();
        } else {
            outcome.error = controlMapError(result.error());
            outcome.executed = false; // reads change nothing
        }
    } catch (...) {
        logFailure(method.name, "failed with an exception");
        outcome.error = {"INTERNAL", "", "the method failed"};
        outcome.executed = method.write;
    }
}

void ControlDispatcher::respond(const Outcome& outcome, const ControlCompletion& completion)
{
    if (outcome.result)
        completion.respondResult(*outcome.result);
    else
        completion.respondError(outcome.error.kind, outcome.error.reason, outcome.error.detail, outcome.executed);
}

} // namespace OpenTune
