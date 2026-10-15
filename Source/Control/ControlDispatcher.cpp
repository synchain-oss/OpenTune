// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ControlDispatcher.h"

#include "ControlMessageThread.h"

#include "Utils/AppLogger.h"

#include <juce_events/juce_events.h>

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
    facts_.limits = setup_.limits;
    facts_.build = setup_.build;
    facts_.capabilities = capabilities_;
}

std::vector<std::string> ControlDispatcher::capabilities() const
{
    return capabilities_;
}

void ControlDispatcher::setInstanceId(std::string instanceId)
{
    std::lock_guard<std::mutex> lock(factsMutex_);
    facts_.instanceId = std::move(instanceId);
}

void ControlDispatcher::setRedactionSecrets(std::vector<std::string> secrets)
{
    std::lock_guard<std::mutex> lock(factsMutex_);
    facts_.redactionSecrets = std::move(secrets);
}

void ControlDispatcher::serverStopping()
{
    // Requests that reach handleRequest() from now on answer themselves with SHUTTING_DOWN (they may have
    // passed the listener's stop check just before its flag was set). Functions already queued for the
    // message thread check the flag before they start; ControlService::stop() has woken their waiters
    // already by stopping the message-thread marshalling.
    stopping_ = true;
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

    auto outcome = std::make_shared<Outcome>();
    // `this` and `method` stay valid: call() returns only after the function finished or once it can no
    // longer start (TimedOut, Stopped), and the dispatcher outlives the request it is handling. The
    // waiting thread holds no lock and no lease of the processor.
    const auto callResult = setup_.messageThread->call(
        [this, method, parsed, outcome] { execute(*method, parsed.get(), *outcome); }, setup_.limits.dispatchTimeoutMs);
    switch (callResult) {
        case ControlMessageThread::CallResult::Done:
            if (outcome->result)
                completion.respondResult(*outcome->result);
            else
                completion.respondError(outcome->error.kind, outcome->error.reason, outcome->error.detail,
                                        outcome->executed);
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
    ControlInstanceFacts facts;
    {
        std::lock_guard<std::mutex> lock(factsMutex_);
        facts = facts_;
    }
    try {
        ControlOpContext context(*setup_.processor, setup_.uiBridge ? setup_.uiBridge() : nullptr, facts, probe_);
        auto result = method.run(context, parsed);
        if (result.ok()) {
            outcome.result = std::move(result).value();
        } else {
            outcome.error = controlMapError(result.error());
            outcome.executed = false; // operations fail in their checks, before any change
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

} // namespace OpenTune
