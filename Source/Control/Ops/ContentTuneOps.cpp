// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ContentTuneOps.h"

#include "EditSupport.h"
#include "OpsJson.h"
#include "OpsSupport.h"
#include "WriteEnvelope.h"

#include "Content/EditableContentSnapshot.h"
#include "Control/ControlUiBridge.h"
#include "Control/Edit/ContentEditTransaction.h"
#include "Control/Edit/ControlOriginAction.h"
#include "PluginProcessor.h"
#include "Utils/LegacyNoteGenerator.h"
#include "Utils/NoteGeneratorTypes.h"
#include "Utils/ScaleUiMapping.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace OpenTune {

namespace {

/** changes, created and removed list at most this many entries each (methods/content.autoTune.schema.json). */
constexpr std::size_t kMaxListedEntries = 200;

Result<std::shared_ptr<ControlHistory>> historyOf(ControlOpContext& context)
{
    auto history = context.history();
    if (history == nullptr)
        return controlOpError("INTERNAL", "", "the undo history of the control API is not available");
    return history;
}

JsonValue contentRef(const std::string& contentId)
{
    auto ref = JsonValue::object();
    ref.appendMember("contentId", JsonValue::string(contentId));
    return ref;
}

JsonValue keyInputJson(const DetectedKey& key)
{
    auto json = JsonValue::object();
    json.appendMember("root", JsonValue::integer(static_cast<int>(key.root)));
    json.appendMember("scale", JsonValue::string(controlScaleName(key.scale)));
    return json;
}

JsonValue field(JsonValue before, JsonValue after)
{
    auto json = JsonValue::object();
    json.appendMember("before", std::move(before));
    json.appendMember("after", std::move(after));
    json.appendMember("unit", JsonValue());
    return json;
}

/** Whether the UI shows this content's key: the selected clip of the active track shows it, and the transport
    bar follows it on the editor's next heartbeat (PluginEditor's applyResolvedScaleForPlacementContent). */
bool keyShownInUi(ControlOpContext& context, const ContentKey& key)
{
    auto* bridge = context.bridge();
    const auto selected = bridge != nullptr ? bridge->selectedPlacementIds() : std::nullopt;
    if (!selected)
        return false;
    for (const auto& placement : controlLivePlacements(context))
        if (placement.placement.contentKey == key
            && std::find(selected->begin(), selected->end(), placement.placement.placementId) != selected->end())
            return true;
    return false;
}

bool failWith(ControlParamReader& reader, std::string& why)
{
    why = reader.why();
    return false;
}

bool reject(ControlParamReader& reader, std::string& why, std::string message)
{
    reader.fail(std::move(message));
    return failWith(reader, why);
}

// ---- content.setKey -------------------------------------------------------------------------------

struct SetKeyParams
{
    ControlHandle contentId;
    DetectedKey key;
    std::optional<std::string> expectedKeyRevision;
};

/** methods/content.setKey.schema.json $defs.params. */
bool parseSetKey(const JsonValue& params, SetKeyParams& out, std::string& why)
{
    ControlParamReader reader(params);
    std::optional<ControlHandle> contentId;
    if (!reader.onlyMembers({"contentId", "key", "expectedKeyRevision"})
        || !reader.optionalHandle("contentId", ControlHandleKind::Content, contentId)
        || !controlReadRevisionToken(reader, "expectedKeyRevision", out.expectedKeyRevision))
        return failWith(reader, why);
    if (!contentId)
        return reject(reader, why, "contentId is required");
    const JsonValue* key = reader.member("key");
    if (key == nullptr || !controlParseKeyInput(*key, out.key))
        return reject(reader, why, "key must be {root: 0..11, scale}");
    out.contentId = *contentId;
    return true;
}

Result<JsonValue> runSetKey(ControlOpContext& context, const SetKeyParams& params)
{
    auto content = controlResolveContent(context, params.contentId);
    if (!content.ok())
        return content.error();
    const auto& ref = content.value();
    if (auto busy = controlCheckBusy(context))
        return *busy;
    if (auto notReady = controlCheckContentReady(context, ref))
        return *notReady;
    if (auto conflict = controlCheckExpectedTokens(controlContentVersions(ref.contentId, *ref.snapshot), std::nullopt,
                                                   params.expectedKeyRevision))
        return *conflict;
    auto history = historyOf(context);
    if (!history.ok())
        return history.error();

    const DetectedKey previous = ref.snapshot->detectedKey;
    ControlWriteEnvelope envelope(context);
    envelope.touchContent(ref.contentId);
    // PluginEditor::scaleChanged(): a manual key that the choice does not change is only shown again, not
    // written; an automatic key chosen again becomes manual.
    if (previous.origin == Origin::Manual && previous.root == params.key.root && previous.scale == params.key.scale)
        return envelope.committed(context);

    // OpenTuneAudioProcessor::setContentDetectedKey(): the call PluginEditor::scaleChanged() makes for the
    // selected clip; then the project is marked as changed, as there.
    if (!context.processor().setContentDetectedKey(ref.key, params.key))
        return controlOpError("INTERNAL", "", "OpenTune did not accept the key");
    controlMarkDirty(context);
    history.value()->onChangeWithoutEntry(context.processor().getUndoManager(), ref.key, ControlContentAspect::Key);

    auto fields = JsonValue::object();
    if (previous.root != params.key.root || previous.origin == Origin::Unset)
        fields.appendMember(
            "root",
            field(previous.origin == Origin::Unset ? JsonValue() : JsonValue::integer(static_cast<int>(previous.root)),
                  JsonValue::integer(static_cast<int>(params.key.root))));
    if (previous.scale != params.key.scale || previous.origin == Origin::Unset)
        fields.appendMember(
            "scale",
            field(previous.origin == Origin::Unset ? JsonValue() : JsonValue::string(controlScaleName(previous.scale)),
                  JsonValue::string(controlScaleName(params.key.scale))));
    if (previous.origin != Origin::Manual)
        fields.appendMember("origin",
                            field(previous.origin == Origin::Automatic ? JsonValue::string("automatic") : JsonValue(),
                                  JsonValue::string("manual")));
    envelope.addChange("key", contentRef(ref.contentId), JsonValue(), std::move(fields));

    // The previous root and scale, with the key revision right after the change (section 15.2 rule 3). A
    // content without a key before cannot get "no key" back; nor can an instance without edit.v1.
    JsonValue revert;
    const auto now = controlLiveSnapshot(context, ref.key);
    if (previous.origin != Origin::Unset && now != nullptr && controlReportsCapability(context, "edit.v1")) {
        auto revertParams = JsonValue::object();
        revertParams.appendMember("contentId", JsonValue::string(ref.contentId));
        revertParams.appendMember("key", keyInputJson(previous));
        revertParams.appendMember("expectedKeyRevision",
                                  JsonValue::string(controlContentVersions(ref.contentId, *now).key));
        revert = controlRevertRecipe("content.setKey", std::move(revertParams));
    }
    if (keyShownInUi(context, ref.key)) {
        auto effect = JsonValue::object();
        effect.appendMember("revert", revert);
        envelope.addSideEffect("uiScaleChanged", std::move(effect));
    }
    envelope.setNotUndoable("ui_parity", std::move(revert));
    return envelope.committed(context);
}

// ---- content.autoTune -----------------------------------------------------------------------------

enum class TuneMode {
    Regenerate,
    SnapNotes,
    NotesOnly,
    Reference
};

const char* modeName(TuneMode mode)
{
    switch (mode) {
        case TuneMode::Regenerate:
            return "regenerate";
        case TuneMode::SnapNotes:
            return "snapNotes";
        case TuneMode::NotesOnly:
            return "notesOnly";
        case TuneMode::Reference:
            return "reference";
    }
    return "regenerate";
}

struct AutoTuneParams
{
    ControlHandle contentId;
    TuneMode mode = TuneMode::Regenerate;
    std::string expectedRevision;
    /** Content seconds; empty for the whole content. */
    std::vector<std::pair<double, double>> ranges;
    std::optional<DetectedKey> key;
    bool clipKey = false;
    std::optional<std::string> expectedKeyRevision;
    std::optional<double> retuneSpeed;
    std::optional<double> vibratoDepth;
    std::optional<double> vibratoRateHz;
    std::optional<double> noteSplitCents;
    bool dryRun = false;
};

bool readRanges(ControlParamReader& reader, std::vector<std::pair<double, double>>& out)
{
    const JsonValue* ranges = reader.member("ranges");
    if (ranges == nullptr)
        return true;
    if (!ranges->isArray() || ranges->size() < 1 || ranges->size() > 16)
        return reader.fail("ranges must be an array of 1 to 16 ranges");
    for (std::size_t i = 0; i < ranges->size(); ++i) {
        const auto& range = ranges->at(i);
        const JsonValue* start = range.isObject() ? range.find("startContentSec") : nullptr;
        const JsonValue* end = range.isObject() ? range.find("endContentSec") : nullptr;
        if (start == nullptr || end == nullptr || range.size() != 2 || !start->isNumber() || !end->isNumber()
            || !std::isfinite(start->asDouble()) || !std::isfinite(end->asDouble()) || start->asDouble() < 0.0
            || end->asDouble() < 0.0)
            return reader.fail("every range must be {startContentSec, endContentSec} of non-negative seconds");
        out.emplace_back(start->asDouble(), end->asDouble());
    }
    return true;
}

bool readGeneratorParams(ControlParamReader& reader, AutoTuneParams& out)
{
    const JsonValue* params = reader.member("params");
    if (params == nullptr)
        return true;
    if (!params->isObject())
        return reader.fail("params must be an object");
    ControlParamReader inner(*params);
    if (!inner.onlyMembers({"retuneSpeed", "vibratoDepth", "vibratoRateHz", "noteSplitCents"})
        || !inner.optionalNumber("retuneSpeed", 0.0, 1.0, out.retuneSpeed)
        || !inner.optionalNumber("vibratoDepth", 0.0, 100.0, out.vibratoDepth)
        || !inner.optionalNumber("vibratoRateHz", 3.0, 12.0, out.vibratoRateHz)
        || !inner.optionalNumber("noteSplitCents", 0.0, 200.0, out.noteSplitCents))
        return reader.fail("params." + inner.why());
    return true;
}

/** methods/content.autoTune.schema.json $defs.params, including the conditions per mode. */
bool parseAutoTune(const JsonValue& params, AutoTuneParams& out, std::string& why)
{
    ControlParamReader reader(params);
    std::optional<ControlHandle> contentId;
    std::optional<ControlHandle> placementId;
    std::optional<std::string> expectedRevision;
    if (!reader.onlyMembers({"contentId", "mode", "expectedRevision", "ranges", "key", "expectedKeyRevision", "params",
                             "placementId", "dryRun"})
        || !reader.optionalHandle("contentId", ControlHandleKind::Content, contentId)
        || !reader.optionalHandle("placementId", ControlHandleKind::Placement, placementId)
        || !controlReadRevisionToken(reader, "expectedRevision", expectedRevision)
        || !controlReadRevisionToken(reader, "expectedKeyRevision", out.expectedKeyRevision)
        || !readRanges(reader, out.ranges) || !readGeneratorParams(reader, out))
        return failWith(reader, why);
    if (!contentId || !expectedRevision)
        return reject(reader, why, "contentId, mode and expectedRevision are required");
    const JsonValue* mode = reader.member("mode");
    bool known = false;
    for (const auto candidate : {TuneMode::Regenerate, TuneMode::SnapNotes, TuneMode::NotesOnly, TuneMode::Reference})
        if (mode != nullptr && mode->isString() && mode->text() == modeName(candidate)) {
            out.mode = candidate;
            known = true;
        }
    if (!known)
        return reject(reader, why, "mode must be regenerate, snapNotes, notesOnly or reference");
    if (const JsonValue* key = reader.member("key")) {
        DetectedKey parsed;
        if (key->isString() && key->text() == "clipKey")
            out.clipKey = true;
        else if (controlParseKeyInput(*key, parsed))
            out.key = parsed;
        else
            return reject(reader, why, "key must be {root: 0..11, scale} or \"clipKey\"");
    }
    if (const JsonValue* dryRun = reader.member("dryRun")) {
        if (!dryRun->isBoolean())
            return reject(reader, why, "dryRun must be a boolean");
        out.dryRun = dryRun->asBoolean();
    }
    const bool hasKey = reader.member("key") != nullptr;
    const bool hasRanges = reader.member("ranges") != nullptr;
    const bool hasParams = reader.member("params") != nullptr;
    const bool hasPlacement = placementId.has_value();
    switch (out.mode) {
        case TuneMode::Regenerate:
            if (!hasKey || hasPlacement)
                return reject(reader, why, "mode regenerate needs key and takes no placementId");
            break;
        case TuneMode::SnapNotes:
            if (!hasKey || hasPlacement || hasParams)
                return reject(reader, why, "mode snapNotes needs key and takes no placementId or params");
            break;
        case TuneMode::NotesOnly:
            if (hasRanges || hasKey || hasPlacement)
                return reject(reader, why, "mode notesOnly takes no ranges, key or placementId");
            break;
        case TuneMode::Reference:
            if (!hasPlacement || hasRanges || hasKey || hasParams || reader.member("dryRun") != nullptr)
                return reject(reader, why,
                              "mode reference needs placementId and takes no ranges, key, params or dryRun");
            break;
    }
    if (out.clipKey && !out.expectedKeyRevision)
        return reject(reader, why, "key clipKey needs expectedKeyRevision");
    out.contentId = *contentId;
    out.expectedRevision = *expectedRevision;
    return true;
}

/** NoteGeneratorParams{} with the given params: never the positions of the UI's knobs (PROTOCOL.md section 21
    rule 1). noteSplitCents is the segmentation threshold that the UI's Note Split knob sets. */
NoteGeneratorParams generatorParams(const AutoTuneParams& params)
{
    NoteGeneratorParams generator;
    if (params.retuneSpeed)
        generator.retuneSpeed = static_cast<float>(*params.retuneSpeed);
    if (params.vibratoDepth)
        generator.vibratoDepth = static_cast<float>(*params.vibratoDepth);
    if (params.vibratoRateHz)
        generator.vibratoRate = static_cast<float>(*params.vibratoRateHz);
    if (params.noteSplitCents)
        generator.policy.transitionThresholdCents = static_cast<float>(*params.noteSplitCents);
    return generator;
}

JsonValue paramsUsedJson(const NoteGeneratorParams& generator)
{
    auto json = JsonValue::object();
    json.appendMember("retuneSpeed", controlJsonNumber(generator.retuneSpeed, 4));
    json.appendMember("vibratoDepth", controlJsonNumber(generator.vibratoDepth, 4));
    json.appendMember("vibratoRateHz", controlJsonNumber(generator.vibratoRate, 4));
    json.appendMember("noteSplitCents", controlJsonNumber(generator.policy.transitionThresholdCents, 4));
    return json;
}

bool sameNote(const Note& a, const Note& b)
{
    return a.startTime == b.startTime && a.endTime == b.endTime && a.pitch == b.pitch
           && a.originalPitch == b.originalPitch && a.pitchOffset == b.pitchOffset && a.retuneSpeed == b.retuneSpeed
           && a.vibratoDepth == b.vibratoDepth && a.vibratoRate == b.vibratoRate
           && a.pitchDriftScale == b.pitchDriftScale && a.isVoiced == b.isVoiced;
}

/** A committed range of regenerate, in content seconds as commitAutoTuneGeneratedNotesByContentKey() merges. */
struct CommittedRange
{
    double startSec = 0.0;
    double endSec = 0.0;
};

/**
 * The notes before the call that regenerate replaced (removed) and the notes after it that are new (created):
 * commitAutoTuneGeneratedNotesByContentKey() removes every note that overlaps a committed range and copies the
 * others unchanged, so a note after the call is new unless it equals one of the notes kept. A note inside a
 * range is replaced even when the generator happens to make an equal one.
 */
void diffNotes(const std::vector<Note>& before, const std::vector<Note>& after,
               const std::vector<CommittedRange>& committed, std::vector<std::size_t>& removed,
               std::vector<std::size_t>& created)
{
    std::vector<const Note*> kept;
    for (std::size_t i = 0; i < before.size(); ++i) {
        const auto& note = before[i];
        const bool overlaps = std::any_of(committed.begin(), committed.end(), [&note](const CommittedRange& range) {
            return note.endTime > range.startSec && note.startTime < range.endSec;
        });
        if (overlaps)
            removed.push_back(i);
        else
            kept.push_back(&note);
    }
    for (std::size_t j = 0; j < after.size(); ++j) {
        const auto match = std::find_if(kept.begin(), kept.end(),
                                        [&](const Note* note) { return note != nullptr && sameNote(*note, after[j]); });
        if (match != kept.end())
            *match = nullptr;
        else
            created.push_back(j);
    }
}

/**
 * What OpenTuneAudioProcessor::autoTuneContentRangeByContentKey() and commitAutoTuneGeneratedNotesByContentKey()
 * would do to the notes, without committing (dryRun): generate in the frame range from the original pitch,
 * snap to the scale, normalise, then keep the notes that do not overlap the range and add the new ones,
 * sorted by start. nullopt when it would commit nothing (no notes generated).
 */
std::optional<std::vector<Note>> predictRegenerate(const PitchCurveSnapshot& curve, const std::vector<Note>& notes,
                                                   F0FrameRange range, const NoteGeneratorParams& generator,
                                                   const std::optional<ScaleSnapConfig>& scaleSnap)
{
    const auto& f0 = curve.getOriginalF0();
    auto generated =
        LegacyNoteGenerator::generate(f0.data(), static_cast<int>(f0.size()), nullptr, range.startFrame,
                                      range.endFrameExclusive, curve.getHopSize(), curve.getSampleRate(), generator);
    if (!LegacyNoteGenerator::validate(generated))
        return std::nullopt;
    if (scaleSnap)
        scaleSnap->applyToNotes(generated);
    auto normalized = normalizeStoredNotes(generated);
    if (normalized.empty())
        return std::nullopt;
    const double secondsPerFrame = curve.getHopSize() / curve.getSampleRate();
    const double rangeStart = range.startFrame * secondsPerFrame;
    const double rangeEnd = range.endFrameExclusive * secondsPerFrame;
    std::vector<Note> merged;
    for (const auto& note : notes)
        if (note.endTime <= rangeStart || note.startTime >= rangeEnd)
            merged.push_back(note);
    merged.insert(merged.end(), normalized.begin(), normalized.end());
    std::sort(merged.begin(), merged.end(), [](const Note& a, const Note& b) { return a.startTime < b.startTime; });
    return merged;
}

/** What OpenTuneAudioProcessor::generateNotesOnlyByContentKey() would make of the notes (dryRun). */
std::optional<std::vector<Note>> predictNotesOnly(const PitchCurveSnapshot& curve, const std::vector<Note>& notes,
                                                  const NoteGeneratorParams& generator)
{
    const auto& f0 = curve.getOriginalF0();
    const int count = static_cast<int>(f0.size());
    auto generated = LegacyNoteGenerator::generate(f0.data(), count, nullptr, 0, count, curve.getHopSize(),
                                                   curve.getSampleRate(), generator);
    if (!LegacyNoteGenerator::validate(generated))
        return std::nullopt;
    for (auto& note : generated)
        if (note.originalPitch > 0.0f)
            note.pitch = note.originalPitch;
    NoteRangeSeconds range{0.0, count * curve.getHopSize() / curve.getSampleRate()};
    for (const auto& note : generated) {
        range.startSeconds = std::min(range.startSeconds, note.startTime);
        range.endSeconds = std::max(range.endSeconds, note.endTime);
    }
    return mergeNotesRange(notes, range, generated);
}

/** Lists removed notes (at the revision before) and created notes (at the revision after; for a prediction at
    the current one), at most kMaxListedEntries each; returns {removed, created} omitted counts. */
std::pair<std::size_t, std::size_t> listNotes(ControlWriteEnvelope& envelope, const std::string& contentId,
                                              const std::vector<Note>& before, const std::string& revisionBefore,
                                              const std::vector<Note>& after, const std::string& revisionAfter,
                                              const std::vector<std::size_t>& removed,
                                              const std::vector<std::size_t>& created)
{
    for (std::size_t i = 0; i < removed.size() && i < kMaxListedEntries; ++i)
        envelope.addRemoved("note", controlNoteRefJson(contentId, removed[i], revisionBefore),
                            controlNoteLabelJson(removed[i], before[removed[i]]));
    for (std::size_t i = 0; i < created.size() && i < kMaxListedEntries; ++i)
        envelope.addCreated("note", controlNoteRefJson(contentId, created[i], revisionAfter),
                            controlNoteLabelJson(created[i], after[created[i]]));
    return {removed.size() > kMaxListedEntries ? removed.size() - kMaxListedEntries : 0,
            created.size() > kMaxListedEntries ? created.size() - kMaxListedEntries : 0};
}

/** The members of the result besides the envelope (methods/content.autoTune.schema.json result). */
void appendAutoTuneMembers(JsonValue& result, TuneMode mode, const std::optional<DetectedKey>& keyUsed,
                           const NoteGeneratorParams& generator, std::size_t before, std::size_t after,
                           std::pair<std::size_t, std::size_t> omitted)
{
    auto omittedCount = JsonValue::object();
    omittedCount.appendMember("changes", JsonValue::integer(0));
    omittedCount.appendMember("created", JsonValue::integer(static_cast<std::int64_t>(omitted.second)));
    omittedCount.appendMember("removed", JsonValue::integer(static_cast<std::int64_t>(omitted.first)));
    result.appendMember("omittedCount", std::move(omittedCount));
    result.appendMember("mode", JsonValue::string(modeName(mode)));
    result.appendMember("keyUsed", keyUsed ? keyInputJson(*keyUsed) : JsonValue());
    result.appendMember("paramsUsed", paramsUsedJson(generator));
    auto noteCount = JsonValue::object();
    noteCount.appendMember("before", JsonValue::integer(static_cast<std::int64_t>(before)));
    noteCount.appendMember("after", JsonValue::integer(static_cast<std::int64_t>(after)));
    result.appendMember("noteCount", std::move(noteCount));
}

/** Frame ranges of the requested content ranges on the content's analysis timeline, as the piano roll resolves
    a selection (F0Timeline::rangeForTimes, then rangeForFrames); the whole content without ranges. Empty ranges
    are left out. */
std::vector<F0FrameRange> frameRanges(const PitchCurveSnapshot& curve, const AutoTuneParams& params)
{
    const F0Timeline f0tl{curve.getHopSize(), curve.getSampleRate(), static_cast<int>(curve.size())};
    std::vector<F0FrameRange> out;
    if (params.ranges.empty()) {
        out.push_back(f0tl.rangeForFrames(0, f0tl.endFrameExclusive()));
    } else {
        for (const auto& [start, end] : params.ranges) {
            const auto times = f0tl.rangeForTimes(start, end);
            out.push_back(f0tl.rangeForFrames(times.startFrame, times.endFrameExclusive));
        }
    }
    out.erase(std::remove_if(out.begin(), out.end(), [](const F0FrameRange& range) { return range.isEmpty(); }),
              out.end());
    return out;
}

Result<JsonValue> runRegenerate(ControlOpContext& context, const AutoTuneParams& params, const ControlContentRef& ref,
                                const ControlContentVersions& versions, const DetectedKey& key)
{
    auto history = historyOf(context);
    if (!history.ok())
        return history.error();
    auto& processor = context.processor();
    const auto generator = generatorParams(params);
    // makeScaleSnapConfig(): the key's scale for the snap, none for chromatic, as the UI maps its scale.
    const auto scaleSnap = makeScaleSnapConfig(key);
    const auto& curve = *ref.snapshot->pitchCurve;
    const auto ranges = frameRanges(curve, params);
    const double secondsPerFrame = curve.getHopSize() / curve.getSampleRate();
    const auto beforeNotes = ref.snapshot->notes;
    const auto beforeWorld = controlCaptureWorldVersions(context);

    ControlWriteEnvelope envelope(context);
    envelope.touchContent(ref.contentId);
    std::vector<CommittedRange> committed;
    std::vector<Note> afterNotes = beforeNotes;
    const juce::String description = TRANS("自动调音");
    ContentEditTransaction transaction(processor, ref.key);
    for (const auto& range : ranges) {
        if (params.dryRun) {
            auto predicted = predictRegenerate(curve, afterNotes, range, generator, scaleSnap);
            if (!predicted)
                continue;
            afterNotes = std::move(*predicted);
        } else {
            // PianoRollComponent::applyAutoTuneToSelection(): capture, commit the range through the AUTO command,
            // record the undo action over the range the correction recomputed (expandNoteBasedCorrectionRange).
            transaction.captureBefore();
            if (!processor.autoTuneContentRangeByContentKey(ref.key, range.startFrame, range.endFrameExclusive,
                                                            generator, scaleSnap))
                continue;
            transaction.recordRange(
                description, PitchCurve::expandNoteBasedCorrectionRange(range.startFrame, range.endFrameExclusive,
                                                                        static_cast<int>(curve.size())));
        }
        committed.push_back({range.startFrame * secondsPerFrame, range.endFrameExclusive * secondsPerFrame});
    }
    if (!params.dryRun)
        if (const auto now = controlLiveSnapshot(context, ref.key))
            afterNotes = now->notes;

    std::vector<std::size_t> removed;
    std::vector<std::size_t> created;
    diffNotes(beforeNotes, afterNotes, committed, removed, created);
    // Notes that overlap a range but do not lie inside one are dropped, not regenerated: the commit removes
    // every note that overlaps the range and generates only inside it (an OpenTune behaviour).
    auto dropped = JsonValue::array();
    for (const auto index : removed) {
        const auto& note = beforeNotes[index];
        const bool inside = std::any_of(committed.begin(), committed.end(), [&note](const CommittedRange& range) {
            return note.startTime >= range.startSec && note.endTime <= range.endSec;
        });
        if (inside || dropped.size() >= kMaxListedEntries)
            continue;
        auto entry = JsonValue::object();
        auto noteRef = JsonValue::object();
        noteRef.appendMember("index", JsonValue::integer(static_cast<std::int64_t>(index)));
        noteRef.appendMember("atRevision", JsonValue::string(versions.revision()));
        entry.appendMember("note", std::move(noteRef));
        entry.appendMember("startContentSec", controlJsonSeconds(note.startTime));
        entry.appendMember("endContentSec", controlJsonSeconds(note.endTime));
        dropped.append(std::move(entry));
    }

    std::string revisionAfter = versions.revision();
    auto inner = transaction.takeActions();
    if (!inner.empty()) {
        auto& manager = processor.getUndoManager();
        const auto undoId = history.value()->nextUndoId(context.instanceShort());
        auto action = std::make_unique<ControlOriginAction>(history.value(), undoId, description, std::move(inner));
        const auto names = action->innerActionNames();
        // UndoManager::addAction(), as the piano roll pushes its entry; it discards the redo history.
        manager.addAction(std::move(action));
        envelope.setUndoable(undoId, description.toStdString(), names);
        controlMarkDirty(context);
        if (const auto now = controlLiveSnapshot(context, ref.key))
            revisionAfter = controlContentVersions(ref.contentId, *now).revision();
    }
    const auto omitted = listNotes(envelope, ref.contentId, beforeNotes, versions.revision(), afterNotes, revisionAfter,
                                   removed, created);
    if (dropped.size() != 0) {
        auto data = JsonValue::object();
        data.appendMember("notes", std::move(dropped));
        envelope.addWarning("DROPPED_BOUNDARY_NOTES", contentRef(ref.contentId), std::move(data));
    }
    JsonValue result;
    if (params.dryRun) {
        if (!committed.empty()) {
            auto effect = JsonValue::object();
            auto ids = JsonValue::array();
            ids.append(JsonValue::string(ref.contentId));
            effect.appendMember("contentIds", std::move(ids));
            envelope.addSideEffect("reRenderQueued", std::move(effect));
        }
        result = envelope.predicted(context);
    } else {
        controlAddReRenderQueued(envelope, beforeWorld, controlCaptureWorldVersions(context));
        result = envelope.committed(context);
    }
    appendAutoTuneMembers(result, TuneMode::Regenerate, key, generator, beforeNotes.size(), afterNotes.size(), omitted);
    return result;
}

Result<JsonValue> runNotesOnly(ControlOpContext& context, const AutoTuneParams& params, const ControlContentRef& ref,
                               const ControlContentVersions& versions)
{
    auto history = historyOf(context);
    if (!history.ok())
        return history.error();
    auto& processor = context.processor();
    const auto generator = generatorParams(params);
    const auto beforeNotes = ref.snapshot->notes;
    const auto beforeWorld = controlCaptureWorldVersions(context);
    std::vector<Note> afterNotes;
    if (params.dryRun) {
        auto predicted = predictNotesOnly(*ref.snapshot->pitchCurve, beforeNotes, generator);
        if (!predicted)
            return controlOpError("INTERNAL", "", "OpenTune's note generator returned no valid result");
        afterNotes = std::move(*predicted);
    }
    ControlWriteEnvelope envelope(context);
    envelope.touchContent(ref.contentId);
    std::string revisionAfter = versions.revision();
    if (!params.dryRun) {
        // OpenTuneAudioProcessor::generateNotesOnlyByContentKey(): replaces all notes, no undo entry, as OpenTune
        // generates the notes of a clip. A generator that returns no valid result changes nothing.
        if (!processor.generateNotesOnlyByContentKey(ref.key, generator))
            return controlOpError("INTERNAL", "", "OpenTune's note generator returned no valid result");
        controlMarkDirty(context);
        history.value()->onChangeWithoutEntry(processor.getUndoManager(), ref.key, ControlContentAspect::NotesAndPitch);
        if (const auto now = controlLiveSnapshot(context, ref.key)) {
            afterNotes = now->notes;
            revisionAfter = controlContentVersions(ref.contentId, *now).revision();
        }
    }
    // generateNotesOnlyByContentKey() replaces the notes of a range that covers the whole content: every note
    // before is removed, every note after is new.
    std::vector<std::size_t> removed(beforeNotes.size());
    std::vector<std::size_t> created(afterNotes.size());
    std::iota(removed.begin(), removed.end(), std::size_t{0});
    std::iota(created.begin(), created.end(), std::size_t{0});
    const auto omitted = listNotes(envelope, ref.contentId, beforeNotes, versions.revision(), afterNotes, revisionAfter,
                                   removed, created);
    auto counts = JsonValue::object();
    counts.appendMember("removedCount", JsonValue::integer(static_cast<std::int64_t>(removed.size())));
    counts.appendMember("createdCount", JsonValue::integer(static_cast<std::int64_t>(created.size())));
    envelope.addWarning("REPLACES_ALL_NOTES", contentRef(ref.contentId), std::move(counts));
    JsonValue result;
    if (params.dryRun) {
        result = envelope.predicted(context);
    } else {
        // No request can bring the previous notes back.
        envelope.addWarning("IRREVERSIBLE", contentRef(ref.contentId));
        envelope.setNotUndoable("ui_parity");
        controlAddReRenderQueued(envelope, beforeWorld, controlCaptureWorldVersions(context));
        result = envelope.committed(context);
    }
    appendAutoTuneMembers(result, TuneMode::NotesOnly, std::nullopt, generator, beforeNotes.size(), afterNotes.size(),
                          omitted);
    return result;
}

Result<JsonValue> runAutoTune(ControlOpContext& context, const AutoTuneParams& params)
{
    // Modes this build does not implement: SNAP follows with the note edits, reference alignment with the
    // reference methods (x-otcp.valueCapabilities: reference.v1).
    if (params.mode == TuneMode::SnapNotes)
        return controlOpError("UNSUPPORTED", "capability_missing",
                              "content.autoTune mode snapNotes is not implemented by this build (edit.v1)");
    if (params.mode == TuneMode::Reference)
        return controlOpError("UNSUPPORTED", "capability_missing",
                              "content.autoTune mode reference needs the capability reference.v1");
    auto content = controlResolveContent(context, params.contentId);
    if (!content.ok())
        return content.error();
    const auto& ref = content.value();
    if (auto busy = controlCheckBusy(context))
        return *busy;
    if (auto notReady = controlCheckContentReady(context, ref))
        return *notReady;
    const auto versions = controlContentVersions(ref.contentId, *ref.snapshot);
    if (auto conflict = controlCheckExpectedTokens(versions, params.expectedRevision, params.expectedKeyRevision))
        return *conflict;
    if (params.mode == TuneMode::NotesOnly)
        return runNotesOnly(context, params, ref, versions);
    // clipKey: the content's own key, guarded by expectedKeyRevision above.
    DetectedKey key = params.key.value_or(ref.snapshot->detectedKey);
    return runRegenerate(context, params, ref, versions, key);
}

} // namespace

void registerContentTuneOps(ControlMethodTable& table)
{
    table.add(controlWriteMethod<SetKeyParams>("content.setKey", parseSetKey, runSetKey));
    table.add(controlWriteMethod<AutoTuneParams>("content.autoTune", parseAutoTune, runAutoTune));
}

} // namespace OpenTune
