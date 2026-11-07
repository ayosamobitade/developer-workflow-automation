import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

import {
    filterModelProjectTree,
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
    const filteredTree = filterModelProjectTree(projectTree);

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


// function formatOutputInstructions(task) {
//     const instructions = task.outputs.map((output, index) => {
//         const startMarker =
//             `<<<PROMPTFLOW_OUTPUT_START:${output.id}>>>`;

//         const endMarker =
//             `<<<PROMPTFLOW_OUTPUT_END:${output.id}>>>`;

//         return [
//             `${index + 1}. ${output.name}`,
//             "",
//             `Begin this file with exactly: ${startMarker}`,
//             `End this file with exactly: ${endMarker}`,
//             "",
//             "Put only the complete file content between these markers.",
//         ].join("\n");
//     });

//     return [
//         "OUTPUT FORMATTING REQUIREMENTS",
//         "==============================",
//         "",
//         "You must produce every required output as a separate, clearly marked file.",
//         "Do not combine multiple files into one code block.",
//         "Do not omit any required output.",
//         "Do not place explanations inside the file content.",
//         "Do not change the output marker identifiers.",
//         "",
//         ...instructions,
//     ].join("\n");
// }

function formatOutputInstructions(task) {
    const instructions = task.outputs.map((output, index) => {
        const startMarker =
            `<<<PROMPTFLOW_OUTPUT_START:${output.id}>>>`;

        const endMarker =
            `<<<PROMPTFLOW_OUTPUT_END:${output.id}>>>`;

        const language =
            output.type === "python" ? "python" : "";

        return [
            `OUTPUT ${index + 1}: ${output.name}`,
            "",
            `Start marker: ${startMarker}`,
            `End marker: ${endMarker}`,
            "",
            "Required structure:",
            startMarker,
            `\`\`\`${language}`,
            "[THE ENTIRE FILE CONTENT MUST BE HERE]",
            "```",
            endMarker,
            "",
            "The markers must be outside the code fence.",
            "The opening and closing code fences must be inside the markers.",
            "Replace the placeholder with the complete file content.",
        ].join("\n");
    });

    return [
        "STRICT OUTPUT FORMATTING REQUIREMENTS",
        "======================================",
        "",
        "Every required output MUST be returned as a complete file.",
        "",
        "MANDATORY RULES:",
        "1. Put the ENTIRE file inside exactly ONE Markdown fenced code block.",
        "2. The code block must contain everything, from the first line to the last line of the file.",
        "3. Do not put any source code before the opening code fence.",
        "4. Do not put any source code after the closing code fence.",
        "5. Never split a file across multiple code blocks.",
        "6. Never put class declarations, function declarations, imports, docstrings, comments, decorators, or variable assignments in ordinary Markdown paragraphs.",
        "7. Preserve the correct indentation throughout the entire file.",
        "8. For Python, use four spaces for each indentation level. Never use tabs.",
        "9. Do not include explanations, headings, labels, or commentary inside the code block.",
        "10. Do not include the word Code or any interface label in the source file.",
        "11. Do not use placeholders, omissions, or abbreviated implementations.",
        "12. Generate all required files independently.",
        "13. Do not put Markdown code fences around the output markers.",
        "14. Do not change, omit, or modify any output marker.",
        "",
        "IMPORTANT: The output markers are plain text delimiters. The code fence belongs INSIDE each pair of markers, not outside them.",
        "",
        "OUTPUT STRUCTURES:",
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

        ...(task.sources.some(
            (source) => source.type === "project_tree"
        )
            ? [
                formatProjectTree(
                    workflow.input.projectTree
                ),
            ]
            : []),

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

    // sections.push([
    //     "IMPORTANT REQUIREMENTS",
    //     "======================",
    //     "1. Follow the supplied project architecture and naming conventions.",
    //     "2. Do not invent models, files, or project structures that were not requested.",
    //     "3. Preserve compatibility with the supplied source files.",
    //     "4. Generate complete, production-quality Python files.",
    //     "5. Produce all required outputs.",
    //     "6. Keep every output between its exact PromptFlow markers.",
    //     "7. Do not put Markdown code fences around the output markers.",
    //     "8. Do not include commentary between output markers.",
    //     "9. Never generate, modify, or include Python __init__.py files.",
    //     "10. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",
    // ].join("\n"));

    sections.push([
        "IMPORTANT REQUIREMENTS",
        "======================",
        "1. Follow the supplied project architecture and naming conventions.",
        "2. Do not invent models, files, or project structures that were not requested.",
        "3. Preserve compatibility with the supplied source files.",
        "4. Generate complete, production-quality Python files.",
        "5. Produce every required output.",
        "6. Put the entire content of each output inside exactly one Python code block.",
        "7. Nothing belonging to a generated file may appear outside its code block.",
        "8. Keep the output markers outside the code fences.",
        "9. Keep the opening and closing code fences inside the corresponding output markers.",
        "10. Preserve all Python indentation using four spaces per indentation level.",
        "11. Do not include explanations, commentary, or Markdown headings between output markers.",
        "12. Never generate, modify, or include Python __init__.py files.",
        "13. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",
    ].join("\n"));

    return sections.join("\n\n");
}