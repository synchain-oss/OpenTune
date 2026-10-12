// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests of the control API channel: run-time options, path rules, CSPRNG, JSON, request ids,
// fixed responses, discovery and ready files, and the listener with its rules before and after
// authentication. The session vectors of the specification copy (Tests/Control/spec/otcp/v1/vectors/
// session) are read and run against a real server with a stand-in request handler.
//
// Every file goes to a fresh directory under OPENTUNE_DATA_DIR (set per test by the gates) or under
// the build directory, never to the user's real data directories.

#include "ControlTestSupport.h"

#include "Control/ControlPathPolicy.h"

#include <cmath>
#include <map>
#include <set>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

using namespace OpenTune;
using namespace OpenTune::ControlTest;

namespace {

// Timing bounds of the server tests.
constexpr int kSlowDripIntervalMs = 300;
constexpr int kHelloTimeoutLowerBoundMs = 1800;
constexpr int kHelloTimeoutUpperBoundMs = 3500;
constexpr int kPromptCloseMs = 1500;
constexpr int kStopBoundMs = 1500;
constexpr int kTestIdleTimeoutMs = 600;
constexpr int kFloodThreads = 4;
constexpr int kFloodConnectionsPerThread = 50;
constexpr int kFloodResponseBoundMs = 2000;
constexpr int kCounterSettleMs = 3000;
constexpr int kCompletionBoundMs = 200;

// Appendix A of PROTOCOL.md, with id 1.
const char* const kAuthFailedId1 =
    R"({"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"AUTH_FAILED","data":{"kind":"AUTH_FAILED","retryable":false,"detail":"authentication failed","executed":false}}})";
const char* const kProtocolMismatchId1 =
    R"({"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"PROTOCOL_MISMATCH","data":{"kind":"PROTOCOL_MISMATCH","retryable":false,"detail":"unsupported protocol major version","executed":false}}})";

ControlEnvironmentLookup environmentOf(std::map<std::string, std::string> values)
{
    return [values](const char* name) -> std::optional<std::string> {
        const auto it = values.find(name);
        if (it == values.end())
            return std::nullopt;
        return it->second;
    };
}

JsonValue parsed(const std::string& text)
{
    const auto result = parseJson(text);
    CONTROL_CHECK(result.ok);
    return result.value;
}

std::string requestLine(const std::string& idJson, const std::string& method, const std::string& paramsJson = "{}")
{
    return "{\"jsonrpc\":\"2.0\",\"id\":" + idJson + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}";
}

// --------------------------------------------------------------------------------------------------
// Options and paths
// --------------------------------------------------------------------------------------------------

void testOptions()
{
    const auto windows = ControlPathStyle::Windows;
    const auto posix = ControlPathStyle::Posix;
    {
        const auto options = parseControlApiOptions({}, environmentOf({}), windows);
        CONTROL_CHECK(!options.enabled && options.error.empty() && !options.canStart());
    }
    CONTROL_CHECK(parseControlApiOptions({}, environmentOf({{"OPENTUNE_CONTROL_API", "1"}}), windows).canStart());
    CONTROL_CHECK(!parseControlApiOptions({}, environmentOf({{"OPENTUNE_CONTROL_API", "true"}}), windows).enabled);
    CONTROL_CHECK(!parseControlApiOptions({}, environmentOf({{"OPENTUNE_CONTROL_API", "1 "}}), windows).enabled);
    CONTROL_CHECK(!parseControlApiOptions({"--control-api=1"}, environmentOf({}), windows).enabled);
    CONTROL_CHECK(parseControlApiOptions({"--control-api"}, environmentOf({}), windows).canStart());

    // While the API is off, its options are ignored (no error), but OPENTUNE_DATA_DIR is still read.
    {
        const auto options = parseControlApiOptions({"--control-api-dir=relative", "--control-api-launch-nonce=x"},
                                                    environmentOf({{"OPENTUNE_DATA_DIR", "relative"}}), windows);
        CONTROL_CHECK(!options.enabled && options.error.empty() && !options.discoveryDirectory && !options.launchNonce);
        CONTROL_CHECK(options.dataDirectory == std::optional<std::string>("relative"));
    }
    {
        // Every allowed character class, built at run time (vectors and tests never hold secret-like literals).
        const std::string nonce = std::string(8, 'a') + std::string(8, 'Z') + "09_-";
        const auto options = parseControlApiOptions({"--control-api", "--control-api-dir=C:\\Data\\instances",
                                                     "--control-api-ready-file=C:\\Data\\ready.json",
                                                     "--control-api-launch-nonce=" + nonce},
                                                    environmentOf({{"OPENTUNE_DATA_DIR", "C:\\Data"}}), windows);
        CONTROL_CHECK(options.canStart());
        CONTROL_CHECK(options.discoveryDirectory == std::optional<std::string>("C:\\Data\\instances"));
        CONTROL_CHECK(options.readyFile == std::optional<std::string>("C:\\Data\\ready.json"));
        CONTROL_CHECK(options.launchNonce == std::optional<std::string>(nonce));
    }
    CONTROL_CHECK(
        parseControlApiOptions({"--control-api", "--control-api-dir=/tmp/x"}, environmentOf({}), posix).canStart());

    const auto failsWith = [](std::vector<std::string> args, std::map<std::string, std::string> env,
                              ControlPathStyle style, const std::string& fragment) {
        args.insert(args.begin(), "--control-api");
        const auto options = parseControlApiOptions(args, environmentOf(std::move(env)), style);
        return options.enabled && !options.canStart() && options.error.find(fragment) != std::string::npos;
    };
    CONTROL_CHECK(failsWith({"--control-api-dir=relative\\dir"}, {}, windows, "path_not_absolute"));
    CONTROL_CHECK(failsWith({"--control-api-dir=/tmp/x"}, {}, windows, "path_not_absolute"));
    CONTROL_CHECK(failsWith({"--control-api-dir=C:\\a\\..\\b"}, {}, windows, "path_not_normalized"));
    CONTROL_CHECK(failsWith({"--control-api-dir="}, {}, windows, "path_not_absolute"));
    CONTROL_CHECK(failsWith({"--control-api-ready-file=\\\\server\\share\\r.json"}, {}, windows, "path_unc"));
    CONTROL_CHECK(failsWith({"--control-api-dir=relative"}, {}, posix, "path_not_absolute"));
    CONTROL_CHECK(failsWith({"--control-api-launch-nonce=short"}, {}, windows, "launch-nonce"));
    CONTROL_CHECK(failsWith({"--control-api-launch-nonce=abcdefghijklmnop!"}, {}, windows, "launch-nonce"));
    CONTROL_CHECK(failsWith({"--control-api-launch-nonce=" + std::string(129, 'a')}, {}, windows, "launch-nonce"));
    CONTROL_CHECK(
        parseControlApiOptions({"--control-api", "--control-api-launch-nonce=" + std::string(128, 'a')}, {}, windows)
            .canStart());
    CONTROL_CHECK(failsWith({"--control-api-dir=C:\\a", "--control-api-dir=C:\\b"}, {}, windows, "more than once"));
    CONTROL_CHECK(failsWith({"--control-api-dir"}, {}, windows, "unknown control API option"));
    CONTROL_CHECK(failsWith({"--control-api-dirx=C:\\a"}, {}, windows, "unknown control API option"));
    CONTROL_CHECK(failsWith({}, {{"OPENTUNE_DATA_DIR", "data"}}, windows, "OPENTUNE_DATA_DIR"));
    CONTROL_CHECK(failsWith({}, {{"OPENTUNE_DATA_DIR", ""}}, windows, "OPENTUNE_DATA_DIR"));
    // The error names the option and the rule, never the value.
    {
        const auto options =
            parseControlApiOptions({"--control-api", "--control-api-dir=C:\\private-value\\x."}, {}, windows);
        CONTROL_CHECK(!options.canStart() && options.error.find("private-value") == std::string::npos);
    }
}

void testPathPolicy()
{
    struct Case
    {
        const char* path;
        ControlPathStyle style;
        const char* reason;
    };
    const auto w = ControlPathStyle::Windows;
    const auto p = ControlPathStyle::Posix;
    const Case cases[] = {
        {"C:\\a\\b", w, ""},
        {"z:\\Music\\take 1.wav", w, ""},
        {"C:\\a\\b\x01", w, "path_invalid_character"},
        {"C:\\a\\\xff", w, "path_invalid_character"},
        {"\\\\?\\C:\\a", w, "path_device_namespace"},
        {"\\\\.\\pipe\\x", w, "path_device_namespace"},
        {"\\\\server\\share\\a", w, "path_unc"},
        {"C:a", w, "path_drive_relative"},
        {"C:", w, "path_drive_relative"},
        {"C:/a", w, "path_drive_relative"},
        {"a\\b", w, "path_not_absolute"},
        {"/a/b", w, "path_not_absolute"},
        {"", w, "path_not_absolute"},
        {"C:\\a\\b:stream", w, "path_alternate_stream"},
        {"C:\\a/b", w, "path_not_normalized"},
        {"C:\\a\\\\b", w, "path_not_normalized"},
        {"C:\\a\\.\\b", w, "path_not_normalized"},
        {"C:\\a\\..\\b", w, "path_not_normalized"},
        {"C:\\a\\", w, "path_not_normalized"},
        {"C:\\", w, "path_not_normalized"},
        {"C:\\a.", w, "path_not_normalized"},
        {"C:\\a ", w, "path_not_normalized"},
        {"C:\\a\\NUL.wav", w, "path_reserved_name"},
        {"C:\\a\\con", w, "path_reserved_name"},
        {"C:\\a\\COM1", w, "path_reserved_name"},
        {"C:\\a\\conout$", w, "path_reserved_name"},
        {"C:\\a\\nul .txt", w, "path_reserved_name"},
        {"C:\\a\\LPT\xC2\xB9", w, "path_reserved_name"},
        {"C:\\a\\COM10", w, ""},
        {"C:\\a\\console", w, ""},
        {"/a/b", p, ""},
        {"/a/b c/.hidden", p, ""},
        {"a/b", p, "path_not_absolute"},
        {"", p, "path_not_absolute"},
        {"/a//b", p, "path_not_normalized"},
        {"/a/./b", p, "path_not_normalized"},
        {"/a/../b", p, "path_not_normalized"},
        {"/a/", p, "path_not_normalized"},
        {"/", p, "path_not_normalized"},
        {"/a\x1f", p, "path_invalid_character"},
    };
    for (const auto& c : cases) {
        const auto reason = controlCheckAbsolutePath(c.path, c.style);
        if (!CONTROL_CHECK(reason == c.reason))
            note(std::string("path case expected '") + c.reason + "', got '" + reason + "'");
    }
    CONTROL_CHECK(controlJoinPath("C:\\a", "control/instances", w) == "C:\\a\\control\\instances");
    CONTROL_CHECK(controlJoinPath("/a/", "control/instances", p) == "/a/control/instances");
}

// --------------------------------------------------------------------------------------------------
// CSPRNG, JSON, ids and responses
// --------------------------------------------------------------------------------------------------

void testSecureRandom()
{
    const auto isLowerHex = [](const std::string& text) {
        return std::all_of(text.begin(), text.end(),
                           [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
    };
    const auto token = SecureRandom::hex(32);
    const auto proof = SecureRandom::hex(16);
    CONTROL_CHECK(token && token->size() == 64 && isLowerHex(*token));
    CONTROL_CHECK(proof && proof->size() == 32 && isLowerHex(*proof));
    std::set<std::string> seen;
    for (int i = 0; i < 2000; ++i)
        seen.insert(SecureRandom::hex(16).value_or(""));
    CONTROL_CHECK(seen.size() == 2000);
    // Every byte value appears in 64 KiB of output (a broken generator usually fails this).
    std::vector<unsigned char> bytes(65536);
    CONTROL_CHECK(SecureRandom::fill(bytes.data(), bytes.size()));
    std::set<unsigned char> values(bytes.begin(), bytes.end());
    CONTROL_CHECK(values.size() == 256);

    CONTROL_CHECK(SecureRandom::constantTimeEquals("abcdef", "abcdef"));
    CONTROL_CHECK(SecureRandom::constantTimeEquals("", ""));
    CONTROL_CHECK(!SecureRandom::constantTimeEquals("abcdee", "abcdef"));
    CONTROL_CHECK(!SecureRandom::constantTimeEquals("bbcdef", "abcdef"));
    CONTROL_CHECK(!SecureRandom::constantTimeEquals("abcde", "abcdef"));
    CONTROL_CHECK(!SecureRandom::constantTimeEquals("abcdefa", "abcdef"));
    CONTROL_CHECK(!SecureRandom::constantTimeEquals("", "abcdef"));
}

void testJson()
{
    const std::string compact = R"({"a":1,"b":[true,false,null],"c":"x","d":{"e":-1.5e3}})";
    const auto value = parsed(" \t" + compact + " \r");
    CONTROL_CHECK(toJsonString(value) == compact);
    CONTROL_CHECK(value.find("d")->find("e")->asDouble() == -1500.0);
    CONTROL_CHECK(parsed("1.0").asDouble() == 1.0 && parsed("1.0").text() == "1.0");
    CONTROL_CHECK(parsed("1e2").asDouble() == 100.0);

    const auto nested = [](int depth, char open, char close) {
        return std::string(static_cast<std::size_t>(depth), open) + std::string(static_cast<std::size_t>(depth), close);
    };
    CONTROL_CHECK(parseJson(nested(64, '[', ']')).ok);
    CONTROL_CHECK(!parseJson(nested(65, '[', ']')).ok);
    // Deep input fails fast instead of exhausting the stack.
    CONTROL_CHECK(!parseJson(nested(100000, '[', ']')).ok);

    const char* const invalid[] = {
        "",
        "{",
        "[1,]",
        "{\"a\":1,}",
        "01",
        "1.",
        ".5",
        "-",
        "1e",
        "+1",
        "tru",
        "nul",
        "'a'",
        "{a:1}",
        "[1 2]",
        "\"\x01\"",
        "\"\\x\"",
        "\"\\u12\"",
        "1 2",
        "\xEF\xBB\xBF{}",
        "\"\xff\"",
        "\"\xC0\xAF\"",
        "\"\xED\xA0\x80\"",
        "\"\\ud800\"",
        "\"\\udc00\"",
        "\"\\ud800\\u0041\"",
        "{\"a\":1,\"a\":2}",
    };
    for (const char* text : invalid) {
        if (!CONTROL_CHECK(!parseJson(text).ok))
            note(std::string("accepted invalid JSON: ") + text);
    }
    CONTROL_CHECK(parsed("\"\\ud834\\udd1e\"").text() == "\xF0\x9D\x84\x9E");
    CONTROL_CHECK(parsed("\"\\u00e9\\n\"").text() == "\xC3\xA9\n");

    std::string quoted;
    appendJsonQuoted(quoted, std::string("a\"b\\c\nd\x01\x7f\xC3\xA9", 11));
    CONTROL_CHECK(quoted == "\"a\\\"b\\\\c\\nd\\u0001\x7f\xC3\xA9\"");
    CONTROL_CHECK(isJsonWhitespaceOnly(" \t\r") && !isJsonWhitespaceOnly(" x"));
    CONTROL_CHECK(utf8CodePointCount("a\xC3\xA9\xF0\x9D\x84\x9E") == 3);
}

void testRequestIds()
{
    const auto idOf = [](const std::string& json) {
        const auto value = parseJson(json);
        return ControlRequestId::fromJson(&value.value);
    };
    const auto written = [](const ControlRequestId& id) {
        std::string out;
        id.appendJson(out);
        return out;
    };
    CONTROL_CHECK(idOf("1.0") && written(*idOf("1.0")) == "1");
    CONTROL_CHECK(idOf("1e2") && written(*idOf("1e2")) == "100");
    CONTROL_CHECK(idOf("0") && written(*idOf("0")) == "0");
    CONTROL_CHECK(idOf("9007199254740991") && written(*idOf("9007199254740991")) == "9007199254740991");
    CONTROL_CHECK(!idOf("9007199254740992"));
    CONTROL_CHECK(!idOf("1.5"));
    CONTROL_CHECK(!idOf("-1"));
    CONTROL_CHECK(!idOf("true"));
    CONTROL_CHECK(!idOf("null"));
    CONTROL_CHECK(!idOf("\"\""));
    CONTROL_CHECK(!ControlRequestId::fromJson(nullptr));
    std::string clefs;
    for (int i = 0; i < 128; ++i)
        clefs += "\\ud834\\udd1e";
    CONTROL_CHECK(idOf("\"" + clefs + "\"").has_value());
    CONTROL_CHECK(idOf("\"" + std::string(128, 'x') + "\"").has_value());
    CONTROL_CHECK(!idOf("\"" + std::string(129, 'x') + "\""));
    CONTROL_CHECK(idOf("1.0")->key() == idOf("1")->key());
    CONTROL_CHECK(idOf("\"1\"")->key() != idOf("1")->key());
    CONTROL_CHECK(written(*idOf("\"a\\\"b\"")) == "\"a\\\"b\"");
}

void testProtocol()
{
    const auto one = ControlRequestId::fromInteger(1);
    CONTROL_CHECK(controlAuthFailedResponse(one) == kAuthFailedId1);
    CONTROL_CHECK(controlProtocolMismatchResponse(one) == kProtocolMismatchId1);
    CONTROL_CHECK(controlAuthFailedResponse(ControlRequestId::fromString("h1")).find("\"id\":\"h1\"")
                  != std::string::npos);

    CONTROL_CHECK(controlErrorCode("INVALID_ARGUMENT", "parse_error") == -32700);
    CONTROL_CHECK(controlErrorCode("INVALID_ARGUMENT", "duplicate_id") == -32600);
    CONTROL_CHECK(controlErrorCode("INVALID_ARGUMENT", "invalid_params") == -32602);
    CONTROL_CHECK(controlErrorCode("UNSUPPORTED", "unknown_method") == -32601);
    CONTROL_CHECK(controlErrorCode("UNSUPPORTED", "capability_missing") == -32000);
    CONTROL_CHECK(controlErrorCode("INTERNAL", "") == -32603);
    {
        const auto line =
            controlErrorResponse({}, "BUSY", "request_limit", "x\xC3\xA9" + std::string(2000, 'y'), false);
        const auto value = parsed(line);
        const auto* data = errorData(value);
        CONTROL_CHECK(value.find("id")->isNull());
        CONTROL_CHECK(data->find("retryable")->asBoolean());
        CONTROL_CHECK(data->find("detail")->text().size() == 1024
                      && data->find("detail")->text().compare(0, 3, "x??") == 0);
        CONTROL_CHECK(!data->find("executed")->asBoolean());
    }
    CONTROL_CHECK(controlMethodCapability("session.info") == std::string("session.v1"));
    CONTROL_CHECK(controlMethodCapability("audio.set") == std::string("audio.device"));
    CONTROL_CHECK(controlMethodCapability("track.rename") == nullptr && controlMethodCapability("") == nullptr);

    // session.hello checks (PROTOCOL.md section 4.2), in their order.
    const std::string token(64, 'a');
    const auto verdict = [&token](const std::string& paramsJson) {
        std::string detail;
        const auto params = parseJson(paramsJson);
        return controlCheckHello(params.ok ? &params.value : nullptr, token, detail);
    };
    const std::string client = R"("client":{"name":"t","version":"1"})";
    using V = ControlHelloVerdict;
    CONTROL_CHECK(verdict("") == V::AuthFailed);
    CONTROL_CHECK(verdict("[]") == V::AuthFailed);
    CONTROL_CHECK(verdict(R"({"protocol":"1.0",)" + client + "}") == V::AuthFailed);
    CONTROL_CHECK(verdict(R"({"token":7,"protocol":"1.0",)" + client + "}") == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + std::string(64, 'b') + "\",\"protocol\":\"1.0\"," + client + "}")
                  == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + std::string(64, 'b') + "\",\"protocol\":\"99.0\"}") == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"1\"," + client + "}") == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"01.0\"," + client + "}") == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":2}") == V::AuthFailed);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"2.0\",\"other\":1}") == V::ProtocolMismatch);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"1.0\"}") == V::InvalidParams);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"1.0\"," + client + ",\"x\":1}")
                  == V::InvalidParams);
    CONTROL_CHECK(
        verdict("{\"token\":\"" + token + "\",\"protocol\":\"1.0\",\"client\":{\"name\":\"a b\",\"version\":\"1\"}}")
        == V::InvalidParams);
    CONTROL_CHECK(verdict("{\"token\":\"" + token + "\",\"protocol\":\"1.7\"," + client + "}") == V::Accepted);
}

// --------------------------------------------------------------------------------------------------
// Discovery and ready files
// --------------------------------------------------------------------------------------------------

#if defined(_WIN32)
// True when the file's DACL is protected and allows only the process user (and optionally SYSTEM).
bool isPrivateToUser(const std::filesystem::path& path, std::string& why)
{
    PACL dacl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (GetNamedSecurityInfoW(path.wstring().c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr,
                              &dacl, nullptr, &descriptor)
        != ERROR_SUCCESS) {
        why = "cannot read the security descriptor";
        return false;
    }
    HANDLE token = nullptr;
    OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token);
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> userBuffer(size);
    GetTokenInformation(token, TokenUser, userBuffer.data(), size, &size);
    CloseHandle(token);
    const PSID user = reinterpret_cast<TOKEN_USER*>(userBuffer.data())->User.Sid;

    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    GetSecurityDescriptorControl(descriptor, &control, &revision);
    bool ok = true;
    int userEntries = 0;
    if ((control & SE_DACL_PROTECTED) == 0) {
        why = "the DACL is not protected from inheritance";
        ok = false;
    } else if (dacl == nullptr) {
        why = "there is no DACL (everyone has access)";
        ok = false;
    }
    for (DWORD i = 0; ok && i < dacl->AceCount; ++i) {
        void* ace = nullptr;
        GetAce(dacl, i, &ace);
        const auto* header = static_cast<ACE_HEADER*>(ace);
        if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE) != 0) {
            why = "an entry is not an explicit allow entry";
            ok = false;
            break;
        }
        const PSID sid = &static_cast<ACCESS_ALLOWED_ACE*>(ace)->SidStart;
        if (EqualSid(sid, user))
            ++userEntries;
        else if (!IsWellKnownSid(sid, WinLocalSystemSid)) {
            why = "an entry grants access to an account other than the user and SYSTEM";
            ok = false;
        }
    }
    if (ok && userEntries == 0) {
        why = "no entry for the user";
        ok = false;
    }
    LocalFree(descriptor);
    return ok;
}
#else
bool isPrivateToUser(const std::filesystem::path& path, std::string& why)
{
    struct stat info
    {};
    if (::stat(path.c_str(), &info) != 0 || (info.st_mode & 0777) != 0600) {
        why = "the file mode is not 0600";
        return false;
    }
    return true;
}
#endif

void testDiscoveryDirectoryResolution()
{
    std::string error;
    ControlApiOptions options;
    options.enabled = true;
    const auto none = environmentOf({});
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options,
                                                   environmentOf({{"LOCALAPPDATA", "C:\\Users\\u\\AppData\\Local"}}),
                                                   ControlPlatform::Windows, error)
                  == "C:\\Users\\u\\AppData\\Local\\OpenTune\\control\\instances");
    CONTROL_CHECK(
        controlResolveDiscoveryDirectory(options, environmentOf({{"HOME", "/Users/u"}}), ControlPlatform::MacOS, error)
        == "/Users/u/Library/Application Support/OpenTune/control/instances");
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options, environmentOf({{"HOME", "/home/u"}}),
                                                   ControlPlatform::OtherPosix, error)
                  == "/home/u/.local/state/OpenTune/control/instances");
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options,
                                                   environmentOf({{"HOME", "/home/u"}, {"XDG_STATE_HOME", "/state"}}),
                                                   ControlPlatform::OtherPosix, error)
                  == "/state/OpenTune/control/instances");
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options, none, ControlPlatform::Windows, error).empty()
                  && !error.empty());

    options.dataDirectory = "C:\\Data";
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options, none, ControlPlatform::Windows, error)
                  == "C:\\Data\\control\\instances");
    options.discoveryDirectory = "C:\\Explicit";
    CONTROL_CHECK(controlResolveDiscoveryDirectory(options, none, ControlPlatform::Windows, error) == "C:\\Explicit");
}

void testDiscoveryFiles()
{
    CONTROL_CHECK(controlValidateBuildIdentity(testBuildIdentity()).empty());
    {
        auto identity = testBuildIdentity();
        identity.commit = "0123";
        CONTROL_CHECK(!controlValidateBuildIdentity(identity).empty());
        identity = testBuildIdentity();
        identity.sourceUrl = "http://example.invalid";
        CONTROL_CHECK(!controlValidateBuildIdentity(identity).empty());
        identity = testBuildIdentity();
        identity.appVersion.clear();
        CONTROL_CHECK(!controlValidateBuildIdentity(identity).empty());
    }

    const auto root = freshDirectory("discovery");
    const auto directory = root / "a" / "b" / "instances";
    ControlDiscovery discovery(pathString(directory));
    std::string error;
    CONTROL_CHECK(discovery.prepareDirectory(error));
    CONTROL_CHECK(std::filesystem::is_directory(directory));

    ControlDiscoveryRecord record;
    record.pid = controlCurrentProcessId();
    record.processStartTimeMs = controlProcessStartTimeMs();
    record.instanceId = SecureRandom::hex(16).value_or("");
    record.port = 4242;
    record.token = SecureRandom::hex(32).value_or("");
    record.serverProof = SecureRandom::hex(16).value_or("");
    record.launchNonce = std::string(18, 'n');
    record.build = testBuildIdentity();
    record.startedAtMs = controlNowMs();
    CONTROL_CHECK(record.processStartTimeMs > 0 && record.processStartTimeMs <= record.startedAtMs);
    CONTROL_CHECK(discovery.publish(record, error));

    const auto file = std::filesystem::u8path(discovery.filePath());
    CONTROL_CHECK(file.filename().string() == std::to_string(record.pid) + ".json");
    const auto content = readFile(file);
    CONTROL_CHECK(content.size() <= 8192);
    const auto json = parsed(content);
    // Exactly the members of the closed schema, in schema order.
    const char* const members[] = {"protocolMajors", "pid",         "processStartTimeMs", "instanceId", "port",
                                   "token",          "serverProof", "launchNonce",        "appVersion", "build",
                                   "buildTag",       "sourceUrl",   "startedAtMs",        "flavor"};
    CONTROL_CHECK(json.size() == std::size(members));
    for (std::size_t i = 0; i < json.size() && i < std::size(members); ++i)
        CONTROL_CHECK(json.keyAt(i) == members[i]);
    CONTROL_CHECK(toJsonString(*json.find("protocolMajors")) == "[1]");
    CONTROL_CHECK(json.find("pid")->asDouble() == static_cast<double>(record.pid));
    CONTROL_CHECK(json.find("token")->text() == record.token && json.find("token")->text().size() == 64);
    CONTROL_CHECK(json.find("serverProof")->text().size() == 32 && json.find("instanceId")->text().size() == 32);
    CONTROL_CHECK(json.find("launchNonce")->text() == *record.launchNonce);
    CONTROL_CHECK(toJsonString(*json.find("build"))
                  == R"({"commit":"0123456789abcdef0123456789abcdef01234567","tag":null})");
    CONTROL_CHECK(json.find("buildTag")->isNull() && json.find("flavor")->text() == "standalone");
    std::string why;
    if (!CONTROL_CHECK(isPrivateToUser(file, why)))
        note("discovery file: " + why);
    // Only the final file remains: no temporary file is left behind.
    std::size_t entries = 0;
    for ([[maybe_unused]] const auto& entry : std::filesystem::directory_iterator(directory))
        ++entries;
    CONTROL_CHECK(entries == 1);

    const auto ready = root / "ready.json";
    CONTROL_CHECK(
        controlWritePrivateFile(pathString(ready), controlReadyFileContent(record.pid, record.instanceId), error));
    CONTROL_CHECK(readFile(ready)
                  == "{\"pid\":" + std::to_string(record.pid) + ",\"instanceId\":\"" + record.instanceId + "\"}");
    if (!CONTROL_CHECK(isPrivateToUser(ready, why)))
        note("ready file: " + why);
    // Replacing an existing file keeps the protection of the new file.
    CONTROL_CHECK(controlWritePrivateFile(pathString(ready), "{}", error) && readFile(ready) == "{}");
    CONTROL_CHECK(isPrivateToUser(ready, why));

    discovery.withdraw();
    CONTROL_CHECK(!std::filesystem::exists(file));

#if !defined(_WIN32)
    struct stat info
    {};
    CONTROL_CHECK(::stat(directory.c_str(), &info) == 0 && (info.st_mode & 0777) == 0700);
    // A directory writable by others and a symbolic link are refused.
    const auto open = root / "open";
    std::filesystem::create_directories(open);
    ::chmod(open.c_str(), 0777);
    ControlDiscovery refused(pathString(open));
    CONTROL_CHECK(!refused.prepareDirectory(error));
    const auto link = root / "link";
    std::filesystem::create_directory_symlink(directory, link);
    ControlDiscovery viaLink(pathString(link));
    CONTROL_CHECK(!viaLink.prepareDirectory(error));
#endif
}

// --------------------------------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------------------------------

void testServerStartAndHello()
{
    ServerFixture fixture;
    if (!fixture.start("hello", {}, {}, false))
        return;
    const auto& discovery = fixture.discovery;
    CONTROL_CHECK(discovery.find("instanceId")->text() == fixture.server->instanceId());

    TestClient client;
    const auto hello = fixture.authenticate(client, "1");
    if (!CONTROL_CHECK(hello.has_value()))
        return;
    const auto& result = *hello->find("result");
    CONTROL_CHECK(result.find("protocol")->text() == "1.0");
    CONTROL_CHECK(result.find("instanceId")->text() == discovery.find("instanceId")->text());
    CONTROL_CHECK(result.find("pid")->asDouble() == discovery.find("pid")->asDouble());
    CONTROL_CHECK(result.find("serverProof")->text() == discovery.find("serverProof")->text());
    CONTROL_CHECK(result.find("appVersion")->text() == discovery.find("appVersion")->text());
    CONTROL_CHECK(toJsonString(*result.find("capabilities")) == R"(["session.v1"])");
    CONTROL_CHECK(toJsonString(*result.find("limits")) == toJsonString(controlLimitsToJson({})));
    CONTROL_CHECK(fixture.server->sessionCount() == 1);

    // Without a dispatcher every defined method other than session.hello is "not implemented".
    CONTROL_CHECK(client.sendLine(requestLine("2", "session.info")));
    CONTROL_CHECK(isError(client.readLine(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(client.sendLine(requestLine("3", "project.get")));
    CONTROL_CHECK(isError(client.readLine(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(client.sendLine(requestLine("4", "nope")));
    CONTROL_CHECK(isError(client.readLine(), "UNSUPPORTED", "unknown_method"));
    CONTROL_CHECK(client.staysQuiet(kOpenCheckMs));

    // The token and the server proof never reach the log.
    for (const auto& line : fixture.logLines())
        CONTROL_CHECK(line.find(fixture.token) == std::string::npos
                      && line.find(discovery.find("serverProof")->text()) == std::string::npos);
}

/** Expects the server to close the connection without sending a byte, within boundMs. */
bool closesSilently(TestClient& client, int boundMs)
{
    std::size_t bytes = 0;
    const bool closed = client.waitClosed(boundMs, bytes);
    return CONTROL_CHECK(closed) && CONTROL_CHECK(bytes == 0);
}

void testBeforeAuthentication()
{
    ServerFixture fixture;
    if (!fixture.start("preauth"))
        return;
    const auto port = fixture.port;

    // A browser's cross-protocol request: closed without a byte.
    {
        TestClient client;
        CONTROL_CHECK(client.connect(port));
        CONTROL_CHECK(client.sendRaw("POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}\n"));
        closesSilently(client, kPromptCloseMs);
    }
    // Other first lines that are not a session.hello request.
    const std::string notHello[] = {
        "[" + fixture.helloLine() + "]",
        R"({"jsonrpc":"2.0","method":"session.hello","params":{}})",
        requestLine("1", "session.info"),
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session.hello\",\"params\":[]}",
        "{not json",
        "",
    };
    for (const auto& line : notHello) {
        TestClient client;
        CONTROL_CHECK(client.connect(port));
        CONTROL_CHECK(client.sendLine(line));
        closesSilently(client, kPromptCloseMs);
    }
    // 9 KiB without an LF: closed long before the hello timeout.
    {
        TestClient client;
        CONTROL_CHECK(client.connect(port));
        const auto started = Clock::now();
        CONTROL_CHECK(client.sendRaw(std::string(9 * 1024, 'a')));
        closesSilently(client, kPromptCloseMs);
        CONTROL_CHECK(millisecondsSince(started) < kHelloTimeoutLowerBoundMs);
    }
    // Slow drip: a valid hello sent one byte at a time never completes within helloTimeoutMs.
    {
        TestClient client;
        CONTROL_CHECK(client.connect(port));
        const auto started = Clock::now();
        const auto line = fixture.helloLine();
        std::size_t bytes = 0;
        bool closed = false;
        for (std::size_t i = 0; i < line.size() && !closed; ++i) {
            client.sendRaw(line.substr(i, 1));
            closed = client.waitClosed(kSlowDripIntervalMs, bytes);
        }
        const auto elapsed = millisecondsSince(started);
        CONTROL_CHECK(closed && bytes == 0);
        if (!CONTROL_CHECK(elapsed >= kHelloTimeoutLowerBoundMs && elapsed <= kHelloTimeoutUpperBoundMs))
            note("slow drip closed after " + std::to_string(elapsed) + " ms");
    }
    CONTROL_CHECK(waitUntil([&] { return fixture.server->pendingConnectionCount() == 0; }, kCounterSettleMs));
}

void testHelloFailures()
{
    ServerFixture fixture;
    if (!fixture.start("hello-failures"))
        return;
    const auto sendFirstLine = [&fixture](const std::string& line, std::optional<std::string>& response) {
        TestClient client;
        if (!client.connect(fixture.port) || !client.sendLine(line))
            return false;
        response = client.readLine();
        std::size_t bytes = 0;
        return client.waitClosed(kPromptCloseMs, bytes) && bytes == 0;
    };
    const std::string wrongToken = std::string(fixture.token).replace(0, 1, fixture.token[0] == 'a' ? "b" : "a");
    const std::string client = R"("client":{"name":"t","version":"1"})";
    std::optional<std::string> response;

    CONTROL_CHECK(sendFirstLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session.hello\",\"params\":{\"token\":\""
                                    + wrongToken + "\",\"protocol\":\"1.0\"," + client + "}}",
                                response));
    CONTROL_CHECK(response == std::optional<std::string>(kAuthFailedId1));
    CONTROL_CHECK(sendFirstLine(
        R"({"jsonrpc":"2.0","id":1,"method":"session.hello","params":{"token":"not-a-token","protocol":"1.0"}})",
        response));
    CONTROL_CHECK(response == std::optional<std::string>(kAuthFailedId1));
    CONTROL_CHECK(sendFirstLine(R"({"jsonrpc":"2.0","id":1e0,"method":"session.hello"})", response));
    CONTROL_CHECK(response == std::optional<std::string>(kAuthFailedId1));
    CONTROL_CHECK(sendFirstLine(fixture.helloLine("1", "99.0"), response));
    CONTROL_CHECK(response == std::optional<std::string>(kProtocolMismatchId1));
    CONTROL_CHECK(
        sendFirstLine("{\"jsonrpc\":\"2.0\",\"id\":\"h\",\"method\":\"session.hello\",\"params\":{\"token\":\""
                          + fixture.token + "\",\"protocol\":\"1.0\"}}",
                      response));
    CONTROL_CHECK(isError(response, "INVALID_ARGUMENT", "invalid_params") && responseIdText(response) == "\"h\"");
    CONTROL_CHECK(sendFirstLine("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session.hello\",\"params\":{\"token\":\""
                                    + fixture.token + "\",\"protocol\":\"1.0\"," + client + ",\"extra\":true}}",
                                response));
    CONTROL_CHECK(isError(response, "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(fixture.server->sessionCount() == 0);

    // A second hello on a session is refused and closes the connection.
    TestClient session;
    CONTROL_CHECK(fixture.authenticate(session).has_value());
    CONTROL_CHECK(session.sendLine(fixture.helloLine("2")));
    CONTROL_CHECK(isError(session.readLine(), "INVALID_ARGUMENT", "hello_repeated"));
    closesSilently(session, kPromptCloseMs);
    CONTROL_CHECK(waitUntil([&] { return fixture.server->sessionCount() == 0; }, kCounterSettleMs));
}

void testConnectionLimits()
{
    ServerFixture fixture;
    if (!fixture.start("limits"))
        return;
    // Four sessions; the fifth hello gets BUSY(session_limit).
    std::vector<TestClient> sessions(4);
    for (auto& session : sessions)
        CONTROL_CHECK(fixture.authenticate(session).has_value());
    {
        TestClient fifth;
        CONTROL_CHECK(fifth.connect(fixture.port) && fifth.sendLine(fixture.helloLine("5")));
        const auto response = fifth.readLine();
        CONTROL_CHECK(isError(response, "BUSY", "session_limit"));
        CONTROL_CHECK(response && parsed(*response).find("error")->find("data")->find("retryable")->asBoolean());
        closesSilently(fifth, kPromptCloseMs);
    }
    sessions[0].close();
    CONTROL_CHECK(waitUntil([&] { return fixture.server->sessionCount() == 3; }, kCounterSettleMs));
    CONTROL_CHECK(fixture.authenticate(sessions[0]).has_value());

    // Eight silent connections wait for authentication; the ninth is closed at once.
    std::vector<TestClient> waiting(8);
    for (auto& client : waiting)
        CONTROL_CHECK(client.connect(fixture.port));
    CONTROL_CHECK(waitUntil([&] { return fixture.server->pendingConnectionCount() == 8; }, kCounterSettleMs));
    TestClient ninth;
    CONTROL_CHECK(ninth.connect(fixture.port));
    closesSilently(ninth, 1000);
    CONTROL_CHECK(waiting.front().staysQuiet(kOpenCheckMs));
    // The sessions still work.
    for (std::size_t i = 0; i < sessions.size(); ++i) {
        CONTROL_CHECK(sessions[i].sendLine(requestLine(std::to_string(10 + i), "session.info")));
        CONTROL_CHECK(responseIdText(sessions[i].readLine()) == std::to_string(10 + i));
    }
}

void testFloodDoesNotDisturbSessions()
{
    ServerFixture fixture;
    if (!fixture.start("flood"))
        return;
    TestClient session;
    CONTROL_CHECK(fixture.authenticate(session).has_value());

    std::vector<std::thread> flooders;
    for (int t = 0; t < kFloodThreads; ++t) {
        flooders.emplace_back([&fixture, t] {
            for (int i = 0; i < kFloodConnectionsPerThread; ++i) {
                TestClient client;
                if (!client.connect(fixture.port))
                    continue;
                if ((i + t) % 3 == 0)
                    client.sendRaw("GET / HTTP/1.1\r\n\r\n");
                else if ((i + t) % 3 == 1)
                    client.sendRaw(std::string(1000, 'x'));
                client.close();
            }
        });
    }
    long long slowest = 0;
    for (int i = 0; i < 20; ++i) {
        const auto started = Clock::now();
        CONTROL_CHECK(session.sendLine(requestLine(std::to_string(i), "session.info")));
        CONTROL_CHECK(responseIdText(session.readLine(kFloodResponseBoundMs)) == std::to_string(i));
        slowest = std::max(slowest, millisecondsSince(started));
    }
    for (auto& flooder : flooders)
        flooder.join();
    note("slowest session response during the flood: " + std::to_string(slowest) + " ms");
    CONTROL_CHECK(slowest < kFloodResponseBoundMs);
    CONTROL_CHECK(fixture.server->sessionCount() == 1);
    CONTROL_CHECK(waitUntil([&] { return fixture.server->pendingConnectionCount() == 0; }, kCounterSettleMs));
}

void testInFlightRules()
{
    ServerFixture fixture;
    if (!fixture.start("in-flight", {}, {"session.v1", "jobs.v1"}))
        return;
    TestClient session;
    CONTROL_CHECK(fixture.authenticate(session).has_value());

    // A request whose id equals one in flight gets duplicate_id with id null; 7.0 equals 7, "7" does not.
    CONTROL_CHECK(session.sendLine(requestLine("7", "job.get")));
    CONTROL_CHECK(fixture.handler->waitForHeld(1));
    CONTROL_CHECK(session.sendRaw("{\"jsonrpc\":\"2.0\",\"id\":7.0,\"method\":\"session.info\",\"params\":{}}\n"));
    const auto duplicate = session.readLine();
    CONTROL_CHECK(isError(duplicate, "INVALID_ARGUMENT", "duplicate_id") && responseIdText(duplicate) == "null");
    CONTROL_CHECK(session.sendLine(requestLine("\"7\"", "session.info")));
    CONTROL_CHECK(responseIdText(session.readLine()) == "\"7\"");
    fixture.handler->releaseAll();
    CONTROL_CHECK(responseIdText(session.readLine()) == "7");

    // At most maxInFlightPerSession requests in flight; the next gets BUSY(request_limit), not executed.
    const int limit = ControlLimits{}.maxInFlightPerSession;
    for (int i = 0; i < limit; ++i)
        CONTROL_CHECK(session.sendLine(requestLine(std::to_string(100 + i), "job.get")));
    CONTROL_CHECK(fixture.handler->waitForHeld(static_cast<std::size_t>(limit)));
    CONTROL_CHECK(session.sendLine(requestLine("200", "session.info")));
    const auto busy = session.readLine();
    CONTROL_CHECK(isError(busy, "BUSY", "request_limit") && responseIdText(busy) == "200");
    // Completing from another thread (in OpenTune the message thread) never waits for the network.
    const auto releaseStarted = Clock::now();
    fixture.handler->releaseAll();
    CONTROL_CHECK(millisecondsSince(releaseStarted) < kCompletionBoundMs);
    std::set<std::string> answered;
    for (int i = 0; i < limit; ++i)
        answered.insert(responseIdText(session.readLine()));
    CONTROL_CHECK(answered.size() == static_cast<std::size_t>(limit) && answered.count("100") == 1);

    // A client that disconnects with a request in flight: the late response is discarded.
    {
        TestClient leaving;
        CONTROL_CHECK(fixture.authenticate(leaving).has_value());
        CONTROL_CHECK(leaving.sendLine(requestLine("1", "job.get")));
        CONTROL_CHECK(fixture.handler->waitForHeld(1));
        leaving.close();
        CONTROL_CHECK(waitUntil([&] { return fixture.server->sessionCount() == 1; }, kCounterSettleMs));
        fixture.handler->releaseAll();
    }
    // A client that disconnects in the middle of a line before authenticating.
    {
        TestClient leaving;
        CONTROL_CHECK(leaving.connect(fixture.port) && leaving.sendRaw("{\"jsonrpc\":\"2.0\",\"id\":1,"));
        leaving.close();
        CONTROL_CHECK(waitUntil([&] { return fixture.server->pendingConnectionCount() == 0; }, kCounterSettleMs));
    }
    CONTROL_CHECK(session.sendLine(requestLine("300", "session.info")));
    CONTROL_CHECK(responseIdText(session.readLine()) == "300");
}

void testLineLimits()
{
    ServerFixture fixture;
    if (!fixture.start("lines"))
        return;
    const auto maxLine = static_cast<std::size_t>(ControlLimits{}.maxLineBytes);
    TestClient session;
    CONTROL_CHECK(fixture.authenticate(session).has_value());
    // A line of exactly maxLineBytes is read (and is a parse error); the session stays open.
    CONTROL_CHECK(session.sendRaw(std::string(maxLine, 'a') + "\n"));
    CONTROL_CHECK(isError(session.readLine(), "INVALID_ARGUMENT", "parse_error"));
    CONTROL_CHECK(session.sendLine(requestLine("1", "session.info")));
    CONTROL_CHECK(responseIdText(session.readLine()) == "1");
    // One byte more without an LF: line_too_long with id null, then the connection closes.
    CONTROL_CHECK(session.sendRaw(std::string(maxLine + 1, 'a')));
    const auto tooLong = session.readLine();
    CONTROL_CHECK(isError(tooLong, "INVALID_ARGUMENT", "line_too_long") && responseIdText(tooLong) == "null");
    closesSilently(session, kPromptCloseMs);
}

void testIdleTimeout()
{
    ControlLimits limits;
    limits.idleTimeoutMs = kTestIdleTimeoutMs;
    ServerFixture fixture;
    if (!fixture.start("idle", limits, {"session.v1", "jobs.v1"}))
        return;
    {
        TestClient session;
        CONTROL_CHECK(fixture.authenticate(session).has_value());
        const auto started = Clock::now();
        closesSilently(session, kTestIdleTimeoutMs * 4);
        CONTROL_CHECK(millisecondsSince(started) >= kTestIdleTimeoutMs - 50);
    }
    // Not idle while a request is in flight.
    TestClient session;
    CONTROL_CHECK(fixture.authenticate(session).has_value());
    CONTROL_CHECK(session.sendLine(requestLine("1", "job.get")));
    CONTROL_CHECK(fixture.handler->waitForHeld(1));
    CONTROL_CHECK(session.staysQuiet(kTestIdleTimeoutMs * 2));
    fixture.handler->releaseAll();
    CONTROL_CHECK(responseIdText(session.readLine()) == "1");
    closesSilently(session, kTestIdleTimeoutMs * 4);
}

void testStopWithBusyConnections()
{
    ServerFixture fixture;
    if (!fixture.start("stop", {}, {"session.v1", "jobs.v1", "read.v1"}))
        return;
    // Three sessions with a request in flight, one session that never reads its large responses, and
    // four connections that never authenticate.
    std::vector<TestClient> sessions(4);
    for (std::size_t i = 0; i < 3; ++i) {
        CONTROL_CHECK(fixture.authenticate(sessions[i]).has_value());
        CONTROL_CHECK(sessions[i].sendLine(requestLine("1", "job.get")));
    }
    CONTROL_CHECK(fixture.handler->waitForHeld(3));
    CONTROL_CHECK(fixture.authenticate(sessions[3]).has_value());
    for (int i = 0; i < 12; ++i)
        CONTROL_CHECK(sessions[3].sendLine(requestLine(std::to_string(i), "project.get")));
    std::vector<TestClient> silent(4);
    for (auto& client : silent)
        CONTROL_CHECK(client.connect(fixture.port));
    CONTROL_CHECK(waitUntil([&] { return fixture.server->pendingConnectionCount() == 4; }, kCounterSettleMs));
    sleepMs(200);

    const auto discoveryFile = std::filesystem::u8path(fixture.server->discoveryFilePath());
    CONTROL_CHECK(std::filesystem::exists(discoveryFile));
    const auto started = Clock::now();
    fixture.server->stop();
    const auto elapsed = millisecondsSince(started);
    note("stop() with busy connections took " + std::to_string(elapsed) + " ms");
    CONTROL_CHECK(elapsed < kStopBoundMs);
    CONTROL_CHECK(!fixture.server->isRunning());
    CONTROL_CHECK(!std::filesystem::exists(discoveryFile));
    CONTROL_CHECK(fixture.handler->stoppingCalls == 1);
    CONTROL_CHECK(fixture.server->sessionCount() == 0 && fixture.server->pendingConnectionCount() == 0);
    for (auto& client : silent) {
        std::size_t bytes = 0;
        CONTROL_CHECK(client.waitClosed(kPromptCloseMs, bytes) && bytes == 0);
    }
    for (std::size_t i = 0; i < 3; ++i) {
        std::size_t bytes = 0;
        CONTROL_CHECK(sessions[i].waitClosed(kPromptCloseMs, bytes));
    }
    // Responses after the stop are discarded; stop() is idempotent; a stopped server cannot restart.
    fixture.handler->releaseAll();
    fixture.server->stop();
    std::string error;
    CONTROL_CHECK(!fixture.server->start(error));
    TestClient late;
    CONTROL_CHECK(!late.connect(fixture.port) || closesSilently(late, kPromptCloseMs));
}

void testStartFailures()
{
    const auto root = freshDirectory("start-failure");
    // The discovery directory cannot be created because a file is in the way.
    {
        std::ofstream(root / "file") << "x";
        ControlServerConfig config;
        config.discoveryDirectory = pathString(root / "file" / "instances");
        config.build = testBuildIdentity();
        ControlServer server(config);
        std::string error;
        CONTROL_CHECK(!server.start(error) && !error.empty());
        CONTROL_CHECK(!server.isRunning() && server.port() == 0);
    }
    // An identity that the discovery schema would reject.
    {
        ControlServerConfig config;
        config.discoveryDirectory = pathString(root / "instances");
        config.build = testBuildIdentity();
        config.build.commit = "not-a-commit";
        ControlServer server(config);
        std::string error;
        CONTROL_CHECK(!server.start(error) && !error.empty());
        CONTROL_CHECK(!std::filesystem::exists(root / "instances"));
    }
    // The ready file is written after the discovery file; a ready-file failure is only logged.
    {
        ControlServerConfig config;
        config.discoveryDirectory = pathString(root / "instances");
        config.readyFile = pathString(root / "ready.json");
        config.build = testBuildIdentity();
        ControlServer server(config);
        std::string error;
        CONTROL_CHECK(server.start(error));
        const auto ready = parsed(readFile(root / "ready.json"));
        CONTROL_CHECK(ready.find("instanceId")->text() == server.instanceId() && ready.size() == 2);
        server.stop();
        CONTROL_CHECK(!std::filesystem::exists(std::filesystem::u8path(server.discoveryFilePath())));

        config.readyFile = pathString(root / "missing" / "ready.json");
        ControlServer second(config);
        CONTROL_CHECK(second.start(error) && second.isRunning());
    }
}

// --------------------------------------------------------------------------------------------------
// Session vectors of the specification copy
// --------------------------------------------------------------------------------------------------

/**
 * Runs one vector of Tests/Control/spec/otcp/v1/vectors (format: vectors/README.md) against a fresh
 * server. Implements the steps, the matchers and the plain-integer check of response ids.
 */
class VectorRunner
{
public:
    explicit VectorRunner(const JsonValue& vector) : vector_(vector) {}

    /** Empty on success, otherwise what went wrong. */
    std::string run()
    {
        if (!fixture_.start("vector"))
            return "the server did not start";
        for (std::size_t i = 0; i < fixture_.discovery.size(); ++i)
            bindings_["discovery." + fixture_.discovery.keyAt(i)] = fixture_.discovery.at(i);
        std::string wrong;
        do {
            wrong = SecureRandom::hex(fixture_.token.size() / 2).value_or("");
        } while (wrong == fixture_.token);
        bindings_["runner.wrongToken"] = JsonValue::string(wrong);

        auto& main = connections_["main"];
        if (!main.connect(fixture_.port))
            return "cannot connect";
        if (vector_.find("session")->text() == "authenticated") {
            if (!main.sendLine(fixture_.helloLine("\"runner.hello\"")) || !isResult(main.readLine()))
                return "the runner's session.hello failed";
        }
        lastStepEnd_ = Clock::now();
        if (vector_.find("type")->text() == "request")
            return runRequest();
        const JsonValue& steps = *vector_.find("steps");
        for (std::size_t i = 0; i < steps.size(); ++i) {
            const std::string failure = runStep(steps.at(i));
            if (!failure.empty())
                return "step " + std::to_string(i + 1) + ": " + failure;
            lastStepEnd_ = Clock::now();
        }
        return {};
    }

private:
    static bool isResult(const std::optional<std::string>& line)
    {
        return line && parseJson(*line).ok && parseJson(*line).value.find("result") != nullptr;
    }

    std::string runRequest()
    {
        auto& main = connections_["main"];
        std::string failure;
        const auto request = substitute(*vector_.find("request"), failure);
        if (!failure.empty())
            return failure;
        if (!main.sendLine(toJsonString(request)))
            return "cannot send the request";
        failure = expectLine(main, *vector_.find("response"));
        if (!failure.empty())
            return failure;
        std::size_t bytes = 0;
        if (vector_.find("connectionAfter")->text() == "closed")
            return main.waitClosed(kReadTimeoutMs, bytes) && bytes == 0 ? std::string() : "the connection stayed open";
        return main.staysQuiet(kOpenCheckMs) ? std::string() : "the connection closed or sent more";
    }

    std::string runStep(const JsonValue& step)
    {
        const JsonValue* connectionName = step.find("connection");
        auto& connection = connections_[connectionName != nullptr ? connectionName->text() : "main"];
        if (const JsonValue* name = step.find("connect"))
            return connections_[name->text()].connect(fixture_.port) ? std::string() : "cannot connect";
        if (const JsonValue* value = step.find("send")) {
            std::string failure;
            const auto resolved = substitute(*value, failure);
            if (!failure.empty())
                return failure;
            return connection.sendLine(toJsonString(resolved)) ? std::string() : "send failed";
        }
        if (const JsonValue* text = step.find("sendRaw"))
            return connection.sendRaw(text->text()) ? std::string() : "send failed";
        if (const JsonValue* hex = step.find("sendHex")) {
            std::string bytes;
            for (std::size_t i = 0; i + 1 < hex->text().size(); i += 2)
                bytes += static_cast<char>(std::stoi(hex->text().substr(i, 2), nullptr, 16));
            return connection.sendRaw(bytes) ? std::string() : "send failed";
        }
        if (const JsonValue* filled = step.find("sendFilled")) {
            std::string bytes = filled->find("head")->text();
            const auto total = static_cast<std::size_t>(filled->find("bytes")->asDouble());
            bytes.append(total - bytes.size(), filled->find("fill")->text()[0]);
            bytes += filled->find("tail")->text();
            return connection.sendRaw(bytes) ? std::string() : "send failed";
        }
        if (const JsonValue* expected = step.find("expect"))
            return expectLine(connection, *expected);
        if (const JsonValue* closed = step.find("expectClosed")) {
            const JsonValue* within = closed->find("withinMs");
            const int bound = within != nullptr ? static_cast<int>(within->asDouble()) : kReadTimeoutMs;
            const int remaining = std::max(0, bound - static_cast<int>(millisecondsSince(lastStepEnd_)));
            std::size_t bytes = 0;
            if (!connection.waitClosed(remaining, bytes))
                return "the connection did not close within " + std::to_string(bound) + " ms";
            const JsonValue* noBytes = closed->find("noBytes");
            if (noBytes != nullptr && noBytes->asBoolean() && bytes != 0)
                return "bytes arrived before the close";
            return {};
        }
        if (const JsonValue* pause = step.find("pauseMs")) {
            sleepMs(static_cast<int>(pause->asDouble()));
            return {};
        }
        return "unknown step";
    }

    std::string expectLine(TestClient& connection, const JsonValue& expected)
    {
        const auto line = connection.readLine();
        if (!line)
            return "no response line";
        const auto actual = parseJson(*line);
        if (!actual.ok)
            return "the response is not JSON";
        std::string failure;
        if (!match(expected, actual.value, "$", failure))
            return failure;
        // Matching rule 4: a number id is written as a plain integer literal.
        const JsonValue* expectedId = expected.find("id");
        if (expectedId != nullptr && expectedId->isNumber()) {
            const std::string& literal = actual.value.find("id")->text();
            const bool plain = !literal.empty() && literal.find_first_not_of("0123456789") == std::string::npos
                               && (literal.size() == 1 || literal[0] != '0');
            if (!plain)
                return "the id is not written as a plain integer: " + literal;
        }
        return {};
    }

    static bool isMatcher(const JsonValue& value)
    {
        if (!value.isObject() || value.size() == 0)
            return false;
        for (std::size_t i = 0; i < value.size(); ++i)
            if (value.keyAt(i).empty() || value.keyAt(i)[0] != '$')
                return false;
        return true;
    }

    JsonValue substitute(const JsonValue& value, std::string& failure)
    {
        if (isMatcher(value)) {
            const JsonValue* reference = value.find("$ref");
            const auto bound = reference != nullptr ? bindings_.find(reference->text()) : bindings_.end();
            if (bound == bindings_.end())
                failure = "unbound or unsupported matcher in a value to send";
            return bound != bindings_.end() ? bound->second : JsonValue();
        }
        if (value.isArray()) {
            auto out = JsonValue::array();
            for (std::size_t i = 0; i < value.size(); ++i)
                out.append(substitute(value.at(i), failure));
            return out;
        }
        if (value.isObject()) {
            auto out = JsonValue::object();
            for (std::size_t i = 0; i < value.size(); ++i)
                out.appendMember(value.keyAt(i), substitute(value.at(i), failure));
            return out;
        }
        return value;
    }

    static bool equal(const JsonValue& a, const JsonValue& b)
    {
        if (a.type() != b.type())
            return false;
        switch (a.type()) {
            case JsonValue::Type::Null:
                return true;
            case JsonValue::Type::Boolean:
                return a.asBoolean() == b.asBoolean();
            case JsonValue::Type::Number:
                return a.asDouble() == b.asDouble();
            case JsonValue::Type::String:
                return a.text() == b.text();
            case JsonValue::Type::Array:
                if (a.size() != b.size())
                    return false;
                for (std::size_t i = 0; i < a.size(); ++i)
                    if (!equal(a.at(i), b.at(i)))
                        return false;
                return true;
            case JsonValue::Type::Object:
                if (a.size() != b.size())
                    return false;
                for (std::size_t i = 0; i < a.size(); ++i) {
                    const JsonValue* other = b.find(a.keyAt(i));
                    if (other == nullptr || !equal(a.at(i), *other))
                        return false;
                }
                return true;
        }
        return false;
    }

    bool matchMatcher(const JsonValue& matcher, const JsonValue& actual, const std::string& where, std::string& failure)
    {
        if (const JsonValue* reference = matcher.find("$ref")) {
            const auto bound = bindings_.find(reference->text());
            if (bound == bindings_.end() || !equal(bound->second, actual)) {
                failure = where + ": does not equal " + reference->text();
                return false;
            }
            return true;
        }
        if (const JsonValue* any = matcher.find("$any"); any != nullptr && any->isString()) {
            const std::string& type = any->text();
            const bool ok = (type == "string" && actual.isString()) || (type == "number" && actual.isNumber())
                            || (type == "integer" && actual.isNumber()
                                && actual.asDouble() == static_cast<double>(static_cast<long long>(actual.asDouble())))
                            || (type == "boolean" && actual.isBoolean()) || (type == "object" && actual.isObject())
                            || (type == "array" && actual.isArray()) || (type == "null" && actual.isNull());
            if (!ok) {
                failure = where + ": not of type " + type;
                return false;
            }
        }
        if (const JsonValue* approx = matcher.find("$approx")) {
            const JsonValue* tolerance = matcher.find("$tol");
            const double tol = tolerance != nullptr ? tolerance->asDouble() : 1e-6;
            if (!actual.isNumber() || std::abs(actual.asDouble() - approx->asDouble()) > tol) {
                failure = where + ": not within the tolerance";
                return false;
            }
        }
        if (const JsonValue* capture = matcher.find("$capture")) {
            if (bindings_.count(capture->text()) != 0) {
                failure = where + ": the vector binds a name twice";
                return false;
            }
            bindings_[capture->text()] = actual;
        }
        return true;
    }

    bool match(const JsonValue& expected, const JsonValue& actual, const std::string& where, std::string& failure)
    {
        if (isMatcher(expected))
            return matchMatcher(expected, actual, where, failure);
        if (expected.isObject()) {
            if (!actual.isObject()) {
                failure = where + ": not an object";
                return false;
            }
            for (std::size_t i = 0; i < expected.size(); ++i) {
                const JsonValue* member = actual.find(expected.keyAt(i));
                if (member == nullptr) {
                    failure = where + "." + expected.keyAt(i) + ": missing";
                    return false;
                }
                if (!match(expected.at(i), *member, where + "." + expected.keyAt(i), failure))
                    return false;
            }
            return true;
        }
        if (expected.isArray()) {
            if (!actual.isArray() || actual.size() != expected.size()) {
                failure = where + ": array of another length";
                return false;
            }
            for (std::size_t i = 0; i < expected.size(); ++i)
                if (!match(expected.at(i), actual.at(i), where + "[" + std::to_string(i) + "]", failure))
                    return false;
            return true;
        }
        if (!equal(expected, actual)) {
            failure = where + ": expected " + toJsonString(expected) + ", got " + toJsonString(actual);
            return false;
        }
        return true;
    }

    const JsonValue& vector_;
    ServerFixture fixture_;
    std::map<std::string, JsonValue> bindings_;
    std::map<std::string, TestClient> connections_;
    Clock::time_point lastStepEnd_;
};

/** Why a vector cannot run against this server, or empty when it can. */
std::string skipReason(const std::string& id, const JsonValue& vector)
{
    const std::set<std::string> reported = {"session.v1"};
    if (reported.count(vector.find("capability")->text()) == 0)
        return "needs capability " + vector.find("capability")->text() + ", not reported before the dispatcher exists";
    if (const JsonValue* extra = vector.find("extraCapabilities"))
        for (std::size_t i = 0; i < extra->size(); ++i)
            if (reported.count(extra->at(i).text()) == 0)
                return "needs capability " + extra->at(i).text();
    if (const JsonValue* given = vector.find("given"))
        for (std::size_t i = 0; i < given->size(); ++i)
            if (given->keyAt(i) != "withoutCapabilities")
                return "precondition given." + given->keyAt(i) + " needs the dispatcher";
    if (id == "session/info-ok")
        return "checks the session.info result, which the dispatcher provides (this test answers with a stand-in)";
    return {};
}

void testSessionVectors()
{
    const auto directory = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors" / "session";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(directory))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    CONTROL_CHECK(files.size() >= 20);
    int passed = 0;
    int skipped = 0;
    for (const auto& file : files) {
        const auto vector = parsed(readFile(file));
        const std::string id = vector.find("id")->text();
        if (const auto reason = skipReason(id, vector); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const std::string failure = VectorRunner(vector).run();
        if (CONTROL_CHECK(failure.empty()))
            ++passed;
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    note(std::to_string(passed) + " session vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace

// Optional argument: run only the tests whose name contains it.
int main(int argc, char** argv)
{
    const std::string filter = argc > 1 ? argv[1] : "";
    const std::pair<const char*, void (*)()> tests[] = {
        {"options", testOptions},
        {"path policy", testPathPolicy},
        {"secure random", testSecureRandom},
        {"json", testJson},
        {"request ids", testRequestIds},
        {"protocol", testProtocol},
        {"discovery directory", testDiscoveryDirectoryResolution},
        {"discovery files", testDiscoveryFiles},
        {"server start and hello", testServerStartAndHello},
        {"before authentication", testBeforeAuthentication},
        {"hello failures", testHelloFailures},
        {"connection limits", testConnectionLimits},
        {"flood", testFloodDoesNotDisturbSessions},
        {"in-flight rules", testInFlightRules},
        {"line limits", testLineLimits},
        {"idle timeout", testIdleTimeout},
        {"stop with busy connections", testStopWithBusyConnections},
        {"start failures", testStartFailures},
        {"session vectors", testSessionVectors},
    };
    if (!ControlSocket::acquireNetworking()) {
        std::cerr << "cannot initialise networking" << std::endl;
        return 1;
    }
    const auto started = Clock::now();
    for (const auto& [name, run] : tests) {
        if (std::string(name).find(filter) == std::string::npos)
            continue;
        const int before = failureCount();
        const auto testStarted = Clock::now();
        std::cout << "[ RUN  ] " << name << std::endl;
        run();
        std::cout << (failureCount() == before ? "[  OK  ] " : "[FAILED] ") << name << " ("
                  << millisecondsSince(testStarted) << " ms)" << std::endl;
    }
    ControlSocket::releaseNetworking();
    std::cout << (failureCount() == 0 ? "All control unit tests passed" : "Control unit tests FAILED") << " in "
              << millisecondsSince(started) << " ms" << std::endl;
    return failureCount() == 0 ? 0 : 1;
}
