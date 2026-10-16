// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// A ControlUiBridge for the headless processor tests: reports what a test injects and counts the
// notifications it receives. Later parts of the control API extend it with what their tests need.

#include "Control/ControlUiBridge.h"

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
    std::optional<ProjectInfo> projectInfo() const override { return project; }
    void markDirty() override
    {
        ++dirtyMarks;
        project.dirty = true;
    }

    std::optional<BusyState> queryBusy() const override { return busy; }

    void onStructureChanged() override { ++structureChanges; }
    void onUndoRedoApplied() override { ++undoRedoNotifications; }
    void onProjectReloaded() override { ++projectReloads; }
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

    /** Counters of the calls received. */
    int dirtyMarks = 0;
    int structureChanges = 0;
    int undoRedoNotifications = 0;
    int projectReloads = 0;
    int timeGridNotifications = 0;
    int revealCalls = 0;
    /** The placements focusPlacement() was called with, in order. */
    std::vector<std::pair<int, std::uint64_t>> focused;
};

} // namespace ControlTest
} // namespace OpenTune
