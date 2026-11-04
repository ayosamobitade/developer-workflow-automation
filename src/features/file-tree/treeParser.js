const TREE_BRANCH_PATTERN = /^(.*?)(?:├── |└── )(.*)$/u;

/**
 * Parses output from the Linux `tree` command.
 *
 * Supports:
 * - Normal tree output.
 * - `tree -F` output, where directories end with /.
 * - Nested directory structures.
 *
 * @param {string} treeText
 * @param {{ includeInitFiles?: boolean }} options
 */
export function parseFileTree(treeText, options = {}) {
    const { includeInitFiles = false } = options;

    if (!treeText || typeof treeText !== "string") {
        throw new Error("Please provide a file tree.");
    }

    const lines = treeText
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => line.trim());

    const entries = [];

    for (const line of lines) {
        const match = line.match(TREE_BRANCH_PATTERN);

        if (!match) continue;

        const [, prefix, rawName] = match;

        const depth = Math.floor(prefix.length / 4);

        const name = rawName.trim();

        if (!name || name === "." || name === "..") continue;

        entries.push({
            name,
            depth,
        });
    }

    if (!entries.length) {
        throw new Error(
            "No files were detected. Paste output from the Linux tree command."
        );
    }

    const directoryStack = [];
    const files = [];

    entries.forEach((entry, index) => {
        while (directoryStack.length > entry.depth) {
            directoryStack.pop();
        }

        const isExplicitDirectory = entry.name.endsWith("/");

        const nextEntry = entries[index + 1];

        const hasChildren =
            nextEntry && nextEntry.depth > entry.depth;

        const name = entry.name.replace(/\/$/, "");

        const relativePath = [
            ...directoryStack,
            name,
        ].join("/");

        if (isExplicitDirectory || hasChildren) {
            directoryStack.push(name);
            return;
        }

        if (!includeInitFiles && name === "__init__.py") {
            return;
        }

        files.push({
            id: relativePath,
            name,
            path: relativePath,
            status: "pending",
        });
    });

    if (!files.length) {
        throw new Error("No eligible files were found in the tree.");
    }

    return files;
}