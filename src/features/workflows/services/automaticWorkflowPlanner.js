// src/features/workflows/services/automaticWorkflowPlanner.js

import { isInitFilePath } from "./workflowPathUtils.js";

const OUTPUT_PATHS = Object.freeze({
    "create_model.model": (model) => model.modelPath,
    "create_factory_and_model_test.model_factory": (model) => [
        ...model.appRoot, "tests", "factories", `${model.modelName}_factory.py`,
    ].join("/"),
    "create_factory_and_model_test.model_test": (model) => [
        ...model.appRoot, "tests", "models", `test_${model.modelName}.py`,
    ].join("/"),
    "create_selector.selector": (model) => [
        ...model.appRoot, "selectors", ...model.modelGroup,
        `${model.modelName}_selector.py`,
    ].join("/"),
    "create_selector_test.selector_test": (model) => [
        ...model.appRoot, "tests", "selectors", ...model.modelGroup,
        `test_${model.modelName}_selector.py`,
    ].join("/"),
    "create_service.service": (model) => [
        ...model.appRoot, "services", ...model.modelGroup,
        `${model.modelName}_service.py`,
    ].join("/"),
    "create_service_test.service_test": (model) => [
        ...model.appRoot, "tests", "services", ...model.modelGroup,
        `test_${model.modelName}_service.py`,
    ].join("/"),
});

function normalizePath(path) {
    const normalized = String(path || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");

    if (!normalized || normalized.split("/").some(
        (part) => !part || part === "." || part === ".."
    ) || isInitFilePath(normalized)) {
        throw new Error(`Invalid project-relative Python path: "${path}".`);
    }

    return normalized;
}

function getModelParts(modelPath) {
    const path = normalizePath(modelPath);
    const parts = path.split("/");
    const index = parts.lastIndexOf("models");

    if (!path.endsWith(".py") || index < 0 || index === parts.length - 1) {
        throw new Error(`"${path}" is not a valid Django model file.`);
    }

    const filename = parts.pop();
    return {
        modelPath: path,
        modelName: filename.replace(/\.py$/i, ""),
        appRoot: parts.slice(0, index),
        modelGroup: parts.slice(index + 1),
    };
}

function normalizeFiles(files) {
    if (!Array.isArray(files)) {
        throw new TypeError("The native project file list must be an array.");
    }

    return new Set(files.map((file) => normalizePath(
        typeof file === "string" ? file : file?.path
    )));
}

/**
 * Inspects every conventional deliverable for one selected model.
 *
 * Existing non-empty files are supplied to their corresponding task as
 * continuation context. PromptFlow asks ChatGPT to assess and complete the
 * existing implementation rather than blindly replacing it. The original
 * contents are retained as a write-time snapshot for safe backup/conflict
 * detection.
 */
export async function planAutomaticWorkflow({
    modelPath,
    listFiles,
    readFile,
} = {}) {
    if (typeof listFiles !== "function" || typeof readFile !== "function") {
        throw new TypeError("listFiles and readFile must be functions.");
    }

    const model = getModelParts(modelPath);
    const files = normalizeFiles(await listFiles());
    const existingFiles = {};
    const deliverables = [];

    for (const [key, buildPath] of Object.entries(OUTPUT_PATHS)) {
        const [taskId, outputId] = key.split(".");
        const path = normalizePath(buildPath(model));
        const exists = files.has(path);

        let status = exists ? "empty" : "missing";
        let content = "";

        if (exists) {
            const response = await readFile(path);
            if (!response || typeof response.content !== "string") {
                throw new Error(`Unable to inspect existing file "${path}".`);
            }

            content = response.content;
            if (content.trim()) {
                status = "existing";
                existingFiles[key] = {
                    path,
                    content,
                };
            }
        }

        deliverables.push({
            taskId,
            outputId,
            path,
            status,
            hasContent: Boolean(content.trim()),
        });
    }

    return {
        modelPath: model.modelPath,
        existingFiles,
        deliverables,
        summary: {
            total: deliverables.length,
            missing: deliverables.filter((item) => item.status === "missing").length,
            empty: deliverables.filter((item) => item.status === "empty").length,
            existing: deliverables.filter((item) => item.status === "existing").length,
        },
    };
}
