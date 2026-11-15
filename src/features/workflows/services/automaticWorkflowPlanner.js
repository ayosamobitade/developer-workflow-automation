// src/features/workflows/services/automaticWorkflowPlanner.js

import { isInitFilePath } from "./workflowPathUtils.js";
import { prepareSourceContent } from "./sourcePreparationService.js";

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

    const paths = [];

    for (const file of files) {
        const rawPath = typeof file === "string" ? file : file?.path;
        const candidate = String(rawPath || "")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, "")
            .replace(/\/+/g, "/");

        // Native project listings include package __init__.py files.
        // They are irrelevant to model deliverable discovery.
        if (!candidate || isInitFilePath(candidate)) continue;

        paths.push(normalizePath(candidate));
    }

    return new Set(paths);
}


const TASK_COMPLETENESS_RULES = Object.freeze({
    create_model: "Confirm the model module contains the complete intended Django model implementation: appropriate model class(es), fields and relationships, constraints and metadata where required, custom methods/managers where applicable, and no unfinished placeholders.",
    create_factory_and_model_test: "Confirm BOTH outputs are complete: a usable factory_boy DjangoModelFactory with correct model mapping and realistic field/relationship values, plus meaningful model tests covering the model's actual fields, relationships, constraints and behavior.",
    create_selector: "Confirm the selector exposes the intended query operations for this model, uses appropriate QuerySets and filtering, handles relevant relationships efficiently, and follows the supplied project conventions.",
    create_selector_test: "Confirm meaningful tests cover the selector's actual public query operations, filtering behavior, edge cases and relationship/query behavior.",
    create_service: "Confirm the service implements the model's intended business operations, validates inputs, uses the project's selector and transaction/error-handling conventions where appropriate, and contains no placeholder logic.",
    create_service_test: "Confirm meaningful tests cover the service's public operations, successful paths, validation failures, edge cases and transactional/business behavior.",
});

export function buildImplementationAssessmentPrompt(plan, definition) {
    if (!plan || !Array.isArray(plan.deliverables) || !definition?.tasks) {
        throw new TypeError("A valid implementation plan and workflow definition are required.");
    }

    const candidates = definition.tasks.filter((task) => {
        const outputs = plan.deliverables.filter((item) => item.taskId === task.id);
        return outputs.length === task.outputs.length &&
            outputs.every((item) => item.status === "existing");
    });

    if (!candidates.length) return "";

    const sections = [
        "PROMPTFLOW EXISTING IMPLEMENTATION ASSESSMENT",
        "============================================",
        "Review the existing Django implementation files below and decide whether each workflow task is already COMPLETE or NEEDS_WORK.",
        "Do not generate or rewrite code. This is an assessment only.",
        "Be conservative: choose COMPLETE only when every output belonging to that task is genuinely production-ready, internally consistent, follows the task requirements and project conventions, and contains no TODO, FIXME, placeholder, stub, or missing core behavior.",
        "A non-empty file, a class declaration, or superficial method names are NOT sufficient evidence of completion. Consider imports, implementation bodies, error handling, data relationships, query behavior and meaningful tests as appropriate.",
        "If correctness is uncertain, choose NEEDS_WORK. For multi-output tasks, every output must be complete for the task to be COMPLETE.",
        "",
        "Return ONLY valid JSON in this exact shape:",
        '{"tasks":{"create_model":"COMPLETE","create_factory_and_model_test":"NEEDS_WORK","create_selector":"COMPLETE","create_selector_test":"NEEDS_WORK","create_service":"NEEDS_WORK","create_service_test":"NEEDS_WORK"}}',
        "Include every task ID shown below. Use only COMPLETE or NEEDS_WORK as values.",
    ];

    for (const task of candidates) {
        sections.push(
            [
                "",
                `TASK: ${task.id}`,
                `Requirements: ${task.instruction}`,
                `Completeness criteria: ${TASK_COMPLETENESS_RULES[task.id] || "Confirm every required output is complete and production-ready."}`,
                ...task.outputs.flatMap((output) => {
                    const key = `${task.id}.${output.id}`;
                    const file = plan.existingFiles[key];
                    const compacted = prepareSourceContent({
                        content: file.content,
                        path: file.path,
                        mode: "compact",
                    }).content;
                    return [
                        "",
                        `OUTPUT: ${key}`,
                        `PATH: ${file.path}`,
                        "\x60\x60\x60python",
                        compacted,
                        "\x60\x60\x60",
                    ];
                }),
            ].join("\n")
        );
    }

    return sections.join("\n");
}

export function parseImplementationAssessment(response, plan, definition) {
    const text = typeof response === "string"
        ? response
        : response?.response?.text;

    const statuses = Object.fromEntries(
        (definition?.tasks || []).map((task) => [task.id, "NEEDS_WORK"])
    );

    if (typeof text !== "string" || !text.trim()) {
        return statuses;
    }

    let parsed;
    const trimmed = text.trim()
        .replace(/^\x60{3}(?:json)?\s*/i, "")
        .replace(/\s*\x60{3}$/, "");
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start) return statuses;
        try {
            parsed = JSON.parse(trimmed.slice(start, end + 1));
        } catch {
            return statuses;
        }
    }

    const supplied = parsed?.tasks;
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        return statuses;
    }

    const eligible = new Set(
        (plan?.deliverables || [])
            .filter((item) => item.status === "existing")
            .map((item) => item.taskId)
    );

    for (const taskId of Object.keys(statuses)) {
        const value = supplied[taskId];
        if (eligible.has(taskId) && value === "COMPLETE") {
            const outputs = plan.deliverables.filter((item) => item.taskId === taskId);
            const taskDefinition = definition.tasks.find((item) => item.id === taskId);
            if (
                taskDefinition &&
                outputs.length === taskDefinition.outputs.length &&
                outputs.every((item) => item.status === "existing")
            ) {
                statuses[taskId] = "COMPLETE";
            }
        }
    }

    return statuses;
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
