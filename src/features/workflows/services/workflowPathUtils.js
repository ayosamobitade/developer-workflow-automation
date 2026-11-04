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