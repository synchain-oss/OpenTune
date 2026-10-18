// SPDX-License-Identifier: AGPL-3.0-or-later
#include "PrefsOps.h"

#include "OpsSupport.h"
#include "WriteEnvelope.h"

#include "Control/ControlJobs.h"
#include "Control/ControlUiBridge.h"
#include "PluginProcessor.h"
#include "Utils/AppPreferences.h"
#include "Utils/AudioEditingScheme.h"
#include "Utils/TuningConfig.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace OpenTune {

namespace {

constexpr const char* kJobKindPrefsApply = "prefsApply";
/** How long a prefsApply job waits for the editor to apply the editing scheme. The editor applies the preferences
    synchronously when the bridge hands them over and again on its heartbeat (30 Hz when idle), so the wait only
    matters for an editor that has stopped running its heartbeat. */
constexpr std::uint32_t kDefaultApplyTimeoutMs = 10000;

std::atomic<std::uint32_t>& applyTimeoutOverrideMs()
{
    static std::atomic<std::uint32_t> overrideMs{0};
    return overrideMs;
}

std::uint32_t applyTimeoutMs()
{
    const auto overrideMs = applyTimeoutOverrideMs().load();
    return overrideMs != 0 ? overrideMs : kDefaultApplyTimeoutMs;
}

// ---- Params ---------------------------------------------------------------------------------------

/** methods/prefs.set.schema.json $defs.params: the members that are present. */
struct PrefsRequest
{
    std::optional<float> tuningHz;
    /** editingScheme: true for openDyne (notes primary), false for openTune. */
    std::optional<bool> notesPrimary;
    std::optional<bool> hybridMode;
    std::optional<bool> experimentalFeatures;
};

/** A4 as the wire carries it: three decimals, like controlJsonNumber(tuningHz, 3) in prefs.get and session.info. */
float roundedTuning(double hz)
{
    return static_cast<float>(std::round(hz * 1000.0) / 1000.0);
}

bool readBoolean(ControlParamReader& reader, const char* name, std::optional<bool>& out)
{
    const JsonValue* value = reader.member(name);
    if (value == nullptr)
        return true;
    if (!value->isBoolean())
        return reader.fail(std::string(name) + " must be a boolean");
    out = value->asBoolean();
    return true;
}

/** Checks the params of prefs.set on the connection thread: a closed object with at least one member. */
bool parsePrefsSet(const JsonValue& params, PrefsRequest& out, std::string& why)
{
    ControlParamReader reader(params);
    std::optional<double> tuning;
    if (!reader.onlyMembers({"tuningHz", "editingScheme", "hybridMode", "experimentalFeatures"})
        || !reader.optionalNumber("tuningHz", static_cast<double>(TuningConfig::kMinTuningHz),
                                  static_cast<double>(TuningConfig::kMaxTuningHz), tuning)) {
        why = reader.why();
        return false;
    }
    if (const JsonValue* scheme = reader.member("editingScheme")) {
        if (!scheme->isString() || (scheme->text() != "openTune" && scheme->text() != "openDyne")) {
            why = "editingScheme must be openTune or openDyne";
            return false;
        }
        out.notesPrimary = scheme->text() == "openDyne";
    }
    if (!readBoolean(reader, "hybridMode", out.hybridMode)
        || !readBoolean(reader, "experimentalFeatures", out.experimentalFeatures)) {
        why = reader.why();
        return false;
    }
    if (tuning)
        out.tuningHz = roundedTuning(*tuning);
    if (!out.tuningHz && !out.notesPrimary && !out.hybridMode && !out.experimentalFeatures) {
        why = "params must have at least one member";
        return false;
    }
    return true;
}

// ---- The preferences, and what a request changes -----------------------------------------------------

/** The four preferences prefs.set changes, as prefs.get reports them. */
struct PrefsState
{
    float tuningHz = TuningConfig::kDefaultTuningHz;
    bool notesPrimary = false;
    bool hybridMode = true;
    bool experimentalFeatures = false;
};

PrefsState readState(OpenTuneAudioProcessor& processor)
{
    // AppPreferences::getState(): a copy taken under the preferences' own mutex; TuningConfig::currentTuningHz():
    // the A4 frequency that analysis and rendering use (the same sources as prefs.get).
    const auto shared = processor.getAppPreferences().getState().shared;
    PrefsState state;
    state.tuningHz = roundedTuning(TuningConfig::currentTuningHz());
    state.notesPrimary = AudioEditingScheme::usesNotesPrimaryScheme(shared.audioEditingScheme);
    state.hybridMode = shared.lightPitchCorrectionEnabled;
    state.experimentalFeatures = shared.experimentalFeaturesEnabled;
    return state;
}

/** Which preferences a request changes: the members that differ from the state. */
struct PrefsDelta
{
    bool tuning = false;
    bool scheme = false;
    bool hybrid = false;
    bool experimental = false;

    bool any() const noexcept { return tuning || scheme || hybrid || experimental; }
};

PrefsDelta computeDelta(const PrefsState& state, const PrefsRequest& request)
{
    PrefsDelta delta;
    delta.tuning = request.tuningHz && *request.tuningHz != state.tuningHz;
    delta.scheme = request.notesPrimary && *request.notesPrimary != state.notesPrimary;
    delta.hybrid = request.hybridMode && *request.hybridMode != state.hybridMode;
    delta.experimental = request.experimentalFeatures && *request.experimentalFeatures != state.experimentalFeatures;
    return delta;
}

/** The state that a request makes of the state before it: the preferences of the delta set to the request's values. */
PrefsState stateAfter(const PrefsState& before, const PrefsRequest& request, const PrefsDelta& delta)
{
    auto after = before;
    if (delta.tuning)
        after.tuningHz = *request.tuningHz;
    if (delta.scheme)
        after.notesPrimary = *request.notesPrimary;
    if (delta.hybrid)
        after.hybridMode = *request.hybridMode;
    if (delta.experimental)
        after.experimentalFeatures = *request.experimentalFeatures;
    return after;
}

/**
 * Makes the changes of a request, as OpenTune's preferences window does for each control (SharedEditingPage's tuning
 * slider and scheme selector, SharedAudioPage's experimental toggle and hybrid toggle with its processor callback in
 * showPreferencesDialog), and then lets the editor apply the preferences. Message thread.
 */
void applyDelta(ControlOpContext& context, const PrefsRequest& request, const PrefsDelta& delta)
{
    auto& processor = context.processor();
    // AppPreferences setters: each stores the value, persists the preferences file and, for the tuning, updates the
    // process-wide A4 frequency.
    auto& preferences = processor.getAppPreferences();
    if (delta.tuning) {
        TuningConfig::TuningSettings tuning;
        tuning.tuningHz = *request.tuningHz;
        preferences.setTuning(tuning);
    }
    if (delta.scheme)
        preferences.setAudioEditingScheme(*request.notesPrimary ? AudioEditingScheme::Scheme::NotesPrimary
                                                                : AudioEditingScheme::Scheme::CorrectedF0Primary);
    if (delta.hybrid) {
        preferences.setLightPitchCorrectionEnabled(*request.hybridMode);
        // The window's hybrid toggle calls this next: every content renders again with the new mode.
        processor.invalidateAllContentCaches();
    }
    if (delta.experimental)
        preferences.setExperimentalFeaturesEnabled(*request.experimentalFeatures);
    if (delta.any())
        if (auto* bridge = context.bridge())
            bridge->onPreferencesChanged();
}

/** Puts the preferences a delta changed back to the state before it; the editor is told only when asked to. */
void restoreState(ControlOpContext* context, OpenTuneAudioProcessor& processor, const PrefsState& before,
                  const PrefsDelta& delta)
{
    auto& preferences = processor.getAppPreferences();
    if (delta.tuning) {
        TuningConfig::TuningSettings tuning;
        tuning.tuningHz = before.tuningHz;
        preferences.setTuning(tuning);
    }
    if (delta.scheme)
        preferences.setAudioEditingScheme(before.notesPrimary ? AudioEditingScheme::Scheme::NotesPrimary
                                                              : AudioEditingScheme::Scheme::CorrectedF0Primary);
    if (delta.hybrid) {
        preferences.setLightPitchCorrectionEnabled(before.hybridMode);
        if (context != nullptr)
            processor.invalidateAllContentCaches();
    }
    if (delta.experimental)
        preferences.setExperimentalFeaturesEnabled(before.experimentalFeatures);
    if (context != nullptr && delta.any())
        if (auto* bridge = context->bridge())
            bridge->onPreferencesChanged();
}

// ---- The write envelope of a change -------------------------------------------------------------------

JsonValue preferenceRef(const char* name)
{
    auto ref = JsonValue::object();
    ref.appendMember("preference", JsonValue::string(name));
    return ref;
}

/** One change of entity preference: {entity, ref {preference}, label, fields {name: {before, after, unit}}}. */
void addPreferenceChange(ControlWriteEnvelope& envelope, const char* name, const char* label, JsonValue before,
                         JsonValue after, JsonValue unit)
{
    auto pair = JsonValue::object();
    pair.appendMember("before", std::move(before));
    pair.appendMember("after", std::move(after));
    pair.appendMember("unit", std::move(unit));
    auto fields = JsonValue::object();
    fields.appendMember(name, std::move(pair));
    envelope.addChange("preference", preferenceRef(name), JsonValue::string(label), std::move(fields));
}

/**
 * Records what a delta changed in the envelope: the changes, the warning GLOBAL_PREFERENCE (and NOT_RETROACTIVE for the
 * tuning), reRenderQueued for the hybrid switch, and the undo descriptor (no undo entry, as in OpenTune; the revert
 * recipe is the same call with the previous values). Nothing is recorded for a delta that changes nothing.
 */
void recordDelta(ControlOpContext& context, ControlWriteEnvelope& envelope, const PrefsState& before,
                 const PrefsRequest& request, const PrefsDelta& delta)
{
    if (!delta.any())
        return;
    auto names = JsonValue::array();
    auto revert = JsonValue::object();
    if (delta.tuning) {
        addPreferenceChange(envelope, "tuningHz", "Tuning (A4)", controlJsonNumber(before.tuningHz, 3),
                            controlJsonNumber(*request.tuningHz, 3), JsonValue::string("hz"));
        names.append(JsonValue::string("tuningHz"));
        revert.appendMember("tuningHz", controlJsonNumber(before.tuningHz, 3));
    }
    if (delta.scheme) {
        addPreferenceChange(envelope, "editingScheme", "Editing scheme",
                            JsonValue::string(before.notesPrimary ? "openDyne" : "openTune"),
                            JsonValue::string(*request.notesPrimary ? "openDyne" : "openTune"), JsonValue());
        names.append(JsonValue::string("editingScheme"));
        revert.appendMember("editingScheme", JsonValue::string(before.notesPrimary ? "openDyne" : "openTune"));
    }
    if (delta.hybrid) {
        addPreferenceChange(envelope, "hybridMode", "Hybrid mode", JsonValue::boolean(before.hybridMode),
                            JsonValue::boolean(*request.hybridMode), JsonValue());
        names.append(JsonValue::string("hybridMode"));
        revert.appendMember("hybridMode", JsonValue::boolean(before.hybridMode));
    }
    if (delta.experimental) {
        addPreferenceChange(envelope, "experimentalFeatures", "Experimental features",
                            JsonValue::boolean(before.experimentalFeatures),
                            JsonValue::boolean(*request.experimentalFeatures), JsonValue());
        names.append(JsonValue::string("experimentalFeatures"));
        revert.appendMember("experimentalFeatures", JsonValue::boolean(before.experimentalFeatures));
    }
    auto data = JsonValue::object();
    data.appendMember("preferences", std::move(names));
    envelope.addWarning("GLOBAL_PREFERENCE", JsonValue(), std::move(data));
    if (delta.tuning)
        envelope.addWarning("NOT_RETROACTIVE", preferenceRef("tuningHz"));
    if (delta.hybrid) {
        // The processor queued a new render of every content (invalidateAllContentCaches()).
        auto ids = JsonValue::array();
        for (const auto& key : controlLiveContents(context))
            ids.append(JsonValue::string(controlContentId(context, key)));
        if (ids.size() != 0) {
            auto effect = JsonValue::object();
            effect.appendMember("contentIds", std::move(ids));
            effect.appendMember("revert", JsonValue());
            envelope.addSideEffect("reRenderQueued", std::move(effect));
        }
    }
    envelope.setNotUndoable("ui_parity", controlRevertRecipe("prefs.set", std::move(revert)));
}

// ---- Notes that a change of the editing scheme makes the editor generate --------------------------------

/** The clip open in the piano roll before the scheme changes, with whether its notes were ever generated. */
struct NotesWatch
{
    bool valid = false;
    ContentKey key;
    std::string contentId;
    bool topologyInitialized = false;
};

NotesWatch captureNotesWatch(ControlOpContext& context)
{
    NotesWatch watch;
    auto* bridge = context.bridge();
    if (bridge == nullptr)
        return watch;
    // ControlUiBridge::viewState(): the placement the piano roll shows; the editor generates the notes of the content
    // it edits when the scheme becomes openDyne (PianoRollComponent::ensureOpenDyneNotesIfNeeded).
    const auto view = bridge->viewState();
    if (!view || view->pianoRollPlacementId == 0)
        return watch;
    ControlHandle handle;
    handle.kind = ControlHandleKind::Placement;
    handle.instanceShort = context.instanceShort();
    handle.epoch = controlContentEpoch(context);
    handle.object = view->pianoRollPlacementId;
    const auto placement = controlResolvePlacement(context, handle);
    if (!placement.ok())
        return watch;
    const auto snapshot = controlLiveSnapshot(context, placement.value().placement.contentKey);
    if (snapshot == nullptr)
        return watch;
    watch.valid = true;
    watch.key = placement.value().placement.contentKey;
    watch.contentId = controlContentId(context, watch.key);
    watch.topologyInitialized = snapshot->noteTopologyInitialized;
    return watch;
}

/** Records the notes the editor generated for the watched clip: the side effect, the two warnings, the project marked
    as changed (the scheme change has no undo entry, and nothing but deleting the clip takes the notes away). */
void recordGeneratedNotes(ControlOpContext& context, ControlWriteEnvelope& envelope, const NotesWatch& watch)
{
    if (!watch.valid || watch.topologyInitialized)
        return;
    const auto snapshot = controlLiveSnapshot(context, watch.key);
    if (snapshot == nullptr || !snapshot->noteTopologyInitialized)
        return;
    auto effect = JsonValue::object();
    effect.appendMember("contentId", JsonValue::string(watch.contentId));
    effect.appendMember("noteCount", JsonValue::integer(static_cast<std::int64_t>(snapshot->notes.size())));
    effect.appendMember("revert", JsonValue());
    envelope.addSideEffect("notesGenerated", std::move(effect));
    for (const char* code : {"SCHEME_GENERATED_NOTES", "IRREVERSIBLE"}) {
        auto subject = JsonValue::object();
        subject.appendMember("contentId", JsonValue::string(watch.contentId));
        envelope.addWarning(code, std::move(subject));
    }
    envelope.touchContent(watch.contentId);
    controlMarkDirty(context);
}

// ---- The job of a change of the editing scheme ---------------------------------------------------------

/**
 * The job of a prefs.set that changes the editing scheme. Its first step makes every change of the request (so the
 * call that started it changed nothing), the following steps wait until the editor reports the scheme as applied, and
 * the last step ends the job with the write envelope. If the editor does not apply the scheme in time, the job takes
 * its changes back (withdraw()) and fails. A job that the registry destroys before it ended (the control API is
 * stopping) also takes them back.
 */
class PrefsApplyJob
{
public:
    PrefsApplyJob(ControlOpEnvironment environment, PrefsRequest request)
        : environment_(std::move(environment))
        , request_(std::move(request))
    {}

    ~PrefsApplyJob()
    {
        // Destroyed on the message thread before the processor goes away (ControlJobs::stop()).
        if (started_ && !finished_ && environment_.processor != nullptr)
            withdraw(nullptr, *environment_.processor);
        leavePending();
    }

    void step(ControlJobStep& jobStep)
    {
        ControlOpContext context(environment_);
        if (!started_)
            begin(context);
        auto* bridge = context.bridge();
        bool applied = true;
        if (delta_.scheme && bridge != nullptr)
            if (const auto reported = bridge->editingSchemeApplied(*request_.notesPrimary))
                applied = *reported;
        if (!applied) {
            if (juce::Time::getMillisecondCounter() - startedAtMs_ < applyTimeoutMs())
                return;
            abandon(context, jobStep);
            return;
        }
        finish(context, jobStep);
    }

private:
    /** The jobs that made their changes and have not ended, in the order they made them. Message thread only. A job
        that takes its changes back looks for the later ones among them (settle()). */
    static std::vector<PrefsApplyJob*>& pendingJobs()
    {
        static std::vector<PrefsApplyJob*> jobs;
        return jobs;
    }

    void leavePending()
    {
        auto& jobs = pendingJobs();
        jobs.erase(std::remove(jobs.begin(), jobs.end(), this), jobs.end());
    }

    /** The envelope starts immediately before the change; the change is made and handed to the editor. */
    void begin(ControlOpContext& context)
    {
        before_ = readState(context.processor());
        delta_ = computeDelta(before_, request_);
        written_ = stateAfter(before_, request_, delta_);
        restoreTo_ = before_;
        envelope_.emplace(context);
        watch_ = delta_.scheme && *request_.notesPrimary ? captureNotesWatch(context) : NotesWatch{};
        applyDelta(context, request_, delta_);
        startedAtMs_ = juce::Time::getMillisecondCounter();
        started_ = true;
        pendingJobs().push_back(this);
    }

    void finish(ControlOpContext& context, ControlJobStep& jobStep)
    {
        recordDelta(context, *envelope_, before_, request_, delta_);
        recordGeneratedNotes(context, *envelope_, watch_);
        // The job runs while the user may change other contents.
        envelope_->limitDiffToTouchedContents();
        auto result = envelope_->committed(context);
        finished_ = true;
        leavePending();
        jobStep.succeed(std::move(result));
    }

    /** The editor did not apply the scheme: the job takes its changes back, so that no half-applied set of
        preferences stays. A preference that another write changed meanwhile keeps that write's value; the detail
        names it, and executed is true because the job's change was not rolled back completely (PROTOCOL.md section
        17.4 rule 3). */
    void abandon(ControlOpContext& context, ControlJobStep& jobStep)
    {
        const auto kept = withdraw(&context, context.processor());
        finished_ = true;
        leavePending();
        std::string detail = "the editor did not apply the editing scheme in time; the previous preferences were "
                             "restored";
        if (!kept.empty()) {
            detail += " except those another write changed while the job waited, which keep that write's value:";
            for (const auto& name : kept)
                detail += " " + name;
        }
        jobStep.fail(ControlJobError{"INTERNAL", "", detail, !kept.empty()});
    }

    /**
     * Takes the changes of this job back, preference by preference (settle()), and tells the editor when context is
     * given. Message thread. Returns the names of the preferences that keep the value of another write.
     */
    std::vector<std::string> withdraw(ControlOpContext* context, OpenTuneAudioProcessor& processor)
    {
        const auto current = readState(processor);
        PrefsDelta restore;
        std::vector<std::string> kept;
        settle(&PrefsDelta::tuning, &PrefsState::tuningHz, "tuningHz", current, restore, kept);
        settle(&PrefsDelta::scheme, &PrefsState::notesPrimary, "editingScheme", current, restore, kept);
        settle(&PrefsDelta::hybrid, &PrefsState::hybridMode, "hybridMode", current, restore, kept);
        settle(&PrefsDelta::experimental, &PrefsState::experimentalFeatures, "experimentalFeatures", current, restore,
               kept);
        restoreState(context, processor, restoreTo_, restore);
        return kept;
    }

    /**
     * How one preference this job changed is taken back. A later pending job of the same processor that read the
     * value this job wrote as its previous value gets this job's previous value instead, so that its own restore never
     * writes this job's value back (its success keeps its own value). Then: a preference that holds the previous value
     * already needs nothing; one that still holds the value this job wrote is marked in restore; one that such a later
     * job changed from that value is left to it; any other was changed by another write while the job waited (a
     * prefs.set, the preferences window), keeps that value and is added to kept.
     */
    template <typename T>
    void settle(bool PrefsDelta::*item, T PrefsState::*value, const char* name, const PrefsState& current,
                PrefsDelta& restore, std::vector<std::string>& kept)
    {
        if (!(delta_.*item))
            return;
        bool handedOver = false;
        auto& jobs = pendingJobs();
        const auto self = std::find(jobs.begin(), jobs.end(), this);
        if (self != jobs.end())
            for (auto later = std::next(self); later != jobs.end(); ++later) {
                auto& job = **later;
                if (job.environment_.processor == environment_.processor && job.delta_.*item
                    && job.restoreTo_.*value == written_.*value) {
                    job.restoreTo_.*value = restoreTo_.*value;
                    handedOver = true;
                }
            }
        if (current.*value == restoreTo_.*value)
            return;
        if (current.*value == written_.*value)
            restore.*item = true;
        else if (!handedOver)
            kept.emplace_back(name);
    }

    ControlOpEnvironment environment_;
    PrefsRequest request_;
    PrefsState before_;
    PrefsDelta delta_;
    /** The preferences this job wrote, and what taking them back writes: before_, except where an earlier job handed
        over its previous value (settle()). */
    PrefsState written_;
    PrefsState restoreTo_;
    NotesWatch watch_;
    std::optional<ControlWriteEnvelope> envelope_;
    std::uint32_t startedAtMs_ = 0;
    bool started_ = false;
    bool finished_ = false;
};

// ---- prefs.set -----------------------------------------------------------------------------------------

/** Why a start of a job failed, as the error of the method (PROTOCOL.md section 12). */
Error startRefusal(const std::string& refusal)
{
    return refusal == "job_limit" ? controlOpError("BUSY", "job_limit", "every retained job is still active")
                                  : controlOpError("SHUTTING_DOWN", "", "the control API is stopping");
}

Result<JsonValue> runPrefsSet(ControlOpContext& context, const PrefsRequest& request)
{
    if (auto busy = controlCheckBusy(context))
        return *busy;
    const auto before = readState(context.processor());
    const auto delta = computeDelta(before, request);
    if (delta.scheme) {
        // OpenTune applies a new editing scheme to its editor asynchronously: a job makes all the changes, and the call
        // itself changes nothing (PROTOCOL.md section 14.2 rule 3).
        auto* jobs = context.jobs();
        if (jobs == nullptr)
            return controlOpError("INTERNAL", "", "the jobs registry is not available");
        auto job = std::make_shared<PrefsApplyJob>(context.environment(), request);
        const auto started = jobs->start(kJobKindPrefsApply, false, [job](ControlJobStep& step) { job->step(step); });
        if (started.jobId.empty())
            return startRefusal(started.refusal);
        ControlWriteEnvelope envelope(context);
        return envelope.handedToJob(context, jobs->jobRef(started.jobId));
    }
    ControlWriteEnvelope envelope(context);
    applyDelta(context, request, delta);
    recordDelta(context, envelope, before, request, delta);
    return envelope.committed(context);
}

} // namespace

void registerPrefsOps(ControlMethodTable& table)
{
    table.add(controlWriteMethod<PrefsRequest>("prefs.set", parsePrefsSet, runPrefsSet));
}

void controlSetPrefsApplyTimeoutForTesting(std::uint32_t milliseconds)
{
    applyTimeoutOverrideMs() = milliseconds;
}

} // namespace OpenTune
