// SPDX-License-Identifier: AGPL-3.0-or-later

// The Windows half of NoAccessFile (ControlTestSupport.h). Include it after the JUCE headers: windows.h defines
// macros that break them.
#pragma once

#include "ControlTestSupport.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <aclapi.h>
#pragma comment(lib, "advapi32.lib")

// Legacy macros of windows.h that would clash with names in the test files.
#undef near
#undef far

namespace OpenTune {
namespace ControlTest {

namespace detail {

/** The SID of the user of this process, as bytes; empty when it cannot be read. */
inline std::vector<unsigned char> currentUserSid()
{
    std::vector<unsigned char> sid;
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return sid;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> buffer(size);
    if (size > 0 && GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
        const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
        const DWORD length = GetLengthSid(user->User.Sid);
        const auto* bytes = reinterpret_cast<const unsigned char*>(user->User.Sid);
        sid.assign(bytes, bytes + length);
    }
    CloseHandle(token);
    return sid;
}

} // namespace detail

inline bool NoAccessFile::deny(const std::filesystem::path& path, unsigned long rights, SavedDacl& saved)
{
    auto sid = detail::currentUserSid();
    if (sid.empty())
        return false;
    const std::wstring wide = path.wstring();
    PACL original = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (GetNamedSecurityInfoW(wide.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &original,
                              nullptr, &descriptor)
        != ERROR_SUCCESS)
        return false;
    saved.descriptor = descriptor;
    saved.dacl = original;
    EXPLICIT_ACCESS_W entry{};
    entry.grfAccessPermissions = rights;
    entry.grfAccessMode = DENY_ACCESS;
    entry.grfInheritance = NO_INHERITANCE;
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.TrusteeType = TRUSTEE_IS_USER;
    entry.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid.data());
    PACL updated = nullptr;
    if (SetEntriesInAclW(1, &entry, original, &updated) != ERROR_SUCCESS)
        return false;
    const DWORD result = SetNamedSecurityInfoW(const_cast<LPWSTR>(wide.c_str()), SE_FILE_OBJECT,
                                               DACL_SECURITY_INFORMATION, nullptr, nullptr, updated, nullptr);
    LocalFree(updated);
    saved.changed = result == ERROR_SUCCESS;
    return saved.changed;
}

inline void NoAccessFile::writeBack(const std::filesystem::path& path, SavedDacl& saved)
{
    if (saved.changed && saved.dacl != nullptr) {
        const std::wstring wide = path.wstring();
        SetNamedSecurityInfoW(const_cast<LPWSTR>(wide.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                              nullptr, static_cast<PACL>(saved.dacl), nullptr);
    }
    if (saved.descriptor != nullptr)
        LocalFree(saved.descriptor);
    saved = SavedDacl{};
}

} // namespace ControlTest
} // namespace OpenTune

#endif
