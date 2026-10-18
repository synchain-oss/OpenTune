// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "ControlOriginAction.h"

#include <cstdint>
#include <vector>

namespace OpenTune {

class OpenTuneAudioProcessor;

/** The outcome of controlAlignToReference(). */
struct ControlReferenceAlignment
{
    enum class Status {
        /** The alignment was committed; `actions` holds its one undo action. */
        Committed,
        /** The reference gave nothing to change (OpenTune's AlignmentPatch::ErrorCode::NoMutation); nothing was
            committed. */
        NoMutation,
        /** The two clips share no time, or the shared time maps to no frame of the target's pitch curve. */
        NoOverlap,
        /** The alignment has no pitch notes to work with (no reference notes, or the target has no notes). */
        InsufficientFeatures,
        /** A placement, a content or the alignment data of one of them is not there (any more). */
        NotReady,
        /** OpenTune did not commit the patch, or the request was invalid. */
        Failed
    };

    Status status = Status::Failed;
    /** Committed: the committed range on the content's analysis timeline, in content seconds. */
    double rangeStartSec = 0.0;
    double rangeEndSec = 0.0;
    /** Committed: the PianoRollEditAction of the commit, for a ControlOriginAction (aspect NotesAndPitch). */
    std::vector<ControlOriginAction::Inner> actions;
};

/**
 * Aligns the pitch of the target placement's content to the clip the placement has a reference binding to, the way the
 * AUTO button does for such a clip (OpenTuneAudioProcessor::executeReferenceAlignmentForPlacement()), except that the
 * undo action is handed back instead of being pushed on the UndoManager, so that the caller can make it part of one
 * ControlOriginAction. It does not start any analysis: both contents must already have alignment data of the current
 * producer (Status::NotReady otherwise).
 *
 * The steps follow the upstream function line by line (it is registered as a mirror, see MIRRORS.md): the overlap of
 * the two clips on the timeline, ReferenceAutoAlign::align(), the affected frame range, the corrected pitch curve for
 * that range, commitContentNotesAndSegments(), and a PianoRollEditAction described "AUTO (Ref)" over the committed
 * range.
 *
 * Threading: message thread only.
 */
ControlReferenceAlignment controlAlignToReference(OpenTuneAudioProcessor& processor, std::uint64_t targetPlacementId);

} // namespace OpenTune
