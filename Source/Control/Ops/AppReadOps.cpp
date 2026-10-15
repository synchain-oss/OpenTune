// SPDX-License-Identifier: AGPL-3.0-or-later
#include "AppReadOps.h"

#include "OpsJson.h"
#include "OpsSupport.h"

#include "Control/ControlLogTail.h"
#include "PluginProcessor.h"
#include "Utils/AppLogger.h"
#include "Utils/AppPreferences.h"
#include "Utils/TuningConfig.h"

namespace OpenTune {

namespace {

/** Longest value of a preference string and of a path (prefs.get.schema.json, common.schema.json path). */
constexpr std::size_t kMaxPreferenceTextCodePoints = 64;
constexpr std::size_t kMaxPathCodePoints = 4096;
constexpr std::int64_t kLogDefaultLines = 200;
constexpr std::int64_t kLogMaxLines = 1000;

JsonValue processingJson(const SharedPreferencesState& preferences)
{
    auto json = JsonValue::object();
    auto nullReasons = JsonValue::object();
    // TuningConfig::currentTuningHz(): the A4 frequency every *Midi value of this API refers to.
    json.appendMember("tuningHz", controlJsonNumber(TuningConfig::currentTuningHz(), 3));
    json.appendMember("editingScheme", JsonValue::string(controlEditingSchemeName(preferences.audioEditingScheme)));
    // The "hybrid" (light pitch correction) switch of the processing preferences.
    json.appendMember("hybridMode", JsonValue::boolean(preferences.lightPitchCorrectionEnabled));
    const auto& weight = preferences.vocoderModelWeight;
    if (!weight.empty() && utf8CodePointCount(weight) <= kMaxPreferenceTextCodePoints && isValidUtf8(weight)) {
        json.appendMember("vocoderWeight", JsonValue::string(weight));
    } else {
        json.appendMember("vocoderWeight", JsonValue());
        nullReasons.appendMember("vocoderWeight", JsonValue::string("unavailable"));
    }
    json.appendMember("f0Model", JsonValue::string("fcpe")); // F0ModelType has FCPE only
    json.appendMember(
        "renderingPriority",
        JsonValue::string(preferences.renderingPriority == RenderingPriority::CpuFirst ? "cpuFirst" : "gpuFirst"));
    json.appendMember("experimentalFeatures", JsonValue::boolean(preferences.experimentalFeaturesEnabled));
    json.appendMember("referenceAlignMode", JsonValue::string(preferences.experimentalReferenceAlignMode
                                                                      == ExperimentalReferenceAlignMode::Game
                                                                  ? "game"
                                                                  : "standardAuto"));
    if (nullReasons.size() != 0)
        json.appendMember("nullReasons", std::move(nullReasons));
    return json;
}

Result<JsonValue> runPrefsGet(ControlOpContext& context, const ControlNoParams&)
{
    auto& preferences = context.processor().getAppPreferences();
    // AppPreferences::getState(): a copy taken under the preferences' own mutex.
    const auto shared = preferences.getState().shared;

    // AppPreferences::getRecentProjects(): the most recently used project files, newest first. Whether a
    // file still exists is a stat of each path.
    auto recent = JsonValue::array();
    for (const auto& path : preferences.getRecentProjects()) {
        if (path.isEmpty())
            continue;
        auto entry = JsonValue::object();
        entry.appendMember("path", controlJsonText(path.toStdString(), kMaxPathCodePoints));
        entry.appendMember("exists", JsonValue::boolean(juce::File(path).existsAsFile()));
        recent.append(std::move(entry));
    }

    auto result = JsonValue::object();
    result.appendMember("processing", processingJson(shared));
    result.appendMember("onboardingShown", JsonValue::boolean(shared.onboardingShown));
    result.appendMember("language", JsonValue::string(controlLanguageTag(shared.language)));
    result.appendMember("recentProjects", std::move(recent));
    return result;
}

struct LogParams
{
    std::int64_t maxLines = kLogDefaultLines;
};

bool parseLogParams(const JsonValue& params, LogParams& out, std::string& why)
{
    ControlParamReader reader(params);
    std::optional<std::int64_t> maxLines;
    if (!reader.onlyMembers({"maxLines"}) || !reader.optionalInteger("maxLines", 1, kLogMaxLines, maxLines)) {
        why = reader.why();
        return false;
    }
    out.maxLines = maxLines.value_or(kLogDefaultLines);
    return true;
}

Result<JsonValue> runGetLog(ControlOpContext& context, const LogParams& params)
{
    // AppLogger::getCurrentLogFile(): the file the process-wide logger writes to; empty until the logger
    // was initialised.
    const auto file = AppLogger::getCurrentLogFile();
    ControlLogTail tail;
    if (file != juce::File()) {
        const auto home = juce::File::getSpecialLocation(juce::File::userHomeDirectory).getFullPathName().toStdString();
        tail = controlReadLogTail(std::filesystem::u8path(file.getFullPathName().toStdString()),
                                  static_cast<std::size_t>(params.maxLines), context.facts().redactionSecrets,
                                  controlHomeDirectorySpellings(home));
    }
    auto result = JsonValue::object();
    if (!tail.readable) {
        result.appendMember("lines", JsonValue());
        result.appendMember("truncated", JsonValue::boolean(false));
        auto nullReasons = JsonValue::object();
        nullReasons.appendMember("lines", JsonValue::string("unavailable"));
        result.appendMember("nullReasons", std::move(nullReasons));
        return result;
    }
    auto lines = JsonValue::array();
    for (const auto& line : tail.lines)
        lines.append(JsonValue::string(line));
    result.appendMember("lines", std::move(lines));
    result.appendMember("truncated", JsonValue::boolean(tail.truncated));
    return result;
}

} // namespace

void registerAppReadOps(ControlMethodTable& table)
{
    table.add(controlReadMethod<ControlNoParams>("prefs.get", controlParseNoParams, runPrefsGet));
    table.add(controlReadMethod<LogParams>("app.getLog", parseLogParams, runGetLog));
}

} // namespace OpenTune
