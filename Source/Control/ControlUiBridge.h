// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace juce {
class AudioDeviceManager;
class ThreadPool;
} // namespace juce

namespace OpenTune {

class ProjectSession;
struct NoteGeneratorParams;

/**
 * Narrow interface through which the control API reaches what only the Standalone editor owns: the
 * project session and its worker pool, the view, the busy state of the UI, the audio device manager.
 * The processor does not take over any of this (docs/code-architecture-review.md: no new data model in
 * PluginProcessor); the editor implements the interface in a thin adapter and registers it with
 * ControlService::setUiBridge(). Without an editor the pointer is null.
 *
 * Every function has a default that reports "not supported" (an empty optional or nullptr) or does
 * nothing, so that each part of the control API overrides only what it needs, and a missing editor
 * reduces results instead of breaking them. The sections follow the domains of the API.
 *
 * Threading: message thread only, like the editor itself. The owner unregisters the bridge
 * (ControlService::setUiBridge(nullptr)) before destroying it.
 */
class ControlUiBridge
{
public:
    virtual ~ControlUiBridge() = default;

    // ---- Project information ------------------------------------------------------------------

    /** What the editor knows about the open project. */
    struct ProjectInfo
    {
        /** Absolute path of the project file (UTF-8); empty for a project that was never saved. */
        std::string projectPath;
        /** True when the editor shows unsaved changes. */
        bool dirty = false;
    };

    /** The open project as the editor sees it; nullopt when not supported. */
    virtual std::optional<ProjectInfo> projectInfo() const { return std::nullopt; }

    /** Marks the project as changed, as the editor does after its own edits. Default: nothing. */
    virtual void markDirty() {}

    // ---- Busy state ---------------------------------------------------------------------------

    /** Why the UI must not be changed under the user's hands right now (UI priority, PROTOCOL.md section
        13.2): each member is one reason of BUSY. */
    struct BusyState
    {
        /** A mouse or pen gesture is in progress in the editor (pointer_down). */
        bool pointerDown = false;
        /** A modal dialog is open (modal_open). */
        bool modalOpen = false;
        /** The editor runs a project save or open of its own (project_operation). */
        bool operationRunning = false;
        /** An import started in the editor is running or queued (import_in_progress). */
        bool importRunning = false;
        /** An export started in the editor is running (export_in_progress). */
        bool exportRunning = false;
    };

    /** The busy state; nullopt when not supported (the control API then cannot tell). */
    virtual std::optional<BusyState> queryBusy() const { return std::nullopt; }

    // ---- Notifications after changes made through the control API -----------------------------

    /** Tracks or placements were added, removed or moved. Default: nothing. */
    virtual void onStructureChanged() {}

    /** An undo or redo step was applied through the control API: the editor does what it does after its own
        undo or redo (marks the project as changed, redraws the arrangement, refreshes derived state).
        Default: nothing. */
    virtual void onUndoRedoApplied() {}

    /** A project was opened or the project was reloaded: the editor does what it does after its own open (updates the
        recent-projects menu and the title, refreshes the track panel, the arrangement, the piano roll and the
        reference context from the new project). Default: nothing. */
    virtual void onProjectReloaded() {}

    /** The project was saved to its file (project.save, project.saveAs): the editor does what it does after its own
        save (updates the recent-projects menu and the window title). Default: nothing. */
    virtual void onProjectSaved() {}

    /** The list of recent projects changed through the control API (project.clearRecent): the editor refreshes its
        recent-projects menu. Default: nothing. */
    virtual void onRecentProjectsChanged() {}

    // ---- Project operations ---------------------------------------------------------------------

    /** Sets or clears the editor's own flag of a running project save or open, which the editor's file commands check
        before they start (and answer with their "another project operation is running" message) and which
        queryBusy() reports as BusyState::operationRunning. A project job of the control API sets it for its
        whole run. Default: nothing. */
    virtual void setProjectOperationRunning(bool /*running*/) {}

    /** The time grid of a content was changed through the control API (content.shiftTiming,
        content.editTimeGrid): the editor does what it does after its own time-grid edit (the piano roll takes
        the new grid of the content it shows and redraws) and redraws the arrangement, which draws clips through
        their grids. Default: nothing. */
    virtual void onTimeGridChanged() {}

    // ---- View changes that a write makes as the UI does ----------------------------------------

    /** Shows a placement the way the editor does after its own import: it becomes the active track's
        selected placement and the piano roll shows its content. Returns false when not supported. */
    virtual bool focusPlacement(int /*trackId*/, std::uint64_t /*placementId*/) { return false; }

    /** Makes the arrangement show at least count track slots, as the editor does when an import fills
        tracks beyond the visible ones. Returns false when not supported. */
    virtual bool revealTracks(int /*count*/) { return false; }

    /** The note generation parameters the editor would use for an AUTO or for the notes of an import
        right now. Returns false, leaving out unchanged, when not supported. */
    virtual bool currentNoteGenerationParams(NoteGeneratorParams& /*out*/) const { return false; }

    // ---- View ---------------------------------------------------------------------------------

    /** The parts of the view that results report. */
    struct ViewState
    {
        /** Name of the visible workspace, for example "arrangement" or "pianoRoll". */
        std::string workspace;
        /** Placement shown in the piano roll; 0 when none. */
        std::uint64_t pianoRollPlacementId = 0;
    };

    /** The view; nullopt when not supported. */
    virtual std::optional<ViewState> viewState() const { return std::nullopt; }

    /** The placements selected in the arrangement, in the editor's order; nullopt when not supported. */
    virtual std::optional<std::vector<std::uint64_t>> selectedPlacementIds() const { return std::nullopt; }

    /** Number of tracks the arrangement shows; nullopt when not supported. */
    virtual std::optional<int> visibleTrackCount() const { return std::nullopt; }

    // ---- Objects owned by the editor ----------------------------------------------------------

    /** The editor's project session; nullptr when not supported. */
    virtual ProjectSession* projectSession() { return nullptr; }

    /** The worker pool the editor uses for project operations; nullptr when not supported. */
    virtual juce::ThreadPool* projectWorkerPool() { return nullptr; }

    // ---- Audio device -------------------------------------------------------------------------

    /** The Standalone application's audio device manager; nullptr when not supported. */
    virtual juce::AudioDeviceManager* audioDevice() { return nullptr; }

    // ---- Preferences and audio device ---------------------------------------------------------

    /** The shared preferences were changed through the control API (prefs.set): the editor applies them the way it
        does after its own preferences window changed one (OpenTuneAudioProcessorEditor::syncSharedAppPreferences),
        which it also does on its heartbeat. Default: nothing. */
    virtual void onPreferencesChanged() {}

    /** Whether the editor has applied the editing scheme to its views (the piano roll, the parameter panel, the
        layout): the notes-primary scheme (openDyne) when notesPrimary is true. nullopt when not supported, in
        which case the control API takes the scheme as applied once the preference is set. */
    virtual std::optional<bool> editingSchemeApplied(bool /*notesPrimary*/) const { return std::nullopt; }

    /** What the audio settings page does before it closes an ASIO device for another device type or output
        device (restoreAsioSampleRateToSystem): returns false when a required restore could not be verified, in
        which case the change must not go on and the current device stays. Default: true (nothing to restore). */
    virtual bool prepareAudioDeviceSwitch(const std::string& /*reason*/) { return true; }
};

} // namespace OpenTune
