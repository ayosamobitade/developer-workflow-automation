const REQUEST_START = "<<<PROMPTFLOW_DEPENDENCY_REQUEST_START>>>";
const REQUEST_END = "<<<PROMPTFLOW_DEPENDENCY_REQUEST_END>>>";

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
