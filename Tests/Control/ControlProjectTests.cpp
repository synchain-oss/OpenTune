// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of project.save, project.saveAs, project.open and project.clearRecent against the real processor without
// a window or an audio device. The test bridge hands the methods what the editor owns: a real ProjectSession and a
// worker pool of one thread, as the editor's projectWorkerPool_. The projects are written by OpenTune's own project
// persistence (ProjectSession::prepareSave and executeSaveToFile) into a directory of the test's data directory.
// Registered with the other processor scenarios in ControlProcessorTests.cpp.

#include "ControlContentFixtures.h"
#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Content/EditableContentSnapshot.h"
#include "Content/StandaloneClipContent.h"
#include "Content/StandaloneContentRepository.h"
#include "Control/ControlDispatcher.h"
#include "Control/ControlJobs.h"
#include "PluginProcessor.h"
#include "Render/ContentRenderService.h"
#include "SourceStore.h"
#include "Utils/AppPreferences.h"
#include "Utils/PitchCurve.h"
#include "Utils/ProjectSession.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <filesystem>
#include <functional>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ControlWinAcl.h" // after the JUCE headers: needs windows.h

namespace OpenTune {
namespace ControlTest {

namespace {

/** Bound of a client exchange that includes a project job. */
constexpr int kJobExchangeMs = 60000;
/** The long poll of job.get, shorter than kJobExchangeMs. */
constexpr int kJobWaitMs = 30000;

juce::File juceFileOf(const std::string& utf8Path)
{
    return juce::File(juce::String::fromUTF8(utf8Path.c_str()));
}

JsonValue json(const std::string& text)
{
    auto parsed = parseJson(text);
    CONTROL_CHECK(parsed.ok);
    return parsed.value;
}

std::string quoted(const std::string& text)
{
    std::string out;
    appendJsonQuoted(out, text);
    return out;
}

/** A new, empty directory in the test's data directory. */
std::filesystem::path projectDirectory(const std::string& name)
{
    const auto directory = isolatedDataDirectory() / "project-io" / std::filesystem::u8path(name);
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);
    std::filesystem::create_directories(directory, ignored);
    return directory;
}

/** Registers a bridge with the service for the life of this object. */
class ScopedBridge
{
public:
    ScopedBridge(ControlService& service, ControlUiBridge& bridge) : service_(service)
    {
        service_.setUiBridge(&bridge);
    }
    ~ScopedBridge() { service_.setUiBridge(nullptr); }

    ScopedBridge(const ScopedBridge&) = delete;
    ScopedBridge& operator=(const ScopedBridge&) = delete;

private:
    ControlService& service_;
};

/**
 * What the editor owns for a project: the session over the processor and the worker pool of one thread, behind a
 * test bridge. Declared after the processor, destroyed before it (the pool joins its worker first).
 */
struct EditorParts
{
    explicit EditorParts(OpenTuneAudioProcessor& processor)
        : session(processor, processor.getAppPreferences())
        , registered(processor.getControlService(), bridge)
    {
        bridge.session = &session;
        bridge.pool = &pool;
    }

    ProjectSession session;
    juce::ThreadPool pool{1};
    TestUiBridge bridge;
    ScopedBridge registered;
};

/** A job on the worker pool that holds the pool's only thread until released, so that a project job waits for its
    worker meanwhile. */
class WorkerHold
{
public:
    explicit WorkerHold(juce::ThreadPool& pool)
    {
        auto state = state_;
        pool.addJob([state] {
            state->running = true;
            while (!state->release.load())
                juce::Thread::sleep(2);
        });
        CONTROL_CHECK(pumpMessagesUntil([state] { return state->running.load(); }, kDriveTimeoutMs));
    }
    ~WorkerHold() { release(); }
    void release() { state_->release = true; }

    WorkerHold(const WorkerHold&) = delete;
    WorkerHold& operator=(const WorkerHold&) = delete;

private:
    struct State
    {
        std::atomic<bool> running{false};
        std::atomic<bool> release{false};
    };
    static constexpr int kDriveTimeoutMs = 20000;
    std::shared_ptr<State> state_ = std::make_shared<State>();
};

/** Discards the project of the processor the way a project open does before it restores one (the steps of
    ProjectSession::commitPreparedOpen), so that a scenario can start from an empty project after it saved one. */
void clearProject(OpenTuneAudioProcessor& processor)
{
    if (auto* service = processor.getContentRenderService())
        service->drainRenderWorker();
    processor.getSourceStore()->clear();
    processor.getStandaloneContentRepository()->clear();
    processor.getStandaloneArrangement()->clear();
    processor.getUndoManager().clear();
    if (auto* service = processor.getContentRenderService())
        service->clearAll();
}

/** A unique clip name, so that the media of two clips never share a file. */
std::string uniqueName(const std::string& base)
{
    static int counter = 0;
    return base + "-" + std::to_string(++counter);
}

/** Writes a project file with one clip of the given length at path, with OpenTune's own save, and leaves the
    processor with an empty project. With missingMedia the clip's media (the original and the copy next to the project)
    are deleted afterwards. */
bool writeProjectFile(OpenTuneAudioProcessor& processor, const std::string& path, double durationSec, bool missingMedia)
{
    ClipSpec spec;
    spec.name = uniqueName("file");
    spec.durationSec = durationSec;
    const auto clip = fixtureAddClip(processor, spec);
    if (!clip.key.isValid())
        return false;
    ProjectSession scratch(processor, processor.getAppPreferences());
    auto task = scratch.prepareSave(juceFileOf(path));
    const bool saved = ProjectSession::executeSaveToFile(task).ok();
    clearProject(processor);
    if (!saved)
        return false;
    if (missingMedia) {
        juceFileOf(clip.sourcePath).deleteFile();
        juceFileOf(path).getParentDirectory().getChildFile(ProjectSession::kMediaDirectoryName).deleteRecursively();
    }
    return true;
}

// ---- Requests -------------------------------------------------------------------------------------

/** The job object of a job.get that waited for the job to end. */
JsonValue waitJob(ApiSession& api, const std::string& jobId)
{
    auto params = JsonValue::object();
    params.appendMember("jobId", JsonValue::string(jobId));
    params.appendMember("waitMs", JsonValue::integer(kJobWaitMs));
    return memberOf(api.result("job.get", std::move(params)), "job");
}

/** The id of the job in the result of a method that handed its work to one; empty when it did not. */
std::string jobIdOf(const JsonValue& result)
{
    return memberOf(memberOf(result, "job"), "jobId").text();
}

JsonValue pathParams(const std::string& path, const char* consent = nullptr)
{
    auto params = JsonValue::object();
    params.appendMember("path", JsonValue::string(path));
    if (consent != nullptr)
        params.appendMember(consent, JsonValue::boolean(true));
    return params;
}

/** Sends a method, waits for its job and returns the job; the method must have handed its work to a job. */
JsonValue runAsJob(ApiSession& api, const std::string& method, JsonValue params, const char* kind)
{
    const auto started = api.result(method, std::move(params));
    const auto jobId = jobIdOf(started);
    if (!CONTROL_CHECK(!jobId.empty() && memberOf(memberOf(started, "job"), "kind").text() == kind))
        return JsonValue();
    return waitJob(api, jobId);
}

bool succeeded(const JsonValue& job)
{
    const bool ok = memberOf(job, "state").text() == "succeeded";
    if (!ok)
        note("the job did not succeed: " + toJsonString(job));
    return ok;
}

bool failedWith(const JsonValue& job, const std::string& kind, const std::string& reason)
{
    const auto& data = memberOf(memberOf(job, "error"), "data");
    const bool ok = memberOf(job, "state").text() == "failed" && memberOf(data, "kind").text() == kind
                    && memberOf(data, "reason").text() == reason && memberOf(data, "executed").isBoolean()
                    && !memberOf(data, "executed").asBoolean();
    if (!ok)
        note("expected a failed job " + kind + "(" + reason + "), got " + toJsonString(job));
    return ok;
}

bool hasWarning(const JsonValue& result, const std::string& code)
{
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        if (memberOf(warnings.at(i), "code").text() == code)
            return true;
    return false;
}

/** The target pitches of a content's notes, in order, as content.getNotes reports them. */
std::vector<double> targetsOf(ApiSession& api, const std::string& contentId)
{
    std::vector<double> out;
    const auto notes =
        memberOf(api.result("content.getNotes", json("{\"contentId\":" + quoted(contentId) + "}")), "notes");
    for (std::size_t i = 0; i < notes.size(); ++i)
        out.push_back(memberOf(notes.at(i), "targetMidi").asDouble());
    return out;
}

/** The placement and content ids of the clip on track 0 at the timeline start, as project.get reports them. */
std::optional<ClipHandles> handlesAt(ApiSession& api, double startTimelineSec)
{
    return fixtureHandlesOf(api.result("project.get"), 0, startTimelineSec);
}

std::string textOf(const std::string& path)
{
    return juceFileOf(path).loadFileAsString().toStdString();
}

// ---- The scenarios -------------------------------------------------------------------------------

/** Notes of the clip the round trip saves. */
ClipSpec sungClip(const char* name)
{
    ClipSpec spec;
    spec.name = uniqueName(name);
    spec.trackId = 0;
    spec.startTimelineSec = 2.0;
    spec.durationSec = 6.0;
    spec.notes = {{0.5, 1.5, 64.0}, {2.0, 3.0, 69.0}, {3.5, 4.5, 60.0}};
    return spec;
}

} // namespace

/** Save as, change, open the file again: the content is what was saved; save again; the lists and flags on the way. */
void scenarioProjectRoundTrip()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    EditorParts editor(*processor);
    // The preferences of a data directory outlive the process: the list starts empty.
    processor->getAppPreferences().clearRecentProjects();
    const auto directory = projectDirectory("round-trip");
    const auto fileA = (directory / "first.otproj").u8string();
    const auto fileB = (directory / "second.otproj").u8string();

    // A project with a clip that was never saved: project.save has no file to write to.
    const auto clip = fixtureAddClip(*processor, sungClip("round-trip"));
    editor.session.markDirty();
    ApiSession api;
    if (!api.open(service))
        return;
    const auto before = handlesAt(api, 2.0);
    if (!CONTROL_CHECK(before.has_value()))
        return;
    const auto savedNotes = targetsOf(api, before->contentId);
    CONTROL_CHECK(savedNotes.size() == 3);
    CONTROL_CHECK(api.fails("project.save", JsonValue::object(), "INVALID_ARGUMENT", "no_project_path"));
    CONTROL_CHECK(editor.session.isDirty() && !editor.session.hasProjectPath());

    // Save as: a job; the file is written next to its media, the flag is cleared and the file is the project's.
    {
        const auto job = runAsJob(api, "project.saveAs", pathParams(fileA), "projectSave");
        CONTROL_CHECK(succeeded(job));
        const auto& result = memberOf(job, "result");
        CONTROL_CHECK(memberOf(result, "path").text() == fileA);
        CONTROL_CHECK(memberOf(result, "sizeBytes").asDouble() > 0.0);
        CONTROL_CHECK(!memberOf(result, "noOp").asBoolean() && memberOf(result, "applied").asBoolean());
        CONTROL_CHECK(memberOf(memberOf(result, "dirty"), "before").asBoolean()
                      && !memberOf(memberOf(result, "dirty"), "after").asBoolean());
        CONTROL_CHECK(hasWarning(result, "IRREVERSIBLE") && hasWarning(result, "NOT_SAVED_IN_PROJECT")
                      && !hasWarning(result, "OVERWROTE_OTHER_PROJECT"));
        CONTROL_CHECK(juceFileOf(fileA).existsAsFile());
        CONTROL_CHECK(
            juceFileOf(fileA).getParentDirectory().getChildFile(ProjectSession::kMediaDirectoryName).isDirectory());
        CONTROL_CHECK(editor.session.hasProjectPath() && !editor.session.isDirty());
        CONTROL_CHECK(editor.session.getCurrentProjectFile().getFullPathName().toStdString() == fileA);
        CONTROL_CHECK(editor.bridge.projectSaves == 1);
        // The write left nothing but the project, its media directory and the original media behind.
        std::vector<std::string> names;
        for (const auto& entry : std::filesystem::directory_iterator(directory))
            names.push_back(entry.path().filename().u8string());
        std::sort(names.begin(), names.end());
        CONTROL_CHECK((names == std::vector<std::string>{ProjectSession::kMediaDirectoryName, "first.otproj"}));
        // The flag of the running operation was set for the job and cleared at its end.
        CONTROL_CHECK((editor.bridge.operationFlagChanges == std::vector<bool>{true, false}));
        CONTROL_CHECK(!editor.bridge.busy.operationRunning);
        // The project is in the list of recent projects.
        const auto prefs = api.result("prefs.get");
        const auto& recent = memberOf(prefs, "recentProjects");
        CONTROL_CHECK(recent.size() == 1 && memberOf(recent.at(0), "path").text() == fileA);
    }

    // A change, then an open of the saved file: refused without discardUnsaved, nothing touched.
    {
        std::vector<Note> notes;
        Note note;
        note.startTime = 0.2;
        note.endTime = 0.8;
        note.pitch = 440.0f;
        note.originalPitch = 440.0f;
        note.isVoiced = true;
        notes.push_back(note);
        CONTROL_CHECK(processor->replaceContentNotesForFullMutation(clip.key, std::move(notes)));
        editor.session.markDirty();
        CONTROL_CHECK(targetsOf(api, before->contentId).size() == 1);
        CONTROL_CHECK(api.fails("project.open", pathParams(fileA), "UNSAVED_CHANGES", "project_dirty"));
        CONTROL_CHECK(editor.session.isDirty() && targetsOf(api, before->contentId).size() == 1);
        CONTROL_CHECK(editor.bridge.operationFlagChanges.size() == 2);
    }

    // With discardUnsaved the saved project comes back as it was: notes equal, handles of the epoch before stale.
    {
        const auto epochBefore = processor->getStandaloneContentRepository()->getContentEpoch();
        const auto job = runAsJob(api, "project.open", pathParams(fileA, "discardUnsaved"), "projectOpen");
        CONTROL_CHECK(succeeded(job));
        const auto& result = memberOf(job, "result");
        CONTROL_CHECK(processor->getStandaloneContentRepository()->getContentEpoch() == epochBefore + 1);
        CONTROL_CHECK(memberOf(result, "path").text() == fileA);
        CONTROL_CHECK(memberOf(memberOf(result, "previous"), "dirty").asBoolean()
                      && memberOf(memberOf(result, "previous"), "discarded").asBoolean());
        CONTROL_CHECK(memberOf(memberOf(result, "previous"), "path").text() == fileA);
        CONTROL_CHECK(memberOf(memberOf(result, "restored"), "placementCount").asDouble() == 1.0
                      && memberOf(memberOf(result, "restored"), "contentCount").asDouble() == 1.0);
        CONTROL_CHECK(memberOf(memberOf(result, "skipped"), "placementCount").asDouble() == 0.0
                      && memberOf(memberOf(result, "skipped"), "media").size() == 0);
        CONTROL_CHECK(memberOf(result, "undo").find("revert") != nullptr
                      && memberOf(memberOf(result, "undo"), "revert").isNull());
        CONTROL_CHECK(hasWarning(result, "IRREVERSIBLE") && !hasWarning(result, "MEDIA_MISSING"));
        CONTROL_CHECK(!editor.session.isDirty() && editor.session.hasProjectPath());
        CONTROL_CHECK(editor.bridge.projectReloads == 1);
        // The handles of the project before are stale; the new ones name the restored content.
        CONTROL_CHECK(api.fails("content.getNotes", json("{\"contentId\":" + quoted(before->contentId) + "}"),
                                "NOT_FOUND", "stale_handle"));
        const auto after = handlesAt(api, 2.0);
        if (CONTROL_CHECK(after.has_value())) {
            CONTROL_CHECK(after->contentId != before->contentId);
            CONTROL_CHECK(targetsOf(api, after->contentId) == savedNotes);
        }
    }

    // Save with no change: the file is written again, and the result is no no-op.
    {
        const auto job = runAsJob(api, "project.save", JsonValue::object(), "projectSave");
        CONTROL_CHECK(succeeded(job));
        const auto& result = memberOf(job, "result");
        CONTROL_CHECK(!memberOf(result, "noOp").asBoolean() && memberOf(result, "changes").size() == 0);
        CONTROL_CHECK(memberOf(result, "path").text() == fileA);
        CONTROL_CHECK(!hasWarning(result, "OVERWROTE_OTHER_PROJECT"));
    }

    // Save as to a second file: the project's file changes; saving over the first needs the caller's confirmation.
    {
        const auto job = runAsJob(api, "project.saveAs", pathParams(fileB), "projectSave");
        CONTROL_CHECK(succeeded(job));
        const auto& changes = memberOf(memberOf(job, "result"), "changes");
        CONTROL_CHECK(changes.size() == 1);
        CONTROL_CHECK(memberOf(memberOf(memberOf(changes.at(0), "fields"), "path"), "before").text() == fileA);
        CONTROL_CHECK(editor.session.getCurrentProjectFile().getFullPathName().toStdString() == fileB);
        const auto sizeA = juceFileOf(fileA).getSize();
        CONTROL_CHECK(api.fails("project.saveAs", pathParams(fileA), "INVALID_ARGUMENT", "confirm_required"));
        CONTROL_CHECK(juceFileOf(fileA).getSize() == sizeA);
        // Saving to the project's own file is a save, with or without confirm.
        const auto again = runAsJob(api, "project.saveAs", pathParams(fileB), "projectSave");
        CONTROL_CHECK(succeeded(again) && memberOf(memberOf(again, "result"), "changes").size() == 0);
        CONTROL_CHECK(!hasWarning(memberOf(again, "result"), "OVERWROTE_OTHER_PROJECT"));
    }
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

/** The checks before a job, the busy state, the cancellation rules and the races of the jobs. */
void scenarioProjectJobs()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    EditorParts editor(*processor);
    const auto directory = projectDirectory("jobs");
    const auto fileA = (directory / "a.otproj").u8string();
    const auto existing = (directory / "existing.otproj").u8string();
    CONTROL_CHECK(juceFileOf(existing).replaceWithText("an existing file"));
    ApiSession api;
    if (!api.open(service))
        return;
    fixtureAddClip(*processor, sungClip("jobs"));
    editor.session.markDirty();

    // The checks before the job, with the errors of the specification and nothing started.
    CONTROL_CHECK(api.fails("project.saveAs", pathParams((directory / "x.wav").u8string()), "INVALID_ARGUMENT",
                            "path_bad_extension"));
    CONTROL_CHECK(api.fails("project.saveAs", pathParams("relative.otproj"), "INVALID_ARGUMENT", "path_not_absolute"));
    CONTROL_CHECK(api.fails("project.saveAs", pathParams((directory / "missing-dir" / "x.otproj").u8string()),
                            "IO_ERROR", "write_failed"));
    CONTROL_CHECK(api.fails("project.saveAs", pathParams(existing), "INVALID_ARGUMENT", "confirm_required"));
    CONTROL_CHECK(textOf(existing) == "an existing file");
    CONTROL_CHECK(
        api.fails("project.open", pathParams((directory / "none.otproj").u8string()), "NOT_FOUND", "file_not_found"));
    CONTROL_CHECK(api.fails("project.open", pathParams((directory / "none.wav").u8string()), "INVALID_ARGUMENT",
                            "path_bad_extension"));
    CONTROL_CHECK(api.fails("project.open", pathParams(existing), "UNSAVED_CHANGES", "project_dirty"));
    CONTROL_CHECK(api.fails("project.save", json(R"({"path":"x"})"), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("project.saveAs", json(R"({"path":"x.otproj","confirm":"yes"})"), "INVALID_ARGUMENT",
                            "invalid_params"));
    CONTROL_CHECK(
        api.fails("project.open", json(R"({"path":"x.otproj","discard":true})"), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(editor.bridge.operationFlagChanges.empty());

    // BUSY: every project method but the read waits for the user's operation, and a running job holds the flag.
    editor.bridge.busy.operationRunning = true;
    CONTROL_CHECK(api.fails("project.saveAs", pathParams(fileA), "BUSY", "project_operation"));
    CONTROL_CHECK(api.fails("project.clearRecent", JsonValue::object(), "BUSY", "project_operation"));
    editor.bridge.busy.operationRunning = false;
    editor.bridge.busy.modalOpen = true;
    CONTROL_CHECK(api.fails("project.saveAs", pathParams(fileA), "BUSY", "modal_open"));
    editor.bridge.busy.modalOpen = false;
    CONTROL_CHECK(!juceFileOf(fileA).exists());

    // A save job cannot be cancelled; a save that finds a file at the target without confirm leaves it alone.
    {
        const auto appeared = (directory / "appeared.otproj").u8string();
        WorkerHold hold(editor.pool);
        const auto started = api.result("project.saveAs", pathParams(appeared));
        const auto jobId = jobIdOf(started);
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(editor.bridge.busy.operationRunning);
        CONTROL_CHECK(api.fails("project.clearRecent", JsonValue::object(), "BUSY", "project_operation"));
        auto cancel = JsonValue::object();
        cancel.appendMember("jobId", JsonValue::string(jobId));
        CONTROL_CHECK(api.fails("job.cancel", cancel, "UNSUPPORTED", "job_not_cancellable"));
        // The file appears while the job waits for its worker.
        CONTROL_CHECK(juceFileOf(appeared).replaceWithText("someone else's file"));
        hold.release();
        const auto job = waitJob(api, jobId);
        CONTROL_CHECK(failedWith(job, "INVALID_ARGUMENT", "confirm_required"));
        CONTROL_CHECK(textOf(appeared) == "someone else's file");
        CONTROL_CHECK(editor.session.isDirty() && !editor.session.hasProjectPath());
        CONTROL_CHECK(!editor.bridge.busy.operationRunning);
        // No temporary file is left.
        std::vector<std::string> names;
        for (const auto& entry : std::filesystem::directory_iterator(directory))
            names.push_back(entry.path().filename().u8string());
        CONTROL_CHECK(std::none_of(names.begin(), names.end(), [](const std::string& name) { return name[0] == '.'; }));
    }

    // A save whose media is gone fails with write_failed and writes nothing.
    {
        const auto target = (directory / "no-media.otproj").u8string();
        ClipSpec spec = sungClip("jobs-media");
        spec.startTimelineSec = 20.0;
        const auto gone = fixtureAddClip(*processor, spec);
        CONTROL_CHECK(juceFileOf(gone.sourcePath).deleteFile());
        const auto job = runAsJob(api, "project.saveAs", pathParams(target), "projectSave");
        CONTROL_CHECK(failedWith(job, "IO_ERROR", "write_failed"));
        CONTROL_CHECK(!juceFileOf(target).exists());
        CONTROL_CHECK(editor.session.isDirty() && !editor.bridge.busy.operationRunning);
    }
    clearProject(*processor);
    editor.session.clearDirty();

    // An open job is cancellable until its file is prepared, and then leaves the project as it is.
    {
        ClipSpec spec = sungClip("jobs-cancel");
        const auto clip = fixtureAddClip(*processor, spec);
        const auto saved = (directory / "cancel.otproj").u8string();
        {
            auto task = editor.session.prepareSave(juceFileOf(saved));
            CONTROL_CHECK(ProjectSession::executeSaveToFile(task).ok());
        }
        WorkerHold hold(editor.pool);
        const auto started = api.result("project.open", pathParams(saved));
        const auto jobId = jobIdOf(started);
        CONTROL_CHECK(!jobId.empty());
        CONTROL_CHECK(editor.bridge.busy.operationRunning);
        auto cancel = JsonValue::object();
        cancel.appendMember("jobId", JsonValue::string(jobId));
        const auto cancelled = api.result("job.cancel", cancel);
        CONTROL_CHECK(memberOf(memberOf(cancelled, "job"), "kind").text() == "projectOpen");
        const auto job = waitJob(api, jobId);
        CONTROL_CHECK(memberOf(job, "state").text() == "cancelled");
        hold.release();
        // The worker still prepares the file; the project is untouched and a new open works.
        CONTROL_CHECK(!editor.session.hasProjectPath() && !editor.bridge.busy.operationRunning);
        CONTROL_CHECK(processor->getStandaloneContentRepository()->isRetired(clip.key) == false);
        CONTROL_CHECK(editor.bridge.projectReloads == 0);
        const auto opened = runAsJob(api, "project.open", pathParams(saved), "projectOpen");
        CONTROL_CHECK(succeeded(opened));
        // This project was saved clean and the previous one had no file: no revert.
        CONTROL_CHECK(memberOf(memberOf(opened, "result"), "undo").find("revert")->isNull());
    }

    // Changes made while the file was prepared are not discarded unasked.
    {
        const auto saved = (directory / "cancel.otproj").u8string();
        WorkerHold hold(editor.pool);
        const auto started = api.result("project.open", pathParams(saved));
        const auto jobId = jobIdOf(started);
        CONTROL_CHECK(!jobId.empty());
        editor.session.markDirty();
        hold.release();
        const auto job = waitJob(api, jobId);
        CONTROL_CHECK(failedWith(job, "UNSAVED_CHANGES", "project_dirty"));
        CONTROL_CHECK(editor.session.isDirty() && !editor.bridge.busy.operationRunning);
        // With the caller's consent the same open replaces the changes; the revert recipe of an open of a clean
        // project with a file opens that file again, without consent members.
        editor.session.clearDirty();
        const auto reopened = runAsJob(api, "project.open", pathParams(saved), "projectOpen");
        CONTROL_CHECK(succeeded(reopened));
        const auto& revert = memberOf(memberOf(memberOf(reopened, "result"), "undo"), "revert");
        CONTROL_CHECK(memberOf(revert, "method").text() == "project.open"
                      && memberOf(memberOf(revert, "params"), "path").text() == saved);
        CONTROL_CHECK(memberOf(revert, "params").find("discardUnsaved") == nullptr);
        CONTROL_CHECK(!hasWarning(memberOf(reopened, "result"), "IRREVERSIBLE"));
    }

    // A file that is not a project ends the job with read_failed and the open project stays.
    {
        const auto broken = (directory / "broken.otproj").u8string();
        CONTROL_CHECK(juceFileOf(broken).replaceWithText("this is not a project"));
        const auto contentCount = processor->getStandaloneContentRepository()->getAllClips().size();
        const auto job = runAsJob(api, "project.open", pathParams(broken), "projectOpen");
        CONTROL_CHECK(failedWith(job, "IO_ERROR", "read_failed"));
        CONTROL_CHECK(processor->getStandaloneContentRepository()->getAllClips().size() == contentCount);
        CONTROL_CHECK(!editor.bridge.busy.operationRunning);
    }
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

/** Without an editor the project session does not exist: the methods that need it say so, clearRecent works. */
void scenarioProjectWithoutEditor()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    ApiSession api;
    if (!api.open(service))
        return;
    CONTROL_CHECK(api.fails("project.save", JsonValue::object(), "UNSUPPORTED", "no_editor_window"));
    const auto directory = projectDirectory("without-editor");
    CONTROL_CHECK(api.fails("project.saveAs", pathParams((directory / "a.otproj").u8string()), "UNSUPPORTED",
                            "no_editor_window"));
    CONTROL_CHECK(
        api.fails("project.open", pathParams((directory / "a.otproj").u8string()), "UNSUPPORTED", "no_editor_window"));
    // The recent projects are a preference: they can be cleared.
    auto& preferences = processor->getAppPreferences();
    preferences.clearRecentProjects();
    preferences.pushRecentProject(juce::String::fromUTF8((directory / "one.otproj").u8string().c_str()));
    const auto result = api.result("project.clearRecent");
    CONTROL_CHECK(memberOf(result, "applied").asBoolean() && !memberOf(result, "noOp").asBoolean());
    CONTROL_CHECK(preferences.getRecentProjects().empty());
    const auto again = api.result("project.clearRecent");
    CONTROL_CHECK(memberOf(again, "noOp").asBoolean());
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- Reopening a project with tuned notes ----------------------------------------------------------

namespace {

/** Bound of the wait for the analysis that a project open requests; the model-less runs end it at once. */
constexpr int kReanalysisWaitMs = 35000;
/** The synthetic analysis of the fixtures (ControlContentFixtures.h) has 100 frames per second. */
constexpr double kFramesPerSecond = 100.0;
/** The frames at the edge of a note that the comparison leaves out: the correction of a note reaches a few frames
    beyond it, and the edges are where a new analysis may differ. */
constexpr int kNoteEdgeFrames = 10;
constexpr double kMidiTolerance = 1e-3;
constexpr float kParameterTolerance = 1e-4f;

/** What the editor's knobs set and store with every correction segment it writes (PitchCorrectionSegment::
    ParameterSnapshot): four values, none of them the default. The API cannot set these (its corrections use the
    generator's defaults, as the UI's knobs start with), so the scenario writes them to the saved segments. */
PitchCorrectionSegment::ParameterSnapshot knobParameters()
{
    PitchCorrectionSegment::ParameterSnapshot parameters;
    parameters.retuneSpeed = 0.35f;
    parameters.vibratoDepth = 45.0f;
    parameters.vibratoRate = 6.5f;
    parameters.pitchDriftScale = 0.5f;
    return parameters;
}

bool sameParameters(const PitchCorrectionSegment::ParameterSnapshot& a,
                    const PitchCorrectionSegment::ParameterSnapshot& b)
{
    return std::abs(a.retuneSpeed - b.retuneSpeed) <= kParameterTolerance
           && std::abs(a.vibratoDepth - b.vibratoDepth) <= kParameterTolerance
           && std::abs(a.vibratoRate - b.vibratoRate) <= kParameterTolerance
           && std::abs(a.pitchDriftScale - b.pitchDriftScale) <= kParameterTolerance;
}

using MidiSeries = std::vector<std::optional<double>>;

MidiSeries midiSeriesOf(const JsonValue& array)
{
    MidiSeries series;
    for (std::size_t i = 0; i < array.size(); ++i)
        series.push_back(array.at(i).isNumber() ? std::optional<double>(array.at(i).asDouble()) : std::nullopt);
    return series;
}

/** The notes and the two pitch lines of a content as the API reports them. */
struct TuningRead
{
    JsonValue notes;
    MidiSeries original;
    MidiSeries corrected;
};

TuningRead readTuning(ApiSession& api, const std::string& contentId)
{
    const auto byContent = json("{\"contentId\":" + quoted(contentId) + "}");
    TuningRead read;
    read.notes = memberOf(api.result("content.getNotes", byContent), "notes");
    const auto curve = api.result("content.getPitchCurve", byContent);
    read.original = midiSeriesOf(memberOf(curve, "originalMidi"));
    read.corrected = midiSeriesOf(memberOf(curve, "correctedMidi"));
    return read;
}

std::vector<PitchCorrectionSegment> segmentsOf(OpenTuneAudioProcessor& processor, const ContentKey& key)
{
    const auto snapshot = processor.getContentSnapshot(key);
    if (snapshot == nullptr || snapshot->pitchCurve == nullptr)
        return {};
    return snapshot->pitchCurve->getCorrectionSegments();
}

/** The corrected value of a frame in the segments; 0 where no segment covers it. */
float segmentValueAt(const std::vector<PitchCorrectionSegment>& segments, int frame)
{
    for (const auto& segment : segments) {
        const auto offset = frame - segment.startFrame;
        if (offset >= 0 && frame < segment.endFrame && offset < static_cast<int>(segment.f0Data.size()))
            return segment.f0Data[static_cast<std::size_t>(offset)];
    }
    return 0.0f;
}

/** The frames inside a note of the scenario's clip, without its edges. */
std::vector<int> interiorFrames(double startSec, double endSec)
{
    std::vector<int> frames;
    const int first = static_cast<int>(startSec * kFramesPerSecond) + kNoteEdgeFrames;
    const int end = static_cast<int>(endSec * kFramesPerSecond) - kNoteEdgeFrames;
    for (int frame = first; frame < end; ++frame)
        frames.push_back(frame);
    return frames;
}

/** Writes the parameters to every correction segment of the content, as the editor's knobs have them when it writes
    the segments (through the content owner, as the processor does). */
bool setSegmentParameters(OpenTuneAudioProcessor& processor, const ContentKey& key,
                          const PitchCorrectionSegment::ParameterSnapshot& parameters)
{
    auto* owner = processor.getStandaloneContentRepository()->findClip(key);
    const auto snapshot = processor.getContentSnapshot(key);
    if (owner == nullptr || snapshot == nullptr || snapshot->pitchCurve == nullptr)
        return false;
    auto segments = snapshot->pitchCurve->getCorrectionSegments();
    for (auto& segment : segments)
        segment.parameterSnapshot = parameters;
    auto curve = PitchCurve::fromSnapshot(snapshot->pitchCurve);
    curve->replaceCorrectionSegments(segments);
    owner->applyPitchCurve(std::move(curve));
    return true;
}

/**
 * Completes the analysis of a reopened content the way OpenTuneAudioProcessor::requestContentRefresh does when the
 * extraction has finished with the preserve-corrections request that ProjectSession::commitPreparedOpen makes: a new
 * curve with the new original F0 (here the F0 the content had when it was saved: the same audio gives the same
 * analysis), the correction segments of the reopened content carried over to it and trimmed to the voiced frames of
 * the new analysis (retainVoicedCorrectionSegments), the curve given to the content owner and the state Ready. The
 * processor's own completion needs the FCPE model, which the model-less runs (the build machines) do not have; with
 * the model it runs by itself and this is not called.
 */
bool completeReanalysis(OpenTuneAudioProcessor& processor, const ContentKey& key, const PitchCurveSnapshot& analysis)
{
    auto* owner = processor.getStandaloneContentRepository()->findClip(key);
    const auto reopened = segmentsOf(processor, key);
    if (owner == nullptr)
        return false;
    auto curve = std::make_shared<PitchCurve>();
    curve->setHopSize(analysis.getHopSize());
    curve->setSampleRate(analysis.getSampleRate());
    curve->setOriginalF0(analysis.getOriginalF0());
    if (!reopened.empty()) {
        curve->replaceCorrectionSegments(reopened);
        // The same call, in the same order, as the production path in requestContentRefresh. It runs here, so the
        // model-less run covers what the cherry-picked change does to the carried segments; the call in the
        // production path itself is covered only on a machine that has the model.
        curve->retainVoicedCorrectionSegments();
    }
    owner->applyOriginalF0(std::move(curve));
    return processor.setContentOriginalF0State(key, OriginalF0State::Ready);
}

/** The notes the scenario tunes, by index: the first two of sungClip(); the third stays as it was analysed. */
constexpr int kTunedNotes = 2;

/** The members of a note that the tuning sets, equal in both reads for every note, and the corrected flag of the
    note equal to the flag expected (when expectFlags). */
void checkNotesEqual(const JsonValue& before, const JsonValue& after, bool expectFlags)
{
    if (!CONTROL_CHECK(before.size() == 3 && after.size() == before.size()))
        return;
    for (std::size_t i = 0; i < after.size(); ++i) {
        for (const char* member :
             {"targetMidi", "offsetCents", "retuneSpeed", "vibratoDepth", "vibratoRateHz", "pitchDriftScale"})
            if (!CONTROL_CHECK(
                    std::abs(memberOf(after.at(i), member).asDouble() - memberOf(before.at(i), member).asDouble())
                    <= kMidiTolerance))
                note("note " + std::to_string(i) + " " + member + ": " + toJsonString(memberOf(after.at(i), member))
                     + " after, " + toJsonString(memberOf(before.at(i), member)) + " before");
        if (expectFlags)
            if (!CONTROL_CHECK(memberOf(after.at(i), "corrected").asBoolean()
                               == memberOf(before.at(i), "corrected").asBoolean()))
                note("note " + std::to_string(i) + " corrected: " + toJsonString(memberOf(after.at(i), "corrected"))
                     + " after, " + toJsonString(memberOf(before.at(i), "corrected")) + " before");
    }
}

} // namespace

/**
 * A tuned project saved and opened again keeps the tuning: the correction segments with the four parameters they were
 * written with, the notes marked as corrected, and the corrected pitch line on the voiced frames of the tuned notes.
 *
 * Opening restores the segments while the original F0 is not yet analysed again (the curve is empty); upstream
 * dropped every saved frame there (commit 0afb6c8 keeps them until the analysis is done) and the project came back
 * with the red line only. The scenario checks the project right after the open job (the segments and their
 * parameters, which no analysis is needed for), waits for the analysis the open requested, completes it as the
 * processor does (completeReanalysis) where the model-less run could not, and compares what the API reports with
 * what it reported before the save.
 */
void scenarioProjectReopenKeepsTuning()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    EditorParts editor(*processor);
    const auto directory = projectDirectory("reopen-tuning");
    const auto file = (directory / "tuned.otproj").u8string();

    // A clip with a finished analysis and three notes; the first two are tuned through the API.
    const auto clip = fixtureAddClip(*processor, sungClip("reopen-tuning"));
    CONTROL_CHECK(settleBackgroundWork(*processor));
    ApiSession api;
    if (!api.open(service))
        return;
    const auto placed = handlesAt(api, 2.0);
    if (!CONTROL_CHECK(placed.has_value()))
        return;
    const auto analysis = processor->getContentSnapshot(clip.key);
    if (!CONTROL_CHECK(analysis != nullptr && analysis->hasUsableOriginalF0()))
        return;
    const auto analysedCurve = analysis->pitchCurve;

    // Tune: move the first note and set the four parameters of the first two.
    const std::string ops = R"([{"op":"setTargetPitch","select":{"indices":[0]},"targetMidi":65.5},)"
                            R"({"op":"setParams","select":{"indices":[0,1]},"retuneSpeed":0.35,"vibratoDepth":45,)"
                            R"("vibratoRateHz":6.5,"pitchDriftScale":0.5}])";
    const auto edited = api.result(
        "content.editNotes", json("{\"contentId\":" + quoted(placed->contentId) + ",\"expectedRevision\":"
                                  + quoted(memberOf(placed->tokens, "revision").text()) + ",\"ops\":" + ops + "}"));
    CONTROL_CHECK(memberOf(edited, "applied").asBoolean());
    CONTROL_CHECK(settleBackgroundWork(*processor));
    CONTROL_CHECK(setSegmentParameters(*processor, clip.key, knobParameters()));

    const auto savedSegments = segmentsOf(*processor, clip.key);
    const auto savedTuning = readTuning(api, placed->contentId);
    // The scenario can tell a tuned line from the red one: the notes are marked, and the lines differ in them.
    CONTROL_CHECK(!savedSegments.empty());
    for (int index = 0; index < 3; ++index)
        CONTROL_CHECK(memberOf(savedTuning.notes.at(static_cast<std::size_t>(index)), "corrected").asBoolean()
                      == (index < kTunedNotes));
    const std::pair<double, double> noteSpans[] = {{0.5, 1.5}, {2.0, 3.0}, {3.5, 4.5}};
    std::vector<std::vector<int>> probes;
    for (int index = 0; index < kTunedNotes; ++index) {
        const auto frames = interiorFrames(noteSpans[index].first, noteSpans[index].second);
        int differing = 0;
        for (const int frame : frames) {
            const auto position = static_cast<std::size_t>(frame);
            if (!CONTROL_CHECK(position < savedTuning.corrected.size() && position < savedTuning.original.size())) {
                note("frame " + std::to_string(frame) + " is outside the pitch lines read before the save: "
                     + std::to_string(savedTuning.original.size()) + " original frames, "
                     + std::to_string(savedTuning.corrected.size()) + " corrected frames");
                return;
            }
            if (savedTuning.corrected[position] && savedTuning.original[position]
                && std::abs(*savedTuning.corrected[position] - *savedTuning.original[position]) > 0.05)
                ++differing;
        }
        CONTROL_CHECK(differing > static_cast<int>(frames.size()) / 2);
        probes.push_back(frames);
    }

    // Save, then open the same file again.
    CONTROL_CHECK(succeeded(runAsJob(api, "project.saveAs", pathParams(file), "projectSave")));
    const auto opened = runAsJob(api, "project.open", pathParams(file), "projectOpen");
    if (!CONTROL_CHECK(succeeded(opened)))
        return;
    CONTROL_CHECK(memberOf(memberOf(memberOf(opened, "result"), "restored"), "contentCount").asDouble() == 1.0);
    const auto keys = processor->getStandaloneContentRepository()->getAllClips();
    if (!CONTROL_CHECK(keys.size() == 1))
        return;
    const auto key = keys.front();

    // Right after the open: the segments are there with their parameters and their corrected frames, before any
    // analysis has been done again.
    const auto reopened = segmentsOf(*processor, key);
    if (CONTROL_CHECK(!reopened.empty())) {
        for (const auto& segment : reopened)
            CONTROL_CHECK(sameParameters(segment.parameterSnapshot, knobParameters()));
        for (const auto& frames : probes)
            for (const int frame : frames)
                if (!CONTROL_CHECK(std::abs(segmentValueAt(reopened, frame) - segmentValueAt(savedSegments, frame))
                                   <= 1e-3f))
                    return;
    }

    // The analysis that the open requested ends: with the processor's own result where it has the model, else
    // failed, and then it is completed the way the processor completes it.
    CONTROL_CHECK(pumpMessagesUntil(
        [&processor, &key] {
            const auto snapshot = processor->getContentSnapshot(key);
            return snapshot == nullptr || snapshot->originalF0State != OriginalF0State::Extracting;
        },
        kReanalysisWaitMs));
    const auto settled = processor->getContentSnapshot(key);
    if (!CONTROL_CHECK(settled != nullptr))
        return;
    if (settled->originalF0State == OriginalF0State::Ready && settled->hasUsableOriginalF0()) {
        note("the processor's own analysis finished the open: its completion ran with the reopened segments");
    } else {
        note("the analysis did not run (no F0 model): completing it with the F0 of the content before the save");
        CONTROL_CHECK(completeReanalysis(*processor, key, *analysedCurve));
    }

    // What the API reports now equals what it reported before the save.
    const auto now = handlesAt(api, 2.0);
    if (!CONTROL_CHECK(now.has_value() && now->contentId != placed->contentId))
        return;
    const auto reopenedTuning = readTuning(api, now->contentId);
    checkNotesEqual(savedTuning.notes, reopenedTuning.notes, true);
    for (int index = 0; index < kTunedNotes; ++index)
        CONTROL_CHECK(memberOf(reopenedTuning.notes.at(static_cast<std::size_t>(index)), "corrected").asBoolean());
    const auto finalSegments = segmentsOf(*processor, key);
    CONTROL_CHECK(!finalSegments.empty());
    for (const auto& segment : finalSegments)
        CONTROL_CHECK(sameParameters(segment.parameterSnapshot, knobParameters()));
    // The corrected line is not empty on the frames in which the original line was voiced before the save, and it is
    // what it was.
    for (const auto& frames : probes)
        for (const int frame : frames) {
            const auto position = static_cast<std::size_t>(frame);
            if (!CONTROL_CHECK(position < reopenedTuning.corrected.size() && position < savedTuning.corrected.size()
                               && position < savedTuning.original.size())) {
                note("frame " + std::to_string(frame) + " is outside the pitch lines: corrected "
                     + std::to_string(reopenedTuning.corrected.size()) + " frames after the open, corrected "
                     + std::to_string(savedTuning.corrected.size()) + " and original "
                     + std::to_string(savedTuning.original.size()) + " frames before the save");
                return;
            }
            if (!savedTuning.original[position])
                continue;
            const bool same =
                reopenedTuning.corrected[position] && savedTuning.corrected[position]
                && std::abs(*reopenedTuning.corrected[position] - *savedTuning.corrected[position]) <= kMidiTolerance;
            if (!CONTROL_CHECK(same)) {
                note("frame " + std::to_string(frame) + ": corrected line "
                     + (reopenedTuning.corrected[position] ? std::to_string(*reopenedTuning.corrected[position])
                                                           : std::string("empty"))
                     + " after the open, "
                     + (savedTuning.corrected[position] ? std::to_string(*savedTuning.corrected[position])
                                                        : std::string("empty"))
                     + " before the save");
                return;
            }
        }
    CONTROL_CHECK(settleBackgroundWork(*processor));
    const auto dispatcher = service.dispatcher();
    CONTROL_CHECK(dispatcher != nullptr && dispatcher->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- The specification's vectors -------------------------------------------------------------------

namespace {

const std::set<std::string> kProjectVectorMethods = {"project.save",        "project.saveAs", "project.open",
                                                     "project.clearRecent", "job.get",        "job.cancel"};
const std::set<std::string> kProjectVectorCapabilities = {"session.v1", "read.v1", "jobs.v1", "project.io"};

std::string projectVectorSkipReason(const JsonValue& vector)
{
    if (kProjectVectorCapabilities.count(memberOf(vector, "capability").text()) == 0)
        return "needs capability " + memberOf(vector, "capability").text() + ", which a later part implements";
    if (memberOf(vector, "capability").text() != "project.io")
        return "runs in the runner of its own capability";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (kProjectVectorCapabilities.count(extra.at(i).text()) == 0)
            return "needs capability " + extra.at(i).text() + ", which a later part implements";
    if (memberOf(vector, "session").text() != "authenticated")
        return "unauthenticated vectors test the listener (ControlUnitTests)";
    std::vector<std::string> methods;
    if (const JsonValue* request = vector.find("request"))
        methods.push_back(memberOf(*request, "method").text());
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i) {
            const auto& step = steps->at(i);
            if ((step.find("send") == nullptr && step.find("expect") == nullptr) || step.find("connection") != nullptr)
                return "uses steps other than send and expect on the main connection";
            if (const JsonValue* send = step.find("send"))
                methods.push_back(memberOf(*send, "method").text());
        }
    for (const auto& method : methods)
        if (kProjectVectorMethods.count(method) == 0)
            return "uses " + method + ", which this runner does not cover";
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name == "dirty" || name == "projectFile" || name == "preferences" || name == "jobs" || name == "clips")
            continue;
        if (name == "files") {
            for (std::size_t f = 0; f < given.at(i).size(); ++f) {
                const auto kind = memberOf(given.at(i).at(f), "kind").text();
                if (kind != "absent" && kind != "existing" && kind != "project" && kind != "projectMissingMedia"
                    && kind != "undecodable" && kind != "noAccess")
                    return "file kind " + kind + " is not established by this runner";
            }
            continue;
        }
        return "precondition given." + name + " is not established by this runner";
    }
    return {};
}

/** Establishes given.jobs: each job ends at once in its state, its id bound to its name. The projectSave and
    projectOpen jobs of the vectors are failed or cancelled jobs, which no request of this runner brings about. */
bool establishJobs(ControlJobs& jobs, const JsonValue& given, VectorMatcher& matcher)
{
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& spec = given.at(i);
        const auto state = memberOf(spec, "state").text();
        const auto& error = memberOf(spec, "error");
        ControlJobWork work;
        if (state == "failed") {
            ControlJobError failure{memberOf(error, "kind").text(), memberOf(error, "reason").text(),
                                    "a failed job of the fixture", false};
            work = [failure](ControlJobStep& step) { step.fail(failure); };
        } else if (state == "cancelled") {
            work = [](ControlJobStep& step) { step.cancel(); };
        } else {
            return false;
        }
        const auto started = jobs.start(memberOf(spec, "kind").text(), false, work);
        if (started.jobId.empty())
            return false;
        matcher.bindings[memberOf(spec, "bind").text()] = JsonValue::string(started.jobId);
        const std::string jobId = started.jobId;
        if (!pumpMessagesUntil(
                [&jobs, jobId, state] {
                    JsonValue job;
                    return jobs.get(jobId, job) == ControlJobs::Lookup::Found && memberOf(job, "state").text() == state;
                },
                kReadTimeoutMs))
            return false;
    }
    return true;
}

/** Runs one vector of the project methods against a fresh processor with a test bridge that owns a project session
    and a worker pool. Empty on success. */
std::string runProjectVector(const JsonValue& vector, const std::string& slug)
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    EditorParts editor(*processor);
    const auto& given = memberOf(vector, "given");
    const auto directory = projectDirectory("vectors-" + slug);
    VectorMatcher matcher;
    processor->getAppPreferences().clearRecentProjects();

    const auto& files = memberOf(given, "files");
    NoAccessFile noAccess; // restores the rights when the run ends
    for (std::size_t i = 0; i < files.size(); ++i) {
        const auto& file = files.at(i);
        const auto bind = memberOf(file, "bind").text();
        const auto kind = memberOf(file, "kind").text();
        const auto extension = file.find("extension") != nullptr ? memberOf(file, "extension").text() : ".wav";
        std::string path = (directory / (bind + extension)).u8string();
        if (kind == "noAccess") {
            if (noAccess.isLocked())
                return "the vector has a second noAccess file, which this runner cannot lock";
            path = noAccess.create(directory, bind + extension);
            if (path.empty())
                return "the file " + bind + " could not be made unreadable for this user";
        } else if (kind == "existing") {
            if (!juceFileOf(path).replaceWithText("an existing file"))
                return "the file " + bind + " could not be written";
        } else if (kind == "undecodable") {
            if (!juceFileOf(path).replaceWithText("these bytes are not a project"))
                return "the file " + bind + " could not be written";
        } else if (kind == "project" || kind == "projectMissingMedia") {
            if (!writeProjectFile(*processor, path, memberOf(file, "durationSec").asDouble(),
                                  kind == "projectMissingMedia"))
                return "the project file " + bind + " could not be written";
        }
        matcher.bindings[bind] = JsonValue::string(path);
    }
    const auto& clips = memberOf(given, "clips");
    std::vector<std::pair<std::string, Clip>> created;
    for (std::size_t i = 0; i < clips.size(); ++i) {
        const auto& spec = clips.at(i);
        const auto bind = memberOf(spec, "bind").text();
        ClipSpec clipSpec;
        clipSpec.name = uniqueName("clip-" + bind);
        clipSpec.trackId = static_cast<int>(memberOf(spec, "trackId").asDouble());
        clipSpec.startTimelineSec = memberOf(spec, "startTimelineSec").asDouble();
        clipSpec.durationSec = memberOf(spec, "durationSec").asDouble();
        auto clip = fixtureAddClip(*processor, clipSpec);
        if (!clip.key.isValid())
            return "the clip " + bind + " could not be added";
        created.emplace_back(bind, clip);
    }
    if (memberOf(given, "projectFile").isString()) {
        const auto bound = matcher.bindings.find(memberOf(given, "projectFile").text());
        if (bound == matcher.bindings.end())
            return "given.projectFile names no file";
        editor.session.setCurrentProjectFile(juceFileOf(bound->second.text()));
    }
    const auto& recent = memberOf(memberOf(given, "preferences"), "recentProjects");
    for (std::size_t i = recent.size(); i > 0; --i) {
        const auto bound = matcher.bindings.find(recent.at(i - 1).text());
        if (bound == matcher.bindings.end())
            return "given.preferences.recentProjects names no file";
        processor->getAppPreferences().pushRecentProject(juce::String::fromUTF8(bound->second.text().c_str()));
    }
    if (memberOf(given, "dirty").isBoolean() && memberOf(given, "dirty").asBoolean())
        editor.session.markDirty();
    if (!establishJobs(*service.jobs(), memberOf(given, "jobs"), matcher))
        return "given.jobs could not be established";

    ApiSession api;
    if (!api.open(service))
        return "session.hello failed";
    const auto& discovery = api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);
    if (!created.empty()) {
        const auto project = api.result("project.get");
        for (const auto& [bind, clip] : created) {
            const auto handles = fixtureHandlesOf(project, 0, 2.0);
            (void)clip;
            if (!handles)
                return "project.get does not list the clip " + bind;
            matcher.bindings[bind + ".contentId"] = JsonValue::string(handles->contentId);
            matcher.bindings[bind + ".placementId"] = JsonValue::string(handles->placementId);
        }
    }

    std::string failure;
    runWhilePumping(
        [&] {
            auto& connection = api.client();
            if (memberOf(vector, "type").text() == "request") {
                const auto request = matcher.substitute(memberOf(vector, "request"), failure);
                if (!failure.empty())
                    return;
                if (!connection.sendLine(toJsonString(request))) {
                    failure = "cannot send the request";
                    return;
                }
                failure = matcher.expectLine(connection, memberOf(vector, "response"));
                if (failure.empty() && memberOf(vector, "connectionAfter").text() == "open"
                    && !connection.staysQuiet(kOpenCheckMs))
                    failure = "the connection closed or sent more";
                return;
            }
            const auto& steps = memberOf(vector, "steps");
            for (std::size_t i = 0; i < steps.size() && failure.empty(); ++i) {
                const auto& step = steps.at(i);
                if (const JsonValue* send = step.find("send")) {
                    const auto value = matcher.substitute(*send, failure);
                    if (failure.empty() && !connection.sendLine(toJsonString(value)))
                        failure = "send failed";
                } else {
                    failure = matcher.expectLine(connection, memberOf(step, "expect"));
                }
                if (!failure.empty())
                    failure = "step " + std::to_string(i + 1) + ": " + failure;
            }
        },
        kJobExchangeMs);
    return failure;
}

/** The vectors of project/ for the project methods that must run and pass headless; the rest are listed as skipped
    with the reason (project/get-ok is a read, run by the Vectors scenario). */
const char* const kMustRunProjectVectors[] = {
    "project/clear-recent-empty",
    "project/clear-recent-ok",
    "project/job-failures",
    "project/open-discard",
    "project/open-job",
    "project/open-media-missing",
    "project/open-not-found",
    "project/open-ok",
    "project/open-unreadable",
    "project/open-unsaved-changes",
    "project/save-as-bad-extension",
    "project/save-as-confirm-required",
    "project/save-as-job",
    "project/save-as-new",
    "project/save-as-no-access",
    "project/save-as-overwrite",
    "project/save-job",
    "project/save-no-path",
    "project/save-ok",
};

} // namespace

void scenarioProjectVectors()
{
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors" / "project";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    int passed = 0;
    int skipped = 0;
    std::set<std::string> passedIds;
    VectorReport report("ControlProcessorTests.ProjectVectors");
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto& vector = parsed.value;
        const auto id = memberOf(vector, "id").text();
        if (const auto reason = projectVectorSkipReason(vector); !reason.empty()) {
            ++skipped;
            report.skip(id, reason);
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        auto slug = id;
        std::replace(slug.begin(), slug.end(), '/', '-');
        const auto failure = runProjectVector(vector, slug);
        report.ran(id, failure);
        if (CONTROL_CHECK(failure.empty())) {
            ++passed;
            passedIds.insert(id);
        }
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    report.write();
    for (const char* id : kMustRunProjectVectors)
        CONTROL_CHECK(passedIds.count(id) == 1);
    note(std::to_string(passed) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace ControlTest
} // namespace OpenTune
