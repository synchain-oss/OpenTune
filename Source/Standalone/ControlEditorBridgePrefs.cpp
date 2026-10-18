// SPDX-License-Identifier: AGPL-3.0-or-later
// The preferences and the audio device of the editor's side of ControlUiBridge:
// what the editor does around a change of the shared preferences or of the
// audio setup that the control API makes through AppPreferences and the device
// manager itself (Control/Ops/PrefsOps.cpp, Control/Ops/AudioDeviceOps.cpp).
#include "ControlEditorBridge.h"

#include "PluginEditor.h"
#include "StandaloneAudioDeviceSync.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_gui_basics/juce_gui_basics.h>
// After the modules it uses, as in PluginEditor.cpp.
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>

namespace OpenTune {

void ControlEditorBridge::onPreferencesChanged()
{
    // OpenTuneAudioProcessorEditor::syncSharedAppPreferences(): the call that
    // every preference page of the editor makes after one of its controls changed
    // a preference, and that the editor's heartbeat repeats; it hands the
    // preferences to the piano roll, the parameter panel, the arrangement and the
    // menu bar.
    editor_.syncSharedAppPreferences();
}

std::optional<bool> ControlEditorBridge::editingSchemeApplied(bool notesPrimary) const
{
    // appliedAudioEditingScheme_ is what syncSharedAppPreferences() last handed
    // to the views.
    return AudioEditingScheme::usesNotesPrimaryScheme(editor_.appliedAudioEditingScheme_) == notesPrimary;
}

bool ControlEditorBridge::prepareAudioDeviceSwitch(const std::string& reason)
{
    // restoreAsioSampleRateToSystem(): the audio settings page calls it before it
    // closes an ASIO device for another type or output device. Without the
    // Standalone holder there is no device manager to restore.
    auto* holder = juce::StandalonePluginHolder::getInstance();
    return holder == nullptr || restoreAsioSampleRateToSystem(holder->deviceManager, juce::String(reason));
}

} // namespace OpenTune
