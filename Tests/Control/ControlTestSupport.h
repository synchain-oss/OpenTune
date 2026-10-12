// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// Helpers for the control API tests: a minimal check macro, a loopback test client, a request
// handler that stands in for the dispatcher, and a server fixture with an isolated discovery
// directory under OPENTUNE_DATA_DIR (or the build directory).

#include "Control/ControlApiOptions.h"
#include "Control/ControlDiscovery.h"
#include "Control/ControlJson.h"
#include "Control/ControlProtocol.h"
#include "Control/ControlServer.h"
#include "Control/ControlSocket.h"
#include "Control/SecureRandom.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace OpenTune {
namespace ControlTest {

using Clock = std::chrono::steady_clock;

/** Time limits of the tests; generous so that a loaded build machine does not cause failures. */
constexpr int kConnectTimeoutMs = 2000;
constexpr int kSendTimeoutMs = 10000;
constexpr int kReadTimeoutMs = 5000;
constexpr int kOpenCheckMs = 150;

inline int& failureCount()
{
    static int count = 0;
    return count;
}

inline bool check(bool ok, const char* expression, const char* file, int line)
{
    if (!ok) {
        ++failureCount();
        std::cerr << "    FAILED " << std::filesystem::path(file).filename().string() << ":" << line << ": "
                  << expression << std::endl;
    }
    return ok;
}

#define CONTROL_CHECK(condition) ::OpenTune::ControlTest::check((condition), #condition, __FILE__, __LINE__)

inline void note(const std::string& message)
{
    std::cout << "    " << message << std::endl;
}

inline long long millisecondsSince(Clock::time_point start)
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - start).count();
}

inline void sleepMs(int milliseconds)
{
    std::this_thread::sleep_for(std::chrono::milliseconds(milliseconds));
}

/** Polls a condition until it holds or the timeout passes. */
inline bool waitUntil(const std::function<bool()>& condition, int timeoutMs)
{
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    while (!condition()) {
        if (Clock::now() >= deadline)
            return false;
        sleepMs(5);
    }
    return true;
}

inline std::string readFile(const std::filesystem::path& path)
{
    std::ifstream in(path, std::ios::binary);
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

/** Root for test files: OPENTUNE_DATA_DIR when set (ctest through the gates), otherwise a directory
    under the build tree. Never the user's real data directories. */
inline std::filesystem::path testDataRoot()
{
    if (const auto fromEnvironment = controlSystemEnvironment("OPENTUNE_DATA_DIR");
        fromEnvironment && !fromEnvironment->empty())
        return std::filesystem::u8path(*fromEnvironment).make_preferred();
    return std::filesystem::u8path(OPENTUNE_CONTROL_TEST_DATA_DIR).make_preferred();
}

/** A fresh, empty directory for one test case. */
inline std::filesystem::path freshDirectory(const std::string& name)
{
    static std::atomic<int> counter{0};
    const auto path =
        testDataRoot() / (name + "-" + std::to_string(controlCurrentProcessId()) + "-" + std::to_string(++counter));
    std::error_code ignored;
    std::filesystem::remove_all(path, ignored);
    std::filesystem::create_directories(path, ignored);
    return path;
}

inline std::string pathString(const std::filesystem::path& path)
{
    return path.u8string();
}

/** A loopback client with line reading and close detection. */
class TestClient
{
public:
    bool connect(int port)
    {
        socket_ = ControlSocket::connectToLoopback(port, kConnectTimeoutMs);
        buffer_.clear();
        closed_ = false;
        return socket_.isValid();
    }

    bool isConnected() const { return socket_.isValid() && !closed_; }

    bool sendRaw(std::string_view bytes, int timeoutMs = kSendTimeoutMs)
    {
        const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
        std::size_t sent = 0;
        while (sent < bytes.size()) {
            const long count = socket_.send(bytes.data() + sent, bytes.size() - sent);
            if (count == ControlSocket::failed)
                return false;
            if (count > 0) {
                sent += static_cast<std::size_t>(count);
                continue;
            }
            if (Clock::now() >= deadline)
                return false;
            socket_.poll(false, true, 50);
        }
        return true;
    }

    bool sendLine(std::string_view line) { return sendRaw(std::string(line) + "\n"); }

    /** One line without its LF; nullopt when the connection closes first or the timeout passes. */
    std::optional<std::string> readLine(int timeoutMs = kReadTimeoutMs)
    {
        const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
        for (;;) {
            const std::size_t lineFeed = buffer_.find('\n');
            if (lineFeed != std::string::npos) {
                std::string line = buffer_.substr(0, lineFeed);
                buffer_.erase(0, lineFeed + 1);
                return line;
            }
            if (closed_ || !fill(deadline))
                return std::nullopt;
        }
    }

    /**
     * Waits until the server closes the connection. Returns true when it closed within the timeout and
     * sets bytes to the number of bytes that arrived (unread buffered bytes included) before the close.
     * A reset counts as a close.
     */
    bool waitClosed(int timeoutMs, std::size_t& bytes)
    {
        const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
        while (!closed_) {
            if (!fill(deadline))
                break;
        }
        bytes = buffer_.size();
        return closed_;
    }

    /** True when the connection neither closes nor delivers data within the given time. */
    bool staysQuiet(int milliseconds)
    {
        const auto deadline = Clock::now() + std::chrono::milliseconds(milliseconds);
        while (Clock::now() < deadline) {
            if (!buffer_.empty() || closed_)
                return false;
            fill(deadline);
        }
        return buffer_.empty() && !closed_;
    }

    void close()
    {
        socket_.close();
        closed_ = true;
    }

private:
    // Reads what is available before the deadline. False on timeout or close.
    bool fill(Clock::time_point deadline)
    {
        char chunk[65536];
        for (;;) {
            const auto remaining =
                std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
            if (remaining <= 0)
                return false;
            const int ready = socket_.poll(true, false, static_cast<int>(std::min<long long>(remaining, 100)));
            if (ready < 0) {
                closed_ = true;
                return false;
            }
            if (ready == 0)
                continue;
            const long count = socket_.receive(chunk, sizeof(chunk));
            if (count == ControlSocket::wouldBlock)
                continue;
            if (count <= 0) {
                closed_ = true;
                return false;
            }
            buffer_.append(chunk, static_cast<std::size_t>(count));
            return true;
        }
    }

    ControlSocket socket_;
    std::string buffer_;
    bool closed_ = true;
};

/**
 * Stands in for the dispatcher. session.info is answered with an empty result (its real result is
 * the dispatcher's job) and with INVALID_ARGUMENT(invalid_params) when params has members. job.get is
 * held until release(), so that requests stay in flight. project.get answers with a result of
 * bigResultBytes, to produce output faster than a client reads. Everything else is answered with
 * UNSUPPORTED(capability_missing).
 */
class TestHandler : public ControlRequestHandler
{
public:
    explicit TestHandler(std::vector<std::string> capabilities = {"session.v1"})
        : capabilities_(std::move(capabilities))
    {}

    std::vector<std::string> capabilities() const override { return capabilities_; }

    void handleRequest(ControlRequest request, ControlCompletion completion) override
    {
        if (request.method == "session.info") {
            if (request.params.size() != 0)
                completion.respondError("INVALID_ARGUMENT", "invalid_params", "session.info takes no params", false);
            else
                completion.respondResult(JsonValue::object());
            return;
        }
        if (request.method == "job.get") {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                held_.push_back(completion);
            }
            heldChanged_.notify_all();
            return;
        }
        if (request.method == "project.get") {
            auto result = JsonValue::object();
            result.appendMember("pad", JsonValue::string(std::string(bigResultBytes, 'p')));
            completion.respondResult(result);
            return;
        }
        completion.respondError("UNSUPPORTED", "capability_missing", "not implemented by the test handler", false);
    }

    void serverStopping() override { ++stoppingCalls; }

    /** Waits until at least count requests are held. */
    bool waitForHeld(std::size_t count, int timeoutMs = kReadTimeoutMs)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        return heldChanged_.wait_for(lock, std::chrono::milliseconds(timeoutMs),
                                     [this, count] { return held_.size() >= count; });
    }

    /** Answers every held request with an empty result. */
    void releaseAll()
    {
        std::vector<ControlCompletion> held;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            held.swap(held_);
        }
        for (const auto& completion : held)
            completion.respondResult(JsonValue::object());
    }

    std::size_t bigResultBytes = 1024 * 1024;
    std::atomic<int> stoppingCalls{0};

private:
    std::vector<std::string> capabilities_;
    std::mutex mutex_;
    std::condition_variable heldChanged_;
    std::vector<ControlCompletion> held_;
};

inline ControlBuildIdentity testBuildIdentity()
{
    ControlBuildIdentity identity;
    identity.appVersion = "0.0.0-test";
    identity.commit = "0123456789abcdef0123456789abcdef01234567";
    identity.sourceUrl = "https://example.invalid/source";
    return identity;
}

/** A running server with an isolated discovery directory and the parsed discovery file. */
class ServerFixture
{
public:
    std::filesystem::path directory;
    std::shared_ptr<TestHandler> handler;
    std::unique_ptr<ControlServer> server;
    JsonValue discovery;
    std::string token;
    int port = 0;

    /** Log lines the server wrote (checked for secrets). */
    std::vector<std::string> logLines() const
    {
        std::lock_guard<std::mutex> lock(*logMutex_);
        return *logLines_;
    }

    bool start(const std::string& name, ControlLimits limits = {},
               std::vector<std::string> capabilities = {"session.v1"}, bool useTestHandler = true)
    {
        directory = freshDirectory(name) / "instances";
        ControlServerConfig config;
        config.discoveryDirectory = pathString(directory);
        config.build = testBuildIdentity();
        config.limits = limits;
        if (useTestHandler) {
            handler = std::make_shared<TestHandler>(std::move(capabilities));
            config.handler = handler;
        }
        auto lines = logLines_;
        auto mutex = logMutex_;
        config.log = [lines, mutex](const std::string& line) {
            std::lock_guard<std::mutex> lock(*mutex);
            lines->push_back(line);
        };
        server = std::make_unique<ControlServer>(std::move(config));
        std::string error;
        if (!CONTROL_CHECK(server->start(error))) {
            note("start failed: " + error);
            return false;
        }
        const auto parsed = parseJson(readFile(std::filesystem::u8path(server->discoveryFilePath())));
        if (!CONTROL_CHECK(parsed.ok && parsed.value.isObject()))
            return false;
        discovery = parsed.value;
        token = discovery.find("token")->text();
        port = static_cast<int>(discovery.find("port")->asDouble());
        return CONTROL_CHECK(port == server->port());
    }

    std::string helloLine(const std::string& idJson = "\"hello\"", const std::string& protocol = "1.0") const
    {
        return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson + ",\"method\":\"session.hello\",\"params\":{\"token\":\""
               + token + "\",\"protocol\":\"" + protocol
               + "\",\"client\":{\"name\":\"control-unit-tests\",\"version\":\"1.0.0\"}}}";
    }

    /** Connects and completes session.hello; returns the parsed hello response. */
    std::optional<JsonValue> authenticate(TestClient& client, const std::string& idJson = "\"hello\"")
    {
        if (!client.connect(port) || !client.sendLine(helloLine(idJson)))
            return std::nullopt;
        const auto line = client.readLine();
        if (!line)
            return std::nullopt;
        auto parsed = parseJson(*line);
        if (!parsed.ok || parsed.value.find("result") == nullptr)
            return std::nullopt;
        return parsed.value;
    }

    ~ServerFixture()
    {
        if (server)
            server->stop();
        if (handler)
            handler->releaseAll();
    }

private:
    std::shared_ptr<std::vector<std::string>> logLines_ = std::make_shared<std::vector<std::string>>();
    std::shared_ptr<std::mutex> logMutex_ = std::make_shared<std::mutex>();
};

/** The error member of a response line, or nullptr. */
inline const JsonValue* errorData(const JsonValue& response)
{
    const JsonValue* error = response.find("error");
    return error != nullptr ? error->find("data") : nullptr;
}

/** True when the line is an error response with this kind and reason (reason "" for none). */
inline bool isError(const std::optional<std::string>& line, const std::string& kind, const std::string& reason)
{
    if (!line)
        return false;
    const auto parsed = parseJson(*line);
    if (!parsed.ok)
        return false;
    const JsonValue* data = errorData(parsed.value);
    if (data == nullptr || data->find("kind") == nullptr || data->find("kind")->text() != kind)
        return false;
    const JsonValue* reasonMember = data->find("reason");
    return reason.empty() ? reasonMember == nullptr : (reasonMember != nullptr && reasonMember->text() == reason);
}

/** The id member of a response line as it was written, or "" when absent. */
inline std::string responseIdText(const std::optional<std::string>& line)
{
    if (!line)
        return {};
    const auto parsed = parseJson(*line);
    const JsonValue* id = parsed.ok ? parsed.value.find("id") : nullptr;
    if (id == nullptr)
        return {};
    return id->isString() ? "\"" + id->text() + "\"" : toJsonString(*id);
}

} // namespace ControlTest
} // namespace OpenTune
