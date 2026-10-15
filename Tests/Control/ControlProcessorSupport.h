// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// Helpers shared by the scenarios of OpenTuneControlProcessorTests: a started processor with its control
// service, the discovery file, session.hello, and requests answered while this (the message) thread
// pumps messages. The scenarios of the dispatcher and the read methods are declared at the end and
// defined in ControlDispatcherTests.cpp.

#include "ControlHeadlessSupport.h"

#include "Control/ControlService.h"
#include "PluginProcessor.h"

#include <atomic>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>

namespace OpenTune {
namespace ControlTest {

/** From construction of the processor to a listening control API. */
constexpr int kStartTimeoutMs = 5000;
/** Time in which something that should not happen (a start, a queued function) would have happened. */
constexpr int kQuietPumpMs = 300;
/** Bound of the processor destruction while connections and waiters are busy. */
constexpr int kShutdownBoundMs = 2000;
/** Time for a client to see the close of its connection, and for a woken thread to return. */
constexpr int kCloseSeenMs = 1000;
/** Time for a waiting thread to enter ControlMessageThread::call(). */
constexpr int kWaiterSettleMs = 2000;
/** Bound of one exchange of a client thread while the message thread pumps; longer than kReadTimeoutMs. */
constexpr int kClientExchangeMs = 15000;

/** A member of an object, or a null value when absent. */
inline const JsonValue& memberOf(const JsonValue& object, const char* name)
{
    static const JsonValue none;
    const JsonValue* value = object.find(name);
    return value != nullptr ? *value : none;
}

/** The discovery file at path, parsed; checks its size limit (PROTOCOL.md section 5.3). */
inline std::optional<JsonValue> readDiscoveryFile(const std::filesystem::path& path)
{
    const auto text = readFile(path);
    CONTROL_CHECK(!text.empty() && text.size() <= 8192);
    auto parsed = parseJson(text);
    if (!CONTROL_CHECK(parsed.ok))
        return std::nullopt;
    return parsed.value;
}

inline std::string helloLine(const std::string& token)
{
    return R"({"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":")" + token
           + R"(","protocol":"1.0","client":{"name":"control-processor-tests","version":"1.0.0"}}})";
}

/** Connects and completes session.hello; returns the hello result. The listener answers session.hello
    itself, so this works without pumping messages. */
inline std::optional<JsonValue> authenticate(TestClient& client, int port, const std::string& token)
{
    if (!client.connect(port) || !client.sendLine(helloLine(token)))
        return std::nullopt;
    const auto line = client.readLine();
    if (!line)
        return std::nullopt;
    auto parsed = parseJson(*line);
    if (!parsed.ok || parsed.value.find("result") == nullptr)
        return std::nullopt;
    return *parsed.value.find("result");
}

/** Constructs a processor with the API enabled and pumps messages until it listens. */
inline std::unique_ptr<OpenTuneAudioProcessor> startedProcessor()
{
    auto processor = std::make_unique<OpenTuneAudioProcessor>();
    auto& service = processor->getControlService();
    const auto started = Clock::now();
    if (CONTROL_CHECK(pumpMessagesUntil([&service] { return service.isRunning(); }, kStartTimeoutMs)))
        note("listening " + std::to_string(millisecondsSince(started)) + " ms after construction");
    return processor;
}

/**
 * Runs exchange on a client thread while this thread, the message thread, pumps messages, so that the
 * requests it sends can run on the message thread. Returns whether it finished within timeoutMs; it
 * always joins the client thread before returning.
 */
template <typename Exchange>
bool runWhilePumping(Exchange&& exchange, int timeoutMs = kClientExchangeMs)
{
    std::atomic<bool> done{false};
    std::thread client([&exchange, &done] {
        exchange();
        done = true;
    });
    const bool finished = pumpMessagesUntil([&done] { return done.load(); }, timeoutMs);
    client.join();
    return finished;
}

/** An authenticated session of a started processor that sends requests and reads their responses. */
class ApiSession
{
public:
    /** Reads the discovery file of the service and completes session.hello. */
    bool open(const ControlService& service)
    {
        const auto discovery = readDiscoveryFile(std::filesystem::u8path(service.discoveryFilePath()));
        if (!discovery)
            return false;
        discovery_ = *discovery;
        return CONTROL_CHECK(authenticate(client_, service.port(), memberOf(discovery_, "token").text()).has_value());
    }

    /** One request and its response, sent and read on a client thread while this thread pumps messages.
        Returns the parsed response, or null when none arrived. */
    JsonValue request(const std::string& method, JsonValue params = JsonValue::object())
    {
        auto request = JsonValue::object();
        request.appendMember("jsonrpc", JsonValue::string("2.0"));
        request.appendMember("id", JsonValue::integer(++nextId_));
        request.appendMember("method", JsonValue::string(method));
        request.appendMember("params", std::move(params));
        const std::string line = toJsonString(request);
        std::optional<std::string> response;
        runWhilePumping([this, &line, &response] {
            if (client_.sendLine(line))
                response = client_.readLine();
        });
        if (!response)
            return JsonValue();
        auto parsed = parseJson(*response);
        return parsed.ok ? parsed.value : JsonValue();
    }

    /** The result of a successful response, or null. */
    JsonValue result(const std::string& method, JsonValue params = JsonValue::object())
    {
        const auto response = request(method, std::move(params));
        const JsonValue* result = response.find("result");
        if (!CONTROL_CHECK(result != nullptr))
            note(method + " failed: " + toJsonString(response));
        return result != nullptr ? *result : JsonValue();
    }

    /** True when the response is an error of this kind and reason (reason "" for none) with executed
        false, as every error of a read is. */
    bool fails(const std::string& method, JsonValue params, const std::string& kind, const std::string& reason)
    {
        const auto response = request(method, std::move(params));
        const JsonValue* data = errorData(response);
        const bool ok =
            data != nullptr && memberOf(*data, "kind").text() == kind
            && (reason.empty() ? data->find("reason") == nullptr : memberOf(*data, "reason").text() == reason)
            && memberOf(*data, "executed").isBoolean() && !memberOf(*data, "executed").asBoolean();
        if (!ok)
            note(method + ": expected " + kind + "(" + reason + "), got " + toJsonString(response));
        return ok;
    }

    const JsonValue& discovery() const noexcept { return discovery_; }
    TestClient& client() noexcept { return client_; }

private:
    TestClient client_;
    JsonValue discovery_;
    std::int64_t nextId_ = 100;
};

// Scenarios of the dispatcher and the read methods (ControlDispatcherTests.cpp).

/** session.info, project.get and the content reads through the dispatcher, with and without an editor
    bridge, including pagination, cursors, analysis states, errors and a reopened project. */
void scenarioReads();
/** Every access to OpenTune state of the operations happens on the message thread; an access from
    another thread is refused and counted. */
void scenarioThreadProbe();
/** A request waits for the message thread when the processor is destroyed: it is answered with
    SHUTTING_DOWN (or TIMEOUT with executed false) and never runs. */
void scenarioDispatchShutdown();
/** A request that does not start within dispatchTimeoutMs gets TIMEOUT(dispatch_timeout) with executed
    false and never runs later. */
void scenarioDispatchTimeout();
/** The specification's vectors of the implemented methods, against the real dispatcher. */
void scenarioVectors();
/** content.getDetails, transport.get, prefs.get and app.getLog (including the redaction of the log) against
    the real dispatcher, with the clips, analysis failures and preferences they report. */
void scenarioDetails();
/** Every method of every capability the instance reports is registered in OpsRegistry, apart from an
    explicit list of exemptions that must be empty before dev is merged. */
void scenarioCompleteness();
/** The methods run off the message thread exactly when their schema says mainThread false, and
    app.getLog answers while the message thread is held, without TIMEOUT. */
void scenarioOffMainThread();

// Scenarios of the jobs, the write envelope and import.start (ControlJobTests.cpp).

/** job.get and job.cancel: answered without the message thread, the long poll (also while the session
    sends other requests), cancellation per state, retention and eviction, and `executed` of errors. */
void scenarioJobs();
/** A job.get waits for a running job when the processor is destroyed: SHUTTING_DOWN within the shutdown
    bound, and no job work runs afterwards. */
void scenarioJobShutdown();
/** The write envelope in its four states, the IRREVERSIBLE rule, the UI snapshot and the busy checks. */
void scenarioWriteEnvelope();
/** import.start in both editing schemes and all layouts, focus and note generation, revealed tracks,
    item failures, the checks before the job, the busy checks and idempotency. */
void scenarioImport();
/** Importing after a project was opened succeeds although OpenTune reuses clip ids then. */
void scenarioImportAfterOpen();
/** A three-file import cancelled after its first commit reports the committed clip. */
void scenarioImportCancel();
/** The specification's vectors of job.get, job.cancel and import.start, against the real dispatcher. */
void scenarioJobVectors();

} // namespace ControlTest
} // namespace OpenTune
