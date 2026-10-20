// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ReferenceOps.h"

#include "EditSupport.h"
#include "OpsSupport.h"
#include "WriteEnvelope.h"

#include "Content/EditableContentSnapshot.h"
#include "Control/ControlJobs.h"
#include "Control/Edit/ControlOriginAction.h"
#include "Control/Edit/ReferenceAlignment.h"
#include "PluginProcessor.h"

#include <chrono>

namespace OpenTune {

namespace {

/** How long a referenceAnalysis job waits for OpenTune's alignment analysis before it gives up. */
constexpr int kReferenceWaitLimitMs = 120000;
/** changes lists at most this many entries (methods/content.autoTune.schema.json). */
constexpr std::size_t kMaxListedEntries = 200;
/** The description of the undo entry, the text OpenTune gives the AUTO button's reference alignment. */
constexpr const char* kUndoDescription = "AUTO (Ref)";
constexpr const char* kJobKind = "referenceAnalysis";

/** The wait limit that the tests set (controlSetReferenceWaitLimitForTesting); 0 for kReferenceWaitLimitMs. */
int& waitLimitOverrideMs()
{
    static int milliseconds = 0;
    return milliseconds;
}

ControlJobError jobErrorOf(const Error& error)
{
    // The checks of the job's steps return errors built by controlOpError / controlOpErrorAfterChange.
    const auto reply = controlMapError(error);
    return {reply.kind, reply.reason, reply.detail, reply.executed.value_or(false)};
}

/** The session cannot complete the analysis any more: OpenTune's reference analysis worker takes no second
    synchronous job (its active job stays engaged after the first completion), so only a restart can analyze again. */
ControlJobError stalledError()
{
    return {"NOT_READY", "reference_analysis_stalled",
            "OpenTune's reference analysis service completed its one synchronous analysis of this session; restart "
            "OpenTune to analyze again",
            false};
}

/** The analysis is still running: the job waited past its limit while the worker could still take jobs. */
ControlJobError analysisTimeoutError()
{
    return {"NOT_READY", "reference_analysis_timeout",
            "OpenTune's reference analysis did not finish within the wait limit; it is still running, so the request "
            "can be retried",
            false};
}

/** OpenTune's reference analysis failed or found nothing to align with. */
ControlJobError analysisFailedError(const char* detail)
{
    return {"ANALYSIS_FAILED", "reference_analysis_failed", detail, false};
}

Result<JsonValue> startJob(ControlOpContext& context, ControlJobWork work, const std::string& digest)
{
    auto* jobs = context.jobs();
    if (jobs == nullptr)
        return controlOpError("INTERNAL", "", "the jobs registry is not available");
    const auto started = jobs->start(kJobKind, true, std::move(work), {}, digest);
    if (started.jobId.empty())
        return started.refusal == "job_limit"
                   ? controlOpError("BUSY", "job_limit", "every retained job is still active")
                   : controlOpError("SHUTTING_DOWN", "", "the control API is stopping");
    return jobs->jobRef(started.jobId);
}

/** Whether a content has alignment data of the producer this instance uses, made from its audio as it is now
    (what content.getDetails reports as reference.alignmentReady, and what the AUTO button needs). */
bool alignmentDataCurrent(OpenTuneAudioProcessor& processor, const EditableContentSnapshot& snapshot)
{
    const auto& features = snapshot.referenceFeatures;
    return features.isReady() && features.producer == processor.getReferenceFeatureProducer()
           && features.inputFingerprint == static_cast<std::int64_t>(snapshot.audioRevision);
}

JsonValue analysisResultJson(ControlOpContext& context, const ControlReferenceBinding& binding)
{
    auto result = JsonValue::object();
    result.appendMember("placementId", JsonValue::string(binding.target.placementId));
    result.appendMember("referencePlacementId", JsonValue::string(binding.reference.placementId));
    result.appendMember(
        "alignmentReady",
        JsonValue::boolean(alignmentDataCurrent(context.processor(), *binding.targetContent.snapshot)
                           && alignmentDataCurrent(context.processor(), *binding.referenceContent.snapshot)));
    return result;
}

/**
 * The work of a referenceAnalysis job, on the message thread, one step per tick:
 *
 * - every step resolves the binding again (controlResolveReferenceBinding): the placement still exists, still has the
 *   same reference binding, and both pitch analyses are ready; the first step of an aligning job and the commit also
 *   check the busy state (that job writes);
 * - it asks for the alignment data of both contents (OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures(), which
 *   does nothing while the analysis runs or is ready) and waits for them; an analysis that failed ends the job with
 *   ANALYSIS_FAILED(reference_analysis_failed), and after the wait limit it ends with
 *   NOT_READY(reference_analysis_timeout);
 * - OpenTune's reference analysis service completes only one synchronous analysis per session: workerLoop() moves its
 *   finished job out of activeJob and leaves the optional engaged (ReferenceAnalysisService.cpp, the moved-from
 *   activeJob), so it takes no second one. The processor's read-only isReferenceAnalysisWorkerStalled() records that
 *   first completion. Once it is set and a content still lacks its data, no analysis can finish: the job ends at once
 *   with NOT_READY(reference_analysis_stalled) instead of waiting for a result that never comes. A binding whose both
 *   contents already have data is unaffected;
 * - an analysis job then reports the binding; an aligning job compares the tokens its call checked with the content's
 *   current ones, then aligns the content (controlAlignToReference()) in one undo step and reports the write envelope.
 *
 * Cancellation is possible until the alignment is committed; nothing is written before that.
 */
class ReferenceJob
{
public:
    /** expected: the tokens of an aligning job's call; nullopt for an analysis job, which writes nothing. */
    ReferenceJob(ControlOpEnvironment environment, bool align, std::uint64_t placementId,
                 std::uint64_t referencePlacementId, std::optional<ControlReferenceExpectedTokens> expected)
        : environment_(std::move(environment))
        , align_(align)
        , placementId_(placementId)
        , referencePlacementId_(referencePlacementId)
        , expected_(std::move(expected))
        , started_(std::chrono::steady_clock::now())
    {}

    void step(ControlJobStep& step)
    {
        ControlOpContext context(environment_);
        if (step.cancelRequested()) {
            step.cancel();
            return;
        }
        auto resolved = controlResolveReferenceBinding(context, placementId_, referencePlacementId_);
        if (!resolved.ok()) {
            step.fail(jobErrorOf(resolved.error()));
            return;
        }
        const auto binding = std::move(resolved).value();
        if (align_ && firstStep_) {
            // The check the call made, made again when the job runs.
            if (const auto busy = controlCheckBusy(context)) {
                step.fail(jobErrorOf(*busy));
                return;
            }
        }
        firstStep_ = false;

        auto& processor = context.processor();
        // Before asking for anything: a worker that completed its one synchronous analysis takes no other job, so a
        // content that still lacks data can only be analyzed after a restart. A recorded failure of the analysis is
        // reported as such; otherwise the wait is skipped instead of running to its limit.
        const bool targetCurrent = alignmentDataCurrent(processor, *binding.targetContent.snapshot);
        const bool referenceCurrent = alignmentDataCurrent(processor, *binding.referenceContent.snapshot);
        if (!(targetCurrent && referenceCurrent)) {
            const auto failed = [&processor](const ControlContentRef& content) {
                const auto& features = content.snapshot->referenceFeatures;
                return features.status == ReferenceFeatureStatus::Failed
                       && features.producer == processor.getReferenceFeatureProducer()
                       && features.inputFingerprint == static_cast<std::int64_t>(content.snapshot->audioRevision);
            };
            if (failed(binding.targetContent) || failed(binding.referenceContent)) {
                step.fail(analysisFailedError("OpenTune's reference analysis of a content failed"));
                return;
            }
            if (processor.isReferenceAnalysisWorkerStalled()) {
                step.fail(stalledError());
                return;
            }
        }

        int ready = 0;
        bool pending = false;
        for (const auto* content : {&binding.targetContent, &binding.referenceContent}) {
            // OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures(): the alignment features of a content,
            // requested once and reported while they are made.
            switch (processor.preheatReferenceAlignmentFeatures(content->key)) {
                case OpenTuneAudioProcessor::ReferenceAnalysisPreheatStatus::AlreadyReady:
                    ++ready;
                    break;
                case OpenTuneAudioProcessor::ReferenceAnalysisPreheatStatus::Queued:
                case OpenTuneAudioProcessor::ReferenceAnalysisPreheatStatus::WaitingForSource:
                    pending = true;
                    break;
                case OpenTuneAudioProcessor::ReferenceAnalysisPreheatStatus::InvalidContent:
                    // The binding was resolved from the live arrangement just above; a content that is gone now is
                    // the same unknown handle.
                    step.fail({"NOT_FOUND", "unknown_handle", "the content of a clip does not exist any more", false});
                    return;
                case OpenTuneAudioProcessor::ReferenceAnalysisPreheatStatus::AnalysisFailed:
                    step.fail(analysisFailedError("OpenTune's reference analysis of a content failed"));
                    return;
            }
        }
        if (pending) {
            wait(step, ready);
            return;
        }
        if (!align_) {
            step.succeed(analysisResultJson(context, binding));
            return;
        }
        commit(context, step, binding);
    }

private:
    void wait(ControlJobStep& step, int ready)
    {
        const int limitMs = waitLimitOverrideMs() > 0 ? waitLimitOverrideMs() : kReferenceWaitLimitMs;
        if (std::chrono::steady_clock::now() - started_ >= std::chrono::milliseconds(limitMs)) {
            // The worker can still take jobs (the stalled case was answered in step()), so the analysis is merely
            // slower than the limit: waiting longer, or retrying, can still finish it.
            step.fail(analysisTimeoutError());
            return;
        }
        step.setProgress(std::nullopt, "analysing", ready, 2);
    }

    /**
     * REVISION_CONFLICT(content_changed) when the placement no longer shows the content the call named or that
     * content's revision differs from the one the call checked, then REVISION_CONFLICT(key_changed) for the key
     * revision when the call gave one (controlCheckExpectedTokens()); nullopt when they match, and for an analysis job.
     * The tokens come from the snapshot this step read (controlContentVersions()). The alignment data the job waited
     * for is no change: OpenTune stores it in the content's referenceFeatures alone, which only the reference
     * component of the revision vector covers, not the revision or the key revision.
     */
    std::optional<Error> expectedTokensConflict(ControlOpContext& context, const ControlContentRef& content) const
    {
        if (!expected_)
            return std::nullopt;
        if (content.contentId != expected_->contentId)
            return controlOpError("REVISION_CONFLICT", "content_changed",
                                  "the placement shows another content than the one the call named; read it again");
        return controlCheckExpectedTokens(controlContentVersions(context, content.contentId, *content.snapshot),
                                          expected_->revision, expected_->keyRevision);
    }

    static void appendMembers(JsonValue& result, std::size_t before, std::size_t after, std::size_t omittedChanges)
    {
        auto omittedCount = JsonValue::object();
        omittedCount.appendMember("changes", JsonValue::integer(static_cast<std::int64_t>(omittedChanges)));
        omittedCount.appendMember("created", JsonValue::integer(0));
        omittedCount.appendMember("removed", JsonValue::integer(0));
        result.appendMember("omittedCount", std::move(omittedCount));
        result.appendMember("mode", JsonValue::string("reference"));
        result.appendMember("keyUsed", JsonValue());
        result.appendMember("paramsUsed", JsonValue());
        auto noteCount = JsonValue::object();
        noteCount.appendMember("before", JsonValue::integer(static_cast<std::int64_t>(before)));
        noteCount.appendMember("after", JsonValue::integer(static_cast<std::int64_t>(after)));
        result.appendMember("noteCount", std::move(noteCount));
    }

    /** Aligns the content and ends the job with the write envelope (the members of content.autoTune's result). */
    void commit(ControlOpContext& context, ControlJobStep& step, const ControlReferenceBinding& binding)
    {
        if (const auto busy = controlCheckBusy(context)) {
            step.fail(jobErrorOf(*busy));
            return;
        }
        auto history = context.history();
        if (history == nullptr) {
            step.fail({"INTERNAL", "", "the undo history of the control API is not available", false});
            return;
        }
        // From here on the alignment is committed: the job can no longer be cancelled.
        if (!step.endCancellability()) {
            step.cancel();
            return;
        }
        auto& processor = context.processor();
        const auto& content = binding.targetContent;
        // PROTOCOL.md section 10 rule 3: the tokens the call checked, compared again in the message-thread step that
        // aligns, just before the alignment. A change made while the job waited is a conflict; nothing is written.
        if (const auto conflict = expectedTokensConflict(context, content)) {
            step.fail(jobErrorOf(*conflict));
            return;
        }
        const auto beforeNotes = content.snapshot->notes;
        const auto beforeWorld = controlCaptureWorldVersions(context);
        ControlWriteEnvelope envelope(context);
        envelope.touchContent(content.contentId);
        envelope.limitDiffToTouchedContents();

        auto aligned = controlAlignToReference(processor, placementId_);
        using Status = ControlReferenceAlignment::Status;
        switch (aligned.status) {
            case Status::NoMutation: {
                // The reference gives nothing to change: a successful no-op, as for any write that changes nothing.
                auto result = envelope.committed(context);
                appendMembers(result, beforeNotes.size(), beforeNotes.size(), 0);
                step.succeed(std::move(result));
                return;
            }
            case Status::NoOverlap:
                step.fail({"INVALID_ARGUMENT", "reference_ineligible",
                           "the clip and its reference clip share no time to align", false});
                return;
            case Status::InsufficientFeatures:
                step.fail(analysisFailedError("OpenTune's reference analysis found no pitch notes to align with"));
                return;
            case Status::NotReady:
                // The data the job waited for is not current any more. If the worker is stalled it can never be
                // recomputed in this session; otherwise the analysis is still the one that can be retried.
                if (processor.isReferenceAnalysisWorkerStalled())
                    step.fail(stalledError());
                else
                    step.fail({"NOT_READY", "reference_analysis_timeout",
                               "the alignment data of the binding is not current any more; the analysis can be retried",
                               false});
                return;
            case Status::Failed:
                step.fail(analysisFailedError("OpenTune did not commit the alignment"));
                return;
            case Status::Committed:
                break;
        }

        const juce::String description = kUndoDescription;
        const auto undoId = history->nextUndoId(context.instanceShort());
        auto action = std::make_unique<ControlOriginAction>(history, undoId, description, std::move(aligned.actions));
        const auto names = action->innerActionNames();
        // UndoManager::addAction(), as OpenTune pushes the entry of the AUTO button; it discards the redo history.
        processor.getUndoManager().addAction(std::move(action));
        envelope.setUndoable(undoId, description.toStdString(), names);
        // The editor marks the project as changed after the button's AUTO; the committed pitch is saved with it.
        controlMarkDirty(context);

        // The result reports the notes as OpenTune stored them, read back (the alignment keeps their number).
        auto read = controlReadCommittedNotes(context, content, beforeNotes.size());
        if (!read.ok()) {
            step.fail(jobErrorOf(read.error()));
            return;
        }
        auto committed = std::move(read).value();
        const auto omittedChanges = controlListNoteChanges(envelope, content.contentId, beforeNotes, committed.notes,
                                                           committed.revision, kMaxListedEntries);
        controlAddReRenderQueued(envelope, beforeWorld, controlCaptureWorldVersions(context));
        auto result = envelope.committed(context);
        appendMembers(result, beforeNotes.size(), committed.notes.size(), omittedChanges);
        step.succeed(std::move(result));
    }

    ControlOpEnvironment environment_;
    bool align_;
    std::uint64_t placementId_;
    std::uint64_t referencePlacementId_;
    std::optional<ControlReferenceExpectedTokens> expected_;
    std::chrono::steady_clock::time_point started_;
    bool firstStep_ = true;
};

// ---- content.analyzeReference ------------------------------------------------------------------------

struct AnalyzeParams
{
    ControlHandle placementId;
};

/** methods/content.analyzeReference.schema.json $defs.params. */
bool parseAnalyze(const JsonValue& params, AnalyzeParams& out, std::string& why)
{
    ControlParamReader reader(params);
    std::optional<ControlHandle> placementId;
    if (!reader.onlyMembers({"placementId"})
        || !reader.optionalHandle("placementId", ControlHandleKind::Placement, placementId)) {
        why = reader.why();
        return false;
    }
    if (!placementId) {
        reader.fail("placementId is required");
        why = reader.why();
        return false;
    }
    out.placementId = *placementId;
    return true;
}

Result<JsonValue> runAnalyze(ControlOpContext& context, const AnalyzeParams& params)
{
    auto* jobs = context.jobs();
    if (jobs == nullptr)
        return controlOpError("INTERNAL", "", "the jobs registry is not available");
    auto placement = controlResolvePlacement(context, params.placementId);
    if (!placement.ok())
        return placement.error();
    const auto& target = placement.value();
    auto binding = controlResolveReferenceBinding(context, target.placement.placementId, std::nullopt);
    if (!binding.ok())
        return binding.error();

    // A call for a placement whose analyzeReference job is not terminal returns that job. The digest is not the one
    // of any other method, so a job that content.autoTune started is never returned (PROTOCOL.md section 12.1).
    const std::string digest = "analyzeReference:" + target.placementId;
    if (const auto existing = jobs->findActiveByDigest(kJobKind, digest); !existing.empty()) {
        auto result = JsonValue::object();
        result.appendMember("job", jobs->jobRef(existing));
        return result;
    }
    auto job = std::make_shared<ReferenceJob>(context.environment(), false, target.placement.placementId,
                                              binding.value().reference.placement.placementId, std::nullopt);
    auto ref = startJob(context, [job](ControlJobStep& step) { job->step(step); }, digest);
    if (!ref.ok())
        return ref.error();
    auto result = JsonValue::object();
    result.appendMember("job", std::move(ref).value());
    return result;
}

} // namespace

Result<ControlReferenceBinding>
controlResolveReferenceBinding(ControlOpContext& context, std::uint64_t targetPlacementId,
                               std::optional<std::uint64_t> expectedReferencePlacementId)
{
    ControlReferenceBinding binding;
    bool foundTarget = false;
    const auto placements = controlLivePlacements(context);
    for (const auto& placement : placements)
        if (placement.placement.placementId == targetPlacementId) {
            binding.target = placement;
            foundTarget = true;
        }
    if (!foundTarget)
        return controlOpError("NOT_FOUND", "unknown_handle", "the placement does not exist any more");

    // StandaloneArrangement::getPlacementReferencePlacement(): the clip the placement is bound to, 0 for none.
    const auto* arrangement = context.processor().getStandaloneArrangement();
    const std::uint64_t referenceId =
        arrangement != nullptr ? arrangement->getPlacementReferencePlacement(binding.target.trackId, targetPlacementId)
                               : 0;
    if (referenceId == 0 || referenceId == targetPlacementId
        || (expectedReferencePlacementId && *expectedReferencePlacementId != referenceId))
        return controlOpError("INVALID_ARGUMENT", "reference_not_bound",
                              "the placement has no reference binding, or not the one the call saw");
    bool foundReference = false;
    for (const auto& placement : placements)
        if (placement.placement.placementId == referenceId) {
            binding.reference = placement;
            foundReference = true;
        }
    if (!foundReference)
        return controlOpError("NOT_FOUND", "unknown_handle", "the reference clip does not exist any more");

    const auto contentOf = [&context](const ControlPlacementRef& placement) {
        ControlContentRef content;
        content.key = placement.placement.contentKey;
        content.contentId = controlContentId(context, content.key);
        content.snapshot = controlLiveSnapshot(context, content.key);
        return content;
    };
    binding.targetContent = contentOf(binding.target);
    binding.referenceContent = contentOf(binding.reference);
    if (binding.targetContent.snapshot == nullptr || binding.referenceContent.snapshot == nullptr)
        return controlOpError("NOT_FOUND", "unknown_handle", "the content of a clip does not exist any more");
    if (auto notReady = controlCheckContentReady(context, binding.targetContent))
        return *notReady;
    if (auto notReady = controlCheckContentReady(context, binding.referenceContent))
        return *notReady;
    return binding;
}

Result<JsonValue> controlStartReferenceAlignJob(ControlOpContext& context, const ControlReferenceBinding& binding,
                                                ControlReferenceExpectedTokens expected)
{
    auto job = std::make_shared<ReferenceJob>(context.environment(), true, binding.target.placement.placementId,
                                              binding.reference.placement.placementId, std::move(expected));
    return startJob(context, [job](ControlJobStep& step) { job->step(step); }, {});
}

void registerReferenceOps(ControlMethodTable& table)
{
    table.add(controlReadMethod<AnalyzeParams>("content.analyzeReference", parseAnalyze, runAnalyze));
}

void controlSetReferenceWaitLimitForTesting(int milliseconds)
{
    waitLimitOverrideMs() = milliseconds > 0 ? milliseconds : 0;
}

} // namespace OpenTune
