// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ControlOriginAction.h"

#include "Utils/PianoRollEditAction.h"
#include "Utils/PianoRollNotePatchAction.h"
#include "Utils/PitchShiftEditAction.h"
#include "Utils/PlacementActions.h"
#include "Utils/ScissorsUndoAction.h"
#include "Utils/TimeGridEditAction.h"
#include "Utils/VolumeEnvelopeEditAction.h"

#include <algorithm>

namespace OpenTune {

// ---- ControlOriginAction ----------------------------------------------------------------------------

ControlOriginAction::ControlOriginAction(std::shared_ptr<ControlHistory> history, std::string undoId,
                                         juce::String description, std::vector<Inner> inner)
    : history_(std::move(history))
    , undoId_(std::move(undoId))
    , description_(std::move(description))
    , inner_(std::move(inner))
{
    if (history_ != nullptr)
        history_->add(this);
}

ControlOriginAction::~ControlOriginAction()
{
    if (history_ != nullptr)
        history_->remove(this);
}

void ControlOriginAction::undo()
{
    for (auto it = inner_.rbegin(); it != inner_.rend(); ++it)
        if (it->action != nullptr && !masked(*it))
            it->action->undo();
}

void ControlOriginAction::redo()
{
    for (auto& inner : inner_)
        if (inner.action != nullptr && !masked(inner))
            inner.action->redo();
}

std::vector<std::string> ControlOriginAction::innerActionNames() const
{
    std::vector<std::string> names;
    for (const auto& inner : inner_)
        names.push_back(inner.name);
    return names;
}

bool ControlOriginAction::unsafe() const
{
    return std::any_of(inner_.begin(), inner_.end(), [](const Inner& inner) {
        return inner.action != nullptr && controlIsUnsafeUndoAction(*inner.action);
    });
}

void ControlOriginAction::mask(const ContentKey& content, ControlContentAspect aspect)
{
    const bool touches = std::any_of(inner_.begin(), inner_.end(), [&](const Inner& inner) {
        return inner.content == content && inner.aspect == aspect;
    });
    if (touches && std::find(masked_.begin(), masked_.end(), std::make_pair(content, aspect)) == masked_.end())
        masked_.emplace_back(content, aspect);
}

bool ControlOriginAction::masked(const Inner& inner) const
{
    return std::find(masked_.begin(), masked_.end(), std::make_pair(inner.content, inner.aspect)) != masked_.end();
}

// ---- ControlHistory ---------------------------------------------------------------------------------

std::string ControlHistory::nextUndoId(const std::string& instanceShort)
{
    return "u:" + instanceShort + ":" + std::to_string(nextSeq_++);
}

ControlHistory::Observation ControlHistory::observe(const UndoManager& manager)
{
    // UndoManager::size(), cursor(), peekUndo() and peekRedo(): the read hook on OpenTune's history.
    return {manager.size(), manager.cursor(), manager.peekUndo(), manager.peekRedo()};
}

void ControlHistory::prune(const UndoManager& manager, std::uint64_t epoch)
{
    // Opening a project clears OpenTune's history (ProjectSession::commitPreparedOpen) and starts a new
    // content epoch; an entry beyond the history's end left it.
    if (epoch_ != epoch) {
        uiEntries_.clear();
        lastObserved_.reset();
    }
    epoch_ = epoch;
    // A full history that changed since it was last observed may have dropped its oldest entry
    // (UndoManager::addAction() at its capacity), which moves every entry down by one position; that
    // position may now hold another entry, also one that took the memory of a dropped one. The positions of
    // UI entries can no longer be confirmed, so their undoIds are forgotten.
    const auto now = observe(manager);
    if (now.size >= kUndoHistoryCapacity && lastObserved_ != now)
        uiEntries_.clear();
    lastObserved_ = now;
    uiEntries_.erase(std::remove_if(uiEntries_.begin(), uiEntries_.end(),
                                    [&manager](const UiEntry& entry) { return entry.index >= manager.size(); }),
                     uiEntries_.end());
}

void ControlHistory::noteOwnStep(const UndoManager& manager)
{
    lastObserved_ = observe(manager);
}

const ControlHistory::UiEntry* ControlHistory::findUiEntry(const UndoAction& action, int index) const
{
    for (const auto& entry : uiEntries_)
        if (entry.action == &action && entry.index == index && entry.type == std::type_index(typeid(action))
            && entry.description == action.getDescription())
            return &entry;
    return nullptr;
}

ControlHistory::Entry ControlHistory::describe(const UndoManager& manager, const UndoAction& action, int index,
                                               std::uint64_t epoch)
{
    prune(manager, epoch);
    Entry entry;
    entry.description = action.getDescription();
    if (const auto* origin = dynamic_cast<const ControlOriginAction*>(&action)) {
        entry.undoId = origin->undoId();
        entry.control = true;
        entry.unsafe = origin->unsafe();
        return entry;
    }
    entry.unsafe = controlIsUnsafeUndoAction(action);
    if (const auto* known = findUiEntry(action, index))
        entry.undoId = known->undoId;
    return entry;
}

std::string ControlHistory::assignUndoId(const UndoManager& manager, const UndoAction& action, int index,
                                         std::uint64_t epoch, const std::string& instanceShort)
{
    const auto entry = describe(manager, action, index, epoch);
    if (entry.undoId)
        return *entry.undoId;
    UiEntry known;
    known.action = &action;
    known.index = index;
    known.type = std::type_index(typeid(action));
    known.description = action.getDescription();
    known.undoId = nextUndoId(instanceShort);
    uiEntries_.push_back(known);
    return known.undoId;
}

void ControlHistory::onChangeWithoutEntry(UndoManager& manager, const ContentKey& content, ControlContentAspect aspect)
{
    for (auto* action : actions_)
        action->mask(content, aspect);
    // UndoManager::clearRedo() (hook): discards the entries after the cursor, as addAction() does.
    manager.clearRedo();
}

void ControlHistory::add(ControlOriginAction* action)
{
    actions_.push_back(action);
}

void ControlHistory::remove(ControlOriginAction* action)
{
    actions_.erase(std::remove(actions_.begin(), actions_.end(), action), actions_.end());
}

// ---- Undo actions of OpenTune -------------------------------------------------------------------------

bool controlIsUnsafeUndoAction(const UndoAction& action)
{
    // After these, OpenTune's reclaim sweep frees objects their undo needs (PROTOCOL.md section 15.4 rule 1).
    return dynamic_cast<const SplitPlacementAction*>(&action) != nullptr
           || dynamic_cast<const MergePlacementAction*>(&action) != nullptr
           || dynamic_cast<const DeletePlacementAction*>(&action) != nullptr;
}

std::string controlUndoActionName(const UndoAction& action)
{
    if (dynamic_cast<const PianoRollEditAction*>(&action) != nullptr)
        return "PianoRollEditAction";
    if (dynamic_cast<const PianoRollNotePatchAction*>(&action) != nullptr)
        return "PianoRollNotePatchAction";
    if (dynamic_cast<const PitchShiftEditAction*>(&action) != nullptr)
        return "PitchShiftEditAction";
    if (dynamic_cast<const TimeGridEditAction*>(&action) != nullptr)
        return "TimeGridEditAction";
    if (dynamic_cast<const ScissorsUndoAction*>(&action) != nullptr)
        return "ScissorsUndoAction";
    if (dynamic_cast<const VolumeEnvelopeEditAction*>(&action) != nullptr)
        return "VolumeEnvelopeEditAction";
    if (dynamic_cast<const SplitPlacementAction*>(&action) != nullptr)
        return "SplitPlacementAction";
    if (dynamic_cast<const MergePlacementAction*>(&action) != nullptr)
        return "MergePlacementAction";
    if (dynamic_cast<const DeletePlacementAction*>(&action) != nullptr)
        return "DeletePlacementAction";
    if (dynamic_cast<const MultiMovePlacementAction*>(&action) != nullptr)
        return "MultiMovePlacementAction";
    if (dynamic_cast<const GainChangeAction*>(&action) != nullptr)
        return "GainChangeAction";
    if (dynamic_cast<const TrimPlacementAction*>(&action) != nullptr)
        return "TrimPlacementAction";
    if (dynamic_cast<const FadeChangeAction*>(&action) != nullptr)
        return "FadeChangeAction";
    if (dynamic_cast<const ReferenceBindingAction*>(&action) != nullptr)
        return "ReferenceBindingAction";
    return "UndoAction";
}

} // namespace OpenTune
