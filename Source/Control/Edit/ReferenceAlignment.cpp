// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ReferenceAlignment.h"

#include "Content/ContentEditCommands.h"
#include "Content/ContentPatchGeometry.h"
#include "Content/EditableContentSnapshot.h"
#include "DSP/ReferenceAutoAlign.h"
#include "PluginProcessor.h"
#include "Utils/F0Timeline.h"
#include "Utils/PianoRollEditAction.h"
#include "Utils/PitchControlConfig.h"

#include <algorithm>

namespace OpenTune {

namespace {

/** The description of the undo entry, the text OpenTune gives it. */
constexpr const char* kUndoDescription = "AUTO (Ref)";

/** The frames of [startSeconds, endSeconds) on a pitch curve's analysis timeline, nullopt when they hold none
    (the static f0FrameRangeForSeconds() of PluginProcessor.cpp, which is not reachable from here). */
std::optional<F0FrameRange> frameRangeForSeconds(int hopSize, double sampleRate, int frameCount, double startSeconds,
                                                 double endSeconds)
{
    if (endSeconds <= startSeconds || hopSize <= 0 || sampleRate <= 0.0 || frameCount <= 0)
        return std::nullopt;
    const F0Timeline timeline(hopSize, sampleRate, frameCount);
    const double timelineEndSeconds = timeline.timeAtFrame(frameCount);
    if (endSeconds <= 0.0 || startSeconds >= timelineEndSeconds)
        return std::nullopt;
    return timeline.rangeForTimes(startSeconds, endSeconds);
}

bool findPlacement(const StandaloneArrangement& arrangement, std::uint64_t placementId, int& trackId,
                   StandaloneArrangement::Placement& placement)
{
    if (placementId == 0)
        return false;
    for (int track = 0; track < arrangement.getNumTracks(); ++track)
        if (arrangement.getPlacementById(track, placementId, placement)) {
            trackId = track;
            return true;
        }
    return false;
}

ReferenceClipProjection projectionOf(const StandaloneArrangement::Placement& placement)
{
    ReferenceClipProjection projection;
    projection.placementId = placement.placementId;
    projection.contentKey = placement.contentKey;
    projection.timelineStartSeconds = placement.timelineStartSeconds;
    projection.timelineEndSeconds = placement.timelineEndSeconds();
    projection.sourceStartSeconds = placement.clipInSeconds;
    projection.sourceEndSeconds = placement.clipInSeconds + placement.durationSeconds;
    return projection;
}

} // namespace

bool controlReferenceFeaturesCurrent(const OpenTuneAudioProcessor& processor, const EditableContentSnapshot& snapshot)
{
    const auto& features = snapshot.referenceFeatures;
    return features.isReady() && features.producer == processor.getReferenceFeatureProducer()
           && features.inputFingerprint == static_cast<std::int64_t>(snapshot.audioRevision);
}

ControlReferenceAlignment controlAlignToReference(OpenTuneAudioProcessor& processor, std::uint64_t targetPlacementId)
{
    ControlReferenceAlignment outcome;
    using Status = ControlReferenceAlignment::Status;

    const auto* arrangement = processor.getStandaloneArrangement();
    if (targetPlacementId == 0 || arrangement == nullptr) {
        outcome.status = Status::NotReady;
        return outcome;
    }
    int targetTrackId = -1;
    StandaloneArrangement::Placement targetPlacement;
    if (!findPlacement(*arrangement, targetPlacementId, targetTrackId, targetPlacement)) {
        outcome.status = Status::NotReady;
        return outcome;
    }
    // StandaloneArrangement::getPlacementReferencePlacement(): the clip the target is bound to.
    const std::uint64_t referencePlacementId =
        arrangement->getPlacementReferencePlacement(targetTrackId, targetPlacementId);
    int referenceTrackId = -1;
    StandaloneArrangement::Placement referencePlacement;
    if (referencePlacementId == 0 || referencePlacementId == targetPlacementId
        || !findPlacement(*arrangement, referencePlacementId, referenceTrackId, referencePlacement)) {
        outcome.status = Status::NotReady;
        return outcome;
    }

    const double overlapStart = std::max(targetPlacement.timelineStartSeconds, referencePlacement.timelineStartSeconds);
    const double overlapEnd = std::min(targetPlacement.timelineEndSeconds(), referencePlacement.timelineEndSeconds());
    if (overlapEnd <= overlapStart) {
        outcome.status = Status::NoOverlap;
        return outcome;
    }

    // OpenTuneAudioProcessor::getContentSnapshot(): the immutable state the alignment reads.
    const auto targetSnap = processor.getContentSnapshot(targetPlacement.contentKey);
    const auto referenceSnap = processor.getContentSnapshot(referencePlacement.contentKey);
    if (!targetSnap || !referenceSnap) {
        outcome.status = Status::NotReady;
        return outcome;
    }

    // The alignment data must be the current producer's, made from the audio as it is now; the caller's job asks for
    // it first (OpenTuneAudioProcessor::preheatReferenceAlignmentFeatures()), the AUTO button does it when it finds
    // the data missing.
    const ReferenceFeatureSet targetFeatures = targetSnap->referenceFeatures;
    const ReferenceFeatureSet referenceFeatures = referenceSnap->referenceFeatures;
    if (!controlReferenceFeaturesCurrent(processor, *targetSnap)
        || !controlReferenceFeaturesCurrent(processor, *referenceSnap)) {
        outcome.status = Status::NotReady;
        return outcome;
    }

    const auto oldNotes = targetSnap->notes;
    const auto oldCurve = targetSnap->pitchCurve;
    if (oldCurve == nullptr) {
        outcome.status = Status::NotReady;
        return outcome;
    }
    const auto oldSegments = oldCurve->getCorrectionSegments();
    const double targetDurationSeconds = targetSnap->sourceWindow.isValid() ? targetSnap->sourceWindow.durationSeconds()
                                                                            : targetFeatures.sourceDurationSeconds;
    const double referenceDurationSeconds = referenceSnap->sourceWindow.isValid()
                                                ? referenceSnap->sourceWindow.durationSeconds()
                                                : referenceFeatures.sourceDurationSeconds;
    if (!(targetDurationSeconds > 0.0) || !(referenceDurationSeconds > 0.0)) {
        outcome.status = Status::InsufficientFeatures;
        return outcome;
    }

    ReferenceAlignmentRequest request;
    request.target = projectionOf(targetPlacement);
    request.reference = projectionOf(referencePlacement);
    request.targetTimeMap = EffectiveTimeMap::fromTimeGrid(targetSnap->timeGrid, targetDurationSeconds);
    request.referenceTimeMap = EffectiveTimeMap::fromTimeGrid(referenceSnap->timeGrid, referenceDurationSeconds);
    request.targetFeatures = targetFeatures;
    request.referenceFeatures = referenceFeatures;
    request.targetNotesBefore = oldNotes;
    request.overlapStartTimelineSeconds = overlapStart;
    request.overlapEndTimelineSeconds = overlapEnd;

    // ReferenceAutoAlign::align(): the notes after the alignment, from the notes the target has.
    const auto patch = ReferenceAutoAlign::align(request);
    if (!patch.success) {
        switch (patch.error) {
            case AlignmentPatch::ErrorCode::NoOverlap:
                outcome.status = Status::NoOverlap;
                break;
            case AlignmentPatch::ErrorCode::InsufficientFeatures:
                outcome.status = Status::InsufficientFeatures;
                break;
            case AlignmentPatch::ErrorCode::NoMutation:
                outcome.status = Status::NoMutation;
                break;
            case AlignmentPatch::ErrorCode::TargetAnalysisNotReady:
            case AlignmentPatch::ErrorCode::ReferenceAnalysisNotReady:
                outcome.status = Status::NotReady;
                break;
            case AlignmentPatch::ErrorCode::InvalidRequest:
            case AlignmentPatch::ErrorCode::None:
                outcome.status = Status::Failed;
                break;
        }
        return outcome;
    }

    const int hopSize = oldCurve->getHopSize();
    const double pitchSampleRate = oldCurve->getSampleRate();
    const int frameCount = static_cast<int>(oldCurve->getOriginalF0().size());
    if (hopSize <= 0 || pitchSampleRate <= 0.0 || frameCount <= 0) {
        outcome.status = Status::NotReady;
        return outcome;
    }
    const auto affectedFrameRange = frameRangeForSeconds(
        hopSize, pitchSampleRate, frameCount, patch.affectedSourceStartSeconds, patch.affectedSourceEndSeconds);
    if (!affectedFrameRange.has_value() || affectedFrameRange->isEmpty()) {
        outcome.status = Status::NoOverlap;
        return outcome;
    }
    const int affectedStartFrame = affectedFrameRange->startFrame;
    const int affectedEndFrame = affectedFrameRange->endFrameExclusive;

    // PitchCurve::expandNoteBasedCorrectionRange(): the range the correction recomputes around the notes.
    const auto& normalizedNotes = patch.notesAfter;
    const auto correctionRange =
        PitchCurve::expandNoteBasedCorrectionRange(affectedStartFrame, affectedEndFrame, frameCount);
    const ContentEditRangeFrames commitRange{correctionRange.startFrame, correctionRange.endFrameExclusive};
    const double secondsPerFrame = static_cast<double>(hopSize) / pitchSampleRate;
    const double rangeStartSeconds = static_cast<double>(commitRange.startFrame) * secondsPerFrame;
    const double rangeEndSeconds = static_cast<double>(commitRange.endFrameExclusive) * secondsPerFrame;

    // PitchCurve::applyCorrectionToRange(): the corrected pitch curve of the aligned notes, with the default
    // retune speed and vibrato, as the AUTO button applies it.
    auto derivedCurve = PitchCurve::fromSnapshot(oldCurve);
    derivedCurve->applyCorrectionToRange(normalizedNotes, affectedStartFrame, affectedEndFrame,
                                         static_cast<float>(targetSnap->pitchShiftSettings.getPitchRatio()),
                                         PitchControlConfig::kDefaultRetuneSpeedNormalized,
                                         PitchControlConfig::kDefaultVibratoDepth,
                                         PitchControlConfig::kDefaultVibratoRateHz);

    const auto segmentsInRange = clipSegmentsToFrameRange(derivedCurve->copyCorrectionSegments(),
                                                          commitRange.startFrame, commitRange.endFrameExclusive);
    auto beforeNotesScoped = filterNotesToRange(oldNotes, rangeStartSeconds, rangeEndSeconds);
    auto beforeSegmentsScoped =
        clipSegmentsToFrameRange(oldSegments, commitRange.startFrame, commitRange.endFrameExclusive);

    // OpenTuneAudioProcessor::commitContentNotesAndSegments(): the commit, which publishes the new notes and segments.
    const auto commitSnap = processor.commitContentNotesAndSegments(targetPlacement.contentKey, normalizedNotes,
                                                                    segmentsInRange, commitRange);
    if (commitSnap == nullptr) {
        outcome.status = Status::Failed;
        return outcome;
    }
    if (commitSnap->pitchCurve == nullptr) {
        // The commit went through, so the notes changed; only the undo action cannot be built from this snapshot.
        outcome.status = Status::CommittedWithoutUndo;
        return outcome;
    }

    // The undo action the AUTO button pushes, handed to the caller instead.
    ControlOriginAction::Inner inner;
    inner.action = std::make_unique<PianoRollEditAction>(
        processor.getContentCommands(), targetPlacement.contentKey, kUndoDescription, std::move(beforeNotesScoped),
        filterNotesToRange(commitSnap->notes, rangeStartSeconds, rangeEndSeconds), std::move(beforeSegmentsScoped),
        clipSegmentsToFrameRange(commitSnap->pitchCurve->getCorrectionSegments(), commitRange.startFrame,
                                 commitRange.endFrameExclusive),
        commitRange);
    inner.name = "PianoRollEditAction";
    inner.content = targetPlacement.contentKey;
    inner.aspect = ControlContentAspect::NotesAndPitch;
    outcome.actions.push_back(std::move(inner));
    outcome.status = Status::Committed;
    outcome.rangeStartSec = rangeStartSeconds;
    outcome.rangeEndSec = rangeEndSeconds;
    return outcome;
}

} // namespace OpenTune
