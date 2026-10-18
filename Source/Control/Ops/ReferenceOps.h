// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "OpsRegistry.h"
#include "OpsSupport.h"

#include <cstdint>
#include <optional>
#include <string>

namespace OpenTune {

/**
 * The reference alignment of capability reference.v1, on the message thread:
 * - content.analyzeReference (methods/content.analyzeReference.schema.json) computes the alignment data of a clip's
 *   reference binding as a job of kind referenceAnalysis: the job asks OpenTune for the alignment features of the
 *   clip and of the clip it is bound to (OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures(), what the editor
 *   asks for when such a clip is selected), waits for them, and reports {placementId, referencePlacementId,
 *   alignmentReady}. It changes no edit and has no undo entry. A call for a placement whose analyzeReference job is
 *   not terminal returns that job.
 * - the job of content.autoTune in mode reference (controlStartReferenceAlignJob()) first does the same, then aligns
 *   the content in one undo step (Edit/ReferenceAlignment.h).
 *
 * Both jobs check on every step that the placement still exists, that it still has the same reference binding and
 * that both pitch analyses are ready; a job that fails stores nothing it has not stored before and changes no note.
 * The aligning job also compares the tokens the call checked (expectedRevision, and expectedKeyRevision when given)
 * with the content's current ones in the step that commits, just before it aligns (PROTOCOL.md section 10 rule 3):
 * a change made while the job waited fails it with REVISION_CONFLICT. The alignment data that the job waits for is
 * no such change: OpenTune stores it in the content's referenceFeatures alone, which neither token covers.
 * They are cancellable until the alignment is committed; cancelling stops the wait, it cannot withdraw an analysis
 * that OpenTune already started (the data it produces is stored as it is when the editor asks for it).
 *
 * Known OpenTune behaviour: the reference analysis service completes only one synchronous (StandardAuto) analysis per
 * session, so a binding whose two contents both lack alignment data cannot be completed (see Source/Control/README.md).
 * The jobs do not wait for ever: after the wait limit they end with NOT_READY.
 */
void registerReferenceOps(ControlMethodTable& table);

/** A reference binding with both ends resolved: the target placement and the clip it is bound to, each with its
    content. */
struct ControlReferenceBinding
{
    ControlPlacementRef target;
    ControlPlacementRef reference;
    ControlContentRef targetContent;
    ControlContentRef referenceContent;
};

/**
 * Resolves the reference binding of a live placement for a job or for the call that starts one, in this order:
 * the placement is live (else NOT_FOUND(unknown_handle)); it has a reference binding, and, when
 * expectedReferencePlacementId is given, still the same one (else INVALID_ARGUMENT(reference_not_bound)); the clip it
 * is bound to is live (else NOT_FOUND(unknown_handle)); both pitch analyses are ready (else NOT_READY with the reason
 * of the readiness gate). Message thread.
 */
Result<ControlReferenceBinding>
controlResolveReferenceBinding(ControlOpContext& context, std::uint64_t targetPlacementId,
                               std::optional<std::uint64_t> expectedReferencePlacementId);

/** The tokens a content.autoTune call checked, which its job compares again before it commits: the content the call
    named, its revision and, when the call gave one, its key revision. */
struct ControlReferenceExpectedTokens
{
    std::string contentId;
    std::string revision;
    std::optional<std::string> keyRevision;
};

/**
 * Hands the work of content.autoTune in mode reference to a job of kind referenceAnalysis: computing the alignment data
 * the binding lacks, then aligning the content in one undo step. expected holds the tokens the call has just checked;
 * the job compares them again with the content's current tokens in the step that commits, and fails with
 * REVISION_CONFLICT (content_changed, or key_changed) when they differ, changing nothing. Returns the job reference
 * ({jobId, kind, state}) for the write envelope's handedToJob(); changes nothing itself. BUSY(job_limit) when every
 * retained job is active. Message thread.
 */
Result<JsonValue> controlStartReferenceAlignJob(ControlOpContext& context, const ControlReferenceBinding& binding,
                                                ControlReferenceExpectedTokens expected);

/** Test seam for the headless tests: the longest time a referenceAnalysis job waits for OpenTune's alignment
    analysis (120 s); 0 restores it. Read again at every wait step. Never used by OpenTune itself. Message thread. */
void controlSetReferenceWaitLimitForTesting(int milliseconds);

} // namespace OpenTune
