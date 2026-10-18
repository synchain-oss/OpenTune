// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scenarios of ui.getState and ui.dismiss against the real processor without a window or an audio device. The test
// bridge reports the dialogs, the onboarding overlay and the scale that the editor's bridge reads from the editor
// (Source/Standalone/ControlEditorBridgeModals.cpp), and closing a track-colour dialog commits its colour as the
// editor's dialog does in its destructor: the track's colour, then the dirty flag. ui.bridge is incomplete until
// ui.setSelection is registered, so these scenarios report it through the test seam. Registered with the other
// processor scenarios in ControlProcessorTests.cpp.

#include "ControlProcessorSupport.h"
#include "TestUiBridge.h"

#include "Control/ControlDispatcher.h"
#include "Control/Ops/OpsRegistry.h"
#include "PluginProcessor.h"
#include "Utils/AppPreferences.h"

#include <algorithm>
#include <filesystem>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace OpenTune {
namespace ControlTest {

namespace {

using DialogInfo = ControlUiBridge::DialogInfo;

/** Bound of one vector's exchange while this thread pumps messages. */
constexpr int kVectorExchangeMs = 30000;

JsonValue jsonOf(const std::string& text)
{
    auto parsed = parseJson(text);
    CONTROL_CHECK(parsed.ok);
    return parsed.value;
}

/** Reports the incomplete ui.bridge, and leaves out the withheld capabilities, for the dispatchers created during its
    life; restores the defaults afterwards. */
class ScopedCapabilities
{
public:
    explicit ScopedCapabilities(std::vector<std::string> withheld = {})
    {
        controlSetReportIncompleteCapabilitiesForTesting(true);
        controlSetWithheldCapabilitiesForTesting(std::move(withheld));
    }
    ~ScopedCapabilities()
    {
        controlSetWithheldCapabilitiesForTesting({});
        controlSetReportIncompleteCapabilitiesForTesting(false);
    }

    ScopedCapabilities(const ScopedCapabilities&) = delete;
    ScopedCapabilities& operator=(const ScopedCapabilities&) = delete;
};

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

/** A dialog as the editor's bridge classifies it (Source/Control/README.md, "Dialogs and onboarding"). */
DialogInfo dialogOf(const std::string& kind, int trackId = -1)
{
    DialogInfo info;
    info.kind = kind;
    info.trackId = kind == "trackColour" ? trackId : -1;
    info.closeCommits = kind == "trackColour" || kind == "unknown";
    if (kind == "trackColour")
        info.title = "Track " + std::to_string(trackId + 1) + " Color";
    else if (kind == "preferences")
        info.title = "Preferences";
    else if (kind == "pitchShift")
        info.title = "Pitch Shift";
    return info;
}

DialogInfo fileChooser()
{
    DialogInfo info;
    info.kind = "fileChooser";
    info.systemFileChooser = true;
    return info;
}

/** "#RRGGBB" as an opaque colour. */
juce::Colour colourOf(const std::string& hex)
{
    return juce::Colour(0xff000000u | static_cast<juce::uint32>(std::stoul(hex.substr(1), nullptr, 16)));
}

std::string hexOf(juce::Colour colour)
{
    return "#" + colour.toDisplayString(false).toStdString();
}

/**
 * A started processor whose dispatcher reports ui.bridge (and ui.onboardingClose unless withheld), with a test bridge
 * registered. A track-colour dialog commits the colour of dialogColours for its track when it closes. Members in the
 * order of their construction: the seam before the processor, the bridge after it.
 */
struct UiFixture
{
    explicit UiFixture(std::vector<std::string> withheld = {})
        : capabilities(std::move(withheld))
        , processor(startedProcessor())
    {
        bridge.view.workspace = "arrangement";
        bridge.onDialogClosed = [this](const DialogInfo& dialog) {
            if (dialog.kind != "trackColour")
                return;
            const auto colour = dialogColours.find(dialog.trackId);
            if (colour != dialogColours.end())
                processor->getStandaloneArrangement()->setTrackColour(dialog.trackId, colour->second);
            bridge.markDirty();
        };
        registered = std::make_unique<ScopedBridge>(processor->getControlService(), bridge);
    }

    ControlService& service() { return processor->getControlService(); }
    AppPreferences& preferences() { return processor->getAppPreferences(); }
    std::string trackColour(int trackId)
    {
        return hexOf(processor->getStandaloneArrangement()->getTrackColour(trackId));
    }

    /** Opens a track-colour dialog of trackId that shows colour (set apart from the track's own colour). */
    void openColourDialog(int trackId, const std::string& colour)
    {
        if (trackColour(trackId) == colour)
            processor->getStandaloneArrangement()->setTrackColour(trackId, juce::Colours::grey);
        dialogColours[trackId] = colourOf(colour);
        bridge.dialogs.push_back(dialogOf("trackColour", trackId));
        bridge.busy.modalOpen = true;
    }
    void openDialog(DialogInfo dialog)
    {
        bridge.dialogs.push_back(std::move(dialog));
        bridge.busy.modalOpen = true;
    }
    void reset()
    {
        bridge.dialogs.clear();
        bridge.closedDialogs.clear();
        bridge.busy = ControlUiBridge::BusyState{};
        bridge.project.dirty = false;
        bridge.onboarding = false;
        bridge.onboardingClosable = true;
        bridge.onboardingCloses = 0;
        bridge.refuseClose = false;
        dialogColours.clear();
    }

    ScopedCapabilities capabilities;
    std::unique_ptr<OpenTuneAudioProcessor> processor;
    TestUiBridge bridge;
    std::map<int, juce::Colour> dialogColours;
    std::unique_ptr<ScopedBridge> registered;
    ApiSession api;
};

const JsonValue* findWarning(const JsonValue& result, const std::string& code)
{
    const auto& warnings = memberOf(result, "warnings");
    for (std::size_t i = 0; i < warnings.size(); ++i)
        if (memberOf(warnings.at(i), "code").text() == code)
            return &warnings.at(i);
    return nullptr;
}

bool reports(const std::vector<std::string>& capabilities, const std::string& capability)
{
    return std::find(capabilities.begin(), capabilities.end(), capability) != capabilities.end();
}

/** The capabilities a dispatcher created now reports, from the method table with the seams as they are. */
std::vector<std::string> tableCapabilities()
{
    ControlMethodTable table;
    registerControlMethods(table);
    return table.capabilities();
}

JsonValue dismiss(UiFixture& f, const std::string& params)
{
    return f.api.result("ui.dismiss", jsonOf(params));
}

} // namespace

// ---- ui.getState ---------------------------------------------------------------------------------------

void scenarioUiState()
{
    // The interface's defaults report "not supported".
    ControlUiBridge defaults;
    CONTROL_CHECK(!defaults.openDialogs() && !defaults.closeTopDialog() && !defaults.onboardingShowing()
                  && !defaults.closeOnboarding() && !defaults.uiScale());

    // ui.bridge is incomplete: without the seam the instance reports neither it nor ui.onboardingClose, which extends
    // it, and the listener refuses its methods.
    const auto plain = tableCapabilities();
    CONTROL_CHECK(!reports(plain, "ui.bridge") && !reports(plain, "ui.onboardingClose"));
    CONTROL_CHECK(controlCapabilityIsIncomplete("ui.bridge"));
    {
        auto processor = startedProcessor();
        auto& service = processor->getControlService();
        if (!service.isRunning())
            return;
        CONTROL_CHECK(!reports(service.dispatcher()->capabilities(), "ui.bridge"));
        CONTROL_CHECK(service.dispatcher()->implements("ui.getState") && service.dispatcher()->implements("ui.dismiss")
                      && !service.dispatcher()->implements("ui.setSelection"));
        ApiSession api;
        if (!api.open(service))
            return;
        CONTROL_CHECK(api.fails("ui.getState", JsonValue::object(), "UNSUPPORTED", "capability_missing"));
        CONTROL_CHECK(api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "UNSUPPORTED", "capability_missing"));
    }
    {
        ScopedCapabilities seam;
        const auto reported = tableCapabilities();
        const auto bridgeAt = std::find(reported.begin(), reported.end(), "ui.bridge");
        CONTROL_CHECK(bridgeAt != reported.end() && bridgeAt + 1 != reported.end()
                      && *(bridgeAt + 1) == "ui.onboardingClose");
    }
    {
        ScopedCapabilities seam({"ui.onboardingClose"});
        const auto reported = tableCapabilities();
        CONTROL_CHECK(reports(reported, "ui.bridge") && !reports(reported, "ui.onboardingClose"));
    }

    UiFixture f;
    if (!f.service().isRunning() || !f.api.open(f.service()))
        return;
    CONTROL_CHECK(reports(f.service().dispatcher()->capabilities(), "ui.onboardingClose"));

    // The stack from the bottom; the file chooser of the operating system counts as modal but is not listed.
    f.openDialog(fileChooser());
    f.openDialog(dialogOf("preferences"));
    f.openDialog(dialogOf("message"));
    f.openColourDialog(2, "#00FF00");
    auto unknown = dialogOf("unknown");
    unknown.title = std::string(300, 'a');
    f.openDialog(unknown);
    f.bridge.busy.pointerDown = true;
    f.bridge.busy.importRunning = true;
    f.bridge.busy.operationRunning = true;
    CONTROL_CHECK(f.processor->tryAcquireExportLock());
    f.preferences().setOnboardingShown(true);
    f.bridge.onboarding = true;
    f.bridge.scale = ControlUiBridge::UiScale{9, 2};
    // A read: never BUSY, also while the UI is busy.
    const auto state = f.api.result("ui.getState");
    f.processor->releaseExportLock();
    const auto& busy = memberOf(state, "busy");
    CONTROL_CHECK(memberOf(busy, "pointerDown").asBoolean() && memberOf(busy, "modalOpen").asBoolean()
                  && memberOf(busy, "importInProgress").asBoolean() && memberOf(busy, "exportInProgress").asBoolean()
                  && memberOf(busy, "projectOperation").asBoolean());
    const auto& dialogs = memberOf(state, "dialogs");
    if (CONTROL_CHECK(dialogs.size() == 4)) {
        const char* kinds[] = {"preferences", "message", "trackColour", "unknown"};
        for (std::size_t i = 0; i < 4; ++i)
            CONTROL_CHECK(memberOf(dialogs.at(i), "kind").text() == kinds[i]);
        CONTROL_CHECK(memberOf(dialogs.at(0), "title").text() == "Preferences"
                      && !memberOf(dialogs.at(0), "closeCommits").asBoolean()
                      && memberOf(dialogs.at(0), "trackId").isNull());
        CONTROL_CHECK(memberOf(dialogs.at(1), "title").text().empty());
        CONTROL_CHECK(memberOf(dialogs.at(2), "title").text() == "Track 3 Color"
                      && memberOf(dialogs.at(2), "closeCommits").asBoolean()
                      && memberOf(dialogs.at(2), "trackId").asDouble() == 2.0);
        // Titles are cut to 256 code points.
        CONTROL_CHECK(memberOf(dialogs.at(3), "title").text().size() == 256
                      && memberOf(dialogs.at(3), "closeCommits").asBoolean());
    }
    const auto& onboarding = memberOf(state, "onboarding");
    CONTROL_CHECK(memberOf(onboarding, "shown").asBoolean() && memberOf(onboarding, "showing").asBoolean());
    CONTROL_CHECK(memberOf(memberOf(state, "uiScale"), "root").asDouble() == 9.0
                  && memberOf(memberOf(state, "uiScale"), "scale").text() == "minor");
    const auto& ui = memberOf(state, "ui");
    CONTROL_CHECK(memberOf(ui, "workspace").text() == "arrangement" && memberOf(ui, "visibleTrackCount").isNumber());
    CONTROL_CHECK(!state.find("asOf"));

    f.reset();
    f.preferences().setOnboardingShown(false);
    f.bridge.scale = ControlUiBridge::UiScale{0, 8};
    const auto idle = f.api.result("ui.getState");
    CONTROL_CHECK(memberOf(idle, "dialogs").size() == 0 && !memberOf(memberOf(idle, "busy"), "modalOpen").asBoolean());
    CONTROL_CHECK(!memberOf(memberOf(idle, "onboarding"), "shown").asBoolean()
                  && !memberOf(memberOf(idle, "onboarding"), "showing").asBoolean());
    CONTROL_CHECK(memberOf(memberOf(idle, "uiScale"), "scale").text() == "pentatonicMinor");
    CONTROL_CHECK(f.api.fails("ui.getState", jsonOf(R"({"x":1})"), "INVALID_ARGUMENT", "invalid_params"));

    // A bridge that does not report its dialogs is no editor window for ui.bridge.
    f.bridge.reportsDialogs = false;
    CONTROL_CHECK(f.api.fails("ui.getState", JsonValue::object(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"onboarding"})"), "UNSUPPORTED", "capability_missing"));
    f.bridge.reportsDialogs = true;
    // Without an editor.
    f.registered.reset();
    CONTROL_CHECK(f.api.fails("ui.getState", JsonValue::object(), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(f.service().dispatcher()->threadProbe().otherThreadAccesses.load() == 0);
}

// ---- ui.dismiss ----------------------------------------------------------------------------------------

void scenarioUiDismiss()
{
    UiFixture f;
    if (!f.service().isRunning() || !f.api.open(f.service()))
        return;

    // Params (methods/ui.dismiss.schema.json $defs.params).
    for (const char* params : {R"({})", R"({"target":"windows"})", R"({"target":"onboarding","confirm":false})",
                               R"({"target":"dialogs","confirm":"yes"})", R"({"target":"dialogs","force":true})"})
        CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(params), "INVALID_ARGUMENT", "invalid_params"));

    // Busy: an open dialog does not refuse ui.dismiss, every other condition does, and nothing is closed.
    f.openDialog(dialogOf("confirm"));
    f.bridge.busy.pointerDown = true;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "BUSY", "pointer_down"));
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"onboarding"})"), "BUSY", "pointer_down"));
    f.bridge.busy.pointerDown = false;
    f.bridge.busy.importRunning = true;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "BUSY", "import_in_progress"));
    f.bridge.busy.importRunning = false;
    CONTROL_CHECK(f.processor->tryAcquireExportLock());
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "BUSY", "export_in_progress"));
    f.processor->releaseExportLock();
    f.bridge.busy.operationRunning = true;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "BUSY", "project_operation"));
    f.bridge.busy.operationRunning = false;
    CONTROL_CHECK(f.bridge.dialogs.size() == 1 && f.bridge.closedDialogs.empty());

    // Dialogs that commit nothing close from the top down; view state: not_persisted_state, revert null, no warning.
    f.reset();
    f.openDialog(dialogOf("message"));
    f.openDialog(dialogOf("pitchShift"));
    f.openDialog(dialogOf("confirm"));
    auto closed = dismiss(f, R"({"target":"dialogs"})");
    CONTROL_CHECK(f.bridge.dialogs.empty() && !f.bridge.busy.modalOpen);
    CONTROL_CHECK((f.bridge.closedDialogs == std::vector<std::string>{"confirm", "pitchShift", "message"}));
    CONTROL_CHECK(memberOf(closed, "applied").asBoolean() && !memberOf(closed, "noOp").asBoolean()
                  && memberOf(closed, "changes").size() == 0 && memberOf(closed, "warnings").size() == 0);
    CONTROL_CHECK(memberOf(memberOf(closed, "undo"), "reason").text() == "not_persisted_state"
                  && memberOf(memberOf(closed, "undo"), "revert").isNull());
    const auto& listed = memberOf(memberOf(memberOf(closed, "sideEffects"), "dialogClosed"), "dialogs");
    if (CONTROL_CHECK(listed.size() == 3))
        CONTROL_CHECK(memberOf(listed.at(0), "kind").text() == "confirm"
                      && memberOf(listed.at(2), "kind").text() == "message"
                      && memberOf(listed.at(0), "trackId").isNull());
    CONTROL_CHECK(!memberOf(memberOf(closed, "dirty"), "after").asBoolean());
    CONTROL_CHECK(memberOf(dismiss(f, R"({"target":"dialogs"})"), "noOp").asBoolean());

    // A dialog that commits when it closes refuses the call without confirm, and nothing closes.
    f.reset();
    f.openColourDialog(1, "#00FF00");
    f.openDialog(dialogOf("message"));
    const auto colourBefore = f.trackColour(1);
    CONTROL_CHECK(
        f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "INVALID_ARGUMENT", "dialog_commits_on_close"));
    CONTROL_CHECK(f.bridge.dialogs.size() == 2 && f.bridge.closedDialogs.empty() && f.trackColour(1) == colourBefore);
    // With confirm the colour is committed. tracks.v1 is not reported here, so no request can restore the colour: the
    // revert recipe is null and the change carries IRREVERSIBLE besides DIALOG_CLOSE_COMMITTED.
    CONTROL_CHECK(!reports(f.service().dispatcher()->capabilities(), "tracks.v1"));
    const auto committed = dismiss(f, R"({"target":"dialogs","confirm":true})");
    CONTROL_CHECK(f.bridge.dialogs.empty() && f.trackColour(1) == "#00FF00" && f.bridge.project.dirty);
    const auto& changes = memberOf(committed, "changes");
    if (CONTROL_CHECK(changes.size() == 1)) {
        const auto& colour = memberOf(memberOf(changes.at(0), "fields"), "colour");
        CONTROL_CHECK(memberOf(changes.at(0), "entity").text() == "track"
                      && memberOf(memberOf(changes.at(0), "ref"), "trackId").asDouble() == 1.0
                      && memberOf(colour, "before").text() == colourBefore
                      && memberOf(colour, "after").text() == "#00FF00");
    }
    CONTROL_CHECK(memberOf(memberOf(committed, "undo"), "reason").text() == "ui_parity"
                  && memberOf(memberOf(committed, "undo"), "revert").isNull());
    const auto* commitWarning = findWarning(committed, "DIALOG_CLOSE_COMMITTED");
    const auto* irreversible = findWarning(committed, "IRREVERSIBLE");
    CONTROL_CHECK(commitWarning != nullptr && irreversible != nullptr && memberOf(committed, "warnings").size() == 2);
    if (commitWarning != nullptr && irreversible != nullptr)
        CONTROL_CHECK(memberOf(memberOf(*commitWarning, "subject"), "trackId").asDouble() == 1.0
                      && memberOf(memberOf(*commitWarning, "data"), "kind").text() == "trackColour"
                      && memberOf(memberOf(*irreversible, "subject"), "trackId").asDouble() == 1.0);
    const auto& effects = memberOf(committed, "sideEffects");
    const auto& dialogCommitted = memberOf(effects, "dialogCommitted");
    CONTROL_CHECK(memberOf(dialogCommitted, "colourBefore").text() == colourBefore
                  && memberOf(dialogCommitted, "colourAfter").text() == "#00FF00"
                  && memberOf(dialogCommitted, "revert").isNull()
                  && memberOf(memberOf(effects, "dialogClosed"), "dialogs").size() == 2);
    CONTROL_CHECK(memberOf(memberOf(committed, "dirty"), "after").asBoolean()
                  && memberOf(memberOf(committed, "revisionDiff"), "trackState").isObject());

    // A colour dialog that shows the track's own colour commits it all the same: no change, but the commit is reported.
    f.reset();
    f.dialogColours[0] = colourOf(f.trackColour(0));
    f.openDialog(dialogOf("trackColour", 0));
    const auto same = dismiss(f, R"({"target":"dialogs","confirm":true})");
    CONTROL_CHECK(!memberOf(same, "noOp").asBoolean() && memberOf(same, "changes").size() == 0
                  && findWarning(same, "DIALOG_CLOSE_COMMITTED") != nullptr
                  && memberOf(memberOf(same, "sideEffects"), "dialogCommitted").isObject());

    // A file chooser of the operating system: above a dialog it blocks the call; alone the call is a no-op; below a
    // dialog it stays open while the dialog closes.
    f.reset();
    f.openDialog(dialogOf("message"));
    f.openDialog(fileChooser());
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs","confirm":true})"), "BUSY", "modal_open"));
    CONTROL_CHECK(f.bridge.dialogs.size() == 2);
    f.reset();
    f.openDialog(fileChooser());
    CONTROL_CHECK(memberOf(dismiss(f, R"({"target":"dialogs"})"), "noOp").asBoolean() && f.bridge.dialogs.size() == 1);
    f.openDialog(dialogOf("message"));
    const auto above = dismiss(f, R"({"target":"dialogs"})");
    CONTROL_CHECK(!memberOf(above, "noOp").asBoolean() && f.bridge.dialogs.size() == 1
                  && f.bridge.dialogs.back().systemFileChooser);

    // A dialog that does not close: INTERNAL before any change.
    f.reset();
    f.openDialog(dialogOf("confirm"));
    f.bridge.refuseClose = true;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"dialogs"})"), "INTERNAL", ""));
    f.bridge.refuseClose = false;

    // A dialog whose closing opens another: the call stops there and leaves the new one, which it did not check.
    f.reset();
    f.openDialog(dialogOf("message"));
    f.openDialog(dialogOf("confirm"));
    const auto commitColour = f.bridge.onDialogClosed;
    f.bridge.onDialogClosed = [&f](const DialogInfo& dialog) {
        if (dialog.kind == "confirm")
            f.bridge.dialogs.push_back(dialogOf("unknown"));
    };
    const auto stopped = dismiss(f, R"({"target":"dialogs"})");
    f.bridge.onDialogClosed = commitColour;
    CONTROL_CHECK(memberOf(memberOf(memberOf(stopped, "sideEffects"), "dialogClosed"), "dialogs").size() == 1);
    CONTROL_CHECK(f.bridge.dialogs.size() == 2 && f.bridge.dialogs.back().kind == "unknown");

    // ---- target onboarding ----
    // Not showing, never shown: prevents the overlay through the preference, which no request resets.
    f.reset();
    f.preferences().setOnboardingShown(false);
    const auto prevented = dismiss(f, R"({"target":"onboarding"})");
    CONTROL_CHECK(f.preferences().getState().shared.onboardingShown && f.bridge.onboardingCloses == 0);
    CONTROL_CHECK(memberOf(memberOf(prevented, "undo"), "reason").text() == "no_upstream_undo"
                  && findWarning(prevented, "IRREVERSIBLE") != nullptr && memberOf(prevented, "changes").size() == 1);
    // Shown before: a no-op.
    CONTROL_CHECK(memberOf(dismiss(f, R"({"target":"onboarding"})"), "noOp").asBoolean());
    // Showing while the preference is already set, as in OpenTune, which sets it when the overlay shows its choice:
    // only the view changes.
    f.bridge.onboarding = true;
    const auto viewOnly = dismiss(f, R"({"target":"onboarding"})");
    CONTROL_CHECK(!f.bridge.onboarding.value_or(true) && f.bridge.onboardingCloses == 1);
    CONTROL_CHECK(!memberOf(viewOnly, "noOp").asBoolean() && memberOf(viewOnly, "changes").size() == 0
                  && memberOf(viewOnly, "warnings").size() == 0
                  && memberOf(memberOf(viewOnly, "undo"), "reason").text() == "not_persisted_state");
    // Showing with its choice dialog on top: closing the dialog finishes the overlay, as Escape does.
    f.reset();
    f.bridge.onboarding = true;
    f.openDialog(dialogOf("confirm"));
    f.bridge.onDialogClosed = [&f](const DialogInfo&) { f.bridge.onboarding = false; };
    const auto choice = dismiss(f, R"({"target":"onboarding"})");
    f.bridge.onDialogClosed = commitColour;
    CONTROL_CHECK(f.bridge.onboardingCloses == 0 && f.bridge.dialogs.empty()
                  && memberOf(memberOf(memberOf(choice, "sideEffects"), "dialogClosed"), "dialogs").size() == 1);
    // A dialog above the overlay that would commit a value refuses the call; nothing closes.
    f.reset();
    f.bridge.onboarding = true;
    f.openColourDialog(0, "#123456");
    CONTROL_CHECK(
        f.api.fails("ui.dismiss", jsonOf(R"({"target":"onboarding"})"), "INVALID_ARGUMENT", "dialog_commits_on_close"));
    CONTROL_CHECK(f.bridge.onboarding.value_or(false) && f.bridge.dialogs.size() == 1);
    // An overlay that does not close: INTERNAL before any change.
    f.reset();
    f.bridge.onboarding = true;
    f.bridge.onboardingClosable = false;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"onboarding"})"), "INTERNAL", ""));
    CONTROL_CHECK(f.service().dispatcher()->threadProbe().otherThreadAccesses.load() == 0);
}

void scenarioUiOnboardingWithheld()
{
    // An instance without ui.onboardingClose prevents the overlay but does not close one that is showing.
    UiFixture f({"ui.onboardingClose"});
    if (!f.service().isRunning() || !f.api.open(f.service()))
        return;
    CONTROL_CHECK(!reports(f.service().dispatcher()->capabilities(), "ui.onboardingClose"));
    f.preferences().setOnboardingShown(false);
    f.bridge.onboarding = true;
    CONTROL_CHECK(f.api.fails("ui.dismiss", jsonOf(R"({"target":"onboarding"})"), "UNSUPPORTED", "capability_missing"));
    CONTROL_CHECK(f.bridge.onboarding.value_or(false) && !f.preferences().getState().shared.onboardingShown);
    f.bridge.onboarding = false;
    const auto prevented = dismiss(f, R"({"target":"onboarding"})");
    CONTROL_CHECK(!memberOf(prevented, "noOp").asBoolean() && f.preferences().getState().shared.onboardingShown);
}

// ---- The specification's vectors ---------------------------------------------------------------------

namespace {

/** Why the runner does not run a vector, and whether it waits for a method of a later part. */
struct UiVectorSkip
{
    std::string reason;
    bool pending = false;
};

UiVectorSkip uiVectorSkip(const JsonValue& vector, const std::vector<std::string>& reported)
{
    if (memberOf(vector, "capability").text() != "ui.bridge")
        return {"runs in the runner of its own capability"};
    if (memberOf(vector, "type").text() != "request" || memberOf(vector, "session").text() != "authenticated")
        return {"only authenticated request vectors are run here"};
    if (memberOf(memberOf(vector, "request"), "method").text() == "ui.setSelection")
        return {"ui.setSelection is registered with the selection part", true};
    const auto& extra = memberOf(vector, "extraCapabilities");
    for (std::size_t i = 0; i < extra.size(); ++i)
        if (!reports(reported, extra.at(i).text()))
            return {"needs capability " + extra.at(i).text() + ", which a later part implements"};
    const auto& given = memberOf(vector, "given");
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto& name = given.keyAt(i);
        if (name != "dirty" && name != "dialogs" && name != "onboarding" && name != "withoutCapabilities")
            return {"precondition given." + name + " is not established by this runner"};
    }
    return {};
}

/** Runs one vector against a fresh processor with the test bridge. Empty on success. */
std::string runUiVector(const JsonValue& vector)
{
    const auto& given = memberOf(vector, "given");
    std::vector<std::string> withheld;
    const auto& without = memberOf(given, "withoutCapabilities");
    for (std::size_t i = 0; i < without.size(); ++i)
        withheld.push_back(without.at(i).text());
    UiFixture f(withheld);
    if (!f.service().isRunning())
        return "the control API did not start";
    f.bridge.project.dirty = memberOf(given, "dirty").isBoolean() && memberOf(given, "dirty").asBoolean();
    const auto& dialogs = memberOf(given, "dialogs");
    for (std::size_t i = 0; i < dialogs.size(); ++i) {
        const auto& spec = dialogs.at(i);
        const auto kind = memberOf(spec, "kind").text();
        if (kind == "trackColour")
            f.openColourDialog(static_cast<int>(memberOf(spec, "trackId").asDouble()), memberOf(spec, "colour").text());
        else
            f.openDialog(dialogOf(kind));
    }
    const auto onboarding = memberOf(given, "onboarding").text();
    // notShown: never shown and not showing; shown: shown before; showing: on screen, not yet marked as shown.
    if (!onboarding.empty())
        f.preferences().setOnboardingShown(onboarding == "shown");
    f.bridge.onboarding = onboarding == "showing";

    if (!f.api.open(f.service()))
        return "session.hello failed";
    VectorMatcher matcher;
    const auto& discovery = f.api.discovery();
    for (std::size_t i = 0; i < discovery.size(); ++i)
        matcher.bindings["discovery." + discovery.keyAt(i)] = discovery.at(i);
    auto expected = memberOf(vector, "response");
    if (memberOf(vector, "id").text() == "ui/get-state-ok") {
        // OpenTune always has an active track (track 0 in a new project, StandaloneArrangement::activeTrackId_), so
        // the snapshot reports 0 where the vector expects null (Source/Control/README.md, "Dialogs and onboarding").
        auto result = memberOf(expected, "result");
        auto ui = memberOf(result, "ui");
        ui.set("activeTrackId", JsonValue::integer(0));
        result.set("ui", std::move(ui));
        expected.set("result", std::move(result));
    }

    std::string failure;
    runWhilePumping(
        [&] {
            auto& connection = f.api.client();
            const auto request = matcher.substitute(memberOf(vector, "request"), failure);
            if (!failure.empty())
                return;
            if (!connection.sendLine(toJsonString(request))) {
                failure = "cannot send the request";
                return;
            }
            failure = matcher.expectLine(connection, expected);
            if (failure.empty() && memberOf(vector, "connectionAfter").text() == "open"
                && !connection.staysQuiet(kOpenCheckMs))
                failure = "the connection closed or sent more";
        },
        kVectorExchangeMs);
    return failure;
}

/** The vectors of ui/ that must run and pass headless; the vectors of ui.setSelection are pending until it is
    registered, and ui/dismiss-confirm-commit needs tracks.v1 for its revert recipe (scenarioUiDismiss covers the
    commit without it). */
const char* const kMustRunUiVectors[] = {
    "ui/dismiss-commits-on-close",
    "ui/dismiss-dialog",
    "ui/dismiss-no-dialog",
    "ui/dismiss-onboarding-close",
    "ui/dismiss-onboarding-close-unsupported",
    "ui/dismiss-onboarding-prevent",
    "ui/dismiss-onboarding-shown",
    "ui/dismiss-unknown-dialog",
    "ui/get-state-dialog",
    "ui/get-state-ok",
};

} // namespace

void scenarioUiVectors()
{
    std::vector<std::string> reported;
    {
        ScopedCapabilities seam;
        reported = tableCapabilities();
    }
    const auto root = std::filesystem::u8path(OPENTUNE_CONTROL_SPEC_DIR) / "vectors" / "ui";
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(root))
        if (entry.path().extension() == ".json")
            files.push_back(entry.path());
    std::sort(files.begin(), files.end());
    int passed = 0;
    int skipped = 0;
    int pending = 0;
    std::set<std::string> passedIds;
    for (const auto& file : files) {
        const auto parsed = parseJson(readFile(file));
        if (!CONTROL_CHECK(parsed.ok))
            continue;
        const auto& vector = parsed.value;
        const auto id = memberOf(vector, "id").text();
        if (const auto skip = uiVectorSkip(vector, reported); !skip.reason.empty()) {
            ++(skip.pending ? pending : skipped);
            note((skip.pending ? "PENDING " : "SKIP ") + id + ": " + skip.reason);
            continue;
        }
        const auto started = Clock::now();
        const auto failure = runUiVector(vector);
        if (CONTROL_CHECK(failure.empty())) {
            ++passed;
            passedIds.insert(id);
        }
        note((failure.empty() ? "PASS " : "FAIL ") + id + " (" + std::to_string(millisecondsSince(started)) + " ms)"
             + (failure.empty() ? "" : ": " + failure));
    }
    for (const char* id : kMustRunUiVectors)
        CONTROL_CHECK(passedIds.count(id) == 1);
    if (reports(reported, "tracks.v1"))
        CONTROL_CHECK(passedIds.count("ui/dismiss-confirm-commit") == 1);
    note(std::to_string(passed) + " vectors passed, " + std::to_string(skipped) + " skipped, " + std::to_string(pending)
         + " pending");
}

} // namespace ControlTest
} // namespace OpenTune
