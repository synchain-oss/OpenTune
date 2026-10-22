// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "OpsRegistry.h"

namespace OpenTune {

/**
 * The track methods of capability tracks.v1, on the message thread, through the arrangement and the editor's
 * bridge. OpenTune identifies a track by its position only ("Track N") and has a fixed number of slots, of which
 * the editor shows the first few; the others are hidden and may hold clips.
 * - track.set (methods/track.set.schema.json): mute, solo, volume (dB or linear, limited to the volume knob's range
 *   of 0 to 4, with the warning CLAMPED) and colour of tracks, as the track panel's controls set them
 *   (trackMuteToggled, trackSoloToggled, trackVolumeChanged; the colour is set directly, without the colour dialog).
 *   As in the UI there is no undo entry (ui_parity); the revert recipe sets the previous values of the members that
 *   changed. The project is marked as changed. Soloing changes which other tracks are audible, which the result
 *   lists for every track.
 * - track.add (methods/track.add.schema.json): shows count more track slots, as the + button does
 *   (TrackPanelComponent::showMoreTracks). The number of shown tracks is view state: not saved with the project
 *   (NOT_PERSISTED), no undo entry (not_persisted_state), the project is not marked as changed. The context menu's
 *   "Add Track" of the same panel (trackAddRequested) does mark the project as changed; the + button is the one the
 *   schema follows.
 * - track.duplicate (methods/track.duplicate.schema.json): the steps of the track menu's Duplicate Track
 *   (trackDuplicateRequested): mute, solo, volume and colour and a copy of every clip go to the first hidden slot,
 *   which is then shown. Mode share inserts the clips with the same contents, as OpenTune does (SHARED_CONTENT);
 *   mode clone first gives every clip a content of its own (OpenTuneAudioProcessor::cloneContent(), the function the
 *   clip duplicate of the arrangement uses). A clip waiting to be reclaimed (isRetired) is not copied. No undo entry
 *   (ui_parity); the revert recipe deletes the new track and needs the end user's consent.
 * - track.delete (methods/track.delete.schema.json): the steps of the track menu's Delete Track
 *   (trackDeleteRequested): StandaloneArrangement::removeTrackAndShift() removes the track's clips and moves every
 *   later shown track down, then the panel and the arrangement show one track fewer. Hidden slots keep their
 *   position, their clips and their mix. It cannot be undone (no_upstream_undo, IRREVERSIBLE) and needs confirm; the
 *   only shown track and hidden tracks cannot be deleted.
 *   A clip of another track whose reference binding named a removed clip loses the binding (the UI leaves it
 *   dangling) and is listed in danglingReferences. The deletion is a barrier in the undo and redo histories
 *   (ControlHistory::onTrackDeleted(), PROTOCOL.md section 15.3 rule 6): an entry that addresses the deleted track or
 *   a shown track after it is possibly stale, while an entry that addresses only hidden tracks stays valid, since
 *   those keep their position. The barrier renumbers the shown tracks it moves down, so a later deletion compares
 *   them with where their clips are then. OpenTune does not retire the contents of
 *   the removed clips (it leaks them); the control API reports a content that no clip shows any more as removed
 *   (ControlHistory::markContentsRemoved()) and does not repair the leak.
 *
 * Every write checks, in the order of PROTOCOL.md section 13.1: the trackId, the busy state, the expected arrangement
 * revision, then the method's own validation. The methods that change the number of shown tracks need the editor
 * (UNSUPPORTED(capability_missing) without one).
 */
void registerTrackOps(ControlMethodTable& table);

} // namespace OpenTune
