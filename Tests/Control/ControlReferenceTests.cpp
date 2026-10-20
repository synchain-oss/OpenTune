// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of the reference alignment (content.analyzeReference, content.autoTune mode reference) against the real
// processor without a window or an audio device, with a test bridge for the dirty flag and the busy state. Contents
// get synthetic F0 (ControlContentFixtures.h). The alignment data of the reference clip is given to its content the
// way the processor stores a finished analysis (OpenTuneAudioProcessor::setContentReferenceFeatures), with notes that
// differ from the target's, so that the alignment has something to change; the target's own analysis runs through
// OpenTune's reference analysis service. Registered with the other processor scenarios in ControlProcessorTests.cpp.

#include "ControlContentFixtures.h"
#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Content/EditableContentSnapshot.h"
#include "Content/StandaloneContentRepository.h"
#include "Control/ControlDispatcher.h"
#include "Control/ControlJobs.h"
#include "Control/Edit/ContentEditTransaction.h"
#include "Control/Ops/OpsRegistry.h"
#include "Control/Ops/OpsSupport.h"
#include "Control/Ops/ReferenceOps.h"
#include "PluginProcessor.h"
#include "Utils/AppPreferences.h"
#include "Utils/ScaleUiMapping.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <optional>
#include <set>

namespace OpenTune {
namespace ControlTest {

namespace {

/** Bound of one vector's exchange while this thread pumps messages. */
constexpr int kVectorExchangeMs = 60000;
/** How long a scenario waits for a job to reach a state. */
constexpr int kJobStateTimeoutMs = 20000;
/** The wait limit of a reference job in the scenarios that let it run out. */
constexpr int kTestWaitLimitMs = 600;
/** Tolerance of a note's pitch read back as a MIDI number. */
constexpr double kMidiTolerance = 1e-3;

/** Sets the reference jobs' wait limit for its lifetime and restores the default (0) when it goes out of scope. */
struct WaitLimitGuard
{
    explicit WaitLimitGuard(int milliseconds) { controlSetReferenceWaitLimitForTesting(milliseconds); }
    ~WaitLimitGuard() { controlSetReferenceWaitLimitForTesting(0); }
    WaitLimitGuard(const WaitLimitGuard&) = delete;
    WaitLimitGuard& operator=(const WaitLimitGuard&) = delete;
};

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

double midiToHz(double midi)
{
    return 440.0 * std::pow(2.0, (midi - 69.0) / 12.0);
}

double hzToMidi(double hz)
{
    return 69.0 + 12.0 * std::log2(hz / 440.0);
}

/** One note of a feature set: start and end in content seconds, and the MIDI pitch. */
using FeatureNote = std::array<double, 3>;

/** Alignment data given to a content the way the processor stores a finished analysis: the status, the producer this
    instance uses, the content's audio revision as fingerprint, and the notes (with an onset at each start). */
bool setReferenceFeatures(OpenTuneAudioProcessor& processor, const ContentKey& key, ReferenceFeatureStatus status,
                          const std::vector<FeatureNote>& notes)
{
    const auto snapshot = processor.getContentSnapshot(key);
    if (snapshot == nullptr)
        return false;
    ReferenceFeatureSet features;
    features.status = status;
    features.producer = processor.getReferenceFeatureProducer();
    features.inputFingerprint = static_cast<std::int64_t>(snapshot->audioRevision);
    features.analysisRevision = snapshot->referenceFeatures.analysisRevision + 1;
    features.sourceDurationSeconds = snapshot->timeGrid != nullptr ? snapshot->timeGrid->totalDurationSeconds() : 6.0;
    std::uint64_t nextId = 1;
    for (const auto& item : notes) {
        Note note;
        note.startTime = item[0];
        note.endTime = item[1];
        note.pitch = static_cast<float>(midiToHz(item[2]));
        note.originalPitch = note.pitch;
        features.pitch.notes.push_back(note);
        ReferenceTimingAnchor anchor;
        anchor.anchorId = nextId++;
        anchor.sourceSeconds = item[0];
        anchor.strength = 1.0f;
        anchor.kind = ReferenceTimingAnchorKind::Onset;
        anchor.confidence = 1.0f;
        features.timing.anchors.push_back(anchor);
    }
    return processor.setContentReferenceFeatures(key, features);
}

/** The notes of the reference clip's alignment data: both of the target's notes, two semitones higher. */
const std::vector<FeatureNote>& referenceNotes()
{
    static const std::vector<FeatureNote> notes = {{0.5, 1.5, 66.0}, {2.0, 3.0, 71.0}};
    return notes;
}

/** The notes of the target clip's alignment data (targetSpec(), as its own analysis would produce them). */
const std::vector<FeatureNote>& targetNotes()
{
    static const std::vector<FeatureNote> notes = {{0.5, 1.5, 64.0}, {2.0, 3.0, 69.0}};
    return notes;
}

/** The target clip: 6 s on track 0 from 2 s with two notes at 64 and 69. */
ClipSpec targetSpec()
{
    ClipSpec spec;
    spec.name = "target";
    spec.trackId = 0;
    spec.startTimelineSec = 2.0;
    spec.durationSec = 6.0;
    spec.notes = {{0.5, 1.5, 64.0}, {2.0, 3.0, 69.0}};
    return spec;
}

/** The reference clip: 6 s on track 1 from 2 s. */
ClipSpec referenceSpec()
{
    ClipSpec spec;
    spec.name = "reference";
    spec.trackId = 1;
    spec.startTimelineSec = 2.0;
    spec.durationSec = 6.0;
    return spec;
}

/** The tokens of a content as project.get reports them right now (asOf.contents). */
JsonValue freshTokens(ApiSession& api, const std::string& contentId)
{
    const auto project = api.result("project.get");
    const auto& contents = memberOf(memberOf(project, "asOf"), "contents");
    for (std::size_t i = 0; i < contents.size(); ++i)
        if (memberOf(contents.at(i), "contentId").text() == contentId)
            return contents.at(i);
    return JsonValue();
}

/** A started processor with a test bridge, a session, a target clip bound to a reference clip. */
struct ReferenceFixture
{
    std::unique_ptr<OpenTuneAudioProcessor> processor;
    TestUiBridge bridge;
    std::unique_ptr<ScopedTestBridge> registered;
    ApiSession api;
    Clip target;
    Clip reference;
    std::string targetContentId;
    std::string targetPlacementId;
    std::string referenceContentId;
    std::string referencePlacementId;
    std::string instanceShort;

    /** Opens the processor and adds both clips and the binding; the reference clip gets its alignment data when
        giveReferenceData is set, the target none. */
    bool open(bool giveReferenceData = true, bool bind = true)
    {
        processor = startedProcessor();
        auto& service = processor->getControlService();
        if (!service.isRunning())
            return false;
        registered = std::make_unique<ScopedTestBridge>(service, bridge);
        if (!api.open(service))
            return false;
        instanceShort = memberOf(api.discovery(), "instanceId").text().substr(0, 8);
        target = fixtureAddClip(*processor, targetSpec());
        reference = fixtureAddClip(*processor, referenceSpec());
        // The render that importing the clips requested is over before the first timed request.
        CONTROL_CHECK(settleBackgroundWork(*processor));
        const auto project = api.result("project.get");
        const auto targetHandles = fixtureHandlesOf(project, 0, 2.0);
        const auto referenceHandles = fixtureHandlesOf(project, 1, 2.0);
        if (!CONTROL_CHECK(targetHandles.has_value() && referenceHandles.has_value()))
            return false;
        targetContentId = targetHandles->contentId;
        targetPlacementId = targetHandles->placementId;
        referenceContentId = referenceHandles->contentId;
        referencePlacementId = referenceHandles->placementId;
        if (bind)
            CONTROL_CHECK(processor->getStandaloneArrangement()->setPlacementReferencePlacement(0, target.placementId,
                                                                                                reference.placementId));
        if (giveReferenceData)
            CONTROL_CHECK(
                setReferenceFeatures(*processor, reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        return true;
    }

    ControlService& service() { return processor->getControlService(); }

    /** The pitch of the target's notes as MIDI numbers, in stored order. */
    std::vector<double> targetMidi() const
    {
        std::vector<double> out;
        const auto snapshot = processor->getContentSnapshot(target.key);
        if (snapshot != nullptr)
            for (const auto& note : snapshot->notes)
                out.push_back(hzToMidi(note.pitch));
        return out;
    }

    bool targetMidiIs(double first, double second) const
    {
        const auto midi = targetMidi();
        return midi.size() == 2 && std::abs(midi[0] - first) < kMidiTolerance
               && std::abs(midi[1] - second) < kMidiTolerance;
    }

    bool alignmentReady()
    {
        const auto details =
            api.result("content.getDetails", jsonOf("{\"contentId\":" + jsonQuoted(targetContentId) + "}"));
        return memberOf(memberOf(details, "reference"), "alignmentReady").asBoolean();
    }

    /** The params of content.autoTune mode reference at the content's current revision, and with its current key
        revision when withKeyRevision is set. */
    JsonValue autoRefParams(bool withKeyRevision = false)
    {
        const auto tokens = freshTokens(api, targetContentId);
        std::string keyRevision;
        if (withKeyRevision)
            keyRevision = ",\"expectedKeyRevision\":" + jsonQuoted(memberOf(tokens, "keyRevision").text());
        return jsonOf("{\"contentId\":" + jsonQuoted(targetContentId) + ",\"mode\":\"reference\",\"expectedRevision\":"
                      + jsonQuoted(memberOf(tokens, "revision").text()) + keyRevision
                      + ",\"placementId\":" + jsonQuoted(targetPlacementId) + "}");
    }

    /** A note edit of the target as the piano roll makes it: every note shifted by cents through the content commands
        over the whole content, recorded as one PianoRollEditAction on OpenTune's history. */
    bool editTargetNotesInUi(double cents)
    {
        ContentEditTransaction transaction(*processor, target.key);
        if (!CONTROL_CHECK(transaction.captureBefore()))
            return false;
        const auto snapshot = processor->getContentSnapshot(target.key);
        auto notes = snapshot->notes;
        for (auto& note : notes)
            note.pitch *= static_cast<float>(std::pow(2.0, cents / 1200.0));
        const int frames = static_cast<int>(snapshot->pitchCurve->size());
        if (!CONTROL_CHECK(processor->commitContentNotesAndSegments(target.key, notes,
                                                                    snapshot->pitchCurve->getCorrectionSegments(),
                                                                    ContentEditRangeFrames{0, frames})
                           != nullptr))
            return false;
        if (!CONTROL_CHECK(transaction.recordRange(TRANS("编辑"), F0FrameRange{0, frames})))
            return false;
        auto actions = transaction.takeActions();
        if (!CONTROL_CHECK(actions.size() == 1))
            return false;
        processor->getUndoManager().addAction(std::move(actions.front().action));
        return true;
    }

    JsonValue analyzeParams() { return jsonOf("{\"placementId\":" + jsonQuoted(targetPlacementId) + "}"); }

    /** Starts content.analyzeReference; the job id, or empty when the call did not return a job. */
    std::string startAnalyze()
    {
        const auto result = api.result("content.analyzeReference", analyzeParams());
        const auto& job = memberOf(result, "job");
        if (!CONTROL_CHECK(job.isObject() && memberOf(job, "kind").text() == "referenceAnalysis"))
            return {};
        return memberOf(job, "jobId").text();
    }

    /** Starts content.autoTune mode reference; the job id, or empty when the call did not hand the work to a job. */
    std::string startAutoRef(bool withKeyRevision = false)
    {
        const auto result = api.result("content.autoTune", autoRefParams(withKeyRevision));
        const auto& job = memberOf(result, "job");
        if (!CONTROL_CHECK(job.isObject() && memberOf(job, "kind").text() == "referenceAnalysis"))
            return {};
        // The state "handed to a job": nothing changed yet (PROTOCOL.md section 14.2).
        CONTROL_CHECK(!memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean()
                      && memberOf(result, "undo").isNull() && memberOf(result, "changes").size() == 0
                      && memberOf(result, "mode").text() == "reference" && memberOf(result, "keyUsed").isNull()
                      && memberOf(result, "paramsUsed").isNull() && memberOf(result, "noteCount").isNull());
        return memberOf(job, "jobId").text();
    }

    /** The job from the registry, without a request. */
    JsonValue jobOf(const std::string& jobId)
    {
        JsonValue job;
        service().jobs()->get(jobId, job);
        return job;
    }

    bool waitJobState(const std::string& jobId, const std::string& state)
    {
        return pumpMessagesUntil([&] { return memberOf(jobOf(jobId), "state").text() == state; }, kJobStateTimeoutMs);
    }

    /** Waits for the job to fail; true when it failed with this kind and reason, retryable as given and executed
        false. */
    bool failedWith(const std::string& jobId, const std::string& kind, const std::string& reason, bool retryable)
    {
        if (!CONTROL_CHECK(waitJobState(jobId, "failed")))
            return false;
        const auto job = jobOf(jobId);
        const auto error = memberOf(memberOf(job, "error"), "data");
        const bool ok =
            memberOf(error, "kind").text() == kind
            && (reason.empty() ? error.find("reason") == nullptr : memberOf(error, "reason").text() == reason)
            && memberOf(error, "retryable").isBoolean() && memberOf(error, "retryable").asBoolean() == retryable
            && memberOf(error, "executed").isBoolean() && !memberOf(error, "executed").asBoolean();
        if (!ok)
            note("expected a job failed with " + kind + "(" + reason + "), got "
                 + toJsonString(memberOf(job, "error")));
        return ok;
    }

    /** The number of undo steps on OpenTune's history (edit.getHistory). */
    std::size_t historySize()
    {
        return static_cast<std::size_t>(
            memberOf(memberOf(api.result("edit.getHistory"), "history"), "undoCount").asDouble());
    }
};

// ---- Scenario: the analysis, the alignment and its undo ------------------------------------------------

void scenarioReferenceImpl()
{
    ReferenceFixture f;
    if (!f.open())
        return;

    // The instance reports the capability: its one method is registered.
    const auto capabilities = f.service().dispatcher()->capabilities();
    CONTROL_CHECK(std::find(capabilities.begin(), capabilities.end(), "reference.v1") != capabilities.end());

    // content.analyzeReference: the target's alignment data comes from OpenTune's analysis, the reference's was given.
    CONTROL_CHECK(f.targetMidiIs(64.0, 69.0));
    CONTROL_CHECK(!f.alignmentReady());
    const auto tokensBeforeAnalysis = freshTokens(f.api, f.targetContentId);
    const auto analyzeId = f.startAnalyze();
    if (!CONTROL_CHECK(!analyzeId.empty()) || !CONTROL_CHECK(f.waitJobState(analyzeId, "succeeded")))
        return;
    // The analysis that finished (ReferenceAnalysisService, then OpenTuneAudioProcessor::analysisFinished()) stored
    // the alignment data alone: the revision and the key revision, which an aligning job compares before it writes,
    // are those of before.
    const auto tokensAfterAnalysis = freshTokens(f.api, f.targetContentId);
    CONTROL_CHECK(memberOf(tokensAfterAnalysis, "revision").text() == memberOf(tokensBeforeAnalysis, "revision").text()
                  && memberOf(tokensAfterAnalysis, "keyRevision").text()
                         == memberOf(tokensBeforeAnalysis, "keyRevision").text());
    const auto analysis = f.jobOf(analyzeId);
    CONTROL_CHECK(memberOf(analysis, "kind").text() == "referenceAnalysis"
                  && !memberOf(analysis, "cancellable").asBoolean());
    CONTROL_CHECK(toJsonString(memberOf(analysis, "result"))
                  == "{\"placementId\":" + jsonQuoted(f.targetPlacementId) + ",\"referencePlacementId\":"
                         + jsonQuoted(f.referencePlacementId) + ",\"alignmentReady\":true}");
    CONTROL_CHECK(f.alignmentReady());
    // The analysis is derived from the audio: no edit, no undo entry, no dirty mark.
    CONTROL_CHECK(f.targetMidiIs(64.0, 69.0) && f.historySize() == 0 && f.bridge.dirtyMarks == 0);
    // A call when nothing is running starts a job of its own.
    const auto again = f.startAnalyze();
    CONTROL_CHECK(!again.empty() && again != analyzeId && f.waitJobState(again, "succeeded"));

    // content.autoTune mode reference: the data is there, so the job aligns the content in one undo step.
    const auto autoId = f.startAutoRef();
    if (!CONTROL_CHECK(!autoId.empty()) || !CONTROL_CHECK(f.waitJobState(autoId, "succeeded")))
        return;
    const auto result = memberOf(f.jobOf(autoId), "result");
    CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
    CONTROL_CHECK(memberOf(result, "mode").text() == "reference" && memberOf(result, "keyUsed").isNull()
                  && memberOf(result, "paramsUsed").isNull() && memberOf(result, "job").isNull());
    CONTROL_CHECK(toJsonString(memberOf(result, "noteCount")) == R"({"before":2,"after":2})");
    CONTROL_CHECK(memberOf(result, "changes").size() == 2 && memberOf(result, "created").size() == 0
                  && memberOf(result, "removed").size() == 0);
    CONTROL_CHECK(f.targetMidiIs(66.0, 71.0));
    const auto& undo = memberOf(result, "undo");
    CONTROL_CHECK(memberOf(undo, "undoable").asBoolean() && memberOf(undo, "steps").asDouble() == 1.0
                  && memberOf(undo, "description").text() == "AUTO (Ref)"
                  && toJsonString(memberOf(undo, "innerActions")) == R"(["PianoRollEditAction"])");
    CONTROL_CHECK(!memberOf(memberOf(result, "dirty"), "before").asBoolean()
                  && memberOf(memberOf(result, "dirty"), "after").asBoolean());
    CONTROL_CHECK(f.bridge.dirtyMarks == 1 && f.historySize() == 1);

    // One undo step puts the notes back, and redo applies the alignment again.
    const auto undoId = memberOf(undo, "undoId").text();
    f.api.result("edit.undo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(undoId) + "}"));
    CONTROL_CHECK(f.targetMidiIs(64.0, 69.0));
    f.api.result("edit.redo", jsonOf("{\"expectedUndoId\":" + jsonQuoted(undoId) + "}"));
    CONTROL_CHECK(f.targetMidiIs(66.0, 71.0));

    // A second alignment finds nothing to change: a successful no-op without an undo entry.
    const auto second = f.startAutoRef();
    if (!CONTROL_CHECK(!second.empty()) || !CONTROL_CHECK(f.waitJobState(second, "succeeded")))
        return;
    const auto repeated = memberOf(f.jobOf(second), "result");
    CONTROL_CHECK(!memberOf(repeated, "applied").asBoolean() || memberOf(repeated, "noOp").asBoolean());
    CONTROL_CHECK(memberOf(repeated, "noOp").asBoolean()
                  && !memberOf(memberOf(repeated, "undo"), "undoable").asBoolean());
    CONTROL_CHECK(f.targetMidiIs(66.0, 71.0) && f.historySize() == 1);
}

// ---- Scenario: the wait limit, the one job per placement, cancellation -----------------------------------

/** Upstream's analysis service finishes one analysis per session: the first job itself consumes it for one of its two
    contents (the other content's analysis is queued behind it and never taken), and the job ends as soon as the worker
    is stuck, with NOT_READY(reference_analysis_stalled), not at its wait limit. */
void scenarioUpstreamServiceLimit()
{
    ReferenceFixture f;
    if (!f.open(false))
        return;
    // Far longer than this test: a job that waits instead of detecting the stall does not end within the test.
    WaitLimitGuard limit(60000);
    const auto jobId = f.startAnalyze();
    if (!CONTROL_CHECK(!jobId.empty())
        || !CONTROL_CHECK(pumpMessagesUntil(
            [&] {
                const auto state = memberOf(f.jobOf(jobId), "state").text();
                return state == "succeeded" || state == "failed";
            },
            kJobStateTimeoutMs)))
        return;
    const auto readyCount = [&] {
        int ready = 0;
        for (const auto& key : {f.target.key, f.reference.key}) {
            const auto snapshot = f.processor->getContentSnapshot(key);
            if (snapshot != nullptr && snapshot->referenceFeatures.isReady())
                ++ready;
        }
        return ready;
    };
    if (memberOf(f.jobOf(jobId), "state").text() == "succeeded") {
        // The asynchronous (GAME) producer completes both analyses (its worker resets activeJob), so both contents
        // have their data; the synchronous standard producer never takes the second job.
        note("the reference analysis service completed both analyses");
        CONTROL_CHECK(readyCount() == 2);
        return;
    }
    // ReferenceAnalysisService::workerLoop never takes a second synchronous job: exactly one content has its data.
    // Nothing before this job requested an analysis; the job's own preheat of the two contents used the one analysis.
    note("the reference analysis service completed one analysis only (known upstream behaviour)");
    CONTROL_CHECK(readyCount() == 1);
    CONTROL_CHECK(f.failedWith(jobId, "NOT_READY", "reference_analysis_stalled", false));

    // A later call for the same binding fails the same way at its first step, without waiting for the limit.
    const auto later = f.startAnalyze();
    CONTROL_CHECK(!later.empty() && later != jobId);
    CONTROL_CHECK(f.failedWith(later, "NOT_READY", "reference_analysis_stalled", false));

    // The stall is only about missing data: with both contents current the analysis reports ready and the aligning job
    // still commits (the worker is not needed). Either content may be the one the worker completed (pendingJobs is
    // ordered by content key, not by submission), so both sets are written.
    CONTROL_CHECK(setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, targetNotes()));
    CONTROL_CHECK(
        setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
    const auto readyJob = f.startAnalyze();
    CONTROL_CHECK(!readyJob.empty() && f.waitJobState(readyJob, "succeeded"));
    CONTROL_CHECK(memberOf(memberOf(f.jobOf(readyJob), "result"), "alignmentReady").asBoolean());
    const auto alignJob = f.startAutoRef();
    CONTROL_CHECK(!alignJob.empty() && f.waitJobState(alignJob, "succeeded"));
    CONTROL_CHECK(f.targetMidiIs(66.0, 71.0) && f.historySize() == 1);
}

void scenarioReferenceLimitImpl()
{
    ReferenceFixture f;
    if (!f.open(false))
        return;
    WaitLimitGuard limit(kTestWaitLimitMs);
    // The target has its data; the reference's analysis never finishes.
    CONTROL_CHECK(setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
    CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));

    // A call for a placement whose analysis job is not terminal returns that job; the job of content.autoTune is not
    // taken for it.
    const auto first = f.startAnalyze();
    if (!CONTROL_CHECK(!first.empty()))
        return;
    CONTROL_CHECK(f.startAnalyze() == first);
    CONTROL_CHECK(memberOf(f.jobOf(first), "state").text() != "failed");
    const auto autoId = f.startAutoRef();
    CONTROL_CHECK(!autoId.empty() && autoId != first);
    // The jobs report the wait, then end at the limit: retryable, nothing executed, no note and no history entry.
    CONTROL_CHECK(f.failedWith(first, "NOT_READY", "reference_analysis_timeout", true));
    CONTROL_CHECK(f.failedWith(autoId, "NOT_READY", "reference_analysis_timeout", true));
    CONTROL_CHECK(f.targetMidiIs(64.0, 69.0) && f.historySize() == 0 && f.bridge.dirtyMarks == 0);
    // Once the job is terminal, the next call starts a new job.
    const auto next = f.startAnalyze();
    CONTROL_CHECK(!next.empty() && next != first);

    // job.cancel stops the wait: the job ends cancelled and changes nothing.
    const auto cancelled = memberOf(f.api.result("job.cancel", jsonOf("{\"jobId\":" + jsonQuoted(next) + "}")), "job");
    CONTROL_CHECK(cancelled.isObject());
    CONTROL_CHECK(f.waitJobState(next, "cancelled"));
    const auto job = f.jobOf(next);
    CONTROL_CHECK(memberOf(memberOf(memberOf(job, "error"), "data"), "kind").text() == "CANCELLED"
                  && !memberOf(memberOf(memberOf(job, "error"), "data"), "executed").asBoolean());

    // An analysis that failed for the current audio is reported as failed, not waited out: ANALYSIS_FAILED with the
    // reference analysis reason, not retryable, and nothing written.
    {
        ReferenceFixture failed;
        if (!failed.open(false))
            return;
        CONTROL_CHECK(setReferenceFeatures(*failed.processor, failed.target.key, ReferenceFeatureStatus::Ready,
                                           referenceNotes()));
        CONTROL_CHECK(
            setReferenceFeatures(*failed.processor, failed.reference.key, ReferenceFeatureStatus::Failed, {}));
        const auto analyzeId = failed.startAnalyze();
        CONTROL_CHECK(!analyzeId.empty());
        CONTROL_CHECK(failed.failedWith(analyzeId, "ANALYSIS_FAILED", "reference_analysis_failed", false));
        const auto alignId = failed.startAutoRef();
        CONTROL_CHECK(!alignId.empty());
        CONTROL_CHECK(failed.failedWith(alignId, "ANALYSIS_FAILED", "reference_analysis_failed", false));
        CONTROL_CHECK(failed.targetMidiIs(64.0, 69.0) && failed.historySize() == 0 && failed.bridge.dirtyMarks == 0);
    }
}

// ---- Scenario: the checks the jobs make again --------------------------------------------------------------

void scenarioReferenceJobChecksImpl()
{
    // The binding is removed while the job waits for the reference's data.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto jobId = f.startAutoRef();
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(
            f.processor->getStandaloneArrangement()->setPlacementReferencePlacement(0, f.target.placementId, 0));
        CONTROL_CHECK(f.failedWith(jobId, "INVALID_ARGUMENT", "reference_not_bound", false));
        CONTROL_CHECK(f.targetMidiIs(64.0, 69.0) && f.historySize() == 0);
    }
    // The target's pitch analysis runs again while the job waits.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto jobId = f.startAnalyze();
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(f.processor->setContentOriginalF0State(f.target.key, OriginalF0State::Extracting));
        CONTROL_CHECK(f.failedWith(jobId, "NOT_READY", "f0_not_ready", true));
    }
    // The target's clip is deleted while the job waits.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto jobId = f.startAnalyze();
        CONTROL_CHECK(!jobId.empty());
        const int index = f.processor->findPlacementIndexById(0, f.target.placementId);
        CONTROL_CHECK(index >= 0 && f.processor->deletePlacement(0, index).has_value());
        CONTROL_CHECK(f.failedWith(jobId, "NOT_FOUND", "unknown_handle", false));
    }
    // A dialog opens while the aligning job waits: the job does not write once the data is there.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto jobId = f.startAutoRef();
        CONTROL_CHECK(!jobId.empty());
        pumpMessagesFor(100);
        f.bridge.busy.modalOpen = true;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(f.failedWith(jobId, "BUSY", "modal_open", true));
        CONTROL_CHECK(f.targetMidiIs(64.0, 69.0) && f.historySize() == 0 && f.bridge.dirtyMarks == 0);
    }
    // The tokens the call checked are compared again just before the alignment (PROTOCOL.md section 10 rule 3). The
    // user edits the target's notes while the aligning job waits for the reference's data: the job ends with
    // REVISION_CONFLICT(content_changed) and writes nothing, so the notes and the history stay as the edit left them.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto jobId = f.startAutoRef();
        CONTROL_CHECK(!jobId.empty());
        // The edit is made once the job runs (it waits for the reference's data), not after a fixed time.
        CONTROL_CHECK(f.waitJobState(jobId, "running"));
        CONTROL_CHECK(f.editTargetNotesInUi(100.0));
        CONTROL_CHECK(f.targetMidiIs(65.0, 70.0) && f.historySize() == 1);
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(f.failedWith(jobId, "REVISION_CONFLICT", "content_changed", false));
        CONTROL_CHECK(f.targetMidiIs(65.0, 70.0) && f.historySize() == 1 && f.bridge.dirtyMarks == 0);
    }
    // The same for the key, when the call gave expectedKeyRevision: REVISION_CONFLICT(key_changed), nothing written.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto revisionBefore = memberOf(freshTokens(f.api, f.targetContentId), "revision").text();
        const auto keyBefore = memberOf(freshTokens(f.api, f.targetContentId), "keyRevision").text();
        const auto jobId = f.startAutoRef(true);
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(f.waitJobState(jobId, "running"));
        // A key chosen in the UI (PluginEditor::scaleChanged() calls setContentDetectedKey()): the key revision
        // changes, the revision does not.
        CONTROL_CHECK(f.processor->setContentDetectedKey(f.target.key, makeDetectedKeyFromUi(5, 1)));
        CONTROL_CHECK(memberOf(freshTokens(f.api, f.targetContentId), "keyRevision").text() != keyBefore);
        CONTROL_CHECK(memberOf(freshTokens(f.api, f.targetContentId), "revision").text() == revisionBefore);
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        CONTROL_CHECK(f.failedWith(jobId, "REVISION_CONFLICT", "key_changed", false));
        CONTROL_CHECK(f.targetMidiIs(64.0, 69.0) && f.historySize() == 0 && f.bridge.dirtyMarks == 0);
    }
    // Without a change the job aligns once the data it waited for is there: storing alignment data (what OpenTune does
    // when its analysis finishes, OpenTuneAudioProcessor::setContentReferenceFeatures()) advances neither the revision
    // nor the key revision, so the comparison before the alignment finds no conflict.
    {
        ReferenceFixture f;
        if (!f.open(false))
            return;
        CONTROL_CHECK(setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Extracting, {}));
        const auto before = freshTokens(f.api, f.targetContentId);
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.target.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        const auto stored = freshTokens(f.api, f.targetContentId);
        CONTROL_CHECK(memberOf(stored, "revision").text() == memberOf(before, "revision").text()
                      && memberOf(stored, "keyRevision").text() == memberOf(before, "keyRevision").text());
        const auto jobId = f.startAutoRef(true);
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(f.waitJobState(jobId, "running"));
        CONTROL_CHECK(
            setReferenceFeatures(*f.processor, f.reference.key, ReferenceFeatureStatus::Ready, referenceNotes()));
        if (!CONTROL_CHECK(f.waitJobState(jobId, "succeeded")))
            return;
        CONTROL_CHECK(memberOf(memberOf(f.jobOf(jobId), "result"), "applied").asBoolean());
        CONTROL_CHECK(f.targetMidiIs(66.0, 71.0) && f.historySize() == 1 && f.bridge.dirtyMarks == 1);
    }
    // The checks of the call itself.
    {
        ReferenceFixture f;
        if (!f.open(true, false))
            return;
        CONTROL_CHECK(
            f.api.fails("content.analyzeReference", f.analyzeParams(), "INVALID_ARGUMENT", "reference_not_bound"));
        CONTROL_CHECK(f.api.fails("content.autoTune", f.autoRefParams(), "INVALID_ARGUMENT", "reference_not_bound"));
        CONTROL_CHECK(
            f.api.fails("content.autoTune",
                        jsonOf("{\"contentId\":" + jsonQuoted(f.referenceContentId)
                               + ",\"mode\":\"reference\",\"expectedRevision\":"
                               + jsonQuoted(memberOf(freshTokens(f.api, f.referenceContentId), "revision").text())
                               + ",\"placementId\":" + jsonQuoted(f.targetPlacementId) + "}"),
                        "INVALID_ARGUMENT", "placement_content_mismatch"));
        // mode reference needs a placementId, and takes no ranges.
        CONTROL_CHECK(f.api.fails(
            "content.autoTune",
            jsonOf("{\"contentId\":" + jsonQuoted(f.targetContentId) + ",\"mode\":\"reference\",\"expectedRevision\":"
                   + jsonQuoted(memberOf(freshTokens(f.api, f.targetContentId), "revision").text()) + "}"),
            "INVALID_ARGUMENT", "invalid_params"));
        CONTROL_CHECK(f.api.fails("content.analyzeReference", jsonOf(R"({"placementId":"x"})"), "INVALID_ARGUMENT",
                                  "invalid_params"));
    }
}

// ---- The specification's vectors -------------------------------------------------------------------------

/** The vectors of the specification that run against the processor and must pass, by id. */
const char* const kMustRunReferenceVectors[] = {
    "content/analyze-reference-job",
    "content/analyze-reference-job-failures",
    "content/analyze-reference-not-bound",
    "content/analyze-reference-not-found",
    "content/analyze-reference-not-ready",
    "content/analyze-reference-ok",
    "content/auto-tune-placement-content-mismatch",
    "content/auto-tune-reference",
    "content/auto-tune-reference-capability-missing",
    "content/auto-tune-reference-job",
    "content/auto-tune-reference-not-bound",
    "content/get-details-reference-binding",
};

const std::set<std::string> kReferenceVectorMethods = {"content.analyzeReference", "content.autoTune",
                                                       "content.getDetails", "job.get", "project.get"};
const std::set<std::string> kReferenceVectorCapabilities = {"session.v1", "read.v1", "jobs.v1", "edit.v1",
                                                            "reference.v1"};

bool isReferenceVector(const std::string& id)
{
    return id.rfind("content/analyze-reference-", 0) == 0 || id.rfind("content/auto-tune-reference", 0) == 0
           || id == "content/get-details-reference-binding" || id == "content/auto-tune-placement-content-mismatch";
}

/** Why this runner does not run a vector, or empty when it does. */
std::string referenceVectorSkipReason(const JsonValue& vector)
{
    if (kReferenceVectorCapabilities.count(memberOf(vector, "capability").text()) == 0)
        return "needs capability " + memberOf(vector, "capability").text() + ", which another part implements";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (kReferenceVectorCapabilities.count(extra.at(i).text()) == 0)
            return "needs capability " + extra.at(i).text() + ", which another part implements";
    if (memberOf(vector, "session").text() != "authenticated")
        return "unauthenticated vectors test the listener (ControlUnitTests)";
    std::vector<const JsonValue*> requests;
    if (const JsonValue* request = vector.find("request"))
        requests.push_back(request);
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i) {
            const auto& step = steps->at(i);
            if ((step.find("send") == nullptr && step.find("expect") == nullptr) || step.find("connection") != nullptr)
                return "uses steps other than send and expect on the main connection";
            if (const JsonValue* send = step.find("send"))
                requests.push_back(send);
        }
    for (const auto* request : requests)
        if (kReferenceVectorMethods.count(memberOf(*request, "method").text()) == 0)
            return "uses " + memberOf(*request, "method").text() + ", which another part implements";
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name == "dirty" || name == "clips" || name == "editingScheme" || name == "withoutCapabilities")
            continue;
        if (name == "preferences") {
            for (std::size_t p = 0; p < given.at(i).size(); ++p)
                if (given.at(i).keyAt(p) != "experimentalFeatures")
                    return "preference " + given.at(i).keyAt(p) + " is not established by this runner";
            continue;
        }
        if (name == "jobs") {
            for (std::size_t j = 0; j < given.at(i).size(); ++j)
                if (memberOf(given.at(i).at(j), "state").text() != "failed")
                    return "a job that has not failed is not established by this runner";
            continue;
        }
        return "precondition given." + name + " is not established by this runner";
    }
    return {};
}

/** Establishes given.jobs (failed jobs of the kinds they name, with their errors); binds their ids. */
bool establishFailedJobs(ControlJobs& jobs, const JsonValue& given, VectorMatcher& matcher)
{
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& spec = given.at(i);
        const auto& error = memberOf(spec, "error");
        const ControlJobError failure{memberOf(error, "kind").text(), memberOf(error, "reason").text(),
                                      "a failed job of the fixture", false};
        const auto started =
            jobs.start(memberOf(spec, "kind").text(), true, [failure](ControlJobStep& step) { step.fail(failure); });
        if (started.jobId.empty())
            return false;
        matcher.bindings[memberOf(spec, "bind").text()] = JsonValue::string(started.jobId);
        const std::string jobId = started.jobId;
        if (!pumpMessagesUntil(
                [&jobs, jobId] {
                    JsonValue job;
                    return jobs.get(jobId, job) == ControlJobs::Lookup::Found
                           && memberOf(job, "state").text() == "failed";
                },
                kReadTimeoutMs))
            return false;
    }
    return true;
}

/** An instance that does not report the capabilities in without: the request run directly with its facts, the way
    a client of such an instance would be answered; the error it gives, or nullopt when it did not fail. */
std::optional<ControlErrorReply> runWithoutCapabilities(OpenTuneAudioProcessor& processor,
                                                        const std::string& instanceId, const JsonValue& request,
                                                        const JsonValue& without)
{
    ControlMethodTable table;
    registerControlMethods(table);
    const ControlMethod* method = table.find(memberOf(request, "method").text());
    if (!CONTROL_CHECK(method != nullptr))
        return std::nullopt;
    std::shared_ptr<const void> parsed;
    std::string why;
    if (!CONTROL_CHECK(method->parse(memberOf(request, "params"), parsed, why)))
        return std::nullopt;
    ControlInstanceFacts facts;
    facts.instanceId = instanceId;
    facts.capabilities = {"session.v1", "read.v1", "jobs.v1", "edit.v1", "history.v1", "reference.v1"};
    for (std::size_t i = 0; i < without.size(); ++i)
        facts.capabilities.erase(
            std::remove(facts.capabilities.begin(), facts.capabilities.end(), without.at(i).text()),
            facts.capabilities.end());
    ControlThreadProbe probe;
    ControlOpContext context(processor, nullptr, facts, probe);
    auto result = method->run(context, parsed.get());
    if (result.ok())
        return std::nullopt;
    return controlMapError(result.error());
}

std::string runReferenceVector(const JsonValue& vector)
{
    ReferenceFixture f;
    f.processor = startedProcessor();
    auto& service = f.processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    f.registered = std::make_unique<ScopedTestBridge>(service, f.bridge);
    if (!f.api.open(service))
        return "session.hello failed";
    f.instanceShort = memberOf(f.api.discovery(), "instanceId").text().substr(0, 8);
    const auto& given = memberOf(vector, "given");
    // The preferences persist in the data directory between vectors: set what the vector needs every time.
    auto& preferences = f.processor->getAppPreferences();
    preferences.setAudioEditingScheme(memberOf(given, "editingScheme").text() == "openDyne"
                                          ? AudioEditingScheme::Scheme::NotesPrimary
                                          : AudioEditingScheme::Scheme::CorrectedF0Primary);
    preferences.setExperimentalFeaturesEnabled(
        memberOf(memberOf(given, "preferences"), "experimentalFeatures").asBoolean());

    VectorMatcher matcher;
    struct Created
    {
        std::string bind;
        ClipSpec spec;
        Clip clip;
    };
    std::vector<Created> created;
    std::vector<std::pair<std::string, std::string>> references; // clip -> clip it has a reference binding to
    std::set<std::string> referenced;
    const auto& clips = memberOf(given, "clips");
    for (std::size_t i = 0; i < clips.size(); ++i) {
        const auto& item = clips.at(i);
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
        if (const JsonValue* reference = item.find("referenceClip")) {
            references.emplace_back(spec.name, reference->text());
            referenced.insert(reference->text());
        }
        created.push_back({spec.name, spec, fixtureAddClip(*f.processor, spec)});
    }
    CONTROL_CHECK(settleBackgroundWork(*f.processor));
    const auto find = [&created](const std::string& name) -> const Created* {
        for (const auto& item : created)
            if (item.bind == name)
                return &item;
        return nullptr;
    };
    // Reference bindings, as the editor's menu sets them; the alignment data of a clip that others refer to, as a
    // finished analysis stores it (the target's own analysis runs through OpenTune's service when the job asks).
    for (const auto& [target, reference] : references) {
        const auto* targetClip = find(target);
        const auto* referenceClip = find(reference);
        if (!CONTROL_CHECK(targetClip != nullptr && referenceClip != nullptr))
            return "a referenceClip names no clip";
        CONTROL_CHECK(f.processor->getStandaloneArrangement()->setPlacementReferencePlacement(
            targetClip->spec.trackId, targetClip->clip.placementId, referenceClip->clip.placementId));
    }
    for (const auto& name : referenced)
        if (const auto* clip = find(name); clip != nullptr && clip->spec.analysis == Analysis::Ready)
            CONTROL_CHECK(
                setReferenceFeatures(*f.processor, clip->clip.key, ReferenceFeatureStatus::Ready, referenceNotes()));
    if (!establishFailedJobs(*service.jobs(), memberOf(given, "jobs"), matcher))
        return "given.jobs could not be established";
    f.bridge.project.dirty = memberOf(given, "dirty").asBoolean();

    const auto& discovery = f.api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);
    const auto epoch = std::to_string(f.processor->getStandaloneContentRepository()->getContentEpoch());
    matcher.bindings["runner.unknownContentId"] =
        JsonValue::string("c:" + f.instanceShort + ":" + epoch + ":4294967295");
    matcher.bindings["runner.unknownPlacementId"] =
        JsonValue::string("p:" + f.instanceShort + ":" + epoch + ":4294967295");
    if (!created.empty()) {
        const auto project = f.api.result("project.get");
        for (const auto& item : created) {
            const auto handles = fixtureHandlesOf(project, item.spec.trackId, item.spec.startTimelineSec);
            if (!handles)
                return "the clip " + item.bind + " is not in project.get";
            matcher.bindings[item.bind + ".contentId"] = JsonValue::string(handles->contentId);
            matcher.bindings[item.bind + ".placementId"] = JsonValue::string(handles->placementId);
            for (const char* token : {"revision", "gridRevision", "keyRevision"})
                matcher.bindings[item.bind + "." + token] = memberOf(handles->tokens, token);
        }
    }

    std::string failure;
    const auto& without = memberOf(given, "withoutCapabilities");
    if (without.size() != 0) {
        // The request runs against the facts of an instance without the capability (this build reports it).
        const auto request = matcher.substitute(memberOf(vector, "request"), failure);
        if (!failure.empty())
            return failure;
        const auto expected = memberOf(memberOf(memberOf(vector, "response"), "error"), "data");
        const auto reply =
            runWithoutCapabilities(*f.processor, memberOf(f.api.discovery(), "instanceId").text(), request, without);
        if (!reply)
            return "the request did not fail";
        if (reply->kind != memberOf(expected, "kind").text() || reply->reason != memberOf(expected, "reason").text()
            || reply->executed.value_or(false))
            return "expected " + memberOf(expected, "kind").text() + "(" + memberOf(expected, "reason").text()
                   + "), got " + reply->kind + "(" + reply->reason + ")";
        return {};
    }
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
                if (failure.empty() && memberOf(vector, "connectionAfter").text() == "open"
                    && !connection.staysQuiet(kOpenCheckMs))
                    failure = "the connection closed or sent more";
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
    preferences.setExperimentalFeaturesEnabled(false);
    return failure;
}

} // namespace

void scenarioReference()
{
    scenarioReferenceImpl();
}

void scenarioReferenceAnalysisLimit()
{
    scenarioReferenceLimitImpl();
    scenarioReferenceJobChecksImpl();
    scenarioUpstreamServiceLimit();
}

void scenarioReferenceVectors()
{
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root / "content"))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    std::set<std::string> passedIds;
    int skipped = 0;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto id = memberOf(parsed.value, "id").text();
        if (!isReferenceVector(id))
            continue;
        if (const auto reason = referenceVectorSkipReason(parsed.value); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runReferenceVector(parsed.value);
        if (CONTROL_CHECK(failure.empty()))
            passedIds.insert(id);
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    for (const char* id : kMustRunReferenceVectors)
        CONTROL_CHECK(passedIds.count(id) == 1);
    note(std::to_string(passedIds.size()) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace ControlTest
} // namespace OpenTune
