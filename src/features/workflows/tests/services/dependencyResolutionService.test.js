import test from "node:test";
import assert from "node:assert/strict";

import {
    normalizeDependencyPath,
    extractDependencyRequest,
    buildDependencyContextPrompt,
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

test("builds dependency context as a separate message without embedding the original instruction", () => {
    const context = buildDependencyContextPrompt({
        path: "core/accounts/models/user.py",
        reason: "Related model",
        requiredFor: "Foreign key",
    }, "class User: pass");

    assert.match(context, /PROMPTFLOW ADDITIONAL SOURCE FILE/);
    assert.match(context, /class User: pass/);
    assert.match(context, /follow that next instruction/);
    assert.doesNotMatch(context, /Create a selector/);
});
