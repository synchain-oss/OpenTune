// SPDX-License-Identifier: AGPL-3.0-or-later
#include "ControlFileIdentity.h"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstdio>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace OpenTune {

namespace {

#if defined(_WIN32)
constexpr char kSeparator = '\\';

bool toWide(const std::string& utf8, std::wstring& wide)
{
    if (utf8.empty())
        return false;
    const int length =
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (length <= 0)
        return false;
    wide.assign(static_cast<std::size_t>(length), L'\0');
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), wide.data(),
                               length)
           == length;
}
#else
constexpr char kSeparator = '/';
#endif

/** The parent directory and the last segment of an absolute path in the platform's form. The parent of a
    file in the root keeps its separator ("C:\" or "/"), so that it names the root and nothing else. */
bool splitLastSegment(const std::string& path, std::string& parent, std::string& name)
{
    const auto separator = path.find_last_of(kSeparator);
    if (separator == std::string::npos || separator + 1 >= path.size())
        return false;
    name = path.substr(separator + 1);
    const auto rootEnd = path.find(kSeparator);
    parent = path.substr(0, separator == rootEnd ? separator + 1 : separator);
    return true;
}

/** Whether two last segments are equal as the file system compares names: on Windows without regard to
    case (the ordinal comparison with the file system's upper-case table), on POSIX systems byte by byte. */
bool sameName(const std::string& a, const std::string& b)
{
#if defined(_WIN32)
    std::wstring wideA;
    std::wstring wideB;
    if (!toWide(a, wideA) || !toWide(b, wideB))
        return false;
    return CompareStringOrdinal(wideA.data(), static_cast<int>(wideA.size()), wideB.data(),
                                static_cast<int>(wideB.size()), TRUE)
           == CSTR_EQUAL;
#else
    return a == b;
#endif
}

} // namespace

ControlFileIdStatus controlFileIdentity(const std::string& utf8Path, ControlFileId& out)
{
    out = ControlFileId{};
#if defined(_WIN32)
    std::wstring wide;
    if (!toWide(utf8Path, wide))
        return ControlFileIdStatus::Failed;
    // FILE_FLAG_BACKUP_SEMANTICS opens directories as well; no access to the content is requested, and the
    // handle shares everything, so that it never disturbs another user of the file.
    const HANDLE handle =
        CreateFileW(wide.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                    OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ControlFileIdStatus::Missing
                                                                              : ControlFileIdStatus::Failed;
    }
    bool found = false;
#if defined(_WIN32_WINNT) && _WIN32_WINNT >= 0x0602
    // The 128-bit file id, which file systems such as ReFS need.
    FILE_ID_INFO idInfo{};
    if (GetFileInformationByHandleEx(handle, FileIdInfo, &idInfo, sizeof(idInfo))) {
        out.volume = idInfo.VolumeSerialNumber;
        static_assert(sizeof(idInfo.FileId.Identifier) == 16, "FILE_ID_128 has 16 bytes");
        for (int i = 0; i < 8; ++i) {
            out.idLow |= static_cast<std::uint64_t>(idInfo.FileId.Identifier[i]) << (8 * i);
            out.idHigh |= static_cast<std::uint64_t>(idInfo.FileId.Identifier[8 + i]) << (8 * i);
        }
        found = true;
    }
#endif
    if (!found) {
        BY_HANDLE_FILE_INFORMATION info{};
        if (GetFileInformationByHandle(handle, &info)) {
            out.volume = info.dwVolumeSerialNumber;
            out.idLow = (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) | info.nFileIndexLow;
            found = true;
        }
    }
    CloseHandle(handle);
    return found ? ControlFileIdStatus::Found : ControlFileIdStatus::Failed;
#else
    struct stat info
    {};
    if (::stat(utf8Path.c_str(), &info) != 0)
        return errno == ENOENT || errno == ENOTDIR ? ControlFileIdStatus::Missing : ControlFileIdStatus::Failed;
    out.volume = static_cast<std::uint64_t>(info.st_dev);
    out.idLow = static_cast<std::uint64_t>(info.st_ino);
    return ControlFileIdStatus::Found;
#endif
}

std::optional<bool> controlSameFile(const std::string& utf8PathA, const std::string& utf8PathB)
{
    ControlFileId idA;
    ControlFileId idB;
    const auto statusA = controlFileIdentity(utf8PathA, idA);
    const auto statusB = controlFileIdentity(utf8PathB, idB);
    if (statusA == ControlFileIdStatus::Failed || statusB == ControlFileIdStatus::Failed)
        return std::nullopt;
    if (statusA == ControlFileIdStatus::Found && statusB == ControlFileIdStatus::Found)
        return idA == idB;
    if (statusA != statusB)
        return false; // an existing file is never the file of a path where nothing exists
    // Neither exists (rule 3): the same file when both parents exist and are the same directory and the
    // last segments are equal.
    std::string parentA;
    std::string nameA;
    std::string parentB;
    std::string nameB;
    if (!splitLastSegment(utf8PathA, parentA, nameA) || !splitLastSegment(utf8PathB, parentB, nameB))
        return false;
    ControlFileId parentIdA;
    ControlFileId parentIdB;
    const auto parentStatusA = controlFileIdentity(parentA, parentIdA);
    const auto parentStatusB = controlFileIdentity(parentB, parentIdB);
    if (parentStatusA == ControlFileIdStatus::Failed || parentStatusB == ControlFileIdStatus::Failed)
        return std::nullopt;
    if (parentStatusA != ControlFileIdStatus::Found || parentStatusB != ControlFileIdStatus::Found)
        return false;
    return parentIdA == parentIdB && sameName(nameA, nameB);
}

ControlRenameResult controlRenameFile(const std::string& utf8From, const std::string& utf8To, bool replace)
{
#if defined(_WIN32)
    std::wstring wideFrom;
    std::wstring wideTo;
    if (!toWide(utf8From, wideFrom) || !toWide(utf8To, wideTo))
        return ControlRenameResult::Failed;
    // Without MOVEFILE_COPY_ALLOWED the move never copies data between volumes.
    if (MoveFileExW(wideFrom.c_str(), wideTo.c_str(), replace ? MOVEFILE_REPLACE_EXISTING : 0))
        return ControlRenameResult::Done;
    const DWORD error = GetLastError();
    return !replace && (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) ? ControlRenameResult::TargetExists
                                                                                     : ControlRenameResult::Failed;
#else
    if (replace)
        return std::rename(utf8From.c_str(), utf8To.c_str()) == 0 ? ControlRenameResult::Done
                                                                  : ControlRenameResult::Failed;
    // A hard link fails with EEXIST when the target exists; on a file system without hard links it fails
    // otherwise, and the operation must not fall back to a test followed by a rename that replaces.
    if (::link(utf8From.c_str(), utf8To.c_str()) != 0)
        return errno == EEXIST ? ControlRenameResult::TargetExists : ControlRenameResult::Failed;
    ::unlink(utf8From.c_str());
    return ControlRenameResult::Done;
#endif
}

} // namespace OpenTune
