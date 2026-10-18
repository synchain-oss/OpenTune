// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <cstdint>

namespace OpenTune {

class ControlMethodTable;

/**
 * Registers prefs.set (capability prefs.write; methods/prefs.set.schema.json).
 *
 * prefs.set changes the processing preferences that OpenTune's preferences window changes: the frequency of A4
 * (tuningHz), the editing scheme, the hybrid (light pitch correction) switch and the experimental features. It makes
 * the same calls as the window does (AppPreferences setters, and for the hybrid switch the processor's
 * invalidateAllContentCaches()) and then asks the editor to apply the preferences
 * (ControlUiBridge::onPreferencesChanged()).
 *
 * - A call that leaves the editing scheme as it is applies at once and returns the write envelope. Every changed
 *   preference is listed (entity preference), the result carries the warning GLOBAL_PREFERENCE, the call has no undo
 *   entry (reason ui_parity) and its revert recipe is the same call with the previous values. A value equal to the
 *   current one is a no-op.
 * - A call that changes the editing scheme changes nothing itself: it hands all its changes to a job of kind
 *   prefsApply, which applies them on the message thread, waits until the editor has applied the scheme and ends with
 *   the write envelope. The job cannot be cancelled. Switching to openDyne can make the editor generate notes for the
 *   clip open in the piano roll; the job reports it as sideEffects.notesGenerated with SCHEME_GENERATED_NOTES and
 *   IRREVERSIBLE, and marks the project as changed. If the editor does not apply the scheme within the time limit,
 *   the job restores the previous preferences and fails with INTERNAL, so that no half-applied set remains.
 *
 * The vocoder weight, the rendering priority, the pitch model and the reference alignment mode cannot be set in this
 * version (the params schema is closed), and no cosmetic preference can be set.
 *
 * Threading: parse on the connection thread; run, the job and everything it touches on the message thread.
 */
void registerPrefsOps(ControlMethodTable& table);

/** Test seam: the time that a prefsApply job waits for the editor to apply the editing scheme, in milliseconds; 0
    restores the default. Any thread. */
void controlSetPrefsApplyTimeoutForTesting(std::uint32_t milliseconds);

} // namespace OpenTune
