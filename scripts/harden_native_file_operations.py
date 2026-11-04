
#!/usr/bin/env python3

from __future__ import annotations

import re
import shutil
import sys

from datetime import datetime
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
HOST_FILE = PROJECT_ROOT / "native" / "host.py"


REQUIRED_IMPORTS = [
    "import secrets",
    "import stat",
]


SECURE_IMPLEMENTATION = r'''
# ---------------------------------------------------------------------
# SECURE PROJECT FILE OPERATIONS
# ---------------------------------------------------------------------

def open_project_parent(root, relative_path):
    """
    Open the destination's parent directory without following symlinks.

    Returns:
        (parent_fd, filename)

    The caller is responsible for closing parent_fd.
    """
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or "\x00" in relative_path
        or "\\" in relative_path
        or relative_path.startswith("/")
    ):
        raise ValueError("Invalid project-relative file path.")

    parts = relative_path.split("/")

    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("Invalid file path component.")

    directory_flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | os.O_CLOEXEC
    )

    current_fd = os.open(root, directory_flags)

    try:
        for part in parts[:-1]:
            next_fd = os.open(
                part,
                directory_flags,
                dir_fd=current_fd,
            )

            os.close(current_fd)
            current_fd = next_fd

        return current_fd, parts[-1]

    except Exception:
        os.close(current_fd)
        raise


def backup_open_file(project_id, relative_path, source_fd):
    """
    Back up an already-open regular file.

    Reads from the opened descriptor rather than reopening its path.
    """
    backup_root = BACKUP_DIRECTORY / project_id

    timestamp_directory = (
        datetime.now(timezone.utc).strftime(
            "%Y%m%dT%H%M%S%fZ"
        )
    )

    backup_path = (
        backup_root
        / timestamp_directory
        / relative_path
    )

    backup_path.parent.mkdir(
        parents=True,
        exist_ok=True,
        mode=0o700,
    )

    backup_fd = os.open(
        backup_path,
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_NOFOLLOW
        | os.O_CLOEXEC,
        0o600,
    )

    try:
        offset = 0

        while True:
            chunk = os.pread(
                source_fd,
                64 * 1024,
                offset,
            )

            if not chunk:
                break

            written = 0

            while written < len(chunk):
                written += os.write(
                    backup_fd,
                    chunk[written:],
                )

            offset += len(chunk)

        os.fsync(backup_fd)

    except Exception:
        os.close(backup_fd)

        try:
            backup_path.unlink()
        except OSError:
            pass

        raise

    else:
        os.close(backup_fd)

    return str(backup_path)


def write_project_file(
    project_id,
    relative_path,
    content,
    approved=False,
):
    root, _ = get_project(project_id)

    if should_exclude(relative_path):
        raise ValueError(
            "Writing to this sensitive or excluded file is prohibited."
        )

    if not isinstance(content, str):
        raise ValueError("File content must be a string.")

    encoded = content.encode("utf-8")

    if len(encoded) > MAX_WRITE_SIZE:
        raise ValueError(
            "Generated content exceeds the 700 KB write limit."
        )

    if approved is not True:
        record_audit(
            "write_file",
            project_id,
            relative_path,
            "rejected",
        )

        return {
            "ok": False,
            "cancelled": True,
            "error": "Explicit write approval is required.",
        }

    parent_fd = None
    original_fd = None
    temporary_fd = None
    temporary_name = None
    backup_path = None

    try:
        parent_fd, filename = open_project_parent(
            root,
            relative_path,
        )

        try:
            original_stat = os.stat(
                filename,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )

        except FileNotFoundError:
            original_stat = None

        if original_stat is not None:
            if not stat.S_ISREG(original_stat.st_mode):
                raise ValueError(
                    "Destination must be a regular file. "
                    "Symbolic links and special files are prohibited."
                )

            original_fd = os.open(
                filename,
                os.O_RDONLY
                | os.O_NOFOLLOW
                | os.O_NONBLOCK
                | os.O_CLOEXEC,
                dir_fd=parent_fd,
            )

            opened_stat = os.fstat(original_fd)

            if not stat.S_ISREG(opened_stat.st_mode):
                raise ValueError(
                    "Destination is not a regular file."
                )

            if (
                opened_stat.st_dev != original_stat.st_dev
                or opened_stat.st_ino != original_stat.st_ino
            ):
                raise ValueError(
                    "Destination changed during validation. "
                    "Please retry the operation."
                )

            backup_path = backup_open_file(
                project_id,
                relative_path,
                original_fd,
            )

            file_mode = stat.S_IMODE(
                opened_stat.st_mode
            ) & 0o777

        else:
            file_mode = 0o600

        temporary_name = (
            f".promptflow-{secrets.token_hex(16)}.tmp"
        )

        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
            0o600,
            dir_fd=parent_fd,
        )

        if original_stat is not None:
            os.fchmod(
                temporary_fd,
                file_mode,
            )

        view = memoryview(encoded)
        offset = 0

        while offset < len(view):
            written = os.write(
                temporary_fd,
                view[offset:],
            )

            if written <= 0:
                raise OSError(
                    "Unable to complete the file write."
                )

            offset += written

        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        try:
            current_stat = os.stat(
                filename,
                dir_fd=parent_fd,
                follow_symlinks=False,
            )

        except FileNotFoundError:
            current_stat = None

        if original_stat is None:
            if current_stat is not None:
                raise ValueError(
                    "A file appeared at the destination during writing. "
                    "Please retry."
                )

        else:
            if (
                current_stat is None
                or current_stat.st_dev != original_stat.st_dev
                or current_stat.st_ino != original_stat.st_ino
            ):
                raise ValueError(
                    "Destination changed during writing. "
                    "The original file was not replaced."
                )

        os.replace(
            temporary_name,
            filename,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
        )

        temporary_name = None

        os.fsync(parent_fd)

        record_audit(
            "write_file",
            project_id,
            relative_path,
        )

        return {
            "ok": True,
            "path": relative_path,
            "backup": backup_path,
            "created": backup_path is None,
            "message": "File successfully written.",
        }

    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)

        if temporary_name is not None and parent_fd is not None:
            try:
                os.unlink(
                    temporary_name,
                    dir_fd=parent_fd,
                )
            except FileNotFoundError:
                pass

        if original_fd is not None:
            os.close(original_fd)

        if parent_fd is not None:
            os.close(parent_fd)
'''


def add_imports(source: str) -> str:
    for import_statement in REQUIRED_IMPORTS:
        if re.search(
            rf"^{re.escape(import_statement)}$",
            source,
            re.MULTILINE,
        ):
            continue

        source = re.sub(
            r"^(import os\s*)$",
            rf"\1\n{import_statement}",
            source,
            count=1,
            flags=re.MULTILINE,
        )

    return source


def replace_implementation(source: str) -> str:
    start_pattern = re.compile(
        r"^def backup_file\(",
        re.MULTILINE,
    )

    end_pattern = re.compile(
        r"^# ---------------------------------------------------------------------\n"
        r"# PROJECT REMOVAL",
        re.MULTILINE,
    )

    start_match = start_pattern.search(source)
    end_match = end_pattern.search(source)

    if not start_match:
        raise RuntimeError(
            "Existing backup_file() function was not found."
        )

    if not end_match or end_match.start() <= start_match.start():
        raise RuntimeError(
            "PROJECT REMOVAL section was not found after file operations."
        )

    return (
        source[:start_match.start()]
        + SECURE_IMPLEMENTATION.strip()
        + "\n\n\n"
        + source[end_match.start():]
    )


def main():
    if not HOST_FILE.is_file():
        raise FileNotFoundError(
            f"Native host file not found: {HOST_FILE}"
        )

    original = HOST_FILE.read_text(
        encoding="utf-8"
    )

    if "def open_project_parent(" in original:
        raise RuntimeError(
            "Secure file operations already appear to be installed. "
            "No changes were made."
        )

    updated = add_imports(original)
    updated = replace_implementation(updated)

    backup_file = HOST_FILE.with_name(
        "host.py.backup."
        + datetime.now().strftime("%Y%m%d-%H%M%S")
    )

    shutil.copy2(
        HOST_FILE,
        backup_file,
    )

    HOST_FILE.write_text(
        updated,
        encoding="utf-8",
    )

    print("Native host updated successfully.")
    print(f"Updated file: {HOST_FILE}")
    print(f"Original backup: {backup_file}")

    print("\nChecking Python syntax...")

    import py_compile

    try:
        py_compile.compile(
            str(HOST_FILE),
            doraise=True,
        )

    except py_compile.PyCompileError:
        shutil.copy2(
            backup_file,
            HOST_FILE,
        )

        print(
            "Syntax validation failed. "
            "The original host.py has been restored."
        )

        raise

    print("Python syntax validation passed.")


if __name__ == "__main__":
    try:
        main()

    except Exception as error:
        print(
            f"UPDATE FAILED: {error}",
            file=sys.stderr,
        )

        sys.exit(1)
