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

    /** Why the UI must not be changed under the user's hands right now (UI priority). */
    struct BusyState
    {
        /** A mouse or pen gesture is in progress in the editor. */
        bool pointerDown = false;
        /** A modal dialog is open. */
        bool modalOpen = false;
        /** The editor runs an import, export or project operation of its own. */
        bool operationRunning = false;
    };

    /** The busy state; nullopt when not supported (the control API then cannot tell). */
    virtual std::optional<BusyState> queryBusy() const { return std::nullopt; }

    // ---- Notifications after changes made through the control API -----------------------------

    /** Tracks or placements were added, removed or moved. Default: nothing. */
    virtual void onStructureChanged() {}

    /** An undo or redo was applied. Default: nothing. */
    virtual void onUndoRedoApplied() {}

    /** A project was opened or the project was reloaded. Default: nothing. */
    virtual void onProjectReloaded() {}

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
};

} // namespace OpenTune
