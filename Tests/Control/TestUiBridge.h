// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// A ControlUiBridge for the headless processor tests: reports what a test injects and counts the
// notifications it receives. Later parts of the control API extend it with what their tests need.

#include "Control/ControlUiBridge.h"
#include "Utils/ProjectSession.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <utility>
#include <vector>

namespace OpenTune {
namespace ControlTest {

/** Message thread only, like a real bridge. */
class TestUiBridge : public ControlUiBridge
{
public:
    std::optional<ProjectInfo> projectInfo() const override
    {
        if (session == nullptr)
            return project;
        // With a project session, the session is the truth, as in the editor.
        ProjectInfo info;
        if (session->hasProjectPath())
            info.projectPath = session->getCurrentProjectFile().getFullPathName().toStdString();
        info.dirty = session->isDirty();
        return info;
    }
    void markDirty() override
    {
        ++dirtyMarks;
        project.dirty = true;
        if (session != nullptr)
            session->markDirty();
    }

    std::optional<BusyState> queryBusy() const override { return busy; }

    void onStructureChanged() override { ++structureChanges; }
    void onUndoRedoApplied() override { ++undoRedoNotifications; }
    void onProjectReloaded() override { ++projectReloads; }
    void onProjectSaved() override { ++projectSaves; }
    void onRecentProjectsChanged() override { ++recentProjectChanges; }
    void setProjectOperationRunning(bool running) override
    {
        busy.operationRunning = running;
        operationFlagChanges.push_back(running);
    }
    ProjectSession* projectSession() override { return session; }
    juce::ThreadPool* projectWorkerPool() override { return pool; }
    void onTimeGridChanged() override { ++timeGridNotifications; }

    bool focusPlacement(int trackId, std::uint64_t placementId) override
    {
        focused.emplace_back(trackId, placementId);
        return true;
    }
    bool revealTracks(int count) override
    {
        ++revealCalls;
        visibleTracks = std::max(visibleTracks, count);
        return true;
    }

    std::optional<ViewState> viewState() const override { return view; }
    std::optional<std::vector<std::uint64_t>> selectedPlacementIds() const override { return selection; }
    std::optional<int> visibleTrackCount() const override { return visibleTracks; }

    /** Injected state. */
    ProjectInfo project;
    BusyState busy;
    ViewState view;
    std::vector<std::uint64_t> selection;
    int visibleTracks = 1;
    /** The project session and its worker pool, as the editor owns them; null for a test without a project. */
    ProjectSession* session = nullptr;
    juce::ThreadPool* pool = nullptr;

    /** Counters of the calls received. */
    int dirtyMarks = 0;
    int structureChanges = 0;
    int undoRedoNotifications = 0;
    int projectReloads = 0;
    int projectSaves = 0;
    int recentProjectChanges = 0;
    /** The values setProjectOperationRunning() was called with, in order. */
    std::vector<bool> operationFlagChanges;
    int timeGridNotifications = 0;
    int revealCalls = 0;
    /** The placements focusPlacement() was called with, in order. */
    std::vector<std::pair<int, std::uint64_t>> focused;
};

} // namespace ControlTest
} // namespace OpenTune
