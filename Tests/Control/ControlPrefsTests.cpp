// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of prefs.set, audio.get and audio.set against the real processor
// without a window. The preferences are the processor's own (AppPreferences in
// the test's data directory, which the harness redirects with
// OPENTUNE_DATA_DIR); the audio device is a juce::AudioDeviceManager with fake
// device types and devices, so that no scenario opens, lists or changes a real
// audio device. The test bridge stands in for the editor: it applies the
// editing scheme (with an optional delay or never), generates the notes of the
// clip open in the piano roll as the piano roll does, and records what the
// control API asks of the editor. Registered with the other processor scenarios
// in ControlProcessorTests.cpp.

#include "ControlContentFixtures.h"
#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Control/ControlDispatcher.h"
#include "Control/ControlJobs.h"
#include "Control/Ops/PrefsOps.h"
#include "PluginProcessor.h"
#include "Utils/AppPreferences.h"
#include "Utils/AudioEditingScheme.h"
#include "Utils/NoteGeneratorTypes.h"
#include "Utils/TuningConfig.h"

#include <juce_audio_devices/juce_audio_devices.h>

#include <algorithm>
#include <atomic>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace OpenTune {
namespace ControlTest {

namespace {

/** Bound of a client exchange that includes a job. */
constexpr int kJobExchangeMs = 60000;
/** The long poll of job.get, shorter than kJobExchangeMs. */
constexpr int kJobWaitMs = 30000;

JsonValue json(const std::string& text)
{
    auto parsed = parseJson(text);
    CONTROL_CHECK(parsed.ok);
    return parsed.value;
}

// ---- The fake audio device
// -----------------------------------------------------------------------------

/** What the fake devices do when opened; shared by every device and type of one
 * rig. Message thread only. */
struct FakeAudioBehaviour
{
    /** Opening a device with this sample rate fails (0: never). */
    double failRateHz = 0.0;
    /** Every open fails. */
    bool failAllOpens = false;
    /** Opening the device of this name fails. */
    juce::String failDeviceName;
    int opens = 0;
    int scans = 0;
};

class FakeAudioDevice final : public juce::AudioIODevice
{
public:
    FakeAudioDevice(const juce::String& name, const juce::String& typeName, FakeAudioBehaviour& behaviour)
        : juce::AudioIODevice(name, typeName)
        , behaviour_(behaviour)
    {}

    ~FakeAudioDevice() override = default;

    juce::StringArray getOutputChannelNames() override { return {"Left", "Right"}; }
    juce::StringArray getInputChannelNames() override { return {}; }
    juce::Array<double> getAvailableSampleRates() override { return {44100.0, 48000.0}; }
    juce::Array<int> getAvailableBufferSizes() override { return {128, 256, 512}; }
    int getDefaultBufferSize() override { return 512; }

    juce::String open(const juce::BigInteger& /*inputChannels*/, const juce::BigInteger& outputChannels,
                      double sampleRate, int bufferSizeSamples) override
    {
        ++behaviour_.opens;
        opened_ = false;
        playing_ = false;
        if (behaviour_.failAllOpens || (behaviour_.failRateHz != 0.0 && sampleRate == behaviour_.failRateHz)
            || getName() == behaviour_.failDeviceName)
            return "fake device: cannot be opened";
        sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
        bufferSize_ = bufferSizeSamples > 0 ? bufferSizeSamples : getDefaultBufferSize();
        outputChannels_ = outputChannels;
        opened_ = true;
        return {};
    }

    void close() override
    {
        opened_ = false;
        playing_ = false;
    }
    bool isOpen() override { return opened_; }
    void start(juce::AudioIODeviceCallback*) override { playing_ = opened_; }
    void stop() override { playing_ = false; }
    bool isPlaying() override { return playing_; }
    juce::String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { return bufferSize_; }
    double getCurrentSampleRate() override { return sampleRate_; }
    int getCurrentBitDepth() override { return 32; }
    juce::BigInteger getActiveOutputChannels() const override { return outputChannels_; }
    juce::BigInteger getActiveInputChannels() const override { return {}; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }

private:
    FakeAudioBehaviour& behaviour_;
    bool opened_ = false;
    bool playing_ = false;
    double sampleRate_ = 44100.0;
    int bufferSize_ = 512;
    juce::BigInteger outputChannels_;
};

class FakeAudioType final : public juce::AudioIODeviceType
{
public:
    FakeAudioType(const juce::String& typeName, juce::StringArray devices, FakeAudioBehaviour& behaviour)
        : juce::AudioIODeviceType(typeName)
        , devices_(std::move(devices))
        , behaviour_(behaviour)
    {}

    void scanForDevices() override { ++behaviour_.scans; }
    juce::StringArray getDeviceNames(bool /*wantInputNames*/) const override { return devices_; }
    int getDefaultDeviceIndex(bool /*forInput*/) const override { return 0; }
    int getIndexOfDevice(juce::AudioIODevice* device, bool /*asInput*/) const override
    {
        return device == nullptr ? -1 : devices_.indexOf(device->getName());
    }
    bool hasSeparateInputsAndOutputs() const override { return false; }
    juce::AudioIODevice* createDevice(const juce::String& outputDeviceName,
                                      const juce::String& inputDeviceName) override
    {
        const auto name = outputDeviceName.isNotEmpty() ? outputDeviceName : inputDeviceName;
        if (!devices_.contains(name))
            return nullptr;
        return new FakeAudioDevice(name, getTypeName(), behaviour_);
    }

private:
    juce::StringArray devices_;
    FakeAudioBehaviour& behaviour_;
};

/**
 * A device manager that only knows two fake device types: the primary one with
 * the devices "Fake Output A" and "Fake Output B", and "Fake B" with "Fake B
 * Output". With running true it starts with Fake Output A at 44100 Hz and a
 * buffer of 512 frames. It never lists or opens a real device: the types are
 * added before anything could add the system's own.
 */
struct FakeAudioRig
{
    explicit FakeAudioRig(bool running = true, const char* primaryType = "Fake")
    {
        manager.addAudioDeviceType(std::make_unique<FakeAudioType>(
            primaryType, juce::StringArray{"Fake Output A", "Fake Output B"}, behaviour));
        manager.addAudioDeviceType(
            std::make_unique<FakeAudioType>("Fake B", juce::StringArray{"Fake B Output"}, behaviour));
        manager.setCurrentAudioDeviceType(primaryType, true);
        if (running) {
            juce::AudioDeviceManager::AudioDeviceSetup setup;
            setup.outputDeviceName = "Fake Output A";
            setup.inputDeviceName = "Fake Output A";
            setup.sampleRate = 44100.0;
            setup.bufferSize = 512;
            setup.useDefaultOutputChannels = true;
            CONTROL_CHECK(manager.setAudioDeviceSetup(setup, true).isEmpty());
        } else {
            manager.closeAudioDevice();
        }
        behaviour.opens = 0;
        behaviour.scans = 0;
    }
    ~FakeAudioRig() { manager.closeAudioDevice(); }

    FakeAudioBehaviour behaviour;
    juce::AudioDeviceManager manager;
};

// ---- The test bridge
// -----------------------------------------------------------------------------------

/**
 * The editor as far as these methods see it. onPreferencesChanged() hands the
 * preferences to the "views": the editing scheme is applied at once, after a
 * delay or never; with generateNotes, applying the notes-primary scheme
 * generates the notes of the clip open in the piano roll
 * (view.pianoRollPlacementId, pianoRollKey) when none were ever generated, as
 * PianoRollComponent::ensureOpenDyneNotesIfNeeded does.
 */
class PrefsBridge : public TestUiBridge
{
public:
    enum class Apply {
        Immediate,
        AfterDelay,
        Never
    };

    juce::AudioDeviceManager* audioDevice() override { return manager; }

    void onPreferencesChanged() override
    {
        ++preferenceNotifications;
        pendingNotesPrimary =
            AudioEditingScheme::usesNotesPrimaryScheme(preferences->getState().shared.audioEditingScheme);
        pendingSinceMs = juce::Time::getMillisecondCounter();
        hasPending = true;
        if (apply == Apply::Immediate)
            applyPending();
    }

    std::optional<bool> editingSchemeApplied(bool notesPrimary) const override
    {
        ++schemeQueries;
        if (apply == Apply::AfterDelay && hasPending
            && juce::Time::getMillisecondCounter() - pendingSinceMs >= static_cast<std::uint32_t>(applyDelayMs))
            applyPending();
        return appliedNotesPrimary == notesPrimary;
    }

    bool prepareAudioDeviceSwitch(const std::string& reason) override
    {
        switchReasons.push_back(reason);
        return asioRestoreSucceeds;
    }

    juce::AudioDeviceManager* manager = nullptr;
    OpenTuneAudioProcessor* processor = nullptr;
    AppPreferences* preferences = nullptr;
    Apply apply = Apply::Immediate;
    int applyDelayMs = 0;
    bool generateNotes = false;
    ContentKey pianoRollKey;
    bool asioRestoreSucceeds = true;

    int preferenceNotifications = 0;
    std::vector<std::string> switchReasons;
    mutable int schemeQueries = 0;
    mutable bool appliedNotesPrimary = false;

private:
    void applyPending() const
    {
        const bool was = appliedNotesPrimary;
        appliedNotesPrimary = pendingNotesPrimary;
        hasPending = false;
        if (!generateNotes || !appliedNotesPrimary || was || processor == nullptr || !pianoRollKey.isValid())
            return;
        const auto snapshot = processor->getContentSnapshot(pianoRollKey);
        if (snapshot == nullptr || snapshot->noteTopologyInitialized || snapshot->pitchCurve == nullptr
            || snapshot->pitchCurve->getOriginalF0().empty())
            return;
        CONTROL_CHECK(processor->generateNotesOnlyByContentKey(pianoRollKey, NoteGeneratorParams{}));
    }

    mutable bool hasPending = false;
    mutable bool pendingNotesPrimary = false;
    mutable std::uint32_t pendingSinceMs = 0;
};

/** Registers a bridge with the service for the life of this object. */
class ScopedBridge
{
public:
    ScopedBridge(ControlService& service, ControlUiBridge& bridge) : service_(service)
    {
        service_.setUiBridge(&bridge);
    }
    ~ScopedBridge() { service_.setUiBridge(nullptr); }

    ScopedBridge(const ScopedBridge&) = delete;
    ScopedBridge& operator=(const ScopedBridge&) = delete;

private:
    ControlService& service_;
};

/** The preferences these methods change, put back to the defaults of a fresh
   installation: the data directory of a process outlives the processors of its
   vectors. */
void resetPreferences(OpenTuneAudioProcessor& processor, bool notesPrimary = false, bool hybrid = true,
                      bool experimental = false, float tuningHz = TuningConfig::kDefaultTuningHz)
{
    auto& preferences = processor.getAppPreferences();
    TuningConfig::TuningSettings tuning;
    tuning.tuningHz = tuningHz;
    preferences.setTuning(tuning);
    preferences.setAudioEditingScheme(notesPrimary ? AudioEditingScheme::Scheme::NotesPrimary
                                                   : AudioEditingScheme::Scheme::CorrectedF0Primary);
    preferences.setLightPitchCorrectionEnabled(hybrid);
    preferences.setExperimentalFeaturesEnabled(experimental);
}

/** A clip with a ready analysis and no notes, on track 0 from 2 s to 8 s. */
ClipSpec readyClip(const char* name)
{
    ClipSpec spec;
    spec.name = std::string("prefs-") + name;
    spec.trackId = 0;
    spec.startTimelineSec = 2.0;
    spec.durationSec = 6.0;
    return spec;
}

// ---- Requests and results
// -------------------------------------------------------------------------------

JsonValue waitJob(ApiSession& api, const std::string& jobId, int waitMs = kJobWaitMs)
{
    auto params = JsonValue::object();
    params.appendMember("jobId", JsonValue::string(jobId));
    params.appendMember("waitMs", JsonValue::integer(waitMs));
    return memberOf(api.result("job.get", std::move(params)), "job");
}

std::string jobIdOf(const JsonValue& result)
{
    return memberOf(memberOf(result, "job"), "jobId").text();
}

/** Sends a method, waits for its job and returns the job; the method must have
 * handed its work to a job. */
JsonValue runAsJob(ApiSession& api, const std::string& method, JsonValue params, const char* kind,
                   JsonValue* started = nullptr)
{
    const auto response = api.result(method, std::move(params));
    if (started != nullptr)
        *started = response;
    const auto jobId = jobIdOf(response);
    if (!CONTROL_CHECK(!jobId.empty() && memberOf(memberOf(response, "job"), "kind").text() == kind))
        return JsonValue();
    return waitJob(api, jobId);
}

bool hasWarning(const JsonValue& result, const std::string& code)
{
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        if (memberOf(warnings.at(i), "code").text() == code)
            return true;
    return false;
}

std::vector<std::string> warningCodes(const JsonValue& result)
{
    std::vector<std::string> codes;
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        codes.push_back(memberOf(warnings.at(i), "code").text());
    return codes;
}

/** The names that GLOBAL_PREFERENCE lists, in order. */
std::vector<std::string> globalPreferences(const JsonValue& result)
{
    std::vector<std::string> names;
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i) {
        if (memberOf(warnings.at(i), "code").text() != "GLOBAL_PREFERENCE")
            continue;
        const auto& list = memberOf(memberOf(warnings.at(i), "data"), "preferences");
        for (std::size_t n = 0; n < list.size(); ++n)
            names.push_back(list.at(n).text());
    }
    return names;
}

/** The change of the entity at index, and the field of it. */
const JsonValue& changeAt(const JsonValue& result, std::size_t index)
{
    return memberOf(result, "changes").at(index);
}

const JsonValue& fieldOf(const JsonValue& change, const char* name)
{
    return memberOf(memberOf(change, "fields"), name);
}

bool numberIs(const JsonValue& value, double expected)
{
    return value.isNumber() && value.asDouble() == expected;
}

bool undoIsUiParity(const JsonValue& result)
{
    const auto& undo = memberOf(result, "undo");
    return memberOf(undo, "undoable").isBoolean() && !memberOf(undo, "undoable").asBoolean()
           && memberOf(undo, "reason").text() == "ui_parity";
}

/** Sends the revert recipe of a result unchanged and returns the result. */
JsonValue replayRevert(ApiSession& api, const JsonValue& result)
{
    const auto& revert = memberOf(memberOf(result, "undo"), "revert");
    if (!CONTROL_CHECK(revert.isObject()))
        return JsonValue();
    return api.result(memberOf(revert, "method").text(), memberOf(revert, "params"));
}

bool processingEqual(const JsonValue& a, const JsonValue& b)
{
    return VectorMatcher::equal(memberOf(a, "processing"), memberOf(b, "processing"));
}

// ---- prefs.set
// -------------------------------------------------------------------------------------------

/** Every setting on its own: changes, warnings, the revert recipe sent back
   unchanged, the no-op, one call that changes several, the closed params, and
   BUSY. */
void checkSynchronousChanges(ApiSession& api, OpenTuneAudioProcessor& processor, PrefsBridge& bridge,
                             const ClipHandles& clip)
{
    const auto baseline = api.result("prefs.get");
    CONTROL_CHECK(numberIs(memberOf(memberOf(baseline, "processing"), "tuningHz"), 440.0));

    // The tuning: the process-wide A4 frequency changes with the preference;
    // results refer to it from now on.
    {
        const auto result = api.result("prefs.set", json(R"({"tuningHz":432})"));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
        CONTROL_CHECK(memberOf(result, "changes").size() == 1);
        const auto& change = changeAt(result, 0);
        CONTROL_CHECK(memberOf(change, "entity").text() == "preference");
        CONTROL_CHECK(memberOf(memberOf(change, "ref"), "preference").text() == "tuningHz");
        CONTROL_CHECK(numberIs(memberOf(fieldOf(change, "tuningHz"), "before"), 440.0)
                      && numberIs(memberOf(fieldOf(change, "tuningHz"), "after"), 432.0)
                      && memberOf(fieldOf(change, "tuningHz"), "unit").text() == "hz");
        CONTROL_CHECK((warningCodes(result) == std::vector<std::string>{"GLOBAL_PREFERENCE", "NOT_RETROACTIVE"}));
        CONTROL_CHECK((globalPreferences(result) == std::vector<std::string>{"tuningHz"}));
        CONTROL_CHECK(undoIsUiParity(result));
        CONTROL_CHECK(TuningConfig::currentTuningHz() == 432.0f);
        CONTROL_CHECK(numberIs(memberOf(memberOf(api.result("session.info"), "processing"), "tuningHz"), 432.0));
        CONTROL_CHECK(numberIs(memberOf(memberOf(api.result("prefs.get"), "processing"), "tuningHz"), 432.0));
        CONTROL_CHECK(bridge.preferenceNotifications == 1);
        // The revert recipe, sent as it is, takes the tuning back; the same value
        // again is a no-op.
        const auto reverted = replayRevert(api, result);
        CONTROL_CHECK(memberOf(reverted, "applied").asBoolean() && !memberOf(reverted, "noOp").asBoolean());
        CONTROL_CHECK(TuningConfig::currentTuningHz() == 440.0f);
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
        const auto again = api.result("prefs.set", json(R"({"tuningHz":440})"));
        CONTROL_CHECK(memberOf(again, "noOp").asBoolean() && memberOf(again, "changes").size() == 0
                      && memberOf(again, "warnings").size() == 0 && memberOf(again, "sideEffects").size() == 0);
        CONTROL_CHECK(memberOf(memberOf(again, "undo"), "reason").text() == "no_op");
        CONTROL_CHECK(bridge.preferenceNotifications == 2);
    }

    // The hybrid switch: every content renders again; the previous value comes
    // back with the revert recipe.
    {
        const auto result = api.result("prefs.set", json(R"({"hybridMode":false})"));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && memberOf(result, "changes").size() == 1);
        CONTROL_CHECK(memberOf(fieldOf(changeAt(result, 0), "hybridMode"), "before").asBoolean()
                      && !memberOf(fieldOf(changeAt(result, 0), "hybridMode"), "after").asBoolean());
        CONTROL_CHECK((warningCodes(result) == std::vector<std::string>{"GLOBAL_PREFERENCE"}));
        const auto& queued = memberOf(memberOf(memberOf(result, "sideEffects"), "reRenderQueued"), "contentIds");
        CONTROL_CHECK(queued.size() == 1 && queued.at(0).text() == clip.contentId);
        CONTROL_CHECK(!processor.getAppPreferences().getState().shared.lightPitchCorrectionEnabled);
        CONTROL_CHECK(!memberOf(memberOf(api.result("prefs.get"), "processing"), "hybridMode").asBoolean());
        replayRevert(api, result);
        CONTROL_CHECK(processor.getAppPreferences().getState().shared.lightPitchCorrectionEnabled);
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
    }

    // The experimental features.
    {
        const auto result = api.result("prefs.set", json(R"({"experimentalFeatures":true})"));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && memberOf(result, "changes").size() == 1);
        CONTROL_CHECK((globalPreferences(result) == std::vector<std::string>{"experimentalFeatures"}));
        CONTROL_CHECK(processor.getAppPreferences().getState().shared.experimentalFeaturesEnabled);
        CONTROL_CHECK(memberOf(memberOf(api.result("session.info"), "processing"), "experimentalFeatures").asBoolean());
        replayRevert(api, result);
        CONTROL_CHECK(!processor.getAppPreferences().getState().shared.experimentalFeaturesEnabled);
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
    }

    // One call that changes several: the changes and the warning follow the order
    // of the schema, and the one revert recipe takes all of them back.
    {
        const auto result =
            api.result("prefs.set", json(R"({"experimentalFeatures":true,"hybridMode":false,"tuningHz":435.5})"));
        CONTROL_CHECK(memberOf(result, "changes").size() == 3);
        CONTROL_CHECK(
            (globalPreferences(result) == std::vector<std::string>{"tuningHz", "hybridMode", "experimentalFeatures"}));
        CONTROL_CHECK(TuningConfig::currentTuningHz() == 435.5f);
        const auto& params = memberOf(memberOf(memberOf(result, "undo"), "revert"), "params");
        CONTROL_CHECK(params.size() == 3 && numberIs(memberOf(params, "tuningHz"), 440.0)
                      && memberOf(params, "hybridMode").asBoolean()
                      && !memberOf(params, "experimentalFeatures").asBoolean());
        replayRevert(api, result);
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
    }

    // A call with some members equal to the current values changes only the
    // others.
    {
        const auto result = api.result("prefs.set", json(R"({"tuningHz":440,"hybridMode":false})"));
        CONTROL_CHECK(memberOf(result, "changes").size() == 1);
        CONTROL_CHECK((globalPreferences(result) == std::vector<std::string>{"hybridMode"}));
        replayRevert(api, result);
    }

    // The params schema is closed and has bounds; nothing changes.
    {
        const int notifications = bridge.preferenceNotifications;
        for (const char* params :
             {"{}", R"({"tuningHz":380})", R"({"tuningHz":500.5})", R"({"tuningHz":"440"})",
              R"({"editingScheme":"openJazz"})", R"({"hybridMode":"yes"})", R"({"experimentalFeatures":1})",
              R"({"vocoderWeight":"x"})", R"({"renderingPriority":"cpuFirst"})", R"({"referenceAlignMode":"game"})",
              R"({"hybridMode":true,"theme":"dark"})"})
            CONTROL_CHECK(api.fails("prefs.set", json(params), "INVALID_ARGUMENT", "invalid_params"));
        CONTROL_CHECK(bridge.preferenceNotifications == notifications);
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
    }

    // BUSY: a modal dialog is open; nothing changes, also not for a change of the
    // editing scheme (no job starts).
    {
        bridge.busy.modalOpen = true;
        CONTROL_CHECK(api.fails("prefs.set", json(R"({"tuningHz":433})"), "BUSY", "modal_open"));
        CONTROL_CHECK(api.fails("prefs.set", json(R"({"editingScheme":"openDyne"})"), "BUSY", "modal_open"));
        bridge.busy.modalOpen = false;
        CONTROL_CHECK(processingEqual(api.result("prefs.get"), baseline));
    }
}

} // namespace

void scenarioPrefsRoundTrip()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    resetPreferences(*processor);
    PrefsBridge bridge;
    bridge.processor = processor.get();
    bridge.preferences = &processor->getAppPreferences();
    ScopedBridge registered(service, bridge);
    fixtureAddClip(*processor, readyClip("round-trip"));
    ApiSession api;
    if (!api.open(service))
        return;
    const auto handles = fixtureHandlesOf(api.result("project.get"), 0, 2.0);
    if (!CONTROL_CHECK(handles.has_value()))
        return;
    checkSynchronousChanges(api, *processor, bridge, *handles);
    resetPreferences(*processor);
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

namespace {

/** The envelope of a job that has ended succeeded: the job and its result. */
bool jobSucceeded(const JsonValue& job)
{
    const bool ok = memberOf(job, "state").text() == "succeeded" && memberOf(job, "kind").text() == "prefsApply"
                    && memberOf(job, "cancellable").isBoolean() && !memberOf(job, "cancellable").asBoolean();
    if (!ok)
        note("the prefsApply job did not succeed: " + toJsonString(job));
    return ok;
}

/** A change of the editing scheme is a job: the call changes nothing, the job
   applies the scheme, and switching to openDyne generates the notes of the clip
   open in the piano roll. */
void checkSchemeJob(ApiSession& api, OpenTuneAudioProcessor& processor, PrefsBridge& bridge, const Clip& clip,
                    const ClipHandles& handles)
{
    auto& preferences = processor.getAppPreferences();
    bridge.generateNotes = true;
    bridge.pianoRollKey = clip.key;
    bridge.view.pianoRollPlacementId = clip.placementId;
    bridge.view.workspace = "pianoRoll";
    CONTROL_CHECK(!processor.getContentSnapshot(clip.key)->noteTopologyInitialized);

    // The editor takes its time: the call returned a job and no change, the job
    // runs until the editor reports the scheme.
    bridge.apply = PrefsBridge::Apply::AfterDelay;
    bridge.applyDelayMs = 400;
    JsonValue started;
    const auto taken = juce::Time::getMillisecondCounter();
    {
        const auto response =
            api.result("prefs.set", json(R"({"editingScheme":"openDyne","tuningHz":441,"hybridMode":false})"));
        started = response;
        CONTROL_CHECK(!memberOf(response, "applied").asBoolean() && !memberOf(response, "noOp").asBoolean());
        CONTROL_CHECK(memberOf(response, "changes").size() == 0 && memberOf(response, "sideEffects").size() == 0);
        CONTROL_CHECK(memberOf(response, "undo").isNull());
        CONTROL_CHECK(memberOf(memberOf(response, "job"), "kind").text() == "prefsApply");
        const auto jobId = jobIdOf(response);
        // While the editor has not applied the scheme the job is not over, and it
        // cannot be cancelled.
        auto running = JsonValue::object();
        running.appendMember("jobId", JsonValue::string(jobId));
        const auto early = memberOf(api.result("job.get", running), "job");
        const auto state = memberOf(early, "state").text();
        CONTROL_CHECK(state == "queued" || state == "running");
        CONTROL_CHECK(!memberOf(early, "cancellable").asBoolean());
        CONTROL_CHECK(api.fails("job.cancel", running, "UNSUPPORTED", "job_not_cancellable"));
        const auto job = waitJob(api, jobId);
        CONTROL_CHECK(jobSucceeded(job));
        CONTROL_CHECK(juce::Time::getMillisecondCounter() - taken >= 400);
        const auto& result = memberOf(job, "result");
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
        CONTROL_CHECK(memberOf(result, "job").isNull());
        CONTROL_CHECK(memberOf(result, "changes").size() == 3);
        CONTROL_CHECK(
            (globalPreferences(result) == std::vector<std::string>{"tuningHz", "editingScheme", "hybridMode"}));
        CONTROL_CHECK((warningCodes(result)
                       == std::vector<std::string>{"GLOBAL_PREFERENCE", "NOT_RETROACTIVE", "SCHEME_GENERATED_NOTES",
                                                   "IRREVERSIBLE"}));
        const auto& generated = memberOf(memberOf(result, "sideEffects"), "notesGenerated");
        CONTROL_CHECK(memberOf(generated, "contentId").text() == handles.contentId);
        CONTROL_CHECK(memberOf(generated, "noteCount").asDouble() > 0.0 && memberOf(generated, "revert").isNull());
        const auto& rerender = memberOf(memberOf(result, "sideEffects"), "reRenderQueued");
        CONTROL_CHECK(memberOf(rerender, "contentIds").size() == 1);
        CONTROL_CHECK(undoIsUiParity(result));
        const auto& params = memberOf(memberOf(memberOf(result, "undo"), "revert"), "params");
        CONTROL_CHECK(params.size() == 3 && memberOf(params, "editingScheme").text() == "openTune");
        CONTROL_CHECK(!memberOf(memberOf(result, "dirty"), "before").asBoolean()
                      && memberOf(memberOf(result, "dirty"), "after").asBoolean());
        // The notes changed, which the revision diff of the touched content says.
        const auto& diff = memberOf(memberOf(result, "revisionDiff"), "contents");
        CONTROL_CHECK(diff.size() == 1 && memberOf(diff.at(0), "contentId").text() == handles.contentId
                      && memberOf(memberOf(diff.at(0), "changed"), "notes").isObject());
        CONTROL_CHECK(processor.getContentSnapshot(clip.key)->noteTopologyInitialized
                      && !processor.getContentSnapshot(clip.key)->notes.empty());
        CONTROL_CHECK(AudioEditingScheme::usesNotesPrimaryScheme(preferences.getState().shared.audioEditingScheme));
        CONTROL_CHECK(TuningConfig::currentTuningHz() == 441.0f);
        CONTROL_CHECK(bridge.project.dirty);
        // One notification when the preferences were changed, and the job asked
        // while the editor was applying.
        CONTROL_CHECK(bridge.preferenceNotifications == 1 && bridge.schemeQueries >= 2);
        // The revert recipe, sent unchanged, takes all three back; it changes the
        // scheme, so it is a job as well.
        const auto reverted = runAsJob(api, "prefs.set", params, "prefsApply");
        CONTROL_CHECK(jobSucceeded(reverted));
        const auto& revertedResult = memberOf(reverted, "result");
        CONTROL_CHECK(memberOf(revertedResult, "changes").size() == 3);
        // The notes stay (they have no undo), but no new notes were generated.
        CONTROL_CHECK(!hasWarning(revertedResult, "SCHEME_GENERATED_NOTES"));
        CONTROL_CHECK(memberOf(revertedResult, "sideEffects").find("notesGenerated") == nullptr);
        CONTROL_CHECK(!AudioEditingScheme::usesNotesPrimaryScheme(preferences.getState().shared.audioEditingScheme));
        CONTROL_CHECK(TuningConfig::currentTuningHz() == 440.0f
                      && preferences.getState().shared.lightPitchCorrectionEnabled);
    }

    // Back to openDyne: the notes exist already, so none are generated and no
    // warning about it is made.
    bridge.apply = PrefsBridge::Apply::Immediate;
    {
        const auto job = runAsJob(api, "prefs.set", json(R"({"editingScheme":"openDyne"})"), "prefsApply");
        CONTROL_CHECK(jobSucceeded(job));
        const auto& result = memberOf(job, "result");
        CONTROL_CHECK((warningCodes(result) == std::vector<std::string>{"GLOBAL_PREFERENCE"}));
        CONTROL_CHECK(memberOf(result, "sideEffects").size() == 0);
        // The same scheme again: a no-op that is no job.
        const auto again = api.result("prefs.set", json(R"({"editingScheme":"openDyne"})"));
        CONTROL_CHECK(memberOf(again, "noOp").asBoolean() && memberOf(again, "job").isNull());
        CONTROL_CHECK(runAsJob(api, "prefs.set", json(R"({"editingScheme":"openTune"})"), "prefsApply").isObject());
    }
}

/** An editor that never applies the scheme: after the wait the job puts every
   preference of the call back and fails with INTERNAL; the same when the
   control API stops while the job waits. */
void checkSchemeTimeout(ApiSession& api, OpenTuneAudioProcessor& processor, PrefsBridge& bridge)
{
    auto& preferences = processor.getAppPreferences();
    bridge.apply = PrefsBridge::Apply::Never;
    controlSetPrefsApplyTimeoutForTesting(300);
    const auto notifications = bridge.preferenceNotifications;
    const auto job =
        runAsJob(api, "prefs.set",
                 json(R"({"editingScheme":"openDyne","tuningHz":433,"hybridMode":false,"experimentalFeatures":true})"),
                 "prefsApply");
    controlSetPrefsApplyTimeoutForTesting(0);
    const auto& error = memberOf(memberOf(job, "error"), "data");
    CONTROL_CHECK(memberOf(job, "state").text() == "failed" && memberOf(error, "kind").text() == "INTERNAL");
    CONTROL_CHECK(memberOf(error, "executed").isBoolean() && !memberOf(error, "executed").asBoolean());
    // Nothing of the call remains: the preferences are those from before, and the
    // editor was told twice (change, restore).
    const auto state = preferences.getState().shared;
    CONTROL_CHECK(!AudioEditingScheme::usesNotesPrimaryScheme(state.audioEditingScheme)
                  && state.lightPitchCorrectionEnabled && !state.experimentalFeaturesEnabled);
    CONTROL_CHECK(TuningConfig::currentTuningHz() == 440.0f);
    CONTROL_CHECK(bridge.preferenceNotifications == notifications + 2);
    const auto prefs = api.result("prefs.get");
    CONTROL_CHECK(numberIs(memberOf(memberOf(prefs, "processing"), "tuningHz"), 440.0)
                  && memberOf(memberOf(prefs, "processing"), "editingScheme").text() == "openTune");
}

} // namespace

void scenarioPrefsSchemeJob()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    resetPreferences(*processor);
    PrefsBridge bridge;
    bridge.processor = processor.get();
    bridge.preferences = &processor->getAppPreferences();
    auto registered = std::make_unique<ScopedBridge>(service, bridge);
    const auto clip = fixtureAddClip(*processor, readyClip("scheme-job"));
    std::optional<ApiSession> session;
    session.emplace();
    auto& api = *session;
    if (!api.open(service))
        return;
    const auto handles = fixtureHandlesOf(api.result("project.get"), 0, 2.0);
    if (!CONTROL_CHECK(handles.has_value()))
        return;
    checkSchemeJob(api, *processor, bridge, clip, *handles);
    checkSchemeTimeout(api, *processor, bridge);

    // Without an editor there is no one to wait for: the job applies the preference and ends.
    {
        service.setUiBridge(nullptr);
        const auto notifications = bridge.preferenceNotifications;
        const auto job = runAsJob(api, "prefs.set", json(R"({"editingScheme":"openDyne"})"), "prefsApply");
        CONTROL_CHECK(jobSucceeded(job));
        CONTROL_CHECK(memberOf(memberOf(job, "result"), "changes").size() == 1);
        CONTROL_CHECK(memberOf(memberOf(job, "result"), "sideEffects").size() == 0);
        CONTROL_CHECK(AudioEditingScheme::usesNotesPrimaryScheme(
            processor->getAppPreferences().getState().shared.audioEditingScheme));
        CONTROL_CHECK(jobSucceeded(runAsJob(api, "prefs.set", json(R"({"editingScheme":"openTune"})"), "prefsApply")));
        CONTROL_CHECK(bridge.preferenceNotifications == notifications);
        service.setUiBridge(&bridge);
    }

    // The control API stops while a job waits for the editor: the previous
    // preferences are put back as well.
    bridge.apply = PrefsBridge::Apply::Never;
    const auto job = api.result("prefs.set", json(R"({"editingScheme":"openDyne","tuningHz":434})"));
    CONTROL_CHECK(!jobIdOf(job).empty());
    CONTROL_CHECK(pumpMessagesUntil([&] { return TuningConfig::currentTuningHz() == 434.0f; }, 5000));
    CONTROL_CHECK(AudioEditingScheme::usesNotesPrimaryScheme(
        processor->getAppPreferences().getState().shared.audioEditingScheme));
    session.reset();
    registered.reset();
    processor.reset();
    CONTROL_CHECK(TuningConfig::currentTuningHz() == 440.0f);
    AppPreferences stored;
    stored.load();
    CONTROL_CHECK(!AudioEditingScheme::usesNotesPrimaryScheme(stored.getState().shared.audioEditingScheme));
    CONTROL_CHECK(stored.getState().shared.tuning.tuningHz == 440.0f);
}

// ---- audio.get and audio.set
// ----------------------------------------------------------------------------

namespace {

const JsonValue& deviceOf(const JsonValue& result)
{
    return memberOf(result, "device");
}

/** The setup of the fake manager as a short text, to compare before and after a
 * failed call. */
std::string setupText(juce::AudioDeviceManager& manager)
{
    const auto setup = manager.getAudioDeviceSetup();
    auto* device = manager.getCurrentAudioDevice();
    return (manager.getCurrentAudioDeviceType() + "|" + setup.outputDeviceName + "|"
            + juce::String(device != nullptr ? device->getCurrentSampleRate() : 0.0) + "|"
            + juce::String(device != nullptr ? device->getCurrentBufferSizeSamples() : 0))
        .toStdString();
}

bool deviceIs(const JsonValue& device, const std::string& type, const std::string& output, double rate, double buffer)
{
    return memberOf(device, "running").asBoolean() && memberOf(device, "deviceType").text() == type
           && memberOf(device, "outputDevice").text() == output && numberIs(memberOf(device, "sampleRateHz"), rate)
           && numberIs(memberOf(device, "bufferSizeFrame"), buffer);
}

std::vector<std::string> textsOf(const JsonValue& array)
{
    std::vector<std::string> out;
    for (std::size_t i = 0; i < array.size(); ++i)
        out.push_back(array.at(i).text());
    return out;
}

bool failsWith(ApiSession& api, const char* params, const char* kind, const char* reason)
{
    return api.fails("audio.set", json(params), kind, reason);
}

/** A failed call with executed true (the previous setup could not be restored).
 */
bool failsAfterChange(ApiSession& api, const char* params, const char* kind, const char* reason)
{
    const auto response = api.request("audio.set", json(params));
    const JsonValue none;
    const JsonValue* error = response.find("error");
    const auto& data = memberOf(error != nullptr ? *error : none, "data");
    const bool ok = memberOf(data, "kind").text() == kind && memberOf(data, "reason").text() == reason
                    && memberOf(data, "executed").isBoolean() && memberOf(data, "executed").asBoolean();
    if (!ok)
        note(std::string("audio.set: expected ") + kind + "(" + reason + ") with executed true, got "
             + toJsonString(response));
    return ok;
}

/** Without a device manager: audio.get says why, audio.set says UNSUPPORTED. */
void checkWithoutDevice(ApiSession& api, PrefsBridge& bridge, ControlService& service)
{
    const auto readNullReason = [&](const char* expected) {
        const auto result = api.result("audio.get");
        const auto& device = deviceOf(result);
        CONTROL_CHECK(!memberOf(device, "running").asBoolean() && memberOf(device, "deviceType").isNull()
                      && memberOf(device, "sampleRateHz").isNull());
        CONTROL_CHECK(memberOf(memberOf(device, "nullReasons"), "outputDevice").text() == expected);
        CONTROL_CHECK(memberOf(memberOf(result, "available"), "deviceTypes").size() == 0);
        CONTROL_CHECK(numberIs(memberOf(memberOf(result, "available"), "outputChannelPairCount"), 0.0));
    };
    // The editor's bridge has no device manager.
    readNullReason("unavailable");
    CONTROL_CHECK(api.fails("audio.set", json(R"({"bufferSizeFrame":256})"), "UNSUPPORTED", "capability_missing"));
    // No editor at all.
    service.setUiBridge(nullptr);
    readNullReason("no_editor");
    CONTROL_CHECK(api.fails("audio.set", json(R"({"bufferSizeFrame":256})"), "UNSUPPORTED", "capability_missing"));
    service.setUiBridge(&bridge);
}

/** What the page offers, the closed params, the values that are not on offer
 * and the changes of the running device. */
void checkRunningDevice(ApiSession& api, FakeAudioRig& rig, PrefsBridge& bridge)
{
    const auto before = api.result("audio.get");
    CONTROL_CHECK(deviceIs(deviceOf(before), "Fake", "Fake Output A", 44100.0, 512.0));
    CONTROL_CHECK(numberIs(memberOf(deviceOf(before), "outputChannelPair"), 0.0));
    CONTROL_CHECK(memberOf(deviceOf(before), "nullReasons").isNull());
    const auto& available = memberOf(before, "available");
    CONTROL_CHECK((textsOf(memberOf(available, "deviceTypes")) == std::vector<std::string>{"Fake", "Fake B"}));
    CONTROL_CHECK(
        (textsOf(memberOf(available, "outputDevices")) == std::vector<std::string>{"Fake Output A", "Fake Output B"}));
    CONTROL_CHECK(memberOf(available, "sampleRatesHz").size() == 2
                  && memberOf(available, "bufferSizesFrame").size() == 3);
    CONTROL_CHECK(numberIs(memberOf(available, "outputChannelPairCount"), 1.0));
    CONTROL_CHECK(rig.behaviour.scans >= 1);
    const auto setupBefore = setupText(rig.manager);

    // The closed params.
    for (const char* params : {"{}", R"({"sampleRateHz":0})", R"({"bufferSizeFrame":0})", R"({"bufferSizeFrame":2.5})",
                               R"({"outputChannelPair":-1})", R"({"deviceType":""})", R"({"outputDevice":5})",
                               R"({"bufferSizeFrame":256,"latency":3})"})
        CONTROL_CHECK(failsWith(api, params, "INVALID_ARGUMENT", "invalid_params"));

    // Values that are not on offer change nothing and do not even reopen the
    // device.
    for (const char* params : {R"({"sampleRateHz":12345})", R"({"bufferSizeFrame":999})", R"({"outputChannelPair":1})",
                               R"({"outputDevice":"No Such Output"})", R"({"deviceType":"No Such Type"})",
                               R"({"deviceType":"Fake B","outputDevice":"Fake Output A"})",
                               R"({"outputDevice":"Fake Output B","sampleRateHz":12345})"})
        CONTROL_CHECK(failsWith(api, params, "INVALID_ARGUMENT", "audio_setting_unavailable"));
    CONTROL_CHECK(setupText(rig.manager) == setupBefore);

    // A setup equal to the current one is a no-op.
    {
        const auto opens = rig.behaviour.opens;
        const auto result = api.result(
            "audio.set",
            json(
                R"({"bufferSizeFrame":512,"sampleRateHz":44100,"outputChannelPair":0,"deviceType":"Fake","outputDevice":"Fake Output A"})"));
        CONTROL_CHECK(memberOf(result, "noOp").asBoolean() && memberOf(result, "changes").size() == 0
                      && memberOf(result, "warnings").size() == 0);
        CONTROL_CHECK(memberOf(memberOf(result, "undo"), "reason").text() == "no_op");
        CONTROL_CHECK(deviceIs(deviceOf(result), "Fake", "Fake Output A", 44100.0, 512.0));
        CONTROL_CHECK(rig.behaviour.opens == opens);
    }

    // The buffer size: the device opens again with it; the revert recipe takes it
    // back.
    {
        const auto result = api.result("audio.set", json(R"({"bufferSizeFrame":256})"));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
        CONTROL_CHECK(memberOf(result, "changes").size() == 1);
        const auto& change = changeAt(result, 0);
        CONTROL_CHECK(memberOf(change, "entity").text() == "audioDevice"
                      && memberOf(memberOf(change, "ref"), "singleton").text() == "audioDevice");
        CONTROL_CHECK(memberOf(change, "fields").size() == 1);
        CONTROL_CHECK(numberIs(memberOf(fieldOf(change, "bufferSizeFrame"), "before"), 512.0)
                      && numberIs(memberOf(fieldOf(change, "bufferSizeFrame"), "after"), 256.0)
                      && memberOf(fieldOf(change, "bufferSizeFrame"), "unit").text() == "frame");
        CONTROL_CHECK((warningCodes(result) == std::vector<std::string>{"GLOBAL_PREFERENCE"}));
        CONTROL_CHECK((globalPreferences(result) == std::vector<std::string>{"audioDevice"}));
        CONTROL_CHECK(undoIsUiParity(result));
        CONTROL_CHECK(deviceIs(deviceOf(result), "Fake", "Fake Output A", 44100.0, 256.0));
        CONTROL_CHECK(deviceIs(deviceOf(api.result("audio.get")), "Fake", "Fake Output A", 44100.0, 256.0));
        CONTROL_CHECK(rig.manager.getCurrentAudioDevice()->getCurrentBufferSizeSamples() == 256);
        const auto& params = memberOf(memberOf(memberOf(result, "undo"), "revert"), "params");
        CONTROL_CHECK(params.size() == 1 && numberIs(memberOf(params, "bufferSizeFrame"), 512.0));
        const auto reverted = replayRevert(api, result);
        CONTROL_CHECK(deviceIs(deviceOf(reverted), "Fake", "Fake Output A", 44100.0, 512.0));
        CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    }

    // The sample rate and the buffer size together open the device once.
    {
        const auto opensBefore = rig.behaviour.opens;
        const auto result = api.result("audio.set", json(R"({"sampleRateHz":48000,"bufferSizeFrame":128})"));
        CONTROL_CHECK(memberOf(result, "changes").size() == 1 && memberOf(changeAt(result, 0), "fields").size() == 2);
        CONTROL_CHECK(deviceIs(deviceOf(result), "Fake", "Fake Output A", 48000.0, 128.0));
        CONTROL_CHECK(rig.behaviour.opens == opensBefore + 1);
        replayRevert(api, result);
        CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    }

    // Another output device: it opens with the device's default channels.
    {
        const auto result = api.result("audio.set", json(R"({"outputDevice":"Fake Output B"})"));
        CONTROL_CHECK(memberOf(result, "changes").size() == 1);
        CONTROL_CHECK(memberOf(fieldOf(changeAt(result, 0), "outputDevice"), "after").text() == "Fake Output B");
        CONTROL_CHECK(deviceIs(deviceOf(result), "Fake", "Fake Output B", 44100.0, 512.0));
        replayRevert(api, result);
        CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    }

    // Another device type: its default device opens; the revert recipe names the
    // type and the device.
    {
        const auto result = api.result("audio.set", json(R"({"deviceType":"Fake B"})"));
        CONTROL_CHECK(memberOf(result, "changes").size() == 1);
        CONTROL_CHECK(deviceIs(deviceOf(result), "Fake B", "Fake B Output", 44100.0, 512.0));
        const auto& params = memberOf(memberOf(memberOf(result, "undo"), "revert"), "params");
        CONTROL_CHECK(memberOf(params, "deviceType").text() == "Fake"
                      && memberOf(params, "outputDevice").text() == "Fake Output A");
        replayRevert(api, result);
        CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    }

    // Busy: a dialog is open.
    {
        bridge.busy.modalOpen = true;
        CONTROL_CHECK(api.fails("audio.set", json(R"({"bufferSizeFrame":256})"), "BUSY", "modal_open"));
        bridge.busy.modalOpen = false;
        CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    }
}

/** The device cannot be opened with the new setup: the previous setup is
 * restored, as the settings page does. */
void checkRollback(ApiSession& api, FakeAudioRig& rig)
{
    const auto setupBefore = setupText(rig.manager);

    // The new sample rate does not open: restored, executed false, the device
    // runs as before.
    rig.behaviour.failRateHz = 48000.0;
    CONTROL_CHECK(failsWith(api, R"({"sampleRateHz":48000})", "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    CONTROL_CHECK(deviceIs(deviceOf(api.result("audio.get")), "Fake", "Fake Output A", 44100.0, 512.0));

    // The first step succeeded and the second does not: the whole call is taken
    // back, also the output device.
    CONTROL_CHECK(failsWith(api, R"({"outputDevice":"Fake Output B","sampleRateHz":48000,"bufferSizeFrame":256})",
                            "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK(setupText(rig.manager) == setupBefore);

    // A device that does not open after a switch of the type: the type is
    // switched back.
    rig.behaviour.failRateHz = 0.0;
    rig.behaviour.failDeviceName = "Fake B Output";
    CONTROL_CHECK(failsWith(api, R"({"deviceType":"Fake B"})", "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK(rig.manager.getCurrentAudioDeviceType() == "Fake" && setupText(rig.manager) == setupBefore);
    rig.behaviour.failDeviceName = {};

    // The previous setup does not open either: executed true, no device runs, and
    // audio.get says so.
    rig.behaviour.failAllOpens = true;
    CONTROL_CHECK(failsAfterChange(api, R"({"bufferSizeFrame":256})", "IO_ERROR", "device_open_failed"));
    rig.behaviour.failAllOpens = false;
    CONTROL_CHECK(rig.manager.getCurrentAudioDevice() == nullptr);
    const auto none = api.result("audio.get");
    CONTROL_CHECK(!memberOf(deviceOf(none), "running").asBoolean() && memberOf(deviceOf(none), "outputDevice").isNull()
                  && memberOf(memberOf(deviceOf(none), "nullReasons"), "bufferSizeFrame").text() == "no_audio_device");
    CONTROL_CHECK(memberOf(memberOf(none, "available"), "sampleRatesHz").size() == 0
                  && memberOf(memberOf(none, "available"), "outputDevices").size() == 2);

    // With no device nothing of the device is on offer, and no device is no state
    // that a request can restore; opening one is a change that cannot be
    // reverted.
    CONTROL_CHECK(failsWith(api, R"({"sampleRateHz":44100})", "INVALID_ARGUMENT", "audio_setting_unavailable"));
    {
        const auto result = api.result("audio.set", json(R"({"outputDevice":"Fake Output B"})"));
        CONTROL_CHECK(memberOf(result, "applied").asBoolean() && memberOf(result, "changes").size() == 1);
        CONTROL_CHECK(memberOf(fieldOf(changeAt(result, 0), "outputDevice"), "before").isNull());
        CONTROL_CHECK(memberOf(memberOf(result, "undo"), "revert").isNull() && hasWarning(result, "IRREVERSIBLE"));
        CONTROL_CHECK(memberOf(deviceOf(result), "running").asBoolean()
                      && memberOf(deviceOf(result), "outputDevice").text() == "Fake Output B");
    }
}

/** A failure with no device before the call leaves no device. */
void checkFailureWithoutDevice(ApiSession& api, FakeAudioRig& rig)
{
    CONTROL_CHECK(rig.manager.getCurrentAudioDevice() == nullptr);
    rig.behaviour.failDeviceName = "Fake Output B";
    CONTROL_CHECK(failsWith(api, R"({"outputDevice":"Fake Output B"})", "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK(rig.manager.getCurrentAudioDevice() == nullptr);
    rig.behaviour.failDeviceName = {};
    CONTROL_CHECK(!memberOf(deviceOf(api.result("audio.get")), "running").asBoolean());
}

/** The ASIO transitions: the editor restores the system sample rate first; a
   restore that cannot be verified keeps the current device. */
void checkAsioSwitch(ApiSession& api, FakeAudioRig& rig, PrefsBridge& bridge)
{
    const auto setupBefore = setupText(rig.manager);
    bridge.asioRestoreSucceeds = false;
    CONTROL_CHECK(failsWith(api, R"({"deviceType":"Fake B"})", "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK(failsWith(api, R"({"outputDevice":"Fake Output B"})", "IO_ERROR", "device_open_failed"));
    CONTROL_CHECK((bridge.switchReasons == std::vector<std::string>{"audio type switch", "audio output switch"}));
    CONTROL_CHECK(setupText(rig.manager) == setupBefore);
    // Other changes of an ASIO device do not close it for another one: no
    // restore.
    bridge.switchReasons.clear();
    const auto buffer = api.result("audio.set", json(R"({"bufferSizeFrame":256})"));
    CONTROL_CHECK(memberOf(buffer, "applied").asBoolean() && bridge.switchReasons.empty());
    replayRevert(api, buffer);
    bridge.asioRestoreSucceeds = true;
    const auto result = api.result("audio.set", json(R"({"deviceType":"Fake B"})"));
    CONTROL_CHECK(memberOf(result, "applied").asBoolean() && bridge.switchReasons.size() == 1);
    CONTROL_CHECK(deviceIs(deviceOf(result), "Fake B", "Fake B Output", 44100.0, 512.0));
}

} // namespace

void scenarioAudioDevice()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    ApiSession api;
    if (!api.open(service))
        return;
    PrefsBridge bridge;
    bridge.processor = processor.get();
    bridge.preferences = &processor->getAppPreferences();
    ScopedBridge registered(service, bridge);
    {
        // The bridge of the editor knows no device manager; then no editor at all.
        checkWithoutDevice(api, bridge, service);
    }
    {
        FakeAudioRig rig;
        bridge.manager = &rig.manager;
        checkRunningDevice(api, rig, bridge);
        checkRollback(api, rig);
        bridge.manager = nullptr;
    }
    {
        FakeAudioRig rig(false);
        bridge.manager = &rig.manager;
        checkFailureWithoutDevice(api, rig);
        bridge.manager = nullptr;
    }
    {
        FakeAudioRig rig(true, "ASIO");
        bridge.manager = &rig.manager;
        checkAsioSwitch(api, rig, bridge);
        bridge.manager = nullptr;
    }
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- The specification's vectors
// ---------------------------------------------------------------------------

namespace {

const std::set<std::string> kPrefsVectorMethods = {"prefs.set", "session.info", "job.get", "ui.setSelection"};
const std::set<std::string> kAudioVectorMethods = {"audio.get", "audio.set"};

/** Why this runner does not run a vector, or empty when it does. */
std::string vectorSkipReason(const JsonValue& vector, const std::string& capability,
                             const std::set<std::string>& methods)
{
    if (memberOf(vector, "capability").text() != capability)
        return "runs in the runner of its own capability";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (extra.at(i).text() != "jobs.v1" && extra.at(i).text() != "ui.bridge")
            return "needs capability " + extra.at(i).text() + ", which this runner does not cover";
    if (memberOf(vector, "session").text() != "authenticated")
        return "unauthenticated vectors test the listener (ControlUnitTests)";
    std::vector<std::string> used;
    if (const JsonValue* request = vector.find("request"))
        used.push_back(memberOf(*request, "method").text());
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i) {
            const auto& step = steps->at(i);
            if ((step.find("send") == nullptr && step.find("expect") == nullptr) || step.find("connection") != nullptr)
                return "uses steps other than send and expect on the main connection";
            if (const JsonValue* send = step.find("send"))
                used.push_back(memberOf(*send, "method").text());
        }
    for (const auto& method : used)
        if (methods.count(method) == 0)
            return "uses " + method + ", which this runner does not cover";
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name == "dirty" || name == "preferences" || name == "editingScheme" || name == "audio")
            continue;
        if (name != "clips")
            return "precondition given." + name + " is not established by this runner";
        for (std::size_t c = 0; c < given.at(i).size(); ++c)
            if (memberOf(given.at(i).at(c), "analysis").text() != "ready")
                return "a clip with analysis " + memberOf(given.at(i).at(c), "analysis").text()
                       + " is not established by this runner";
    }
    return {};
}

/**
 * Runs one vector against a fresh processor, a test bridge with a fake device
 * manager and the preferences of the vector's preconditions. ui.setSelection
 * (which a later part implements) is not sent: its effect in the vectors of
 * prefs.set, the clip being open in the piano roll, is made on the test bridge
 * and its response is not expected. Empty on success.
 */
std::string runVector(const JsonValue& vector, bool withClips)
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    const auto& given = memberOf(vector, "given");
    const auto& preferencesGiven = memberOf(given, "preferences");
    resetPreferences(
        *processor, memberOf(given, "editingScheme").text() == "openDyne",
        !(preferencesGiven.find("hybridMode") != nullptr && !memberOf(preferencesGiven, "hybridMode").asBoolean()),
        false,
        preferencesGiven.find("tuningHz") != nullptr
            ? static_cast<float>(memberOf(preferencesGiven, "tuningHz").asDouble())
            : TuningConfig::kDefaultTuningHz);
    const auto& audioGiven = memberOf(given, "audio");
    const bool audioRunning = audioGiven.find("running") == nullptr || memberOf(audioGiven, "running").asBoolean();
    FakeAudioRig rig(audioRunning);
    if (audioGiven.find("failsToOpen") != nullptr && memberOf(audioGiven, "failsToOpen").asBoolean())
        rig.behaviour.failRateHz = 48000.0;
    PrefsBridge bridge;
    bridge.processor = processor.get();
    bridge.preferences = &processor->getAppPreferences();
    bridge.manager = &rig.manager;
    bridge.generateNotes = true;
    bridge.project.dirty = memberOf(given, "dirty").isBoolean() && memberOf(given, "dirty").asBoolean();
    ScopedBridge registered(service, bridge);

    VectorMatcher matcher;
    std::vector<Clip> created;
    const auto& clips = memberOf(given, "clips");
    std::vector<std::string> binds;
    for (std::size_t i = 0; withClips && i < clips.size(); ++i) {
        const auto& spec = clips.at(i);
        ClipSpec clipSpec = readyClip(("vector-" + memberOf(spec, "bind").text()).c_str());
        clipSpec.trackId = static_cast<int>(memberOf(spec, "trackId").asDouble());
        clipSpec.startTimelineSec = memberOf(spec, "startTimelineSec").asDouble();
        clipSpec.durationSec = memberOf(spec, "durationSec").asDouble();
        created.push_back(fixtureAddClip(*processor, clipSpec));
        if (!created.back().key.isValid())
            return "the clip could not be added";
        binds.push_back(memberOf(spec, "bind").text());
    }

    ApiSession api;
    if (!api.open(service))
        return "session.hello failed";
    if (!created.empty()) {
        const auto project = api.result("project.get");
        for (std::size_t i = 0; i < created.size(); ++i) {
            const auto handles =
                fixtureHandlesOf(project, static_cast<int>(memberOf(clips.at(i), "trackId").asDouble()),
                                 memberOf(clips.at(i), "startTimelineSec").asDouble());
            if (!handles)
                return "project.get does not list the clip " + binds[i];
            matcher.bindings[binds[i] + ".contentId"] = JsonValue::string(handles->contentId);
            matcher.bindings[binds[i] + ".placementId"] = JsonValue::string(handles->placementId);
        }
    }

    std::string failure;
    runWhilePumping(
        [&] {
            auto& connection = api.client();
            const auto sendAndExpect = [&](const JsonValue& send, const JsonValue* expect) {
                const auto value = matcher.substitute(send, failure);
                if (!failure.empty())
                    return;
                if (!connection.sendLine(toJsonString(value))) {
                    failure = "cannot send the request";
                    return;
                }
                if (expect != nullptr)
                    failure = matcher.expectLine(connection, *expect);
            };
            if (memberOf(vector, "type").text() == "request") {
                sendAndExpect(memberOf(vector, "request"), &memberOf(vector, "response"));
                if (failure.empty() && memberOf(vector, "connectionAfter").text() == "open"
                    && !connection.staysQuiet(kOpenCheckMs))
                    failure = "the connection closed or sent more";
                return;
            }
            const auto& steps = memberOf(vector, "steps");
            for (std::size_t i = 0; i < steps.size() && failure.empty(); ++i) {
                const auto& step = steps.at(i);
                if (const JsonValue* send = step.find("send")) {
                    if (memberOf(*send, "method").text() == "ui.setSelection") {
                        // Opening the clip in the piano roll, on the test bridge; the
                        // next step expects its response.
                        bridge.view.workspace = "pianoRoll";
                        bridge.pianoRollKey = created.empty() ? ContentKey{} : created.front().key;
                        bridge.view.pianoRollPlacementId = created.empty() ? 0 : created.front().placementId;
                        ++i;
                        continue;
                    }
                    sendAndExpect(*send, nullptr);
                } else {
                    failure = matcher.expectLine(connection, memberOf(step, "expect"));
                }
                if (!failure.empty())
                    failure = "step " + std::to_string(i + 1) + ": " + failure;
            }
        },
        kJobExchangeMs);
    // The next vector starts from the defaults again.
    resetPreferences(*processor);
    return failure;
}

void runVectorsOf(const char* directory, const char* capability, const std::set<std::string>& methods,
                  const std::vector<std::string>& mustRun, bool withClips)
{
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors" / directory;
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    int passed = 0;
    int skipped = 0;
    std::set<std::string> passedIds;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto& vector = parsed.value;
        const auto id = memberOf(vector, "id").text();
        if (const auto reason = vectorSkipReason(vector, capability, methods); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runVector(vector, withClips);
        if (CONTROL_CHECK(failure.empty())) {
            ++passed;
            passedIds.insert(id);
        }
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    for (const auto& id : mustRun)
        CONTROL_CHECK(passedIds.count(id) == 1);
    note(std::to_string(passed) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace

void scenarioPrefsVectors()
{
    // prefs/get-ok is a read, run by the Vectors scenario.
    runVectorsOf("prefs", "prefs.write", kPrefsVectorMethods,
                 {"prefs/set-hybrid", "prefs/set-no-op", "prefs/set-out-of-range", "prefs/set-scheme",
                  "prefs/set-scheme-job", "prefs/set-tuning", "prefs/set-tuning-revert"},
                 true);
}

void scenarioAudioVectors()
{
    runVectorsOf("audio", "audio.device", kAudioVectorMethods,
                 {"audio/get-no-device", "audio/get-ok", "audio/set-ok", "audio/set-rollback", "audio/set-unavailable"},
                 false);
}

} // namespace ControlTest
} // namespace OpenTune
