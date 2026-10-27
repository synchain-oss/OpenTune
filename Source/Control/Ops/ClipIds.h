// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

// The control API's handling of an OpenTune defect in the numbering of clips.
//
// StandaloneContentRepository::createClip() takes the id of a new clip from a counter and refuses (it returns an
// invalid key) when a clip with that id exists. Opening a project calls StandaloneContentRepository::clear(), which
// restarts the counter at 1 while the clips of the opened project keep their saved ids. Every function that makes a
// clip (importing, splitting, merging, copying, duplicating) then fails once for each id in use that the counter
// reaches, and a failed attempt still uses up the id. Nothing in OpenTune handles this; the editor's own
// split, merge, paste and duplicate fail the same way after a project was opened.
//
// OpenTune is not changed for this. A method of the control API that makes clips calls
// controlSkipUsedClipIds() before it calls the OpenTune function, and controlRecordCommittedClipId() for each clip that
// the function made. The import job, which was written first, repeats a commit that failed instead (ImportOps.cpp);
// it shares the other two functions so that both ways agree on which ids are behind the counter.
//
// Why the other methods do not repeat a failed call: splitPlacementAtSeconds() makes two clips, and when only one
// of the two ids is in use it gives up after the other clip was made and published. Its clean-up,
// StandaloneContentRepository::releaseClip(), deletes a clip only after retireClip(), so the clip stays: a content that
// no clip shows, listed by project.get. Skipping the ids first means the call never meets an id in use.

#include "OpsRegistry.h"

#include "Content/ContentKey.h"

#include <cstddef>

namespace OpenTune {

/**
 * How many clips of the repository can still make a creation fail because of their ids: the clips whose id lies
 * above the highest id that this instance has seen the counter pass since the last StandaloneContentRepository::clear()
 * (see controlRecordCommittedClipId()). 0 without a content epoch (no project was opened, so the counter is past every
 * id), and 0 right after controlSkipUsedClipIds() and the creations that followed it were recorded. It never
 * undercounts; clips that the editor made in the meantime are counted too, which costs a pass of
 * controlSkipUsedClipIds() but is never wrong. Message thread.
 */
std::size_t controlPossibleClipIdCollisions(ControlOpContext& context);

/**
 * Records that the counter has passed the id of a clip that was just made (by an import commit or by one of
 * the OpenTune functions that controlSkipUsedClipIds() prepares), so that controlPossibleClipIdCollisions() stops
 * counting the ids up to it. Only raises the record; starts again from 0 when the content epoch changed. Message
 * thread.
 */
void controlRecordCommittedClipId(ControlOpContext& context, const ContentKey& key);

/**
 * Moves OpenTune's clip id counter past the id of every clip the repository holds, so that the creation of clips
 * that follows meets no id in use. Does nothing (and takes nothing from the counter) when
 * controlPossibleClipIdCollisions() is 0, so a call without a project opened before has no effect on OpenTune. Call it
 * only where the method has passed its checks and is about to change state: the counter is state, a dry run and a
 * refused call leave it alone.
 *
 * The counter cannot be read, so it is moved the way OpenTune moves it: by createClip(). Each call takes the next id
 * from the counter; a call that meets an id in use returns an invalid key and has still used up the id. A call that
 * returns a key made an empty clip, which is retired and released again at once: the probe has no content, is not in
 * the render service, is not shown by any clip and does not reach the undo history, and releaseClip() deletes it
 * (a retired clip, unlike a new one, is deleted). It goes on until a probe got an id above the highest id of any
 * clip in the repository, which includes retired clips that have not been reclaimed yet (createClip() checks all of
 * them). Then the highest id is recorded, so that import and the other methods do not skip again.
 *
 * Message thread only, like every access to the repository. operation names the method for the log line that is
 * written when ids were skipped (for example "arrangement.edit split"). Returns the number of ids that were skipped:
 * the ids at or below the highest one that the counter handed to the probes, in use or free.
 */
std::size_t controlSkipUsedClipIds(ControlOpContext& context, const char* operation);

} // namespace OpenTune
