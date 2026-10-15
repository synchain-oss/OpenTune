// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of the dispatcher and the read methods (session.info, project.get, content.getNotes,
// content.getPitchCurve, content.segmentNotes) against the real processor without a window or an audio
// device. Contents get a pitch analysis made of synthetic F0, committed the way OpenTune commits a
// finished analysis, so no model is needed. Requests go over a real session while the test thread, the
// message thread, pumps messages. Registered with the other processor scenarios in ControlProcessorTests.cpp.

#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Content/StandaloneClipContent.h"
#include "Content/StandaloneContentRepository.h"
#include "Control/ControlDispatcher.h"
#include "Control/ControlMessageThread.h"
#include "Control/Ops/OpsRegistry.h"
#include "Utils/DetectedKey.h"
#include "Utils/PitchCurve.h"
#include "Utils/PitchUtils.h"
#include "Utils/ProjectSession.h"
#include "Utils/TuningConfig.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <vector>

namespace OpenTune {
namespace ControlTest {

namespace {

/** Sample rate of the test audio (OpenTune stores audio at 44.1 kHz). */
constexpr double kAudioSampleRate = 44100.0;
/** Geometry of the synthetic pitch analysis, the one the F0 extractor produces: 16 kHz, hop 160. */
constexpr double kF0SampleRate = 16000.0;
constexpr int kF0HopSize = 160;
constexpr double kFrameSec = kF0HopSize / kF0SampleRate;
/** Pitch of the test audio, and of the analysis outside notes (A3). */
constexpr float kBaseHz = 220.0f;
/** Inside a note the detected pitch lies this far from the note's target, as a singer slightly flat. */
constexpr double kDetuneCents = -30.0;
/** The end of every analysed content is unvoiced (F0 0) for this long. */
constexpr double kUnvoicedTailSec = 0.5;
constexpr double kSecTolerance = 1e-6;
constexpr double kMidiTolerance = 1e-3;
/** A segment starts within this distance of the note the synthetic F0 holds (gap bridging, tails). */
constexpr double kSegmentEdgeTolerance = 0.06;
/** Number of analysis frames of a 6 s content. */
constexpr int kSixSecondFrames = 600;

// ---- Contents with a synthetic analysis --------------------------------------------------------

struct NoteSpec
{
    double startSec = 0.0;
    double endSec = 0.0;
    double targetMidi = 0.0;
};

enum class Analysis {
    NotRequested,
    Running,
    Failed,
    Ready
};

struct ClipSpec
{
    std::string name = "clip";
    int trackId = 0;
    double startTimelineSec = 0.0;
    double durationSec = 6.0;
    Analysis analysis = Analysis::Ready;
    std::vector<NoteSpec> notes;
    std::optional<DetectedKey> key;
};

struct Clip
{
    ContentKey key;
    std::uint64_t placementId = 0;
    std::string sourcePath;
};

float hzOf(double midi)
{
    return PitchUtils::midiToFreq(static_cast<float>(midi), TuningConfig::currentTuningHz());
}

double midiOf(float hz)
{
    return PitchUtils::freqToMidi(hz, TuningConfig::currentTuningHz());
}

double detectedMidiOf(double targetMidi)
{
    return targetMidi + kDetuneCents / 100.0;
}

juce::File juceFile(const std::filesystem::path& path)
{
    return juce::File(juce::String::fromUTF8(path.u8string().c_str()));
}

bool writeWav(const juce::File& file, const juce::AudioBuffer<float>& audio)
{
    file.deleteFile();
    std::unique_ptr<juce::OutputStream> stream(file.createOutputStream().release());
    if (stream == nullptr)
        return false;
    juce::WavAudioFormat wav;
    const auto options = juce::AudioFormatWriterOptions{}
                             .withSampleRate(kAudioSampleRate)
                             .withNumChannels(audio.getNumChannels())
                             .withBitsPerSample(16);
    auto writer = wav.createWriterFor(stream, options);
    return writer != nullptr && writer->writeFromAudioSampleBuffer(audio, 0, audio.getNumSamples());
}

/** F0 of a content: the base pitch, each note's detected pitch inside the note, an unvoiced tail. */
std::shared_ptr<PitchCurve> analysisOf(const ClipSpec& spec)
{
    const auto frames = static_cast<std::size_t>(std::llround(spec.durationSec / kFrameSec));
    std::vector<float> f0(frames, kBaseHz);
    for (const auto& note : spec.notes) {
        const auto first = static_cast<std::size_t>(std::ceil(note.startSec / kFrameSec - kSecTolerance));
        const auto end = static_cast<std::size_t>(std::ceil(note.endSec / kFrameSec - kSecTolerance));
        for (auto frame = first; frame < std::min(end, frames); ++frame)
            f0[frame] = hzOf(detectedMidiOf(note.targetMidi));
    }
    const auto tail = static_cast<std::size_t>(std::llround(kUnvoicedTailSec / kFrameSec));
    for (auto frame = frames > tail ? frames - tail : 0; frame < frames; ++frame)
        f0[frame] = 0.0f;
    auto curve = std::make_shared<PitchCurve>();
    curve->setHopSize(kF0HopSize);
    curve->setSampleRate(kF0SampleRate);
    curve->setOriginalF0(f0);
    return curve;
}

std::vector<Note> notesOf(const ClipSpec& spec)
{
    std::vector<Note> notes;
    for (const auto& noteSpec : spec.notes) {
        Note note; // OpenTune's default note parameters
        note.startTime = noteSpec.startSec;
        note.endTime = noteSpec.endSec;
        note.pitch = hzOf(noteSpec.targetMidi);
        note.originalPitch = hzOf(detectedMidiOf(noteSpec.targetMidi));
        note.isVoiced = true;
        notes.push_back(note);
    }
    return notes;
}

/**
 * Imports a clip of spec.durationSec seconds of a voiced tone, written as a WAV file into the test's data
 * directory, the way the editor imports (prepareImport, then commitPreparedImportAsPlacement), and gives
 * its content the requested analysis state. A Ready analysis follows the steps of the F0 completion in
 * OpenTuneAudioProcessor::requestContentRefresh with a synthetic curve: the curve goes to the content
 * owner (StandaloneClipContent::applyOriginalF0, which the processor's private writeOriginalF0ToOwner
 * calls for a Standalone clip), then the notes and the key, then the state Ready.
 */
Clip addClip(OpenTuneAudioProcessor& processor, const ClipSpec& spec)
{
    Clip clip;
    const auto samples = static_cast<int>(std::llround(spec.durationSec * kAudioSampleRate));
    juce::AudioBuffer<float> audio(1, samples);
    for (int i = 0; i < samples; ++i)
        audio.setSample(
            0, i,
            0.25f
                * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * kBaseHz * i / kAudioSampleRate)));
    const auto media = isolatedDataDirectory() / "media";
    std::error_code ignored;
    std::filesystem::create_directories(media, ignored);
    const auto file = juceFile(media / (spec.name + ".wav"));
    CONTROL_CHECK(writeWav(file, audio));
    clip.sourcePath = file.getFullPathName().toStdString();

    OpenTuneAudioProcessor::PreparedImport prepared;
    if (!CONTROL_CHECK(processor.prepareImport(std::move(audio), kAudioSampleRate, juce::String(spec.name),
                                               file.getFullPathName(), prepared)))
        return clip;
    OpenTuneAudioProcessor::ImportPlacement placement;
    placement.trackId = spec.trackId;
    placement.timelineStartSeconds = spec.startTimelineSec;
    const auto committed = processor.commitPreparedImportAsPlacement(std::move(prepared), placement);
    if (!CONTROL_CHECK(committed.isValid()))
        return clip;
    clip.key = committed.contentKey;
    clip.placementId = committed.placementId;

    switch (spec.analysis) {
        case Analysis::NotRequested:
            break;
        case Analysis::Running:
            CONTROL_CHECK(processor.setContentOriginalF0State(clip.key, OriginalF0State::Extracting));
            break;
        case Analysis::Failed:
            CONTROL_CHECK(processor.setContentOriginalF0State(clip.key, OriginalF0State::Failed));
            break;
        case Analysis::Ready: {
            auto* owner = processor.getStandaloneContentRepository()->findClip(clip.key);
            if (!CONTROL_CHECK(owner != nullptr))
                return clip;
            owner->applyOriginalF0(analysisOf(spec));
            if (!spec.notes.empty())
                CONTROL_CHECK(processor.replaceContentNotesForFullMutation(clip.key, notesOf(spec)));
            if (spec.key)
                CONTROL_CHECK(processor.setContentDetectedKey(clip.key, *spec.key));
            CONTROL_CHECK(processor.setContentOriginalF0State(clip.key, OriginalF0State::Ready));
            break;
        }
    }
    return clip;
}

/** A sung clip: on track 0 from 2 s to 8 s, three notes, key A minor (set by hand). */
ClipSpec sungSpec()
{
    ClipSpec spec;
    spec.name = "sung";
    spec.trackId = 0;
    spec.startTimelineSec = 2.0;
    spec.notes = {{0.5, 1.5, 64.0}, {2.0, 3.0, 69.0}, {3.5, 4.5, 69.3}};
    DetectedKey key;
    key.root = Key::A;
    key.scale = Scale::Minor;
    key.origin = Origin::Manual;
    spec.key = key;
    return spec;
}

ClipSpec unanalysedSpec(const char* name, int trackId, double start, Analysis analysis)
{
    ClipSpec spec;
    spec.name = name;
    spec.trackId = trackId;
    spec.startTimelineSec = start;
    spec.durationSec = 2.0;
    spec.analysis = analysis;
    return spec;
}

/** Saves the project and opens it again with the editor's two-phase flows (ProjectSession::prepareSave,
    executeSaveToFile, prepareOpen, commitPreparedOpen): opening clears the content repository. */
bool saveAndReopen(OpenTuneAudioProcessor& processor)
{
    ProjectSession session(processor, processor.getAppPreferences());
    const auto directory = isolatedDataDirectory() / "project";
    std::error_code ignored;
    std::filesystem::create_directories(directory, ignored);
    const auto file = juceFile(directory / "reads.otproj");
    auto task = session.prepareSave(file);
    if (!CONTROL_CHECK(ProjectSession::executeSaveToFile(task).ok()))
        return false;
    auto prepared = session.prepareOpen(file);
    if (!CONTROL_CHECK(prepared.ok()))
        return false;
    return CONTROL_CHECK(session.commitPreparedOpen(std::move(prepared).value()).ok());
}

// ---- Results ---------------------------------------------------------------------------------------

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

bool near(const JsonValue& value, double expected, double tolerance)
{
    return value.isNumber() && std::abs(value.asDouble() - expected) <= tolerance;
}

bool containsString(const JsonValue& array, const std::string& text)
{
    for (std::size_t i = 0; i < array.size(); ++i)
        if (array.at(i).isString() && array.at(i).text() == text)
            return true;
    return false;
}

const JsonValue& nullReason(const JsonValue& object, const char* member)
{
    return memberOf(memberOf(object, "nullReasons"), member);
}

/** The handles and tokens of one clip as project.get reports them. */
struct ClipHandles
{
    std::string contentId;
    std::string placementId;
    std::string geometryHash;
    JsonValue placement;
    JsonValue content;
    JsonValue tokens;
};

std::optional<ClipHandles> handlesOf(const JsonValue& project, int trackId, double startTimelineSec)
{
    const auto& placements = memberOf(project, "placements");
    for (std::size_t i = 0; i < placements.size(); ++i) {
        const auto& placement = placements.at(i);
        if (memberOf(placement, "trackId").asDouble() != trackId
            || !near(memberOf(placement, "startTimelineSec"), startTimelineSec, kSecTolerance))
            continue;
        ClipHandles handles;
        handles.placement = placement;
        handles.contentId = memberOf(placement, "contentId").text();
        handles.placementId = memberOf(placement, "placementId").text();
        handles.geometryHash = memberOf(placement, "geometryHash").text();
        const auto& contents = memberOf(project, "contents");
        for (std::size_t c = 0; c < contents.size(); ++c)
            if (memberOf(contents.at(c), "contentId").text() == handles.contentId)
                handles.content = contents.at(c);
        const auto& tokens = memberOf(memberOf(project, "asOf"), "contents");
        for (std::size_t c = 0; c < tokens.size(); ++c)
            if (memberOf(tokens.at(c), "contentId").text() == handles.contentId)
                handles.tokens = tokens.at(c);
        return handles;
    }
    return std::nullopt;
}

/** The contentEpoch part of a handle. */
std::string epochOf(const std::string& handle)
{
    const auto first = handle.find(':', 2);
    const auto second = handle.find(':', first + 1);
    return handle.substr(first + 1, second - first - 1);
}

/** A handle prefix of an instance that is not this one. */
std::string otherInstanceShort(const std::string& instanceShort)
{
    std::string other = instanceShort;
    other[0] = other[0] == '0' ? '1' : '0';
    return other;
}

// ---- The scenario of the reads ---------------------------------------------------------------------

void checkSessionInfo(ApiSession& api)
{
    const auto info = api.result("session.info");
    CONTROL_CHECK(memberOf(info, "protocol").text() == "1.0");
    CONTROL_CHECK(memberOf(info, "instanceId").text() == memberOf(api.discovery(), "instanceId").text());
    CONTROL_CHECK(memberOf(info, "appVersion").text() == memberOf(api.discovery(), "appVersion").text());
    CONTROL_CHECK(memberOf(info, "flavor").text() == "standalone");
    CONTROL_CHECK(VectorMatcher::equal(memberOf(info, "build"), memberOf(api.discovery(), "build")));
    CONTROL_CHECK(memberOf(info, "sourceUrl").text() == memberOf(api.discovery(), "sourceUrl").text());
    CONTROL_CHECK(memberOf(memberOf(info, "runtime"), "pid").asDouble()
                  == static_cast<double>(controlCurrentProcessId()));
    // Only the capabilities this build implements are reported.
    CONTROL_CHECK(toJsonString(memberOf(info, "capabilities")) == R"(["session.v1","read.v1","jobs.v1"])");

    // Without an editor the audio device is unknown; never omitted.
    const auto& device = memberOf(info, "audioDevice");
    CONTROL_CHECK(memberOf(device, "running").isBoolean() && !memberOf(device, "running").asBoolean());
    CONTROL_CHECK(memberOf(device, "name").isNull() && nullReason(device, "name").text() == "no_editor");
    CONTROL_CHECK(memberOf(device, "sampleRateHz").isNull()
                  && nullReason(device, "sampleRateHz").text() == "no_editor");

    const auto& processing = memberOf(info, "processing");
    CONTROL_CHECK(near(memberOf(processing, "tuningHz"), TuningConfig::currentTuningHz(), 1e-3));
    const auto scheme = memberOf(processing, "editingScheme").text();
    CONTROL_CHECK(scheme == "openTune" || scheme == "openDyne");
    CONTROL_CHECK(memberOf(processing, "f0Model").text() == "fcpe");
    CONTROL_CHECK(memberOf(processing, "vocoderReady").isBoolean() && memberOf(processing, "hybridMode").isBoolean());

    CONTROL_CHECK(containsString(memberOf(memberOf(info, "import"), "extensions"), ".wav"));
    CONTROL_CHECK(memberOf(memberOf(info, "import"), "maxChannels").asDouble() == 2);
    CONTROL_CHECK(
        toJsonString(memberOf(info, "export"))
        == R"({"formats":["wav"],"sampleRateHz":44100,"channels":{"clip":1,"track":1,"master":2},"sampleFormat":"float32"})");
    CONTROL_CHECK(memberOf(memberOf(info, "limits"), "dispatchTimeoutMs").asDouble()
                  == ControlLimits{}.dispatchTimeoutMs);
    // Not a read of project state: no asOf and no derived (PROTOCOL.md section 16 rule 5).
    CONTROL_CHECK(info.find("asOf") == nullptr && info.find("derived") == nullptr);
    CONTROL_CHECK(api.fails("session.info", json(R"({"verbose":true})"), "INVALID_ARGUMENT", "invalid_params"));
}

/** project.get without an editor; returns the result. */
JsonValue checkProjectWithoutEditor(ApiSession& api, OpenTuneAudioProcessor& processor, const Clip& sung)
{
    const auto project = api.result("project.get");
    const auto& asOf = memberOf(project, "asOf");
    CONTROL_CHECK(memberOf(asOf, "arrangementRevision").isString());
    CONTROL_CHECK(memberOf(asOf, "contents").size() == 4);
    CONTROL_CHECK(memberOf(project, "placements").size() == 4 && memberOf(project, "contents").size() == 4);

    // Values that belong to the editor: null with a reason, or computed and listed in derived.
    const auto& derived = memberOf(project, "derived");
    CONTROL_CHECK(memberOf(memberOf(project, "project"), "path").isNull());
    CONTROL_CHECK(!memberOf(memberOf(project, "project"), "dirty").asBoolean());
    CONTROL_CHECK(containsString(derived, "project.path") && containsString(derived, "project.dirty"));
    CONTROL_CHECK(containsString(derived, "visibleTrackCount") && containsString(derived, "tracks[].label"));
    CONTROL_CHECK(memberOf(project, "selection").isNull() && nullReason(project, "selection").text() == "no_editor");
    CONTROL_CHECK(memberOf(project, "history").isNull()
                  && nullReason(project, "history").text() == "capability_missing");
    // Track slots 0 to 2 hold clips, so at least three are visible.
    CONTROL_CHECK(memberOf(project, "visibleTrackCount").asDouble() == 3);

    const auto& tracks = memberOf(project, "tracks");
    if (CONTROL_CHECK(tracks.size() == static_cast<std::size_t>(processor.getStandaloneArrangement()->getNumTracks())
                      && tracks.size() >= 3)) {
        const auto& first = tracks.at(0);
        CONTROL_CHECK(memberOf(first, "trackId").asDouble() == 0 && memberOf(first, "label").text() == "Track 1");
        CONTROL_CHECK(memberOf(first, "placementCount").asDouble() == 1);
        CONTROL_CHECK(memberOf(tracks.at(1), "placementCount").asDouble() == 2);
        CONTROL_CHECK(memberOf(first, "visible").asBoolean());
        CONTROL_CHECK(memberOf(first, "rmsDb").isNull() && nullReason(first, "rmsDb").text() == "no_editor");
        CONTROL_CHECK(memberOf(first, "colour").text().size() == 7 && memberOf(first, "colour").text()[0] == '#');
        CONTROL_CHECK(memberOf(first, "volumeLinear").asDouble() >= 0);
    }

    const auto sungHandles = handlesOf(project, 0, 2.0);
    if (CONTROL_CHECK(sungHandles.has_value())) {
        const auto& placement = sungHandles->placement;
        const auto instanceShort = memberOf(api.discovery(), "instanceId").text().substr(0, 8);
        CONTROL_CHECK(sungHandles->contentId.rfind("c:" + instanceShort + ":", 0) == 0);
        CONTROL_CHECK(sungHandles->placementId.rfind("p:" + instanceShort + ":", 0) == 0);
        CONTROL_CHECK(near(memberOf(placement, "endTimelineSec"), 8.0, kSecTolerance));
        CONTROL_CHECK(near(memberOf(placement, "durationSec"), 6.0, kSecTolerance));
        CONTROL_CHECK(near(memberOf(placement, "clipInContentSec"), 0.0, kSecTolerance));
        CONTROL_CHECK(near(memberOf(placement, "gainDb"), 0.0, kSecTolerance));
        CONTROL_CHECK(near(memberOf(placement, "gainLinear"), 1.0, kSecTolerance));
        CONTROL_CHECK(memberOf(placement, "referencePlacementId").isNull());
        CONTROL_CHECK(memberOf(placement, "name").text() == "sung");
        CONTROL_CHECK(memberOf(placement, "sourcePath").text() == sung.sourcePath);
        CONTROL_CHECK(!sungHandles->geometryHash.empty());

        const auto& content = sungHandles->content;
        CONTROL_CHECK(memberOf(content, "f0State").text() == "ready");
        CONTROL_CHECK(toJsonString(memberOf(content, "key"))
                      == R"({"root":9,"scale":"minor","origin":"manual","confidence":null})");
        CONTROL_CHECK(memberOf(content, "noteCount").asDouble() == 3);
        CONTROL_CHECK(toJsonString(memberOf(content, "pitchShift")) == R"({"semitones":0,"cents":0})");
        CONTROL_CHECK(memberOf(content, "timeGridIdentity").asBoolean());
        CONTROL_CHECK(memberOf(sungHandles->tokens, "revision").isString()
                      && memberOf(sungHandles->tokens, "gridRevision").isString()
                      && memberOf(sungHandles->tokens, "keyRevision").isString());
    }
    // Contents without a finished analysis: the state says why, the key is null with a reason.
    const std::pair<std::pair<int, double>, const char*> states[] = {
        {{1, 0.0}, "notRequested"}, {{1, 3.0}, "extracting"}, {{2, 0.0}, "failed"}};
    for (const auto& [where, state] : states) {
        const auto handles = handlesOf(project, where.first, where.second);
        if (!CONTROL_CHECK(handles.has_value()))
            continue;
        CONTROL_CHECK(memberOf(handles->content, "f0State").text() == state);
        CONTROL_CHECK(memberOf(handles->content, "key").isNull()
                      && nullReason(handles->content, "key").text() == "not_analyzed");
        CONTROL_CHECK(memberOf(handles->content, "noteCount").asDouble() == 0);
    }

    const auto& transport = memberOf(project, "transport");
    CONTROL_CHECK(!memberOf(transport, "playing").asBoolean()
                  && !memberOf(transport, "audioDeviceRunning").asBoolean());
    CONTROL_CHECK(near(memberOf(transport, "bpm"), processor.getBpm(), 1e-3));
    CONTROL_CHECK(memberOf(memberOf(transport, "timeSignature"), "numerator").asDouble()
                  == processor.getTimeSigNumerator());
    CONTROL_CHECK(project.find("lastControl") == nullptr && transport.find("lastControl") != nullptr);
    return project;
}

/** project.get with an editor bridge: the project file, the selection and the view come from it. */
void checkProjectWithEditor(ApiSession& api, ControlService& service, const Clip& sung, const ClipHandles& handles)
{
    TestUiBridge bridge;
    bridge.project.projectPath = (isolatedDataDirectory() / "song.otproj").u8string();
    bridge.project.dirty = true;
    bridge.selection = {sung.placementId};
    bridge.view.workspace = "pianoRoll";
    bridge.view.pianoRollPlacementId = sung.placementId;
    bridge.visibleTracks = 4;
    service.setUiBridge(&bridge);
    const auto project = api.result("project.get");
    service.setUiBridge(nullptr);

    const auto& derived = memberOf(project, "derived");
    CONTROL_CHECK(memberOf(memberOf(project, "project"), "path").text() == bridge.project.projectPath);
    CONTROL_CHECK(memberOf(memberOf(project, "project"), "dirty").asBoolean());
    CONTROL_CHECK(!containsString(derived, "project.path") && !containsString(derived, "visibleTrackCount"));
    const auto& selection = memberOf(project, "selection");
    CONTROL_CHECK(toJsonString(memberOf(selection, "selectedPlacementIds")) == "[" + quoted(handles.placementId) + "]");
    CONTROL_CHECK(memberOf(selection, "pianoRollContentId").text() == handles.contentId);
    CONTROL_CHECK(nullReason(project, "selection").isNull());
    CONTROL_CHECK(memberOf(project, "visibleTrackCount").asDouble() == 4);
    const auto& tracks = memberOf(project, "tracks");
    if (tracks.size() > 4)
        CONTROL_CHECK(memberOf(tracks.at(3), "visible").asBoolean() && !memberOf(tracks.at(4), "visible").asBoolean());
    // A bridge without access to the audio device: unknown, not "no editor".
    CONTROL_CHECK(nullReason(tracks.at(0), "rmsDb").text() == "unavailable");
}

void checkNotes(ApiSession& api, OpenTuneAudioProcessor& processor, const Clip& sung, const ClipHandles& handles)
{
    const auto byContent = "\"contentId\":" + quoted(handles.contentId);
    const auto byPlacement = "\"placementId\":" + quoted(handles.placementId);
    const auto spec = sungSpec();
    const char* const labels[] = {"#0 E4 0.50-1.50s", "#1 A4 2.00-3.00s", "#2 A4 3.50-4.50s"};

    const auto all = api.result("content.getNotes", json("{" + byContent + "}"));
    CONTROL_CHECK(memberOf(all, "contentId").text() == handles.contentId && memberOf(all, "placementId").isNull());
    CONTROL_CHECK(toJsonString(memberOf(memberOf(all, "asOf"), "contents"))
                  == "[" + toJsonString(handles.tokens) + "]");
    CONTROL_CHECK(near(memberOf(all, "tuningHz"), TuningConfig::currentTuningHz(), 1e-3));
    CONTROL_CHECK(memberOf(all, "totalCount").asDouble() == 3 && memberOf(all, "nextCursor").isNull());
    CONTROL_CHECK(containsString(memberOf(all, "derived"), "notes[].label"));
    const auto& notes = memberOf(all, "notes");
    if (CONTROL_CHECK(notes.size() == 3))
        for (std::size_t i = 0; i < 3; ++i) {
            const auto& note = notes.at(i);
            CONTROL_CHECK(memberOf(note, "index").asDouble() == static_cast<double>(i));
            CONTROL_CHECK(memberOf(note, "label").text() == labels[i]);
            CONTROL_CHECK(near(memberOf(note, "startContentSec"), spec.notes[i].startSec, kSecTolerance));
            CONTROL_CHECK(near(memberOf(note, "endContentSec"), spec.notes[i].endSec, kSecTolerance));
            CONTROL_CHECK(memberOf(note, "startTimelineSec").isNull() && memberOf(note, "endTimelineSec").isNull());
            CONTROL_CHECK(near(memberOf(note, "targetMidi"), spec.notes[i].targetMidi, kMidiTolerance));
            CONTROL_CHECK(
                near(memberOf(note, "detectedMidi"), detectedMidiOf(spec.notes[i].targetMidi), kMidiTolerance));
            CONTROL_CHECK(near(memberOf(note, "offsetCents"), 0.0, kMidiTolerance));
            CONTROL_CHECK(memberOf(note, "voiced").asBoolean() && !memberOf(note, "corrected").asBoolean());
            CONTROL_CHECK(memberOf(note, "retuneSpeed").isNumber() && memberOf(note, "vibratoRateHz").isNumber());
        }

    // By placement: timeline times through it, and a timeline range (4.0-4.6 s is content 2.0-2.6 s).
    const auto timeline = api.result(
        "content.getNotes", json("{" + byPlacement + R"(,"range":{"startTimelineSec":4,"endTimelineSec":4.6}})"));
    CONTROL_CHECK(memberOf(timeline, "placementId").text() == handles.placementId);
    CONTROL_CHECK(memberOf(timeline, "contentId").text() == handles.contentId);
    CONTROL_CHECK(memberOf(timeline, "totalCount").asDouble() == 1);
    if (CONTROL_CHECK(memberOf(timeline, "notes").size() == 1)) {
        const auto& note = memberOf(timeline, "notes").at(0);
        CONTROL_CHECK(memberOf(note, "index").asDouble() == 1);
        CONTROL_CHECK(near(memberOf(note, "startTimelineSec"), 4.0, kSecTolerance));
        CONTROL_CHECK(near(memberOf(note, "endTimelineSec"), 5.0, kSecTolerance));
    }
    // A content range keeps the notes that overlap it; indexes stay those of all notes.
    const auto ranged = api.result("content.getNotes",
                                   json("{" + byContent + R"(,"range":{"startContentSec":1.8,"endContentSec":3.6}})"));
    CONTROL_CHECK(memberOf(ranged, "totalCount").asDouble() == 2);
    if (CONTROL_CHECK(memberOf(ranged, "notes").size() == 2))
        CONTROL_CHECK(memberOf(memberOf(ranged, "notes").at(0), "index").asDouble() == 1
                      && memberOf(memberOf(ranged, "notes").at(1), "index").asDouble() == 2);

    // Pagination: one note per page, the cursor carries the position.
    std::vector<double> indexes;
    JsonValue cursor;
    for (int page = 0; page < 3; ++page) {
        const auto params =
            "{" + byContent + R"(,"limit":1)" + (cursor.isString() ? ",\"cursor\":" + quoted(cursor.text()) : "") + "}";
        const auto result = api.result("content.getNotes", json(params));
        CONTROL_CHECK(memberOf(result, "totalCount").asDouble() == 3 && memberOf(result, "notes").size() == 1);
        if (memberOf(result, "notes").size() == 1)
            indexes.push_back(memberOf(memberOf(result, "notes").at(0), "index").asDouble());
        cursor = memberOf(result, "nextCursor");
        CONTROL_CHECK(cursor.isString() == (page < 2));
    }
    CONTROL_CHECK((indexes == std::vector<double>{0, 1, 2}));

    // A cursor is bound to the selection params of its method and to the tokens of its read.
    const auto first = api.result("content.getNotes", json("{" + byContent + R"(,"limit":1})"));
    const auto next = memberOf(first, "nextCursor").text();
    CONTROL_CHECK(api.fails(
        "content.getNotes",
        json("{" + byContent + R"(,"range":{"startContentSec":0,"endContentSec":9},"cursor":)" + quoted(next) + "}"),
        "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("content.getPitchCurve", json("{" + byContent + ",\"cursor\":" + quoted(next) + "}"),
                            "INVALID_ARGUMENT", "invalid_params"));
    // The notes change on the message thread (as an edit in the piano roll would change them): stale.
    auto changed = notesOf(spec);
    changed[2].retuneSpeed = 0.25f;
    CONTROL_CHECK(processor.replaceContentNotesForFullMutation(sung.key, changed));
    CONTROL_CHECK(api.fails("content.getNotes", json("{" + byContent + ",\"cursor\":" + quoted(next) + "}"),
                            "REVISION_CONFLICT", "cursor_stale"));
    const auto after = api.result("content.getNotes", json("{" + byContent + "}"));
    const auto& afterTokens = memberOf(memberOf(after, "asOf"), "contents").at(0);
    CONTROL_CHECK(memberOf(afterTokens, "revision").text() != memberOf(handles.tokens, "revision").text());
    // A notes change does not change the key or the grid (PROTOCOL.md section 10 rule 2).
    CONTROL_CHECK(memberOf(afterTokens, "keyRevision").text() == memberOf(handles.tokens, "keyRevision").text());
    CONTROL_CHECK(memberOf(afterTokens, "gridRevision").text() == memberOf(handles.tokens, "gridRevision").text());
}

void checkPitchCurve(ApiSession& api, const ClipHandles& handles)
{
    const auto byContent = "\"contentId\":" + quoted(handles.contentId);
    const double baseMidi = midiOf(kBaseHz);
    const double noteMidi = detectedMidiOf(64.0);

    const auto full = api.result("content.getPitchCurve", json("{" + byContent + "}"));
    CONTROL_CHECK(memberOf(full, "f0State").text() == "ready");
    CONTROL_CHECK(near(memberOf(full, "hopSec"), kFrameSec, 1e-9) && memberOf(full, "stepFrame").asDouble() == 1);
    CONTROL_CHECK(near(memberOf(full, "startContentSec"), 0.0, kSecTolerance));
    CONTROL_CHECK(memberOf(full, "pointCount").asDouble() == kSixSecondFrames && memberOf(full, "nextCursor").isNull());
    const auto& original = memberOf(full, "originalMidi");
    const auto& corrected = memberOf(full, "correctedMidi");
    if (CONTROL_CHECK(original.size() == kSixSecondFrames && corrected.size() == kSixSecondFrames)) {
        CONTROL_CHECK(near(original.at(10), baseMidi, kMidiTolerance));
        CONTROL_CHECK(near(original.at(60), noteMidi, kMidiTolerance));
        // Nothing is corrected: the rendered pitch is the original one.
        CONTROL_CHECK(near(corrected.at(60), noteMidi, kMidiTolerance)
                      && near(corrected.at(10), baseMidi, kMidiTolerance));
        // The unvoiced tail has no pitch on either curve.
        CONTROL_CHECK(original.at(kSixSecondFrames - 1).isNull() && corrected.at(kSixSecondFrames - 1).isNull());
    }
    CONTROL_CHECK(containsString(memberOf(full, "derived"), "originalMidi"));

    // Every 10th frame, and a range of 0.1 s at full resolution.
    const auto sparse = api.result("content.getPitchCurve", json("{" + byContent + R"(,"stepFrame":10})"));
    CONTROL_CHECK(memberOf(sparse, "pointCount").asDouble() == kSixSecondFrames / 10);
    CONTROL_CHECK(near(memberOf(sparse, "originalMidi").at(6), noteMidi, kMidiTolerance));
    const auto range = api.result("content.getPitchCurve",
                                  json("{" + byContent + R"(,"range":{"startContentSec":0.5,"endContentSec":0.6}})"));
    CONTROL_CHECK(near(memberOf(range, "startContentSec"), 0.5, kSecTolerance));
    CONTROL_CHECK(memberOf(range, "pointCount").asDouble() == 10);

    // Pages of 250 values: 250, 250, 100; each page starts where the previous one ended.
    JsonValue cursor;
    std::vector<double> counts;
    std::vector<double> starts;
    for (int page = 0; page < 3; ++page) {
        const auto params = "{" + byContent + R"(,"limit":250)"
                            + (cursor.isString() ? ",\"cursor\":" + quoted(cursor.text()) : "") + "}";
        const auto result = api.result("content.getPitchCurve", json(params));
        counts.push_back(memberOf(result, "pointCount").asDouble());
        starts.push_back(std::round(memberOf(result, "startContentSec").asDouble() * 1000.0) / 1000.0);
        cursor = memberOf(result, "nextCursor");
    }
    CONTROL_CHECK((counts == std::vector<double>{250, 250, 100}) && cursor.isNull());
    CONTROL_CHECK((starts == std::vector<double>{0.0, 2.5, 5.0}));
    // The cursor is bound to stepFrame, a selection param.
    const auto first = api.result("content.getPitchCurve", json("{" + byContent + R"(,"limit":250})"));
    CONTROL_CHECK(api.fails(
        "content.getPitchCurve",
        json("{" + byContent + R"(,"stepFrame":2,"cursor":)" + quoted(memberOf(first, "nextCursor").text()) + "}"),
        "INVALID_ARGUMENT", "invalid_params"));
}

void checkSegmentNotes(ApiSession& api, const ClipHandles& handles)
{
    const auto byContent = "\"contentId\":" + quoted(handles.contentId);
    const auto before = api.result("content.getNotes", json("{" + byContent + "}"));
    const auto result = api.result("content.segmentNotes", json("{" + byContent + R"(,"noteSplitCents":80})"));
    CONTROL_CHECK(memberOf(result, "f0State").text() == "ready" && near(memberOf(result, "noteSplitCents"), 80, 1e-9));
    const auto& segments = memberOf(result, "segments");
    CONTROL_CHECK(segments.size() >= 3);
    bool foundFirstNote = false;
    bool foundSecondNote = false;
    for (std::size_t i = 0; i < segments.size(); ++i) {
        const auto& segment = segments.at(i);
        const double start = memberOf(segment, "startContentSec").asDouble();
        const double end = memberOf(segment, "endContentSec").asDouble();
        const double midi = memberOf(segment, "detectedMidi").asDouble();
        CONTROL_CHECK(start >= 0.0 && end > start && end <= 6.0 + kSecTolerance);
        foundFirstNote =
            foundFirstNote
            || (std::abs(midi - detectedMidiOf(64.0)) < 0.05 && std::abs(start - 0.5) < kSegmentEdgeTolerance);
        foundSecondNote =
            foundSecondNote
            || (std::abs(midi - detectedMidiOf(69.0)) < 0.05 && std::abs(start - 2.0) < kSegmentEdgeTolerance);
    }
    CONTROL_CHECK(foundFirstNote && foundSecondNote);
    // Nothing is stored: the tokens of the content stay as they were.
    CONTROL_CHECK(toJsonString(memberOf(result, "asOf")) == toJsonString(memberOf(before, "asOf")));
    const auto after = api.result("content.getNotes", json("{" + byContent + "}"));
    CONTROL_CHECK(toJsonString(memberOf(after, "asOf")) == toJsonString(memberOf(before, "asOf")));

    // Without noteSplitCents the generator's default is used and reported; a range keeps overlapping segments.
    const auto ranged = api.result("content.segmentNotes",
                                   json("{" + byContent + R"(,"range":{"startContentSec":2,"endContentSec":3}})"));
    CONTROL_CHECK(near(memberOf(ranged, "noteSplitCents"), PitchControlConfig::kDefaultNoteSplitCents, 1e-9));
    const auto& kept = memberOf(ranged, "segments");
    CONTROL_CHECK(kept.size() >= 1);
    for (std::size_t i = 0; i < kept.size(); ++i)
        CONTROL_CHECK(memberOf(kept.at(i), "endContentSec").asDouble() > 2.0
                      && memberOf(kept.at(i), "startContentSec").asDouble() < 3.0);
}

/** Reads are not gated (PROTOCOL.md section 11): without a finished analysis the arrays are empty and
    f0State says why. */
void checkUnanalysed(ApiSession& api, const JsonValue& project)
{
    const std::pair<std::pair<int, double>, const char*> states[] = {
        {{1, 0.0}, "notRequested"}, {{1, 3.0}, "extracting"}, {{2, 0.0}, "failed"}};
    for (const auto& [where, state] : states) {
        const auto handles = handlesOf(project, where.first, where.second);
        if (!CONTROL_CHECK(handles.has_value()))
            continue;
        const auto byContent = "{\"contentId\":" + quoted(handles->contentId) + "}";
        const auto curve = api.result("content.getPitchCurve", json(byContent));
        CONTROL_CHECK(memberOf(curve, "f0State").text() == state);
        CONTROL_CHECK(memberOf(curve, "pointCount").asDouble() == 0 && memberOf(curve, "originalMidi").size() == 0
                      && memberOf(curve, "correctedMidi").size() == 0 && memberOf(curve, "nextCursor").isNull());
        CONTROL_CHECK(memberOf(curve, "hopSec").asDouble() > 0 && containsString(memberOf(curve, "derived"), "hopSec"));
        const auto segments = api.result("content.segmentNotes", json(byContent));
        CONTROL_CHECK(memberOf(segments, "f0State").text() == state && memberOf(segments, "segments").size() == 0);
        const auto notes = api.result("content.getNotes", json(byContent));
        CONTROL_CHECK(memberOf(notes, "totalCount").asDouble() == 0 && memberOf(notes, "notes").size() == 0);
    }
}

/** Errors of the checks before a method runs; every one has executed false. */
void checkErrors(ApiSession& api, const ClipHandles& handles)
{
    const auto instanceShort = memberOf(api.discovery(), "instanceId").text().substr(0, 8);
    const auto epoch = epochOf(handles.contentId);
    const auto unknownContent = quoted("c:" + instanceShort + ":" + epoch + ":4294967295");
    const auto unknownPlacement = quoted("p:" + instanceShort + ":" + epoch + ":4294967295");
    const auto otherContent = quoted("c:" + otherInstanceShort(instanceShort) + ":" + epoch + ":1");
    const auto otherEpoch = quoted("c:" + instanceShort + ":" + std::to_string(std::stoull(epoch) + 1) + ":1");
    const auto content = quoted(handles.contentId);
    const auto placement = quoted(handles.placementId);

    CONTROL_CHECK(
        api.fails("content.getNotes", json("{\"contentId\":" + unknownContent + "}"), "NOT_FOUND", "unknown_handle"));
    CONTROL_CHECK(api.fails("content.getNotes", json("{\"placementId\":" + unknownPlacement + "}"), "NOT_FOUND",
                            "unknown_handle"));
    CONTROL_CHECK(
        api.fails("content.getPitchCurve", json("{\"contentId\":" + otherContent + "}"), "NOT_FOUND", "stale_handle"));
    CONTROL_CHECK(
        api.fails("content.segmentNotes", json("{\"contentId\":" + otherEpoch + "}"), "NOT_FOUND", "stale_handle"));
    // A handle of one kind where the other is expected fails the form check (PROTOCOL.md section 9 rule 1).
    CONTROL_CHECK(
        api.fails("content.getNotes", json("{\"contentId\":" + placement + "}"), "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(
        api.fails("content.getNotes", json("{\"placementId\":" + content + "}"), "INVALID_ARGUMENT", "invalid_params"));
    const char* const invalidNotes[] = {
        "{}",
        R"({"contentId":CONTENT,"placementId":PLACEMENT})",
        R"({"contentId":CONTENT,"range":{"startTimelineSec":1,"endTimelineSec":2}})",
        R"({"contentId":CONTENT,"range":{"startContentSec":1}})",
        R"({"contentId":CONTENT,"range":{"startContentSec":-1,"endContentSec":2}})",
        R"({"contentId":CONTENT,"limit":0})",
        R"({"contentId":CONTENT,"limit":501})",
        R"({"contentId":CONTENT,"limit":1.5})",
        R"({"contentId":CONTENT,"cursor":""})",
        R"({"contentId":CONTENT,"cursor":"not-a-cursor"})",
        R"({"contentId":CONTENT,"verbose":true})",
    };
    for (std::string params : invalidNotes) {
        for (const auto& [name, value] :
             {std::pair<std::string, std::string>{"CONTENT", content}, {"PLACEMENT", placement}})
            for (auto at = params.find(name); at != std::string::npos; at = params.find(name))
                params.replace(at, name.size(), value);
        CONTROL_CHECK(api.fails("content.getNotes", json(params), "INVALID_ARGUMENT", "invalid_params"));
    }
    CONTROL_CHECK(api.fails("content.getPitchCurve", json("{\"contentId\":" + content + ",\"stepFrame\":0}"),
                            "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("content.getPitchCurve", json("{\"contentId\":" + content + ",\"limit\":10001}"),
                            "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("content.getPitchCurve", json("{\"placementId\":" + placement + "}"), "INVALID_ARGUMENT",
                            "invalid_params"));
    CONTROL_CHECK(api.fails("content.segmentNotes", json("{\"contentId\":" + content + ",\"noteSplitCents\":201}"),
                            "INVALID_ARGUMENT", "invalid_params"));
    CONTROL_CHECK(api.fails("project.get", json(R"({"verbose":true})"), "INVALID_ARGUMENT", "invalid_params"));
    // Methods of a reported capability that a later part implements, a method of a capability this build
    // does not report yet, and a method the protocol does not define.
    CONTROL_CHECK(
        api.fails("content.getDetails", json("{\"contentId\":" + content + "}"), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(api.fails("transport.get", JsonValue::object(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(api.fails("export.start", JsonValue::object(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(api.fails("track.rename", JsonValue::object(), "UNSUPPORTED", "unknown_method"));
}

/** Opening a project discards every content: the handles from before are stale, the new ones work. */
void checkReopen(ApiSession& api, OpenTuneAudioProcessor& processor, const ClipHandles& before)
{
    const auto epochBefore = processor.getStandaloneContentRepository()->getContentEpoch();
    if (!saveAndReopen(processor))
        return;
    CONTROL_CHECK(processor.getStandaloneContentRepository()->getContentEpoch() == epochBefore + 1);
    CONTROL_CHECK(api.fails("content.getNotes", json("{\"contentId\":" + quoted(before.contentId) + "}"), "NOT_FOUND",
                            "stale_handle"));
    CONTROL_CHECK(api.fails("content.getNotes", json("{\"placementId\":" + quoted(before.placementId) + "}"),
                            "NOT_FOUND", "stale_handle"));
    const auto project = api.result("project.get");
    const auto after = handlesOf(project, 0, 2.0);
    if (!CONTROL_CHECK(after.has_value()))
        return;
    CONTROL_CHECK(after->contentId != before.contentId && after->placementId != before.placementId);
    CONTROL_CHECK(epochOf(after->contentId) == std::to_string(epochBefore + 1));
    const auto notes = api.result("content.getNotes", json("{\"contentId\":" + quoted(after->contentId) + "}"));
    CONTROL_CHECK(memberOf(notes, "contentId").text() == after->contentId);
}

// ---- The specification's vectors ------------------------------------------------------------------

/** The methods this build implements; the runner runs the vectors that use only these. */
const std::set<std::string> kImplementedMethods = {"session.info", "project.get", "content.getNotes",
                                                   "content.getPitchCurve", "content.segmentNotes"};
const std::set<std::string> kReportedCapabilities = {"session.v1", "read.v1"};

/** The methods a vector sends. */
std::vector<std::string> methodsOf(const JsonValue& vector)
{
    std::vector<std::string> methods;
    if (const JsonValue* request = vector.find("request"))
        methods.push_back(memberOf(*request, "method").text());
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i)
            if (const JsonValue* send = steps->at(i).find("send"))
                methods.push_back(memberOf(*send, "method").text());
    return methods;
}

/** Why this runner does not run a vector, or empty when it does. */
std::string vectorSkipReason(const JsonValue& vector)
{
    if (kReportedCapabilities.count(memberOf(vector, "capability").text()) == 0)
        return "needs capability " + memberOf(vector, "capability").text() + ", which a later part implements";
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (kReportedCapabilities.count(extra.at(i).text()) == 0)
            return "needs capability " + extra.at(i).text() + ", which a later part implements";
    const auto methods = methodsOf(vector);
    bool usesImplemented = false;
    for (const auto& method : methods) {
        if (kImplementedMethods.count(method) != 0)
            usesImplemented = true;
        else if (controlMethodCapability(method) != nullptr && method != "session.hello")
            return "uses " + method + ", which a later part implements";
    }
    if (!usesImplemented)
        return "tests the listener only (ControlUnitTests runs it against the channel)";
    if (memberOf(vector, "session").text() != "authenticated")
        return "unauthenticated vectors test the listener (ControlUnitTests)";
    if (const JsonValue* steps = vector.find("steps"))
        for (std::size_t i = 0; i < steps->size(); ++i) {
            const auto& step = steps->at(i);
            if ((step.find("send") == nullptr && step.find("expect") == nullptr) || step.find("connection") != nullptr)
                return "uses steps other than send and expect on the main connection";
        }
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name == "dirty" && !given.at(i).asBoolean())
            continue; // without an editor the project has no unsaved changes
        if (name != "clips")
            return "precondition given." + name + " is not established by this runner";
        for (std::size_t c = 0; c < given.at(i).size(); ++c) {
            const auto& clip = given.at(i).at(c);
            if (memberOf(clip, "analysis").text() != "ready")
                return "a clip with analysis " + memberOf(clip, "analysis").text()
                       + " is not established by this runner";
            for (const char* member : {"pitchShift", "timeGrid", "referenceClip"})
                if (clip.find(member) != nullptr)
                    return std::string("clip member ") + member + " is not established by this runner";
        }
    }
    return {};
}

std::optional<Scale> scaleOf(const std::string& name)
{
    const std::pair<const char*, Scale> scales[] = {{"major", Scale::Major},
                                                    {"minor", Scale::Minor},
                                                    {"chromatic", Scale::Chromatic},
                                                    {"harmonicMinor", Scale::HarmonicMinor},
                                                    {"dorian", Scale::Dorian},
                                                    {"mixolydian", Scale::Mixolydian},
                                                    {"pentatonicMajor", Scale::PentatonicMajor},
                                                    {"pentatonicMinor", Scale::PentatonicMinor}};
    for (const auto& [text, scale] : scales)
        if (name == text)
            return scale;
    return std::nullopt;
}

/**
 * Runs one vector (request, or scenario of send and expect steps) against a fresh processor: establishes
 * given.clips, binds the names of vectors/README.md (discovery.*, runner.*, <clip>.*), then sends and
 * matches on a client thread while this thread pumps messages. Empty on success.
 */
std::string runVector(const JsonValue& vector)
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return "the control API did not start";
    VectorMatcher matcher;

    std::vector<std::pair<std::string, ClipSpec>> specs;
    const auto& clips = memberOf(memberOf(vector, "given"), "clips");
    for (std::size_t i = 0; i < clips.size(); ++i) {
        const auto& given = clips.at(i);
        ClipSpec spec;
        spec.name = memberOf(given, "bind").text();
        spec.trackId = static_cast<int>(memberOf(given, "trackId").asDouble());
        spec.startTimelineSec = memberOf(given, "startTimelineSec").asDouble();
        spec.durationSec = memberOf(given, "durationSec").asDouble();
        const auto& notes = memberOf(given, "notes");
        for (std::size_t n = 0; n < notes.size(); ++n)
            spec.notes.push_back({memberOf(notes.at(n), "startContentSec").asDouble(),
                                  memberOf(notes.at(n), "endContentSec").asDouble(),
                                  memberOf(notes.at(n), "targetMidi").asDouble()});
        if (const JsonValue* key = given.find("key")) {
            DetectedKey detected;
            detected.root = static_cast<Key>(static_cast<int>(memberOf(*key, "root").asDouble()));
            detected.scale = scaleOf(memberOf(*key, "scale").text()).value_or(Scale::Major);
            detected.origin = Origin::Manual;
            spec.key = detected;
        }
        specs.emplace_back(spec.name, spec);
    }
    std::vector<std::pair<std::string, Clip>> created;
    for (const auto& [bind, spec] : specs)
        created.emplace_back(bind, addClip(*processor, spec));

    ApiSession api;
    if (!api.open(service))
        return "session.hello failed";
    const auto& discovery = api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);
    const auto instanceShort = memberOf(discovery, "instanceId").text().substr(0, 8);
    const auto epoch = std::to_string(processor->getStandaloneContentRepository()->getContentEpoch());
    const auto other = otherInstanceShort(instanceShort);
    matcher.bindings["runner.unknownContentId"] = JsonValue::string("c:" + instanceShort + ":" + epoch + ":4294967295");
    matcher.bindings["runner.unknownPlacementId"] =
        JsonValue::string("p:" + instanceShort + ":" + epoch + ":4294967295");
    matcher.bindings["runner.staleContentId"] = JsonValue::string("c:" + other + ":" + epoch + ":1");
    matcher.bindings["runner.stalePlacementId"] = JsonValue::string("p:" + other + ":" + epoch + ":1");
    const int lastTrack = processor->getStandaloneArrangement()->getNumTracks() - 1;
    matcher.bindings["runner.lastTrackId"] = JsonValue::integer(lastTrack);
    matcher.bindings["runner.unknownTrackId"] = JsonValue::integer(lastTrack + 1);

    // The handles and tokens of the clips after the preconditions, as the instance reports them.
    if (!created.empty()) {
        const auto project = api.result("project.get");
        for (std::size_t i = 0; i < created.size(); ++i) {
            const auto& [bind, clip] = created[i];
            const auto handles = handlesOf(project, specs[i].second.trackId, specs[i].second.startTimelineSec);
            if (!handles)
                return "the clip " + bind + " is not in project.get";
            matcher.bindings[bind + ".contentId"] = JsonValue::string(handles->contentId);
            matcher.bindings[bind + ".placementId"] = JsonValue::string(handles->placementId);
            matcher.bindings[bind + ".geometryHash"] = JsonValue::string(handles->geometryHash);
            matcher.bindings[bind + ".sourcePath"] = JsonValue::string(clip.sourcePath);
            for (const char* token : {"revision", "gridRevision", "keyRevision"})
                matcher.bindings[bind + "." + token] = memberOf(handles->tokens, token);
        }
    }

    std::string failure;
    runWhilePumping([&] {
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
    });
    processor.reset();
    return failure;
}

} // namespace

// ---- Scenarios -------------------------------------------------------------------------------------

void scenarioReads()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    const auto dispatcher = service.dispatcher();
    if (!CONTROL_CHECK(dispatcher != nullptr))
        return;
    for (const auto& method : kImplementedMethods)
        CONTROL_CHECK(dispatcher->implements(method));
    CONTROL_CHECK(!dispatcher->implements("content.getDetails") && !dispatcher->implements("session.hello"));
    const auto sung = addClip(*processor, sungSpec());
    addClip(*processor, unanalysedSpec("pending", 1, 0.0, Analysis::NotRequested));
    addClip(*processor, unanalysedSpec("running", 1, 3.0, Analysis::Running));
    addClip(*processor, unanalysedSpec("failed", 2, 0.0, Analysis::Failed));

    ApiSession api;
    if (!api.open(service))
        return;
    checkSessionInfo(api);
    const auto project = checkProjectWithoutEditor(api, *processor, sung);
    const auto handles = handlesOf(project, 0, 2.0);
    if (!CONTROL_CHECK(handles.has_value()))
        return;
    checkProjectWithEditor(api, service, sung, *handles);
    checkPitchCurve(api, *handles);
    checkSegmentNotes(api, *handles);
    checkUnanalysed(api, project);
    checkErrors(api, *handles);
    checkNotes(api, *processor, sung, *handles);
    checkReopen(api, *processor, *handles);

    // Every access of the operations to OpenTune state happened on the message thread.
    CONTROL_CHECK(dispatcher->threadProbe().otherThreadAccesses.load() == 0);
    CONTROL_CHECK(dispatcher->threadProbe().messageThreadAccesses.load() > 0 && dispatcher->executedCount() > 0);
    note(std::to_string(dispatcher->executedCount()) + " methods ran, "
         + std::to_string(dispatcher->threadProbe().messageThreadAccesses.load()) + " accesses on the message thread");
}

void scenarioThreadProbe()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    const auto dispatcher = service.dispatcher();
    if (!CONTROL_CHECK(dispatcher != nullptr))
        return;
    addClip(*processor, sungSpec());
    ApiSession api;
    if (!api.open(service))
        return;
    const auto project = api.result("project.get");
    const auto handles = handlesOf(project, 0, 2.0);
    if (!CONTROL_CHECK(handles.has_value()))
        return;
    const auto byContent = json("{\"contentId\":" + quoted(handles->contentId) + "}");
    const int accessesBefore = dispatcher->threadProbe().messageThreadAccesses.load();
    const int executedBefore = dispatcher->executedCount();
    api.result("session.info");
    api.result("content.getNotes", byContent);
    api.result("content.getPitchCurve", byContent);
    api.result("content.segmentNotes", byContent);
    CONTROL_CHECK(dispatcher->executedCount() == executedBefore + 4);
    CONTROL_CHECK(dispatcher->threadProbe().messageThreadAccesses.load() > accessesBefore);
    CONTROL_CHECK(dispatcher->threadProbe().otherThreadAccesses.load() == 0);

    // The check is always on, also in release builds: an operation context used on another thread
    // refuses to hand out the processor and counts the attempt.
    ControlThreadProbe probe;
    ControlInstanceFacts facts;
    facts.instanceId = memberOf(api.discovery(), "instanceId").text();
    bool refused = false;
    std::thread other([&] {
        ControlOpContext context(*processor, nullptr, facts, probe);
        try {
            context.processor();
        } catch (const ControlThreadViolation&) {
            refused = true;
        }
    });
    other.join();
    CONTROL_CHECK(refused && probe.otherThreadAccesses.load() == 1 && probe.messageThreadAccesses.load() == 0);
    ControlOpContext onMessageThread(*processor, nullptr, facts, probe);
    CONTROL_CHECK(&onMessageThread.processor() == processor.get() && probe.messageThreadAccesses.load() == 1);
    CONTROL_CHECK(onMessageThread.instanceShort() == facts.instanceId.substr(0, 8));
}

void scenarioDispatchShutdown()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    const auto dispatcher = service.dispatcher();
    const auto messageThread = service.messageThread();
    ApiSession api;
    if (!CONTROL_CHECK(dispatcher != nullptr) || !api.open(service))
        return;

    // This thread does not pump messages, so the request waits in ControlMessageThread::call().
    std::optional<std::string> response;
    std::thread client([&api, &response] {
        if (api.client().sendLine(R"({"jsonrpc":"2.0","id":7,"method":"project.get","params":{}})"))
            response = api.client().readLine();
    });
    CONTROL_CHECK(waitUntil([&messageThread] { return messageThread->waitingCalls() == 1; }, kWaiterSettleMs));

    const auto started = Clock::now();
    processor.reset();
    const auto elapsed = millisecondsSince(started);
    note("processor destroyed in " + std::to_string(elapsed) + " ms");
    CONTROL_CHECK(elapsed <= kShutdownBoundMs);
    client.join();
    // Woken by the stop: SHUTTING_DOWN, never executed. (A TIMEOUT would also promise executed false.)
    if (CONTROL_CHECK(response.has_value())) {
        note("response: " + *response);
        CONTROL_CHECK(isError(response, "SHUTTING_DOWN", "") || isError(response, "TIMEOUT", "dispatch_timeout"));
        const auto parsed = parseJson(*response);
        const JsonValue* data = errorData(parsed.value);
        CONTROL_CHECK(data != nullptr && memberOf(*data, "executed").isBoolean()
                      && !memberOf(*data, "executed").asBoolean());
        CONTROL_CHECK(memberOf(parsed.value, "id").asDouble() == 7);
    }
    CONTROL_CHECK(dispatcher->isStopping() && messageThread->waitingCalls() == 0);
    // The queued function reaches the message loop now and finds the liveness token dead.
    pumpMessagesFor(kQuietPumpMs);
    CONTROL_CHECK(dispatcher->executedCount() == 0);
}

void scenarioDispatchTimeout()
{
    auto processor = startedProcessor();
    auto& service = processor->getControlService();
    if (!service.isRunning())
        return;
    const auto dispatcher = service.dispatcher();
    ApiSession api;
    if (!CONTROL_CHECK(dispatcher != nullptr) || !api.open(service))
        return;

    // This thread does not pump messages for longer than dispatchTimeoutMs.
    const int dispatchTimeoutMs = ControlLimits{}.dispatchTimeoutMs;
    std::optional<std::string> response;
    std::atomic<bool> answered{false};
    std::thread client([&] {
        if (api.client().sendLine(R"({"jsonrpc":"2.0","id":8,"method":"project.get","params":{}})"))
            response = api.client().readLine(dispatchTimeoutMs + kReadTimeoutMs);
        answered = true;
    });
    const auto started = Clock::now();
    CONTROL_CHECK(
        waitUntil([&answered] { return answered.load(); }, dispatchTimeoutMs + kReadTimeoutMs + kCloseSeenMs));
    client.join();
    const auto elapsed = millisecondsSince(started);
    note("answered after " + std::to_string(elapsed) + " ms");
    CONTROL_CHECK(elapsed >= dispatchTimeoutMs);
    if (CONTROL_CHECK(response.has_value())) {
        CONTROL_CHECK(isError(response, "TIMEOUT", "dispatch_timeout"));
        const auto parsed = parseJson(*response);
        const JsonValue* data = errorData(parsed.value);
        CONTROL_CHECK(data != nullptr && !memberOf(*data, "executed").asBoolean()
                      && memberOf(*data, "retryable").asBoolean());
    }
    // The abandoned request reaches the message loop now and never runs; the next one does.
    pumpMessagesFor(kQuietPumpMs);
    CONTROL_CHECK(dispatcher->executedCount() == 0);
    CONTROL_CHECK(memberOf(api.result("project.get"), "placements").isArray());
    CONTROL_CHECK(dispatcher->executedCount() == 1);
}

void scenarioVectors()
{
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors";
    std::vector<std::filesystem::path> files;
    for (const char* area : {"session", "project", "content"})
        for (const auto& entry : std::filesystem::directory_iterator(root / area))
            if (entry.path().extension() == ".json")
                files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    int passed = 0;
    int skipped = 0;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto& vector = parsed.value;
        const auto id = memberOf(vector, "id").text();
        if (const auto reason = vectorSkipReason(vector); !reason.empty()) {
            ++skipped;
            note("SKIP " + id + ": " + reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runVector(vector);
        if (CONTROL_CHECK(failure.empty()))
            ++passed;
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    // The vectors of every implemented method run (session.info, project.get and the three content reads).
    CONTROL_CHECK(passed >= 11);
    note(std::to_string(passed) + " vectors passed, " + std::to_string(skipped) + " skipped");
}

} // namespace ControlTest
} // namespace OpenTune
