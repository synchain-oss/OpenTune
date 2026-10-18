// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "OpsRegistry.h"

namespace OpenTune {

/**
 * The transport methods of capability transport.v1, on the message thread, through the processor's Standalone
 * transport (OpenTuneAudioProcessor::play, pause, stop, pauseAtPosition, setPosition, setLoopEnabled, setBpm and
 * setTimeSignature, the functions the editor's transport bar calls):
 * - transport.control (methods/transport.control.schema.json): play, pause, stop, seek, playFromLastStart and
 *   pauseAtLastStart. play, pause, stop and seek do what the transport bar and the piano roll's playhead do
 *   (playRequested, pauseRequested, stopRequested, playheadPositionChangeRequested); playFromLastStart and
 *   pauseAtLastStart are the two halves of the play-from-start button (playFromStartToggleRequested). "Last start"
 *   is the position of the last play or seek (the processor's play start position), not 0: play and seek set it,
 *   and so does a seek made in the UI. Each call is recorded as the last transport call
 *   (OpenTuneAudioProcessor::recordControlCall), which transport.get reports as lastControl. The transport commands
 *   are carried out by the audio callback, a block later; the result reports the position that stop and
 *   pauseAtLastStart are about to give it when an audio device runs. Without a running device the position does not
 *   advance and the audio callback never carries a command out, so play and playFromLastStart carry the warning
 *   NO_AUDIO_DEVICE. The play state and the position are view state: the undo reason is not_persisted_state, there
 *   is no revert recipe and no IRREVERSIBLE warning, and the project is not marked as changed.
 * - transport.setTempo (methods/transport.setTempo.schema.json): the tempo and the time signature of the project.
 *   As the transport bar's fields do (bpmChanged, timeSignatureChanged), there is no undo entry (reason ui_parity);
 *   the revert recipe sets the previous values. The values are saved with the project, so it is marked as changed.
 * - transport.setLoop (methods/transport.setLoop.schema.json): the loop flag. OpenTune Standalone has no loop
 *   range, so the flag has no audible effect (LOOP_NO_EFFECT_STANDALONE when it is turned on); it is not saved with
 *   the project (NOT_PERSISTED), which is not marked as changed.
 *
 * Every write checks the busy state first (PROTOCOL.md section 13.2). The editor is told through
 * ControlUiBridge::onTransportChanged() and onTempoChanged().
 */
void registerTransportOps(ControlMethodTable& table);

} // namespace OpenTune
