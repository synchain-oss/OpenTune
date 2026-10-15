// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "Control/ControlJson.h"
#include "Utils/AudioEditingScheme.h"
#include "Utils/DetectedKey.h"
#include "Utils/LocalizationManager.h"
#include "Utils/PitchShiftSettings.h"

namespace OpenTune {

/**
 * Wire forms of small OpenTune values that more than one read method reports. Pure functions; no
 * OpenTune state is read, so they may run on any thread.
 */

/** The wire name of a scale (common.schema.json#/$defs/scaleName). */
const char* controlScaleName(Scale scale);

/** The key of a content (common.schema.json#/$defs/key); null until the analysis determined one. */
JsonValue controlKeyJson(const DetectedKey& key);

/** The pitch shift of a content (common.schema.json#/$defs/pitchShift). */
JsonValue controlPitchShiftJson(const PitchShiftSettings& settings);

/** The language tag session.info and prefs.get report (en, zh, ja, ru, es). */
const char* controlLanguageTag(Language language);

/** The wire name of an editing scheme: openDyne for the notes-primary scheme, openTune otherwise. */
const char* controlEditingSchemeName(AudioEditingScheme::Scheme scheme);

} // namespace OpenTune
