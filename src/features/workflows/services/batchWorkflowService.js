
import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

import {
    createWorkflowInstance,
    getWorkflowTaskDefinition,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    assignWorkflowOutputDestination,
    markWorkflowOutputWritten,
    completeWorkflowTask,
    retryWorkflowTask,
} from "./workflowService.js";

import {
    saveBatchState,
    getBatchState,
    updateBatchState,
    BATCH_STATUS,
    BATCH_MODE,
    BATCH_MODEL_STATUS,
} from "../storage/batchStorage.js";


const CREATE_MODEL_TASK_ID = "create_model";

const VALID_MODEL_SOURCE_MODES = new Set([
    "create",
    "existing",
]);

const VALID_PREPARATION_MODES = new Set([
    "full",
    "remove_comments",
    "remove_tests",
    "remove_comments_and_tests",
]);

// Prevent two batch runners from executing simultaneously in one tab.
const runningBatches = new Map();


function now() {
    return new Date().toISOString();
}


function createId() {
    return globalThis.crypto?.randomUUID?.() ||
        `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}


function normalizeProjectPath(path) {
    const rawPath = String(path || "").replace(/\\/g, "/");

    if (
        !rawPath ||
        rawPath.startsWith("/") ||
        /^[A-Za-z]:/.test(rawPath)
    ) {
        throw new Error(
            `Invalid project-relative path: "${path}".`
        );
    }

    const normalized = rawPath
        .replace(/\/+/g, "/")
        .replace(/\/+$/g, "");

    if (
        !normalized ||
        normalized.split("/").some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".."
        )
    ) {
        throw new Error(
            `Invalid project-relative path: "${path}".`
        );
    }

    return normalized;
}


function isInitFile(path) {
    return path.split("/").at(-1) === "__init__.py";
}


function normalizeModelSourceMode(value = "existing") {
    if (!VALID_MODEL_SOURCE_MODES.has(value)) {
        throw new Error(
            `Invalid model source mode: "${value}".`
        );
    }

    return value;
}


function normalizePreparationMode(value = "full") {
    if (!VALID_PREPARATION_MODES.has(value)) {
        throw new Error(
            `Invalid source preparation mode: "${value}".`
        );
    }

    return value;
}


function normalizeModelPath(path) {
    const normalized = normalizeProjectPath(path);

    if (!normalized.toLowerCase().endsWith(".py")) {
        throw new Error(
            `Model file must be a Python file: "${normalized}".`
        );
    }

    if (isInitFile(normalized)) {
        throw new Error(
            "__init__.py files cannot be used as Django models."
        );
    }

    const segments = normalized.split("/");
    const modelsIndex = segments.lastIndexOf("models");

    if (
        modelsIndex === -1 ||
        modelsIndex >= segments.length - 1
    ) {
        throw new Error(
            `The path "${normalized}" is not inside a models directory.`
        );
    }

    return normalized;
}


/**
 * Normalize an individual batch model configuration.
 *
 * modelSource:
 *   "create"   - generate the model.
 *   "existing" - continue from an existing model.
 *
 * sourceMode:
 *   Source preparation mode used when generating prompts.
 */
function getModelConfiguration(model, defaults = {}) {
    if (typeof model === "string") {
        return {
            path: normalizeModelPath(model),

            modelSource: normalizeModelSourceMode(
                defaults.modelSource || "existing"
            ),

            sourceMode: normalizePreparationMode(
                defaults.sourceMode || "full"
            ),
        };
    }

    if (!model || typeof model !== "object") {
        throw new TypeError(
            "Each batch model must be a path or model configuration object."
        );
    }

    return {
        path: normalizeModelPath(model.path),

        modelSource: normalizeModelSourceMode(
            model.modelSource ||
            defaults.modelSource ||
            "existing"
        ),

        sourceMode: normalizePreparationMode(
            model.sourceMode ||
            defaults.sourceMode ||
            "full"
        ),
    };
}


function getModelTaskDefinition(definition) {
    const task = getWorkflowTaskDefinition(
        CREATE_MODEL_TASK_ID,
        definition
    );

    if (
        !Array.isArray(task.outputs) ||
        task.outputs.length !== 1
    ) {
        throw new Error(
            'The "create_model" task must define exactly one model output.'
        );
    }

    return task;
}


function extractFileContent(response, path) {
    const content =
        typeof response === "string"
            ? response
            : response?.content;

    if (
        typeof content !== "string" ||
        !content.trim()
    ) {
        throw new Error(
            `Existing model file "${path}" is empty or could not be read.`
        );
    }

    return content;
}


function assertValidTabId(tabId) {
    if (
        tabId === undefined ||
        tabId === null ||
        !Number.isInteger(Number(tabId)) ||
        Number(tabId) < 0
    ) {
        throw new Error(
            "A valid Firefox tab ID is required."
        );
    }
}


function getBatchFromRecord(record) {
    return record?.batch || null;
}


async function mutateBatch(tabId, batchId, updater) {
    const record = await updateBatchState(
        tabId,
        async (batch) => {
            if (batch.id !== batchId) {
                throw new Error(
                    "The saved batch has changed. Reload the batch before continuing."
                );
            }

            return updater(batch);
        }
    );

    return record.batch;
}


async function checkpointModel({
    tabId,
    batchId,
    modelPath,
    workflow,
}) {
    return mutateBatch(
        tabId,
        batchId,
        (batch) => {
            const model = batch.models.find(
                (item) => item.path === modelPath
            );

            if (!model) {
                throw new Error(
                    `Model "${modelPath}" is not part of this batch.`
                );
            }

            model.workflow = workflow;
            model.updatedAt = now();

            return batch;
        }
    );
}


async function setModelStatus({
    tabId,
    batchId,
    modelPath,
    status,
    error = null,
    workflow,
}) {
    return mutateBatch(
        tabId,
        batchId,
        (batch) => {
            const model = batch.models.find(
                (item) => item.path === modelPath
            );

            if (!model) {
                throw new Error(
                    `Model "${modelPath}" is not part of this batch.`
                );
            }

            model.status = status;
            model.error = error;
            model.updatedAt = now();

            if (workflow !== undefined) {
                model.workflow = workflow;
            }

            if (status === BATCH_MODEL_STATUS.RUNNING) {
                model.startedAt = now();
                model.completedAt = null;
            }

            if (
                status === BATCH_MODEL_STATUS.COMPLETED ||
                status === BATCH_MODEL_STATUS.SKIPPED
            ) {
                model.completedAt = now();
            }

            return batch;
        }
    );
}


async function getCurrentBatch(tabId, batchId) {
    const record = await getBatchState(tabId);
    const batch = getBatchFromRecord(record);

    if (!batch || batch.id !== batchId) {
        throw new Error(
            "The saved batch could not be found."
        );
    }

    return batch;
}


/**
 * Discover Python files located below any directory named "models".
 *
 * Examples:
 * core/accounts/models/user.py
 * core/finance/ledger/models/account_balances/account_balance.py
 * models/payment.py
 *
 * All __init__.py files are excluded.
 */
export function discoverDjangoModelFiles(files) {
    if (!Array.isArray(files)) {
        throw new TypeError(
            "The project file list must be an array."
        );
    }

    const discovered = new Set();

    for (const item of files) {
        const rawPath =
            typeof item === "string"
                ? item
                : item?.path;

        if (typeof rawPath !== "string") {
            continue;
        }

        let path;

        try {
            path = normalizeProjectPath(rawPath);
        } catch {
            continue;
        }

        if (
            !path.toLowerCase().endsWith(".py") ||
            isInitFile(path)
        ) {
            continue;
        }

        const segments = path.split("/");
        const modelsIndex = segments.lastIndexOf("models");

        if (
            modelsIndex === -1 ||
            modelsIndex >= segments.length - 1
        ) {
            continue;
        }

        discovered.add(path);
    }

    return [...discovered].sort((a, b) =>
        a.localeCompare(b)
    );
}


/**
 * Create a batch from manually selected model files.
 *
 * Each model can independently specify:
 *
 * {
 *     path: "...",
 *     modelSource: "create" | "existing",
 *     sourceMode: "full" | "remove_comments" |
 *         "remove_tests" | "remove_comments_and_tests"
 * }
 */
export async function createWorkflowBatch({
    tabId,
    projectId,
    projectName = "",
    workingDirectory = "",
    projectTree,
    modelPaths,
    models,
    mode = BATCH_MODE.MANUAL,
    modelSource = "existing",
    sourceMode = "full",
    preparationMode,
    definition = DJANGO_MODEL_WORKFLOW,
}) {
    assertValidTabId(tabId);

    if (!projectId) {
        throw new Error(
            "A registered native project ID is required."
        );
    }

    if (!projectTree || typeof projectTree !== "string") {
        throw new Error(
            "The project file tree is required."
        );
    }

    if (!Object.values(BATCH_MODE).includes(mode)) {
        throw new Error(
            `Invalid batch execution mode: "${mode}".`
        );
    }

    const suppliedModels = models || modelPaths;

    if (!Array.isArray(suppliedModels)) {
        throw new Error(
            "Select at least one Django model file."
        );
    }

    const defaults = {
        modelSource,
        sourceMode: preparationMode || sourceMode,
    };

    const normalizedModels = suppliedModels.map(
        (model) => getModelConfiguration(model, defaults)
    );

    if (!normalizedModels.length) {
        throw new Error(
            "Select at least one Django model file."
        );
    }

    const paths = new Set();

    for (const model of normalizedModels) {
        if (paths.has(model.path)) {
            throw new Error(
                `Duplicate model selected: "${model.path}".`
            );
        }

        paths.add(model.path);
    }

    if (
        mode === BATCH_MODE.SINGLE &&
        normalizedModels.length !== 1
    ) {
        throw new Error(
            "Single-model mode requires exactly one selected model."
        );
    }

    const timestamp = now();

    const batch = {
        id: createId(),
        tabId: Number(tabId),

        project: {
            id: projectId,
            name: projectName,
        },

        workingDirectory: String(workingDirectory || ""),
        projectTree,

        definitionId: definition.id,

        mode,
        status: BATCH_STATUS.READY,

        models: normalizedModels.map((model) => ({
            path: model.path,
            modelSource: model.modelSource,
            sourceMode: model.sourceMode,

            status: BATCH_MODEL_STATUS.PENDING,

            workflow: null,
            error: null,

            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: null,
            completedAt: null,
        })),

        currentIndex: 0,

        pauseRequested: false,
        stopRequested: false,
        awaitingNext: false,

        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        completedAt: null,
    };

    await saveBatchState(tabId, batch);

    return batch;
}


/**
 * Create an individual workflow for a batch model.
 */
function createModelWorkflow({
    batch,
    model,
    definition,
}) {
    const workflow = createWorkflowInstance({
        definition,

        projectId: batch.project.id,
        projectName: batch.project.name,

        modelPath: model.path,
        projectTree: batch.projectTree,
    });

    workflow.input.workingDirectory =
        batch.workingDirectory || "";

    return workflow;
}


/**
 * Treat an existing model file as the completed output of create_model.
 *
 * This uses the normal workflow lifecycle functions so downstream
 * workflow dependencies remain valid.
 */
async function seedExistingModel({
    workflow,
    model,
    readFile,
    definition,
}) {
    if (typeof readFile !== "function") {
        throw new TypeError(
            "readFile is required to continue from an existing model."
        );
    }

    const response = await readFile(model.path);

    const content = extractFileContent(
        response,
        model.path
    );

    const taskDefinition = getModelTaskDefinition(definition);
    const outputDefinition = taskDefinition.outputs[0];

    let updatedWorkflow = startWorkflowTask(
        workflow,
        CREATE_MODEL_TASK_ID,
        definition
    );

    updatedWorkflow = storeWorkflowOutput(
        updatedWorkflow,
        {
            taskId: CREATE_MODEL_TASK_ID,
            outputId: outputDefinition.id,
            content,
        }
    );

    updatedWorkflow = validateWorkflowOutput(
        updatedWorkflow,
        {
            taskId: CREATE_MODEL_TASK_ID,
            outputId: outputDefinition.id,
        }
    );

    updatedWorkflow = assignWorkflowOutputDestination(
        updatedWorkflow,
        {
            taskId: CREATE_MODEL_TASK_ID,
            outputId: outputDefinition.id,
            path: model.path,
            confirmed: true,
        }
    );

    updatedWorkflow = markWorkflowOutputWritten(
        updatedWorkflow,
        {
            taskId: CREATE_MODEL_TASK_ID,
            outputId: outputDefinition.id,
        }
    );

    updatedWorkflow = completeWorkflowTask(
        updatedWorkflow,
        CREATE_MODEL_TASK_ID
    );

    return updatedWorkflow;
}


/**
 * Prepare a model workflow.
 *
 * Existing models are seeded as completed create_model tasks.
 * Newly generated models start with all tasks pending.
 */
async function prepareModelWorkflow({
    batch,
    model,
    readFile,
    definition,
}) {
    let workflow = model.workflow;

    if (!workflow) {
        workflow = createModelWorkflow({
            batch,
            model,
            definition,
        });
    }

    if (
        model.modelSource === "existing" &&
        !workflow.tasks.some(
            (task) =>
                task.id === CREATE_MODEL_TASK_ID &&
                task.status === "completed"
        )
    ) {
        workflow = await seedExistingModel({
            workflow,
            model,
            readFile,
            definition,
        });
    }

    return workflow;
}


function findNextPendingIndex(batch, fromIndex = 0) {
    for (
        let index = fromIndex;
        index < batch.models.length;
        index += 1
    ) {
        if (
            batch.models[index].status ===
            BATCH_MODEL_STATUS.PENDING
        ) {
            return index;
        }
    }

    return -1;
}


function getBatchCompletionStatus(batch) {
    const allFinished = batch.models.every(
        (model) =>
            model.status === BATCH_MODEL_STATUS.COMPLETED ||
            model.status === BATCH_MODEL_STATUS.SKIPPED
    );

    return allFinished
        ? BATCH_STATUS.COMPLETED
        : null;
}


/**
 * Execute a batch sequentially.
 *
 * runModel receives:
 * {
 *     tabId,
 *     workflow,
 *     sourceMode,
 *     modelSource,
 *     onWorkflowChange
 * }
 *
 * It must return:
 * {
 *     success,
 *     workflow,
 *     progress,
 *     error
 * }
 */
export async function startWorkflowBatch({
    tabId,
    batchId,
    runModel,
    readFile,
    definition = DJANGO_MODEL_WORKFLOW,
    onBatchChange = () => {},
    onModelChange = () => {},
}) {
    assertValidTabId(tabId);

    if (typeof runModel !== "function") {
        throw new TypeError(
            "runModel must be a function."
        );
    }

    const key = Number(tabId);

    if (runningBatches.has(key)) {
        throw new Error(
            "A batch is already running in this Firefox tab."
        );
    }

    let batch = await getCurrentBatch(tabId, batchId);

    if (batch.definitionId !== definition.id) {
        throw new Error(
            "The batch workflow definition does not match the current definition."
        );
    }

    if (
        batch.status === BATCH_STATUS.COMPLETED ||
        batch.status === BATCH_STATUS.STOPPED
    ) {
        throw new Error(
            `This batch cannot be resumed because it is "${batch.status}".`
        );
    }

    if (batch.status === BATCH_STATUS.FAILED) {
        throw new Error(
            "This batch has a failed model. Retry or skip that model before continuing."
        );
    }

    const control = {
        batchId,
    };

    runningBatches.set(key, control);

    let processedCount = 0;

    try {
        batch = await mutateBatch(
            tabId,
            batchId,
            (current) => {
                current.status = BATCH_STATUS.RUNNING;
                current.pauseRequested = false;
                current.stopRequested = false;
                current.awaitingNext = false;

                current.startedAt =
                    current.startedAt || now();

                current.updatedAt = now();

                return current;
            }
        );

        onBatchChange(batch);

        while (true) {
            batch = await getCurrentBatch(tabId, batchId);

            // Stop only between model workflows.
            if (batch.stopRequested) {
                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.status = BATCH_STATUS.STOPPED;
                        current.awaitingNext = false;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onBatchChange(batch);
                break;
            }

            // Pause only between model workflows.
            if (batch.pauseRequested) {
                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.status = BATCH_STATUS.PAUSED;
                        current.awaitingNext = false;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onBatchChange(batch);
                break;
            }

            const nextIndex = findNextPendingIndex(
                batch,
                batch.currentIndex
            );

            if (nextIndex === -1) {
                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.currentIndex =
                            current.models.length;

                        current.status =
                            getBatchCompletionStatus(current) ||
                            BATCH_STATUS.READY;

                        current.completedAt =
                            current.status === BATCH_STATUS.COMPLETED
                                ? now()
                                : null;

                        current.awaitingNext = false;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onBatchChange(batch);
                break;
            }

            batch = await mutateBatch(
                tabId,
                batchId,
                (current) => {
                    current.currentIndex = nextIndex;
                    current.updatedAt = now();

                    return current;
                }
            );

            const model = batch.models[nextIndex];

            onModelChange({
                type: "model_started",
                model,
                index: nextIndex,
                total: batch.models.length,
            });

            await setModelStatus({
                tabId,
                batchId,
                modelPath: model.path,
                status: BATCH_MODEL_STATUS.RUNNING,
                error: null,
            });

            let workflow;

            try {
                batch = await getCurrentBatch(tabId, batchId);

                const currentModel = batch.models[nextIndex];

                /*
                 * Create and checkpoint the initial workflow before
                 * reading an existing model. This preserves a snapshot
                 * if the file read or existing-model seeding fails.
                 */
                workflow = currentModel.workflow ||
                    createModelWorkflow({
                        batch,
                        model: currentModel,
                        definition,
                    });

                await checkpointModel({
                    tabId,
                    batchId,
                    modelPath: model.path,
                    workflow,
                });

                workflow = await prepareModelWorkflow({
                    batch,
                    model: {
                        ...currentModel,
                        workflow,
                    },
                    readFile,
                    definition,
                });

                await checkpointModel({
                    tabId,
                    batchId,
                    modelPath: model.path,
                    workflow,
                });

                /*
                 * The controller calls onStateChange synchronously
                 * but does not await it. Serialize and drain checkpoints
                 * after runModel returns to avoid losing its final state.
                 */
                let checkpointChain = Promise.resolve();

                const onWorkflowChange = (updatedWorkflow) => {
                    checkpointChain = checkpointChain.then(
                        () => checkpointModel({
                            tabId,
                            batchId,
                            modelPath: model.path,
                            workflow: updatedWorkflow,
                        })
                    );

                    return checkpointChain;
                };

                const result = await runModel({
                    tabId: Number(tabId),
                    workflow,

                    // Source preparation mode.
                    sourceMode: currentModel.sourceMode,
                    preparationMode: currentModel.sourceMode,

                    // Model creation/continuation choice.
                    modelSource: currentModel.modelSource,
                    modelSourceMode: currentModel.modelSource,

                    onWorkflowChange,
                });

                await checkpointChain;

                if (result?.workflow) {
                    workflow = result.workflow;

                    await checkpointModel({
                        tabId,
                        batchId,
                        modelPath: model.path,
                        workflow,
                    });
                }

                if (!result || result.success !== true) {
                    throw new Error(
                        result?.error ||
                        `Workflow failed for "${model.path}".`
                    );
                }

                await setModelStatus({
                    tabId,
                    batchId,
                    modelPath: model.path,
                    status: BATCH_MODEL_STATUS.COMPLETED,
                    workflow,
                    error: null,
                });

                processedCount += 1;

                onModelChange({
                    type: "model_completed",
                    model: {
                        ...model,
                        workflow,
                        status: BATCH_MODEL_STATUS.COMPLETED,
                    },
                    index: nextIndex,
                    total: batch.models.length,
                });

            } catch (error) {
                const failedWorkflow =
                    error?.workflow || workflow || null;

                await setModelStatus({
                    tabId,
                    batchId,
                    modelPath: model.path,
                    status: BATCH_MODEL_STATUS.FAILED,
                    workflow: failedWorkflow || undefined,
                    error: error.message || String(error),
                });

                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.status = BATCH_STATUS.FAILED;
                        current.awaitingNext = false;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onModelChange({
                    type: "model_failed",
                    model: {
                        ...model,
                        workflow: failedWorkflow,
                        status: BATCH_MODEL_STATUS.FAILED,
                        error: error.message || String(error),
                    },
                    index: nextIndex,
                    total: batch.models.length,
                    error: error.message || String(error),
                });

                onBatchChange(batch);

                return {
                    success: false,
                    batch,
                    processedCount,
                    error: error.message || String(error),
                };
            }

            batch = await getCurrentBatch(tabId, batchId);

            const remainingIndex = findNextPendingIndex(
                batch,
                nextIndex + 1
            );

            if (remainingIndex === -1) {
                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.currentIndex =
                            current.models.length;

                        current.status = BATCH_STATUS.COMPLETED;
                        current.completedAt = now();
                        current.awaitingNext = false;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onBatchChange(batch);
                break;
            }

            // Single mode and manual mode stop after one model.
            if (
                batch.mode === BATCH_MODE.SINGLE ||
                batch.mode === BATCH_MODE.MANUAL
            ) {
                batch = await mutateBatch(
                    tabId,
                    batchId,
                    (current) => {
                        current.currentIndex = remainingIndex;
                        current.status = BATCH_STATUS.PAUSED;
                        current.awaitingNext = true;
                        current.updatedAt = now();

                        return current;
                    }
                );

                onBatchChange(batch);
                break;
            }

            // Automatic mode continues to the next selected model.
        }

        batch = await getCurrentBatch(tabId, batchId);

        return {
            success: batch.status === BATCH_STATUS.COMPLETED,
            batch,
            processedCount,
        };

    } finally {
        if (runningBatches.get(key) === control) {
            runningBatches.delete(key);
        }
    }
}


/**
 * Resume a paused or ready batch.
 *
 * Manual mode processes exactly one more model.
 */
export async function resumeWorkflowBatch(options) {
    return startWorkflowBatch(options);
}


/**
 * Request a pause. The current model is allowed to finish.
 */
export async function pauseWorkflowBatch(tabId, batchId) {
    const batch = await mutateBatch(
        tabId,
        batchId,
        (current) => {
            if (current.status !== BATCH_STATUS.RUNNING) {
                throw new Error(
                    "Only a running batch can be paused."
                );
            }

            current.pauseRequested = true;
            current.updatedAt = now();

            return current;
        }
    );

    return batch;
}


/**
 * Request a stop. The current model is allowed to finish.
 */
export async function stopWorkflowBatch(tabId, batchId) {
    const batch = await mutateBatch(
        tabId,
        batchId,
        (current) => {
            if (current.status !== BATCH_STATUS.RUNNING) {
                throw new Error(
                    "Only a running batch can be stopped."
                );
            }

            current.stopRequested = true;
            current.updatedAt = now();

            return current;
        }
    );

    return batch;
}


/**
 * Retry a failed model.
 *
 * If a workflow task failed, retry it through the normal lifecycle.
 * If the failure occurred before a task entered the failed state
 * (for example, reading an existing model), recreate the workflow
 * when the model is run again.
 *
 * Already-written outputs remain intact.
 */
export async function retryBatchModel(tabId, batchId) {
    const batch = await getCurrentBatch(tabId, batchId);

    if (batch.status !== BATCH_STATUS.FAILED) {
        throw new Error(
            "Only a failed batch can have its failed model retried."
        );
    }

    const failedIndex = batch.models.findIndex(
        (model) =>
            model.status === BATCH_MODEL_STATUS.FAILED
    );

    if (failedIndex === -1) {
        throw new Error(
            "No failed model was found in this batch."
        );
    }

    const failedModel = batch.models[failedIndex];

    let retriedWorkflow = failedModel.workflow || null;

    if (retriedWorkflow) {
        const failedTask = retriedWorkflow.tasks.find(
            (task) => task.status === "failed"
        );

        if (failedTask) {
            retriedWorkflow = retryWorkflowTask(
                retriedWorkflow,
                failedTask.id
            );
        } else {
            // Failure occurred before a workflow task failed.
            retriedWorkflow = null;
        }
    }

    const updatedBatch = await mutateBatch(
        tabId,
        batchId,
        (current) => {
            const model = current.models.find(
                (item) => item.path === failedModel.path
            );

            model.workflow = retriedWorkflow;
            model.status = BATCH_MODEL_STATUS.PENDING;
            model.error = null;
            model.completedAt = null;
            model.updatedAt = now();

            current.currentIndex = failedIndex;
            current.status = BATCH_STATUS.READY;
            current.pauseRequested = false;
            current.stopRequested = false;
            current.awaitingNext = false;
            current.completedAt = null;
            current.updatedAt = now();

            return current;
        }
    );

    return updatedBatch;
}


/**
 * Skip a pending or failed model.
 *
 * A running model cannot be skipped.
 */
export async function skipBatchModel(
    tabId,
    batchId,
    modelPath
) {
    const normalizedPath = normalizeModelPath(modelPath);

    const batch = await mutateBatch(
        tabId,
        batchId,
        (current) => {
            const model = current.models.find(
                (item) => item.path === normalizedPath
            );

            if (!model) {
                throw new Error(
                    `Model "${normalizedPath}" is not in this batch.`
                );
            }

            if (
                model.status === BATCH_MODEL_STATUS.RUNNING ||
                model.status === BATCH_MODEL_STATUS.COMPLETED ||
                model.status === BATCH_MODEL_STATUS.SKIPPED
            ) {
                throw new Error(
                    `Model "${normalizedPath}" cannot be skipped in its current state.`
                );
            }

            model.status = BATCH_MODEL_STATUS.SKIPPED;
            model.error = null;
            model.completedAt = now();
            model.updatedAt = now();

            const nextIndex = findNextPendingIndex(
                current,
                current.currentIndex
            );

            current.currentIndex =
                nextIndex === -1
                    ? current.models.length
                    : nextIndex;

            if (current.status === BATCH_STATUS.FAILED) {
                current.status =
                    getBatchCompletionStatus(current) ||
                    BATCH_STATUS.READY;
            }

            if (
                getBatchCompletionStatus(current) ===
                BATCH_STATUS.COMPLETED
            ) {
                current.status = BATCH_STATUS.COMPLETED;
                current.completedAt = now();
            }

            current.updatedAt = now();

            return current;
        }
    );

    return batch;
}


/**
 * Calculate aggregate batch progress.
 */
export function getBatchProgress(batch) {
    if (!batch || !Array.isArray(batch.models)) {
        return {
            total: 0,
            completed: 0,
            skipped: 0,
            failed: 0,
            running: 0,
            pending: 0,
            percentage: 0,
        };
    }

    const total = batch.models.length;

    const completed = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.COMPLETED
    ).length;

    const skipped = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.SKIPPED
    ).length;

    const failed = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.FAILED
    ).length;

    const running = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.RUNNING
    ).length;

    const pending = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.PENDING
    ).length;

    const percentage = total
        ? Math.round(
            ((completed + skipped) / total) * 100
        )
        : 0;

    return {
        total,
        completed,
        skipped,
        failed,
        running,
        pending,
        percentage,
    };
}


/**
 * Retrieve the currently saved batch for a tab.
 */
export async function getWorkflowBatch(tabId) {
    assertValidTabId(tabId);

    const record = await getBatchState(tabId);

    return getBatchFromRecord(record);
}


/**
 * Check whether this tab currently has an active in-memory runner.
 */
export function isWorkflowBatchRunning(tabId) {
    return runningBatches.has(Number(tabId));
}
