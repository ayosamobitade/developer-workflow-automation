#!/usr/bin/env python3

import hashlib
import json
import os
import secrets
import stat
import struct
import sys
import fcntl
# import black

from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from contextlib import contextmanager


HOST_NAME = "com.samworld.promptflow"
HOST_VERSION = "1.2.0"

# Firefox Native Messaging has a 1 MB message limit.
MAX_MESSAGE_SIZE = 1024 * 1024

# Leave room for JSON serialization overhead.
MAX_READ_SIZE = 700 * 1024
MAX_WRITE_SIZE = 700 * 1024

MAX_FILE_COUNT = 5000

EXTENSION_ID = "promptflow@samworldtechnologies.com"


EXCLUDED_DIRECTORIES = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
    "vendor",
}


EXCLUDED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
    ".zip", ".gz", ".tar", ".rar", ".7z", ".mp3", ".mp4",
    ".wav", ".avi", ".mov", ".woff", ".woff2", ".ttf", ".otf",
    ".exe", ".dll", ".so", ".bin", ".pyc", ".db", ".sqlite",
    ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".cer", ".crt",
}


EXCLUDED_FILENAMES = {
    ".ds_store",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
}


# ---------------------------------------------------------------------
# DIRECTORIES
# ---------------------------------------------------------------------

def config_directory():
    base = Path(
        os.environ.get(
            "XDG_CONFIG_HOME",
            Path.home() / ".config",
        )
    )
    directory = base / "promptflow"
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


def data_directory():
    base = Path(
        os.environ.get(
            "XDG_DATA_HOME",
            Path.home() / ".local" / "share",
        )
    )
    directory = base / "promptflow"
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    return directory


REGISTRY_FILE = config_directory() / "projects.json"
BACKUP_DIRECTORY = data_directory() / "backups"
AUDIT_FILE = data_directory() / "audit.jsonl"

SESSION_FILE = data_directory() / "sessions.json"
SESSION_LOCK_FILE = data_directory() / "sessions.lock"

SESSION_TTL_SECONDS = 8 * 60 * 60
SESSION_TOKEN_BYTES = 32


# ---------------------------------------------------------------------
# NATIVE AUTHORIZATION SESSIONS
# ---------------------------------------------------------------------

@contextmanager
def locked_session_store():
    """
    Serialize session-store access across separate native-host processes.
    Firefox may start a new native-host process for every request.
    """
    lock_fd = os.open(
        SESSION_LOCK_FILE,
        os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
    )

    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)

        if SESSION_FILE.exists():
            session_fd = os.open(
                SESSION_FILE,
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
            )

            try:
                file_stat = os.fstat(session_fd)

                if not stat.S_ISREG(file_stat.st_mode):
                    raise ValueError("Invalid session storage file.")

                if file_stat.st_size > 2 * 1024 * 1024:
                    raise ValueError("Session storage file is too large.")

                chunks = []
                while True:
                    chunk = os.read(session_fd, 65536)
                    if not chunk:
                        break
                    chunks.append(chunk)

                data = json.loads(b"".join(chunks).decode("utf-8"))

            finally:
                os.close(session_fd)

            if not isinstance(data, dict):
                raise ValueError("Invalid session storage format.")

        else:
            data = {}

        yield data

    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)


def save_session_store(sessions):
    """Atomically save the session store with restrictive permissions."""
    encoded = json.dumps(
        sessions,
        separators=(",", ":"),
    ).encode("utf-8")

    temporary_path = SESSION_FILE.with_name(
        f".sessions-{secrets.token_hex(16)}.tmp"
    )

    temporary_fd = None

    try:
        temporary_fd = os.open(
            temporary_path,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_NOFOLLOW
            | os.O_CLOEXEC,
            0o600,
        )

        view = memoryview(encoded)
        offset = 0

        while offset < len(view):
            written = os.write(temporary_fd, view[offset:])
            if written <= 0:
                raise OSError("Unable to save session storage.")
            offset += written

        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        os.replace(temporary_path, SESSION_FILE)
        SESSION_FILE.chmod(0o600)

        directory_fd = os.open(
            SESSION_FILE.parent,
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        )

        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)

        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def create_authorization_session(
    project_id,
    directory="",
    permission="read",
    confirmed=False,
):
    if permission not in {"read", "write"}:
        raise ValueError("Unsupported session permission.")

    if permission == "write" and confirmed is not True:
        raise ValueError(
            "Explicit write authorization is required."
        )

    root, _ = get_project(project_id)

    _, normalized_directory = resolve_project_directory(
        root,
        directory,
    )

    token = secrets.token_urlsafe(SESSION_TOKEN_BYTES)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

    now = int(datetime.now(timezone.utc).timestamp())

    session = {
        "project_id": project_id,
        "directory": normalized_directory,
        "permissions": (
            ["read", "write"]
            if permission == "write"
            else ["read"]
        ),
        "created_at": now,
        "expires_at": now + SESSION_TTL_SECONDS,
    }

    with locked_session_store() as sessions:
        # Remove expired entries before adding a new session.
        sessions = {
            key: value
            for key, value in sessions.items()
            if (
                isinstance(value, dict)
                and isinstance(value.get("expires_at"), int)
                and value["expires_at"] > now
            )
        }

        sessions[token_hash] = session
        save_session_store(sessions)

    record_audit(
        "create_session",
        project_id,
        normalized_directory,
        permission,
    )

    return {
        "ok": True,
        "token": token,
        "project_id": project_id,
        "directory": normalized_directory,
        "permission": permission,
        "expires_at": session["expires_at"],
    }


def validate_authorization_session(
    token,
    project_id,
    directory,
    operation,
):
    if not isinstance(token, str) or not token:
        raise ValueError("A valid authorization session is required.")

    if len(token) > 256:
        raise ValueError("Invalid authorization session.")

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

    root, _ = get_project(project_id)

    _, normalized_directory = resolve_project_directory(
        root,
        directory,
    )

    now = int(datetime.now(timezone.utc).timestamp())

    with locked_session_store() as sessions:
        session = sessions.get(token_hash)

        if not isinstance(session, dict):
            raise ValueError(
                "Authorization session is invalid or has been revoked."
            )

        if session.get("expires_at", 0) <= now:
            sessions.pop(token_hash, None)
            save_session_store(sessions)

            raise ValueError("Authorization session has expired.")

        if session.get("project_id") != project_id:
            raise ValueError(
                "Authorization session belongs to another project."
            )

        if session.get("directory") != normalized_directory:
            raise ValueError(
                "Authorization session belongs to another working directory."
            )

        permissions = session.get("permissions", [])

        if operation == "read" and "read" not in permissions:
            raise ValueError("Read permission is not granted.")

        if operation == "write" and "write" not in permissions:
            raise ValueError("Write permission is not granted.")

        if operation not in {"read", "write"}:
            raise ValueError("Unsupported authorization operation.")

        return {
            "project_id": project_id,
            "directory": normalized_directory,
            "permissions": permissions,
        }


def revoke_authorization_session(token):
    if not isinstance(token, str) or not token:
        return {
            "ok": True,
            "revoked": False,
        }

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

    with locked_session_store() as sessions:
        existed = token_hash in sessions

        sessions.pop(token_hash, None)

        if existed:
            save_session_store(sessions)

    return {
        "ok": True,
        "revoked": existed,
    }

# ---------------------------------------------------------------------
# NATIVE MESSAGING
# ---------------------------------------------------------------------

def read_exact(stream, size):
    chunks = []
    remaining = size

    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            if not chunks:
                return None
            raise EOFError("Incomplete native messaging request.")
        chunks.append(chunk)
        remaining -= len(chunk)

    return b"".join(chunks)


def receive_message():
    header = read_exact(sys.stdin.buffer, 4)
    if header is None:
        return None

    message_size = struct.unpack("=I", header)[0]
    if message_size == 0:
        raise ValueError("Empty native messaging request.")
    if message_size > MAX_MESSAGE_SIZE:
        raise ValueError(
            "Incoming message exceeds Firefox's message size limit."
        )

    payload = read_exact(sys.stdin.buffer, message_size)
    if payload is None:
        raise ValueError("Missing native messaging payload.")

    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid JSON request.") from error


def send_message(payload):
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
    ).encode("utf-8")

    if len(encoded) > MAX_MESSAGE_SIZE:
        encoded = json.dumps({
            "ok": False,
            "error": (
                "Response exceeds Firefox's native messaging "
                "size limit."
            ),
        }).encode("utf-8")

    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------------
# REGISTRY
# ---------------------------------------------------------------------

def load_registry():
    if not REGISTRY_FILE.exists():
        return {"projects": {}}

    try:
        with REGISTRY_FILE.open("r", encoding="utf-8") as file:
            data = json.load(file)

        if not isinstance(data, dict):
            return {"projects": {}}

        projects = data.get("projects")
        if not isinstance(projects, dict):
            return {"projects": {}}

        return {
            "projects": {
                project_id: project
                for project_id, project in projects.items()
                if (
                    isinstance(project_id, str)
                    and isinstance(project, dict)
                    and isinstance(project.get("path"), str)
                    and isinstance(project.get("name"), str)
                )
            }
        }

    except (OSError, json.JSONDecodeError):
        return {"projects": {}}


def save_registry(registry):
    temporary_file = REGISTRY_FILE.with_suffix(".tmp")

    try:
        with temporary_file.open("w", encoding="utf-8") as file:
            json.dump(registry, file, indent=2)
            file.flush()
            os.fsync(file.fileno())

        temporary_file.chmod(0o600)
        os.replace(temporary_file, REGISTRY_FILE)

    finally:
        if temporary_file.exists():
            temporary_file.unlink()


# ---------------------------------------------------------------------
# AUDIT
# ---------------------------------------------------------------------

def timestamp():
    return datetime.now(timezone.utc).isoformat()


def record_audit(
    operation,
    project_id,
    relative_path="",
    result="success",
):
    entry = {
        "timestamp": timestamp(),
        "operation": operation,
        "project_id": project_id,
        "path": relative_path,
        "result": result,
    }

    with AUDIT_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


# ---------------------------------------------------------------------
# FILE EXCLUSIONS
# ---------------------------------------------------------------------

def should_exclude(relative_path):
    if not isinstance(relative_path, str):
        return True

    parts = relative_path.split("/")
    if not parts:
        return True

    filename = parts[-1].lower()

    if any(part.lower() in EXCLUDED_DIRECTORIES for part in parts):
        return True

    if Path(filename).suffix.lower() in EXCLUDED_EXTENSIONS:
        return True

    if filename in EXCLUDED_FILENAMES:
        return True

    if filename == ".env" or filename.startswith(".env."):
        return True

    if "secret" in filename or "credential" in filename:
        return True

    return False


# ---------------------------------------------------------------------
# PROJECT REGISTRATION
# ---------------------------------------------------------------------

def register_project(directory_path):
    if not directory_path:
        raise ValueError("A project directory path is required.")

    root = Path(directory_path).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("The selected project path is not a directory.")

    project_id = hashlib.sha256(
        str(root).encode("utf-8")
    ).hexdigest()[:20]

    registry = load_registry()
    registry["projects"][project_id] = {
        "name": root.name,
        "path": str(root),
        "added_at": timestamp(),
    }
    save_registry(registry)

    record_audit("register_project", project_id)

    return {
        "ok": True,
        "project": {
            "id": project_id,
            "name": root.name,
            "path": str(root),
        },
    }


def get_project(project_id):
    if not isinstance(project_id, str) or not project_id:
        raise ValueError("A valid project ID is required.")

    registry = load_registry()
    project = registry["projects"].get(project_id)
    if not project:
        raise ValueError(
            "Project has not been approved in PromptFlow."
        )

    root = Path(project["path"]).resolve(strict=True)
    if not root.is_dir():
        raise ValueError(
            "The approved project directory is unavailable."
        )

    return root, project


# ---------------------------------------------------------------------
# PROJECT PATH VALIDATION AND WORKING-DIRECTORY SCOPE
# ---------------------------------------------------------------------

def parse_project_relative_path(relative_path, label="file"):
    """Validate a project-relative POSIX path without normalizing it."""
    if (
        not isinstance(relative_path, str)
        or not relative_path
        or "\x00" in relative_path
        or "\\" in relative_path
        or relative_path.startswith("/")
    ):
        raise ValueError(f"A valid project-relative {label} path is required.")

    raw_parts = relative_path.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError(f"Invalid project-relative {label} path.")

    parsed = PurePosixPath(relative_path)
    if parsed.is_absolute() or not parsed.parts:
        raise ValueError(f"Invalid project-relative {label} path.")

    return tuple(raw_parts)


def resolve_project_directory(root, directory=""):
    """
    Resolve a selected working directory inside the approved project.

    An empty directory selects the project root. Every component is
    checked without accepting symlinks or traversal components.
    Returns (resolved_directory, normalized_project_relative_path).
    """
    if directory is None:
        directory = ""

    if not isinstance(directory, str):
        raise ValueError("Working directory must be a relative path.")

    if directory == "":
        return root, ""

    parts = parse_project_relative_path(
        directory,
        label="working directory",
    )

    current = root
    for part in parts:
        current = current / part

        if current.is_symlink():
            raise ValueError(
                "Symbolic links are not allowed in the working directory."
            )

        try:
            current_stat = current.stat()
        except FileNotFoundError as error:
            raise FileNotFoundError(
                "The selected working directory does not exist."
            ) from error

        if not stat.S_ISDIR(current_stat.st_mode):
            raise ValueError(
                "The selected working directory is not a directory."
            )

    resolved = current.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(
            "Working directory is outside the approved project."
        ) from error

    return resolved, "/".join(parts)


def enforce_directory_scope(relative_path, directory=""):
    """Reject a project-relative file path outside the selected directory."""
    file_parts = parse_project_relative_path(relative_path, label="file")

    if directory in (None, ""):
        return

    directory_parts = parse_project_relative_path(
        directory,
        label="working directory",
    )

    if file_parts[:len(directory_parts)] != directory_parts:
        raise ValueError(
            "File is outside the selected working directory."
        )



def resolve_project_file(
    root,
    relative_path,
    allow_missing=False,
):
    parts = parse_project_relative_path(relative_path, label="file")
    current = root

    for index, part in enumerate(parts):
        current = current / part

        if current.is_symlink():
            raise ValueError("Symbolic links are not allowed.")

        is_last = index == len(parts) - 1

        if not is_last and not current.is_dir():
            raise ValueError("A parent directory does not exist.")

        if is_last and not allow_missing and not current.exists():
            raise FileNotFoundError("Project file does not exist.")

    resolved = current.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(
            "File path is outside the approved project."
        ) from error

    return resolved


# ---------------------------------------------------------------------
# FILE LISTING
# ---------------------------------------------------------------------

def list_project_files(project_id, directory=""):
    root, _ = get_project(project_id)
    working_root, normalized_directory = resolve_project_directory(
        root,
        directory,
    )

    results = []

    for current_root, directories, filenames in os.walk(
        working_root,
        followlinks=False,
    ):
        current_path = Path(current_root)

        directories[:] = [
            name
            for name in directories
            if (
                name.lower() not in EXCLUDED_DIRECTORIES
                and not (current_path / name).is_symlink()
            )
        ]

        for filename in filenames:
            file_path = current_path / filename
            if file_path.is_symlink():
                continue

            relative_path = file_path.relative_to(root).as_posix()
            if should_exclude(relative_path):
                continue

            try:
                if not file_path.is_file():
                    continue
                if file_path.stat().st_size > MAX_READ_SIZE:
                    continue
            except OSError:
                continue

            results.append(relative_path)
            if len(results) >= MAX_FILE_COUNT:
                break

        if len(results) >= MAX_FILE_COUNT:
            break

    results.sort()
    record_audit("list_files", project_id, normalized_directory)

    return {
        "ok": True,
        "files": results,
        "count": len(results),
        "directory": normalized_directory,
    }


def list_project_directories(project_id, directory=""):
    root, _ = get_project(project_id)

    working_root, normalized_directory = resolve_project_directory(
        root,
        directory,
    )

    results = {normalized_directory}

    for current_root, directories, _ in os.walk(
        working_root,
        topdown=True,
        followlinks=False,
    ):
        current_path = Path(current_root)

        directories[:] = sorted(
            name
            for name in directories
            if (
                name.lower() not in EXCLUDED_DIRECTORIES
                and not (current_path / name).is_symlink()
            )
        )

        for name in directories:
            directory_path = current_path / name

            try:
                if not directory_path.is_dir():
                    continue

                relative_path = directory_path.relative_to(root).as_posix()

                if should_exclude(relative_path):
                    continue

                results.add(relative_path)

            except (OSError, ValueError):
                continue

    sorted_directories = sorted(
        results,
        key=lambda path: (path.count("/"), path.lower()),
    )

    record_audit(
        "list_directories",
        project_id,
        normalized_directory,
    )

    return {
        "ok": True,
        "directories": sorted_directories,
        "count": len(sorted_directories),
        "directory": normalized_directory,
    }
# ---------------------------------------------------------------------
# FILE READING
# ---------------------------------------------------------------------

def read_project_file(project_id, relative_path, directory=""):
    root, _ = get_project(project_id)

    _, normalized_directory = resolve_project_directory(
        root,
        directory,
    )

    enforce_directory_scope(
        relative_path,
        normalized_directory,
    )

    if should_exclude(relative_path):
        raise ValueError("This file type is excluded.")

    parent_fd = None
    file_fd = None

    try:
        parent_fd, filename = open_project_parent(
            root,
            relative_path,
        )

        file_fd = os.open(
            filename,
            os.O_RDONLY
            | os.O_NOFOLLOW
            | os.O_NONBLOCK
            | os.O_CLOEXEC,
            dir_fd=parent_fd,
        )

        file_stat = os.fstat(file_fd)

        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError(
                "The requested path is not a regular file."
            )

        if file_stat.st_size > MAX_READ_SIZE:
            raise ValueError(
                "File exceeds the 700 KB reading limit."
            )

        chunks = []
        total_size = 0

        while True:
            remaining = MAX_READ_SIZE + 1 - total_size

            if remaining <= 0:
                raise ValueError(
                    "File exceeds the 700 KB reading limit."
                )

            chunk = os.read(
                file_fd,
                min(64 * 1024, remaining),
            )

            if not chunk:
                break

            chunks.append(chunk)
            total_size += len(chunk)

            if total_size > MAX_READ_SIZE:
                raise ValueError(
                    "File exceeds the 700 KB reading limit."
                )

        content = b"".join(chunks)

        if b"\0" in content:
            raise ValueError("Binary files cannot be read.")

        try:
            decoded = content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(
                "File is not valid UTF-8 text."
            ) from error

        record_audit(
            "read_file",
            project_id,
            relative_path,
        )

        return {
            "ok": True,
            "path": relative_path,
            "content": decoded,
            "size": len(content),
            "directory": normalized_directory,
        }

    finally:
        if file_fd is not None:
            os.close(file_fd)

        if parent_fd is not None:
            os.close(parent_fd)

# ---------------------------------------------------------------------
# SECURE PROJECT FILE OPERATIONS
# ---------------------------------------------------------------------
def open_project_parent(root, relative_path):
    """Safely open or create a destination parent directory.

    Directory traversal is performed relative to open directory
    descriptors. Symlinks are never followed.
    """
    parts = parse_project_relative_path(
        relative_path,
        label="file",
    )

    directory_flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | os.O_CLOEXEC
    )

    current_fd = os.open(root, directory_flags)

    try:
        for part in parts[:-1]:
            try:
                next_fd = os.open(
                    part,
                    directory_flags,
                    dir_fd=current_fd,
                )

            except FileNotFoundError:
                # Create only the missing directory directly beneath
                # the directory descriptor currently being traversed.
                try:
                    os.mkdir(
                        part,
                        mode=0o755,
                        dir_fd=current_fd,
                    )
                    os.fsync(current_fd)

                except FileExistsError:
                    # Another process may have created it. Re-open it
                    # below with O_NOFOLLOW and O_DIRECTORY.
                    pass

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
    """Back up an already-open regular file using its descriptor."""
    backup_root = BACKUP_DIRECTORY / project_id
    timestamp_directory = datetime.now(timezone.utc).strftime(
        "%Y%m%dT%H%M%S%fZ"
    )
    backup_path = backup_root / timestamp_directory / relative_path

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
            chunk = os.pread(source_fd, 64 * 1024, offset)
            if not chunk:
                break

            written = 0
            while written < len(chunk):
                written += os.write(backup_fd, chunk[written:])
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
    directory="",
):
    root, _ = get_project(project_id)
    _, normalized_directory = resolve_project_directory(root, directory)
    enforce_directory_scope(relative_path, normalized_directory)

    if should_exclude(relative_path):
        raise ValueError(
            "Writing to this sensitive or excluded file is prohibited."
        )

    if not isinstance(content, str):
        raise ValueError("File content must be a string.")

    # if Path(relative_path).suffix.lower() == ".py":
    #     try:
    #         content = black.format_str(
    #             content,
    #             mode=black.FileMode(),
    #         )
    #     except black.InvalidInput as error:
    #         raise ValueError(
    #             f"Generated Python file is invalid and could not be "
    #             f"formatted: {error}"
    #         ) from error

    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_SIZE:
        raise ValueError(
            "Generated content exceeds the 700 KB write limit."
        )

    parent_fd = None
    original_fd = None
    temporary_fd = None
    temporary_name = None
    backup_path = None

    try:
        parent_fd, filename = open_project_parent(root, relative_path)

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
                raise ValueError("Destination is not a regular file.")

            if (
                opened_stat.st_dev != original_stat.st_dev
                or opened_stat.st_ino != original_stat.st_ino
            ):
                raise ValueError(
                    "Destination changed during validation. Please retry."
                )

            backup_path = backup_open_file(
                project_id,
                relative_path,
                original_fd,
            )
            file_mode = stat.S_IMODE(opened_stat.st_mode) & 0o777
        else:
            file_mode = 0o600

        temporary_name = f".promptflow-{secrets.token_hex(16)}.tmp"

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
            os.fchmod(temporary_fd, file_mode)

        view = memoryview(encoded)
        offset = 0
        while offset < len(view):
            written = os.write(temporary_fd, view[offset:])
            if written <= 0:
                raise OSError("Unable to complete the file write.")
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
        elif (
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

        record_audit("write_file", project_id, relative_path)

        return {
            "ok": True,
            "path": relative_path,
            "backup": backup_path,
            "created": backup_path is None,
            "directory": normalized_directory,
            "message": "File successfully written.",
        }

    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)

        if temporary_name is not None and parent_fd is not None:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass

        if original_fd is not None:
            os.close(original_fd)

        if parent_fd is not None:
            os.close(parent_fd)


# ---------------------------------------------------------------------
# PROJECT REMOVAL
# ---------------------------------------------------------------------

def remove_project(project_id):
    registry = load_registry()
    if project_id not in registry["projects"]:
        raise ValueError("Project was not found.")

    del registry["projects"][project_id]
    save_registry(registry)
    record_audit("remove_project", project_id)

    return {
        "ok": True,
        "message": "Project removed from the approved-project registry.",
    }


# ---------------------------------------------------------------------
# NATIVE REQUEST HANDLER
# ---------------------------------------------------------------------

def handle_request(request):
    if not isinstance(request, dict):
        raise ValueError("Request must be a JSON object.")

    action = request.get("action")

    # ---------------------------------------------------------
    # PUBLIC / INITIALIZATION OPERATIONS
    # ---------------------------------------------------------

    if action == "ping":
        return {
            "ok": True,
            "host": HOST_NAME,
            "version": HOST_VERSION,
        }

    if action == "list_projects":
        registry = load_registry()

        projects = [
            {
                "id": project_id,
                "name": project["name"],
            }
            for project_id, project in registry["projects"].items()
        ]

        return {
            "ok": True,
            "projects": projects,
        }

    # ---------------------------------------------------------
    # SESSION MANAGEMENT
    # ---------------------------------------------------------

    if action == "create_session":
        return create_authorization_session(
            project_id=request.get("project_id"),
            directory=request.get("directory", ""),
            permission=request.get("permission", "read"),
            confirmed=request.get("confirmed") is True,
        )

    if action == "revoke_session":
        return revoke_authorization_session(
            request.get("token")
        )

    # ---------------------------------------------------------
    # PROTECTED PROJECT OPERATIONS
    # ---------------------------------------------------------

    project_id = request.get("project_id")
    directory = request.get("directory", "")
    token = request.get("token")

    if action in {
        "list_files",
        "list_directories",
        "read_file",
    }:
        session = validate_authorization_session(
            token=token,
            project_id=project_id,
            directory=directory,
            operation="read",
        )

        authorized_directory = session["directory"]

        if action == "list_files":
            return list_project_files(
                project_id,
                directory=authorized_directory,
            )

        if action == "list_directories":
            return list_project_directories(
                project_id,
                directory=authorized_directory,
            )

        if action == "read_file":
            return read_project_file(
                project_id,
                request.get("path"),
                directory=authorized_directory,
            )

    if action == "write_file":
        session = validate_authorization_session(
            token=token,
            project_id=project_id,
            directory=directory,
            operation="write",
        )

        return write_project_file(
            project_id,
            request.get("path"),
            request.get("content"),
            directory=session["directory"],
        )

    if action == "remove_project":
        if request.get("confirmed") is not True:
            raise ValueError(
                "Explicit project-removal confirmation is required."
            )

        session = validate_authorization_session(
            token=token,
            project_id=project_id,
            directory=directory,
            operation="write",
        )

        if session["directory"] != "":
            raise ValueError(
                "Project removal requires a root-directory session."
            )

        return remove_project(project_id)

    raise ValueError(f"Unsupported operation: {action}")


# ---------------------------------------------------------------------
# TERMINAL COMMANDS
# ---------------------------------------------------------------------

def run_cli():
    if len(sys.argv) < 2:
        return False

    command = sys.argv[1]
    if command not in {
        "--register-project",
        "--list-projects",
        "--help",
    }:
        return False

    if command == "--register-project":
        if len(sys.argv) != 3:
            raise SystemExit(
                "Usage: python3 native/host.py "
                "--register-project /path/to/project"
            )
        result = register_project(sys.argv[2])
        print(json.dumps(result, indent=2))
        return True

    if command == "--list-projects":
        if len(sys.argv) != 2:
            raise SystemExit(
                "Usage: python3 native/host.py --list-projects"
            )
        registry = load_registry()
        projects = [
            {
                "id": project_id,
                "name": project["name"],
                "path": project["path"],
            }
            for project_id, project in registry["projects"].items()
        ]
        print(json.dumps(projects, indent=2))
        return True

    if command == "--help":
        print(
            "PromptFlow Native Host\n\n"
            "Commands:\n"
            "  --register-project PATH   Register a project directory\n"
            "  --list-projects           List registered projects\n"
            "  --help                    Show this help message"
        )
        return True

    raise SystemExit(f"Unknown command: {command}")


# ---------------------------------------------------------------------
# NATIVE HOST MAIN LOOP
# ---------------------------------------------------------------------

def debug_log(message):
    try:
        with open(
            "/tmp/promptflow-native-host-debug.log",
            "a",
            encoding="utf-8",
        ) as log_file:
            log_file.write(message + "\n")
    except Exception:
        pass


def main():
    debug_log("HOST STARTED")

    while True:
        try:
            debug_log("WAITING FOR REQUEST")
            request = receive_message()

            if request is None:
                debug_log("STDIN CLOSED")
                break

            action = (
                request.get("action")
                if isinstance(request, dict)
                else "INVALID REQUEST"
            )
            debug_log(f"REQUEST RECEIVED: {action}")

            try:
                response = handle_request(request)
            except Exception as error:
                debug_log(f"HANDLER ERROR: {error}")
                print(
                    f"PromptFlow native host error: {error}",
                    file=sys.stderr,
                    flush=True,
                )
                response = {"ok": False, "error": str(error)}

            send_message(response)
            debug_log("RESPONSE SENT")

        except (EOFError, BrokenPipeError) as error:
            debug_log(f"PIPE CLOSED: {error}")
            break
        except Exception as error:
            debug_log(f"HOST ERROR: {error}")
            print(
                f"PromptFlow native host stopped: {error}",
                file=sys.stderr,
                flush=True,
            )
            break

    debug_log("HOST EXITED")


if __name__ == "__main__":
    if not run_cli():
        main()
