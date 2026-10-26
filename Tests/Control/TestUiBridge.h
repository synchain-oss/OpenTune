// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// A ControlUiBridge for the headless processor tests: reports what a test injects and counts the
// notifications it receives. Later parts of the control API extend it with what their tests need.

#include "Control/ControlUiBridge.h"
#include "PluginProcessor.h"
#include "Utils/ProjectSession.h"

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
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

    // ---- Dialogs and onboarding ----

    std::optional<std::vector<DialogInfo>> openDialogs() const override
    {
        if (!reportsDialogs)
            return std::nullopt;
        return dialogs;
    }
    /** Closes the topmost dialog, as the editor's bridge does, and runs onDialogClosed for it (what closing it
        commits, which the test decides); the modal flag of busy follows the remaining dialogs. */
    bool closeTopDialog() override
    {
        if (dialogs.empty() || dialogs.back().systemFileChooser || refuseClose)
            return false;
        const auto closed = dialogs.back();
        dialogs.pop_back();
        busy.modalOpen = !dialogs.empty();
        closedDialogs.push_back(closed.kind);
        if (onDialogClosed)
            onDialogClosed(closed);
        return true;
    }
    std::optional<bool> onboardingShowing() const override { return onboarding; }
    bool closeOnboarding() override
    {
        if (!onboarding.value_or(false) || !onboardingClosable)
            return false;
        onboarding = false;
        ++onboardingCloses;
        return true;
    }
    std::optional<UiScale> uiScale() const override { return scale; }

    // ---- Workspace ----

    /** What the editor's bridge does (ControlEditorBridgeWorkspace.cpp): the view alone changes, nothing else is
        touched except the tempo that the BPM field rewrites (commitBpmFieldOnViewSwitch()), and a window that shows
        the view already does nothing. A bridge without the switch returns false. */
    bool setWorkspace(bool arrangement) override
    {
        if (!switchesWorkspace)
            return false;
        if (swallowsWorkspaceSwitch)
            return true;
        const std::string target = arrangement ? "arrangement" : "pianoRoll";
        if (view.workspace == target)
            return true;
        ++workspaceSwitches;
        view.workspace = target;
        commitBpmFieldOnViewSwitch();
        return true;
    }

    /** The transport bar's BPM field, as the editor meets it when the view really changes: the switch moves the
        keyboard focus, the focus that leaves the field commits it (BpmValueField::commit shows the tempo with one
        decimal, juce::String(value, 1), and sends that value to OpenTuneAudioProcessorEditor::bpmChanged), and the
        editor sets that tempo and marks the project as changed. The editor's bridge takes the mark back when the tempo
        is what it was (settleViewSwitch), so a tempo with one decimal changes nothing and a tempo with more decimals
        is rewritten and keeps the mark. A test that gives the processor here has the focus in the field; null, the
        default, is a window whose focus is elsewhere, which leaves the tempo alone. A derived bridge that switches the
        view calls this when it does. */
    void commitBpmFieldOnViewSwitch()
    {
        if (bpmFieldProcessor == nullptr)
            return;
        const double before = bpmFieldProcessor->getBpm();
        bpmFieldProcessor->setBpm(juce::String(before, 1).getDoubleValue());
        if (std::abs(bpmFieldProcessor->getBpm() - before) > 1e-9)
            markDirty();
    }

    /** The processor whose tempo the BPM field of commitBpmFieldOnViewSwitch() commits; null: no focus in the field. */
    OpenTuneAudioProcessor* bpmFieldProcessor = nullptr;

    /** setWorkspace(): false is a bridge that cannot switch. */
    bool switchesWorkspace = true;
    /** setWorkspace() answers true and shows another view than asked for, as an editor that did not take the switch. */
    bool swallowsWorkspaceSwitch = false;
    /** The switches setWorkspace() made, in the number of calls that changed the view. */
    int workspaceSwitches = 0;

    /** Injected dialogs, from the bottom of the stack to the top; reportsDialogs false is a bridge without them. */
    std::vector<DialogInfo> dialogs;
    bool reportsDialogs = true;
    /** closeTopDialog() fails, as a dialog that would not close. */
    bool refuseClose = false;
    /** What closing a dialog does in the test (a track-colour dialog: set the track's colour, mark dirty). */
    std::function<void(const DialogInfo&)> onDialogClosed;
    /** The onboarding overlay: showing, not showing, or nullopt for a bridge without it. */
    std::optional<bool> onboarding = false;
    bool onboardingClosable = true;
    std::optional<UiScale> scale = UiScale{};
    /** The kinds closeTopDialog() closed, in order, and the number of closeOnboarding() calls that closed it. */
    std::vector<std::string> closedDialogs;
    int onboardingCloses = 0;
};

} // namespace ControlTest
} // namespace OpenTune
