// SPDX-License-Identifier: AGPL-3.0-or-later
#include "OpsJson.h"

#include "OpsSupport.h"

namespace OpenTune {

const char* controlScaleName(Scale scale)
{
    switch (scale) {
        case Scale::Major:
            return "major";
        case Scale::Minor:
            return "minor";
        case Scale::Chromatic:
            return "chromatic";
        case Scale::HarmonicMinor:
            return "harmonicMinor";
        case Scale::Dorian:
            return "dorian";
        case Scale::Mixolydian:
            return "mixolydian";
        case Scale::PentatonicMajor:
            return "pentatonicMajor";
        case Scale::PentatonicMinor:
            return "pentatonicMinor";
    }
    return "major";
}

JsonValue controlKeyJson(const DetectedKey& key)
{
    if (key.origin == Origin::Unset)
        return JsonValue();
    auto json = JsonValue::object();
    json.appendMember("root", JsonValue::integer(static_cast<int>(key.root)));
    json.appendMember("scale", JsonValue::string(controlScaleName(key.scale)));
    json.appendMember("origin", JsonValue::string(key.origin == Origin::Manual ? "manual" : "automatic"));
    json.appendMember("confidence", key.origin == Origin::Manual ? JsonValue() : controlJsonNumber(key.confidence, 4));
    return json;
}

JsonValue controlPitchShiftJson(const PitchShiftSettings& settings)
{
    auto json = JsonValue::object();
    json.appendMember("semitones", JsonValue::integer(settings.semitone));
    json.appendMember("cents", JsonValue::integer(settings.cents));
    return json;
}

const char* controlLanguageTag(Language language)
{
    switch (language) {
        case Language::English:
            return "en";
        case Language::Chinese:
            return "zh";
        case Language::Japanese:
            return "ja";
        case Language::Russian:
            return "ru";
        case Language::Spanish:
            return "es";
        case Language::Count:
            break;
    }
    return "en";
}

const char* controlEditingSchemeName(AudioEditingScheme::Scheme scheme)
{
    return scheme == AudioEditingScheme::Scheme::NotesPrimary ? "openDyne" : "openTune";
}

} // namespace OpenTune
