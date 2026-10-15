// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "ControlServer.h"
#include "Ops/OpsRegistry.h"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace OpenTune {

class ControlJobs;
class ControlMessageThread;
class ControlUiBridge;
class OpenTuneAudioProcessor;

/**
 * The single entry point of every method on the C++ side, and the request handler of the listener
 * (ControlServerConfig::handler). For each request it:
 * 1. answers SHUTTING_DOWN once serverStopping() began (a request can pass the listener's own stop check
 *    just before the flag is set and reach the handler afterwards);
 * 2. finds the method in the method table (Ops/OpsRegistry.cpp); a defined method this build does not
 *    implement gets UNSUPPORTED(capability_missing);
 * 3. checks params on the network thread (shape and ranges only, never OpenTune state):
 *    INVALID_ARGUMENT(invalid_params);
 * 4. runs the method on the message thread through ControlMessageThread::call(), with the dispatch
 *    timeout of the limits. A request that has not started within it is abandoned and answered with
 *    TIMEOUT(dispatch_timeout), executed false, and never runs later (the liveness token and the
 *    abandon mark of call()). A request that stop() overtakes before it started gets SHUTTING_DOWN;
 * 5. maps the method's Result to the response: the result object, or the error that controlMapError
 *    gives (the only place where OpenTune errors become protocol errors). `executed` is what the
 *    operation stated (controlOpError or controlOpErrorAfterChange); for any other failure of a write
 *    it is true, because the write may have changed state.
 *
 * Methods whose schema says mainThread false (job.get, job.cancel) skip step 4: they run on the
 * connection thread with the jobs registry only, and job.get with waitMs answers later from the
 * registry's own thread, so the connection keeps serving the session's other requests meanwhile.
 *
 * Every access to OpenTune state goes through ControlOpContext, which refuses any thread other than the
 * message thread, always (not only in debug builds); the refusals are counted in threadProbe().
 *
 * A request occupies its connection thread while it waits for the message thread: at most the dispatch
 * timeout before it starts, then until it returns (reads return within one main-thread step). The
 * requests of one session therefore start on the message thread in the order they arrived (PROTOCOL.md
 * section 3.3 rule 6), and different sessions do not wait for each other.
 *
 * Threading: handleRequest() on connection threads, concurrently; serverStopping() and setInstanceId() on
 * the thread that starts and stops the listener (the message thread in OpenTune); the accessors from any
 * thread.
 */
class ControlDispatcher final : public ControlRequestHandler
{
public:
    /** What the dispatcher works with. */
    struct Setup
    {
        /** Initialised (ensureRuntimeInitialized()) before the listener starts; reached only on the
            message thread, while the liveness token of messageThread is alive. */
        OpenTuneAudioProcessor* processor = nullptr;
        std::shared_ptr<ControlMessageThread> messageThread;
        /** The limits of the listener; session.info reports them, dispatchTimeoutMs bounds the wait. */
        ControlLimits limits;
        /** The build identity of the listener, for session.info. */
        ControlBuildIdentity build;
        /** The editor's bridge, or nullptr; called on the message thread for each request. */
        std::function<ControlUiBridge*()> uiBridge;
        /** The jobs of the instance (job.get, job.cancel and the methods that start jobs); stopped by
            ControlService::stop() before the listener. */
        std::shared_ptr<ControlJobs> jobs;
    };

    explicit ControlDispatcher(Setup setup);

    /** session.v1 and the capabilities of the registered methods. */
    std::vector<std::string> capabilities() const override;
    void handleRequest(ControlRequest request, ControlCompletion completion) override;
    /** From now on every request is answered with SHUTTING_DOWN, also one that is waiting for the
        message thread and has not started yet. */
    void serverStopping() override;

    /** The instance id the listener generated, also for the job ids; set after ControlServer::start(),
        before the message loop runs any request. Message thread. */
    void setInstanceId(std::string instanceId);

    /** True once serverStopping() was called. Thread-safe. */
    bool isStopping() const noexcept { return stopping_.load(); }
    /** True when this build implements the method. Thread-safe. */
    bool implements(std::string_view method) const { return methods_.find(method) != nullptr; }
    /** Accesses to OpenTune state through the operations, by thread. Thread-safe. */
    const ControlThreadProbe& threadProbe() const noexcept { return probe_; }
    /** Number of methods that started on the message thread. Thread-safe. */
    int executedCount() const noexcept { return executed_.load(); }

private:
    struct Outcome;

    void execute(const ControlMethod& method, const void* parsed, Outcome& outcome);

    Setup setup_;
    ControlMethodTable methods_;
    std::vector<std::string> capabilities_;
    mutable std::mutex factsMutex_;
    ControlInstanceFacts facts_;
    ControlThreadProbe probe_;
    std::atomic<bool> stopping_{false};
    std::atomic<int> executed_{0};
};

} // namespace OpenTune
