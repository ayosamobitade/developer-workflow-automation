import {
    isInitFilePath,
} from "./workflowPathUtils.js";


const OUTPUT_MARKER_PATTERN =
    /<<<PROMPTFLOW_OUTPUT_(?:START|END):[^>]+>>>/;


function getTaskDefinition(taskId, definition) {
    if (!definition || !Array.isArray(definition.tasks)) {
        throw new Error("A valid workflow definition is required.");
    }

    const task = definition.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(`Unknown workflow task: ${taskId}`);
    }

    return task;
}


function normalizePath(path) {
    return String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");
}


function validateOutputContent(output, outputDefinition) {
    const errors = [];
    const content = output?.content;

    if (typeof content !== "string") {
        errors.push("Output content must be a string.");

        return errors;
    }

    if (
        outputDefinition.validation?.nonEmpty !== false &&
        !content.trim()
    ) {
        errors.push("Output content is empty.");
    }

    const expectedExtension =
        outputDefinition.validation?.extension;

    if (expectedExtension) {
        const normalizedExtension = expectedExtension.startsWith(".")
            ? expectedExtension
            : `.${expectedExtension}`;

        if (
            !output.destination ||
            typeof output.destination !== "string" ||
            !output.destination.toLowerCase().endsWith(
                normalizedExtension.toLowerCase()
            )
        ) {
            errors.push(
                `Output destination must have the "${normalizedExtension}" extension.`
            );
        }
    }

    if (OUTPUT_MARKER_PATTERN.test(content)) {
        errors.push(
            "Output contains unresolved PromptFlow output markers."
        );
    }

    if (/^\s*```[\w.+-]*\s*$/m.test(content)) {
        errors.push(
            "Output contains Markdown code fences. Extract the file content before validation."
        );
    }

    if (content.includes("\u0000")) {
        errors.push(
            "Output contains a null byte and may not be valid text."
        );
    }

    return errors;
}


/**
 * Validate one extracted workflow output.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {Object} options.output
 * @param {Object} options.definition
 *
 * @returns {{valid: boolean, errors: string[], outputId: string}}
 */
export function validateWorkflowOutputContent({
    taskId,
    output,
    definition,
} = {}) {
    if (!output?.outputId) {
        throw new Error("An output ID is required.");
    }

    const task = getTaskDefinition(taskId, definition);

    const outputDefinition = task.outputs.find(
        (item) => item.id === output.outputId
    );

    if (!outputDefinition) {
        throw new Error(
            `Output "${output.outputId}" is not defined for task "${taskId}".`
        );
    }

    const errors = validateOutputContent(
        output,
        outputDefinition
    );

    return {
        valid: errors.length === 0,
        outputId: output.outputId,
        errors,
    };
}


/**
 * Validate every extracted output for a workflow task.
 *
 * @param {Object} options
 * @param {string} options.taskId
 * @param {Array<Object>} options.outputs
 * @param {Object} options.definition
 *
 * @returns {{valid: boolean, results: Array, errors: Array}}
 */
export function validateWorkflowOutputs({
    taskId,
    outputs,
    definition,
} = {}) {
    if (!Array.isArray(outputs)) {
        throw new TypeError("Workflow outputs must be an array.");
    }

    const task = getTaskDefinition(taskId, definition);
    const results = [];
    const errors = [];

    const outputMap = new Map();

    for (const output of outputs) {
        if (!output?.outputId) {
            errors.push(
                "An extracted output is missing its output ID."
            );

            continue;
        }

        if (outputMap.has(output.outputId)) {
            errors.push(
                `Duplicate extracted output "${output.outputId}".`
            );

            continue;
        }

        outputMap.set(output.outputId, output);
    }

    for (const outputDefinition of task.outputs) {
        const output = outputMap.get(outputDefinition.id);

        if (!output) {
            if (outputDefinition.required !== false) {
                errors.push(
                    `Required output "${outputDefinition.id}" is missing.`
                );
            }

            continue;
        }

        const result = validateWorkflowOutputContent({
            taskId,
            output,
            definition,
        });

        results.push(result);

        for (const error of result.errors) {
            errors.push(
                `${outputDefinition.id}: ${error}`
            );
        }
    }

    // Reject outputs not declared in the task definition.
    for (const outputId of outputMap.keys()) {
        const isExpected = task.outputs.some(
            (item) => item.id === outputId
        );

        if (!isExpected) {
            errors.push(
                `Unexpected output "${outputId}".`
            );
        }
    }

    return {
        valid: errors.length === 0,
        taskId,
        results,
        errors,
    };
}


/**
 * Validate destination assignments for a group of outputs.
 *
 * This checks:
 * - Missing destination paths.
 * - Duplicate destination paths.
 * - Prohibited __init__.py destinations.
 *
 * It does not perform filesystem existence checks.
 *
 * @param {Array<Object>} destinations
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWorkflowDestinations(destinations = []) {
    if (!Array.isArray(destinations)) {
        throw new TypeError("Destinations must be an array.");
    }

    const errors = [];
    const assignedPaths = new Map();

    for (const destination of destinations) {
        if (!destination?.outputId) {
            errors.push(
                "A destination is missing its output ID."
            );

            continue;
        }

        const path = normalizePath(destination.path);

        if (!path) {
            errors.push(
                `Output "${destination.outputId}" has no destination path.`
            );

            continue;
        }

        // PromptFlow must never generate or update __init__.py files.
        if (isInitFilePath(path)) {
            errors.push(
                `Destination "${path}" is not allowed. PromptFlow does not generate __init__.py files.`
            );

            continue;
        }

        const previousOutput = assignedPaths.get(path);

        if (previousOutput) {
            errors.push(
                `Outputs "${previousOutput}" and "${destination.outputId}" share the same destination "${path}".`
            );
        } else {
            assignedPaths.set(
                path,
                destination.outputId
            );
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}