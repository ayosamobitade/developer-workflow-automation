// src/features/workflows/services/workflowDestinationService.js

import { parseFileTree } from "../../file-tree/treeParser.js";

import {
    isInitFilePath,
} from "./workflowPathUtils.js";


/*
 * Destination conventions are derived exclusively from the selected
 * model path. Project-tree contents never determine the destination.
 *
 * Model:
 *   <app>/models/<group>/<model>.py
 *
 * Factory:
 *   <app>/tests/factories/<model>_factory.py
 *
 * Model test:
 *   <app>/tests/models/test_<model>.py
 *
 * Selector:
 *   <app>/selectors/<group>/<model>_selector.py
 *
 * Selector test:
 *   <app>/tests/selectors/<group>/test_<model>_selector.py
 *
 * Service:
 *   <app>/services/<group>/<model>_service.py
 *
 * Service test:
 *   <app>/tests/services/<group>/test_<model>_service.py
 */

const OUTPUT_RULES = Object.freeze({
    model_factory: (model) => [
        ...model.appRoot,
        "tests",
        "factories",
        `${model.modelName}_factory.py`,
    ],

    model_test: (model) => [
        ...model.appRoot,
        "tests",
        "models",
        `test_${model.modelName}.py`,
    ],

    selector: (model) => [
        ...model.appRoot,
        "selectors",
        ...model.modelGroup,
        `${model.modelName}_selector.py`,
    ],

    selector_test: (model) => [
        ...model.appRoot,
        "tests",
        "selectors",
        ...model.modelGroup,
        `test_${model.modelName}_selector.py`,
    ],

    service: (model) => [
        ...model.appRoot,
        "services",
        ...model.modelGroup,
        `${model.modelName}_service.py`,
    ],

    service_test: (model) => [
        ...model.appRoot,
        "tests",
        "services",
        ...model.modelGroup,
        `test_${model.modelName}_service.py`,
    ],
});


function normalizePath(path) {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");
}


function getFilePaths(projectFiles = [], projectTree = "") {
    if (
        Array.isArray(projectFiles) &&
        projectFiles.length > 0
    ) {
        return projectFiles
            .map((file) =>
                typeof file === "string"
                    ? normalizePath(file)
                    : normalizePath(file?.path || file?.id)
            )
            .filter(
                (path) =>
                    Boolean(path) &&
                    !isInitFilePath(path)
            );
    }

    if (
        typeof projectTree === "string" &&
        projectTree.trim()
    ) {
        return parseFileTree(projectTree)
            .map((file) => normalizePath(file.path))
            .filter(
                (path) =>
                    Boolean(path) &&
                    !isInitFilePath(path)
            );
    }

    return [];
}


function getModelInformation(modelPath) {
    const normalized = normalizePath(modelPath);

    if (!normalized || isInitFilePath(normalized)) {
        throw new Error(
            "An __init__.py file cannot be selected as the Django model file."
        );
    }

    const segments = normalized.split("/");
    const filename = segments.pop();

    if (
        !filename ||
        !filename.toLowerCase().endsWith(".py")
    ) {
        throw new Error(
            "The selected model path must be a Python file."
        );
    }

    const modelName = filename.replace(/\.py$/i, "");
    const modelsIndex = segments.lastIndexOf("models");

    if (modelsIndex === -1) {
        throw new Error(
            `Cannot identify the models directory in "${normalized}".`
        );
    }

    const appRoot = segments.slice(0, modelsIndex);
    const modelGroup = segments.slice(modelsIndex + 1);

    return {
        modelPath: normalized,
        modelName,
        appRoot,
        modelGroup,
        modelDirectory: [
            ...appRoot,
            "models",
            ...modelGroup,
        ].join("/"),
    };
}


function fileExists(path, projectFiles) {
    return projectFiles.includes(normalizePath(path));
}


function buildConventionPath({ model, outputId }) {
    const buildPath = OUTPUT_RULES[outputId];

    if (!buildPath) {
        return null;
    }

    const path = normalizePath(
        buildPath(model).join("/")
    );

    if (!path || isInitFilePath(path)) {
        throw new Error(
            `The destination rule for "${outputId}" produced an invalid path.`
        );
    }

    return path;
}


function getExplicitDestination({
    taskId,
    outputId,
    explicitDestinations,
    workflow,
}) {
    const key = `${taskId}.${outputId}`;

    return (
        explicitDestinations?.[key] ||
        workflow?.explicitDestinations?.[key] ||
        null
    );
}


/**
 * Resolve the destination of one workflow output.
 *
 * Explicit mappings take priority. Otherwise, the destination is
 * generated from the selected model path using OUTPUT_RULES.
 *
 * The project file list is used only to report whether the resulting
 * destination currently exists. It never changes the destination path.
 */
export function resolveWorkflowOutputDestination({
    workflow,
    taskId,
    outputId,
    modelPath,
    projectFiles = [],
    projectTree = "",
    explicitDestinations = {},
} = {}) {
    if (!workflow) {
        throw new Error(
            "A workflow instance is required."
        );
    }

    if (!taskId || !outputId) {
        throw new Error(
            "Task ID and output ID are required."
        );
    }

    const files = getFilePaths(
        projectFiles,
        projectTree
    );

    const taskInstance = workflow.tasks?.find(
        (task) => task.id === taskId
    );

    const outputInstance = taskInstance?.outputs?.find(
        (output) => output.id === outputId
    );

    const assignedDestination = outputInstance?.destination;

    // Preserve an already-confirmed destination.
    if (
        assignedDestination?.path &&
        assignedDestination.confirmed
    ) {
        const path = normalizePath(
            assignedDestination.path
        );

        if (isInitFilePath(path)) {
            throw new Error(
                "PromptFlow cannot generate or update an __init__.py file."
            );
        }

        return {
            taskId,
            outputId,
            path,
            source: assignedDestination.source || "workflow",
            requiresConfirmation: false,
            confirmed: true,
            exists: fileExists(path, files),
            alternatives: [],
        };
    }

    // An explicit mapping always takes priority over conventions.
    const explicit = getExplicitDestination({
        taskId,
        outputId,
        explicitDestinations,
        workflow,
    });

    if (explicit) {
        const path = normalizePath(
            typeof explicit === "string"
                ? explicit
                : explicit.path
        );

        if (!path) {
            throw new Error(
                `Explicit destination for "${taskId}.${outputId}" is invalid.`
            );
        }

        if (isInitFilePath(path)) {
            throw new Error(
                `Destination "${path}" is not allowed. PromptFlow does not generate __init__.py files.`
            );
        }

        return {
            taskId,
            outputId,
            path,
            source: "explicit",
            requiresConfirmation: false,
            confirmed: true,
            exists: fileExists(path, files),
            alternatives: [],
        };
    }

    const resolvedModelPath =
        modelPath ||
        workflow.input?.modelPath ||
        workflow.inputs?.modelPath ||
        workflow.modelPath;

    if (!resolvedModelPath) {
        throw new Error(
            "The workflow has no selected model path."
        );
    }

    const model = getModelInformation(
        resolvedModelPath
    );

    const path = buildConventionPath({
        model,
        outputId,
    });

    if (!path) {
        return {
            taskId,
            outputId,
            path: null,
            source: "unresolved",
            requiresConfirmation: true,
            confirmed: false,
            exists: false,
            alternatives: [],
            reason:
                `No destination rule exists for output "${outputId}".`,
        };
    }

    return {
        taskId,
        outputId,
        path,
        source: "convention",
        requiresConfirmation: true,
        confirmed: false,
        exists: fileExists(path, files),
        alternatives: [],
        reason:
            "The destination was generated using the Django model path convention. Confirm it before writing.",
    };
}


/**
 * Resolve destinations for every output belonging to a workflow task.
 */
export function resolveWorkflowDestinations({
    workflow,
    taskId,
    definition,
    projectFiles = [],
    projectTree = "",
    explicitDestinations = {},
} = {}) {
    if (
        !definition ||
        !Array.isArray(definition.tasks)
    ) {
        throw new Error(
            "A valid workflow definition is required."
        );
    }

    const task = definition.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(
            `Unknown workflow task: ${taskId}`
        );
    }

    if (!Array.isArray(task.outputs)) {
        throw new Error(
            `Task "${taskId}" has no output definitions.`
        );
    }

    return task.outputs.map((output) =>
        resolveWorkflowOutputDestination({
            workflow,
            taskId,
            outputId: output.id,
            modelPath: workflow.input?.modelPath,
            projectFiles,
            projectTree,
            explicitDestinations,
        })
    );
}


/**
 * Check whether every destination has a valid path.
 *
 * File-existence conflicts are handled by the write/recovery layer,
 * not by destination resolution.
 */
export function areWorkflowDestinationsResolved(
    destinations = []
) {
    if (
        !Array.isArray(destinations) ||
        destinations.length === 0
    ) {
        return false;
    }

    return destinations.every(
        (destination) =>
            Boolean(destination.path) &&
            !isInitFilePath(destination.path)
    );
}