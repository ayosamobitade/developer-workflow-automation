/**
 * Generates a prompt using the complete original tree.
 *
 * Supported placeholders:
 * [FILE]
 * {{file}}
 * [PATH]
 * {{path}}
 */
export function generatePrompt({
    tree,
    template,
    file,
    sourceContent = "",
}) {
    if (!tree?.trim()) {
        throw new Error("The original file tree is required.");
    }

    if (!template?.trim()) {
        throw new Error("Please provide an instruction template.");
    }

    if (!file?.name) {
        throw new Error("No current file was selected.");
    }

    const instruction = template
        .replace(/\[FILE\]|\{\{file\}\}/gi, file.name)
        .replace(/\[PATH\]|\{\{path\}\}/gi, file.path);

    const sections = [tree.trim()];

    if (sourceContent.trim()) {
        sections.push(
            [
                "SOURCE FILE:",
                `File: ${file.path}`,
                "",
                sourceContent.trim(),
            ].join("\n")
        );
    }

    sections.push(
        [
            "TASK:",
            instruction.trim(),
        ].join("\n")
    );

    return sections.join("\n\n");
}