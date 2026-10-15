// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "Control/ControlDiscovery.h"
#include "Control/ControlJson.h"
#include "Control/ControlProtocol.h"
#include "Utils/Error.h"

#include <atomic>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace OpenTune {

class ControlUiBridge;
class OpenTuneAudioProcessor;

/**
 * Counts accesses to OpenTune state made through ControlOpContext, by thread. The control API reads
 * and changes project content only on the message thread; an access from any other thread is refused
 * (always, also in release builds) and counted here, so that tests can assert that it never happens.
 * Thread-safe.
 */
struct ControlThreadProbe
{
    std::atomic<int> messageThreadAccesses{0};
    std::atomic<int> otherThreadAccesses{0};
};

/** Thrown by ControlOpContext when OpenTune state is reached from a thread other than the message
    thread. ControlDispatcher answers the request with INTERNAL; nothing was read or changed. */
class ControlThreadViolation : public std::runtime_error
{
public:
    ControlThreadViolation() : std::runtime_error("OpenTune state accessed off the message thread") {}
};

/**
 * What session.info, the handles and app.getLog need to know about the running instance. ControlDispatcher
 * keeps it as an immutable snapshot: a change makes a new copy, so a method can read the copy it got from
 * any thread without a lock.
 */
struct ControlInstanceFacts
{
    /** The instance id of the listener (32 lowercase hexadecimal digits). */
    std::string instanceId;
    ControlLimits limits;
    ControlBuildIdentity build;
    /** The capabilities the instance reports, in the order session.hello lists them. */
    std::vector<std::string> capabilities;
    /** The session token and the server proof: texts that leave the process (app.getLog) are redacted
        with them. Never reported, logged or stored elsewhere. */
    std::vector<std::string> redactionSecrets;
    /** The spellings of the user's home directory (controlHomeDirectorySpellings()), which app.getLog
        replaces with "~"; taken once on the message thread when the dispatcher is created. */
    std::vector<std::string> homeDirectorySpellings;
};

/**
 * What an operation may use while it runs on the message thread: the processor, the editor's bridge
 * and the facts of the instance. Every access to the processor or the bridge checks the thread, so an
 * operation can never read or change content anywhere but on the message thread.
 *
 * Threading: created by ControlDispatcher on the message thread for one request; not shared.
 */
class ControlOpContext
{
public:
    ControlOpContext(OpenTuneAudioProcessor& processor, ControlUiBridge* bridge, const ControlInstanceFacts& facts,
                     ControlThreadProbe& probe);

    /** The processor. Throws ControlThreadViolation off the message thread. */
    OpenTuneAudioProcessor& processor();
    /** The editor's bridge, or nullptr without an editor. Throws ControlThreadViolation off the message
        thread. */
    ControlUiBridge* bridge();

    const ControlInstanceFacts& facts() const noexcept { return facts_; }
    /** The first 8 characters of the instance id, the instance part of every handle. */
    const std::string& instanceShort() const noexcept { return instanceShort_; }

private:
    void requireMessageThread();

    OpenTuneAudioProcessor& processor_;
    ControlUiBridge* bridge_;
    const ControlInstanceFacts& facts_;
    ControlThreadProbe& probe_;
    std::string instanceShort_;
};

/**
 * The error an operation returns, as an OpenTune Error: the protocol's error kind and reason travel
 * in Error::context as "otcp:<KIND>:<reason>" (reason may be empty) and the diagnostic text in
 * Error::message. Only ControlDispatcher maps errors to the protocol (controlMapError). detail must be
 * printable ASCII and must never contain secrets or text taken from files or projects.
 */
Error controlOpError(std::string_view kind, std::string_view reason, std::string detail);

/** Error kind, reason and detail that ControlDispatcher sends for an Error. */
struct ControlErrorReply
{
    std::string kind;
    std::string reason;
    std::string detail;
};

/**
 * Maps an Error to the protocol: errors made by controlOpError keep their kind, reason and detail;
 * other OpenTune errors are mapped by their ErrorCode (InvalidParameter: INVALID_ARGUMENT, NotInitialized:
 * NOT_READY, model and session failures: MODEL_UNAVAILABLE, OperationCancelled: CANCELLED, the rest:
 * INTERNAL), with the fixed text of the code as detail, never the error's own message.
 */
ControlErrorReply controlMapError(const Error& error);

/**
 * One method of the protocol as the dispatcher runs it.
 *
 * parse runs on the network thread: it checks params against the method's params schema (shape and
 * ranges only, never OpenTune state) and keeps what it parsed. On failure it sets why (printable
 * ASCII, no request content) and the request is answered with INVALID_ARGUMENT(invalid_params).
 *
 * run runs on the message thread with what parse kept, and returns the result object or an Error.
 *
 * A method whose schema says x-otcp.mainThread false (app.getLog) has runOffMainThread instead of run: it
 * runs on the connection thread, never waits for the message thread and so never answers TIMEOUT. It
 * gets only the instance facts (an immutable snapshot) and what parse kept, never the processor or the
 * editor bridge, so it cannot read or change project content.
 */
struct ControlMethod
{
    std::string name;
    /** Runs on the message thread (x-otcp.mainThread of the schema): run is set when true,
        runOffMainThread when false. */
    bool mainThread = true;
    /** Changes state (x-otcp.write is not "no"): decides `executed` of an error after the start. */
    bool write = false;
    std::function<bool(const JsonValue& params, std::shared_ptr<const void>& parsed, std::string& why)> parse;
    std::function<Result<JsonValue>(ControlOpContext& context, const void* parsed)> run;
    /** Any thread; must not block for long, read files only within a fixed bound, and reach no OpenTune
        state other than what is thread-safe by its own contract (for example AppLogger). */
    std::function<Result<JsonValue>(const ControlInstanceFacts& facts, const void* parsed)> runOffMainThread;
};

/**
 * A read method from typed functions: parse fills a Params value on the network thread, run gets it
 * on the message thread.
 */
template <typename Params>
ControlMethod controlReadMethod(std::string name, bool (*parse)(const JsonValue&, Params&, std::string&),
                                Result<JsonValue> (*run)(ControlOpContext&, const Params&))
{
    ControlMethod method;
    method.name = std::move(name);
    method.parse = [parse](const JsonValue& params, std::shared_ptr<const void>& parsed, std::string& why) {
        auto value = std::make_shared<Params>();
        if (!parse(params, *value, why))
            return false;
        parsed = std::move(value);
        return true;
    };
    method.run = [run](ControlOpContext& context, const void* parsed) {
        return run(context, *static_cast<const Params*>(parsed));
    };
    return method;
}

/**
 * A read method whose schema says x-otcp.mainThread false: parse fills a Params value and run gets it,
 * with the instance facts, on the same connection thread. Only for methods that read no project state.
 */
template <typename Params>
ControlMethod controlOffMainThreadReadMethod(std::string name, bool (*parse)(const JsonValue&, Params&, std::string&),
                                             Result<JsonValue> (*run)(const ControlInstanceFacts&, const Params&))
{
    ControlMethod method = controlReadMethod<Params>(std::move(name), parse, nullptr);
    method.mainThread = false;
    method.run = nullptr;
    method.runOffMainThread = [run](const ControlInstanceFacts& facts, const void* parsed) {
        return run(facts, *static_cast<const Params*>(parsed));
    };
    return method;
}

/** The methods the dispatcher implements. Filled once before the listener starts; read-only after. */
class ControlMethodTable
{
public:
    /** Adds a method; its name must be a method of protocol version 1 that is not yet in the table. */
    void add(ControlMethod method);
    /** The method, or nullptr when this build does not implement it. Thread-safe once filled. */
    const ControlMethod* find(std::string_view name) const;
    /** session.v1 and the capabilities of the methods added, in the order they were first added. */
    std::vector<std::string> capabilities() const;

private:
    std::vector<ControlMethod> methods_;
};

/**
 * Registers every method this build implements, one group per line (Ops/OpsRegistry.cpp). Groups that
 * later parts of the control API add have a placeholder line there.
 */
void registerControlMethods(ControlMethodTable& table);

} // namespace OpenTune
