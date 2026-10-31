// SPDX-License-Identifier: AGPL-3.0-or-later
#include "TimeGridOps.h"

#include "Content/ContentEditCommands.h"
#include "PluginProcessor.h"
#include "Utils/LocalizationManager.h"
#include "Utils/TimeGridEditAction.h"

#include <algorithm>
#include <cmath>

namespace OpenTune {

namespace {

/** A handle counts as clamped when it ends further than this from its requested time (the uniform distance of a
    group move is computed from the leading handle, which can differ from deltaSec in the last bits). */
constexpr double kClampToleranceSec = 1e-9;

/** juce::jlimit(lower, upper, value) as the time tool limits a handle; nullopt when lower > upper (no room). */
std::optional<double> limit(double lower, double upper, double value)
{
    if (!(lower <= upper))
        return std::nullopt;
    return std::min(std::max(value, lower), upper);
}

/** The second pass of the time tool's group drag (PianoRollToolHandler::handleTimeToolMouseDrag): from left to
    right, each inner handle limited to its limited left neighbour plus the spacing and its right neighbour minus
    the spacing. False when a handle has no room; the time tool then keeps the grid as it was. */
bool limitInOrder(std::vector<double>& outputs)
{
    for (std::size_t i = 1; i + 1 < outputs.size(); ++i) {
        const auto limited = limit(outputs[i - 1] + TimeGridOps::kMinSpacingSec,
                                   outputs[i + 1] - TimeGridOps::kMinSpacingSec, outputs[i]);
        if (!limited)
            return false;
        outputs[i] = *limited;
    }
    return true;
}

std::optional<std::size_t> indexOf(const std::vector<TimeHandle>& handles, std::uint64_t id)
{
    for (std::size_t i = 1; i + 1 < handles.size(); ++i)
        if (handles[i].id == id)
            return i;
    return std::nullopt;
}

/** The plan of the new output times (one per handle of the grid), or of no change when room is false. */
TimeGridOps::Plan finish(const std::shared_ptr<const TimeGridSnapshot>& grid, const std::vector<double>& outputs,
                         const std::vector<std::optional<double>>& requested, bool room)
{
    TimeGridOps::Plan plan;
    plan.before = grid;
    const auto& handles = grid->handles();
    std::vector<TimeHandle> next(handles.begin(), handles.end());
    bool changed = false;
    if (room) {
        for (std::size_t i = 0; i < next.size(); ++i) {
            changed = changed || outputs[i] != handles[i].output_seconds;
            next[i].output_seconds = outputs[i];
        }
    }
    // TimeGridSnapshot::makeFromHandles(): the validation every grid of the time tool passes; a grid it rejects
    // is not applied, as the time tool keeps its last valid grid then.
    if (changed)
        plan.after = TimeGridSnapshot::makeFromHandles(next);
    const bool applied = plan.after != nullptr;
    for (std::size_t i = 1; i + 1 < handles.size(); ++i) {
        TimeGridOps::HandleResult result;
        result.handleId = handles[i].id;
        result.index = i - 1;
        result.contentSec = handles[i].source_seconds;
        result.beforeOutputSec = handles[i].output_seconds;
        result.afterOutputSec = applied ? outputs[i] : handles[i].output_seconds;
        result.requestedOutputSec = requested[i];
        if (result.requestedOutputSec || result.moved())
            plan.handles.push_back(result);
    }
    return plan;
}

std::vector<double> currentOutputs(const std::vector<TimeHandle>& handles)
{
    std::vector<double> outputs;
    outputs.reserve(handles.size());
    for (const auto& handle : handles)
        outputs.push_back(handle.output_seconds);
    return outputs;
}

} // namespace

bool TimeGridOps::HandleResult::clamped() const noexcept
{
    return requestedOutputSec && std::abs(afterOutputSec - *requestedOutputSec) > kClampToleranceSec;
}

std::vector<TimeHandle> TimeGridOps::innerHandles(const TimeGridSnapshot& grid)
{
    std::vector<TimeHandle> inner;
    for (const auto& handle : grid.handles())
        if (!handle.isEndpoint())
            inner.push_back(handle);
    return inner;
}

bool TimeGridOps::isSeeded(const TimeGridSnapshot* grid)
{
    if (grid == nullptr)
        return false;
    const auto& handles = grid->handles();
    return std::any_of(handles.begin(), handles.end(), [](const TimeHandle& handle) { return !handle.isEndpoint(); });
}

std::string TimeGridOps::handleIdText(std::uint64_t id)
{
    return std::to_string(id);
}

std::optional<std::uint64_t> TimeGridOps::findInnerHandle(const TimeGridSnapshot& grid, const std::string& handleId)
{
    for (const auto& handle : grid.handles())
        if (!handle.isEndpoint() && handleIdText(handle.id) == handleId)
            return handle.id;
    return std::nullopt;
}

TimeGridOps::Plan TimeGridOps::planShift(const std::shared_ptr<const TimeGridSnapshot>& grid, double startOutputSec,
                                         double endOutputSec, double deltaSec)
{
    const auto& handles = grid->handles();
    auto outputs = currentOutputs(handles);
    std::vector<std::optional<double>> requested(handles.size());
    std::vector<std::size_t> section;
    for (std::size_t i = 1; i + 1 < handles.size(); ++i)
        if (handles[i].output_seconds >= startOutputSec && handles[i].output_seconds <= endOutputSec) {
            section.push_back(i);
            requested[i] = handles[i].output_seconds + deltaSec;
        }
    if (section.empty() || deltaSec == 0.0)
        return finish(grid, outputs, requested, true);

    // First pass: the dragged handle, limited by its neighbours as they are (handleTimeToolMouseDrag's
    // clampedOutput). The handle that leads in the direction of the move stops the section at its neighbour.
    const std::size_t lead = deltaSec > 0.0 ? section.back() : section.front();
    const auto limited =
        limit(outputs[lead - 1] + kMinSpacingSec, outputs[lead + 1] - kMinSpacingSec, outputs[lead] + deltaSec);
    if (!limited)
        return finish(grid, outputs, requested, false);
    if (section.size() == 1) {
        outputs[lead] = *limited;
        return finish(grid, outputs, requested, true);
    }
    // A group drag: every handle of the section moves by the distance the dragged handle was allowed
    // (uniformDelta), then the second pass.
    const double uniformDelta = *limited - handles[lead].output_seconds;
    for (const auto i : section)
        outputs[i] = handles[i].output_seconds + uniformDelta;
    const bool room = limitInOrder(outputs);
    return finish(grid, outputs, requested, room);
}

TimeGridOps::Plan TimeGridOps::planMoves(const std::shared_ptr<const TimeGridSnapshot>& grid,
                                         const std::vector<Move>& moves)
{
    const auto& handles = grid->handles();
    auto outputs = currentOutputs(handles);
    std::vector<std::optional<double>> requested(handles.size());
    std::vector<std::size_t> moved;
    for (const auto& move : moves)
        if (const auto index = indexOf(handles, move.handleId)) {
            requested[*index] = move.outputSec;
            moved.push_back(*index);
        }
    if (moved.empty())
        return finish(grid, outputs, requested, true);

    if (moved.size() == 1) {
        // The time tool's drag of one handle: limited by its neighbours, which stay.
        const auto i = moved.front();
        const auto limited = limit(outputs[i - 1] + kMinSpacingSec, outputs[i + 1] - kMinSpacingSec, *requested[i]);
        if (!limited)
            return finish(grid, outputs, requested, false);
        outputs[i] = *limited;
        return finish(grid, outputs, requested, true);
    }

    // First pass: each moved handle limited by its neighbours as they are requested to be. A handle whose
    // requested neighbours leave it no room is left to the second pass.
    std::vector<double> targets = outputs;
    for (const auto i : moved)
        targets[i] = *requested[i];
    auto limitedOutputs = targets;
    for (const auto i : moved)
        if (const auto limited = limit(targets[i - 1] + kMinSpacingSec, targets[i + 1] - kMinSpacingSec, targets[i]))
            limitedOutputs[i] = *limited;
    const bool room = limitInOrder(limitedOutputs);
    return finish(grid, limitedOutputs, requested, room);
}

juce::String TimeGridOps::moveDescription()
{
    return LOC_RAW("Drag time handle");
}

std::optional<ControlOriginAction::Inner> TimeGridOps::commit(OpenTuneAudioProcessor& processor, const ContentKey& key,
                                                              const Plan& plan, const juce::String& description)
{
    if (plan.before == nullptr || plan.after == nullptr || !key.isValid())
        return std::nullopt;
    // The processor's ContentEditCommands, the instance the piano roll's commitTimeGrid uses.
    auto commands = processor.getContentCommands();
    if (commands == nullptr)
        return std::nullopt;
    auto action = std::make_unique<TimeGridEditAction>(commands, key, description, plan.before, plan.after);
    if (!commands->setTimeGrid(key, plan.after))
        return std::nullopt;
    ControlOriginAction::Inner inner;
    inner.action = std::move(action);
    inner.name = "TimeGridEditAction";
    inner.content = key;
    inner.aspect = ControlContentAspect::TimeGrid;
    return inner;
}

} // namespace OpenTune
