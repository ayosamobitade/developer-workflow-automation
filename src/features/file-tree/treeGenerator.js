function createNode(name) {
    return {
        name,
        directories: new Map(),
        files: [],
    };
}

export function generateFileTree(files, projectName = "project") {
    if (!Array.isArray(files) || !files.length) {
        throw new Error("No project files are available.");
    }

    const root = createNode(projectName);

    for (const file of files) {
        const segments = file.path
            .split("/")
            .filter(Boolean);

        let current = root;

        segments.forEach((segment, index) => {
            const isFile = index === segments.length - 1;

            if (isFile) {
                current.files.push(segment);
                return;
            }

            if (!current.directories.has(segment)) {
                current.directories.set(
                    segment,
                    createNode(segment)
                );
            }

            current = current.directories.get(segment);
        });
    }

    const lines = [projectName];

    function render(node, prefix = "") {
        const entries = [
            ...Array.from(node.directories.values()).map(
                (directory) => ({
                    name: `${directory.name}/`,
                    directory,
                })
            ),
            ...node.files.map((name) => ({
                name,
                directory: null,
            })),
        ].sort((a, b) =>
            a.name.localeCompare(b.name)
        );

        entries.forEach((entry, index) => {
            const isLast = index === entries.length - 1;
            const branch = isLast ? "└── " : "├── ";

            lines.push(`${prefix}${branch}${entry.name}`);

            if (entry.directory) {
                render(
                    entry.directory,
                    prefix + (isLast ? "    " : "│   ")
                );
            }
        });
    }

    render(root);

    return lines.join("\n");
}