// src/features/workflows/services/workflowBatchService.js

import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

import {
    createWorkflowInstance,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    assignWorkflowOutputDestination,
    markWorkflowOutputWritten,
    completeWorkflowTask,
    retryWorkflowTask,
    WORKFLOW_TASK_STATUS,
} from "./workflowService.js";

import {
    createWorkflowExecutionController,
} from "./workflowExecutionService.js";

import {
    saveBatchState,
    getBatchState,
    BATCH_STATUS,
    BATCH_MODE,
    BATCH_MODEL_STATUS,
} from "../storage/batchStorage.js";

import {
    isInitFilePath,
} from "./workflowPathUtils.js";


const activeBatches = new Map();


function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    throw new Error("Secure UUID generation is unavailable.");
}


function normalizePath(path) {
    if (typeof path !== "string" || !path.trim()) {
        throw new Error("A valid model path is required.");
    }

    const normalized = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\/+/g, "/");

    if (
        !normalized ||
        normalized.split("/").some(
            (segment) =>
                !segment ||
                segment === "." ||
                segment === ".."
        )
    ) {
        throw new Error(`Invalid project-relative path: "${path}".`);
    }

    return normalized;
}


function validateModelPath(path) {
    const normalized = normalizePath(path);
    const segments = normalized.split("/");
    const modelsIndex = segments.lastIndexOf("models");

    if (
        !normalized.endsWith(".py") ||
        isInitFilePath(normalized) ||
        modelsIndex === -1 ||
        modelsIndex === segments.length - 1
    ) {
        throw new Error(
            `"${normalized}" is not a valid Django model file.`
        );
    }

    return normalized;
}


function getFilePath(file) {
    return typeof file === "string"
        ? file
        : file?.path;
}


/**
 * Discover Python files under any directory named "models".
 *
 * Examples:
 *   core/finance/ledger/models/account.py
 *   core/finance/ledger/models/account_balances/account_balance.py
 *
 * __init__.py files and non-Python files are excluded.
 */
export function discoverDjangoModelFiles(files) {
    if (!Array.isArray(files)) {
        throw new TypeError("The project file list must be an array.");
    }

    const discovered = new Set();

    for (const file of files) {
        const rawPath = getFilePath(file);

        if (typeof rawPath !== "string") continue;

        let path;

        try {
            path = normalizePath(rawPath);
        } catch {
            continue;
        }

        if (
            !path.endsWith(".py") ||
            isInitFilePath(path)
        ) {
            continue;
        }

        const segments = path.split("/");
        const modelsIndex = segments.lastIndexOf("models");

        if (
            modelsIndex === -1 ||
            modelsIndex === segments.length - 1
        ) {
            continue;
        }

        discovered.add(path);
    }

    return [...discovered].sort((a, b) =>
        a.localeCompare(b)
    );
}


function normalizeSelectedModels(models, existingModelPaths) {
    if (!Array.isArray(models) || models.length === 0) {
        throw new Error("Select at least one model.");
    }

    const existingPaths = new Set(
        (existingModelPaths || []).map(normalizePath)
    );

    const seen = new Set();

    return models.map((item) => {
        const rawPath =
            typeof item === "string"
                ? item
                : item?.path;

        const path = validateModelPath(rawPath);

        if (seen.has(path)) {
            throw new Error(
                `The model "${path}" was selected more than once.`
            );
        }

        seen.add(path);

        const requestedMode =
            typeof item === "object"
                ? item.mode
                : null;

        const mode =
            requestedMode ||
            (existingPaths.has(path) ? "existing" : "create");

        if (!["create", "existing"].includes(mode)) {
            throw new Error(
                `Invalid model processing mode for "${path}".`
            );
        }

        return {
            path,
            mode,
            status: BATCH_MODEL_STATUS.PENDING,
            workflow: null,
            error: null,
            startedAt: null,
            completedAt: null,
        };
    });
}


function validateBatchOptions({
    tabId,
    projectId,
    projectTree,
    mode,
    models,
}) {
    if (
        tabId === undefined ||
        tabId === null ||
        !Number.isInteger(Number(tabId)) ||
        Number(tabId) < 0
    ) {
        throw new Error("A valid Firefox tab ID is required.");
    }

    if (!projectId) {
        throw new Error("A registered project ID is required.");
    }

    if (typeof projectTree !== "string" || !projectTree.trim()) {
        throw new Error("The project file tree is required.");
    }

    if (!Object.values(BATCH_MODE).includes(mode)) {
        throw new Error(`Invalid batch mode: "${mode}".`);
    }

    if (mode === BATCH_MODE.SINGLE && models.length !== 1) {
        throw new Error(
            "Single-model mode requires exactly one selected model."
        );
    }
}


/**
 * Create a new batch.
 *
 * models accepts:
 *   ["core/app/models/example.py"]
 *
 * Or:
 *   [
 *     { path: "core/app/models/example.py", mode: "existing" },
 *     { path: "core/app/models/another.py", mode: "create" },
 *   ]
 *
 * @returns {Promise<Object>} Saved batch record.
 */
export async function createWorkflowBatch({
    tabId,
    projectId,
    projectName = "",
    workingDirectory = "",
    projectTree,
    models,
    existingModelPaths = [],
    mode = BATCH_MODE.SINGLE,
    sourceMode = "full",
}) {
    const normalizedModels = normalizeSelectedModels(
        models,
        existingModelPaths
    );

    validateBatchOptions({
        tabId,
        projectId,
        projectTree,
        mode,
        models: normalizedModels,
    });

    if (
        ![
            "full",
            "remove_comments",
            "remove_tests",
            "remove_comments_and_tests",
        ].includes(sourceMode)
    ) {
        throw new Error(
            `Unsupported source preparation mode: "${sourceMode}".`
        );
    }

    const now = new Date().toISOString();

    const batch = {
        id: createId(),

        tabId: Number(tabId),

        mode,

        status: BATCH_STATUS.READY,

        project: {
            id: projectId,
            name: projectName,
        },

        workingDirectory,

        projectTree,

        sourceMode,

        models: normalizedModels,

        currentIndex: 0,

        pauseRequested: false,

        stopRequested: false,

        pauseReason: null,

        error: null,

        createdAt: now,

        updatedAt: now,

        completedAt: null,
    };

    return saveBatchState(tabId, batch);
}


/**
 * Update and persist a batch.
 */
async function persistBatch(tabId, batch, onBatchChange) {
    batch.updatedAt = new Date().toISOString();

    const record = await saveBatchState(tabId, batch);

    if (typeof onBatchChange === "function") {
        onBatchChange(structuredClone(batch));
    }

    return record;
}


/**
 * Prepare a workflow for one selected model.
 */
function createModelWorkflow(batch, model) {
    const workflow = createWorkflowInstance({
        definition: DJANGO_MODEL_WORKFLOW,

        projectId: batch.project.id,

        projectName: batch.project.name,

        modelPath: model.path,

        projectTree: batch.projectTree,
    });

    // Keep the selected native working directory with this workflow.
    workflow.input.workingDirectory = batch.workingDirectory || "";

    return workflow;
}


/**
 * Seed create_model as completed using the normal workflow lifecycle.
 *
 * This is used only when the user chooses "Continue from existing model".
 * No project file is written or modified here.
 */
async function seedExistingModel({
    workflow,
    modelPath,
    readFile,
}) {
    const response = await readFile(modelPath);

    if (
        !response ||
        typeof response.content !== "string" ||
        !response.content.trim()
    ) {
        throw new Error(
            `The existing model "${modelPath}" could not be read or is empty.`
        );
    }

    let next = startWorkflowTask(
        workflow,
        "create_model",
        DJANGO_MODEL_WORKFLOW
    );

    next = storeWorkflowOutput(next, {
        taskId: "create_model",
        outputId: "model",
        content: response.content,
    });

    next = validateWorkflowOutput(next, {
        taskId: "create_model",
        outputId: "model",
    });

    next = assignWorkflowOutputDestination(next, {
        taskId: "create_model",
        outputId: "model",
        path: modelPath,
        confirmed: true,
    });

    next = markWorkflowOutputWritten(next, {
        taskId: "create_model",
        outputId: "model",
    });

    next = completeWorkflowTask(
        next,
        "create_model"
    );

    return next;
}


function getNextModelIndex(batch) {
    return batch.models.findIndex(
        (model, index) =>
            index >= batch.currentIndex &&
            model.status === BATCH_MODEL_STATUS.PENDING
    );
}


function updateCurrentIndex(batch) {
    const nextIndex = getNextModelIndex(batch);

    batch.currentIndex =
        nextIndex === -1
            ? batch.models.length
            : nextIndex;
}


function getBatchProgress(batch) {
    const total = batch.models.length;

    const completed = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.COMPLETED
    ).length;

    const failed = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.FAILED
    ).length;

    const skipped = batch.models.filter(
        (model) =>
            model.status === BATCH_MODEL_STATUS.SKIPPED
    ).length;

    const remaining = total - completed - skipped;

    return {
        total,
        completed,
        failed,
        skipped,
        remaining,
        percentage: total
            ? Math.round(
                ((completed + skipped) / total) * 100
            )
            : 0,
    };
}


/**
 * Process the next model or continue automatically.
 *
 * Manual mode processes one model per invocation.
 * Automatic mode continues until completion or a failure.
 *
 * A pause/stop request takes effect between models. It does not
 * interrupt a ChatGPT response or a filesystem write midway.
 */
export async function runWorkflowBatch({
    tabId,
    readFile,
    writeFile,
    listFiles,
    sendPrompt,
    confirmDestinations,
    ensureWriteAuthorization,
    onBatchChange = () => {},
    onEvent = () => {},
    shouldStop = () => false,
}) {
    const requiredFunctions = {
        readFile,
        writeFile,
        listFiles,
        sendPrompt,
        confirmDestinations,
    };

    for (const [name, value] of Object.entries(requiredFunctions)) {
        if (typeof value !== "function") {
            throw new TypeError(`${name} must be a function.`);
        }
    }

    if (typeof shouldStop !== "function") {
        throw new TypeError("shouldStop must be a function.");
    }

    const normalizedTabId = Number(tabId);

    if (activeBatches.has(normalizedTabId)) {
        throw new Error(
            "A batch is already running for this Firefox tab."
        );
    }

    const record = await getBatchState(normalizedTabId);

    if (!record) {
        throw new Error(
            "No saved batch exists for this Firefox tab."
        );
    }

    const batch = record.batch;

    if (
        batch.status === BATCH_STATUS.COMPLETED ||
        batch.status === BATCH_STATUS.STOPPED
    ) {
        throw new Error(
            `This batch cannot run because its status is "${batch.status}".`
        );
    }

    if (
        batch.status === BATCH_STATUS.FAILED &&
        !batch.models.some(
            (model) =>
                model.status === BATCH_MODEL_STATUS.PENDING
        )
    ) {
        throw new Error(
            "The batch has no pending models. Retry or skip the failed model first."
        );
    }

    const control = {
        pauseRequested: false,
        stopRequested: false,
    };

    activeBatches.set(normalizedTabId, control);

    let pendingSnapshotWrites = Promise.resolve();

    function emit(type, details = {}) {
        onEvent({
            type,
            timestamp: new Date().toISOString(),
            ...details,
        });
    }

    function queueSnapshotSave(model, updatedWorkflow) {
        model.workflow = structuredClone(updatedWorkflow);

        pendingSnapshotWrites = pendingSnapshotWrites.then(
            () => persistBatch(
                normalizedTabId,
                batch,
                onBatchChange
            )
        );

        return pendingSnapshotWrites;
    }

    try {
        if (typeof ensureWriteAuthorization === "function") {
            await ensureWriteAuthorization();
        }

        batch.status = BATCH_STATUS.RUNNING;
        batch.error = null;
        batch.pauseRequested = false;
        batch.stopRequested = false;

        await persistBatch(
            normalizedTabId,
            batch,
            onBatchChange
        );

        let processedThisRun = 0;

        while (true) {
            if (shouldStop() || control.stopRequested) {
                batch.status = BATCH_STATUS.STOPPED;
                batch.stopRequested = true;
                batch.pauseReason = "stopped_by_user";

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                break;
            }

            if (control.pauseRequested) {
                batch.status = BATCH_STATUS.PAUSED;
                batch.pauseRequested = true;
                batch.pauseReason = "paused_by_user";

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                break;
            }

            const modelIndex = getNextModelIndex(batch);

            if (modelIndex === -1) {
                const hasFailures = batch.models.some(
                    (model) =>
                        model.status === BATCH_MODEL_STATUS.FAILED
                );

                batch.status = hasFailures
                    ? BATCH_STATUS.FAILED
                    : BATCH_STATUS.COMPLETED;

                batch.completedAt =
                    batch.status === BATCH_STATUS.COMPLETED
                        ? new Date().toISOString()
                        : null;

                batch.pauseReason = null;

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                emit("batch_completed", {
                    batchId: batch.id,
                    progress: getBatchProgress(batch),
                });

                break;
            }

            const model = batch.models[modelIndex];

            batch.currentIndex = modelIndex;

            model.status = BATCH_MODEL_STATUS.RUNNING;
            model.error = null;
            model.startedAt = new Date().toISOString();

            await persistBatch(
                normalizedTabId,
                batch,
                onBatchChange
            );

            emit("model_started", {
                batchId: batch.id,
                modelPath: model.path,
                modelIndex,
                total: batch.models.length,
            });

            try {
                let workflow = model.workflow
                    ? structuredClone(model.workflow)
                    : createModelWorkflow(batch, model);

                if (!model.workflow && model.mode === "existing") {
                    workflow = await seedExistingModel({
                        workflow,
                        modelPath: model.path,
                        readFile,
                    });

                    model.workflow = structuredClone(workflow);

                    await persistBatch(
                        normalizedTabId,
                        batch,
                        onBatchChange
                    );

                    emit("existing_model_loaded", {
                        modelPath: model.path,
                    });
                }

                if (
                    workflow.status === "failed"
                ) {
                    throw new Error(
                        `The saved workflow for "${model.path}" has failed. Retry the model before continuing.`
                    );
                }

                const controller =
                    createWorkflowExecutionController({
                        definition: DJANGO_MODEL_WORKFLOW,

                        readFile,

                        writeFile,

                        listFiles,

                        sendPrompt,

                        confirmDestinations,

                        onStateChange: (updatedWorkflow) => {
                            queueSnapshotSave(
                                model,
                                updatedWorkflow
                            );
                        },

                        onEvent: (event) => {
                            emit("workflow_event", {
                                modelPath: model.path,
                                event,
                            });
                        },

                        shouldStop,
                    });

                const result = await controller.run({
                    tabId: normalizedTabId,

                    workflow,

                    sourceModes: {
                        model: batch.sourceMode,
                    },
                });

                await pendingSnapshotWrites;

                if (!result.success) {
                    model.workflow = structuredClone(
                        result.workflow
                    );

                    throw new Error(
                        result.error ||
                        `Workflow failed for "${model.path}".`
                    );
                }

                model.workflow = structuredClone(result.workflow);

                model.status = BATCH_MODEL_STATUS.COMPLETED;
                model.completedAt = new Date().toISOString();
                model.error = null;

                processedThisRun += 1;

                updateCurrentIndex(batch);

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                emit("model_completed", {
                    modelPath: model.path,
                    progress: getBatchProgress(batch),
                });

            } catch (error) {
                await pendingSnapshotWrites;

                model.status = BATCH_MODEL_STATUS.FAILED;
                model.error =
                    error?.message ||
                    String(error || "Unknown model execution error.");

                batch.status = BATCH_STATUS.FAILED;
                batch.error = model.error;
                batch.pauseReason = "model_failed";

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                emit("model_failed", {
                    modelPath: model.path,
                    error: model.error,
                    progress: getBatchProgress(batch),
                });

                break;
            }

            // Manual mode always stops after one completed model.
            if (
                batch.mode === BATCH_MODE.MANUAL ||
                batch.mode === BATCH_MODE.SINGLE
            ) {
                const remaining = getNextModelIndex(batch);

                if (remaining !== -1) {
                    batch.status = BATCH_STATUS.PAUSED;
                    batch.pauseReason = "awaiting_manual_next";
                } else {
                    batch.status = BATCH_STATUS.COMPLETED;
                    batch.completedAt = new Date().toISOString();
                }

                await persistBatch(
                    normalizedTabId,
                    batch,
                    onBatchChange
                );

                break;
            }

            // Automatic mode continues to the next selected model.
        }

        return {
            success:
                batch.status === BATCH_STATUS.COMPLETED ||
                batch.status === BATCH_STATUS.PAUSED,

            batch: structuredClone(batch),

            progress: getBatchProgress(batch),
        };

    } catch (error) {
        batch.status = BATCH_STATUS.FAILED;
        batch.error = error?.message || String(error);

        await persistBatch(
            normalizedTabId,
            batch,
            onBatchChange
        );

        return {
            success: false,
            batch: structuredClone(batch),
            progress: getBatchProgress(batch),
            error: batch.error,
        };

    } finally {
        activeBatches.delete(normalizedTabId);
    }
}


/**
 * Request a pause after the currently executing model finishes.
 */
export function requestBatchPause(tabId) {
    const control = activeBatches.get(Number(tabId));

    if (!control) {
        return false;
    }

    control.pauseRequested = true;

    return true;
}


/**
 * Request a stop after the currently executing model finishes.
 */
export function requestBatchStop(tabId) {
    const control = activeBatches.get(Number(tabId));

    if (!control) {
        return false;
    }

    control.stopRequested = true;

    return true;
}


/**
 * Retry a failed model.
 *
 * The workflow's completed tasks and written outputs are preserved.
 */
export async function retryBatchModel(tabId, modelPath) {
    const record = await getBatchState(tabId);

    if (!record) {
        throw new Error("No saved batch exists.");
    }

    const batch = record.batch;

    const normalizedPath = normalizePath(modelPath);

    const model = batch.models.find(
        (item) => item.path === normalizedPath
    );

    if (!model) {
        throw new Error(
            `Model "${normalizedPath}" was not found in this batch.`
        );
    }

    if (model.status !== BATCH_MODEL_STATUS.FAILED) {
        throw new Error(
            "Only failed models can be retried."
        );
    }

    if (!model.workflow || model.workflow.status !== "failed") {
        throw new Error(
            "The failed model does not have a recoverable workflow snapshot."
        );
    }

    const failedTask = model.workflow.tasks.find(
        (task) => task.status === WORKFLOW_TASK_STATUS.FAILED
    );

    if (!failedTask) {
        throw new Error(
            "The saved workflow has no failed task to retry."
        );
    }

    model.workflow = retryWorkflowTask(
        model.workflow,
        failedTask.id
    );

    model.status = BATCH_MODEL_STATUS.PENDING;
    model.error = null;
    model.completedAt = null;

    batch.status = BATCH_STATUS.PAUSED;
    batch.error = null;
    batch.pauseReason = "retry_ready";

    updateCurrentIndex(batch);

    return saveBatchState(tabId, batch);
}


/**
 * Skip a failed model and continue with the next pending model.
 */
export async function skipBatchModel(tabId, modelPath) {
    const record = await getBatchState(tabId);

    if (!record) {
        throw new Error("No saved batch exists.");
    }

    const batch = record.batch;
    const normalizedPath = normalizePath(modelPath);

    const model = batch.models.find(
        (item) => item.path === normalizedPath
    );

    if (!model) {
        throw new Error(
            `Model "${normalizedPath}" was not found in this batch.`
        );
    }

    if (model.status !== BATCH_MODEL_STATUS.FAILED) {
        throw new Error(
            "Only failed models can be skipped."
        );
    }

    model.status = BATCH_MODEL_STATUS.SKIPPED;
    model.error = null;

    batch.status = BATCH_STATUS.PAUSED;
    batch.error = null;
    batch.pauseReason = "model_skipped";

    updateCurrentIndex(batch);

    return saveBatchState(tabId, batch);
}


/**
 * Retrieve the saved batch and its progress.
 */
export async function getWorkflowBatch(tabId) {
    const record = await getBatchState(tabId);

    if (!record) return null;

    return {
        ...record,
        progress: getBatchProgress(record.batch),
    };
}