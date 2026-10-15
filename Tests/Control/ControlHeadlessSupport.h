// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// Headless processor test framework: the JUCE message loop without a window, a re-entrant message
// pump, the isolated data directory of the test process and the process environment.
//
// The pump loops over a platform-specific "dispatch one round of messages" step. It does not use
// MessageManager::runDispatchLoop() with callAsync(stopDispatchLoop): in JUCE 9.0.3 stopDispatchLoop()
// latches for the rest of the process (every later posted message is dropped and runDispatchLoop()
// returns at once), so that pattern works only once per process.
//
// Windows and Linux: juce::detail::dispatchNextMessageOnSystemQueue(true), which dispatches one message
// and returns false at once when none is pending. JUCE defines it only for those platforms, so it
// cannot be linked on macOS.
// macOS: MessageManager::runDispatchLoopUntil(kPumpIdleMs), the public JUCE entry that runs the
// platform loop for a short time and returns. It only reports whether a quit message was posted and
// never posts one itself, so it does not engage the stopDispatchLoop() latch; the pump never calls
// stopDispatchLoop().

#include "ControlTestSupport.h"

#include "Control/ControlApiOptions.h"
#include "Control/ControlDiscovery.h"
#include "Control/ControlPathPolicy.h"

#include <juce_events/juce_events.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>

#if !JUCE_MAC
namespace juce {
namespace detail {
// JUCE's platform message loop (juce_events): dispatches one message of this thread's queue; with
// returnIfNoPendingMessages it returns false at once when none is pending.
bool dispatchNextMessageOnSystemQueue(bool returnIfNoPendingMessages);
} // namespace detail
} // namespace juce
#endif

namespace OpenTune {
namespace ControlTest {

/** Sleep of the message pump when no message is pending. */
constexpr int kPumpIdleMs = 2;

/**
 * Dispatches the messages of the calling thread, which must be the message thread, until condition()
 * holds or timeoutMs passes. Returns whether the condition holds. Re-entrant, and usable any number of
 * times per process.
 */
inline bool pumpMessagesUntil(const std::function<bool()>& condition, int timeoutMs)
{
    const auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        if (condition())
            return true;
        if (Clock::now() >= deadline)
            return false;
#if JUCE_MAC
        // Blocks for up to kPumpIdleMs while idle, so no extra sleep is needed.
        juce::MessageManager::getInstance()->runDispatchLoopUntil(kPumpIdleMs);
#else
        if (!juce::detail::dispatchNextMessageOnSystemQueue(true))
            sleepMs(kPumpIdleMs);
#endif
    }
}

/** Dispatches the messages of the calling (message) thread for the given time. */
inline void pumpMessagesFor(int milliseconds)
{
    pumpMessagesUntil([] { return false; }, milliseconds);
}

/** OPENTUNE_DATA_DIR of this process; empty when it is not set to an accepted absolute path. */
inline std::filesystem::path isolatedDataDirectory()
{
    const auto value = controlSystemEnvironment("OPENTUNE_DATA_DIR");
    if (!value || value->empty() || !controlCheckAbsolutePath(*value, controlNativePathStyle()).empty())
        return {};
    return std::filesystem::u8path(*value);
}

/** Sets a variable of the process environment, or removes it with nullopt (an empty value also
    removes it on Windows). Visible to controlSystemEnvironment and to child processes. */
inline void setEnvironmentVariable(const char* name, const std::optional<std::string>& value)
{
#if defined(_WIN32)
    // The CRT updates the operating system's environment block as well.
    _putenv_s(name, value ? value->c_str() : "");
#else
    if (value)
        ::setenv(name, value->c_str(), 1);
    else
        ::unsetenv(name);
#endif
}

/** The discovery file this process would write without OPENTUNE_DATA_DIR and --control-api-dir=
    (PROTOCOL.md section 5.1): in the user's real data folder, so no test may ever create it. */
inline std::filesystem::path realDiscoveryFileOfThisProcess()
{
    ControlApiOptions options;
    options.enabled = true;
    std::string error;
    const auto directory =
        controlResolveDiscoveryDirectory(options, controlSystemEnvironment, controlCurrentPlatform(), error);
    if (directory.empty())
        return {};
    return std::filesystem::u8path(directory) / (std::to_string(controlCurrentProcessId()) + ".json");
}

/** True when path names directory or something inside it (lexically; case-insensitive on Windows). */
inline bool isWithin(const std::filesystem::path& path, const std::filesystem::path& directory)
{
    auto normalised = [](const std::filesystem::path& p) {
        auto text = p.lexically_normal().generic_u8string();
#if defined(_WIN32)
        std::transform(text.begin(), text.end(), text.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
#endif
        while (text.size() > 1 && text.back() == '/')
            text.pop_back();
        return text;
    };
    const auto inner = normalised(path);
    const auto outer = normalised(directory);
    return !outer.empty() && inner.compare(0, outer.size(), outer) == 0
           && (inner.size() == outer.size() || inner[outer.size()] == '/');
}

} // namespace ControlTest
} // namespace OpenTune
