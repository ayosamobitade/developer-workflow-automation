const REQUEST_START = "<<<PROMPTFLOW_DEPENDENCY_REQUEST_START>>>";
const REQUEST_END = "<<<PROMPTFLOW_DEPENDENCY_REQUEST_END>>>";
const FILE_START = "<<<PROMPTFLOW_DEPENDENCY_FILE_START>>>";
const FILE_END = "<<<PROMPTFLOW_DEPENDENCY_FILE_END>>>";

export function normalizeDependencyPath(path) {
    if (typeof path !== "string" || !path.trim()) {
        throw new Error("ChatGPT requested a dependency without a file path.");
    }

    const normalized = path.trim().replace(/\\/g, "/");

    if (
        normalized.startsWith("/") ||
        /^[A-Za-z]:/.test(normalized) ||
        normalized.split("/").some((part) =>
            !part || part === "." || part === ".."
        ) ||
        normalized.split("/").at(-1) === "__init__.py"
    ) {
        throw new Error(`Unsafe dependency file path: "${path}".`);
    }

    return normalized;
}

export function extractDependencyRequest(responseText) {
    if (typeof responseText !== "string") return null;

    const start = responseText.indexOf(REQUEST_START);
    if (start < 0) return null;

    const bodyStart = start + REQUEST_START.length;
    const end = responseText.indexOf(REQUEST_END, bodyStart);

    if (end < 0) {
        throw new Error("ChatGPT returned an incomplete dependency request.");
    }

    let request;
    try {
        request = JSON.parse(responseText.slice(bodyStart, end).trim());
    } catch {
        throw new Error("ChatGPT returned an invalid dependency request.");
    }

    return {
        path: normalizeDependencyPath(request.path),
        reason: typeof request.reason === "string"
            ? request.reason.trim()
            : "",
        requiredFor: typeof request.requiredFor === "string"
            ? request.requiredFor.trim()
            : "",
    };
}

export function buildDependencyFilePrompt(request) {
    const path = normalizeDependencyPath(request.path);

    return [
        "PROMPTFLOW DEPENDENCY FILE GENERATION",
        "=====================================",
        "The original workflow needs this dependency file before it can continue.",
        `Required path: ${path}`,
        request.reason ? `Why it is required: ${request.reason}` : "",
        request.requiredFor ? `Used by: ${request.requiredFor}` : "",
        "",
        "Generate only this one complete file. Follow the existing project conventions if they were supplied in the conversation.",
        "Do not generate the original requested deliverable yet.",
        "Do not generate __init__.py.",
        "Return the entire file inside exactly one fenced code block between these exact markers:",
        FILE_START,
        "```python",
        "[COMPLETE FILE CONTENT]",
        "```",
        FILE_END,
        "Do not add commentary inside the markers.",
    ].filter(Boolean).join("\n");
}

export function extractDependencyFile(responseText) {
    if (typeof responseText !== "string") {
        throw new Error("ChatGPT did not return dependency file content.");
    }

    const start = responseText.indexOf(FILE_START);
    const end = responseText.indexOf(FILE_END, start + FILE_START.length);

    if (start < 0 || end < 0) {
        throw new Error("ChatGPT did not return the required dependency file markers.");
    }

    const markedContent = responseText.slice(
        start + FILE_START.length,
        end
    ).trim();

    const match = markedContent.match(/^```[A-Za-z0-9_+-]*\s*\n([\s\S]*?)\n```\s*$/);
    if (!match || !match[1].trim()) {
        throw new Error("The generated dependency file is empty or incorrectly formatted.");
    }

    return match[1].replace(/\r\n/g, "\n");
}

export function buildPromptWithDependencySources(originalPrompt, dependencies) {
    const sections = dependencies.map((dependency) => [
        `DEPENDENCY FILE AVAILABLE: ${dependency.path}`,
        `Reason requested: ${dependency.reason || "Required by the implementation."}`,
        "```",
        dependency.content,
        "```",
    ].join("\n"));

    return [
        originalPrompt,
        "",
        "PROMPTFLOW AUTOMATICALLY RESOLVED THE FOLLOWING ADDITIONAL PROJECT FILES.",
        "Use these exact files as source context and now complete the original task.",
        ...sections,
    ].join("\n\n");
}

/**
 * Sends a dependency as a separate ChatGPT message. The original task
 * instruction is deliberately not modified or combined with file contents.
 */
export function buildDependencyContextPrompt(request, content) {
    const path = normalizeDependencyPath(request.path);

    if (typeof content !== "string" || !content.trim()) {
        throw new Error(`Dependency file "${path}" has no content to provide.`);
    }

    return [
        "PROMPTFLOW ADDITIONAL SOURCE FILE",
        "=================================",
        `Requested file: ${path}`,
        request.reason ? `Reason: ${request.reason}` : "",
        request.requiredFor ? `Required for: ${request.requiredFor}` : "",
        "",
        "The following is the complete content read from the project. Treat it as source context; do not recreate or modify it.",
        `<<<PROMPTFLOW_DEPENDENCY_SOURCE_START:${path}>>>`,
        "```",
        content,
        "```",
        `<<<PROMPTFLOW_DEPENDENCY_SOURCE_END:${path}>>>`,
        "",
        "I will now resend the exact prompt instruction that was interrupted. Follow that next instruction using this source file.",
    ].filter(Boolean).join("\n");
}
