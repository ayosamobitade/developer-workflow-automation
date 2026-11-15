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
    buildImplementationAssessmentPrompt,
    parseImplementationAssessment,
} from "./automaticWorkflowPlanner.js";

import {
    extractWorkflowOutputs,
} from "./workflowOutputService.js";

import {
    resolveWorkflowDestinations,
    resolveWorkflowOutputDestination,
} from "./workflowDestinationService.js";

import {
    extractDependencyRequest,
    normalizeDependencyPath,
    buildDependencyContextPrompt,
} from "./dependencyResolutionService.js";

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


export const MAX_PROMPT_TOKENS = 24000;
const CHARS_PER_ESTIMATED_TOKEN = 3.5;

export function estimatePromptTokens(prompt) {
    return Math.ceil(String(prompt || "").length / CHARS_PER_ESTIMATED_TOKEN);
}


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



function getResponseText(response) {
    return typeof response === "string"
        ? response
        : response?.response?.text;
}


function inferDependencyTask(dependencyPath, definition, workflow) {
    const patterns = [
        {
            taskId: "create_model",
            outputId: "model",
            match: dependencyPath.match(/^(?!.*\/tests\/)(.*?)(?:^|\/)models\/(.+\/)?([^/]+)\.py$/),
        },
        {
            taskId: "create_factory_and_model_test",
            outputId: "model_factory",
            match: dependencyPath.match(/^(.*?)(?:^|\/)tests\/factories\/([^/]+)_factory\.py$/),
        },
        {
            taskId: "create_factory_and_model_test",
            outputId: "model_test",
            match: dependencyPath.match(/^(.*?)(?:^|\/)tests\/models\/test_([^/]+)\.py$/),
        },
        {
            taskId: "create_selector",
            outputId: "selector",
            match: dependencyPath.match(/^(?!.*\/tests\/)(.*?)(?:^|\/)selectors\/(.+\/)?([^/]+)_selector\.py$/),
        },
        {
            taskId: "create_selector_test",
            outputId: "selector_test",
            match: dependencyPath.match(/^(.*?)(?:^|\/)tests\/selectors\/(.+\/)?test_([^/]+)_selector\.py$/),
        },
        {
            taskId: "create_service",
            outputId: "service",
            match: dependencyPath.match(/^(?!.*\/tests\/)(.*?)(?:^|\/)services\/(.+\/)?([^/]+)_service\.py$/),
        },
        {
            taskId: "create_service_test",
            outputId: "service_test",
            match: dependencyPath.match(/^(.*?)(?:^|\/)tests\/services\/(.+\/)?test_([^/]+)_service\.py$/),
        },
    ];

    const match = patterns.find((item) => item.match);
    if (!match) return null;

    const task = definition.tasks.find((item) => item.id === match.taskId);
    const output = task?.outputs.find((item) => item.id === match.outputId);
    if (!task || !output) return null;

    const groups = match.match;
    let appRoot = "";
    let modelGroup = "";
    let modelName = "";

    if (match.taskId === "create_model") {
        appRoot = groups[1].replace(/\/$/, "");
        modelGroup = (groups[2] || "").replace(/\/$/, "");
        modelName = groups[3];
    } else if (
        match.taskId === "create_selector" ||
        match.taskId === "create_selector_test" ||
        match.taskId === "create_service" ||
        match.taskId === "create_service_test"
    ) {
        appRoot = groups[1].replace(/\/$/, "");
        modelGroup = (groups[2] || "").replace(/\/$/, "");
        modelName = groups[3];
    } else {
        appRoot = groups[1].replace(/\/$/, "");
        modelName = groups[2];
        const selectedPath = workflow.input?.modelPath || "";
        const selectedName = selectedPath.split("/").at(-1)?.replace(/\.py$/i, "");
        if (selectedName === modelName) {
            const segments = selectedPath.split("/");
            const modelsIndex = segments.lastIndexOf("models");
            if (modelsIndex >= 0) {
                appRoot = segments.slice(0, modelsIndex).join("/");
                modelGroup = segments.slice(modelsIndex + 1, -1).join("/");
            }
        }
    }

    const modelPath = [
        appRoot,
        "models",
        modelGroup,
        `${modelName}.py`,
    ].filter(Boolean).join("/");

    const selectorPath = [
        appRoot,
        "selectors",
        modelGroup,
        `${modelName}_selector.py`,
    ].filter(Boolean).join("/");

    const servicePath = [
        appRoot,
        "services",
        modelGroup,
        `${modelName}_service.py`,
    ].filter(Boolean).join("/");

    const sourcePaths = {
        model: modelPath,
        selector: selectorPath,
        service: servicePath,
    };

    const dependencyTask = {
        ...task,
        sources: task.sources.map((source) => {
            if (source.type === "project_tree") return source;
            const path = sourcePaths[source.id];
            if (!path) {
                throw new Error(
                    `Cannot infer the source path for dependency "${source.id}" required by "${dependencyPath}".`
                );
            }
            return {
                ...source,
                type: "project_file",
                path,
            };
        }),
    };

    return {
        task: dependencyTask,
        output,
    };
}

function findDependencyOutput({
    workflow,
    definition,
    dependencyPath,
    projectFiles,
}) {
    const matches = [];

    for (const task of definition.tasks) {
        for (const output of task.outputs || []) {
            const destination = resolveWorkflowOutputDestination({
                workflow,
                taskId: task.id,
                outputId: output.id,
                projectFiles,
                projectTree: workflow.input?.projectTree || "",
                explicitDestinations: workflow.explicitDestinations || {},
            });

            if (
                destination.path &&
                normalizeDependencyPath(destination.path) === dependencyPath
            ) {
                matches.push({ task, output });
            }
        }
    }

    if (matches.length > 1) {
        throw new Error(
            `Dependency path "${dependencyPath}" matches more than one workflow output.`
        );
    }

    if (matches.length === 1) return matches[0];

    const inferred = inferDependencyTask(
        dependencyPath,
        definition,
        workflow
    );

    if (inferred) return inferred;

    throw new Error(
        `PromptFlow does not have a normal file-generation instruction for dependency "${dependencyPath}". The file type could not be identified safely.`
    );
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


    async function assessExistingTask({
        tabId,
        workflow,
        taskId,
    }) {
        const plan = workflow.input?.implementationPlan;
        const taskDefinition = getTaskDefinition(definition, taskId);
        const deliverables = plan?.deliverables?.filter(
            (item) => item.taskId === taskId
        ) || [];

        if (
            !plan ||
            deliverables.length !== taskDefinition.outputs.length ||
            deliverables.some((item) => item.status !== "existing")
        ) {
            return { workflow, status: "NEEDS_WORK" };
        }

        const savedAssessment =
            workflow.input?.implementationAssessments?.[taskId];

        if (savedAssessment) {
            return { workflow, status: savedAssessment };
        }

        const prompt = buildImplementationAssessmentPrompt(
            plan,
            definition,
            [taskId],
            workflow
        );

        if (!prompt) {
            return { workflow, status: "NEEDS_WORK" };
        }

        let status = "NEEDS_WORK";
        const estimatedTokens = estimatePromptTokens(prompt);

        if (estimatedTokens <= MAX_PROMPT_TOKENS) {
            emit("implementation_assessment_started", {
                taskId,
                estimatedTokens,
            });

            const response = await sendPrompt(prompt);
            assertNotStopped(shouldStop);

            status = parseImplementationAssessment(
                response,
                plan,
                definition
            )[taskId] || "NEEDS_WORK";
        } else {
            emit("implementation_assessment_skipped", {
                taskId,
                estimatedTokens,
                reason: "assessment_prompt_exceeds_budget",
            });
        }

        // Re-read every candidate before accepting COMPLETE. If a file changed
        // after inspection, refresh the prompt context and run the task normally.
        if (status === "COMPLETE") {
            for (const output of taskDefinition.outputs) {
                const key = `${taskId}.${output.id}`;
                const snapshot = workflow.input.existingFiles?.[key];
                const current = snapshot
                    ? await readFile(snapshot.path)
                    : null;

                if (
                    !snapshot ||
                    !current ||
                    typeof current.content !== "string" ||
                    current.content !== snapshot.content
                ) {
                    status = "NEEDS_WORK";

                    if (current && typeof current.content === "string" && current.content.trim()) {
                        const refreshed = {
                            path: snapshot?.path || plan.deliverables.find(
                                (item) => item.taskId === taskId && item.outputId === output.id
                            )?.path,
                            content: current.content,
                        };
                        workflow.input.existingFiles[key] = refreshed;
                        plan.existingFiles[key] = refreshed;
                    } else {
                        delete workflow.input.existingFiles[key];
                        delete plan.existingFiles[key];
                    }
                }
            }
        }

        workflow.input.implementationAssessments ||= {};
        workflow.input.implementationAssessments[taskId] = status;
        await persist(tabId, workflow);

        emit("implementation_assessment_completed", {
            taskId,
            status,
        });

        return { workflow, status };
    }


    async function seedAssessedTask({
        tabId,
        workflow,
        taskId,
    }) {
        const taskDefinition = getTaskDefinition(definition, taskId);
        workflow = startWorkflowTask(workflow, taskId);

        for (const output of taskDefinition.outputs) {
            const key = `${taskId}.${output.id}`;
            const existing = workflow.input.existingFiles[key];

            workflow = storeWorkflowOutput(workflow, {
                taskId,
                outputId: output.id,
                content: existing.content,
            });

            workflow = validateWorkflowOutput(workflow, {
                taskId,
                outputId: output.id,
            });

            workflow = assignWorkflowOutputDestination(workflow, {
                taskId,
                outputId: output.id,
                path: existing.path,
                confirmed: true,
            });

            workflow = markWorkflowOutputWritten(workflow, {
                taskId,
                outputId: output.id,
            });
        }

        workflow = completeWorkflowTask(workflow, taskId);
        await persist(tabId, workflow);

        emit("existing_implementation_skipped", {
            taskId,
            paths: taskDefinition.outputs.map(
                (output) => workflow.input.existingFiles[
                    `${taskId}.${output.id}`
                ].path
            ),
        });

        return workflow;
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

            // Existing non-empty files are protected by default. Automatic
            // continuation may update them because the native host creates a
            // timestamped backup before replacing an existing destination.
            if (
                taskOutput.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
            ) {
                throw new Error(
                    `Recovery conflict: "${destination}" was previously written by this workflow but now contains different content. It was not overwritten.`
                );
            }

            if (existingFile.content.trim() !== "") {
                if (!workflow.input?.automaticContinuation) {
                    throw new Error(
                        `Recovery conflict: "${destination}" already contains different content. The file was not overwritten.`
                    );
                }

                emit("existing_file_update_authorized", {
                    taskId,
                    outputId: output.outputId,
                    path: destination,
                    backupRequired: true,
                });
            }

            // Continue to the native write operation. The native host is
            // responsible for creating and returning the backup path.
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

        if (
            currentFiles.has(destination) &&
            workflow.input?.automaticContinuation
        ) {
            const backupPath =
                writeResponse?.backup ||
                writeResponse?.result?.backup ||
                writeResponse?.data?.backup;

            if (!backupPath) {
                throw new Error(
                    `The native host did not confirm a backup for existing file "${destination}". The update was not accepted as safe.`
                );
            }

            emit("existing_file_backed_up", {
                taskId,
                outputId: output.outputId,
                path: destination,
                backupPath,
            });
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



    async function sendPromptWithDependencies({
        prompt,
        workflow,
        definition,
        readFile,
        writeFile,
        listFiles,
        sendPrompt,
        sourceModes,
        shouldStop,
        emit,
        tabId,
        taskId,
        persist,
        resolvedPaths = new Set(),
    }) {
        if (
            workflow.input.dependencyResolution?.taskId === taskId &&
            typeof workflow.input.dependencyResolution.originalPrompt === "string"
        ) {
            // A retry after interruption must use the exact instruction that
            // originally triggered dependency resolution.
            prompt = workflow.input.dependencyResolution.originalPrompt;
        } else {
            workflow.input.dependencyResolution = {
                taskId,
                originalPrompt: prompt,
                status: "resolving",
                dependencies: [],
            };
            await persist(tabId, workflow);
        }

        const response = await sendPrompt(prompt);
        assertNotStopped(shouldStop);

        const responseText = getResponseText(response);
        if (typeof responseText !== "string" || !responseText.trim()) {
            throw new Error("ChatGPT returned an empty or invalid response.");
        }

        const request = extractDependencyRequest(responseText);
        if (!request) return responseText;

        const dependencyPath = normalizeDependencyPath(request.path);
        if (resolvedPaths.has(dependencyPath)) {
            throw new Error(
                `ChatGPT requested dependency "${dependencyPath}" more than once without progressing. Dependency resolution was stopped to prevent an infinite loop.`
            );
        }
        if (resolvedPaths.size >= 12) {
            throw new Error("Dependency resolution exceeded the limit of 12 files.");
        }
        resolvedPaths.add(dependencyPath);

        workflow.input.dependencyResolution.requestedPath = dependencyPath;
        workflow.input.dependencyResolution.status = "dependency_requested";
        await persist(tabId, workflow);

        emit("dependency_requested", {
            path: dependencyPath,
            reason: request.reason,
            requiredFor: request.requiredFor,
        });

        let dependency = await readFile(dependencyPath);
        let dependencyContent =
            dependency && typeof dependency.content === "string"
                ? dependency.content
                : "";

        if (!dependencyContent.trim()) {
            emit("dependency_generation_started", {
                path: dependencyPath,
                wasEmpty: Boolean(dependency && typeof dependency.content === "string"),
            });

            const projectFiles = normalizeFileList(await listFiles());
            assertNotStopped(shouldStop);

            const { task, output } = findDependencyOutput({
                workflow,
                definition,
                dependencyPath,
                projectFiles: [...projectFiles],
            });

            // Reuse the exact task-specific instruction and source contract
            // already used by the normal workflow, but request only this output.
            const dependencyTask = {
                ...task,
                outputs: [output],
            };
            const dependencyDefinition = {
                ...definition,
                tasks: definition.tasks.map((item) =>
                    item.id === task.id ? dependencyTask : item
                ),
            };

            const { sourceContents, sourcePaths } = await loadTaskSources({
                workflow,
                task: dependencyTask,
                readFile,
                sourceModes,
            });

            const dependencyPrompt = generateWorkflowPrompt({
                workflow,
                taskId: task.id,
                sourceContents,
                sourcePaths,
                destinationHints: {
                    [output.id]: dependencyPath,
                },
                additionalInstructions: [
                    "DEPENDENCY SUBTASK SCOPE",
                    request.reason ? `Why this dependency is required: ${request.reason}` : "",
                    request.requiredFor ? `Used by: ${request.requiredFor}` : "",
                    "Generate ONLY the single requested dependency output listed below. The normal task instruction may describe other outputs; do not generate, modify, or return any of those other outputs during this dependency subtask.",
                    `Only output ID: ${output.id}`,
                    `Only destination path: ${dependencyPath}`,
                    "Use the normal task instruction and supplied source files for this one output. Return it using the exact output markers supplied in EXPECTED OUTPUTS.",
                ].join("\n"),
                definition: dependencyDefinition,
            });

            const generatedResponse = await sendPromptWithDependencies({
                prompt: dependencyPrompt,
                workflow,
                definition,
                readFile,
                writeFile,
                listFiles,
                sendPrompt,
                sourceModes,
                shouldStop,
                emit,
                tabId,
                taskId: taskId,
                persist,
                resolvedPaths,
            });

            const generated = extractWorkflowOutputs({
                response: generatedResponse,
                taskId: task.id,
                definition: dependencyDefinition,
            }).outputs.find((item) => item.outputId === output.id);

            if (!generated || !generated.content.trim()) {
                throw new Error(
                    `ChatGPT did not generate valid content for dependency "${dependencyPath}".`
                );
            }

            const writeResult = await writeFile(
                dependencyPath,
                generated.content
            );
            if (writeResult && typeof writeResult === "object" && writeResult.ok === false) {
                throw new Error(
                    writeResult.error ||
                    `Could not save generated dependency "${dependencyPath}".`
                );
            }

            dependency = await readFile(dependencyPath);
            if (
                !dependency ||
                typeof dependency.content !== "string" ||
                dependency.content !== generated.content
            ) {
                throw new Error(
                    `Generated dependency "${dependencyPath}" could not be verified after saving.`
                );
            }

            dependencyContent = dependency.content;
            emit("dependency_generation_completed", {
                path: dependencyPath,
                taskId: task.id,
                outputId: output.id,
            });
        } else {
            emit("dependency_file_found", {
                path: dependencyPath,
                contentLength: dependencyContent.length,
            });
        }

        assertNotStopped(shouldStop);

        workflow.input.dependencyResolution.dependencies.push({
            path: dependencyPath,
            reason: request.reason,
            requiredFor: request.requiredFor,
            content: dependencyContent,
        });
        workflow.input.dependencyResolution.requestedPath = null;
        workflow.input.dependencyResolution.status = "source_ready";
        await persist(tabId, workflow);

        // The dependency is a separate ChatGPT message. Do not append its
        // contents to the original prompt: resend that exact prompt next.
        await sendPrompt(
            buildDependencyContextPrompt(request, dependencyContent)
        );
        assertNotStopped(shouldStop);

        emit("dependency_provided", {
            path: dependencyPath,
            originalPromptResent: true,
        });

        return sendPromptWithDependencies({
            prompt,
            workflow,
            definition,
            readFile,
            writeFile,
            listFiles,
            sendPrompt,
            sourceModes,
            shouldStop,
            emit,
            tabId,
            taskId,
            persist,
            resolvedPaths,
        });
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

                // 2. Generate the prompt and automatically reduce temporary
                // Python source context if it exceeds the conservative budget.
                const existingFilesForTask = Object.fromEntries(
                    (taskDefinition.outputs || [])
                        .map((output) => {
                            const key = `${taskId}.${output.id}`;
                            const existing = workflow.input?.existingFiles?.[key];
                            return existing ? [key, existing] : null;
                        })
                        .filter(Boolean)
                );

                let prompt = generateWorkflowPrompt({
                    workflow,
                    taskId,
                    sourceContents,
                    sourcePaths,
                    existingFiles: existingFilesForTask,
                    additionalInstructions,
                    definition,
                });

                const initialPromptSize = estimatePromptTokens(prompt);
                let compacted = false;

                if (initialPromptSize > MAX_PROMPT_TOKENS) {
                    const compactedSourceModes = {
                        ...sourceModes,
                    };

                    for (const source of taskDefinition.sources || []) {
                        const sourcePath = sourcePaths[source.id] || source.path || "";
                        const isPythonSource =
                            source.type !== "project_tree" &&
                            String(sourcePath).toLowerCase().endsWith(".py");

                        if (isPythonSource) {
                            compactedSourceModes[source.id] =
                                taskId === "create_selector_test" &&
                                source.id === "model"
                                    ? "model_contract"
                                    : "compact";
                        }
                    }

                    const compactedSources = await loadTaskSources({
                        workflow,
                        task: taskDefinition,
                        readFile,
                        sourceModes: compactedSourceModes,
                    });

                    const compactedExistingFiles = Object.fromEntries(
                        Object.entries(existingFilesForTask).map(([key, file]) => [
                            key,
                            {
                                ...file,
                                content: prepareSourceContent({
                                    content: file.content,
                                    path: file.path,
                                    mode: "compact",
                                }).content,
                            },
                        ])
                    );

                    const compactedPrompt = generateWorkflowPrompt({
                        workflow,
                        taskId,
                        sourceContents: compactedSources.sourceContents,
                        sourcePaths: compactedSources.sourcePaths,
                        existingFiles: compactedExistingFiles,
                        additionalInstructions,
                        definition,
                    });

                    const compactedTokens = estimatePromptTokens(compactedPrompt);

                    emit("prompt_compaction", {
                        taskId,
                        initialEstimatedTokens: initialPromptSize,
                        compactedEstimatedTokens: compactedTokens,
                        sourceCount: Object.keys(compactedSources.sourceContents).length,
                    });

                    if (compactedTokens < initialPromptSize) {
                        prompt = compactedPrompt;
                        compacted = true;
                    }
                }

                const estimatedTokens = estimatePromptTokens(prompt);

                if (estimatedTokens > MAX_PROMPT_TOKENS) {
                    throw new Error(
                        `Prompt for task "${taskId}" is too large (${estimatedTokens.toLocaleString()} estimated tokens; budget ${MAX_PROMPT_TOKENS.toLocaleString()}). PromptFlow compacted temporary Python source copies by removing comments, top-level tests, blank lines and trailing whitespace. For create_selector_test, it also reduced the model source to a structural contract while retaining fields, relationships, constraints, metadata and method signatures. Reduce the selected source context or split the task; original project files were not changed.`
                    );
                }

                emit("prompt_ready", {
                    taskId,
                    promptLength: prompt.length,
                    estimatedTokens,
                    compacted,
                });

                // 3. Send the prompt. If ChatGPT requests dependencies,
                // resolve them as separate messages and resend this exact prompt.
                const responseText = await sendPromptWithDependencies({
                    prompt,
                    workflow,
                    definition,
                    readFile,
                    writeFile,
                    listFiles,
                    sendPrompt,
                    sourceModes,
                    shouldStop,
                    emit,
                    tabId,
                    taskId,
                    persist,
                });

                assertNotStopped(shouldStop);

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

            // Preserve the dependency-resolution outcome with the task state.
            if (workflow.input?.dependencyResolution?.taskId === taskId) {
                workflow.input.dependencyResolution.status = "completed";
                workflow.input.dependencyResolution.requestedPath = null;
                await persist(tabId, workflow);
            }

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

                if (workflow.input?.automaticContinuation) {
                    const assessment = await assessExistingTask({
                        tabId,
                        workflow,
                        taskId: nextTask.id,
                    });

                    workflow = assessment.workflow;

                    if (assessment.status === "COMPLETE") {
                        workflow = await seedAssessedTask({
                            tabId,
                            workflow,
                            taskId: nextTask.id,
                        });
                        continue;
                    }
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