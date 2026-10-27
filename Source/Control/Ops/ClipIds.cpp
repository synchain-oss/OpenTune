// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ClipIds.h"

#include "Content/StandaloneContentRepository.h"
#include "PluginProcessor.h"
#include "Utils/AppLogger.h"

#include <algorithm>
#include <cstdint>
#include <string>

namespace OpenTune {

namespace {

/** The highest clip id that the counter of the instance is known to have passed, with the content epoch it was
    recorded in. Message thread only. */
struct ClipIdFloor
{
    std::string instanceId;
    std::uint64_t epoch = 0;
    std::uint64_t clipId = 0;
};

ClipIdFloor& clipIdFloor()
{
    static ClipIdFloor floor;
    return floor;
}

} // namespace

std::size_t controlPossibleClipIdCollisions(ControlOpContext& context)
{
    const auto* repository = context.processor().getStandaloneContentRepository();
    // Without a StandaloneContentRepository::clear() (content epoch 0) every id came from the counter, which is past
    // them all.
    if (repository == nullptr || repository->getContentEpoch() == 0)
        return 0;
    const auto& floor = clipIdFloor();
    const std::uint64_t behind =
        floor.instanceId == context.facts().instanceId && floor.epoch == repository->getContentEpoch() ? floor.clipId
                                                                                                       : 0;
    const auto clips = repository->getAllClips();
    return static_cast<std::size_t>(
        std::count_if(clips.begin(), clips.end(), [behind](const ContentKey& key) { return key.objectId > behind; }));
}

void controlRecordCommittedClipId(ControlOpContext& context, const ContentKey& key)
{
    const auto* repository = context.processor().getStandaloneContentRepository();
    if (repository == nullptr)
        return;
    auto& floor = clipIdFloor();
    const auto epoch = repository->getContentEpoch();
    if (floor.instanceId != context.facts().instanceId || floor.epoch != epoch)
        floor = ClipIdFloor{context.facts().instanceId, epoch, 0};
    floor.clipId = std::max(floor.clipId, key.objectId);
}

std::size_t controlSkipUsedClipIds(ControlOpContext& context, const char* operation)
{
    if (controlPossibleClipIdCollisions(context) == 0)
        return 0;
    auto* repository = context.processor().getStandaloneContentRepository();
    if (repository == nullptr)
        return 0;

    // The highest id of any clip: getAllClips() lists every clip of the repository, the retired ones that are not
    // reclaimed yet as well, and createClip() refuses an id that any of them has.
    std::uint64_t highest = 0;
    for (const auto& key : repository->getAllClips())
        highest = std::max(highest, key.objectId);

    // Each createClip() takes one id from the counter, so the counter is past `highest` after at most highest + 1
    // calls; the bound only keeps a case that was not foreseen from looping.
    std::size_t skipped = 0;
    bool reached = false;
    ContentKey last;
    for (std::uint64_t call = 0; call <= highest && !reached; ++call) {
        // StandaloneContentRepository::createClip() without a forced id: the call OpenTune's own functions make for a
        // new clip. It takes the next id from the counter and refuses an id in use, using the id up either way.
        const auto probe = repository->createClip();
        if (!probe.isValid()) {
            ++skipped; // the id was in use: the counter moved on
            continue;
        }
        // A free id made an empty clip. Retired and then released, it is deleted (releaseClip() deletes only a retired
        // clip); it never reached the render service or an arrangement.
        repository->retireClip(probe);
        repository->releaseClip(probe);
        jassert(repository->findClip(probe) == nullptr);
        last = probe;
        if (probe.objectId > highest)
            reached = true;
        else
            ++skipped; // a free id below the highest one: not usable by the next creation either way
    }
    if (reached)
        controlRecordCommittedClipId(context, last);
    if (skipped > 0)
        AppLogger::logNoThrow(juce::String("control API: ") + operation + ": OpenTune's clip id counter was moved past "
                              + juce::String(static_cast<int>(skipped))
                              + " id(s) that clips already have (project opened before)");
    return skipped;
}

} // namespace OpenTune
