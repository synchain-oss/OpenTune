// SPDX-License-Identifier: AGPL-3.0-or-later
#include "TransportOps.h"

#include "OpsSupport.h"
#include "WriteEnvelope.h"

#include "Control/ControlUiBridge.h"
#include "PluginProcessor.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace OpenTune {

namespace {

/** Positions closer than this are the same position: a position read twice during playback differs by the time
    between the reads, and the presented position is only as exact as the clock. */
constexpr double kSamePositionSec = 1e-6;
/** The tempo and time signature the schemas allow (OpenTune's setters accept more, and limit silently). */
constexpr double kMinBpm = 1.0;
constexpr double kMaxBpm = 999.0;
constexpr int kMaxTimeSignatureNumerator = 32;

JsonValue singletonRef(const char* name)
{
    auto ref = JsonValue::object();
    ref.appendMember("singleton", JsonValue::string(name));
    return ref;
}

/** {before, after, unit} of one changed member (PROTOCOL.md section 14.3). */
JsonValue fieldChange(JsonValue before, JsonValue after, const char* unit)
{
    auto field = JsonValue::object();
    field.appendMember("before", std::move(before));
    field.appendMember("after", std::move(after));
    field.appendMember("unit", unit != nullptr ? JsonValue::string(unit) : JsonValue());
    return field;
}

JsonValue signatureJson(int numerator, int denominator)
{
    auto json = JsonValue::object();
    json.appendMember("numerator", JsonValue::integer(numerator));
    json.appendMember("denominator", JsonValue::integer(denominator));
    return json;
}

// ---- transport.control ----------------------------------------------------------------------------

enum class Action {
    Play,
    Pause,
    Stop,
    Seek,
    PlayFromLastStart,
    PauseAtLastStart
};

struct ControlParams
{
    Action action = Action::Play;
    double positionTimelineSec = 0.0;
};

bool parseControl(const JsonValue& params, ControlParams& out, std::string& why)
{
    ControlParamReader reader(params);
    const JsonValue* action = reader.member("action");
    std::optional<double> position;
    if (!reader.onlyMembers({"action", "positionTimelineSec"})
        || !reader.optionalNumber("positionTimelineSec", 0.0, std::numeric_limits<double>::max(), position)) {
        why = reader.why();
        return false;
    }
    struct Named
    {
        const char* name;
        Action action;
    };
    static const Named kActions[] = {{"play", Action::Play},
                                     {"pause", Action::Pause},
                                     {"stop", Action::Stop},
                                     {"seek", Action::Seek},
                                     {"playFromLastStart", Action::PlayFromLastStart},
                                     {"pauseAtLastStart", Action::PauseAtLastStart}};
    const auto* found = std::find_if(std::begin(kActions), std::end(kActions), [action](const Named& named) {
        return action != nullptr && action->isString() && action->text() == named.name;
    });
    if (found == std::end(kActions)) {
        why = "action must be play, pause, stop, seek, playFromLastStart or pauseAtLastStart";
        return false;
    }
    out.action = found->action;
    // positionTimelineSec is required with seek and not allowed with the other actions.
    if (out.action == Action::Seek) {
        if (!position) {
            why = "positionTimelineSec is required with action seek";
            return false;
        }
        out.positionTimelineSec = *position;
    } else if (position) {
        why = "positionTimelineSec is only allowed with action seek";
        return false;
    }
    return true;
}

/** The transport state transport.control compares before and after a call. */
struct PlayState
{
    bool playing = false;
    double positionSec = 0.0;
    double playStartSec = 0.0;
};

PlayState readPlayState(OpenTuneAudioProcessor& processor)
{
    PlayState state;
    state.playing = processor.isPlaying();
    state.positionSec = std::max(0.0, processor.getPosition());
    state.playStartSec = std::max(0.0, processor.getPlayStartPosition());
    return state;
}

Result<JsonValue> runControl(ControlOpContext& context, const ControlParams& params)
{
    if (auto busy = controlCheckBusy(context))
        return *busy;
    auto& processor = context.processor();
    ControlWriteEnvelope envelope(context);
    const auto device = controlAudioDeviceState(context);
    const auto before = readPlayState(processor);
    // Where the audio callback will put the position when it carries pauseAtLastStart out; the other actions report
    // the position the processor presents right after the call (nullopt: report the read at `after` below).
    std::optional<double> positionAfter;
    bool warnsNoDevice = false;

    // The processor's transport functions and recordControlCall(), as the editor's listener functions call them.
    using Call = OpenTuneAudioProcessor::DiagnosticControlCall;
    switch (params.action) {
        case Action::Play:
            // playRequested(). The transport bar's play button is the pause button while playing, so a play during
            // playback is not issued again (it would only move the play start position).
            if (!before.playing)
                processor.play();
            processor.recordControlCall(Call::Play);
            warnsNoDevice = true;
            break;
        case Action::Pause:
            // pauseRequested().
            processor.pause();
            processor.recordControlCall(Call::Pause);
            break;
        case Action::Stop:
            // stopRequested(): OpenTuneAudioProcessor::stop() freezes the presented position and asks the audio
            // callback to fade the running transport out and land it on 0 (processBlock's Stop case; stop() sets
            // pendingCompletionTime_ to 0). The landing happens on the audio thread when that fade-out completes
            // (kTransportRampDurationSeconds, 0.2 s on the audio thread), so a read right after the call still
            // returns the frozen presented position. The result reports that read, exactly as transport.get does
            // now; after the fade a read returns 0. There is no earlier value to wait for on this thread.
            processor.stop();
            processor.recordControlCall(Call::Stop);
            break;
        case Action::Seek:
            // playheadPositionChangeRequested(): also the play start position of the next play-from-start.
            processor.setPosition(params.positionTimelineSec);
            processor.recordControlCall(Call::Seek);
            break;
        case Action::PlayFromLastStart:
            // playFromStartToggleRequested(), the branch of a stopped transport. While playing, the button pauses
            // instead; the schema defines this action as "move to the last start and play", so a running transport is
            // moved and plays on.
            processor.setPosition(before.playStartSec);
            if (!before.playing)
                processor.play();
            processor.recordControlCall(Call::Play);
            warnsNoDevice = true;
            break;
        case Action::PauseAtLastStart:
            // playFromStartToggleRequested(), the branch of a running transport. A stopped transport has nothing to
            // pause and stays where it is: a no-op.
            if (before.playing) {
                processor.pauseAtPosition(before.playStartSec);
                if (device.running)
                    positionAfter = before.playStartSec;
            }
            processor.recordControlCall(Call::Pause);
            break;
    }
    if (warnsNoDevice && !device.running)
        envelope.addWarning("NO_AUDIO_DEVICE");

    if (auto* bridge = context.bridge())
        bridge->onTransportChanged();

    const auto after = readPlayState(processor);
    // play and pause keep the position; what the clock moved between the two reads is not a change.
    const bool keepsPosition = params.action == Action::Play || params.action == Action::Pause;
    const double afterPosition = positionAfter ? *positionAfter : after.positionSec;
    auto fields = JsonValue::object();
    if (before.playing != after.playing)
        fields.appendMember(
            "playing", fieldChange(JsonValue::boolean(before.playing), JsonValue::boolean(after.playing), nullptr));
    if (!keepsPosition && std::abs(afterPosition - before.positionSec) > kSamePositionSec)
        fields.appendMember("positionTimelineSec", fieldChange(controlJsonSeconds(before.positionSec),
                                                               controlJsonSeconds(afterPosition), "sec"));
    if (std::abs(after.playStartSec - before.playStartSec) > kSamePositionSec)
        fields.appendMember("playStartTimelineSec", fieldChange(controlJsonSeconds(before.playStartSec),
                                                                controlJsonSeconds(after.playStartSec), "sec"));
    if (fields.size() != 0) {
        envelope.addChange("transport", singletonRef("transport"), JsonValue::string("Transport"), std::move(fields));
        // View state (PROTOCOL.md section 15.2 rule 6): not saved with the project, no undo, nothing to revert.
        envelope.setNotUndoable("not_persisted_state");
    }
    auto result = envelope.committed(context);
    // The transport member reports the same position the change above reports: the read the call made, not a second
    // read that the audio thread may already have moved on from (the stop landing).
    result.appendMember("transport", controlTransportJson(context, afterPosition));
    return result;
}

// ---- transport.setTempo ---------------------------------------------------------------------------

struct TempoParams
{
    std::optional<double> bpm;
    std::optional<int> numerator;
    std::optional<int> denominator;
};

bool parseTempo(const JsonValue& params, TempoParams& out, std::string& why)
{
    ControlParamReader reader(params);
    if (!reader.onlyMembers({"bpm", "timeSignature"})) {
        why = reader.why();
        return false;
    }
    if (params.size() == 0) {
        why = "at least one of bpm and timeSignature is required";
        return false;
    }
    if (!reader.optionalNumber("bpm", kMinBpm, kMaxBpm, out.bpm)) {
        why = reader.why();
        return false;
    }
    if (const JsonValue* signature = reader.member("timeSignature")) {
        if (!signature->isObject()) {
            why = "timeSignature must be an object";
            return false;
        }
        ControlParamReader signatureReader(*signature);
        std::optional<std::int64_t> numerator;
        std::optional<std::int64_t> denominator;
        if (!signatureReader.onlyMembers({"numerator", "denominator"}) || signatureReader.member("numerator") == nullptr
            || signatureReader.member("denominator") == nullptr
            || !signatureReader.optionalInteger("numerator", 1, kMaxTimeSignatureNumerator, numerator)
            || !signatureReader.optionalInteger("denominator", 1, 32, denominator)) {
            why = signatureReader.why().empty() ? "timeSignature needs a numerator and a denominator"
                                                : signatureReader.why();
            return false;
        }
        // A power of two from 1 to 32: OpenTune's setter would ignore any other denominator without saying so.
        if ((*denominator & (*denominator - 1)) != 0) {
            why = "timeSignature.denominator must be a power of two";
            return false;
        }
        out.numerator = static_cast<int>(*numerator);
        out.denominator = static_cast<int>(*denominator);
    }
    return true;
}

JsonValue tempoJson(double bpm, int numerator, int denominator)
{
    auto tempo = JsonValue::object();
    tempo.appendMember("bpm", controlJsonNumber(bpm, 3));
    tempo.appendMember("timeSignature", signatureJson(numerator, denominator));
    return tempo;
}

Result<JsonValue> runSetTempo(ControlOpContext& context, const TempoParams& params)
{
    if (auto busy = controlCheckBusy(context))
        return *busy;
    auto& processor = context.processor();
    ControlWriteEnvelope envelope(context);
    const double bpmBefore = processor.getBpm();
    const int numeratorBefore = processor.getTimeSigNumerator();
    const int denominatorBefore = processor.getTimeSigDenominator();
    // The values equal to the current ones are not set again: the editor's fields set the processor only on an
    // edit, and the call is a no-op.
    const bool bpmChanges = params.bpm && std::abs(*params.bpm - bpmBefore) > 1e-9;
    const bool signatureChanges =
        params.numerator && (*params.numerator != numeratorBefore || *params.denominator != denominatorBefore);
    if (bpmChanges || signatureChanges) {
        // OpenTuneAudioProcessor::setBpm() and setTimeSignature(), the canonical setters bpmChanged() and
        // timeSignatureChanged() call; then the project is marked as changed, as they do.
        if (bpmChanges)
            processor.setBpm(*params.bpm);
        if (signatureChanges)
            processor.setTimeSignature(*params.numerator, *params.denominator);
        controlMarkDirty(context);
        if (auto* bridge = context.bridge())
            bridge->onTempoChanged();
    }
    const double bpmAfter = processor.getBpm();
    const int numeratorAfter = processor.getTimeSigNumerator();
    const int denominatorAfter = processor.getTimeSigDenominator();

    auto fields = JsonValue::object();
    if (std::abs(bpmAfter - bpmBefore) > 1e-9)
        fields.appendMember("bpm", fieldChange(controlJsonNumber(bpmBefore, 3), controlJsonNumber(bpmAfter, 3), "bpm"));
    if (numeratorAfter != numeratorBefore || denominatorAfter != denominatorBefore)
        fields.appendMember("timeSignature", fieldChange(signatureJson(numeratorBefore, denominatorBefore),
                                                         signatureJson(numeratorAfter, denominatorAfter), nullptr));
    if (fields.size() != 0) {
        envelope.addChange("tempo", singletonRef("tempo"), JsonValue::string("Tempo"), std::move(fields));
        // No undo entry, as in the UI (ui_parity); the previous tempo and time signature restore the state.
        envelope.setNotUndoable(
            "ui_parity",
            controlRevertRecipe("transport.setTempo", tempoJson(bpmBefore, numeratorBefore, denominatorBefore)));
    }
    auto result = envelope.committed(context);
    result.appendMember("tempo", tempoJson(bpmAfter, numeratorAfter, denominatorAfter));
    return result;
}

// ---- transport.setLoop ----------------------------------------------------------------------------

struct LoopParams
{
    bool enabled = false;
};

bool parseSetLoop(const JsonValue& params, LoopParams& out, std::string& why)
{
    ControlParamReader reader(params);
    const JsonValue* enabled = reader.member("enabled");
    if (!reader.onlyMembers({"enabled"}) || enabled == nullptr || !enabled->isBoolean()) {
        why = reader.why().empty() ? "enabled is required and must be a boolean" : reader.why();
        return false;
    }
    out.enabled = enabled->asBoolean();
    return true;
}

Result<JsonValue> runSetLoop(ControlOpContext& context, const LoopParams& params)
{
    if (auto busy = controlCheckBusy(context))
        return *busy;
    auto& processor = context.processor();
    ControlWriteEnvelope envelope(context);
    const bool before = processor.isLoopEnabled();
    if (before != params.enabled) {
        // OpenTuneAudioProcessor::setLoopEnabled(), the function loopToggled() calls. The flag is not saved with the
        // project, which the editor does not mark as changed either.
        processor.setLoopEnabled(params.enabled);
        if (auto* bridge = context.bridge())
            bridge->onTransportChanged();
        auto fields = JsonValue::object();
        fields.appendMember("loopEnabled",
                            fieldChange(JsonValue::boolean(before), JsonValue::boolean(params.enabled), nullptr));
        envelope.addChange("transport", singletonRef("transport"), JsonValue::string("Transport"), std::move(fields));
        auto revert = JsonValue::object();
        revert.appendMember("enabled", JsonValue::boolean(before));
        envelope.setNotUndoable("not_persisted_state", controlRevertRecipe("transport.setLoop", std::move(revert)));
        if (params.enabled)
            envelope.addWarning("LOOP_NO_EFFECT_STANDALONE");
        envelope.addWarning("NOT_PERSISTED", singletonRef("transport"));
    }
    auto result = envelope.committed(context);
    result.appendMember("transport", controlTransportJson(context));
    return result;
}

} // namespace

void registerTransportOps(ControlMethodTable& table)
{
    table.add(controlWriteMethod<ControlParams>("transport.control", parseControl, runControl));
    table.add(controlWriteMethod<TempoParams>("transport.setTempo", parseTempo, runSetTempo));
    table.add(controlWriteMethod<LoopParams>("transport.setLoop", parseSetLoop, runSetLoop));
}

} // namespace OpenTune
