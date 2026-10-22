// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

namespace OpenTune {

class ControlMethodTable;

/**
 * Registers ui.setSelection (capability ui.bridge; methods/ui.setSelection.schema.json), the third method of ui.bridge
 * after ui.getState and ui.dismiss (UiOps.h).
 *
 * The call selects through the editor (ControlUiBridge::select()) as the arrangement view does when the user clicks: a
 * placementId makes that clip the only selected clip and its track the active track, as a click on it does; openEditor
 * also opens it in the piano roll, as a double click does; a trackId makes that track the active track with no clip
 * selected and the piano roll empty. Without an editor the call answers UNSUPPORTED(no_editor_window).
 *
 * Selecting can change more than the selection, as a click does, and the result reports what the call observed:
 * - notesGenerated (warnings SELECTION_GENERATED_NOTES and IRREVERSIBLE, the project marked as changed): in the
 * openDyne scheme the piano roll generates the notes of the clip it shows when they were never generated and its pitch
 *   analysis is ready (PianoRollComponent::ensureOpenDyneNotesIfNeeded, called by setEditedContentAndProjection when
 *   the piano roll gets another clip), with no undo entry;
 * - referenceAnalysisQueued (warning REFERENCE_ANALYSIS_QUEUED): the editor refreshes its reference context
 *   (OpenTuneAudioProcessorEditor::refreshReferenceContext), which asks for the reference alignment data of the clip
 *   and of the clip it is bound to (preheatReferenceAlignmentFeatures) when the clip has a binding, experimental
 *   features are on and the openTune scheme is applied (evaluateAutoRefUiState reports no binding in openDyne);
 * - uiScaleChanged: the transport bar shows the clip's key (applyResolvedScaleForPlacementContent);
 * - workspaceSwitched: openEditor switched from the arrangement to the piano roll (placementDoubleClicked).
 *
 * The call predicts these effects from the same state first; dryRun returns the prediction and changes nothing, the
 * selection included. A committed call reports what happened; a difference from the prediction is logged. The
 * selection is view state: the undo reason is not_persisted_state, and the revert recipe selects the active track and
 * its selected clip from before the call with ui.setSelection (never taking back notes or switching the window back).
 * Selecting what is already selected, with no other effect, is a no-op. The busy checks of PROTOCOL.md section 13.2
 * apply, also to dryRun.
 */
void registerSelectionOps(ControlMethodTable& table);

} // namespace OpenTune
