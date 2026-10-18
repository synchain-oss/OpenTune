// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "Control/ControlUiBridge.h"

namespace OpenTune {

class OpenTuneAudioProcessorEditor;

/**
 * The Standalone editor's side of ControlUiBridge: a thin adapter that reads the editor's own state and
 * calls the editor's own functions, and adds no behaviour of its own. It is a friend of
 * OpenTuneAudioProcessorEditor (the editor's hook in Source/Standalone/PluginEditor.h, see
 * Source/Control/README.md#hooks), so that the editor keeps its members private.
 *
 * Lifecycle: the editor creates it at the end of its constructor, which registers it with the processor's
 * ControlService, and destroys it first in its destructor, which unregisters it; the control API therefore
 * never reaches an editor that is being built or torn down. With the control API not enabled at run time
 * the service never starts and never calls the bridge.
 *
 * ControlEditorBridge.cpp covers the general part (project information, busy state, structure changes, the steps
 * after an undo or redo, the refresh after a time-grid edit, the view, the import focus, objects the editor owns);
 * ControlEditorBridgeProject.cpp the project flows (the steps after a save or an open, the recent projects, the flag
 * of a running project operation); dialogs, tracks and preferences follow in files of their own
 * (ControlEditorBridge<Domain>.cpp).
 *
 * Threading: message thread, like the editor.
 */
class ControlEditorBridge final : public ControlUiBridge
{
public:
    explicit ControlEditorBridge(OpenTuneAudioProcessorEditor& editor);
    ~ControlEditorBridge() override;

    ControlEditorBridge(const ControlEditorBridge&) = delete;
    ControlEditorBridge& operator=(const ControlEditorBridge&) = delete;

    std::optional<ProjectInfo> projectInfo() const override;
    void markDirty() override;
    std::optional<BusyState> queryBusy() const override;
    void onStructureChanged() override;
    void onUndoRedoApplied() override;
    void onTimeGridChanged() override;
    void onProjectReloaded() override;
    void onProjectSaved() override;
    void onRecentProjectsChanged() override;
    void setProjectOperationRunning(bool running) override;
    bool focusPlacement(int trackId, std::uint64_t placementId) override;
    bool revealTracks(int count) override;
    bool currentNoteGenerationParams(NoteGeneratorParams& out) const override;
    std::optional<ViewState> viewState() const override;
    std::optional<std::vector<std::uint64_t>> selectedPlacementIds() const override;
    std::optional<int> visibleTrackCount() const override;
    ProjectSession* projectSession() override;
    juce::ThreadPool* projectWorkerPool() override;
    juce::AudioDeviceManager* audioDevice() override;

    // ---- Tracks and transport (ControlEditorBridgeTracks.cpp) ----
    bool setVisibleTrackCount(int count) override;
    void onTrackMixChanged() override;
    void onTransportChanged() override;
    void onTempoChanged() override;
    // ---- Dialogs and onboarding (ControlEditorBridgeModals.cpp) ----
    std::optional<std::vector<DialogInfo>> openDialogs() const override;
    bool closeTopDialog() override;
    std::optional<bool> onboardingShowing() const override;
    bool closeOnboarding() override;
    std::optional<UiScale> uiScale() const override;

    // ---- Preferences and audio device (ControlEditorBridgePrefs.cpp) ----
    void onPreferencesChanged() override;
    std::optional<bool> editingSchemeApplied(bool notesPrimary) const override;
    bool prepareAudioDeviceSwitch(const std::string& reason) override;

private:
    /** The placement the arrangement selects on its active track, or 0. */
    std::uint64_t activeSelection() const;

    OpenTuneAudioProcessorEditor& editor_;
};

} // namespace OpenTune
