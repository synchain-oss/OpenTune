// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

#include "OpsRegistry.h"

namespace OpenTune {

/**
 * The session methods the dispatcher runs: session.info (methods/session.info.schema.json). The
 * listener answers session.hello itself, before a session exists.
 *
 * session.info reports the build, the runtime, the audio device (through the editor's bridge), the
 * processing settings (AppPreferences and the process-wide render runtime), the UI language, the
 * capabilities the instance reports, the import and export capabilities and the limits. It runs on the
 * message thread because the preferences and the audio device belong to it. Errors: only the generic
 * ones (INVALID_ARGUMENT for params, TIMEOUT, SHUTTING_DOWN, INTERNAL).
 */
void registerSessionOps(ControlMethodTable& table);

} // namespace OpenTune
