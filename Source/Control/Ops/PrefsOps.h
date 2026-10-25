// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include <cstdint>

namespace OpenTune {

class ControlMethodTable;

/**
 * Registers prefs.set (capability prefs.write; methods/prefs.set.schema.json).
 *
 * prefs.set changes the processing preferences that OpenTune's preferences window changes: the frequency of A4
 * (tuningHz), the editing scheme, the hybrid (light pitch correction) switch, the experimental features, the vocoder
 * weight, the rendering priority, the pitch model and the reference alignment mode. It makes the same calls as the
 * window does (AppPreferences setters, and the processor functions the window calls next: invalidateAllContentCaches()
 * for the hybrid switch, setVocoderModelWeight(), resetInferenceBackend() and setF0ModelType()) and then asks the
 * editor to apply the preferences (ControlUiBridge::onPreferencesChanged()).
 *
 * - A call that changes none of the editing scheme, the vocoder weight and the rendering priority applies at once and
 *   returns the write envelope. Every changed preference is listed (entity preference), the result carries the warning
 *   GLOBAL_PREFERENCE (and EXPERIMENTAL_FEATURE for the reference alignment mode), the call has no undo entry (reason
 *   ui_parity) and its revert recipe is the same call with the previous values. A value equal to the current one is a
 *   no-op.
 * - The vocoder weight and the pitch model must be among processing.options of prefs.get (the files and models that the
 *   window lists); a value that is not gives INVALID_ARGUMENT(option_unavailable) and changes nothing. The pitch model
 *   is switched first: when the processor refuses, the call fails with MODEL_UNAVAILABLE(model_missing) and nothing
 *   changes.
 * - A call that changes the editing scheme, the vocoder weight or the rendering priority changes nothing itself: it
 *   hands all its changes to a job of kind prefsApply, which applies them on the message thread, waits and ends with
 *   the write envelope. The job cannot be cancelled. It waits until the editor has applied the scheme, and, when the
 *   vocoder was ready before the change, until the vocoder is ready again after the new weight or priority. Switching
 *   to openDyne can make the editor generate notes for the clip open in the piano roll; the job reports it as
 *   sideEffects.notesGenerated with SCHEME_GENERATED_NOTES and IRREVERSIBLE, and marks the project as changed. A new
 *   vocoder weight makes OpenTune render every content again (sideEffects.reRenderQueued); a new rendering priority
 *   does not. If the editor does not apply the scheme within the time limit, or the vocoder is not ready within its
 *   own, longer limit, the job restores the previous preferences (and asks the runtime for the previous vocoder weight
 *   and priority) and fails, with INTERNAL for the scheme and MODEL_UNAVAILABLE(vocoder_not_ready) for the vocoder, so
 *   that no half-applied set remains.
 *
 * No cosmetic preference can be set (the params schema is closed).
 *
 * Threading: parse on the connection thread; run, the job and everything it touches on the message thread.
 */
void registerPrefsOps(ControlMethodTable& table);

/** Test seam: the time that a prefsApply job waits for the editor to apply the editing scheme, in milliseconds; 0
    restores the default. Any thread. */
void controlSetPrefsApplyTimeoutForTesting(std::uint32_t milliseconds);

/** Test seam: the time that a prefsApply job waits for the vocoder to be ready again after a new vocoder weight or
    rendering priority, in milliseconds; 0 restores the default (60 s). Any thread. */
void controlSetPrefsVocoderWaitForTesting(std::uint32_t milliseconds);

} // namespace OpenTune
