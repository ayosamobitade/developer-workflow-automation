import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

import {
    filterProjectTree,
    isInitFilePath,
} from "./workflowPathUtils.js";


function getTaskDefinition(taskId, definition) {
    const task = definition.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(
            `Workflow task "${taskId}" was not found.`
        );
    }

    return task;
}


function validateSourceContents(task, sourceContents) {
    if (!sourceContents || typeof sourceContents !== "object") {
        throw new Error(
            "Source contents must be provided as an object."
        );
    }

    for (const source of task.sources) {
        if (source.required === false) continue;

        const content = sourceContents[source.id];

        if (typeof content !== "string" || !content.trim()) {
            throw new Error(
                `Required source "${source.id}" is missing or empty.`
            );
        }
    }
}


function formatProjectTree(projectTree) {
    const filteredTree = filterProjectTree(projectTree);

    if (!filteredTree.trim()) {
        throw new Error(
            "The project file tree is required."
        );
    }

    return [
        "PROJECT FILE TREE",
        "=================",
        filteredTree.trim(),
    ].join("\n");
}


function formatSourceFiles(task, sourceContents, sourcePaths = {}) {
    const sections = [];

    for (const source of task.sources) {
        const content = sourceContents[source.id];

        if (!content?.trim()) {
            if (source.required === false) continue;

            throw new Error(
                `Source "${source.id}" has no content.`
            );
        }

        const sourcePath =
            sourcePaths[source.id] ||
            source.path ||
            source.id;

        if (isInitFilePath(sourcePath)) {
            if (source.required === false) {
                continue;
            }

            throw new Error(
                `Source "${source.id}" cannot include an __init__.py file.`
            );
        }

        sections.push([
            `SOURCE FILE: ${sourcePath}`,
            `Source ID: ${source.id}`,
            "",
            "```",
            content.trim(),
            "```",
        ].join("\n"));
    }

    return sections.join("\n\n");
}


function formatExpectedOutputs(task, destinationHints = {}) {
    return task.outputs.map((output, index) => {
        const destination =
            destinationHints[output.id] ||
            output.destination?.path ||
            "Destination to be determined from the project tree.";

        if (isInitFilePath(destination)) {
            throw new Error(
                `Output "${output.id}" cannot target an __init__.py file.`
            );
        }

        return [
            `OUTPUT ${index + 1}: ${output.name}`,
            `Output ID: ${output.id}`,
            `Expected file type: ${output.type}`,
            `Suggested destination: ${destination}`,
            `Required: ${output.required !== false ? "Yes" : "No"}`,
        ].join("\n");
    }).join("\n\n");
}


function formatOutputInstructions(task) {
    const instructions = task.outputs.map((output, index) => {
        const startMarker =
            `<<<PROMPTFLOW_OUTPUT_START:${output.id}>>>`;

        const endMarker =
            `<<<PROMPTFLOW_OUTPUT_END:${output.id}>>>`;

        return [
            `${index + 1}. ${output.name}`,
            "",
            `Begin this file with exactly: ${startMarker}`,
            `End this file with exactly: ${endMarker}`,
            "",
            "Put only the complete file content between these markers.",
        ].join("\n");
    });

    return [
        "OUTPUT FORMATTING REQUIREMENTS",
        "==============================",
        "",
        "You must produce every required output as a separate, clearly marked file.",
        "Do not combine multiple files into one code block.",
        "Do not omit any required output.",
        "Do not place explanations inside the file content.",
        "Do not change the output marker identifiers.",
        "",
        ...instructions,
    ].join("\n");
}


export function generateWorkflowPrompt({
    workflow,
    taskId,
    sourceContents = {},
    sourcePaths = {},
    destinationHints = {},
    additionalInstructions = "",
    definition = DJANGO_MODEL_WORKFLOW,
}) {
    if (!workflow) {
        throw new Error(
            "A workflow instance is required."
        );
    }

    if (workflow.definitionId !== definition.id) {
        throw new Error(
            "The workflow definition does not match the supplied workflow instance."
        );
    }

    if (isInitFilePath(workflow.input?.modelPath)) {
        throw new Error(
            "The workflow model path cannot be an __init__.py file."
        );
    }

    const task = getTaskDefinition(
        taskId,
        definition
    );

    const taskInstance = workflow.tasks.find(
        (item) => item.id === taskId
    );

    if (!taskInstance) {
        throw new Error(
            `Task "${taskId}" does not exist in this workflow instance.`
        );
    }

    validateSourceContents(
        task,
        sourceContents
    );

    const sections = [
        [
            "PROMPTFLOW WORKFLOW TASK",
            "========================",
            `Workflow: ${workflow.name}`,
            `Task: ${task.name}`,
            `Task ID: ${task.id}`,
            `Project: ${workflow.project.name || "Selected project"}`,
            `Model file: ${workflow.input.modelPath}`,
        ].join("\n"),

        formatProjectTree(
            workflow.input.projectTree
        ),

        [
            "TASK INSTRUCTIONS",
            "=================",
            task.instruction,
        ].join("\n"),

        [
            "SOURCE FILES",
            "============",
            formatSourceFiles(
                task,
                sourceContents,
                sourcePaths
            ),
        ].join("\n"),

        [
            "EXPECTED OUTPUTS",
            "================",
            formatExpectedOutputs(
                task,
                destinationHints
            ),
        ].join("\n"),

        formatOutputInstructions(task),
    ];

    if (additionalInstructions?.trim()) {
        sections.push([
            "ADDITIONAL INSTRUCTIONS",
            "=======================",
            additionalInstructions.trim(),
        ].join("\n"));
    }

    sections.push([
        "IMPORTANT REQUIREMENTS",
        "======================",
        "1. Follow the supplied project architecture and naming conventions.",
        "2. Do not invent models, files, or project structures that were not requested.",
        "3. Preserve compatibility with the supplied source files.",
        "4. Generate complete, production-quality Python files.",
        "5. Produce all required outputs.",
        "6. Keep every output between its exact PromptFlow markers.",
        "7. Do not put Markdown code fences around the output markers.",
        "8. Do not include commentary between output markers.",
        "9. Never generate, modify, or include Python __init__.py files.",
        "10. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",
    ].join("\n"));

    return sections.join("\n\n");
}