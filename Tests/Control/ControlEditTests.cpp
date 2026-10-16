// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of the undo history, the key, AUTO, the note edits and the pitch shift (edit.getHistory, edit.undo,
// edit.redo, content.setKey, content.autoTune, content.editNotes, content.setPitchShift) against the real
// processor without a window or an audio device, with a test bridge for the dirty flag and the selection.
// Contents get synthetic F0 (ControlContentFixtures.h). Entries the user would make in the UI are pushed the
// way the UI pushes them: the same upstream undo actions, unwrapped. Registered with the other processor
// scenarios in ControlProcessorTests.cpp.

#include "ControlContentFixtures.h"
#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Content/EditableContentSnapshot.h"
#include "Control/ControlDispatcher.h"
#include "Control/ControlJobs.h"
#include "Control/Edit/ContentEditTransaction.h"
#include "Control/Edit/ControlOriginAction.h"
#include "Control/Ops/OpsRegistry.h"
#include "PluginProcessor.h"
#include "Utils/PitchShiftEditAction.h"
#include "Utils/PitchUtils.h"
#include "Utils/PlacementActions.h"
#include "Utils/ScaleUiMapping.h"
#include "Utils/TuningConfig.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <tuple>

namespace OpenTune {
namespace ControlTest {

namespace {

/** Bound of one vector's exchange while this thread pumps messages. */
constexpr int kVectorExchangeMs = 30000;

JsonValue jsonOf(const std::string& text)
{
    auto parsed = parseJson(text);
    CONTROL_CHECK(parsed.ok);
    return parsed.value;
}

std::string jsonQuoted(const std::string& text)
{
    std::string out;
    appendJsonQuoted(out, text);
    return out;
}

/** Registers a test bridge with the processor's service for as long as it lives. */
class ScopedTestBridge
{
public:
    ScopedTestBridge(ControlService& service, TestUiBridge& bridge) : service_(service)
    {
        service_.setUiBridge(&bridge);
    }
    ~ScopedTestBridge() { service_.setUiBridge(nullptr); }

private:
    ControlService& service_;
};

/** The clip of the AUTO vectors: track 0 from 2 s, 6 s long, four notes, A minor (manual). */
ClipSpec fourNoteSpec()
{
    ClipSpec spec;
    spec.name = "edit";
    spec.trackId = 0;
    spec.startTimelineSec = 2.0;
    spec.notes = {{0.5, 1.5, 64.0}, {2.0, 3.0, 69.0}, {3.5, 4.5, 69.3}, {5.0, 5.8, 66.2}};
    DetectedKey key;
    key.root = Key::A;
    key.scale = Scale::Minor;
    key.origin = Origin::Manual;
    key.confidence = 1.0f;
    spec.key = key;
    return spec;
}

// ---- The state of a content, for "undo restores the state before" ---------------------------------

struct ContentState
{
    std::vector<Note> notes;
    std::vector<PitchCorrectionSegment> segments;
    DetectedKey key;
};

ContentState stateOf(OpenTuneAudioProcessor& processor, const ContentKey& key)
{
    ContentState state;
    if (const auto snapshot = processor.getContentSnapshot(key)) {
        state.notes = snapshot->notes;
        if (snapshot->pitchCurve != nullptr)
            state.segments = snapshot->pitchCurve->getCorrectionSegments();
        state.key = snapshot->detectedKey;
    }
    return state;
}

bool sameNotes(const std::vector<Note>& a, const std::vector<Note>& b)
{
    if (a.size() != b.size())
        return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].startTime != b[i].startTime || a[i].endTime != b[i].endTime || a[i].pitch != b[i].pitch
            || a[i].originalPitch != b[i].originalPitch || a[i].pitchOffset != b[i].pitchOffset
            || a[i].retuneSpeed != b[i].retuneSpeed)
            return false;
    return true;
}

bool sameSegments(const std::vector<PitchCorrectionSegment>& a, const std::vector<PitchCorrectionSegment>& b)
{
    if (a.size() != b.size())
        return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].startFrame != b[i].startFrame || a[i].endFrame != b[i].endFrame || a[i].f0Data != b[i].f0Data)
            return false;
    return true;
}

bool sameState(const ContentState& a, const ContentState& b)
{
    return sameNotes(a.notes, b.notes) && sameSegments(a.segments, b.segments) && a.key.root == b.key.root
           && a.key.scale == b.key.scale && a.key.origin == b.key.origin;
}

// ---- Entries as the UI and the API record them ---------------------------------------------------------

/** Shifts every note by cents through the content commands over the whole content, and records the edit as
    one PianoRollEditAction (the range commit of the piano roll). Returns the inner action, not pushed. */
std::optional<ControlOriginAction::Inner> noteEdit(OpenTuneAudioProcessor& processor, const ContentKey& key,
                                                   double cents)
{
    ContentEditTransaction transaction(processor, key);
    if (!CONTROL_CHECK(transaction.captureBefore()))
        return std::nullopt;
    const auto snapshot = processor.getContentSnapshot(key);
    auto notes = snapshot->notes;
    for (auto& note : notes)
        note.pitch *= static_cast<float>(std::pow(2.0, cents / 1200.0));
    const int frames = static_cast<int>(snapshot->pitchCurve->size());
    if (!CONTROL_CHECK(processor.commitContentNotesAndSegments(
                           key, notes, snapshot->pitchCurve->getCorrectionSegments(), ContentEditRangeFrames{0, frames})
                       != nullptr))
        return std::nullopt;
    if (!CONTROL_CHECK(transaction.recordRange(TRANS("编辑"), F0FrameRange{0, frames})))
        return std::nullopt;
    auto actions = transaction.takeActions();
    return std::move(actions.front());
}

/** A note edit the user made in the UI: the PianoRollEditAction on the history as the piano roll pushes it. */
bool pushUiNoteEdit(OpenTuneAudioProcessor& processor, const ContentKey& key, double cents = 20.0)
{
    auto inner = noteEdit(processor, key, cents);
    if (!inner)
        return false;
    processor.getUndoManager().addAction(std::move(inner->action));
    return true;
}

/** A note edit made through the API: the same action in a ControlOriginAction. Returns its undoId. */
std::string pushControlNoteEdit(ControlService& service, OpenTuneAudioProcessor& processor, const ContentKey& key,
                                const std::string& instanceShort)
{
    auto inner = noteEdit(processor, key, 20.0);
    if (!inner)
        return {};
    std::vector<ControlOriginAction::Inner> actions;
    actions.push_back(std::move(*inner));
    const auto undoId = service.history()->nextUndoId(instanceShort);
    processor.getUndoManager().addAction(
        std::make_unique<ControlOriginAction>(service.history(), undoId, TRANS("编辑"), std::move(actions)));
    return undoId;
}

/** A pitch shift made through the API: OpenTuneAudioProcessor::commitPitchShiftEdit() and its action in a
    ControlOriginAction. Returns its undoId. */
std::string pushControlPitchShift(ControlService& service, OpenTuneAudioProcessor& processor, const ContentKey& key,
                                  const std::string& instanceShort)
{
    PitchShiftSettings settings;
    settings.semitone = 2;
    auto action = processor.commitPitchShiftEdit(key, settings);
    if (!CONTROL_CHECK(action != nullptr))
        return {};
    std::vector<ControlOriginAction::Inner> actions(1);
    const auto description = action->getDescription();
    actions[0].action = std::move(action);
    actions[0].name = "PitchShiftEditAction";
    actions[0].content = key;
    actions[0].aspect = ControlContentAspect::PitchShift;
    const auto undoId = service.history()->nextUndoId(instanceShort);
    processor.getUndoManager().addAction(
        std::make_unique<ControlOriginAction>(service.history(), undoId, description, std::move(actions)));
    return undoId;
}

/** How often a MarkerAction was undone and redone. */
struct MarkerCounts
{
    int undos = 0;
    int redos = 0;
};

/** An entry of the history that changes nothing and counts its steps: a stand-in for any entry the user makes
    in the UI, cheap enough to fill OpenTune's history to its capacity. */
class MarkerAction final : public UndoAction
{
public:
    explicit MarkerAction(juce::String description, std::shared_ptr<MarkerCounts> counts = nullptr)
        : description_(std::move(description))
        , counts_(std::move(counts))
    {}
    void undo() override
    {
        if (counts_ != nullptr)
            ++counts_->undos;
    }
    void redo() override
    {
        if (counts_ != nullptr)
            ++counts_->redos;
    }
    juce::String getDescription() const override { return description_; }

private:
    juce::String description_;
    std::shared_ptr<MarkerCounts> counts_;
};

void pushMarkers(UndoManager& manager, int count)
{
    for (int i = 0; i < count; ++i)
        manager.addAction(std::make_unique<MarkerAction>("filler"));
}

/** A clip split the user made in the arrangement: the first clip of the track split in its middle, and the
    SplitPlacementAction on the history, as ArrangementViewComponent pushes it. */
bool pushUiSplit(OpenTuneAudioProcessor& processor, int trackId)
{
    StandaloneArrangement::Placement placement;
    if (!CONTROL_CHECK(processor.getStandaloneArrangement()->getPlacementByIndex(trackId, 0, placement)))
        return false;
    const auto outcome =
        processor.splitPlacementAtSeconds(trackId, 0, placement.timelineStartSeconds + placement.durationSeconds / 2);
    if (!CONTROL_CHECK(outcome.has_value()))
        return false;
    processor.getUndoManager().addAction(std::make_unique<SplitPlacementAction>(processor, *outcome));
    return true;
}

// ---- Reading results -------------------------------------------------------------------------------

/** The tokens of a content as a fresh project.get reports them. */
JsonValue freshTokens(ApiSession& api, const std::string& contentId)
{
    const auto project = api.result("project.get");
    const auto& contents = memberOf(memberOf(project, "asOf"), "contents");
    for (std::size_t i = 0; i < contents.size(); ++i)
        if (memberOf(contents.at(i), "contentId").text() == contentId)
            return contents.at(i);
    return JsonValue();
}

/** The tokens of the content in a write result. */
JsonValue resultTokens(const JsonValue& result, const std::string& contentId)
{
    const auto& contents = memberOf(memberOf(result, "tokens"), "contents");
    for (std::size_t i = 0; i < contents.size(); ++i)
        if (memberOf(contents.at(i), "contentId").text() == contentId)
            return contents.at(i);
    return JsonValue();
}

bool hasWarning(const JsonValue& result, const std::string& code)
{
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        if (memberOf(warnings.at(i), "code").text() == code)
            return true;
    return false;
}

std::vector<int> noteIndexes(const JsonValue& entries)
{
    std::vector<int> indexes;
    for (std::size_t i = 0; i < entries.size(); ++i)
        indexes.push_back(
            static_cast<int>(memberOf(memberOf(memberOf(entries.at(i), "ref"), "note"), "index").asDouble()));
    return indexes;
}

/** The error data of a response, or null. */
JsonValue errorOf(const JsonValue& response)
{
    const JsonValue* data = errorData(response);
    return data != nullptr ? *data : JsonValue();
}

bool isErrorOf(const JsonValue& response, const std::string& kind, const std::string& reason, bool retryable)
{
    const auto data = errorOf(response);
    const bool ok = memberOf(data, "kind").text() == kind && memberOf(data, "reason").text() == reason
                    && memberOf(data, "retryable").isBoolean() && memberOf(data, "retryable").asBoolean() == retryable
                    && memberOf(data, "executed").isBoolean() && !memberOf(data, "executed").asBoolean();
    if (!ok)
        note("expected " + kind + "(" + reason + "), got " + toJsonString(response));
    return ok;
}

/** A started processor with a test bridge, a session and the four-note clip. */
struct EditFixture
{
    std::unique_ptr<OpenTuneAudioProcessor> processor;
    TestUiBridge bridge;
    std::unique_ptr<ScopedTestBridge> registered;
    ApiSession api;
    Clip clip;
    std::string contentId;
    std::string placementId;
    std::string instanceShort;

    bool open(const ClipSpec& spec)
    {
        processor = startedProcessor();
        auto& service = processor->getControlService();
        if (!service.isRunning())
            return false;
        registered = std::make_unique<ScopedTestBridge>(service, bridge);
        clip = fixtureAddClip(*processor, spec);
        if (!api.open(service))
            return false;
        instanceShort = memberOf(api.discovery(), "instanceId").text().substr(0, 8);
        const auto handles = fixtureHandlesOf(api.result("project.get"), spec.trackId, spec.startTimelineSec);
        if (!CONTROL_CHECK(handles.has_value()))
            return false;
        contentId = handles->contentId;
        placementId = handles->placementId;
        return true;
    }

    ControlService& service() { return processor->getControlService(); }
    std::string revision() { return memberOf(freshTokens(api, contentId), "revision").text(); }
    std::string keyRevision() { return memberOf(freshTokens(api, contentId), "keyRevision").text(); }

    JsonValue regenerate(const std::string& ranges, const std::string& extra = {})
    {
        return api.result("content.autoTune",
                          jsonOf("{\"contentId\":" + jsonQuoted(contentId)
                                 + ",\"mode\":\"regenerate\",\"expectedRevision\":" + jsonQuoted(revision())
                                 + ",\"key\":{\"root\":0,\"scale\":\"major\"}"
                                 + (ranges.empty() ? "" : ",\"ranges\":" + ranges) + extra + "}"));
    }

    JsonValue undo(const std::string& undoId, const char* method = "edit.undo")
    {
        return api.result(method, jsonOf("{\"expectedUndoId\":" + jsonQuoted(undoId) + "}"));
    }

    JsonValue history() { return memberOf(api.result("edit.getHistory"), "history"); }

    /** The params of content.editNotes at the current revision. */
    JsonValue editNotesParams(const std::string& ops, const std::string& extra = {})
    {
        return jsonOf("{\"contentId\":" + jsonQuoted(contentId) + ",\"expectedRevision\":" + jsonQuoted(revision())
                      + ",\"ops\":" + ops + extra + "}");
    }
    JsonValue editNotes(const std::string& ops, const std::string& extra = {})
    {
        return api.result("content.editNotes", editNotesParams(ops, extra));
    }

    JsonValue snapNotes(const std::string& key, const std::string& extra = {})
    {
        return api.result("content.autoTune", jsonOf("{\"contentId\":" + jsonQuoted(contentId)
                                                     + ",\"mode\":\"snapNotes\",\"expectedRevision\":"
                                                     + jsonQuoted(revision()) + ",\"key\":" + key + extra + "}"));
    }

    JsonValue setPitchShift(int semitones, int cents)
    {
        return api.result("content.setPitchShift",
                          jsonOf("{\"contentId\":" + jsonQuoted(contentId) + ",\"pitchShift\":{\"semitones\":"
                                 + std::to_string(semitones) + ",\"cents\":" + std::to_string(cents) + "}}"));
    }
};

// ---- Scenario: edit.getHistory, edit.undo, edit.redo -------------------------------------------------

void checkStepParams(EditFixture& f)
{
    // Without force, expectedUndoId is required and must be an undoId; with force it is not even parsed.
    for (const char* params : {R"({})", R"({"expectedUndoId":"x"})", R"({"expectedUndoId":"u:0123456:1"})",
                               R"({"expectedUndoId":"u:01234567:0"})", R"({"force":"yes"})", R"({"other":1})"})
        CONTROL_CHECK(f.api.fails("edit.undo", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(f.api.fails("edit.getHistory", jsonOf(R"({"x":1})"), "INVALID_ARGUMENT", "invalid_params"));
    const auto empty = f.history();
    CONTROL_CHECK(toJsonString(empty)
                  == R"({"canUndo":false,"canRedo":false,"undoCount":0,"redoCount":0,"undoTop":null,"redoTop":null})");
    // An empty history is UNDO_CONFLICT(history_empty), also with force and an expectedUndoId of any value.
    CONTROL_CHECK(isErrorOf(f.api.request("edit.undo", jsonOf(R"({"force":true,"expectedUndoId":5})")), "UNDO_CONFLICT",
                            "history_empty", false));
    CONTROL_CHECK(isErrorOf(f.api.request("edit.redo", jsonOf(R"({"expectedUndoId":"u:01234567:1"})")), "UNDO_CONFLICT",
                            "history_empty", false));
}

/** AUTO through the API, undo and redo: one step each, back to the exact state before and after; the entry's
    origin and id; dirty and the editor's refresh after every step; tokens equal a fresh read. */
void checkUndoRedoOfApiEntry(EditFixture& f)
{
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto applied = f.regenerate(R"([{"startContentSec":1,"endContentSec":4}])");
    const auto undoId = memberOf(memberOf(applied, "undo"), "undoId").text();
    CONTROL_CHECK(!undoId.empty());
    const auto after = stateOf(*f.processor, f.clip.key);
    CONTROL_CHECK(!sameState(before, after));
    const auto top = memberOf(f.history(), "undoTop");
    CONTROL_CHECK(memberOf(top, "undoId").text() == undoId && memberOf(top, "origin").text() == "control"
                  && !memberOf(top, "unsafe").asBoolean() && !memberOf(top, "possiblyStale").asBoolean());

    const int marks = f.bridge.dirtyMarks;
    const int refreshes = f.bridge.undoRedoNotifications;
    const auto undone = f.undo(undoId);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(memberOf(undone, "applied").asBoolean() && !memberOf(undone, "noOp").asBoolean());
    CONTROL_CHECK(
        toJsonString(memberOf(undone, "undo"))
        == R"({"undoable":false,"reason":"ui_parity","revert":{"method":"edit.redo","params":{"expectedUndoId":)"
               + jsonQuoted(undoId) + "}}}");
    CONTROL_CHECK(memberOf(memberOf(undone, "entry"), "undoId").text() == undoId);
    CONTROL_CHECK(f.bridge.dirtyMarks > marks && f.bridge.undoRedoNotifications == refreshes + 1);
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(undone, f.contentId), freshTokens(f.api, f.contentId)));
    const auto& changes = memberOf(undone, "changes");
    CONTROL_CHECK(changes.size() == 1 && memberOf(changes.at(0), "entity").text() == "content");
    CONTROL_CHECK(memberOf(memberOf(undone, "sideEffects"), "reRenderQueued").isObject());

    // The redo is the undo's revert recipe, sent unchanged.
    const auto& recipe = memberOf(memberOf(undone, "undo"), "revert");
    const auto redone = f.api.result(memberOf(recipe, "method").text(), memberOf(recipe, "params"));
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
    CONTROL_CHECK(memberOf(memberOf(memberOf(redone, "undo"), "revert"), "method").text() == "edit.undo");
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(redone, f.contentId), freshTokens(f.api, f.contentId)));

    // The user's Ctrl+Z applies the API's entry as the UI's own: OpenTune's UndoManager::undo().
    CONTROL_CHECK(f.processor->getUndoManager().undo() != nullptr);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(f.processor->getUndoManager().redo() != nullptr);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
}

/** The user edits after the API: the API's undo names its own entry and gets UNDO_CONFLICT(top_mismatch), the
    user's edit stays; with force (the end user asked) the UI entry is undone, gets an undoId, and its revert
    recipe redoes it. */
void checkUserEditOnTop(EditFixture& f)
{
    const auto applied = f.regenerate("");
    const auto apiId = memberOf(memberOf(applied, "undo"), "undoId").text();
    CONTROL_CHECK(pushUiNoteEdit(*f.processor, f.clip.key));
    const auto userEdited = stateOf(*f.processor, f.clip.key);
    const auto top = memberOf(f.history(), "undoTop");
    CONTROL_CHECK(memberOf(top, "undoId").isNull() && memberOf(top, "origin").text() == "ui");
    CONTROL_CHECK(f.api.fails("edit.undo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(apiId) + "}"), "UNDO_CONFLICT",
                              "top_mismatch"));
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), userEdited));

    const auto forced = f.api.result("edit.undo", jsonOf(R"({"force":true})"));
    const auto uiId = memberOf(memberOf(forced, "entry"), "undoId").text();
    CONTROL_CHECK(!uiId.empty() && uiId != apiId && memberOf(memberOf(forced, "entry"), "origin").text() == "ui");
    CONTROL_CHECK(!sameState(stateOf(*f.processor, f.clip.key), userEdited));
    const auto history = f.history();
    CONTROL_CHECK(memberOf(memberOf(history, "redoTop"), "undoId").text() == uiId);
    CONTROL_CHECK(memberOf(memberOf(history, "undoTop"), "undoId").text() == apiId);
    const auto& recipe = memberOf(memberOf(forced, "undo"), "revert");
    CONTROL_CHECK(memberOf(memberOf(recipe, "params"), "force").isNull());
    f.api.result(memberOf(recipe, "method").text(), memberOf(recipe, "params"));
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), userEdited));
    CONTROL_CHECK(memberOf(memberOf(f.history(), "undoTop"), "undoId").text() == uiId);
}

/** A clip split on top is refused, also with force (UNSUPPORTED(undo_unsafe_build)); the history says so. */
void checkUnsafeTop(EditFixture& f)
{
    CONTROL_CHECK(pushUiSplit(*f.processor, 0));
    const auto top = memberOf(f.history(), "undoTop");
    CONTROL_CHECK(memberOf(top, "unsafe").asBoolean() && memberOf(top, "origin").text() == "ui");
    CONTROL_CHECK(f.api.fails("edit.undo", jsonOf(R"({"force":true})"), "UNSUPPORTED", "undo_unsafe_build"));
    CONTROL_CHECK(memberOf(f.history(), "undoCount").asDouble() >= 1);
}

/** Opening a project clears OpenTune's history: undo then has nothing to undo, and old ids name nothing. */
void checkProjectOpenClearsHistory(EditFixture& f, const std::string& oldId)
{
    CONTROL_CHECK(fixtureSaveAndReopen(*f.processor));
    const auto history = f.history();
    CONTROL_CHECK(!memberOf(history, "canUndo").asBoolean() && !memberOf(history, "canRedo").asBoolean());
    CONTROL_CHECK(f.api.fails("edit.undo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(oldId) + "}"), "UNDO_CONFLICT",
                              "history_empty"));
}

/** Rule 9: a change without an undo entry is never taken back; entries recorded before stop putting back the
    aspect it changed, and it clears the redo history. */
void checkChangesWithoutEntry(EditFixture& f)
{
    // AUTO, then notesOnly (no entry) replaces every note: undoing AUTO has nothing left to put back.
    const auto applied = f.regenerate("");
    const auto autoId = memberOf(memberOf(applied, "undo"), "undoId").text();
    const auto notesOnly = f.api.result(
        "content.autoTune", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                   + ",\"mode\":\"notesOnly\",\"expectedRevision\":" + jsonQuoted(f.revision()) + "}"));
    CONTROL_CHECK(hasWarning(notesOnly, "REPLACES_ALL_NOTES") && hasWarning(notesOnly, "IRREVERSIBLE"));
    const auto generated = stateOf(*f.processor, f.clip.key);
    const auto undone = f.undo(autoId);
    CONTROL_CHECK(memberOf(undone, "applied").asBoolean() && memberOf(undone, "noOp").asBoolean());
    CONTROL_CHECK(toJsonString(memberOf(undone, "warnings"))
                  == R"([{"code":"UNDO_NO_EFFECT","subject":null,"data":null}])");
    CONTROL_CHECK(memberOf(memberOf(undone, "dirty"), "after").asBoolean());
    CONTROL_CHECK(sameNotes(stateOf(*f.processor, f.clip.key).notes, generated.notes));

    // A note edit undone, then a key change: the redo history is gone.
    const auto editId = pushControlNoteEdit(f.service(), *f.processor, f.clip.key, f.instanceShort);
    f.undo(editId);
    CONTROL_CHECK(memberOf(f.history(), "canRedo").asBoolean());
    f.api.result("content.setKey",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":2,"scale":"dorian"}})"));
    CONTROL_CHECK(!memberOf(f.history(), "canRedo").asBoolean());
    CONTROL_CHECK(f.api.fails("edit.redo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(editId) + "}"), "UNDO_CONFLICT",
                              "history_empty"));

    // For comparison, the UI's own key change keeps the redo history: PluginEditor::scaleChanged() only calls
    // setContentDetectedKey(), so after a UI undo the user can still redo; the API's key change clears it.
    auto& manager = f.processor->getUndoManager();
    CONTROL_CHECK(pushUiNoteEdit(*f.processor, f.clip.key));
    CONTROL_CHECK(manager.undo() != nullptr && manager.canRedo());
    CONTROL_CHECK(f.processor->setContentDetectedKey(f.clip.key, makeDetectedKeyFromUi(5, 1)));
    CONTROL_CHECK(manager.canRedo());
    f.api.result("content.setKey",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":7,"scale":"major"}})"));
    CONTROL_CHECK(!manager.canRedo());

    // A note edit, then a key change, then the undo: the notes go back, the later key stays.
    const auto beforeEdit = stateOf(*f.processor, f.clip.key);
    const auto secondId = pushControlNoteEdit(f.service(), *f.processor, f.clip.key, f.instanceShort);
    f.api.result("content.setKey",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":4,"scale":"major"}})"));
    const auto keyUndone = f.undo(secondId);
    const auto now = stateOf(*f.processor, f.clip.key);
    CONTROL_CHECK(sameNotes(now.notes, beforeEdit.notes));
    CONTROL_CHECK(now.key.root == Key::E && now.key.scale == Scale::Major);
    CONTROL_CHECK(memberOf(keyUndone, "changes").size() == 1);
}

/** ControlHistory on its own: the undoId of a UI entry is confirmed at its position while the history is not
    full, also after other changes; once the history is full and changed, every position may have moved
    (UndoManager::addAction() drops the oldest entry), so the id is no longer confirmed; the API's own steps
    keep it. The remembered entries are objects outside the history standing in for the entry at that
    position, which is what an entry that took the memory of a dropped one would look like. */
void checkHistoryCapacityRule()
{
    constexpr int capacity = ControlHistory::kUndoHistoryCapacity;
    constexpr std::uint64_t epoch = 1;
    UndoManager manager;
    ControlHistory history;
    pushMarkers(manager, 1);
    const MarkerAction atFirst("edit");
    const auto id = history.assignUndoId(manager, atFirst, 0, epoch, "01234567");
    CONTROL_CHECK(history.describe(manager, atFirst, 0, epoch).undoId == id);
    pushMarkers(manager, capacity - 2);
    CONTROL_CHECK(manager.size() == capacity - 1 && history.describe(manager, atFirst, 0, epoch).undoId == id);
    // The history becomes full: from now on positions can move without a sign, the id is forgotten.
    pushMarkers(manager, 1);
    CONTROL_CHECK(manager.size() == capacity && !history.describe(manager, atFirst, 0, epoch).undoId.has_value());

    // At the capacity, an id assigned now survives the API's own undo and redo (noteOwnStep) ...
    const MarkerAction atTop("edit");
    const auto topId = history.assignUndoId(manager, atTop, capacity - 1, epoch, "01234567");
    CONTROL_CHECK(manager.undo() != nullptr);
    history.noteOwnStep(manager);
    CONTROL_CHECK(history.describe(manager, atTop, capacity - 1, epoch).undoId == topId);
    CONTROL_CHECK(manager.redo() != nullptr);
    history.noteOwnStep(manager);
    CONTROL_CHECK(history.describe(manager, atTop, capacity - 1, epoch).undoId == topId);
    // ... and not a new entry of the UI, which drops the oldest entry.
    pushMarkers(manager, 1);
    CONTROL_CHECK(manager.size() == capacity
                  && !history.describe(manager, atTop, capacity - 1, epoch).undoId.has_value());
}

/** Through the API: a UI entry that edit.undo applied with force (it got an undoId) moves down by one position
    when the user's new entries overflow the history. On top again, it is not confirmed: the call with its
    undoId fails with UNDO_CONFLICT(top_mismatch) and nothing is undone. */
void checkFullHistory(EditFixture& f)
{
    constexpr int capacity = ControlHistory::kUndoHistoryCapacity;
    auto& manager = f.processor->getUndoManager();
    pushMarkers(manager, capacity - 2 - manager.size());
    auto counts = std::make_shared<MarkerCounts>();
    auto target = std::make_unique<MarkerAction>("target", counts);
    const UndoAction* targetAddress = target.get();
    manager.addAction(std::move(target));
    CONTROL_CHECK(manager.size() == capacity - 1);

    // Below the capacity the forced step names the entry, and its revert recipe takes it back.
    const auto forced = f.api.result("edit.undo", jsonOf(R"({"force":true})"));
    const auto uiId = memberOf(memberOf(forced, "entry"), "undoId").text();
    CONTROL_CHECK(!uiId.empty() && counts->undos == 1);
    CONTROL_CHECK(memberOf(memberOf(memberOf(forced, "undo"), "revert"), "params").isObject());
    f.undo(uiId, "edit.redo");
    CONTROL_CHECK(counts->redos == 1 && memberOf(memberOf(f.history(), "undoTop"), "undoId").text() == uiId);

    // The user adds two entries: the first fills the history, the second drops the oldest one and moves every
    // entry down by one. Two Ctrl+Z bring the target back on top.
    pushMarkers(manager, 2);
    CONTROL_CHECK(manager.size() == capacity);
    CONTROL_CHECK(manager.undo() != nullptr && manager.undo() != nullptr);
    CONTROL_CHECK(manager.peekUndo() == targetAddress);
    CONTROL_CHECK(memberOf(memberOf(f.history(), "undoTop"), "undoId").isNull());
    CONTROL_CHECK(f.api.fails("edit.undo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(uiId) + "}"), "UNDO_CONFLICT",
                              "top_mismatch"));
    CONTROL_CHECK(counts->undos == 1 && manager.peekUndo() == targetAddress);

    // At the capacity a forced step still names its entry, and its revert recipe works while the history
    // stays as the step left it.
    const auto again = f.api.result("edit.undo", jsonOf(R"({"force":true})"));
    const auto newId = memberOf(memberOf(again, "entry"), "undoId").text();
    CONTROL_CHECK(!newId.empty() && newId != uiId && counts->undos == 2);
    f.undo(newId, "edit.redo");
    CONTROL_CHECK(counts->redos == 2);
}

void scenarioUndoImpl()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    checkStepParams(f);
    checkUndoRedoOfApiEntry(f);
    checkUserEditOnTop(f);
    checkChangesWithoutEntry(f);
    const auto lastId = memberOf(memberOf(f.history(), "undoTop"), "undoId").text();
    checkUnsafeTop(f);
    checkProjectOpenClearsHistory(f, lastId.empty() ? "u:01234567:1" : lastId);
    checkHistoryCapacityRule();
    checkFullHistory(f);
    CONTROL_CHECK(f.service().dispatcher()->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- Scenario: content.setKey ------------------------------------------------------------------------

void scenarioSetKeyImpl()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    const auto revision = f.revision();
    const auto keyRevision = f.keyRevision();
    const auto before = stateOf(*f.processor, f.clip.key);

    // A minor to C major: the key aspect only; no undo entry; the revert recipe restores A minor.
    const auto set = f.api.result("content.setKey", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                                           + R"(,"key":{"root":0,"scale":"major"}})"));
    CONTROL_CHECK(memberOf(set, "applied").asBoolean() && !memberOf(set, "noOp").asBoolean());
    CONTROL_CHECK(
        toJsonString(memberOf(memberOf(set, "changes").at(0), "fields"))
        == R"({"root":{"before":9,"after":0,"unit":null},"scale":{"before":"minor","after":"major","unit":null}})");
    const auto tokens = resultTokens(set, f.contentId);
    CONTROL_CHECK(VectorMatcher::equal(tokens, freshTokens(f.api, f.contentId)));
    CONTROL_CHECK(memberOf(tokens, "revision").text() == revision
                  && memberOf(tokens, "keyRevision").text() != keyRevision);
    CONTROL_CHECK(memberOf(memberOf(set, "undo"), "reason").text() == "ui_parity");
    CONTROL_CHECK(!hasWarning(set, "IRREVERSIBLE") && memberOf(set, "sideEffects").size() == 0);
    CONTROL_CHECK(memberOf(memberOf(set, "dirty"), "after").asBoolean() && f.bridge.dirtyMarks >= 1);
    CONTROL_CHECK(f.processor->getContentSnapshot(f.clip.key)->detectedKey.root == Key::C);
    CONTROL_CHECK(!memberOf(f.history(), "canUndo").asBoolean());

    // A request with the old key revision conflicts and changes nothing.
    CONTROL_CHECK(
        f.api.fails("content.setKey",
                    jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":4,"scale":"major"},)"
                           + "\"expectedKeyRevision\":" + jsonQuoted(keyRevision) + "}"),
                    "REVISION_CONFLICT", "key_changed"));
    // The revert recipe, sent unchanged, restores the previous key.
    const auto& recipe = memberOf(memberOf(set, "undo"), "revert");
    const auto reverted = f.api.result(memberOf(recipe, "method").text(), memberOf(recipe, "params"));
    CONTROL_CHECK(memberOf(reverted, "applied").asBoolean() && !memberOf(reverted, "noOp").asBoolean());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    // Setting the key the content has is a no-op.
    const auto same = f.api.result("content.setKey", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                                            + R"(,"key":{"root":9,"scale":"minor"}})"));
    CONTROL_CHECK(memberOf(same, "noOp").asBoolean()
                  && toJsonString(memberOf(same, "undo")) == R"({"undoable":false,"reason":"no_op","revert":null})");

    // The clip selected in the UI: the transport bar's scale follows, reported with the same revert recipe.
    f.bridge.selection = {f.clip.placementId};
    const auto shown = f.api.result("content.setKey", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                                             + R"(,"key":{"root":7,"scale":"dorian"}})"));
    CONTROL_CHECK(VectorMatcher::equal(memberOf(memberOf(memberOf(shown, "sideEffects"), "uiScaleChanged"), "revert"),
                                       memberOf(memberOf(shown, "undo"), "revert")));
    f.bridge.selection.clear();

    // Handles first, then the readiness gate.
    CONTROL_CHECK(f.api.fails("content.setKey",
                              jsonOf("{\"contentId\":" + jsonQuoted("c:" + f.instanceShort + ":0:4294967295")
                                     + R"(,"key":{"root":0,"scale":"major"}})"),
                              "NOT_FOUND", "unknown_handle"));
    for (const auto& [name, analysis, reason] : {std::make_tuple("running", Analysis::Running, "f0_not_ready"),
                                                 std::make_tuple("failed", Analysis::Failed, "f0_failed"),
                                                 std::make_tuple("unvoiced", Analysis::Failed, "f0_empty")}) {
        ClipSpec spec;
        spec.name = name;
        spec.trackId = std::string(name) == "running" ? 1 : std::string(name) == "failed" ? 2 : 3;
        spec.durationSec = 2.0;
        spec.analysis = analysis;
        const auto clip = fixtureAddClip(*f.processor, spec);
        if (std::string(reason) == "f0_empty")
            f.processor->recordF0FailureReason(clip.key, "f0_empty");
        const auto handles = fixtureHandlesOf(f.api.result("project.get"), spec.trackId, 0.0);
        if (!CONTROL_CHECK(handles.has_value()))
            continue;
        CONTROL_CHECK(
            isErrorOf(f.api.request("content.setKey", jsonOf("{\"contentId\":" + jsonQuoted(handles->contentId)
                                                             + R"(,"key":{"root":0,"scale":"major"}})")),
                      "NOT_READY", reason, std::string(reason) == "f0_not_ready"));
    }
    // Params: closed, key required, expectedKeyRevision a token.
    for (const char* params :
         {R"({"key":{"root":0,"scale":"major"}})", R"({"contentId":"c:00000000:0:1"})",
          R"({"contentId":"c:00000000:0:1","key":{"root":12,"scale":"major"}})",
          R"({"contentId":"c:00000000:0:1","key":{"root":0,"scale":"lydian"}})",
          R"({"contentId":"c:00000000:0:1","key":{"root":0,"scale":"major"},"x":1})",
          R"({"contentId":"c:00000000:0:1","key":{"root":0,"scale":"major"},"expectedKeyRevision":"a b"})"})
        CONTROL_CHECK(f.api.fails("content.setKey", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));
}

// ---- Scenario: content.autoTune ----------------------------------------------------------------------

/** Every created note lies inside a range and is snapped to C major. */
void checkCreatedNotes(EditFixture& f, const JsonValue& result, const std::vector<std::pair<double, double>>& ranges)
{
    const auto notes =
        memberOf(f.api.result("content.getNotes", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + "}")), "notes");
    const auto created = noteIndexes(memberOf(result, "created"));
    CONTROL_CHECK(!created.empty());
    const std::set<int> cMajor = {0, 2, 4, 5, 7, 9, 11};
    for (const int index : created) {
        if (!CONTROL_CHECK(static_cast<std::size_t>(index) < notes.size()))
            continue;
        const auto& item = notes.at(static_cast<std::size_t>(index));
        const double start = memberOf(item, "startContentSec").asDouble();
        const double end = memberOf(item, "endContentSec").asDouble();
        // Within the range's analysis frames; the generator lets a note's tail run on by up to 15 ms
        // (NoteSegmentationPolicy::tailExtendMs).
        CONTROL_CHECK(std::any_of(ranges.begin(), ranges.end(), [&](const std::pair<double, double>& range) {
            return start >= range.first - 0.011 && end <= range.second + 0.026;
        }));
        const int pitchClass = static_cast<int>(std::lround(memberOf(item, "targetMidi").asDouble())) % 12;
        CONTROL_CHECK(cMajor.count(pitchClass) == 1);
    }
}

void scenarioAutoTuneImpl()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto revision = f.revision();

    // dryRun predicts and changes nothing.
    const auto predicted = f.regenerate(R"([{"startContentSec":1,"endContentSec":4}])", R"(,"dryRun":true)");
    CONTROL_CHECK(memberOf(predicted, "dryRun").asBoolean() && !memberOf(predicted, "applied").asBoolean());
    CONTROL_CHECK(memberOf(predicted, "undo").isNull() && f.revision() == revision);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));

    // One range over 1-4 s, hand-computed: notes 0-2 overlap it and are removed, note 3 stays; notes 0 and 2
    // reach beyond it and are dropped (DROPPED_BOUNDARY_NOTES); one undo step.
    const auto applied = f.regenerate(R"([{"startContentSec":1,"endContentSec":4}])");
    if (!CONTROL_CHECK(noteIndexes(memberOf(applied, "removed")) == (std::vector<int>{0, 1, 2})))
        note("removed " + toJsonString(memberOf(applied, "removed")) + " created "
             + toJsonString(memberOf(applied, "created")));
    CONTROL_CHECK(noteIndexes(memberOf(predicted, "removed")) == (std::vector<int>{0, 1, 2}));
    CONTROL_CHECK(memberOf(predicted, "created").size() == memberOf(applied, "created").size());
    const auto& warnings = memberOf(applied, "warnings");
    CONTROL_CHECK(warnings.size() == 1 && memberOf(warnings.at(0), "code").text() == "DROPPED_BOUNDARY_NOTES");
    const auto& dropped = memberOf(memberOf(warnings.at(0), "data"), "notes");
    CONTROL_CHECK(dropped.size() == 2 && memberOf(memberOf(dropped.at(0), "note"), "index").asDouble() == 0
                  && memberOf(memberOf(dropped.at(1), "note"), "index").asDouble() == 2);
    checkCreatedNotes(f, applied, {{1.0, 4.0}});
    const auto& undo = memberOf(applied, "undo");
    CONTROL_CHECK(memberOf(undo, "undoable").asBoolean()
                  && toJsonString(memberOf(undo, "innerActions")) == R"(["PianoRollEditAction"])");
    CONTROL_CHECK(memberOf(undo, "description").text() == TRANS("自动调音").toStdString());
    CONTROL_CHECK(toJsonString(memberOf(applied, "paramsUsed"))
                  == R"({"retuneSpeed":0.15,"vibratoDepth":0,"vibratoRateHz":7.5,"noteSplitCents":80})");
    CONTROL_CHECK(toJsonString(memberOf(applied, "keyUsed")) == R"({"root":0,"scale":"major"})");
    CONTROL_CHECK(memberOf(memberOf(applied, "noteCount"), "before").asDouble() == 4);
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(applied, f.contentId), freshTokens(f.api, f.contentId)));
    // The prediction lists the side effects of the commit, member for member (PROTOCOL.md sections 14.4 and
    // 14.6: every side effect carries revert).
    const std::string reRender =
        R"({"reRenderQueued":{"contentIds":[)" + jsonQuoted(f.contentId) + R"(],"revert":null}})";
    CONTROL_CHECK(toJsonString(memberOf(applied, "sideEffects")) == reRender);
    CONTROL_CHECK(toJsonString(memberOf(predicted, "sideEffects")) == reRender);
    f.undo(memberOf(undo, "undoId").text());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));

    // Two ranges are one undo step with one action per range; given params are used, nothing else.
    const auto two =
        f.regenerate(R"([{"startContentSec":0.2,"endContentSec":1.8},{"startContentSec":4.8,"endContentSec":5.9}])",
                     R"(,"params":{"retuneSpeed":1,"noteSplitCents":40})");
    CONTROL_CHECK(noteIndexes(memberOf(two, "removed")) == (std::vector<int>{0, 3}));
    CONTROL_CHECK(!hasWarning(two, "DROPPED_BOUNDARY_NOTES"));
    CONTROL_CHECK(memberOf(memberOf(two, "undo"), "innerActions").size() == 2);
    CONTROL_CHECK(toJsonString(memberOf(two, "paramsUsed"))
                  == R"({"retuneSpeed":1,"vibratoDepth":0,"vibratoRateHz":7.5,"noteSplitCents":40})");
    checkCreatedNotes(f, two, {{0.2, 1.8}, {4.8, 5.9}});
    f.undo(memberOf(memberOf(two, "undo"), "undoId").text());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));

    // notesOnly replaces every note, without an undo entry or revert recipe. Its dryRun predicts the same
    // side effects as the commit and changes nothing.
    const std::string notesOnlyParams = "{\"contentId\":" + jsonQuoted(f.contentId)
                                        + ",\"mode\":\"notesOnly\",\"expectedRevision\":" + jsonQuoted(f.revision());
    const auto notesOnlyPredicted = f.api.result("content.autoTune", jsonOf(notesOnlyParams + ",\"dryRun\":true}"));
    CONTROL_CHECK(memberOf(notesOnlyPredicted, "dryRun").asBoolean()
                  && !memberOf(notesOnlyPredicted, "applied").asBoolean());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    const auto notesOnly = f.api.result("content.autoTune", jsonOf(notesOnlyParams + "}"));
    CONTROL_CHECK(toJsonString(memberOf(notesOnly, "undo"))
                  == R"({"undoable":false,"reason":"ui_parity","revert":null})");
    CONTROL_CHECK(noteIndexes(memberOf(notesOnly, "removed")) == (std::vector<int>{0, 1, 2, 3}));
    CONTROL_CHECK(memberOf(notesOnly, "keyUsed").isNull() && hasWarning(notesOnly, "IRREVERSIBLE"));
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(notesOnly, f.contentId), freshTokens(f.api, f.contentId)));
    CONTROL_CHECK(toJsonString(memberOf(notesOnly, "sideEffects")) == reRender);
    CONTROL_CHECK(toJsonString(memberOf(notesOnlyPredicted, "sideEffects")) == reRender);
    CONTROL_CHECK(memberOf(notesOnlyPredicted, "created").size() == memberOf(notesOnly, "created").size());

    // The checks before the change: tokens, clipKey, unsupported modes, params.
    CONTROL_CHECK(
        f.api.fails("content.autoTune",
                    jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"mode":"regenerate","expectedRevision":)"
                           + jsonQuoted(revision) + R"(,"key":{"root":0,"scale":"major"}})"),
                    "REVISION_CONFLICT", "content_changed"));
    const auto keyRevision = f.keyRevision();
    f.api.result("content.setKey",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":2,"scale":"major"}})"));
    CONTROL_CHECK(f.api.fails("content.autoTune",
                              jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                     + R"(,"mode":"regenerate","expectedRevision":)" + jsonQuoted(f.revision())
                                     + R"(,"key":"clipKey","expectedKeyRevision":)" + jsonQuoted(keyRevision) + "}"),
                              "REVISION_CONFLICT", "key_changed"));
    const auto withClipKey = f.api.result(
        "content.autoTune", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                   + R"(,"mode":"regenerate","expectedRevision":)" + jsonQuoted(f.revision())
                                   + R"(,"key":"clipKey","expectedKeyRevision":)" + jsonQuoted(f.keyRevision()) + "}"));
    CONTROL_CHECK(toJsonString(memberOf(withClipKey, "keyUsed")) == R"({"root":2,"scale":"major"})");
    // clipKey on a content without a key: there is no key to use, so the call is refused (INVALID_ARGUMENT,
    // without a reason: the protocol has none for it) and changes nothing.
    {
        ClipSpec spec;
        spec.name = "keyless";
        spec.trackId = 1;
        spec.notes = {{0.5, 1.5, 64.0}};
        const auto keyless = fixtureAddClip(*f.processor, spec);
        CONTROL_CHECK(f.processor->getContentSnapshot(keyless.key)->detectedKey.origin == Origin::Unset);
        const auto handles = fixtureHandlesOf(f.api.result("project.get"), spec.trackId, 0.0);
        if (CONTROL_CHECK(handles.has_value())) {
            const auto tokens = freshTokens(f.api, handles->contentId);
            const auto undoCount = memberOf(f.history(), "undoCount").asDouble();
            CONTROL_CHECK(f.api.fails("content.autoTune",
                                      jsonOf("{\"contentId\":" + jsonQuoted(handles->contentId)
                                             + R"(,"mode":"regenerate","expectedRevision":)"
                                             + jsonQuoted(memberOf(tokens, "revision").text())
                                             + R"(,"key":"clipKey","expectedKeyRevision":)"
                                             + jsonQuoted(memberOf(tokens, "keyRevision").text()) + "}"),
                                      "INVALID_ARGUMENT", ""));
            CONTROL_CHECK(VectorMatcher::equal(freshTokens(f.api, handles->contentId), tokens));
            CONTROL_CHECK(memberOf(f.history(), "undoCount").asDouble() == undoCount);
            // An explicit key works on the same content.
            const auto explicitKey =
                f.api.result("content.autoTune", jsonOf("{\"contentId\":" + jsonQuoted(handles->contentId)
                                                        + R"(,"mode":"regenerate","expectedRevision":)"
                                                        + jsonQuoted(memberOf(tokens, "revision").text())
                                                        + R"(,"key":{"root":0,"scale":"major"}})"));
            CONTROL_CHECK(toJsonString(memberOf(explicitKey, "keyUsed")) == R"({"root":0,"scale":"major"})");
        }
    }
    // Mode reference needs reference.v1, which this build does not report.
    CONTROL_CHECK(
        f.api.fails("content.autoTune",
                    jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + ",\"mode\":\"reference\",\"expectedRevision\":"
                           + jsonQuoted(f.revision()) + ",\"placementId\":" + jsonQuoted(f.placementId) + "}"),
                    "UNSUPPORTED", "capability_missing"));
    const std::string base = "{\"contentId\":" + jsonQuoted(f.contentId) + ",\"expectedRevision\":\"r1\",";
    for (const std::string params :
         {base + R"("mode":"regenerate"})", base + R"("mode":"notesOnly","key":{"root":0,"scale":"major"}})",
          base + R"("mode":"regenerate","key":"clipKey"})", base + R"("mode":"other"})",
          base + R"("mode":"regenerate","key":{"root":0,"scale":"major"},"ranges":[]})",
          base + R"("mode":"regenerate","key":{"root":0,"scale":"major"},"params":{"retuneSpeed":2}})",
          base + R"("mode":"reference","placementId":)" + jsonQuoted(f.placementId) + R"(,"dryRun":true})"})
        CONTROL_CHECK(f.api.fails("content.autoTune", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));
}

// ---- Scenario: content.editNotes ----------------------------------------------------------------------

/** The members of a note of content.getNotes that the note edits change. */
const char* const kEditedNoteMembers[] = {"targetMidi",   "offsetCents",   "retuneSpeed",
                                          "vibratoDepth", "vibratoRateHz", "pitchDriftScale"};

JsonValue notesNow(EditFixture& f)
{
    return memberOf(f.api.result("content.getNotes", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + "}")),
                    "notes");
}

/** The reRenderQueued side effect of a write to the fixture's content. */
std::string reRenderOf(const EditFixture& f)
{
    return R"({"reRenderQueued":{"contentIds":[)" + jsonQuoted(f.contentId) + R"(],"revert":null}})";
}

/** The changes of a write result as comparable texts without the revision the notes are referenced at: a
    prediction references them at the current revision, the commit at the revision after it (PROTOCOL.md section
    14.3). */
std::vector<std::string> changesWithoutRevision(const JsonValue& changes)
{
    std::vector<std::string> out;
    for (std::size_t i = 0; i < changes.size(); ++i) {
        const auto& change = changes.at(i);
        const auto& ref = memberOf(change, "ref");
        out.push_back(memberOf(change, "entity").text() + "|" + memberOf(ref, "contentId").text() + "|"
                      + toJsonString(memberOf(memberOf(ref, "note"), "index")) + "|"
                      + toJsonString(memberOf(change, "label")) + "|" + toJsonString(memberOf(change, "fields")));
    }
    return out;
}

bool notesReferencedAt(const JsonValue& changes, const std::string& revision)
{
    for (std::size_t i = 0; i < changes.size(); ++i)
        if (memberOf(memberOf(memberOf(changes.at(i), "ref"), "note"), "atRevision").text() != revision)
            return false;
    return true;
}

/** The notes after an edit: the hand-computed members of the expected notes, and every other member of every
    note as before; start, end and detected pitch never change. */
void checkNotesAfter(const JsonValue& before, const JsonValue& after,
                     const std::map<int, std::map<std::string, double>>& expected)
{
    if (!CONTROL_CHECK(after.size() == before.size()))
        return;
    for (std::size_t i = 0; i < after.size(); ++i) {
        const auto found = expected.find(static_cast<int>(i));
        for (const char* member : kEditedNoteMembers) {
            const double now = memberOf(after.at(i), member).asDouble();
            const bool listed = found != expected.end() && found->second.count(member) != 0;
            const double want = listed ? found->second.at(member) : memberOf(before.at(i), member).asDouble();
            if (!CONTROL_CHECK(std::abs(now - want) < (listed ? 1e-3 : 1e-9)))
                note("note " + std::to_string(i) + " " + member + ": " + std::to_string(now) + ", expected "
                     + std::to_string(want));
        }
        for (const char* member : {"startContentSec", "endContentSec", "detectedMidi"})
            CONTROL_CHECK(VectorMatcher::equal(memberOf(after.at(i), member), memberOf(before.at(i), member)));
    }
}

/** G3: the undo restores exactly the state before, the redo the state after, through the API and through
    OpenTune's own UndoManager (the UI's Ctrl+Z and Ctrl+Y); the content ends in the state before. */
void checkUndoSymmetry(EditFixture& f, const std::string& undoId, const ContentState& before, const ContentState& after)
{
    auto& manager = f.processor->getUndoManager();
    CONTROL_CHECK(memberOf(f.undo(undoId), "applied").asBoolean());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(memberOf(f.undo(undoId, "edit.redo"), "applied").asBoolean());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
    CONTROL_CHECK(manager.undo() != nullptr);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(manager.redo() != nullptr);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
    const auto undone = f.undo(undoId);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(undone, f.contentId), freshTokens(f.api, f.contentId)));
}

/** One row of the table: the ops, the hand-computed values of the notes that change (index, then member and
    value; every other member stays), the undo description and the number of commits (one per op that changes
    something). */
struct NoteEditCase
{
    const char* name;
    std::string ops;
    std::map<int, std::map<std::string, double>> expected;
    std::string description;
    std::size_t commits = 1;
    bool clipKey = false;
};

std::vector<NoteEditCase> noteEditCases()
{
    const std::string move = juce::String::fromUTF8(u8"移动音符").toStdString();
    const std::string snap = juce::String::fromUTF8(u8"音高吸附").toStdString();
    const std::string knob = TRANS("Edit note parameter").toStdString();
    const std::string drift = juce::String::fromUTF8(u8"漂移修正").toStdString();
    // The four notes target 64, 69, 69.3 and 66.2 with no cent offset; the key is A minor.
    return {
        {"setTargetPitch",
         R"([{"op":"setTargetPitch","select":{"indices":[1]},"targetMidi":70.5}])",
         {{1, {{"targetMidi", 70.5}}}},
         move},
        {"setTargetPitch clears the cent offset",
         R"([{"op":"shiftCents","select":{"indices":[2]},"deltaCents":40},)"
         R"({"op":"setTargetPitch","select":{"indices":[2]},"targetMidi":69.3}])",
         {},
         move,
         2},
        {"shiftCents by range",
         R"([{"op":"shiftCents","select":{"range":{"startContentSec":0,"endContentSec":1}},)"
         R"("deltaCents":30}])",
         {{0, {{"targetMidi", 64.3}, {"offsetCents", 30}}}},
         move},
        {"shiftCents on all",
         R"([{"op":"shiftCents","select":{"all":true},"deltaCents":-25}])",
         {{0, {{"targetMidi", 63.75}, {"offsetCents", -25}}},
          {1, {{"targetMidi", 68.75}, {"offsetCents", -25}}},
          {2, {{"targetMidi", 69.05}, {"offsetCents", -25}}},
          {3, {{"targetMidi", 65.95}, {"offsetCents", -25}}}},
         move},
        {"snapToScale C major",
         R"([{"op":"snapToScale","select":{"all":true},"key":{"root":0,"scale":"major"}}])",
         {{2, {{"targetMidi", 69}}}, {3, {{"targetMidi", 67}}}},
         snap},
        {"snapToScale clipKey (A minor)",
         R"([{"op":"snapToScale","select":{"all":true},"key":"clipKey"}])",
         {{2, {{"targetMidi", 69}}}, {3, {{"targetMidi", 67}}}},
         snap,
         1,
         true},
        {"snapToScale: an exact tie goes up",
         R"([{"op":"shiftCents","select":{"indices":[1]},"deltaCents":50},)"
         R"({"op":"snapToScale","select":{"indices":[1]},"key":{"root":0,"scale":"chromatic"}}])",
         {{1, {{"targetMidi", 70}}}},
         move,
         2},
        {"ops apply in order",
         R"([{"op":"setTargetPitch","select":{"indices":[0]},"targetMidi":60},)"
         R"({"op":"shiftCents","select":{"indices":[0,2]},"deltaCents":10}])",
         {{0, {{"targetMidi", 60.1}, {"offsetCents", 10}}}, {2, {{"targetMidi", 69.4}, {"offsetCents", 10}}}},
         move,
         2},
        {"setParams of the knobs",
         R"([{"op":"setParams","select":{"indices":[0,1]},"retuneSpeed":0.8,"vibratoDepth":20}])",
         {{0, {{"retuneSpeed", 0.8}, {"vibratoDepth", 20}}}, {1, {{"retuneSpeed", 0.8}, {"vibratoDepth", 20}}}},
         knob},
        {"setParams vibrato rate",
         R"([{"op":"setParams","select":{"indices":[3]},"vibratoRateHz":9}])",
         {{3, {{"vibratoRateHz", 9}}}},
         knob},
        {"setParams drift",
         R"([{"op":"setParams","select":{"all":true},"pitchDriftScale":0.5}])",
         {{0, {{"pitchDriftScale", 0.5}}},
          {1, {{"pitchDriftScale", 0.5}}},
          {2, {{"pitchDriftScale", 0.5}}},
          {3, {{"pitchDriftScale", 0.5}}}},
         drift},
    };
}

void checkNoteEditCase(EditFixture& f, const NoteEditCase& c)
{
    note(std::string("case: ") + c.name);
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto notesBefore = notesNow(f);
    const auto tokensBefore = freshTokens(f.api, f.contentId);
    const auto revisionBefore = memberOf(tokensBefore, "revision").text();
    const std::string extra = c.clipKey ? ",\"expectedKeyRevision\":" + jsonQuoted(f.keyRevision()) : std::string();

    // dryRun predicts and changes nothing.
    const auto predicted = f.editNotes(c.ops, extra + ",\"dryRun\":true");
    CONTROL_CHECK(memberOf(predicted, "dryRun").asBoolean() && !memberOf(predicted, "applied").asBoolean()
                  && memberOf(predicted, "undo").isNull());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(VectorMatcher::equal(freshTokens(f.api, f.contentId), tokensBefore));
    CONTROL_CHECK(notesReferencedAt(memberOf(predicted, "changes"), revisionBefore));

    const int marks = f.bridge.dirtyMarks;
    const auto applied = f.editNotes(c.ops, extra);
    CONTROL_CHECK(memberOf(applied, "applied").asBoolean() && !memberOf(applied, "noOp").asBoolean());
    // The changed notes are the hand-computed ones, and the prediction lists the same changes and side
    // effects, member for member (PROTOCOL.md section 14.2 rule 2).
    std::vector<int> expectedIndexes;
    for (const auto& entry : c.expected)
        expectedIndexes.push_back(entry.first);
    if (!CONTROL_CHECK(noteIndexes(memberOf(applied, "changes")) == expectedIndexes))
        note("changes " + toJsonString(memberOf(applied, "changes")));
    CONTROL_CHECK(changesWithoutRevision(memberOf(predicted, "changes"))
                  == changesWithoutRevision(memberOf(applied, "changes")));
    CONTROL_CHECK(toJsonString(memberOf(applied, "sideEffects")) == reRenderOf(f));
    CONTROL_CHECK(toJsonString(memberOf(predicted, "sideEffects")) == reRenderOf(f));
    CONTROL_CHECK(memberOf(applied, "created").size() == 0 && memberOf(applied, "removed").size() == 0
                  && memberOf(applied, "warnings").size() == 0);
    CONTROL_CHECK(memberOf(applied, "omittedChangeCount").asDouble() == 0
                  && memberOf(predicted, "omittedChangeCount").asDouble() == 0);
    // The tokens are read back and equal a fresh read: revision changed, the grid and the key did not; the
    // notes are referenced at the new revision.
    const auto tokens = resultTokens(applied, f.contentId);
    CONTROL_CHECK(VectorMatcher::equal(tokens, freshTokens(f.api, f.contentId)));
    CONTROL_CHECK(memberOf(tokens, "revision").text() != revisionBefore);
    CONTROL_CHECK(memberOf(tokens, "gridRevision").text() == memberOf(tokensBefore, "gridRevision").text()
                  && memberOf(tokens, "keyRevision").text() == memberOf(tokensBefore, "keyRevision").text());
    CONTROL_CHECK(notesReferencedAt(memberOf(applied, "changes"), memberOf(tokens, "revision").text()));
    // One undo step with the UI's description, one PianoRollEditAction per op that changed notes.
    const auto& undo = memberOf(applied, "undo");
    CONTROL_CHECK(memberOf(undo, "undoable").asBoolean() && memberOf(undo, "description").text() == c.description);
    const auto& inner = memberOf(undo, "innerActions");
    CONTROL_CHECK(inner.size() == c.commits);
    for (std::size_t i = 0; i < inner.size(); ++i)
        CONTROL_CHECK(inner.at(i).text() == "PianoRollEditAction");
    CONTROL_CHECK(f.bridge.dirtyMarks > marks && memberOf(memberOf(applied, "dirty"), "after").asBoolean());
    checkNotesAfter(notesBefore, notesNow(f), c.expected);
    checkUndoSymmetry(f, memberOf(undo, "undoId").text(), before, stateOf(*f.processor, f.clip.key));
}

/** The checks before the change and the calls that change nothing. */
void checkNoteEditErrors(EditFixture& f)
{
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto undoCount = memberOf(f.history(), "undoCount").asDouble();
    const std::string shiftAll = R"([{"op":"shiftCents","select":{"all":true},"deltaCents":10}])";
    // An index beyond the notes at expectedRevision.
    CONTROL_CHECK(isErrorOf(
        f.api.request("content.editNotes", f.editNotesParams(R"([{"op":"shiftCents","select":{"indices":[0,4]},)"
                                                             R"("deltaCents":10}])")),
        "NOT_FOUND", "unknown_handle", false));
    // An old revision, an old key revision with clipKey.
    const auto oldRevision = f.revision();
    const auto oldKeyRevision = f.keyRevision();
    const auto first = f.editNotes(shiftAll);
    CONTROL_CHECK(isErrorOf(
        f.api.request("content.editNotes", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + ",\"expectedRevision\":"
                                                  + jsonQuoted(oldRevision) + ",\"ops\":" + shiftAll + "}")),
        "REVISION_CONFLICT", "content_changed", false));
    f.undo(memberOf(memberOf(first, "undo"), "undoId").text());
    f.api.result("content.setKey",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + R"(,"key":{"root":9,"scale":"dorian"}})"));
    CONTROL_CHECK(
        isErrorOf(f.api.request("content.editNotes",
                                f.editNotesParams(R"([{"op":"snapToScale","select":{"all":true},"key":"clipKey"}])",
                                                  ",\"expectedKeyRevision\":" + jsonQuoted(oldKeyRevision))),
                  "REVISION_CONFLICT", "key_changed", false));
    // The UI is in the middle of a gesture.
    f.bridge.busy.pointerDown = true;
    CONTROL_CHECK(
        isErrorOf(f.api.request("content.editNotes", f.editNotesParams(shiftAll)), "BUSY", "pointer_down", true));
    f.bridge.busy.pointerDown = false;
    // Edits that change nothing: the target where it is, a range without notes, a parameter as it is.
    for (const char* ops :
         {R"([{"op":"setTargetPitch","select":{"indices":[1]},"targetMidi":69}])",
          R"([{"op":"shiftCents","select":{"range":{"startContentSec":1.6,"endContentSec":1.9}},"deltaCents":10}])",
          R"([{"op":"shiftCents","select":{"all":true},"deltaCents":0}])"}) {
        const auto same = f.editNotes(ops);
        CONTROL_CHECK(memberOf(same, "applied").asBoolean() && memberOf(same, "noOp").asBoolean());
        CONTROL_CHECK(toJsonString(memberOf(same, "undo")) == R"({"undoable":false,"reason":"no_op","revert":null})");
    }
    CONTROL_CHECK(sameNotes(stateOf(*f.processor, f.clip.key).notes, before.notes));
    // No entry is left: the key change (which has none) cleared the undone shift from the redo history, and the
    // no-ops add none.
    CONTROL_CHECK(memberOf(f.history(), "undoCount").asDouble() == undoCount);
    CONTROL_CHECK(!memberOf(f.history(), "canRedo").asBoolean());

    // The readiness gate, and clipKey on a content without a key.
    {
        ClipSpec spec;
        spec.name = "running";
        spec.trackId = 1;
        spec.durationSec = 2.0;
        spec.analysis = Analysis::Running;
        fixtureAddClip(*f.processor, spec);
        ClipSpec keyless;
        keyless.name = "keyless";
        keyless.trackId = 2;
        keyless.notes = {{0.5, 1.5, 64.0}};
        fixtureAddClip(*f.processor, keyless);
        const auto project = f.api.result("project.get");
        const auto running = fixtureHandlesOf(project, 1, 0.0);
        const auto noKey = fixtureHandlesOf(project, 2, 0.0);
        if (CONTROL_CHECK(running.has_value() && noKey.has_value())) {
            CONTROL_CHECK(isErrorOf(
                f.api.request("content.editNotes", jsonOf("{\"contentId\":" + jsonQuoted(running->contentId)
                                                          + R"(,"expectedRevision":"r1","ops":)" + shiftAll + "}")),
                "NOT_READY", "f0_not_ready", true));
            const auto tokens = freshTokens(f.api, noKey->contentId);
            CONTROL_CHECK(
                f.api.fails("content.editNotes",
                            jsonOf("{\"contentId\":" + jsonQuoted(noKey->contentId)
                                   + ",\"expectedRevision\":" + jsonQuoted(memberOf(tokens, "revision").text())
                                   + ",\"expectedKeyRevision\":" + jsonQuoted(memberOf(tokens, "keyRevision").text())
                                   + R"(,"ops":[{"op":"snapToScale","select":{"all":true},"key":"clipKey"}]})"),
                            "INVALID_ARGUMENT", ""));
            CONTROL_CHECK(VectorMatcher::equal(freshTokens(f.api, noKey->contentId), tokens));
        }
    }

    // Params: closed objects, the forms of select and of every op, the ranges, clipKey with its key revision.
    const std::string head = "{\"contentId\":" + jsonQuoted(f.contentId) + ",\"expectedRevision\":\"r1\"";
    const std::string select = R"("select":{"all":true})";
    for (const std::string& params : {
             head + "}",
             head + R"(,"ops":[]})",
             head + R"(,"ops":[{"op":"other",)" + select + "}]}",
             head + R"(,"ops":[{"op":"shiftCents",)" + select + "}]}",
             head + R"(,"ops":[{"op":"shiftCents",)" + select + R"(,"deltaCents":1201}]})",
             head + R"(,"ops":[{"op":"shiftCents",)" + select + R"(,"deltaCents":10,"x":1}]})",
             head + R"(,"ops":[{"op":"setTargetPitch",)" + select + R"(,"targetMidi":128}]})",
             head + R"(,"ops":[{"op":"setTargetPitch","targetMidi":60}]})",
             head + R"(,"ops":[{"op":"setParams",)" + select + "}]}",
             head + R"(,"ops":[{"op":"setParams",)" + select + R"(,"vibratoRateHz":2}]})",
             head + R"(,"ops":[{"op":"setParams",)" + select + R"(,"pitchDriftScale":4}]})",
             head + R"(,"ops":[{"op":"snapToScale",)" + select + R"(,"key":{"root":0,"scale":"lydian"}}]})",
             head + R"(,"ops":[{"op":"snapToScale",)" + select + R"(,"key":"clipKey"}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"indices":[0,0]},"deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"indices":[-1]},"deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"indices":[1.5]},"deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"indices":[]},"deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"all":false},"deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents","select":{"all":true,"indices":[0]},"deltaCents":10}]})",
             head
                 + R"(,"ops":[{"op":"shiftCents","select":{"range":{"startTimelineSec":0,"endTimelineSec":1}},)"
                   R"("deltaCents":10}]})",
             head + R"(,"ops":[{"op":"shiftCents",)" + select + R"(,"deltaCents":10}],"dryRun":"yes"})",
             head + R"(,"ops":[{"op":"shiftCents",)" + select + R"(,"deltaCents":10}],"extra":1})",
         })
        CONTROL_CHECK(f.api.fails("content.editNotes", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(sameNotes(stateOf(*f.processor, f.clip.key).notes, before.notes));
}

void scenarioEditNotesImpl()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    const auto initial = stateOf(*f.processor, f.clip.key);
    for (const auto& c : noteEditCases())
        checkNoteEditCase(f, c);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), initial));
    checkNoteEditErrors(f);
    CONTROL_CHECK(f.service().dispatcher()->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- Scenario: content.setPitchShift -----------------------------------------------------------------

JsonValue pitchShiftNow(EditFixture& f)
{
    return memberOf(f.api.result("content.getDetails", jsonOf("{\"contentId\":" + jsonQuoted(f.contentId) + "}")),
                    "pitchShift");
}

/** The components of the revision vector that a write changed, of the fixture's content. */
std::vector<std::string> changedComponents(const JsonValue& result, const std::string& contentId)
{
    std::vector<std::string> names;
    const auto& contents = memberOf(memberOf(result, "revisionDiff"), "contents");
    for (std::size_t i = 0; i < contents.size(); ++i) {
        if (memberOf(contents.at(i), "contentId").text() != contentId)
            continue;
        const auto& changed = memberOf(contents.at(i), "changed");
        for (std::size_t c = 0; c < changed.size(); ++c)
            names.push_back(changed.keyAt(c));
    }
    return names;
}

/** Rule 9 with a pitch shift: notesOnly after the API's pitch shift replaced the notes, so undoing the shift puts
    back the settings only and keeps the generated notes, scaled back by the shift as the dialog scales notes. */
void checkPitchShiftAfterNotesOnly()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    const auto shift = f.setPitchShift(2, 0);
    const auto shiftId = memberOf(memberOf(shift, "undo"), "undoId").text();
    f.api.result("content.autoTune",
                 jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                        + ",\"mode\":\"notesOnly\",\"expectedRevision\":" + jsonQuoted(f.revision()) + "}"));
    const auto generated = notesNow(f);
    const auto undone = f.undo(shiftId);
    CONTROL_CHECK(memberOf(undone, "applied").asBoolean() && !memberOf(undone, "noOp").asBoolean());
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":0,"cents":0})");
    const auto restored = notesNow(f);
    if (CONTROL_CHECK(restored.size() == generated.size() && restored.size() > 0))
        for (std::size_t i = 0; i < restored.size(); ++i) {
            CONTROL_CHECK(std::abs(memberOf(restored.at(i), "targetMidi").asDouble()
                                   - (memberOf(generated.at(i), "targetMidi").asDouble() - 2.0))
                          < 1e-3);
            CONTROL_CHECK(memberOf(restored.at(i), "startContentSec").asDouble()
                          == memberOf(generated.at(i), "startContentSec").asDouble());
        }
    // The redo sets the shift again on the same notes.
    f.undo(shiftId, "edit.redo");
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":2,"cents":0})");
    const auto again = notesNow(f);
    if (CONTROL_CHECK(again.size() == generated.size()))
        for (std::size_t i = 0; i < again.size(); ++i)
            CONTROL_CHECK(std::abs(memberOf(again.at(i), "targetMidi").asDouble()
                                   - memberOf(generated.at(i), "targetMidi").asDouble())
                          < 1e-3);
}

void checkPitchShift()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    auto& manager = f.processor->getUndoManager();
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto tokensBefore = freshTokens(f.api, f.contentId);
    const auto revision = memberOf(tokensBefore, "revision").text();
    const auto notesBefore = notesNow(f);

    // +2 semitones: one undo step; only the pitchShift component changes, revision stays (PROTOCOL.md section 10
    // rule 2), the key is not transposed.
    const int marks = f.bridge.dirtyMarks;
    const auto shifted = f.setPitchShift(2, 0);
    CONTROL_CHECK(memberOf(shifted, "applied").asBoolean() && !memberOf(shifted, "noOp").asBoolean());
    CONTROL_CHECK(toJsonString(memberOf(shifted, "changes"))
                  == R"([{"entity":"pitchShift","ref":{"contentId":)" + jsonQuoted(f.contentId)
                         + R"(},"label":null,"fields":{"semitones":{"before":0,"after":2,"unit":"semitones"}}}])");
    CONTROL_CHECK(changedComponents(shifted, f.contentId) == std::vector<std::string>{"pitchShift"});
    CONTROL_CHECK(toJsonString(memberOf(shifted, "warnings"))
                  == R"([{"code":"KEY_NOT_TRANSPOSED","subject":{"contentId":)" + jsonQuoted(f.contentId)
                         + R"(},"data":null}])");
    CONTROL_CHECK(toJsonString(memberOf(shifted, "sideEffects")) == reRenderOf(f));
    const auto tokens = resultTokens(shifted, f.contentId);
    CONTROL_CHECK(VectorMatcher::equal(tokens, freshTokens(f.api, f.contentId)));
    CONTROL_CHECK(VectorMatcher::equal(tokens, tokensBefore));
    const auto& undo = memberOf(shifted, "undo");
    CONTROL_CHECK(memberOf(undo, "undoable").asBoolean()
                  && toJsonString(memberOf(undo, "innerActions")) == R"(["PitchShiftEditAction"])");
    CONTROL_CHECK(memberOf(undo, "description").text() == "Pitch Shift +2st");
    CONTROL_CHECK(f.bridge.dirtyMarks > marks);
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":2,"cents":0})");
    // OpenTune scales the stored notes with the shift (commitPitchShiftEdit()), so the targets read two
    // semitones higher while revision stays.
    const auto notesShifted = notesNow(f);
    if (CONTROL_CHECK(notesShifted.size() == notesBefore.size()))
        for (std::size_t i = 0; i < notesShifted.size(); ++i)
            CONTROL_CHECK(std::abs(memberOf(notesShifted.at(i), "targetMidi").asDouble()
                                   - memberOf(notesBefore.at(i), "targetMidi").asDouble() - 2.0)
                          < 1e-3);
    const auto after = stateOf(*f.processor, f.clip.key);
    const auto undoId = memberOf(undo, "undoId").text();

    // The current shift is a no-op.
    const auto same = f.setPitchShift(2, 0);
    CONTROL_CHECK(memberOf(same, "noOp").asBoolean()
                  && toJsonString(memberOf(same, "undo")) == R"({"undoable":false,"reason":"no_op","revert":null})");
    CONTROL_CHECK(memberOf(memberOf(f.history(), "undoTop"), "undoId").text() == undoId);

    // G3: the undo puts back the exact state, the redo the shifted one; revision never changes.
    const auto undone = f.undo(undoId);
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":0,"cents":0})");
    CONTROL_CHECK(changedComponents(undone, f.contentId) == std::vector<std::string>{"pitchShift"});
    CONTROL_CHECK(memberOf(resultTokens(undone, f.contentId), "revision").text() == revision);
    const auto redone = f.undo(undoId, "edit.redo");
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
    CONTROL_CHECK(memberOf(resultTokens(redone, f.contentId), "revision").text() == revision);
    // The user's Ctrl+Z and Ctrl+Y of the API's entry (OpenTune's UndoManager): the next read sees the step, and
    // revision stays as well.
    CONTROL_CHECK(manager.undo() != nullptr);
    CONTROL_CHECK(memberOf(freshTokens(f.api, f.contentId), "revision").text() == revision);
    CONTROL_CHECK(manager.redo() != nullptr);
    CONTROL_CHECK(memberOf(freshTokens(f.api, f.contentId), "revision").text() == revision);

    // A pitch shift in the UI's dialog (commitPitchShiftEdit(), then the action on the history): revision stays.
    auto dialog = f.processor->getContentCommands()->commitPitchShiftEdit(f.clip.key, PitchShiftSettings{-1, 50});
    if (CONTROL_CHECK(dialog != nullptr))
        manager.addAction(std::move(dialog));
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":-1,"cents":50})");
    CONTROL_CHECK(memberOf(freshTokens(f.api, f.contentId), "revision").text() == revision);
    // A shift of the same total cents is one OpenTune does not apply: a no-op.
    const auto equalTotal = f.setPitchShift(0, -50);
    CONTROL_CHECK(memberOf(equalTotal, "noOp").asBoolean());
    CONTROL_CHECK(toJsonString(pitchShiftNow(f)) == R"({"semitones":-1,"cents":50})");
    // A note edit after the shifts changes revision, as always.
    const auto edited = f.editNotes(R"([{"op":"shiftCents","select":{"all":true},"deltaCents":10}])");
    CONTROL_CHECK(memberOf(resultTokens(edited, f.contentId), "revision").text() != revision);

    // Errors: handles first, then the readiness gate; params.
    CONTROL_CHECK(f.api.fails("content.setPitchShift",
                              jsonOf("{\"contentId\":" + jsonQuoted("c:" + f.instanceShort + ":0:4294967295")
                                     + R"(,"pitchShift":{"semitones":1,"cents":0}})"),
                              "NOT_FOUND", "unknown_handle"));
    for (const char* params : {R"({"contentId":"c:00000000:0:1"})", R"({"pitchShift":{"semitones":1,"cents":0}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":25,"cents":0}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1,"cents":100}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1.5,"cents":0}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1,"cents":0,"x":0}})",
                               R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1,"cents":0},"x":1})"})
        CONTROL_CHECK(f.api.fails("content.setPitchShift", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(f.service().dispatcher()->threadProbe().otherThreadAccesses.load() == 0);
}

void scenarioSetPitchShiftImpl()
{
    // One processor at a time: each fixture's processor is destroyed before the next one starts.
    checkPitchShift();
    checkPitchShiftAfterNotesOnly();
}

// ---- Scenario: content.autoTune mode snapNotes ------------------------------------------------------

void scenarioSnapNotesImpl()
{
    EditFixture f;
    if (!f.open(fourNoteSpec()))
        return;
    const auto before = stateOf(*f.processor, f.clip.key);
    const auto notesBefore = notesNow(f);
    const std::string cMajor = R"({"root":0,"scale":"major"})";
    const std::string snap = TRANS("音高吸附").toStdString();

    // Every note to C major, hand-computed from the base pitches: 64 and 69 are in the scale; 69.3 goes to 69
    // and 66.2 to 67, through the cent offset (SNAP keeps the base pitch).
    const auto predicted = f.snapNotes(cMajor, R"(,"dryRun":true)");
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before) && memberOf(predicted, "undo").isNull());
    const auto applied = f.snapNotes(cMajor);
    CONTROL_CHECK(memberOf(applied, "applied").asBoolean() && !memberOf(applied, "noOp").asBoolean());
    CONTROL_CHECK(noteIndexes(memberOf(applied, "changes")) == (std::vector<int>{2, 3}));
    checkNotesAfter(notesBefore, notesNow(f),
                    {{2, {{"targetMidi", 69}, {"offsetCents", -30}}}, {3, {{"targetMidi", 67}, {"offsetCents", 80}}}});
    CONTROL_CHECK(changesWithoutRevision(memberOf(predicted, "changes"))
                  == changesWithoutRevision(memberOf(applied, "changes")));
    CONTROL_CHECK(toJsonString(memberOf(applied, "sideEffects")) == reRenderOf(f));
    CONTROL_CHECK(toJsonString(memberOf(predicted, "sideEffects")) == reRenderOf(f));
    CONTROL_CHECK(memberOf(applied, "created").size() == 0 && memberOf(applied, "removed").size() == 0);
    CONTROL_CHECK(memberOf(applied, "mode").text() == "snapNotes" && memberOf(applied, "paramsUsed").isNull());
    CONTROL_CHECK(toJsonString(memberOf(applied, "keyUsed")) == cMajor);
    CONTROL_CHECK(toJsonString(memberOf(applied, "noteCount")) == R"({"before":4,"after":4})");
    CONTROL_CHECK(toJsonString(memberOf(applied, "omittedCount")) == R"({"changes":0,"created":0,"removed":0})");
    const auto& undo = memberOf(applied, "undo");
    CONTROL_CHECK(memberOf(undo, "description").text() == snap
                  && toJsonString(memberOf(undo, "innerActions")) == R"(["PianoRollEditAction"])");
    CONTROL_CHECK(VectorMatcher::equal(resultTokens(applied, f.contentId), freshTokens(f.api, f.contentId)));
    const auto after = stateOf(*f.processor, f.clip.key);
    // SNAP again over note 2, whose frames are voiced and now corrected: nothing moves, nothing to do.
    const auto again = f.snapNotes(cMajor, R"(,"ranges":[{"startContentSec":3.4,"endContentSec":4.6}])");
    CONTROL_CHECK(memberOf(again, "noOp").asBoolean());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), after));
    // Over every note OpenTune commits again although no note moves: the unvoiced end of note 3 never gets a
    // correction segment, so SNAP never finds its targets fully corrected (an OpenTune behaviour, reported as
    // it is: a step without changes of notes, with its undo entry).
    const auto whole = f.snapNotes(cMajor);
    CONTROL_CHECK(memberOf(whole, "applied").asBoolean() && !memberOf(whole, "noOp").asBoolean()
                  && memberOf(whole, "changes").size() == 0);
    CONTROL_CHECK(memberOf(memberOf(whole, "undo"), "innerActions").size() == 1);
    f.undo(memberOf(memberOf(whole, "undo"), "undoId").text());
    CONTROL_CHECK(sameNotes(stateOf(*f.processor, f.clip.key).notes, after.notes));
    checkUndoSymmetry(f, memberOf(undo, "undoId").text(), before, after);

    // A range is a selection of the notes that overlap it: only note 2; chromatic rounds to semitones.
    const auto ranged =
        f.snapNotes(R"({"root":0,"scale":"chromatic"})", R"(,"ranges":[{"startContentSec":3.4,"endContentSec":4.6}])");
    CONTROL_CHECK(noteIndexes(memberOf(ranged, "changes")) == (std::vector<int>{2}));
    checkNotesAfter(notesBefore, notesNow(f), {{2, {{"targetMidi", 69}, {"offsetCents", -30}}}});
    checkUndoSymmetry(f, memberOf(memberOf(ranged, "undo"), "undoId").text(), before,
                      stateOf(*f.processor, f.clip.key));
    // Two ranges are one undo step with one commit each: note 0 does not move but its frames get their
    // correction, note 3 goes to 66.
    const auto two = f.snapNotes(
        R"({"root":0,"scale":"chromatic"})",
        R"(,"ranges":[{"startContentSec":0.2,"endContentSec":1.8},{"startContentSec":4.8,"endContentSec":5.9}])");
    CONTROL_CHECK(noteIndexes(memberOf(two, "changes")) == (std::vector<int>{3}));
    CONTROL_CHECK(memberOf(memberOf(two, "undo"), "innerActions").size() == 2);
    checkNotesAfter(notesBefore, notesNow(f), {{3, {{"targetMidi", 66}, {"offsetCents", -20}}}});
    checkUndoSymmetry(f, memberOf(memberOf(two, "undo"), "undoId").text(), before, stateOf(*f.processor, f.clip.key));
    // clipKey: A minor has the pitch classes of C major.
    const auto withClipKey = f.snapNotes("\"clipKey\"", ",\"expectedKeyRevision\":" + jsonQuoted(f.keyRevision()));
    CONTROL_CHECK(toJsonString(memberOf(withClipKey, "keyUsed")) == R"({"root":9,"scale":"minor"})");
    CONTROL_CHECK(noteIndexes(memberOf(withClipKey, "changes")) == (std::vector<int>{2, 3}));
    f.undo(memberOf(memberOf(withClipKey, "undo"), "undoId").text());
    CONTROL_CHECK(sameState(stateOf(*f.processor, f.clip.key), before));
    // snapNotes takes no params.
    CONTROL_CHECK(f.api.fails("content.autoTune",
                              jsonOf("{\"contentId\":" + jsonQuoted(f.contentId)
                                     + R"(,"mode":"snapNotes","expectedRevision":"r1","key":)" + cMajor
                                     + R"(,"params":{"retuneSpeed":1}})"),
                              "INVALID_ARGUMENT", "invalid_params"));
}

// ---- The specification's vectors ----------------------------------------------------------------------

/** The vectors of the specification that run against the processor and must pass, by id. */
const char* const kMustRunEditVectors[] = {
    "content/auto-tune-key-changed",
    "content/auto-tune-not-found",
    "content/auto-tune-not-ready",
    "content/auto-tune-notes-only",
    "content/auto-tune-reference-capability-missing",
    "content/auto-tune-regenerate",
    "content/auto-tune-snap-notes",
    "content/edit-notes-busy-export",
    "content/edit-notes-content-changed",
    "content/edit-notes-dry-run",
    "content/edit-notes-not-ready",
    "content/edit-notes-note-refs",
    "content/edit-notes-set-params",
    "content/edit-notes-set-target-pitch",
    "content/edit-notes-shift-cents",
    "content/edit-notes-snap-to-scale",
    "content/edit-notes-unknown-note",
    "content/set-key-key-changed",
    "content/set-key-no-op",
    "content/set-key-not-found",
    "content/set-key-not-ready",
    "content/set-key-ok",
    "content/set-key-revert",
    "content/set-pitch-shift-not-ready",
    "content/set-pitch-shift-ok",
    "content/set-pitch-shift-stale-handle",
    "edit/get-history-ok",
    "edit/redo-cleared-by-write-without-entry",
    "edit/redo-force-without-id",
    "edit/redo-history-empty",
    "edit/redo-ok",
    "edit/undo-force-ui-entry",
    "edit/undo-force-without-id",
    "edit/undo-history-empty",
    "edit/undo-keeps-later-key",
    "edit/undo-no-effect-after-notes-only",
    "edit/undo-ok",
    "edit/undo-top-mismatch",
    "edit/undo-unsafe-build",
};

const std::set<std::string> kEditVectorMethods = {
    "edit.getHistory",   "edit.undo",          "edit.redo",        "content.setKey",        "content.autoTune",
    "content.editNotes", "content.getDetails", "content.getNotes", "content.setPitchShift", "project.get"};
const std::set<std::string> kEditVectorCapabilities = {"session.v1", "read.v1", "history.v1", "edit.v1"};

std::vector<const JsonValue*> sentRequests(const JsonValue& vector)
{
    std::vector<const JsonValue*> requests;
    if (const JsonValue* request = vector.find("request"))
        requests.push_back(request);
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i)
            if (const JsonValue* send = steps->at(i).find("send"))
                requests.push_back(send);
    return requests;
}

/** Why this runner does not run a vector, or empty when it does. */
std::string editVectorSkipReason(const JsonValue& vector)
{
    if (kEditVectorCapabilities.count(memberOf(vector, "capability").text()) == 0)
        return "needs capability " + memberOf(vector, "capability").text() + ", which another runner or part covers";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (kEditVectorCapabilities.count(extra.at(i).text()) == 0)
            return "needs capability " + extra.at(i).text() + ", which a later part implements";
    if (memberOf(vector, "session").text() != "authenticated")
        return "unauthenticated vectors test the listener (ControlUnitTests)";
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i)
            if ((steps->at(i).find("send") == nullptr && steps->at(i).find("expect") == nullptr)
                || steps->at(i).find("connection") != nullptr)
                return "uses steps other than send and expect on the main connection";
    for (const auto* request : sentRequests(vector)) {
        const auto method = memberOf(*request, "method").text();
        if (kEditVectorMethods.count(method) == 0)
            return "uses " + method + ", which a later part implements";
        // Mode reference runs only where the instance lacks reference.v1 (its refusal).
        const auto mode = memberOf(memberOf(*request, "params"), "mode").text();
        const auto& without = memberOf(memberOf(vector, "given"), "withoutCapabilities");
        const bool withoutReference = without.size() == 1 && without.at(0).text() == "reference.v1";
        if (method == "content.autoTune" && mode == "reference" && !withoutReference)
            return "uses content.autoTune mode reference, which a later part implements";
    }
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name == "dirty" || name == "editingScheme" || name == "clips")
            continue;
        if (name == "jobs") {
            // A running export holds the export lock; that is what the content writes see of it.
            for (std::size_t j = 0; j < given.at(i).size(); ++j)
                if (memberOf(given.at(i).at(j), "kind").text() != "export"
                    || memberOf(given.at(i).at(j), "state").text() != "running")
                    return "a job other than a running export is not established by this runner";
            continue;
        }
        if (name == "withoutCapabilities") {
            for (std::size_t c = 0; c < given.at(i).size(); ++c)
                if (kEditVectorCapabilities.count(given.at(i).at(c).text()) != 0)
                    return "removing the reported capability " + given.at(i).at(c).text() + " is not supported";
            continue;
        }
        if (name != "history")
            return "precondition given." + name + " is not established by this runner";
        for (const char* side : {"undo", "redo"}) {
            const auto& entries = memberOf(given.at(i), side);
            for (std::size_t e = 0; e < entries.size(); ++e) {
                const auto& entry = entries.at(e);
                const auto action = memberOf(entry, "action").text();
                if (memberOf(entry, "trackDeletedAfter").asBoolean()
                    || memberOf(entry, "laterTrackDeletedAfter").asBoolean())
                    return "track deletion barriers arrive with the track methods";
                if (action != "noteEdit" && action != "pitchShift" && action != "clipSplit")
                    return "history action " + action + " is not established by this runner";
                if (action == "clipSplit" && memberOf(entry, "origin").text() != "ui")
                    return "a clip split recorded through the API arrives with the arrangement methods";
            }
        }
    }
    return {};
}

/** Pushes one entry of given.history; binds a control entry's undoId to its name. */
bool pushHistoryEntry(EditFixture& f, const JsonValue& entry, const std::map<std::string, Clip>& clips,
                      VectorMatcher& matcher)
{
    const auto clip = clips.find(memberOf(entry, "clip").text());
    if (clip == clips.end())
        return false;
    const auto action = memberOf(entry, "action").text();
    const bool control = memberOf(entry, "origin").text() == "control";
    std::string undoId;
    if (action == "clipSplit")
        return pushUiSplit(*f.processor, 0);
    if (action == "pitchShift") {
        if (control) {
            undoId = pushControlPitchShift(f.service(), *f.processor, clip->second.key, f.instanceShort);
        } else {
            PitchShiftSettings settings;
            settings.semitone = 2;
            auto shift = f.processor->commitPitchShiftEdit(clip->second.key, settings);
            if (shift == nullptr)
                return false;
            f.processor->getUndoManager().addAction(std::move(shift));
            return true;
        }
    } else if (control) {
        undoId = pushControlNoteEdit(f.service(), *f.processor, clip->second.key, f.instanceShort);
    } else {
        return pushUiNoteEdit(*f.processor, clip->second.key);
    }
    if (undoId.empty())
        return false;
    if (const JsonValue* bind = entry.find("bind"))
        matcher.bindings[bind->text()] = JsonValue::string(undoId);
    return true;
}

/** Establishes given.jobs, running exports only (editVectorSkipReason): a job of kind export that runs until it
    is cancelled, its id bound to its name, and the export lock it holds, as the vectors' README requires. */
bool establishRunningExports(EditFixture& f, const JsonValue& jobs, VectorMatcher& matcher, bool& lockHeld)
{
    const auto registry = f.service().jobs();
    if (registry == nullptr)
        return jobs.size() == 0;
    for (std::size_t i = 0; i < jobs.size(); ++i) {
        const auto started =
            registry->start("export", memberOf(jobs.at(i), "cancellable").asBoolean(), [](ControlJobStep& step) {
                if (step.cancelRequested())
                    step.cancel();
            });
        if (started.jobId.empty())
            return false;
        matcher.bindings[memberOf(jobs.at(i), "bind").text()] = JsonValue::string(started.jobId);
        const std::string jobId = started.jobId;
        if (!pumpMessagesUntil(
                [&registry, &jobId] {
                    JsonValue job;
                    return registry->get(jobId, job) == ControlJobs::Lookup::Found
                           && memberOf(job, "state").text() == "running";
                },
                kReadTimeoutMs))
            return false;
        if (!lockHeld)
            lockHeld = f.processor->tryAcquireExportLock();
    }
    return jobs.size() == 0 || lockHeld;
}

std::string runEditVector(const JsonValue& vector)
{
    EditFixture f;
    f.processor = startedProcessor();
    auto& service = f.processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    f.registered = std::make_unique<ScopedTestBridge>(service, f.bridge);
    if (!f.api.open(service))
        return "session.hello failed";
    f.instanceShort = memberOf(f.api.discovery(), "instanceId").text().substr(0, 8);
    const auto& given = memberOf(vector, "given");
    f.processor->getAppPreferences().setAudioEditingScheme(memberOf(given, "editingScheme").text() == "openDyne"
                                                               ? AudioEditingScheme::Scheme::NotesPrimary
                                                               : AudioEditingScheme::Scheme::CorrectedF0Primary);
    VectorMatcher matcher;
    std::map<std::string, Clip> clips;
    std::vector<std::pair<std::string, ClipSpec>> specs;
    const auto& givenClips = memberOf(given, "clips");
    for (std::size_t i = 0; i < givenClips.size(); ++i) {
        const auto& item = givenClips.at(i);
        ClipSpec spec;
        spec.name = memberOf(item, "bind").text();
        spec.trackId = static_cast<int>(memberOf(item, "trackId").asDouble());
        spec.startTimelineSec = memberOf(item, "startTimelineSec").asDouble();
        spec.durationSec = memberOf(item, "durationSec").asDouble();
        const auto analysis = memberOf(item, "analysis").text();
        spec.analysis = analysis == "ready"     ? Analysis::Ready
                        : analysis == "running" ? Analysis::Running
                                                : Analysis::Failed;
        const auto& notes = memberOf(item, "notes");
        for (std::size_t n = 0; n < notes.size(); ++n)
            spec.notes.push_back({memberOf(notes.at(n), "startContentSec").asDouble(),
                                  memberOf(notes.at(n), "endContentSec").asDouble(),
                                  memberOf(notes.at(n), "targetMidi").asDouble()});
        if (const JsonValue* key = item.find("key")) {
            DetectedKey detected;
            detected.root = static_cast<Key>(static_cast<int>(memberOf(*key, "root").asDouble()));
            detected.scale = fixtureScaleOf(memberOf(*key, "scale").text()).value_or(Scale::Major);
            detected.origin = Origin::Manual;
            detected.confidence = 1.0f;
            spec.key = detected;
        }
        const auto clip = fixtureAddClip(*f.processor, spec);
        // An unvoiced analysis is a failed one with the reason OpenTune records for it (its F0 hook).
        if (analysis == "unvoiced")
            f.processor->recordF0FailureReason(clip.key, "f0_empty");
        clips[spec.name] = clip;
        specs.emplace_back(spec.name, spec);
    }
    // Reference bindings: StandaloneArrangement::setPlacementReferencePlacement(), as the editor's menu sets one.
    for (std::size_t i = 0; i < givenClips.size(); ++i)
        if (const JsonValue* reference = givenClips.at(i).find("referenceClip")) {
            const auto target = clips.find(memberOf(givenClips.at(i), "bind").text());
            const auto source = clips.find(reference->text());
            if (target == clips.end() || source == clips.end()
                || !f.processor->getStandaloneArrangement()->setPlacementReferencePlacement(
                    specs[i].second.trackId, target->second.placementId, source->second.placementId))
                return "the reference binding of " + specs[i].first + " could not be set";
        }
    // given.history: the undo entries oldest first; the redo entries pushed from the top down and undone.
    const auto& history = memberOf(given, "history");
    const auto& undoEntries = memberOf(history, "undo");
    for (std::size_t i = 0; i < undoEntries.size(); ++i)
        if (!pushHistoryEntry(f, undoEntries.at(i), clips, matcher))
            return "given.history.undo could not be established";
    const auto& redoEntries = memberOf(history, "redo");
    for (std::size_t i = redoEntries.size(); i-- > 0;)
        if (!pushHistoryEntry(f, redoEntries.at(i), clips, matcher))
            return "given.history.redo could not be established";
    for (std::size_t i = 0; i < redoEntries.size(); ++i)
        if (f.processor->getUndoManager().undo() == nullptr)
            return "given.history.redo could not be established";
    f.bridge.project.dirty = memberOf(given, "dirty").asBoolean();
    bool exportLockHeld = false;
    if (!establishRunningExports(f, memberOf(given, "jobs"), matcher, exportLockHeld))
        return "given.jobs could not be established";

    const auto& discovery = f.api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);
    const auto epoch = std::to_string(f.processor->getStandaloneContentRepository()->getContentEpoch());
    matcher.bindings["runner.unknownContentId"] =
        JsonValue::string("c:" + f.instanceShort + ":" + epoch + ":4294967295");
    matcher.bindings["runner.unknownPlacementId"] =
        JsonValue::string("p:" + f.instanceShort + ":" + epoch + ":4294967295");
    matcher.bindings["runner.staleContentId"] =
        JsonValue::string("c:" + fixtureOtherInstanceShort(f.instanceShort) + ":" + epoch + ":1");
    if (!specs.empty()) {
        const auto project = f.api.result("project.get");
        for (const auto& [bind, spec] : specs) {
            const auto handles = fixtureHandlesOf(project, spec.trackId, spec.startTimelineSec);
            if (!handles)
                return "the clip " + bind + " is not in project.get";
            matcher.bindings[bind + ".contentId"] = JsonValue::string(handles->contentId);
            matcher.bindings[bind + ".placementId"] = JsonValue::string(handles->placementId);
            matcher.bindings[bind + ".geometryHash"] = JsonValue::string(handles->geometryHash);
            for (const char* token : {"revision", "gridRevision", "keyRevision"})
                matcher.bindings[bind + "." + token] = memberOf(handles->tokens, token);
        }
    }

    std::string failure;
    runWhilePumping(
        [&] {
            auto& connection = f.api.client();
            if (memberOf(vector, "type").text() == "request") {
                const auto request = matcher.substitute(memberOf(vector, "request"), failure);
                if (!failure.empty())
                    return;
                if (!connection.sendLine(toJsonString(request))) {
                    failure = "cannot send the request";
                    return;
                }
                failure = matcher.expectLine(connection, memberOf(vector, "response"));
                return;
            }
            const auto& steps = memberOf(vector, "steps");
            for (std::size_t i = 0; i < steps.size() && failure.empty(); ++i) {
                const auto& step = steps.at(i);
                if (const JsonValue* send = step.find("send")) {
                    const auto value = matcher.substitute(*send, failure);
                    if (failure.empty() && !connection.sendLine(toJsonString(value)))
                        failure = "send failed";
                } else {
                    failure = matcher.expectLine(connection, memberOf(step, "expect"));
                }
                if (!failure.empty())
                    failure = "step " + std::to_string(i + 1) + ": " + failure;
            }
        },
        kVectorExchangeMs);
    if (exportLockHeld)
        f.processor->releaseExportLock();
    return failure;
}

} // namespace

void scenarioUndo()
{
    controlSetReportIncompleteCapabilitiesForTesting(true);
    scenarioUndoImpl();
}

void scenarioSetKey()
{
    controlSetReportIncompleteCapabilitiesForTesting(true);
    scenarioSetKeyImpl();
}

void scenarioAutoTune()
{
    controlSetReportIncompleteCapabilitiesForTesting(true);
    scenarioAutoTuneImpl();
}

void scenarioEditNotes()
{
    scenarioEditNotesImpl();
}

void scenarioSetPitchShift()
{
    scenarioSetPitchShiftImpl();
}

void scenarioSnapNotes()
{
    scenarioSnapNotesImpl();
}

void scenarioEditCapability()
{
    // edit.v1 is complete and reported, without the test seam: every one of its four methods is registered, and
    // the listener passes them to the dispatcher, which resolves the handle (here one of another instance).
    controlSetReportIncompleteCapabilitiesForTesting(false);
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    const auto capabilities = service.dispatcher()->capabilities();
    for (const char* capability : {"edit.v1", "history.v1"})
        CONTROL_CHECK(std::find(capabilities.begin(), capabilities.end(), capability) != capabilities.end());
    for (const char* method : {"content.setKey", "content.autoTune", "content.editNotes", "content.setPitchShift"})
        CONTROL_CHECK(service.dispatcher()->implements(method) && !controlCapabilityIsIncomplete("edit.v1"));
    ApiSession api;
    if (!api.open(service))
        return;
    CONTROL_CHECK(api.fails("content.setKey",
                            jsonOf(R"({"contentId":"c:00000000:0:1","key":{"root":0,"scale":"major"}})"), "NOT_FOUND",
                            "stale_handle"));
    CONTROL_CHECK(api.fails("content.setPitchShift",
                            jsonOf(R"({"contentId":"c:00000000:0:1","pitchShift":{"semitones":1,"cents":0}})"),
                            "NOT_FOUND", "stale_handle"));
    CONTROL_CHECK(memberOf(api.result("edit.getHistory"), "history").isObject());
}

void scenarioEditVectors()
{
    controlSetReportIncompleteCapabilitiesForTesting(true);
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root / "edit"))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    for (const auto& entry : std::filesystem::directory_iterator(root / "content")) {
        const auto name = entry.path().filename().u8string();
        if (entry.path().extension() != ".json")
            continue;
        for (const char* prefix : {"set-key-", "auto-tune-", "edit-notes-", "set-pitch-shift-"})
            if (name.rfind(prefix, 0) == 0)
                files.push_back(entry.path());
    }
    std::sort(files.begin(), files.end());
    std::set<std::string> passedIds;
    int skipped = 0;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto id = memberOf(parsed.value, "id").text();
        if (const auto reason = editVectorSkipReason(parsed.value); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runEditVector(parsed.value);
        if (CONTROL_CHECK(failure.empty()))
            passedIds.insert(id);
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    for (const char* id : kMustRunEditVectors)
        CONTROL_CHECK(passedIds.count(id) == 1);
    note(std::to_string(passedIds.size()) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace ControlTest
} // namespace OpenTune
