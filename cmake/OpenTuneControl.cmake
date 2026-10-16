# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Local control API of OpenTune Standalone (OTCP v1, loopback only).
#
# Included at the end of the top-level CMakeLists.txt. Everything below is inside
# if(OPENTUNE_ENABLE_CONTROL_API): with the option OFF (the default) this file adds no source,
# definition, library or test, so the build is the same as without it.
#
# The control sources are compiled into the Standalone SharedCode target (OpenTuneStandalone) only;
# they must not reference symbols that exist only in the application wrapper target.

if(OPENTUNE_ENABLE_CONTROL_API)
    # Explicit, ordered source list. Each part of the control API adds its own block.
    # Channel: run-time options, path rules, CSPRNG, JSON, protocol framing, sockets, discovery file and
    # the listener with authentication and limits. Standard library and operating system only: the unit
    # tests compile these files on their own.
    set(OPENTUNE_CONTROL_CHANNEL_SOURCES
        Source/Control/ControlApiOptions.cpp
        Source/Control/ControlApiOptions.h
        Source/Control/ControlPathPolicy.cpp
        Source/Control/ControlPathPolicy.h
        Source/Control/SecureRandom.cpp
        Source/Control/SecureRandom.h
        Source/Control/ControlJson.cpp
        Source/Control/ControlJson.h
        Source/Control/ControlProtocol.cpp
        Source/Control/ControlProtocol.h
        Source/Control/ControlSocket.cpp
        Source/Control/ControlSocket.h
        Source/Control/ControlDiscovery.cpp
        Source/Control/ControlDiscovery.h
        Source/Control/ControlServer.cpp
        Source/Control/ControlServer.h
    )
    set(OPENTUNE_CONTROL_SOURCES
        ${OPENTUNE_CONTROL_CHANNEL_SOURCES}
        # Service, processor start/stop and data-directory redirection: the service facade, the
        # message-thread marshalling with its liveness token, the editor bridge interface and
        # OPENTUNE_DATA_DIR. These and every later part use JUCE and the processor.
        Source/Control/ControlDataDirectory.cpp
        Source/Control/ControlDataDirectory.h
        Source/Control/ControlMessageThread.cpp
        Source/Control/ControlMessageThread.h
        Source/Control/ControlUiBridge.h
        Source/Control/ControlService.cpp
        Source/Control/ControlService.h
        # Dispatcher and the read methods: handles, revision tokens and cursors (standard library only),
        # the request handler with its method table and error mapping, the helpers the operations share
        # (parameter checks, handle resolution, the world revision vector, asOf) and the session,
        # project and content reads.
        Source/Control/ContentHandles.cpp
        Source/Control/ContentHandles.h
        Source/Control/ControlDispatcher.cpp
        Source/Control/ControlDispatcher.h
        Source/Control/Ops/OpsRegistry.cpp
        Source/Control/Ops/OpsRegistry.h
        Source/Control/Ops/OpsSupport.cpp
        Source/Control/Ops/OpsSupport.h
        Source/Control/Ops/SessionOps.cpp
        Source/Control/Ops/SessionOps.h
        Source/Control/Ops/ProjectReadOps.cpp
        Source/Control/Ops/ProjectReadOps.h
        Source/Control/Ops/ContentReadOps.cpp
        Source/Control/Ops/ContentReadOps.h
        # The rest of the reads: content details, preferences and the log, the wire forms they share
        # with the other reads, and the redacting log tail (standard library only).
        Source/Control/Ops/OpsJson.cpp
        Source/Control/Ops/OpsJson.h
        Source/Control/Ops/ContentDetailsOps.cpp
        Source/Control/Ops/ContentDetailsOps.h
        Source/Control/Ops/AppReadOps.cpp
        Source/Control/Ops/AppReadOps.h
        Source/Control/ControlLogTail.cpp
        Source/Control/ControlLogTail.h
        # Jobs, import, export and the editor bridge: the jobs registry (tick on the message thread, long
        # poll on a thread of its own, retention), the write envelope and the busy checks that every write
        # shares, job.get and job.cancel, and import.start. The editor's side of the bridge is below.
        Source/Control/ControlJobs.cpp
        Source/Control/ControlJobs.h
        Source/Control/Ops/WriteEnvelope.cpp
        Source/Control/Ops/WriteEnvelope.h
        Source/Control/Ops/JobOps.cpp
        Source/Control/Ops/JobOps.h
        Source/Control/Ops/ImportOps.cpp
        Source/Control/Ops/ImportOps.h
        # export.start: file identity and the final rename (operating system only), and the export job.
        Source/Control/ControlFileIdentity.cpp
        Source/Control/ControlFileIdentity.h
        Source/Control/Ops/ExportOps.cpp
        Source/Control/Ops/ExportOps.h
        # Undo and redo, key and AUTO: the undo entries of the API (ControlOriginAction) and what the instance
        # knows about OpenTune's history (ControlHistory), undo entries built from snapshots as the piano roll
        # builds them (ContentEditTransaction), what content edits share, edit.getHistory, edit.undo,
        # edit.redo, content.setKey and content.autoTune.
        Source/Control/Edit/ControlOriginAction.cpp
        Source/Control/Edit/ControlOriginAction.h
        Source/Control/Edit/ContentEditTransaction.cpp
        Source/Control/Edit/ContentEditTransaction.h
        Source/Control/Ops/EditSupport.cpp
        Source/Control/Ops/EditSupport.h
        Source/Control/Ops/UndoOps.cpp
        Source/Control/Ops/UndoOps.h
        Source/Control/Ops/ContentTuneOps.cpp
        Source/Control/Ops/ContentTuneOps.h
        # Note edits: added later.
        # Time grid: the handle moves of OpenTune's time tool without the piano roll (TimeGridOps),
        # content.shiftTiming and content.editTimeGrid (seed as a job, moveHandles).
        Source/Control/Edit/TimeGridOps.cpp
        Source/Control/Edit/TimeGridOps.h
        Source/Control/Ops/TimingOps.cpp
        Source/Control/Ops/TimingOps.h
    )

    target_sources(OpenTuneStandalone PRIVATE ${OPENTUNE_CONTROL_SOURCES})
    # The editor's side of the bridge belongs to the application wrapper, like the editor itself
    # (OPENTUNE_STANDALONE_APP_SOURCES in CMakeLists.txt); the headless tests use a bridge of their own.
    target_sources(OpenTuneStandalone_Standalone PRIVATE
        Source/Standalone/ControlEditorBridge.cpp
        Source/Standalone/ControlEditorBridge.h
    )
    # PUBLIC, so that every target that compiles or links the SharedCode sees the same class layouts.
    target_compile_definitions(OpenTuneStandalone PUBLIC OPENTUNE_ENABLE_CONTROL_API=1)
    if(WIN32)
        # Winsock for the listener, BCrypt for the system CSPRNG.
        target_link_libraries(OpenTuneStandalone PRIVATE ws2_32 bcrypt)
    endif()

    # Build identity published in the discovery file (PROTOCOL.md section 5.3). By default the commit
    # and its exact tag are read from git each time CMake configures; builds that are distributed pass
    # the values explicitly. Only ControlService.cpp sees them, so a new commit recompiles one file.
    set(OPENTUNE_CONTROL_BUILD_COMMIT "" CACHE STRING
        "Commit id the control API publishes (40 hexadecimal digits; empty: git HEAD at configure time)")
    set(OPENTUNE_CONTROL_COMMIT_TAG "" CACHE STRING
        "Version-control tag of that commit (empty: the exact git tag at configure time, if any)")
    set(OPENTUNE_CONTROL_BUILD_TAG "" CACHE STRING "Distribution label of this binary (empty: none)")
    set(OPENTUNE_CONTROL_SOURCE_URL "https://github.com/YuFeng926/OpenTune" CACHE STRING
        "Where the corresponding source code of this build can be obtained (https URL)")
    set(_opentune_control_commit "${OPENTUNE_CONTROL_BUILD_COMMIT}")
    set(_opentune_control_commit_tag "${OPENTUNE_CONTROL_COMMIT_TAG}")
    find_package(Git QUIET)
    if(GIT_FOUND AND _opentune_control_commit STREQUAL "")
        execute_process(COMMAND "${GIT_EXECUTABLE}" rev-parse HEAD
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
            OUTPUT_VARIABLE _opentune_control_commit OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
        if(_opentune_control_commit_tag STREQUAL "")
            execute_process(COMMAND "${GIT_EXECUTABLE}" describe --tags --exact-match HEAD
                WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
                OUTPUT_VARIABLE _opentune_control_commit_tag OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
        endif()
    endif()
    string(TOLOWER "${_opentune_control_commit}" _opentune_control_commit)
    if(NOT _opentune_control_commit MATCHES "^[0-9a-f]+$")
        set(_opentune_control_commit "")
    endif()
    string(LENGTH "${_opentune_control_commit}" _opentune_control_commit_length)
    if(NOT _opentune_control_commit_length EQUAL 40)
        message(STATUS "Control API: the commit id is unknown; the discovery file reports 40 zeros")
        set(_opentune_control_commit "0000000000000000000000000000000000000000")
    endif()
    set_source_files_properties(Source/Control/ControlService.cpp PROPERTIES COMPILE_DEFINITIONS
        "OPENTUNE_CONTROL_BUILD_COMMIT=\"${_opentune_control_commit}\";OPENTUNE_CONTROL_COMMIT_TAG=\"${_opentune_control_commit_tag}\";OPENTUNE_CONTROL_BUILD_TAG=\"${OPENTUNE_CONTROL_BUILD_TAG}\";OPENTUNE_CONTROL_SOURCE_URL=\"${OPENTUNE_CONTROL_SOURCE_URL}\"")

    if(OPENTUNE_BUILD_TESTS)
        # Unit tests of the channel: standard library and the channel sources only.
        # Handles and tokens are standard library only as well.
        set(OPENTUNE_CONTROL_TEST_SOURCES ${OPENTUNE_CONTROL_CHANNEL_SOURCES} Source/Control/ContentHandles.cpp)
        # The log tail and its redaction are standard library only as well.
        list(APPEND OPENTUNE_CONTROL_TEST_SOURCES Source/Control/ControlLogTail.cpp)
        list(FILTER OPENTUNE_CONTROL_TEST_SOURCES INCLUDE REGEX "\\.cpp$")
        add_executable(OpenTuneControlUnitTests
            Tests/Control/ControlUnitTests.cpp
            Tests/Control/ControlTestSupport.h
            ${OPENTUNE_CONTROL_TEST_SOURCES}
        )
        target_include_directories(OpenTuneControlUnitTests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/Source)
        target_compile_definitions(OpenTuneControlUnitTests PRIVATE
            OPENTUNE_CONTROL_SPEC_DIR="${CMAKE_CURRENT_SOURCE_DIR}/Tests/Control/spec/otcp/v1"
            OPENTUNE_CONTROL_TEST_DATA_DIR="${CMAKE_CURRENT_BINARY_DIR}/ot-test-data/ControlUnitTests"
        )
        if(WIN32)
            target_link_libraries(OpenTuneControlUnitTests PRIVATE ws2_32 bcrypt)
        else()
            find_package(Threads REQUIRED)
            target_link_libraries(OpenTuneControlUnitTests PRIVATE Threads::Threads)
        endif()
        if(MSVC)
            target_compile_options(OpenTuneControlUnitTests PRIVATE /utf-8 /EHsc /W4)
        endif()
        add_test(NAME ControlUnitTests COMMAND OpenTuneControlUnitTests)
        set_tests_properties(ControlUnitTests PROPERTIES TIMEOUT 300)

        # Processor tests without a window or an audio device: the real OpenTuneAudioProcessor of the
        # Standalone SharedCode with its control service. The executable links the SharedCode and no
        # source of the application wrapper (the test defines the createOpenTuneEditor stub). It copies
        # the SharedCode's compile definitions (JucePlugin_Build_* and the rest, JUCE_SHARED_CODE
        # excepted) and include directories: PluginProcessor.h changes its class layout with them, and
        # a test compiled without them would break the one-definition rule without any diagnostic. The
        # language standard and the MSVC runtime come from the directory scope, as for the SharedCode.
        add_executable(OpenTuneControlProcessorTests
            Tests/Control/ControlProcessorTests.cpp
            Tests/Control/ControlDispatcherTests.cpp
            Tests/Control/ControlProcessorSupport.h
            Tests/Control/ControlHeadlessSupport.h
            Tests/Control/TestUiBridge.h
            Tests/Control/ControlTestSupport.h
        )
        target_compile_definitions(OpenTuneControlProcessorTests PRIVATE
            $<FILTER:$<TARGET_PROPERTY:OpenTuneStandalone,COMPILE_DEFINITIONS>,EXCLUDE,^JUCE_SHARED_CODE>
            OPENTUNE_CONTROL_SPEC_DIR="${CMAKE_CURRENT_SOURCE_DIR}/Tests/Control/spec/otcp/v1"
            OPENTUNE_CONTROL_TEST_DATA_DIR="${CMAKE_CURRENT_BINARY_DIR}/ot-test-data/ControlProcessorTests"
        )
        target_include_directories(OpenTuneControlProcessorTests PRIVATE
            $<TARGET_PROPERTY:OpenTuneStandalone,INCLUDE_DIRECTORIES>
            ${OPENTUNE_JUCE_DIR}/modules
            ${CMAKE_CURRENT_SOURCE_DIR}/Source
            ${CMAKE_CURRENT_SOURCE_DIR}/Tests
        )
        target_link_libraries(OpenTuneControlProcessorTests PRIVATE OpenTuneStandalone)
        if(APPLE)
            # The test message pump drives the main CFRunLoop directly.
            target_link_libraries(OpenTuneControlProcessorTests PRIVATE "-framework CoreFoundation")
        endif()
        # Jobs, import and the write envelope.
        target_sources(OpenTuneControlProcessorTests PRIVATE Tests/Control/ControlJobTests.cpp)
        # export.start and the export lock.
        target_sources(OpenTuneControlProcessorTests PRIVATE Tests/Control/ControlExportTests.cpp)
        # Undo and redo, key and AUTO, with the contents they share with the reads.
        target_sources(OpenTuneControlProcessorTests PRIVATE
            Tests/Control/ControlEditTests.cpp
            Tests/Control/ControlContentFixtures.h
        )
        # The time grid: shiftTiming, moveHandles and the seed job.
        target_sources(OpenTuneControlProcessorTests PRIVATE Tests/Control/ControlTimingTests.cpp)
        if(MSVC)
            target_compile_options(OpenTuneControlProcessorTests PRIVATE /utf-8 /EHsc /bigobj)
        endif()
        if(WIN32)
            # Without /DELAYLOAD the inference runtime is loaded at start, as for the upstream tests.
            add_custom_command(TARGET OpenTuneControlProcessorTests POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${ONNXRUNTIME_DLL}"
                    "$<TARGET_FILE_DIR:OpenTuneControlProcessorTests>/${OPENTUNE_ORT_DLL_NAME}"
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${DIRECTML_DLL}"
                    "$<TARGET_FILE_DIR:OpenTuneControlProcessorTests>/DirectML.dll"
                COMMENT "Copying inference runtime DLLs to OpenTuneControlProcessorTests...")
        endif()
        # One process per scenario, each with its own OPENTUNE_DATA_DIR (<build>/ot-test-data/<test>).
        # The scenario name comes first; the control API reads the other arguments from the process
        # command line, as in the application. @DATA@ stands for the test's data directory. Paths are
        # native: the control API accepts only the platform's absolute form (PROTOCOL.md section 20.1).
        set(_opentune_control_scenarios
            "StartAndHello|--control-api|--control-api-launch-nonce=headless-test-nonce-0123456789|--control-api-ready-file=@DATA@/ready.json"
            "Disabled|--control-api-dir=not/absolute"
            "RuntimeInitFailure|--control-api"
            "InvalidOption|--control-api|--control-api-dir=not/absolute"
            "DataDirectory"
            "UiBridge"
            "DestroyBeforeStart|--control-api"
            "RepeatedStop|--control-api"
            "Shutdown|--control-api"
            "Reads|--control-api"
            "ThreadProbe|--control-api"
            "DispatchShutdown|--control-api"
            "DispatchTimeout|--control-api"
            "Details|--control-api"
            "Completeness|--control-api"
            "Vectors|--control-api"
            "OffMainThread|--control-api"
        )
        file(TO_NATIVE_PATH "${CMAKE_CURRENT_BINARY_DIR}/lifecycle-traces" _opentune_control_trace_dir)
        # Jobs, import and the write envelope (Tests/Control/ControlJobTests.cpp).
        list(APPEND _opentune_control_scenarios
            "Jobs|--control-api"
            "JobShutdown|--control-api"
            "WriteEnvelope|--control-api"
            "Import|--control-api"
            "ImportAfterOpen|--control-api"
            "ImportCancel|--control-api"
            "JobVectors|--control-api"
        )
        # export.start and the export lock (Tests/Control/ControlExportTests.cpp).
        list(APPEND _opentune_control_scenarios
            "Export|--control-api"
            "ExportFailures|--control-api"
            "ExportVectors|--control-api"
            "ExportTimeStretch|--control-api"
        )
        # Undo and redo, key and AUTO (Tests/Control/ControlEditTests.cpp).
        list(APPEND _opentune_control_scenarios
            "Undo|--control-api"
            "SetKey|--control-api"
            "AutoTune|--control-api"
            "IncompleteCapability|--control-api"
            "EditVectors|--control-api"
        )
        # The time grid (Tests/Control/ControlTimingTests.cpp).
        list(APPEND _opentune_control_scenarios
            "Timing|--control-api"
            "TimeGridSeed|--control-api"
            "TimingVectors|--control-api"
        )
        foreach(_opentune_control_scenario IN LISTS _opentune_control_scenarios)
            string(REPLACE "|" ";" _opentune_control_scenario "${_opentune_control_scenario}")
            list(GET _opentune_control_scenario 0 _opentune_control_name)
            set(_opentune_control_test "ControlProcessorTests.${_opentune_control_name}")
            set(_opentune_control_data "${CMAKE_CURRENT_BINARY_DIR}/ot-test-data/${_opentune_control_test}")
            set(_opentune_control_arguments)
            foreach(_opentune_control_argument IN LISTS _opentune_control_scenario)
                if(_opentune_control_argument MATCHES "@DATA@")
                    string(REPLACE "@DATA@" "${_opentune_control_data}" _opentune_control_argument
                        "${_opentune_control_argument}")
                    file(TO_NATIVE_PATH "${_opentune_control_argument}" _opentune_control_argument)
                endif()
                list(APPEND _opentune_control_arguments "${_opentune_control_argument}")
            endforeach()
            file(TO_NATIVE_PATH "${_opentune_control_data}" _opentune_control_data)
            add_test(NAME ${_opentune_control_test}
                COMMAND OpenTuneControlProcessorTests ${_opentune_control_arguments})
            set_tests_properties(${_opentune_control_test} PROPERTIES
                TIMEOUT 60
                ENVIRONMENT "OPENTUNE_DATA_DIR=${_opentune_control_data};OPENTUNE_LIFECYCLE_TRACE_DIR=${_opentune_control_trace_dir}")
        endforeach()
        # Every vector starts a processor of its own.
        set_tests_properties(ControlProcessorTests.Vectors PROPERTIES TIMEOUT 300)
        set_tests_properties(ControlProcessorTests.JobVectors PROPERTIES TIMEOUT 300)
        set_tests_properties(ControlProcessorTests.ExportVectors PROPERTIES TIMEOUT 300)
        set_tests_properties(ControlProcessorTests.EditVectors PROPERTIES TIMEOUT 300)
        set_tests_properties(ControlProcessorTests.TimingVectors PROPERTIES TIMEOUT 300)
    endif()
endif()
