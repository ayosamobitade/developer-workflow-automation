#!/usr/bin/env python3

import json
import os

from pathlib import Path


HOST_NAME = "com.samworld.promptflow"

EXTENSION_ID = "promptflow@samworldtechnologies.com"

NATIVE_DIRECTORY = (
    Path.home() / ".mozilla" / "native-messaging-hosts"
)

PROJECT_DIRECTORY = Path(__file__).resolve().parent

HOST_SCRIPT = PROJECT_DIRECTORY / "host.py"

HOST_MANIFEST = NATIVE_DIRECTORY / f"{HOST_NAME}.json"


def main():
    if not HOST_SCRIPT.is_file():
        raise SystemExit(
            f"Native host script not found: {HOST_SCRIPT}"
        )

    HOST_SCRIPT.chmod(0o755)

    NATIVE_DIRECTORY.mkdir(
        parents=True,
        exist_ok=True,
    )

    manifest = {
        "name": HOST_NAME,
        "description": "PromptFlow local project companion",
        "path": str(HOST_SCRIPT),
        "type": "stdio",
        "allowed_extensions": [
            EXTENSION_ID,
        ],
    }

    temporary_manifest = HOST_MANIFEST.with_suffix(".tmp")

    with temporary_manifest.open("w", encoding="utf-8") as file:
        json.dump(manifest, file, indent=2)

    temporary_manifest.chmod(0o600)
    os.replace(temporary_manifest, HOST_MANIFEST)

    print("PromptFlow native host installed successfully.")
    print()
    print(f"Host script: {HOST_SCRIPT}")
    print(f"Host manifest: {HOST_MANIFEST}")
    print(f"Extension ID: {EXTENSION_ID}")


if __name__ == "__main__":
    main()