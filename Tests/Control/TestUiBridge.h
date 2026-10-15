// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// A ControlUiBridge for the headless processor tests: reports what a test injects and counts the
// notifications it receives. Later parts of the control API extend it with what their tests need.

#include "Control/ControlUiBridge.h"

#include <optional>

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

    std::optional<int> visibleTrackCount() const override { return visibleTracks; }

    /** Injected state. */
    ProjectInfo project;
    BusyState busy;
    int visibleTracks = 1;

    /** Counters of the calls received. */
    int dirtyMarks = 0;
    int structureChanges = 0;
    int undoRedoNotifications = 0;
    int projectReloads = 0;
};

} // namespace ControlTest
} // namespace OpenTune
