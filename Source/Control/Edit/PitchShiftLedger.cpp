// SPDX-License-Identifier: AGPL-3.0-or-later
#include "PitchShiftLedger.h"

#include "Content/EditableContentSnapshot.h"

namespace OpenTune {

ControlPitchShiftLedger::Counters ControlPitchShiftLedger::observe(const std::string& contentId, std::uint64_t epoch,
                                                                   const EditableContentSnapshot& snapshot)
{
    if (epoch_ != epoch) {
        entries_.clear();
        epoch_ = epoch;
    }
    const Counters raw{snapshot.notesRevision, snapshot.pitchRevision};
    const auto [it, inserted] = entries_.try_emplace(contentId);
    auto& entry = it->second;
    if (inserted) {
        entry.last = raw;
        entry.shift = snapshot.pitchShiftSettings;
    } else if (raw.notes >= entry.last.notes && raw.pitch >= entry.last.pitch) {
        // applyPitchShiftState() since the last observation: the settings changed, and the notes and pitch
        // counters advanced with it (StandaloneClipContent::applyPitchShiftState()).
        if (snapshot.pitchShiftSettings != entry.shift && raw.notes > entry.last.notes && raw.pitch > entry.last.pitch)
            entry.steps.push_back(raw);
        entry.last = raw;
        entry.shift = snapshot.pitchShiftSettings;
    }
    // Every counted step lies at or before raw in the counter it advanced, and steps strictly increase, so
    // the result never goes below zero.
    Counters effective = raw;
    for (const auto& step : entry.steps) {
        if (step.notes <= raw.notes)
            --effective.notes;
        if (step.pitch <= raw.pitch)
            --effective.pitch;
    }
    return effective;
}

} // namespace OpenTune
