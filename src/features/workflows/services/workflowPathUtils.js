export function normalizeWorkflowPath(path) {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");
}


export function isInitFilePath(path) {
    const normalized = normalizeWorkflowPath(path);
    const filename = normalized.split("/").pop();

    return filename === "__init__.py";
}


/**
 * Removes __init__.py entries from Linux tree output while
 * preserving all directory entries and their hierarchy.
 */
export function filterProjectTree(projectTree) {
    if (typeof projectTree !== "string") {
        return "";
    }

    return projectTree
        .split(/\r?\n/)
        .filter((line) => {
            const match = line.match(
                /^(.*?)(?:├── |└── )(.+?)\s*$/u
            );

            if (!match) {
                return true;
            }

            const entryName = match[2].replace(/\/$/, "").trim();

            return entryName !== "__init__.py";
        })
        .join("\n");
}


/**
 * Builds a compact project tree containing model directories and their
 * parent directories. Test directories and their contents are excluded.
 *
 * The original project tree remains available to internal file operations.
 */
export function filterModelProjectTree(projectTree) {
    if (typeof projectTree !== "string" || !projectTree.trim()) {
        return "";
    }

    const lines = projectTree.split(/\r?\n/);
    const rootName = lines[0]?.trim();

    if (!rootName) {
        return "";
    }

    const entries = [];
    const directoryStack = [];

    for (const line of lines.slice(1)) {
        const match = line.match(/^(.*?)(?:├── |└── )(.+?)\s*$/u);

        if (!match) {
            continue;
        }

        const prefix = match[1];
        const depth = Math.floor(prefix.length / 4);
        const rawName = match[2].trim();
        const isDirectory = rawName.endsWith("/");
        const name = rawName.replace(/\/$/, "");

        directoryStack.length = depth;

        const path = [...directoryStack, name];

        entries.push({
            path,
            isDirectory,
        });

        if (isDirectory) {
            directoryStack[depth] = name;
        }
    }

    // const modelRoots = entries
    //     .filter((entry) => {
    //         if (!entry.isDirectory) {
    //             return false;
    //         }

    //         const modelIndex = entry.path.lastIndexOf("models");

    //         return (
    //             modelIndex !== -1 &&
    //             entry.path[modelIndex] === "models" &&
    //             !entry.path.slice(0, modelIndex).includes("tests")
    //         );
    //     })
    //     .map((entry) => entry.path);

    const modelRoots = entries
        .filter((entry) => {
            if (!entry.isDirectory) {
                return false;
            }

            return (
                entry.path.at(-1) === "models" &&
                !entry.path.slice(0, -1).includes("tests")
            );
        })
        .map((entry) => entry.path);


    if (!modelRoots.length) {
        return rootName;
    }

    const selectedDirectories = new Set();
    const selectedFiles = new Set();

    for (const modelRoot of modelRoots) {
        // Keep the parent directories needed to reach this models directory.
        for (let index = 1; index <= modelRoot.length; index += 1) {
            selectedDirectories.add(
                modelRoot.slice(0, index).join("/")
            );
        }

        for (const entry of entries) {
            const entryPath = entry.path.join("/");
            const modelPath = modelRoot.join("/");

            const isInsideModelRoot =
                entryPath.startsWith(`${modelPath}/`);

            if (!isInsideModelRoot) {
                continue;
            }

            // Do not expose test directories, including nested test folders.
            if (entry.path.includes("tests")) {
                continue;
            }

            if (entry.isDirectory) {
                selectedDirectories.add(entryPath);
            } else {
                selectedFiles.add(entryPath);
            }
        }
    }

    const root = {
        directories: new Map(),
        files: [],
    };

    function ensureDirectory(pathParts) {
        let current = root;

        for (const part of pathParts) {
            if (!current.directories.has(part)) {
                current.directories.set(part, {
                    directories: new Map(),
                    files: [],
                });
            }

            current = current.directories.get(part);
        }

        return current;
    }

    for (const directoryPath of selectedDirectories) {
        ensureDirectory(directoryPath.split("/"));
    }

    for (const filePath of selectedFiles) {
        const parts = filePath.split("/");
        const filename = parts.pop();
        ensureDirectory(parts).files.push(filename);
    }

    const output = [rootName];

    function render(node, prefix = "") {
        const directories = Array.from(node.directories.entries())
            .map(([name, directory]) => ({
                name,
                directory,
            }));

        const files = node.files.map((name) => ({
            name,
            directory: null,
        }));

        const children = [...directories, ...files].sort((a, b) =>
            `${a.name}/`.localeCompare(`${b.name}/`)
        );

        children.forEach((entry, index) => {
            const isLast = index === children.length - 1;
            const branch = isLast ? "└── " : "├── ";
            const suffix = entry.directory ? "/" : "";

            output.push(`${prefix}${branch}${entry.name}${suffix}`);

            if (entry.directory) {
                render(
                    entry.directory,
                    prefix + (isLast ? "    " : "│   ")
                );
            }
        });
    }

    render(root);

    return output.join("\n");
}
