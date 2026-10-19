// SPDX-License-Identifier: AGPL-3.0-or-later
#include "SelectionOps.h"

#include "OpsJson.h"
#include "OpsSupport.h"
#include "TrackSupport.h"
#include "WriteEnvelope.h"

#include "Content/EditableContentSnapshot.h"
#include "Control/ControlUiBridge.h"
#include "PluginProcessor.h"
#include "Utils/AppLogger.h"
#include "Utils/AppPreferences.h"
#include "Utils/AudioEditingScheme.h"
#include "Utils/LegacyNoteGenerator.h"
#include "Utils/Note.h"
#include "Utils/NoteGeneratorTypes.h"
#include "Utils/ScaleUiMapping.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace OpenTune {

namespace {

using UiScale = ControlUiBridge::UiScale;

// ---- Params ---------------------------------------------------------------------------------------

struct SelectionParams
{
    /** The clip to select; nullopt when trackId selects a track. */
    std::optional<ControlHandle> placement;
    int trackId = -1;
    bool openEditor = false;
    bool dryRun = false;
};

bool readBoolean(ControlParamReader& reader, const char* name, bool& out)
{
    const JsonValue* value = reader.member(name);
    if (value == nullptr)
        return true;
    if (!value->isBoolean())
        return reader.fail(std::string(name) + " must be a boolean");
    out = value->asBoolean();
    return true;
}

bool readSelection(ControlParamReader& reader, SelectionParams& out)
{
    if (!reader.onlyMembers({"placementId", "trackId", "openEditor", "dryRun"})
        || !reader.optionalHandle("placementId", ControlHandleKind::Placement, out.placement))
        return false;
    const JsonValue* track = reader.member("trackId");
    if (out.placement.has_value() == (track != nullptr))
        return reader.fail("exactly one of placementId and trackId is required");
    if (track != nullptr) {
        if (!track->isNumber() || std::floor(track->asDouble()) != track->asDouble() || track->asDouble() < 0.0)
            return reader.fail("trackId must be a non-negative integer");
        // A position beyond the slots is a NOT_FOUND of the run; the bound keeps the conversion defined.
        out.trackId = static_cast<int>(std::min(track->asDouble(), 1.0e6));
        if (reader.member("openEditor") != nullptr)
            return reader.fail("openEditor is accepted with placementId only");
    }
    return readBoolean(reader, "openEditor", out.openEditor) && readBoolean(reader, "dryRun", out.dryRun);
}

/** methods/ui.setSelection.schema.json $defs.params, on the connection thread. */
bool parseSetSelection(const JsonValue& params, SelectionParams& out, std::string& why)
{
    ControlParamReader reader(params);
    if (readSelection(reader, out))
        return true;
    why = reader.why();
    return false;
}

// ---- What the call reads before it selects ----------------------------------------------------------

/** The selection as results report it: the active track and the selected clip of that track
    (ControlUiBridge::selectedPlacementIds()). */
struct SelectionState
{
    int activeTrack = -1;
    std::vector<std::uint64_t> selected;
};

/** The clip or track to select. */
struct Target
{
    int trackId = -1;
    /** 0 for a track. */
    std::uint64_t placementId = 0;
    ContentKey key;
    std::string contentId;
};

/** One content whose reference alignment data the editor's reference context asks for. */
struct ReferenceWatch
{
    ContentKey key;
    std::string contentId;
    OriginalF0State f0 = OriginalF0State::NotRequested;
    int analysisRevision = 0;
};

/** The state before the call. */
struct Before
{
    SelectionState selection;
    std::string workspace;
    std::uint64_t pianoRollPlacementId = 0;
    std::optional<UiScale> scale;
    /** Whether the notes of the clip's content were ever generated or edited (noteTopologyInitialized). */
    bool topologyInitialized = true;
    /** The clip and the clip it is bound to, when it has a reference binding that resolves. */
    std::vector<ReferenceWatch> reference;
};

/** The selection and its effects after the call, observed or predicted. */
struct Outcome
{
    SelectionState selection;
    /** notesGenerated: the number of notes of the clip's content. */
    std::optional<std::size_t> noteCount;
    /** referenceAnalysisQueued: the contents, the selected clip's first. */
    std::vector<std::string> referenceContents;
    std::optional<UiScale> scale;
    std::string workspace;
};

SelectionState captureSelection(ControlOpContext& context, ControlUiBridge& bridge)
{
    SelectionState state;
    if (const auto* arrangement = context.processor().getStandaloneArrangement())
        state.activeTrack = arrangement->getActiveTrackId();
    if (const auto ids = bridge.selectedPlacementIds())
        for (const auto id : *ids)
            if (id != 0)
                state.selected.push_back(id);
    return state;
}

ReferenceWatch watchOf(ControlOpContext& context, const ContentKey& key)
{
    ReferenceWatch watch;
    watch.key = key;
    watch.contentId = controlContentId(context, key);
    if (const auto snapshot = controlLiveSnapshot(context, key)) {
        watch.f0 = snapshot->originalF0State;
        watch.analysisRevision = snapshot->referenceFeatures.analysisRevision;
    }
    return watch;
}

/** The clip and the clip it is bound to, as the editor's reference context finds them: the binding that
    OpenTuneAudioProcessor::queryAutoRefAvailability() reports and the bound clip on any track
    (findReferencePlacementInfo in OpenTuneAudioProcessorEditor::refreshReferenceContext). */
std::vector<ReferenceWatch> captureReference(ControlOpContext& context, const Target& target)
{
    if (target.placementId == 0)
        return {};
    auto& processor = context.processor();
    const auto availability = processor.queryAutoRefAvailability(target.placementId);
    if (!availability.hasReferenceBinding())
        return {};
    StandaloneArrangement::Placement reference;
    bool found = false;
    for (int trackId = 0; trackId < OpenTuneAudioProcessor::MAX_TRACKS && !found; ++trackId)
        found = processor.getPlacementById(trackId, availability.referencePlacementId, reference);
    if (!found)
        return {};
    return {watchOf(context, target.key), watchOf(context, reference.contentKey)};
}

Before captureBefore(ControlOpContext& context, ControlUiBridge& bridge, const Target& target)
{
    Before before;
    before.selection = captureSelection(context, bridge);
    if (const auto view = bridge.viewState()) {
        before.workspace = view->workspace;
        before.pianoRollPlacementId = view->pianoRollPlacementId;
    }
    before.scale = bridge.uiScale();
    if (target.placementId != 0)
        if (const auto snapshot = controlLiveSnapshot(context, target.key))
            before.topologyInitialized = snapshot->noteTopologyInitialized;
    before.reference = captureReference(context, target);
    return before;
}

// ---- The prediction --------------------------------------------------------------------------------

/** Whether the editor shows the openDyne scheme (ControlUiBridge::editingSchemeApplied(); the preference when the
    bridge cannot tell). */
bool openDyneApplied(ControlOpContext& context, ControlUiBridge& bridge)
{
    const bool preference = AudioEditingScheme::usesNotesPrimaryScheme(
        context.processor().getAppPreferences().getState().shared.audioEditingScheme);
    return bridge.editingSchemeApplied(true).value_or(preference);
}

/**
 * The notes the piano roll would generate when it gets the clip, mirrored from PianoRollComponent::
 * ensureOpenDyneNotesIfNeeded(): the openDyne scheme, notes never generated (noteTopologyInitialized false) and a
 * ready pitch analysis; setEditedContentAndProjection() calls it only when the piano roll gets another clip. The
 * count is that of OpenTuneAudioProcessor::generateNotesOnlyByContentKey() with the editor's parameters
 * (getCurrentAutoTuneParams): LegacyNoteGenerator over the whole analysis, merged into the content's notes.
 */
std::optional<std::size_t> predictNotes(ControlOpContext& context, ControlUiBridge& bridge, const Target& target,
                                        const Before& before)
{
    if (target.placementId == 0 || before.topologyInitialized || before.pianoRollPlacementId == target.placementId
        || !openDyneApplied(context, bridge))
        return std::nullopt;
    const auto snapshot = controlLiveSnapshot(context, target.key);
    if (snapshot == nullptr || snapshot->pitchCurve == nullptr || snapshot->pitchCurve->getOriginalF0().empty())
        return std::nullopt;
    const auto& curve = *snapshot->pitchCurve;
    const auto& f0 = curve.getOriginalF0();
    const int count = static_cast<int>(f0.size());
    if (curve.getHopSize() <= 0 || curve.getSampleRate() <= 0.0)
        return std::nullopt;
    NoteGeneratorParams params;
    bridge.currentNoteGenerationParams(params);
    auto generated = LegacyNoteGenerator::generate(f0.data(), count, nullptr, 0, count, curve.getHopSize(),
                                                   curve.getSampleRate(), params);
    if (!LegacyNoteGenerator::validate(generated))
        return std::nullopt;
    NoteRangeSeconds range{0.0, count * curve.getHopSize() / curve.getSampleRate()};
    for (const auto& note : generated) {
        range.startSeconds = std::min(range.startSeconds, note.startTime);
        range.endSeconds = std::max(range.endSeconds, note.endTime);
    }
    return mergeNotesRange(snapshot->notes, range, generated).size();
}

/** Whether OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures() would ask for the content's alignment data now:
    its pitch analysis when that was never requested, or the analysis of the alignment data when they are neither
    ready, failed nor being made for the current producer and audio. */
bool preheatWouldQueue(ControlOpContext& context, const ContentKey& key)
{
    if (!key.isValid() || key.domainKind != DomainKind::StandaloneClip)
        return false;
    const auto snapshot = controlLiveSnapshot(context, key);
    if (snapshot == nullptr)
        return false;
    const auto producer = context.processor().getReferenceFeatureProducer();
    if (producer == ReferenceFeatureProducer::StandardAuto) {
        switch (snapshot->originalF0State) {
            case OriginalF0State::NotRequested:
                return true;
            case OriginalF0State::Extracting:
            case OriginalF0State::Failed:
                return false;
            case OriginalF0State::Ready:
                break;
        }
        if (snapshot->pitchCurve == nullptr || snapshot->pitchCurve->getOriginalF0().empty())
            return false;
    }
    const auto& features = snapshot->referenceFeatures;
    const bool current = features.producer == producer
                         && features.inputFingerprint == static_cast<std::int64_t>(snapshot->audioRevision);
    return !(current
             && (features.isReady() || features.status == ReferenceFeatureStatus::Failed
                 || features.status == ReferenceFeatureStatus::Extracting));
}

/** The contents whose alignment data the editor's reference context would ask for (refreshReferenceContext after
    evaluateAutoRefUiState): only for a clip with a binding, with experimental features on and outside openDyne. */
std::vector<std::string> predictReference(ControlOpContext& context, ControlUiBridge& bridge, const Before& before)
{
    std::vector<std::string> contents;
    if (before.reference.empty() || openDyneApplied(context, bridge)
        || !context.processor().getAppPreferences().getState().shared.experimentalFeaturesEnabled)
        return contents;
    for (const auto& watch : before.reference)
        if (preheatWouldQueue(context, watch.key))
            contents.push_back(watch.contentId);
    return contents;
}

Outcome predict(ControlOpContext& context, ControlUiBridge& bridge, const Target& target, const Before& before,
                bool openEditor)
{
    Outcome outcome;
    outcome.selection.activeTrack = target.trackId;
    if (target.placementId != 0)
        outcome.selection.selected.push_back(target.placementId);
    outcome.noteCount = predictNotes(context, bridge, target, before);
    outcome.referenceContents = predictReference(context, bridge, before);
    // The scale the editor resolves for the clip (resolveScaleForPlacementContent); selecting a track leaves it.
    outcome.scale = before.scale;
    if (target.placementId != 0 && before.scale.has_value())
        if (const auto scale = bridge.scaleForSelection(target.trackId, target.placementId))
            outcome.scale = scale;
    // placementDoubleClicked switches to the piano roll when the arrangement is shown.
    outcome.workspace = openEditor && before.workspace == "arrangement" ? "pianoRoll" : before.workspace;
    return outcome;
}

// ---- What the call observed after it selected -----------------------------------------------------

Outcome observe(ControlOpContext& context, ControlUiBridge& bridge, const Target& target, const Before& before)
{
    Outcome outcome;
    outcome.selection = captureSelection(context, bridge);
    if (target.placementId != 0 && !before.topologyInitialized)
        if (const auto snapshot = controlLiveSnapshot(context, target.key);
            snapshot && snapshot->noteTopologyInitialized)
            outcome.noteCount = snapshot->notes.size();
    for (const auto& watch : before.reference) {
        const auto snapshot = controlLiveSnapshot(context, watch.key);
        if (snapshot == nullptr)
            continue;
        // The pitch analysis was requested first, or the analysis of the alignment data was started
        // (preheatReferenceAlignmentFeatures sets it to Extracting with the next analysis revision).
        const bool f0Requested =
            watch.f0 == OriginalF0State::NotRequested && snapshot->originalF0State != OriginalF0State::NotRequested;
        const bool featuresStarted = snapshot->referenceFeatures.analysisRevision != watch.analysisRevision
                                     && snapshot->referenceFeatures.status == ReferenceFeatureStatus::Extracting;
        if (f0Requested || featuresStarted)
            outcome.referenceContents.push_back(watch.contentId);
    }
    outcome.scale = bridge.uiScale();
    if (const auto view = bridge.viewState())
        outcome.workspace = view->workspace;
    return outcome;
}

// ---- The result ------------------------------------------------------------------------------------

bool sameScale(const std::optional<UiScale>& a, const std::optional<UiScale>& b)
{
    if (!a || !b)
        return a.has_value() == b.has_value();
    return a->rootNote == b->rootNote && a->scaleType == b->scaleType;
}

/** {root, scale}, as ui.getState reports uiScale. */
JsonValue scaleJson(const UiScale& scale)
{
    auto json = JsonValue::object();
    json.appendMember("root", JsonValue::integer(juce::jlimit(0, 11, scale.rootNote)));
    json.appendMember("scale", JsonValue::string(controlScaleName(uiScaleTypeToScale(scale.scaleType))));
    return json;
}

JsonValue idsJson(ControlOpContext& context, const std::vector<std::uint64_t>& ids)
{
    auto json = JsonValue::array();
    for (const auto id : ids)
        json.append(JsonValue::string(controlPlacementId(context, id)));
    return json;
}

JsonValue selectionRef()
{
    auto ref = JsonValue::object();
    ref.appendMember("singleton", JsonValue::string("selection"));
    return ref;
}

JsonValue fieldPair(JsonValue before, JsonValue after)
{
    auto pair = JsonValue::object();
    pair.appendMember("before", std::move(before));
    pair.appendMember("after", std::move(after));
    pair.appendMember("unit", JsonValue());
    return pair;
}

JsonValue contentSubject(const std::string& contentId)
{
    auto subject = JsonValue::object();
    subject.appendMember("contentId", JsonValue::string(contentId));
    return subject;
}

/** Records the selection and its effects; returns whether there was anything to record. */
bool record(ControlOpContext& context, ControlWriteEnvelope& envelope, const Target& target, const Before& before,
            const Outcome& after)
{
    bool recorded = false;
    auto fields = JsonValue::object();
    if (after.selection.activeTrack != before.selection.activeTrack) {
        const auto trackJson = [](int trackId) { return trackId >= 0 ? JsonValue::integer(trackId) : JsonValue(); };
        fields.appendMember("activeTrackId",
                            fieldPair(trackJson(before.selection.activeTrack), trackJson(after.selection.activeTrack)));
    }
    if (after.selection.selected != before.selection.selected)
        fields.appendMember("selectedPlacementIds", fieldPair(idsJson(context, before.selection.selected),
                                                              idsJson(context, after.selection.selected)));
    if (fields.size() != 0) {
        envelope.addChange("selection", selectionRef(), JsonValue::string("Selection"), std::move(fields));
        recorded = true;
    }
    if (after.noteCount.has_value()) {
        // The piano roll generated the notes with no undo entry; nothing but deleting the clip takes them away.
        auto effect = JsonValue::object();
        effect.appendMember("contentId", JsonValue::string(target.contentId));
        effect.appendMember("noteCount", JsonValue::integer(static_cast<std::int64_t>(*after.noteCount)));
        effect.appendMember("revert", JsonValue());
        envelope.addSideEffect("notesGenerated", std::move(effect));
        for (const char* code : {"SELECTION_GENERATED_NOTES", "IRREVERSIBLE"})
            envelope.addWarning(code, contentSubject(target.contentId));
        envelope.touchContent(target.contentId);
        recorded = true;
    }
    if (!after.referenceContents.empty()) {
        auto ids = JsonValue::array();
        for (const auto& id : after.referenceContents) {
            ids.append(JsonValue::string(id));
            envelope.touchContent(id);
        }
        auto effect = JsonValue::object();
        effect.appendMember("contentIds", std::move(ids));
        effect.appendMember("revert", JsonValue());
        envelope.addSideEffect("referenceAnalysisQueued", std::move(effect));
        auto subject = JsonValue::object();
        subject.appendMember("placementId", JsonValue::string(controlPlacementId(context, target.placementId)));
        envelope.addWarning("REFERENCE_ANALYSIS_QUEUED", std::move(subject));
        recorded = true;
    }
    if (before.scale && after.scale && !sameScale(before.scale, after.scale)) {
        auto effect = JsonValue::object();
        effect.appendMember("before", scaleJson(*before.scale));
        effect.appendMember("after", scaleJson(*after.scale));
        effect.appendMember("revert", JsonValue());
        envelope.addSideEffect("uiScaleChanged", std::move(effect));
        recorded = true;
    }
    if (!before.workspace.empty() && !after.workspace.empty() && after.workspace != before.workspace) {
        auto effect = JsonValue::object();
        effect.appendMember("from", JsonValue::string(before.workspace));
        effect.appendMember("to", JsonValue::string(after.workspace));
        effect.appendMember("revert", JsonValue());
        envelope.addSideEffect("workspaceSwitched", std::move(effect));
        recorded = true;
    }
    return recorded;
}

/** ui.setSelection of the active track and its selected clip from before the call; null when no track was active or
    the instance does not report ui.bridge (PROTOCOL.md section 15.2 rule 2). */
JsonValue revertRecipe(ControlOpContext& context, const SelectionState& before)
{
    if (before.activeTrack < 0 || !controlReportsCapability(context, "ui.bridge"))
        return JsonValue();
    auto params = JsonValue::object();
    if (!before.selected.empty())
        params.appendMember("placementId", JsonValue::string(controlPlacementId(context, before.selected.front())));
    else
        params.appendMember("trackId", JsonValue::integer(before.activeTrack));
    return controlRevertRecipe("ui.setSelection", std::move(params));
}

/** A short description of the effects, for the log when the observed ones differ from the prediction. */
std::string describe(const Outcome& outcome)
{
    std::string text = "active track " + std::to_string(outcome.selection.activeTrack) + ", "
                       + std::to_string(outcome.selection.selected.size()) + " selected";
    if (outcome.noteCount)
        text += ", " + std::to_string(*outcome.noteCount) + " notes generated";
    if (!outcome.referenceContents.empty())
        text += ", reference analysis of " + std::to_string(outcome.referenceContents.size()) + " contents";
    if (outcome.scale)
        text += ", scale " + std::to_string(outcome.scale->rootNote) + "/" + std::to_string(outcome.scale->scaleType);
    return text + ", " + outcome.workspace;
}

// ---- ui.setSelection -------------------------------------------------------------------------------

Error noEditor()
{
    return controlOpError("UNSUPPORTED", "capability_missing",
                          "ui.bridge describes the OpenTune editor window, and no editor exists");
}

Result<JsonValue> runSetSelection(ControlOpContext& context, const SelectionParams& params)
{
    auto* bridge = context.bridge();
    if (bridge == nullptr || !bridge->canSelect())
        return noEditor();
    Target target;
    if (params.placement) {
        const auto placement = controlResolvePlacement(context, *params.placement);
        if (!placement.ok())
            return placement.error();
        target.trackId = placement.value().trackId;
        target.placementId = placement.value().placement.placementId;
        target.key = placement.value().placement.contentKey;
        target.contentId = controlContentId(context, target.key);
    } else {
        if (auto missing = controlCheckTrackSlot(context, params.trackId))
            return *missing;
        target.trackId = params.trackId;
    }
    if (auto busy = controlCheckBusy(context))
        return *busy;

    const auto before = captureBefore(context, *bridge, target);
    const auto predicted = predict(context, *bridge, target, before, params.openEditor);
    if (params.dryRun) {
        ControlWriteEnvelope envelope(context);
        record(context, envelope, target, before, predicted);
        return envelope.predicted(context);
    }

    ControlWriteEnvelope envelope(context);
    if (!bridge->select(target.trackId, target.placementId, params.openEditor))
        return controlOpError("INTERNAL", "", "the editor did not take the selection");
    const auto observed = observe(context, *bridge, target, before);
    if (observed.noteCount.has_value())
        // As the editor's piano roll does after it generated the notes (its contentEdited listener).
        controlMarkDirty(context);
    if (record(context, envelope, target, before, observed))
        envelope.setNotUndoable("not_persisted_state", revertRecipe(context, before.selection));
    // The result reports what happened; a prediction that missed is logged, so that a drift of the mirrored steps
    // shows.
    const auto expected = describe(predicted);
    const auto actual = describe(observed);
    if (expected != actual)
        AppLogger::logNoThrow("control API: ui.setSelection: the effects differ from the prediction (predicted "
                              + expected + "; observed " + actual + ")");
    return envelope.committed(context);
}

} // namespace

void registerSelectionOps(ControlMethodTable& table)
{
    table.add(controlWriteMethod<SelectionParams>("ui.setSelection", parseSetSelection, runSetSelection));
}

} // namespace OpenTune
