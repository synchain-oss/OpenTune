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
    set(OPENTUNE_CONTROL_SOURCES
        # Channel: run-time options, path rules, CSPRNG, JSON, protocol framing, sockets, discovery
        # file and the listener with authentication and limits.
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
        # Service, processor start/stop and data-directory redirection: added later.
        # Dispatcher and the read methods: added later.
        # Jobs, import, export and the editor bridge: added later.
        # Note edits, undo and redo: added later.
        # Time grid: added later.
    )

    target_sources(OpenTuneStandalone PRIVATE ${OPENTUNE_CONTROL_SOURCES})
    # PUBLIC, so that every target that compiles or links the SharedCode sees the same class layouts.
    target_compile_definitions(OpenTuneStandalone PUBLIC OPENTUNE_ENABLE_CONTROL_API=1)
    if(WIN32)
        # Winsock for the listener, BCrypt for the system CSPRNG.
        target_link_libraries(OpenTuneStandalone PRIVATE ws2_32 bcrypt)
    endif()

    if(OPENTUNE_BUILD_TESTS)
        # Unit tests of the channel: standard library and the control sources only.
        set(OPENTUNE_CONTROL_TEST_SOURCES ${OPENTUNE_CONTROL_SOURCES})
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
    endif()
endif()
