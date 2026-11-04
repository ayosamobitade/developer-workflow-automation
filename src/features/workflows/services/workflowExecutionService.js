import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

import {
    WORKFLOW_TASK_STATUS,
    WORKFLOW_OUTPUT_STATUS,
    createWorkflowInstance,
    getNextReadyTask,
    getWorkflowOutput,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    assignWorkflowOutputDestination,
    markWorkflowOutputWritten,
    completeWorkflowTask,
    failWorkflowTask,
    getWorkflowProgress,
} from "./workflowService.js";

import {
    generateWorkflowPrompt,
} from "./workflowPromptService.js";

import {
    prepareSourceContent,
} from "./sourcePreparationService.js";

import {
    extractWorkflowOutputs,
} from "./workflowOutputService.js";

import {
    resolveWorkflowDestinations,
} from "./workflowDestinationService.js";

import {
    validateWorkflowOutputs,
    validateWorkflowDestinations,
} from "./workflowValidationService.js";

import {
    saveWorkflowState,
} from "../storage/workflowStorage.js";

import {
    isInitFilePath,
    filterProjectTree,
} from "./workflowPathUtils.js";


function assertFunction(value, name) {
    if (typeof value !== "function") {
        throw new TypeError(`${name} must be a function.`);
    }
}


function getTaskDefinition(definition, taskId) {
    const task = definition.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(`Unknown workflow task: ${taskId}`);
    }

    return task;
}


function getTaskInstance(workflow, taskId) {
    const task = workflow.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(`Unknown workflow task instance: ${taskId}`);
    }

    return task;
}


function getSourceMode(source, overrides = {}) {
    const configuredMode = overrides[source.id];

    if (configuredMode) {
        const supportedModes =
            source.preparation?.supportedModes || [];

        if (
            supportedModes.length &&
            !supportedModes.includes(configuredMode)
        ) {
            throw new Error(
                `Preparation mode "${configuredMode}" is not supported for source "${source.id}".`
            );
        }

        return configuredMode;
    }

    if (source.preparation?.mode === "configurable") {
        return source.preparation.defaultMode || "full";
    }

    return source.preparation?.mode || "full";
}


async function loadTaskSources({
    workflow,
    task,
    readFile,
    sourceModes,
}) {
    const sourceContents = {};
    const sourcePaths = {};

    for (const source of task.sources || []) {
        let content;
        let path = "";

        if (source.type === "project_tree") {
            content = filterProjectTree(
                workflow.input?.projectTree
            );

            path = "Project file tree";

        } else if (source.type === "workflow_output") {
            const output = getWorkflowOutput(
                workflow,
                source.task,
                source.output
            );

            content = output.content;
            path = output.destination?.path || "";

            if (isInitFilePath(path)) {
                throw new Error(
                    `Workflow source "${source.id}" cannot use an __init__.py file.`
                );
            }

        } else if (source.type === "project_file") {
            if (!source.path) {
                throw new Error(
                    `Project file source "${source.id}" has no path.`
                );
            }

            if (isInitFilePath(source.path)) {
                throw new Error(
                    `Workflow source "${source.id}" cannot use an __init__.py file.`
                );
            }

            const response = await readFile(source.path);

            if (
                !response ||
                typeof response.content !== "string"
            ) {
                throw new Error(
                    `Could not read project file "${source.path}".`
                );
            }

            content = response.content;
            path = source.path;

        } else {
            throw new Error(
                `Unsupported source type "${source.type}" for "${source.id}".`
            );
        }

        if (
            source.required !== false &&
            (typeof content !== "string" || !content.trim())
        ) {
            throw new Error(
                `Required source "${source.id}" is missing or empty.`
            );
        }

        if (typeof content !== "string") {
            continue;
        }

        const prepared = prepareSourceContent({
            content,
            path,
            mode: getSourceMode(source, sourceModes),
        });

        sourceContents[source.id] = prepared.content;
        sourcePaths[source.id] = path;
    }

    return {
        sourceContents,
        sourcePaths,
    };
}


function getConfirmedDestinationPath(
    destination,
    confirmation
) {
    if (destination.confirmed) {
        return destination.path;
    }

    const key = `${destination.taskId}.${destination.outputId}`;

    const confirmed =
        confirmation?.[key] ??
        confirmation?.[destination.outputId];

    if (typeof confirmed === "string") {
        return confirmed;
    }

    if (
        confirmed &&
        typeof confirmed.path === "string" &&
        confirmed.confirmed === true
    ) {
        return confirmed.path;
    }

    return null;
}


function normalizeProjectPath(path) {
    const normalized = String(path || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");

    if (
        !normalized ||
        normalized.split("/").some(
            (segment) =>
                segment === "." ||
                segment === ".."
        )
    ) {
        throw new Error(
            "An invalid project-relative path was supplied."
        );
    }

    return normalized;
}


function normalizeFileList(files) {
    if (!Array.isArray(files)) {
        throw new Error(
            "The native project file list is invalid."
        );
    }

    return new Set(
        files.map((file) =>
            normalizeProjectPath(
                typeof file === "string"
                    ? file
                    : file?.path
            )
        )
    );
}


function updateWorkflowOutputDestination(
    workflow,
    taskId,
    outputId,
    path,
    confirmed
) {
    return assignWorkflowOutputDestination(
        workflow,
        {
            taskId,
            outputId,
            path,
            confirmed,
        }
    );
}


function assertNotStopped(shouldStop) {
    if (shouldStop()) {
        throw new Error("Workflow execution was stopped.");
    }
}


/**
 * Returns persisted outputs only when every expected output
 * already has content and a confirmed destination.
 *
 * This allows a retried task to continue without generating
 * the same response again.
 */
function getRecoverableOutputs({
    workflow,
    taskId,
    taskDefinition,
}) {
    const task = getTaskInstance(workflow, taskId);

    const expectedOutputs = taskDefinition.outputs || [];

    if (!expectedOutputs.length) {
        return null;
    }

    const outputs = [];

    for (const definitionOutput of expectedOutputs) {
        const output = task.outputs.find(
            (item) => item.id === definitionOutput.id
        );

        if (
            !output ||
            typeof output.content !== "string" ||
            !output.content.trim() ||
            !output.destination?.path ||
            output.destination.confirmed !== true
        ) {
            return null;
        }

        outputs.push({
            outputId: output.id,
            content: output.content,
            destination: normalizeProjectPath(
                output.destination.path
            ),
            status: output.status,
        });
    }

    return outputs;
}


/**
 * Prevents regeneration when an output has already been written
 * but the rest of its persisted state is incomplete.
 */




function assertNoIncompleteWrittenOutputs({
    workflow,
    taskId,
    recoverableOutputs,
}) {
    const task = getTaskInstance(workflow, taskId);

    const writtenOutput = task.outputs.find(
        (output) =>
            output.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
    );

    if (!writtenOutput) {
        return;
    }

    if (!recoverableOutputs) {
        throw new Error(
            `Output "${writtenOutput.id}" is marked as written, but the task's saved outputs are incomplete. Manual recovery is required.`
        );
    }

    const recoveredOutput = recoverableOutputs.find(
        (output) => output.outputId === writtenOutput.id
    );

    if (!recoveredOutput) {
        throw new Error(
            `Output "${writtenOutput.id}" is marked as written, but its saved output is missing. Manual recovery is required.`
        );
    }
}


function validateExecutionOptions({
    definition,
    workflow,
    tabId,
}) {
    if (tabId === undefined || tabId === null) {
        throw new Error(
            "A browser tab ID is required."
        );
    }

    if (!Number.isInteger(Number(tabId)) || Number(tabId) < 0) {
        throw new Error("A valid browser tab ID is required.");
    }

    if (!workflow || typeof workflow !== "object") {
        throw new Error("A workflow instance is required.");
    }

    if (workflow.definitionId !== definition.id) {
        throw new Error(
            "The workflow definition does not match the workflow instance."
        );
    }

    if (!Array.isArray(workflow.tasks)) {
        throw new Error(
            "The workflow instance does not contain a valid tasks array."
        );
    }

    if (
        workflow.status === "failed" ||
        workflow.status === "completed"
    ) {
        throw new Error(
            `Cannot execute a workflow with status "${workflow.status}".`
        );
    }
}


export function createWorkflowExecutionController({
    definition = DJANGO_MODEL_WORKFLOW,
    readFile,
    writeFile,
    listFiles,
    sendPrompt,
    confirmDestinations,
    onStateChange = () => {},
    onEvent = () => {},
    shouldStop = () => false,
}) {
    assertFunction(readFile, "readFile");
    assertFunction(writeFile, "writeFile");
    assertFunction(listFiles, "listFiles");
    assertFunction(sendPrompt, "sendPrompt");
    assertFunction(confirmDestinations, "confirmDestinations");

    if (typeof shouldStop !== "function") {
        throw new TypeError("shouldStop must be a function.");
    }

    let running = false;


    async function persist(tabId, workflow) {
        workflow.updatedAt = new Date().toISOString();

        await saveWorkflowState(tabId, workflow);

        onStateChange(workflow);
    }


    function emit(type, details = {}) {
        onEvent({
            type,
            timestamp: new Date().toISOString(),
            ...details,
        });
    }


    /**
     * Validate persisted outputs before attempting recovery.
     */
    function validatePersistedOutputs({
        taskId,
        outputs,
    }) {
        const validation = validateWorkflowOutputs({
            taskId,
            outputs: outputs.map((output) => ({
                outputId: output.outputId,
                content: output.content,
                destination: output.destination,
            })),
            definition,
        });

        if (!validation.valid) {
            throw new Error(
                `Saved output validation failed:\n${validation.errors.join("\n")}`
            );
        }

        const destinationValidation =
            validateWorkflowDestinations(
                outputs.map((output) => ({
                    outputId: output.outputId,
                    path: output.destination,
                    exists: false,
                }))
            );

        if (!destinationValidation.valid) {
            throw new Error(
                `Saved destination validation failed:\n${destinationValidation.errors.join("\n")}`
            );
        }
    }


    /**
     * Recover or write one output.
     *
     * Existing files are never overwritten. An existing file
     * is accepted only when its content exactly matches the
     * saved workflow output.
     */
    async function writeOrRecoverOutput({
        tabId,
        workflow,
        taskId,
        output,
    }) {
        assertNotStopped(shouldStop);

        const destination = output.destination;

        const currentFiles = normalizeFileList(
            await listFiles()
        );

        assertNotStopped(shouldStop);

        const taskOutput = getWorkflowOutput(
            workflow,
            taskId,
            output.outputId
        );


        if (currentFiles.has(destination)) {
            const existingFile = await readFile(destination);

            if (
                !existingFile ||
                typeof existingFile.content !== "string"
            ) {
                throw new Error(
                    `Could not verify existing file "${destination}".`
                );
            }

            // Recover an output that was already written successfully.
            if (existingFile.content === output.content) {
                if (
                    taskOutput.status !== WORKFLOW_OUTPUT_STATUS.WRITTEN
                ) {
                    workflow = markWorkflowOutputWritten(
                        workflow,
                        {
                            taskId,
                            outputId: output.outputId,
                        }
                    );

                    await persist(tabId, workflow);
                }

                emit("output_recovered", {
                    taskId,
                    outputId: output.outputId,
                    path: destination,
                });

                return workflow;
            }

            // An empty placeholder may receive generated content,
            // but a previously written output must never be overwritten.
            if (
                existingFile.content.trim() !== "" ||
                taskOutput.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
            ) {
                throw new Error(
                    `Recovery conflict: "${destination}" already contains different content. The file was not overwritten.`
                );
            }

            // Empty or whitespace-only file:
            // continue below to the normal write operation.
        }


        emit("writing_output", {
            taskId,
            outputId: output.outputId,
            path: destination,
        });

        const writeResponse = await writeFile(
            destination,
            output.content
        );

        if (
            writeResponse &&
            typeof writeResponse === "object" &&
            writeResponse.ok === false
        ) {
            throw new Error(
                writeResponse.error ||
                `Native host failed to write "${destination}".`
            );
        }

        assertNotStopped(shouldStop);

        // Verify the native host can read the written file.
        const writtenFile = await readFile(destination);

        if (
            !writtenFile ||
            typeof writtenFile.content !== "string" ||
            writtenFile.content !== output.content
        ) {
            throw new Error(
                `Write verification failed for "${destination}".`
            );
        }

        workflow = markWorkflowOutputWritten(
            workflow,
            {
                taskId,
                outputId: output.outputId,
            }
        );

        await persist(tabId, workflow);

        emit("output_written", {
            taskId,
            outputId: output.outputId,
            path: destination,
        });

        return workflow;
    }


    async function executeTask({
        tabId,
        workflow: initialWorkflow,
        taskId,
        sourceModes = {},
        additionalInstructions = "",
    }) {
        const taskDefinition = getTaskDefinition(
            definition,
            taskId
        );

        let workflow = startWorkflowTask(
            initialWorkflow,
            taskId,
            definition
        );

        await persist(tabId, workflow);

        emit("task_started", {
            taskId,
            taskName: taskDefinition.name,
        });

        try {
            assertNotStopped(shouldStop);

            /*
             * RECOVERY CHECK
             *
             * If every expected output has already been saved
             * with a confirmed destination, skip ChatGPT entirely.
             */
            let outputs = getRecoverableOutputs({
                workflow,
                taskId,
                taskDefinition,
            });

            const recovering = Boolean(outputs);

            if (recovering) {
                const writtenOutputs = taskDefinition.outputs
                    .map((definitionOutput) =>
                        getWorkflowOutput(
                            workflow,
                            taskId,
                            definitionOutput.id
                        )
                    )
                    .filter(
                        (output) =>
                            output.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
                    );

                const currentFiles = normalizeFileList(
                    await listFiles()
                );

                for (const output of writtenOutputs) {
                    const destination = normalizeProjectPath(
                        output.destination.path
                    );

                    if (!currentFiles.has(destination)) {
                        throw new Error(
                            `Output "${output.id}" is marked as written, but its destination "${destination}" is missing from the project. Manual recovery is required.`
                        );
                    }
                }
            }

            assertNoIncompleteWrittenOutputs({
                workflow,
                taskId,
                recoverableOutputs: outputs,
            });

            if (recovering) {
                emit("task_recovery_started", {
                    taskId,
                    outputCount: outputs.length,
                });

                validatePersistedOutputs({
                    taskId,
                    outputs,
                });

            } else {
                /*
                 * NORMAL EXECUTION
                 */

                // 1. Read and prepare the task's source files.
                const {
                    sourceContents,
                    sourcePaths,
                } = await loadTaskSources({
                    workflow,
                    task: taskDefinition,
                    readFile,
                    sourceModes,
                });

                assertNotStopped(shouldStop);

                // 2. Generate the ChatGPT prompt.
                const prompt = generateWorkflowPrompt({
                    workflow,
                    taskId,
                    sourceContents,
                    sourcePaths,
                    additionalInstructions,
                    definition,
                });

                emit("prompt_ready", {
                    taskId,
                    promptLength: prompt.length,
                });

                // 3. Send the prompt and wait for completion.
                const response = await sendPrompt(prompt);

                assertNotStopped(shouldStop);

                const responseText =
                    typeof response === "string"
                        ? response
                        : response?.response?.text;

                if (
                    typeof responseText !== "string" ||
                    !responseText.trim()
                ) {
                    throw new Error(
                        "ChatGPT returned an empty or invalid response."
                    );
                }

                // 4. Extract every expected output.
                const extracted = extractWorkflowOutputs({
                    response: responseText,
                    taskId,
                    definition,
                });

                if (
                    !Array.isArray(extracted.outputs) ||
                    extracted.outputs.length === 0
                ) {
                    throw new Error(
                        "No workflow outputs were extracted."
                    );
                }

                // 5. Resolve output destinations.
                const projectFiles = await listFiles();

                assertNotStopped(shouldStop);

                const destinations = resolveWorkflowDestinations({
                    workflow,
                    taskId,
                    definition,
                    projectFiles,
                    projectTree: workflow.input?.projectTree || "",
                    explicitDestinations:
                        workflow.explicitDestinations || {},
                });

                if (
                    destinations.length !== extracted.outputs.length
                ) {
                    throw new Error(
                        "The number of resolved destinations does not match the number of extracted outputs."
                    );
                }

                // 6. Require confirmation for inferred destinations.
                const needsConfirmation = destinations.some(
                    (item) => !item.confirmed
                );

                let confirmation = {};

                if (needsConfirmation) {
                    emit("destination_confirmation_required", {
                        taskId,
                        destinations,
                    });

                    confirmation = await confirmDestinations({
                        workflow,
                        taskId,
                        destinations,
                    });

                    assertNotStopped(shouldStop);

                    if (!confirmation) {
                        throw new Error(
                            "Destination confirmation was declined."
                        );
                    }
                }

                // 7. Verify all destination paths.
                const resolvedDestinations = destinations.map(
                    (destination) => {
                        const path = getConfirmedDestinationPath(
                            destination,
                            confirmation
                        );

                        if (!path) {
                            throw new Error(
                                `Destination for "${destination.outputId}" was not explicitly confirmed.`
                            );
                        }

                        const normalizedPath = normalizeProjectPath(path);

                        if (isInitFilePath(normalizedPath)) {
                            throw new Error(
                                `Destination "${normalizedPath}" is not allowed. PromptFlow does not generate __init__.py files.`
                            );
                        }

                        return {
                            ...destination,
                            path: normalizedPath,
                            confirmed: true,
                        };
                    }
                );

                // 8. Validate generated output content against final paths.
                const outputsForValidation = extracted.outputs.map(
                    (output) => {
                        const destination = resolvedDestinations.find(
                            (item) =>
                                item.outputId === output.outputId
                        );

                        if (!destination) {
                            throw new Error(
                                `No destination was resolved for output "${output.outputId}".`
                            );
                        }

                        return {
                            ...output,
                            destination: destination.path,
                        };
                    }
                );

                const validation = validateWorkflowOutputs({
                    taskId,
                    outputs: outputsForValidation,
                    definition,
                });

                if (!validation.valid) {
                    throw new Error(
                        `Output validation failed:\n${validation.errors.join("\n")}`
                    );
                }

                // 9. Validate destination uniqueness and availability.
                const destinationValidation =
                    validateWorkflowDestinations(
                        resolvedDestinations
                    );

                if (!destinationValidation.valid) {
                    throw new Error(
                        `Destination validation failed:\n${destinationValidation.errors.join("\n")}`
                    );
                }

                // Ensure every extracted output has exactly one destination.
                const outputIds = extracted.outputs.map(
                    (output) => output.outputId
                );

                const destinationIds = resolvedDestinations.map(
                    (destination) => destination.outputId
                );

                if (
                    new Set(outputIds).size !== outputIds.length ||
                    new Set(destinationIds).size !== destinationIds.length ||
                    outputIds.some(
                        (id) => !destinationIds.includes(id)
                    )
                ) {
                    throw new Error(
                        "Output-to-destination mapping is invalid or ambiguous."
                    );
                }

                // 10. Store and validate outputs in workflow state.
                for (const output of extracted.outputs) {
                    workflow = storeWorkflowOutput(
                        workflow,
                        {
                            taskId,
                            outputId: output.outputId,
                            content: output.content,
                        }
                    );

                    workflow = validateWorkflowOutput(
                        workflow,
                        {
                            taskId,
                            outputId: output.outputId,
                        }
                    );

                    const destination = resolvedDestinations.find(
                        (item) =>
                            item.outputId === output.outputId
                    );

                    workflow = updateWorkflowOutputDestination(
                        workflow,
                        taskId,
                        output.outputId,
                        destination.path,
                        true
                    );

                    await persist(tabId, workflow);
                }

                outputs = extracted.outputs.map((output) => {
                    const destination = resolvedDestinations.find(
                        (item) =>
                            item.outputId === output.outputId
                    );

                    return {
                        outputId: output.outputId,
                        content: output.content,
                        destination: destination.path,
                    };
                });
            }

            assertNotStopped(shouldStop);

            /*
             * WRITE / RECOVERY
             *
             * Each output is checked against the current filesystem.
             * Matching existing files are accepted as completed writes.
             * Differing existing files are never overwritten.
             */
            for (const output of outputs) {
                workflow = await writeOrRecoverOutput({
                    tabId,
                    workflow,
                    taskId,
                    output,
                });
            }

            assertNotStopped(shouldStop);

            // Complete only after every required output is written.
            workflow = completeWorkflowTask(
                workflow,
                taskId
            );

            await persist(tabId, workflow);

            emit("task_completed", {
                taskId,
                progress: getWorkflowProgress(workflow),
            });

            return workflow;

        } catch (error) {
            if (
                workflow.tasks.find(
                    (item) => item.id === taskId
                )?.status === WORKFLOW_TASK_STATUS.RUNNING
            ) {
                workflow = failWorkflowTask(
                    workflow,
                    taskId,
                    error
                );

                await persist(tabId, workflow);
            }

            error.workflow = workflow;

            emit("task_failed", {
                taskId,
                error: error.message,
            });

            throw error;
        }
    }


    async function run({
        tabId,
        workflow: initialWorkflow,
        sourceModes = {},
        additionalInstructions = {},
    }) {
        if (running) {
            throw new Error(
                "A workflow execution is already running in this controller."
            );
        }

        validateExecutionOptions({
            definition,
            workflow: initialWorkflow,
            tabId,
        });

        running = true;

        let workflow = initialWorkflow;

        try {
            emit("workflow_started", {
                workflowId: workflow.id,
                workflowName: workflow.name,
            });

            await persist(tabId, workflow);

            while (true) {
                assertNotStopped(shouldStop);

                if (workflow.status === "completed") {
                    break;
                }

                const nextTask = getNextReadyTask(workflow);

                if (!nextTask) {
                    const failedTask = workflow.tasks.find(
                        (task) =>
                            task.status === WORKFLOW_TASK_STATUS.FAILED
                    );

                    if (failedTask) {
                        throw new Error(
                            `Workflow stopped because task "${failedTask.id}" failed.`
                        );
                    }

                    const incompleteTask = workflow.tasks.find(
                        (task) =>
                            task.status !== WORKFLOW_TASK_STATUS.COMPLETED
                    );

                    if (incompleteTask) {
                        throw new Error(
                            `Workflow cannot continue. Task "${incompleteTask.id}" is not ready.`
                        );
                    }

                    break;
                }

                workflow = await executeTask({
                    tabId,
                    workflow,
                    taskId: nextTask.id,
                    sourceModes,
                    additionalInstructions:
                        additionalInstructions[nextTask.id] || "",
                });
            }

            emit("workflow_completed", {
                workflowId: workflow.id,
                progress: getWorkflowProgress(workflow),
            });

            return {
                success: true,
                workflow,
                progress: getWorkflowProgress(workflow),
            };

        } catch (error) {
            if (error.workflow) {
                workflow = error.workflow;
            }

            emit("workflow_failed", {
                workflowId: workflow.id,
                error: error.message,
            });

            return {
                success: false,
                workflow,
                progress: getWorkflowProgress(workflow),
                error: error.message,
            };

        } finally {
            running = false;
        }
    }


    return {
        run,

        isRunning() {
            return running;
        },
    };
}


export {
    createWorkflowInstance,
};