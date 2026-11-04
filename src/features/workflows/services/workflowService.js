import {
    DJANGO_MODEL_WORKFLOW,
} from "../definitions/django-model-workflow.js";

export const WORKFLOW_TASK_STATUS = Object.freeze({
    PENDING: "pending",
    READY: "ready",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    BLOCKED: "blocked",
});


export const WORKFLOW_OUTPUT_STATUS = Object.freeze({
    PENDING: "pending",
    EXTRACTED: "extracted",
    VALIDATED: "validated",
    AWAITING_DESTINATION: "awaiting_destination",
    READY_TO_WRITE: "ready_to_write",
    WRITTEN: "written",
    FAILED: "failed",
});


function createId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    throw new Error(
        "Secure UUID generation is unavailable."
    );
}


function clone(value) {
    return structuredClone(value);
}


function validateWorkflowDefinition(definition) {
    if (!definition?.id || !Array.isArray(definition.tasks)) {
        throw new Error("Invalid workflow definition.");
    }

    if (!definition.tasks.length) {
        throw new Error("The workflow has no tasks.");
    }

    const taskIds = new Set();

    for (const task of definition.tasks) {
        if (!task.id || taskIds.has(task.id)) {
            throw new Error(
                "Workflow task IDs must be unique."
            );
        }

        taskIds.add(task.id);

        if (!Array.isArray(task.dependencies)) {
            throw new Error(
                `Task "${task.id}" must define dependencies.`
            );
        }

        if (!Array.isArray(task.sources)) {
            throw new Error(
                `Task "${task.id}" must define sources.`
            );
        }

        if (!Array.isArray(task.outputs) || !task.outputs.length) {
            throw new Error(
                `Task "${task.id}" must define at least one output.`
            );
        }

        const outputIds = new Set();

        for (const output of task.outputs) {
            if (!output.id || outputIds.has(output.id)) {
                throw new Error(
                    `Output IDs must be unique within task "${task.id}".`
                );
            }

            outputIds.add(output.id);

            if (!output.destination?.mode) {
                throw new Error(
                    `Output "${output.id}" in task "${task.id}" must define a destination mode.`
                );
            }
        }
    }

    for (const task of definition.tasks) {
        for (const dependency of task.dependencies) {
            if (!taskIds.has(dependency)) {
                throw new Error(
                    `Task "${task.id}" depends on unknown task "${dependency}".`
                );
            }

            if (dependency === task.id) {
                throw new Error(
                    `Task "${task.id}" cannot depend on itself.`
                );
            }
        }
    }

    // Detect circular task dependencies.
    const visited = new Set();
    const visiting = new Set();

    function visit(taskId) {
        if (visiting.has(taskId)) {
            throw new Error(
                `Circular workflow dependency detected at "${taskId}".`
            );
        }

        if (visited.has(taskId)) return;

        visiting.add(taskId);

        const task = definition.tasks.find(
            (item) => item.id === taskId
        );

        for (const dependency of task.dependencies) {
            visit(dependency);
        }

        visiting.delete(taskId);
        visited.add(taskId);
    }

    for (const task of definition.tasks) {
        visit(task.id);
    }

    return true;
}


function validateDefinitionForWorkflow(workflow, definition) {
    validateWorkflowDefinition(definition);

    if (workflow.definitionId !== definition.id) {
        throw new Error(
            `Workflow definition mismatch. Expected "${workflow.definitionId}", received "${definition.id}".`
        );
    }

    const expectedVersion = definition.version || 1;

    if (workflow.definitionVersion !== expectedVersion) {
        throw new Error(
            `Workflow definition version mismatch. Expected version "${workflow.definitionVersion}", received "${expectedVersion}".`
        );
    }
}


function createTaskInstance(taskDefinition) {
    return {
        id: taskDefinition.id,

        name: taskDefinition.name,

        description: taskDefinition.description || "",

        order: taskDefinition.order,

        dependencies: [...taskDefinition.dependencies],

        status: WORKFLOW_TASK_STATUS.PENDING,

        attempts: 0,

        error: null,

        startedAt: null,

        completedAt: null,

        outputs: taskDefinition.outputs.map((output) => ({
            id: output.id,

            name: output.name,

            type: output.type,

            required: output.required !== false,

            status: WORKFLOW_OUTPUT_STATUS.PENDING,

            content: null,

            destination: {
                mode: output.destination.mode,

                path: null,

                requiresConfirmation:
                    output.destination.requiresConfirmation ??
                    output.destination.mode ===
                        "infer_from_project_tree",

                confirmed: false,

                source: null,
            },

            validation: clone(output.validation || {}),

            error: null,
        })),
    };
}


function getTaskDefinition(definition, taskId) {
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


function getTaskInstance(workflow, taskId) {
    const task = workflow.tasks.find(
        (item) => item.id === taskId
    );

    if (!task) {
        throw new Error(
            `Workflow task "${taskId}" was not found.`
        );
    }

    return task;
}


function getOutputInstance(task, outputId) {
    const output = task.outputs.find(
        (item) => item.id === outputId
    );

    if (!output) {
        throw new Error(
            `Output "${outputId}" was not found in task "${task.id}".`
        );
    }

    return output;
}


function ensureTaskIsRunning(task, operation) {
    if (task.status !== WORKFLOW_TASK_STATUS.RUNNING) {
        throw new Error(
            `Cannot ${operation} for task "${task.id}" because its status is "${task.status}".`
        );
    }
}


function areDependenciesCompleted(workflow, task) {
    return task.dependencies.every((dependencyId) => {
        const dependency = getTaskInstance(
            workflow,
            dependencyId
        );

        return (
            dependency.status ===
            WORKFLOW_TASK_STATUS.COMPLETED
        );
    });
}


function areRequiredOutputsReady(task) {
    return task.outputs.every((output) => {
        if (!output.required) return true;

        return [
            WORKFLOW_OUTPUT_STATUS.EXTRACTED,
            WORKFLOW_OUTPUT_STATUS.VALIDATED,
            WORKFLOW_OUTPUT_STATUS.AWAITING_DESTINATION,
            WORKFLOW_OUTPUT_STATUS.READY_TO_WRITE,
            WORKFLOW_OUTPUT_STATUS.WRITTEN,
        ].includes(output.status);
    });
}


function refreshTaskReadiness(workflow) {
    for (const task of workflow.tasks) {
        if (
            task.status !== WORKFLOW_TASK_STATUS.PENDING &&
            task.status !== WORKFLOW_TASK_STATUS.READY
        ) {
            continue;
        }

        task.status = areDependenciesCompleted(
            workflow,
            task
        )
            ? WORKFLOW_TASK_STATUS.READY
            : WORKFLOW_TASK_STATUS.PENDING;
    }
}


function findSourceOutput(workflow, source) {
    const task = getTaskInstance(
        workflow,
        source.task
    );

    return getOutputInstance(
        task,
        source.output
    );
}


function ensureTaskCanStart(workflow, task, definition) {
    if (
        task.status !== WORKFLOW_TASK_STATUS.READY &&
        task.status !== WORKFLOW_TASK_STATUS.PENDING
    ) {
        throw new Error(
            `Task "${task.id}" cannot start from status "${task.status}".`
        );
    }

    if (!areDependenciesCompleted(workflow, task)) {
        throw new Error(
            `Task "${task.id}" has incomplete dependencies.`
        );
    }

    const taskDefinition = getTaskDefinition(
        definition,
        task.id
    );

    for (const source of taskDefinition.sources) {
        if (source.type !== "workflow_output") continue;

        const output = findSourceOutput(
            workflow,
            source
        );

        if (
            source.required !== false &&
            output.status !== WORKFLOW_OUTPUT_STATUS.WRITTEN
        ) {
            throw new Error(
                `Required source "${source.id}" is not written yet.`
            );
        }
    }
}


function normalizeProjectRelativePath(path, label) {
    if (typeof path !== "string" || !path.trim()) {
        throw new Error(`${label} is required.`);
    }

    const normalized = path
        .trim()
        .replace(/\\/g, "/");

    if (
        normalized.startsWith("/") ||
        /^[a-zA-Z]:/.test(normalized) ||
        normalized.split("/").some(
            (part) =>
                !part ||
                part === "." ||
                part === ".."
        )
    ) {
        throw new Error(
            `${label} must be a valid project-relative path.`
        );
    }

    return normalized;
}


export function createWorkflowInstance({
    definition = DJANGO_MODEL_WORKFLOW,
    projectId,
    projectName = "",
    modelPath,
    projectTree,
    explicitDestinations = {},
}) {
    validateWorkflowDefinition(definition);

    if (!projectId) {
        throw new Error(
            "A registered project is required."
        );
    }

    if (!modelPath?.trim()) {
        throw new Error(
            "A model destination path is required."
        );
    }

    if (!projectTree?.trim()) {
        throw new Error(
            "The project file tree is required."
        );
    }

    const normalizedModelPath = normalizeProjectRelativePath(
        modelPath,
        "The model path"
    );

    const modelTask = definition.tasks.find(
        (task) => task.id === "create_model"
    );

    const modelOutputDefinition = modelTask?.outputs.find(
        (output) => output.id === "model"
    );

    if (!modelOutputDefinition) {
        throw new Error(
            "The workflow must define the create_model task and model output."
        );
    }

    const workflow = {
        id: createId(),

        definitionId: definition.id,

        definitionVersion: definition.version || 1,

        name: definition.name,

        project: {
            id: projectId,

            name: projectName,
        },

        input: {
            modelPath: normalizedModelPath,

            projectTree,
        },

        explicitDestinations: clone(
            explicitDestinations
        ),

        status: "ready",

        currentTaskId: null,

        tasks: definition.tasks
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map(createTaskInstance),

        createdAt: new Date().toISOString(),

        updatedAt: new Date().toISOString(),

        completedAt: null,

        error: null,
    };

    // Assign the model destination to this workflow instance,
    // never to the shared workflow definition.
    const modelTaskInstance = getTaskInstance(
        workflow,
        "create_model"
    );

    const modelOutputInstance = getOutputInstance(
        modelTaskInstance,
        "model"
    );

    modelOutputInstance.destination.path = normalizedModelPath;

    modelOutputInstance.destination.source = "explicit_input";

    modelOutputInstance.destination.confirmed = true;

    modelOutputInstance.destination.mode = "explicit";

    // Apply explicitly supplied destinations.
    for (const task of definition.tasks) {
        const taskInstance = getTaskInstance(
            workflow,
            task.id
        );

        for (const outputDefinition of task.outputs) {
            const output = getOutputInstance(
                taskInstance,
                outputDefinition.id
            );

            const destinationKey =
                `${task.id}.${outputDefinition.id}`;

            const explicitPath =
                explicitDestinations[destinationKey];

            if (!explicitPath) continue;

            const normalizedPath = normalizeProjectRelativePath(
                typeof explicitPath === "string"
                    ? explicitPath
                    : explicitPath.path,
                `Destination for "${destinationKey}"`
            );

            output.destination.path = normalizedPath;

            output.destination.mode = "explicit";

            output.destination.source = "user";

            output.destination.confirmed = true;
        }
    }

    refreshTaskReadiness(workflow);

    workflow.currentTaskId =
        workflow.tasks.find(
            (task) =>
                task.status === WORKFLOW_TASK_STATUS.READY
        )?.id || null;

    return workflow;
}


export function getWorkflowProgress(workflow) {
    const total = workflow.tasks.length;

    const completed = workflow.tasks.filter(
        (task) =>
            task.status === WORKFLOW_TASK_STATUS.COMPLETED
    ).length;

    return {
        total,

        completed,

        remaining: total - completed,

        percentage: total
            ? Math.round((completed / total) * 100)
            : 0,
    };
}


export function getNextReadyTask(workflow) {
    const nextTask = workflow.tasks.find(
        (task) =>
            task.status === WORKFLOW_TASK_STATUS.READY
    );

    return nextTask ? clone(nextTask) : null;
}


export function startWorkflowTask(
    workflow,
    taskId,
    definition = DJANGO_MODEL_WORKFLOW
) {
    validateDefinitionForWorkflow(workflow, definition);

    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    ensureTaskCanStart(
        next,
        task,
        definition
    );

    task.status = WORKFLOW_TASK_STATUS.RUNNING;

    task.attempts += 1;

    task.startedAt = new Date().toISOString();

    task.completedAt = null;

    task.error = null;

    next.currentTaskId = task.id;

    next.status = "running";

    next.error = null;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function storeWorkflowOutput(
    workflow,
    {
        taskId,
        outputId,
        content,
    }
) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    ensureTaskIsRunning(task, "store an output");

    const output = getOutputInstance(
        task,
        outputId
    );

    if (output.status === WORKFLOW_OUTPUT_STATUS.WRITTEN) {
        throw new Error(
            `Output "${outputId}" has already been written and cannot be replaced.`
        );
    }

    if (typeof content !== "string" || !content.trim()) {
        throw new Error(
            `Output "${outputId}" cannot be empty.`
        );
    }

    output.content = content;

    output.status = WORKFLOW_OUTPUT_STATUS.EXTRACTED;

    output.error = null;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function validateWorkflowOutput(
    workflow,
    {
        taskId,
        outputId,
    }
) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    ensureTaskIsRunning(task, "validate an output");

    const output = getOutputInstance(
        task,
        outputId
    );

    if (
        output.status !== WORKFLOW_OUTPUT_STATUS.EXTRACTED
    ) {
        throw new Error(
            `Output "${outputId}" must be extracted before validation.`
        );
    }

    if (!output.content?.trim()) {
        throw new Error(
            `Output "${outputId}" is empty.`
        );
    }

    const expectedExtension = output.validation.extension;

    if (expectedExtension && output.destination.path) {
        const extension = expectedExtension.startsWith(".")
            ? expectedExtension
            : `.${expectedExtension}`;

        if (
            !output.destination.path
                .toLowerCase()
                .endsWith(extension.toLowerCase())
        ) {
            throw new Error(
                `Output "${outputId}" must have a "${extension}" destination.`
            );
        }
    }

    output.status = WORKFLOW_OUTPUT_STATUS.VALIDATED;

    output.error = null;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function assignWorkflowOutputDestination(
    workflow,
    {
        taskId,
        outputId,
        path,
        confirmed = false,
    }
) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    ensureTaskIsRunning(task, "assign an output destination");

    const output = getOutputInstance(
        task,
        outputId
    );

    if (
        output.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
    ) {
        throw new Error(
            `The destination for output "${outputId}" cannot be changed after it has been written.`
        );
    }

    if (output.status === WORKFLOW_OUTPUT_STATUS.FAILED) {
        throw new Error(
            `The destination for failed output "${outputId}" cannot be changed. Retry the task first.`
        );
    }

    const normalizedPath = normalizeProjectRelativePath(
        path,
        "The output destination"
    );

    const expectedExtension = output.validation.extension;

    if (expectedExtension) {
        const extension = expectedExtension.startsWith(".")
            ? expectedExtension
            : `.${expectedExtension}`;

        if (
            !normalizedPath
                .toLowerCase()
                .endsWith(extension.toLowerCase())
        ) {
            throw new Error(
                `The output destination must have a "${extension}" extension.`
            );
        }
    }

    output.destination.path = normalizedPath;

    output.destination.source = "user";

    output.destination.mode = "explicit";

    output.destination.confirmed = confirmed === true;

    if (
        output.status === WORKFLOW_OUTPUT_STATUS.VALIDATED ||
        output.status === WORKFLOW_OUTPUT_STATUS.AWAITING_DESTINATION
    ) {
        output.status = confirmed
            ? WORKFLOW_OUTPUT_STATUS.READY_TO_WRITE
            : WORKFLOW_OUTPUT_STATUS.AWAITING_DESTINATION;
    }

    next.updatedAt = new Date().toISOString();

    return next;
}


export function markWorkflowOutputWritten(
    workflow,
    {
        taskId,
        outputId,
    }
) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    ensureTaskIsRunning(task, "mark an output as written");

    const output = getOutputInstance(
        task,
        outputId
    );

    if (
        !output.destination.path ||
        !output.destination.confirmed
    ) {
        throw new Error(
            `Output "${outputId}" requires a confirmed destination.`
        );
    }

    if (
        output.status !== WORKFLOW_OUTPUT_STATUS.READY_TO_WRITE &&
        output.status !== WORKFLOW_OUTPUT_STATUS.VALIDATED
    ) {
        throw new Error(
            `Output "${outputId}" is not ready to be written.`
        );
    }

    output.status = WORKFLOW_OUTPUT_STATUS.WRITTEN;

    output.error = null;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function completeWorkflowTask(workflow, taskId) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    if (task.status !== WORKFLOW_TASK_STATUS.RUNNING) {
        throw new Error(
            `Task "${taskId}" is not running.`
        );
    }

    if (!areRequiredOutputsReady(task)) {
        throw new Error(
            `Task "${taskId}" still has required outputs that have not been extracted.`
        );
    }

    const incompleteOutputs = task.outputs.filter(
        (output) =>
            output.required &&
            output.status !== WORKFLOW_OUTPUT_STATUS.WRITTEN
    );

    if (incompleteOutputs.length) {
        throw new Error(
            `Task "${taskId}" has outputs that have not been written: ${
                incompleteOutputs.map((output) => output.id).join(", ")
            }.`
        );
    }

    task.status = WORKFLOW_TASK_STATUS.COMPLETED;

    task.completedAt = new Date().toISOString();

    task.error = null;

    next.currentTaskId = null;

    refreshTaskReadiness(next);

    const nextTask = next.tasks.find(
        (item) =>
            item.status === WORKFLOW_TASK_STATUS.READY
    );

    next.currentTaskId = nextTask?.id || null;

    const allCompleted = next.tasks.every(
        (item) =>
            item.status === WORKFLOW_TASK_STATUS.COMPLETED
    );

    if (allCompleted) {
        next.status = "completed";

        next.completedAt = new Date().toISOString();
    } else {
        next.status = "ready";
    }

    next.updatedAt = new Date().toISOString();

    return next;
}


export function failWorkflowTask(
    workflow,
    taskId,
    error
) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    if (task.status !== WORKFLOW_TASK_STATUS.RUNNING) {
        throw new Error(
            `Task "${taskId}" is not running.`
        );
    }

    task.status = WORKFLOW_TASK_STATUS.FAILED;

    task.error =
        error?.message ||
        String(error || "Unknown workflow task error.");

    next.status = "failed";

    next.error = task.error;

    next.currentTaskId = task.id;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function retryWorkflowTask(workflow, taskId) {
    const next = clone(workflow);

    const task = getTaskInstance(next, taskId);

    if (task.status !== WORKFLOW_TASK_STATUS.FAILED) {
        throw new Error(
            "Only failed tasks can be retried."
        );
    }

    if (!areDependenciesCompleted(next, task)) {
        throw new Error(
            `Task "${taskId}" cannot be retried because its dependencies are incomplete.`
        );
    }

    task.status = WORKFLOW_TASK_STATUS.READY;

    task.error = null;

    task.startedAt = null;

    task.completedAt = null;

    for (const output of task.outputs) {
        // Successfully written outputs must remain untouched.
        if (
            output.status === WORKFLOW_OUTPUT_STATUS.WRITTEN
        ) {
            continue;
        }

        // Preserve generated content and destinations.
        // Execution will verify existing files before resuming.
        if (output.content?.trim()) {
            output.error = null;
            continue;
        }

        // Only reset outputs that have no generated content.
        output.status = WORKFLOW_OUTPUT_STATUS.PENDING;

        output.content = null;

        output.error = null;

        const preserveDestination = [
            "user",
            "explicit_input",
        ].includes(output.destination.source);

        if (!preserveDestination) {
            output.destination.path = null;

            output.destination.confirmed = false;
        }
    }

    next.status = "ready";

    next.error = null;

    next.currentTaskId = task.id;

    next.updatedAt = new Date().toISOString();

    return next;
}


export function getWorkflowOutput(
    workflow,
    taskId,
    outputId
) {
    const task = getTaskInstance(
        workflow,
        taskId
    );

    const output = getOutputInstance(
        task,
        outputId
    );

    return clone(output);
}


export function getWorkflowTaskDefinition(
    taskId,
    definition = DJANGO_MODEL_WORKFLOW
) {
    validateWorkflowDefinition(definition);

    return clone(
        getTaskDefinition(definition, taskId)
    );
}


export function getWorkflowDefinition(
    definition = DJANGO_MODEL_WORKFLOW
) {
    validateWorkflowDefinition(definition);

    return clone(definition);
}