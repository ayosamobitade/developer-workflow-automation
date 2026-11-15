import test from "node:test";
import assert from "node:assert/strict";

import {
    normalizeDependencyPath,
    extractDependencyRequest,
    buildDependencyFilePrompt,
    extractDependencyFile,
    buildPromptWithDependencySources,
} from "../../services/dependencyResolutionService.js";

test("parses a structured dependency request", () => {
    const response = [
        "I need another source file.",
        "<<<PROMPTFLOW_DEPENDENCY_REQUEST_START>>>",
        JSON.stringify({
            path: "core/accounts/models/user.py",
            reason: "I need the related user fields.",
            requiredFor: "Foreign key validation",
        }),
        "<<<PROMPTFLOW_DEPENDENCY_REQUEST_END>>>",
    ].join("\n");

    assert.deepEqual(extractDependencyRequest(response), {
        path: "core/accounts/models/user.py",
        reason: "I need the related user fields.",
        requiredFor: "Foreign key validation",
    });
});

test("rejects unsafe dependency paths", () => {
    for (const path of ["../secrets.py", "/etc/passwd", "core/../secret.py", "core/app/models/__init__.py"]) {
        assert.throws(() => normalizeDependencyPath(path));
    }
});

test("returns null when ChatGPT did not request a dependency", () => {
    assert.equal(extractDependencyRequest("Here is the completed implementation."), null);
});

test("builds a separate dependency-file generation prompt", () => {
    const prompt = buildDependencyFilePrompt({
        path: "core/accounts/models/user.py",
        reason: "The task needs the user model.",
    });

    assert.match(prompt, /Required path: core\/accounts\/models\/user\.py/);
    assert.match(prompt, /PROMPTFLOW_DEPENDENCY_FILE_START/);
});

test("extracts complete dependency file content", () => {
    const response = [
        "<<<PROMPTFLOW_DEPENDENCY_FILE_START>>>",
        "```python",
        "class User:",
        "    pass",
        "```",
        "<<<PROMPTFLOW_DEPENDENCY_FILE_END>>>",
    ].join("\n");

    assert.equal(extractDependencyFile(response), "class User:\n    pass");
});

test("resends original prompt with resolved dependency source", () => {
    const prompt = buildPromptWithDependencySources("Create a selector.", [{
        path: "core/accounts/models/user.py",
        reason: "Related model",
        content: "class User: pass",
    }]);

    assert.match(prompt, /Create a selector\./);
    assert.match(prompt, /DEPENDENCY FILE AVAILABLE: core\/accounts\/models\/user\.py/);
    assert.match(prompt, /class User: pass/);
});
