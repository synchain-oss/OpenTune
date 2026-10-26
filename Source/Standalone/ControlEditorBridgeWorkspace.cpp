// SPDX-License-Identifier: AGPL-3.0-or-later
// The workspace of the editor's side of ControlUiBridge: ui.setWorkspace (Control/Ops/WorkspaceOps.cpp) switches the
// window between the arrangement view and the piano roll as the two view buttons of the transport bar do. Only the
// view changes; the editor's viewToggled() moves the timeline camera, the visibility and the keyboard focus of the two
// views and runs the piano roll's heartbeat tick (the camera of the first F0 frame and the waveform cache), and never
// touches a content, a key, a note, a clip or a track. The one exception is upstream behaviour that is not corrected
// here and that the operation reports (Control/Ops/WorkspaceOps.cpp): the keyboard focus that leaves the transport
// bar's BPM field commits the field, which rewrites a tempo with more than one decimal (see settleViewSwitch()).
#include "ControlEditorBridge.h"

#include "PluginEditor.h"

namespace OpenTune {

ControlEditorBridge::ViewSwitchBaseline ControlEditorBridge::viewSwitchBaseline() const
{
    ViewSwitchBaseline baseline;
    baseline.dirty = editor_.projectSession_.isDirty();
    baseline.bpm = editor_.processorRef_.getBpm();
    baseline.timeSignatureNumerator = editor_.processorRef_.getTimeSigNumerator();
    baseline.timeSignatureDenominator = editor_.processorRef_.getTimeSigDenominator();
    return baseline;
}

void ControlEditorBridge::settleViewSwitch(const ViewSwitchBaseline& baseline)
{
    // viewToggled() moves the keyboard focus, and the focus that the transport bar's BPM field loses then commits the
    // field (BpmValueField::commit -> TransportBarComponent::onBpmChanged -> OpenTuneAudioProcessorEditor::bpmChanged),
    // which sets the tempo the field shows (the processor's tempo with one decimal) and marks the project as changed
    // even when nothing was typed. A view switch leaves the project as it was (PROTOCOL.md section 15.2 rule 6), so the
    // mark is taken back when the project was unchanged before and the tempo and the time signature are what they were:
    // then the mark came from that commit, with nothing to save. A tempo or time signature that did change (a tempo
    // with more decimals that the field rewrote, or a value typed into the field and not committed yet) is a real
    // change and keeps the mark; the operation reports the rewritten tempo from the processor's tempo before and after.
    if (!baseline.dirty && editor_.projectSession_.isDirty() && editor_.processorRef_.getBpm() == baseline.bpm
        && editor_.processorRef_.getTimeSigNumerator() == baseline.timeSignatureNumerator
        && editor_.processorRef_.getTimeSigDenominator() == baseline.timeSignatureDenominator)
        editor_.projectSession_.clearDirty();
}

bool ControlEditorBridge::setWorkspace(bool arrangement)
{
    // The window shows the view already: what a click on the button of the view shown does (it only re-asserts the
    // toggle state of the button).
    if (editor_.isWorkspaceView_ == arrangement)
        return true;

    const auto baseline = viewSwitchBaseline();
    // TransportBarComponent::onTrackViewClicked() / onPianoViewClicked(): the button state, then the listener, which
    // is the editor. The editor's own Escape handler (escapeKeyPressed) makes the same two calls.
    editor_.transportBar_.setWorkspaceView(arrangement);
    editor_.viewToggled(arrangement);
    settleViewSwitch(baseline);
    return true;
}

} // namespace OpenTune
