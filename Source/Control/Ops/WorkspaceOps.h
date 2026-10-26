// SPDX-License-Identifier: AGPL-3.0-or-later
#pragma once

namespace OpenTune {

class ControlMethodTable;

/**
 * Registers ui.setWorkspace (capability ui.workspace; methods/ui.setWorkspace.schema.json).
 *
 * The call switches the window between the arrangement view and the piano roll through the editor
 * (ControlUiBridge::setWorkspace()), as the two view buttons of the transport bar do. Only the view changes: no
 * content, key, note, clip or track is touched and nothing is generated or queued, in either editing scheme, so
 * revisionDiff is empty and dirty does not change (the workspace is not saved with the project). Switching to the
 * piano roll with no clip selected shows an empty piano roll, as the window does, and is no error.
 *
 * The result lists one change (entity ui, ref {singleton: workspace}, member workspace {before, after}) and the side
 * effect workspaceSwitched {from, to, revert: null}, the same one that ui.setSelection reports when it opens the
 * editor. The workspace is view state: the undo reason is not_persisted_state, and the revert recipe is
 * ui.setWorkspace to the workspace the window showed before. Asking for the workspace the window already shows is a
 * no-op (no change, no side effect, undo reason no_op). The busy checks of PROTOCOL.md section 13.2 apply. Without an
 * editor the call answers UNSUPPORTED(no_editor_window), and with a bridge that cannot report or switch the workspace
 * UNSUPPORTED(capability_missing).
 */
void registerWorkspaceOps(ControlMethodTable& table);

} // namespace OpenTune
