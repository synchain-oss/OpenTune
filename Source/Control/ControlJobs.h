// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "ControlJson.h"
#include "ControlProtocol.h"

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace OpenTune {

/** The error of a failed or cancelled job, or of an item of a job result (PROTOCOL.md section 17.1):
    the kind, reason and detail as ControlDispatcher would send them, and executed. detail is printable
    ASCII and never contains text taken from files or projects. */
struct ControlJobError
{
    std::string kind;
    std::string reason;
    std::string detail;
    bool executed = true;
};

/** The error object of the protocol (common.schema.json#/$defs/errorObject) of a job error: the
    JSON-RPC code and the retryability of the kind (registry/error-kinds.json). */
JsonValue controlErrorObjectJson(const ControlJobError& error);

class ControlJobs;

/**
 * What the work of a job sees during one of its steps: whether cancellation was requested, and the
 * calls that report progress or end the job. A step ends the job with exactly one of succeed(),
 * fail() or cancel(); the registry then destroys the work.
 *
 * Threading: message thread, valid only during the step it was passed to.
 */
class ControlJobStep
{
public:
    /** True once job.cancel requested cancellation (PROTOCOL.md section 12.3). */
    bool cancelRequested() const;
    /** Ends the job's cancellability, for a job that passed the point after which it can no longer be
        cancelled. Returns false, and changes nothing, when cancellation was already requested. */
    bool endCancellability();
    /** The job's progress; members without a value are null. */
    void setProgress(std::optional<double> fraction, const char* phase, std::optional<int> itemsDone,
                     std::optional<int> itemsTotal);
    /** Ends the job as succeeded with its result (an object). */
    void succeed(JsonValue result);
    /** Ends the job as failed; result is null or the work it committed before it failed. */
    void fail(ControlJobError error, JsonValue result = JsonValue());
    /** Ends the job as cancelled, with the error CANCELLED(cancelled_by_request); result is null or the
        work it committed before it stopped, and changedState (the error's executed) tells whether it
        committed any. */
    void cancel(JsonValue result = JsonValue(), bool changedState = false);
    /** True once one of succeed(), fail() or cancel() was called. */
    bool finished() const noexcept { return finished_; }

private:
    friend class ControlJobs;
    ControlJobStep(ControlJobs& jobs, std::uint64_t seq) : jobs_(jobs), seq_(seq) {}

    ControlJobs& jobs_;
    std::uint64_t seq_;
    bool finished_ = false;
};

/** The work of a job. The registry calls it on the message thread, once per tick, until it ends the
    job, and destroys it on the message thread afterwards or when the registry stops. Each call must
    return quickly; long work belongs on a thread of the work's own, which its destructor joins. */
using ControlJobWork = std::function<void(ControlJobStep& step)>;

/**
 * The jobs of one instance (PROTOCOL.md section 12): the registry that job.get and job.cancel read, the
 * tick that advances every running job on the message thread, retention and the long poll of job.get.
 *
 * - Ids are j:<instanceIdShort>:<seq>, seq from 1. A job is created queued, becomes running at its first
 *   step and ends succeeded, failed or cancelled; terminal states never change again.
 * - Retention: a terminal job is kept for limits.jobRetentionMs after it finished, unless more than
 *   limits.jobRetentionCount jobs exist; then the terminal jobs that finished first are evicted first.
 *   Jobs that are not terminal are never evicted; when all retained jobs are active, start() refuses with
 *   BUSY(job_limit).
 * - job.get with waitMs holds its response on a thread of the registry, never on the message thread and
 *   never on the connection thread: the response comes when the job becomes terminal, or when waitMs
 *   passes, or with SHUTTING_DOWN when the registry stops. The waiting holds no lock or lease of the
 *   processor.
 * - Cancellation (section 12.3): a job created cancellable stays so until it ends, until its work calls
 *   ControlJobStep::endCancellability(), or until job.cancel requests cancellation; the work sees the
 *   request at its next step and stops there.
 *
 * Threading: start(), findByKey() and stop() on the message thread; get(), waitAsync(), cancel() and
 * the accessors from any thread. The work runs on the message thread only. Destroy the registry after
 * stop() (any thread then), or on the message thread.
 */
class ControlJobs
{
public:
    /** How a lookup ended. */
    enum class Lookup {
        Found,
        NotFound,
        Stopped
    };
    /** How job.cancel ended (section 12.3 rules 1 to 5). */
    enum class Cancel {
        Requested,
        AlreadyRequested,
        Terminal,
        NotCancellable,
        NotFound,
        Stopped
    };
    /** Result of start(): the job id, or empty with the refusal ("job_limit", or "stopping" after stop()). */
    struct Started
    {
        std::string jobId;
        std::string refusal;
    };
    /** Milliseconds since the Unix epoch. */
    using Clock = std::function<std::int64_t()>;

    explicit ControlJobs(const ControlLimits& limits);
    /** Calls stop() when it was not called; see the class threading rules. */
    ~ControlJobs();

    ControlJobs(const ControlJobs&) = delete;
    ControlJobs& operator=(const ControlJobs&) = delete;

    /** The instance part of the job ids; set once the listener generated the instance id. Any thread. */
    void setInstanceShort(std::string instanceShort);

    /**
     * Creates a job of the kind (a camelName of section 12.3) and starts the tick. idempotencyKey and
     * paramsDigest, when given, let findByKey() find the job while it is retained. Message thread.
     */
    Started start(const std::string& kind, bool cancellable, ControlJobWork work,
                  const std::string& idempotencyKey = {}, const std::string& paramsDigest = {});

    /** The retained job of that kind started with that idempotency key: its id and the params digest it
        was started with; empty id when none. Message thread. */
    std::string findByKey(const std::string& kind, const std::string& idempotencyKey, std::string& paramsDigest) const;

    /** The job object (common.schema.json#/$defs/job). Any thread. */
    Lookup get(const std::string& jobId, JsonValue& job) const;
    /** {jobId, kind, state} of a job (common.schema.json#/$defs/jobRef), or null. Any thread. */
    JsonValue jobRef(const std::string& jobId) const;

    /** Responder of waitAsync(): called exactly once, from the calling thread or the registry's waiter
        thread, with the lookup result and the job object. */
    using WaitResponder = std::function<void(Lookup, JsonValue job)>;
    /**
     * job.get (section 12.2): responds at once when waitMs is 0, the job is terminal or unknown;
     * otherwise when the job becomes terminal or waitMs passed, whichever comes first, and with Stopped
     * when stop() is called meanwhile. Any thread; never blocks.
     */
    void waitAsync(const std::string& jobId, int waitMs, WaitResponder respond);

    /** job.cancel (section 12.3); job is the job right after the request. Any thread. */
    Cancel cancel(const std::string& jobId, JsonValue& job);

    /**
     * Stops the registry: waiting job.get requests are answered with Stopped at once, the tick stops,
     * the waiter thread is joined, and the work of every job is destroyed on this thread; no work runs
     * afterwards. start() refuses from now on. Message thread; idempotent.
     */
    void stop();

    /** True once stop() was called. Any thread. */
    bool isStopped() const;
    /** Number of retained jobs, and of those that are not terminal. Any thread; for tests. */
    std::size_t retainedCount() const;
    std::size_t activeCount() const;
    /** Number of job.get requests waiting. Any thread; for tests. */
    std::size_t waitingCount() const;

    /** Test seam: the clock of the timestamps and of retention. Message thread, before the first job. */
    void setClockForTesting(Clock clock);

private:
    friend class ControlJobStep;
    struct Job;
    struct Waiter;
    class Ticker;

    std::int64_t now() const;
    /** Advances every active job once; returns whether one is still active. Message thread. */
    bool tick();
    void evictLocked(std::int64_t nowMs);
    Job* findLocked(const std::string& jobId) const;
    JsonValue jobJsonLocked(const Job& job) const;
    void finishLocked(Job& job, const char* state, std::optional<ControlJobError> error, JsonValue result);
    void ensureWaiterThreadLocked();
    void waiterLoop();

    ControlLimits limits_;
    Clock clock_;
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::string instanceShort_ = "00000000";
    std::uint64_t nextSeq_ = 1;
    std::map<std::uint64_t, std::unique_ptr<Job>> jobs_;
    std::vector<Waiter> waiters_;
    std::thread waiterThread_;
    bool stopped_ = false;
    /** Message thread only. */
    std::unique_ptr<Ticker> ticker_;
};

} // namespace OpenTune
