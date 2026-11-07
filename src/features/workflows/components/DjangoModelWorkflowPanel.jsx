import { useEffect, useRef, useState } from "react";

import {
    AlertCircle,
    CheckCircle2,
    Circle,
    Clock,
    FolderTree,
    Play,
    RotateCcw,
    Save,
    Square,
} from "lucide-react";

import { DJANGO_MODEL_WORKFLOW } from "../definitions/django-model-workflow.js";

import {
    WORKFLOW_TASK_STATUS,
    createWorkflowInstance,
    getWorkflowProgress,
    retryWorkflowTask,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    assignWorkflowOutputDestination,
    markWorkflowOutputWritten,
    completeWorkflowTask,
} from "../services/workflowService.js";

import {
    createWorkflowExecutionController,
} from "../services/workflowExecutionService.js";

import {
    isInitFilePath,
} from "../services/workflowPathUtils.js";

import {
    getWorkflowState,
    saveWorkflowState,
} from "../storage/workflowStorage.js";

import {
    discoverDjangoModelFiles,
    createWorkflowBatch,
    startWorkflowBatch,
    pauseWorkflowBatch,
    stopWorkflowBatch,
    retryBatchModel,
    skipBatchModel,
    getBatchProgress,
    getWorkflowBatch,
} from "../services/batchWorkflowService.js";

import {
    BATCH_MODE,
    BATCH_STATUS,
    BATCH_MODEL_STATUS,
} from "../storage/batchStorage.js";


const SOURCE_PREPARATION_MODES = [
    { value: "full", label: "Full source" },
    { value: "remove_comments", label: "Remove comments" },
    { value: "remove_tests", label: "Remove tests" },
    {
        value: "remove_comments_and_tests",
        label: "Remove comments and tests",
    },
];

const MODEL_SOURCE_MODES = [
    { value: "create", label: "Create a new model" },
    {
        value: "existing",
        label: "Continue from an existing model",
    },
];


function getDestinationEntries(destinations, taskId) {
    const entries = [];

    if (Array.isArray(destinations)) {
        for (const item of destinations) {
            const outputId =
                item.outputId ||
                item.id ||
                item.output?.id;

            if (!outputId) continue;

            entries.push({
                key: `${taskId}.${outputId}`,
                outputId,
                name: item.name || item.outputName || outputId,
                path:
                    item.path ||
                    item.destination?.path ||
                    item.candidate?.path ||
                    "",
            });
        }

        return entries;
    }

    if (!destinations || typeof destinations !== "object") {
        return entries;
    }

    for (const [key, value] of Object.entries(destinations)) {
        if (!value) continue;

        const outputId =
            value.outputId ||
            value.id ||
            key.split(".").pop();

        if (!outputId) continue;

        entries.push({
            key: key.includes(".") ? key : `${taskId}.${outputId}`,
            outputId,
            name: value.name || value.outputName || outputId,
            path:
                typeof value === "string"
                    ? value
                    : (
                        value.path ||
                        value.destination?.path ||
                        value.candidate?.path ||
                        ""
                    ),
        });
    }

    return entries;
}


function getWorkflowStatusLabel(workflow) {
    if (!workflow) return "Not started";

    switch (workflow.status) {
        case "ready":
            return "Ready";
        case "running":
            return "Running";
        case "failed":
            return "Failed";
        case "completed":
            return "Completed";
        default:
            return workflow.status || "Unknown";
    }
}


function getBatchStatusLabel(batch) {
    if (!batch) return "Not started";

    const labels = {
        [BATCH_STATUS.READY]: "Ready",
        [BATCH_STATUS.RUNNING]: "Running",
        [BATCH_STATUS.PAUSED]: "Paused",
        [BATCH_STATUS.FAILED]: "Failed",
        [BATCH_STATUS.COMPLETED]: "Completed",
        [BATCH_STATUS.STOPPED]: "Stopped",
    };

    return labels[batch.status] || batch.status;
}


function getModelStatusLabel(status) {
    const labels = {
        [BATCH_MODEL_STATUS.PENDING]: "Pending",
        [BATCH_MODEL_STATUS.RUNNING]: "Running",
        [BATCH_MODEL_STATUS.COMPLETED]: "Completed",
        [BATCH_MODEL_STATUS.FAILED]: "Failed",
        [BATCH_MODEL_STATUS.SKIPPED]: "Skipped",
    };

    return labels[status] || status;
}


function getModelStatusClass(status) {
    switch (status) {
        case BATCH_MODEL_STATUS.COMPLETED:
            return "text-green-700 bg-green-100";
        case BATCH_MODEL_STATUS.RUNNING:
            return "text-indigo-700 bg-indigo-100";
        case BATCH_MODEL_STATUS.FAILED:
            return "text-red-700 bg-red-100";
        case BATCH_MODEL_STATUS.SKIPPED:
            return "text-slate-600 bg-slate-100";
        default:
            return "text-slate-600 bg-slate-100";
    }
}

export default function DjangoModelWorkflowPanel({
    activeTabId,
    nativeProjectId,
    nativeProjectName,
    nativeProjectFiles,
    nativeWorkingDirectory,
    treeText,
    readNativeProjectFile,
    writeNativeProjectFile,
    getNativeProjectFiles,
    ensureWriteAuthorization,
    getWorkflowAuthorization,
    sendPromptToChatGPT,
}) {
    const [workflow, setWorkflow] = useState(null);
    const [batch, setBatch] = useState(null);

    const [modelPath, setModelPath] = useState("");

    const [sourceMode, setSourceMode] = useState("full");
    const [modelSourceMode, setModelSourceMode] = useState("create");

    // These are deliberately separate:
    // executionMode: single | batch
    // batchMode: manual | automatic
    const [executionMode, setExecutionMode] = useState("single");
    const [batchMode, setBatchMode] = useState(BATCH_MODE.MANUAL);

    const [batchModelSourceMode, setBatchModelSourceMode] =
        useState("existing");

    const [discoveredModels, setDiscoveredModels] = useState([]);
    const [selectedModels, setSelectedModels] = useState([]);

    const [isLoading, setIsLoading] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [events, setEvents] = useState([]);

    const [destinationDialog, setDestinationDialog] = useState(null);

    const stopRequestedRef = useRef(false);
    const destinationResolverRef = useRef(null);
    const mountedRef = useRef(true);

    const activeTabIdRef = useRef(activeTabId);
    const nativeProjectIdRef = useRef(nativeProjectId);
    const nativeWorkingDirectoryRef = useRef(
        nativeWorkingDirectory || ""
    );

    const executionContextRef = useRef(null);

    activeTabIdRef.current = activeTabId;
    nativeProjectIdRef.current = nativeProjectId;
    nativeWorkingDirectoryRef.current =
        nativeWorkingDirectory || "";

    // --------------------------------------------------------
    // BACKGROUND MESSAGE/EVENT HANDLING
    // --------------------------------------------------------
    useEffect(() => {
        const handleBackgroundMessage = (message) => {
            if (
                message?.type ===
                "PROMPTFLOW_BACKGROUND_DESTINATION_CONFIRMATION"
            ) {
                const request = message.request;

                if (
                    request?.workflowTabId !== activeTabIdRef.current
                ) {
                    return;
                }

                setDestinationDialog({
                    requestId: request.requestId,
                    taskId: request.taskId,
                    entries: getDestinationEntries(
                        request.destinations,
                        request.taskId
                    ),
                });

                return;
            }

            if (
                message?.type !==
                "PROMPTFLOW_BACKGROUND_WORKFLOW_EVENT"
            ) {
                return;
            }

            if (
                message.workflowTabId !== activeTabIdRef.current
            ) {
                return;
            }

            switch (message.event) {
                case "workflow_started":
                    setIsRunning(true);
                    setIsStopping(false);
                    setError("");
                    break;

                case "workflow_state_changed":
                    if (message.workflow) {
                        setWorkflow(message.workflow);
                    }
                    break;

                case "workflow_event":
                    if (message.workflowEvent) {
                        setEvents((previous) => [
                            ...previous,
                            message.workflowEvent,
                        ].slice(-40));
                    }
                    break;

                case "workflow_finished": {
                    const result = message.result;

                    if (result?.workflow) {
                        setWorkflow(result.workflow);
                    }

                    setIsRunning(false);
                    setIsStopping(false);

                    if (result?.success) {
                        setNotice(
                            "Django model workflow completed successfully. All required output files were written."
                        );
                        setError("");
                    } else {
                        setError(
                            result?.error ||
                            "Workflow execution stopped. Review the failed task and retry."
                        );
                    }

                    break;
                }

                case "workflow_failed":
                case "workflow_start_failed":
                    setIsRunning(false);
                    setIsStopping(false);
                    setError(
                        message.error ||
                        "Background workflow execution failed."
                    );
                    break;

                default:
                    break;
            }
        };

        browser.runtime.onMessage.addListener(
            handleBackgroundMessage
        );

        return () => {
            browser.runtime.onMessage.removeListener(
                handleBackgroundMessage
            );
        };
    }, []);
    // ---------------------------------------------------------
    // RESTORE SAVED WORKFLOW AND BATCH
    // ---------------------------------------------------------

    useEffect(() => {
        let cancelled = false;

        async function restoreState() {
            setWorkflow(null);
            setBatch(null);
            setEvents([]);
            setError("");
            setNotice("");
            setModelPath("");

            if (
                activeTabId === null ||
                activeTabId === undefined
            ) {
                return;
            }

            setIsLoading(true);

            try {
                const [savedWorkflow, savedBatch] =
                    await Promise.all([
                        getWorkflowState(activeTabId),
                        getWorkflowBatch(activeTabId),
                    ]);

                if (cancelled) return;

                const restoredWorkflow =
                    savedWorkflow?.workflow ||
                    savedWorkflow ||
                    null;

                setBatch(savedBatch);

                const currentBatchModel =
                    savedBatch?.models?.[
                        savedBatch.currentIndex
                    ];

                const batchWorkflow =
                    currentBatchModel?.workflow ||
                    savedBatch?.models
                        ?.slice()
                        .reverse()
                        .find((model) => model.workflow)
                        ?.workflow ||
                    null;

                const selectedWorkflow =
                    batchWorkflow || restoredWorkflow;

                setWorkflow(selectedWorkflow);

                setModelPath(
                    selectedWorkflow?.input?.modelPath || ""
                );

                if (savedBatch) {
                    setExecutionMode(
                        savedBatch.mode === BATCH_MODE.SINGLE
                            ? "single"
                            : "batch"
                    );

                    if (
                        savedBatch.mode === BATCH_MODE.AUTOMATIC
                    ) {
                        setBatchMode(BATCH_MODE.AUTOMATIC);
                    } else {
                        setBatchMode(BATCH_MODE.MANUAL);
                    }

                    const currentModel =
                        savedBatch.models?.[
                            savedBatch.currentIndex
                        ];

                    if (currentModel?.modelSource) {
                        setBatchModelSourceMode(
                            currentModel.modelSource
                        );
                    }
                }

            } catch (err) {
                if (!cancelled) {
                    setError(
                        err.message ||
                        "Unable to restore the saved workflow."
                    );
                }

            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        }

        restoreState();

        return () => {
            cancelled = true;
        };
    }, [activeTabId]);


    // ---------------------------------------------------------
    // DISCOVER MODEL FILES
    // ---------------------------------------------------------

    useEffect(() => {
        if (!Array.isArray(nativeProjectFiles)) {
            setDiscoveredModels([]);
            return;
        }

        const models = discoverDjangoModelFiles(
            nativeProjectFiles
        );

        setDiscoveredModels(models);

        setSelectedModels((previous) =>
            previous.filter((path) => models.includes(path))
        );
    }, [nativeProjectFiles]);


    function handleSelectAllModels() {
        setSelectedModels([...discoveredModels]);
    }


    function handleClearModelSelection() {
        setSelectedModels([]);
    }


    function handleToggleModel(path) {
        setSelectedModels((previous) =>
            previous.includes(path)
                ? previous.filter((item) => item !== path)
                : [...previous, path]
        );
    }


    // ---------------------------------------------------------
    // PROJECT AND DIRECTORY CHANGES
    // ---------------------------------------------------------

    const previousContextRef = useRef({
        projectId: nativeProjectId,
        workingDirectory: nativeWorkingDirectory || "",
    });

    useEffect(() => {
        const previous = previousContextRef.current;

        const projectChanged =
            previous.projectId !== nativeProjectId;

        const directoryChanged =
            previous.workingDirectory !==
            (nativeWorkingDirectory || "");

        if (!projectChanged && !directoryChanged) {
            return;
        }

        previousContextRef.current = {
            projectId: nativeProjectId,
            workingDirectory: nativeWorkingDirectory || "",
        };

        setModelPath("");
        setWorkflow(null);
        setBatch(null);
        setEvents([]);
        setError("");
        setNotice("");
        setSelectedModels([]);

    }, [
        nativeProjectId,
        nativeWorkingDirectory,
    ]);


    // ---------------------------------------------------------
    // DEFAULT MODEL FILE
    // ---------------------------------------------------------

    useEffect(() => {
        if (!nativeProjectFiles?.length || modelPath) {
            return;
        }

        const candidate = nativeProjectFiles.find((path) => {
            const normalized = path.replace(/\\/g, "/");

            return (
                !isInitFilePath(normalized) &&
                normalized.endsWith(".py") &&
                normalized.includes("/models/")
            );
        });

        if (candidate) {
            setModelPath(candidate);
        }
    }, [
        nativeProjectFiles,
        modelPath,
    ]);


    // ---------------------------------------------------------
    // CLEAN UP DESTINATION CONFIRMATION
    // ---------------------------------------------------------

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;

            if (destinationResolverRef.current) {
                destinationResolverRef.current(null);
                destinationResolverRef.current = null;
            }
        };
    }, []);


    // ---------------------------------------------------------
    // STOP WHEN PROJECT CONTEXT CHANGES
    // ---------------------------------------------------------

    useEffect(() => {
        const execution = executionContextRef.current;

        if (!execution) return;

        const contextChanged =
            execution.tabId !== activeTabId ||
            execution.projectId !== nativeProjectId ||
            execution.workingDirectory !==
                (nativeWorkingDirectory || "");

        if (!contextChanged) return;

        stopRequestedRef.current = true;
        setIsStopping(true);

        if (destinationResolverRef.current) {
            destinationResolverRef.current(null);
            destinationResolverRef.current = null;
        }

        setDestinationDialog(null);

    }, [
        activeTabId,
        nativeProjectId,
        nativeWorkingDirectory,
    ]);


    // ---------------------------------------------------------
    // WORKFLOW PROGRESS
    // ---------------------------------------------------------

    const progress = workflow
        ? getWorkflowProgress(workflow)
        : {
            total: DJANGO_MODEL_WORKFLOW.tasks.length,
            completed: 0,
            remaining: DJANGO_MODEL_WORKFLOW.tasks.length,
            percentage: 0,
        };

    const failedTask = workflow?.tasks?.find(
        (task) => task.status === WORKFLOW_TASK_STATUS.FAILED
    );

    const projectMatchesWorkflow = Boolean(
        workflow &&
        nativeProjectId &&
        workflow.project?.id === nativeProjectId &&
        (workflow.input?.workingDirectory || "") ===
            (nativeWorkingDirectory || "")
    );

    const canStartNewWorkflow =
        !workflow ||
        workflow.status === "completed" ||
        !projectMatchesWorkflow;


    // ---------------------------------------------------------
    // BATCH PROGRESS
    // ---------------------------------------------------------

    const batchProgress = batch
        ? getBatchProgress(batch)
        : {
            total: 0,
            completed: 0,
            skipped: 0,
            failed: 0,
            running: 0,
            pending: 0,
            percentage: 0,
        };


    // ---------------------------------------------------------
    // DESTINATION CONFIRMATION
    // ---------------------------------------------------------

    function requestDestinationConfirmation({
        taskId,
        destinations,
    }) {
        if (destinationResolverRef.current) {
            destinationResolverRef.current(null);
            destinationResolverRef.current = null;
        }

        const entries = getDestinationEntries(
            destinations,
            taskId
        );

        if (!entries.length) {
            return Promise.resolve(null);
        }

        return new Promise((resolve) => {
            destinationResolverRef.current = resolve;

            setDestinationDialog({
                taskId,
                entries,
            });
        });
    }


    function handleDestinationPathChange(key, path) {
        setDestinationDialog((previous) => {
            if (!previous) return previous;

            return {
                ...previous,
                entries: previous.entries.map((entry) =>
                    entry.key === key
                        ? { ...entry, path }
                        : entry
                ),
            };
        });
    }


async function handleConfirmDestinations() {
    if (!destinationDialog) return;

    const result = {};

    for (const entry of destinationDialog.entries) {
        if (!entry.path.trim()) {
            setError(`Enter a destination for ${entry.name}.`);
            return;
        }

        if (isInitFilePath(entry.path)) {
            setError(
                `The destination "${entry.path}" is not allowed. PromptFlow does not generate __init__.py files.`
            );
            return;
        }

        result[entry.key] = {
            path: entry.path.trim(),
            confirmed: true,
        };
    }

    if (destinationDialog.requestId) {
        try {
            const response = await browser.runtime.sendMessage({
                type: "PROMPTFLOW_BACKGROUND_DESTINATION_CONFIRMATION_RESULT",
                requestId: destinationDialog.requestId,
                confirmation: result,
            });

            if (!response?.success) {
                throw new Error(
                    response?.error || "Unable to confirm destinations."
                );
            }
        } catch (err) {
            setError(err.message);
            return;
        }
    } else {
        const resolve = destinationResolverRef.current;
        destinationResolverRef.current = null;
        resolve?.(result);
    }

    setDestinationDialog(null);
    setError("");
}


async function handleCancelDestinations() {
    if (!destinationDialog) return;

    if (destinationDialog.requestId) {
        try {
            await browser.runtime.sendMessage({
                type: "PROMPTFLOW_BACKGROUND_DESTINATION_CONFIRMATION_RESULT",
                requestId: destinationDialog.requestId,
                confirmation: null,
            });
        } catch (err) {
            setError(err.message);
        }
    } else {
        const resolve = destinationResolverRef.current;
        destinationResolverRef.current = null;
        resolve?.(null);
    }

    setDestinationDialog(null);
}


    // ---------------------------------------------------------
    // RUN ONE WORKFLOW
    // ---------------------------------------------------------

    async function runWorkflowController({
        initialWorkflow,
        runTabId,
        runProjectId,
        runWorkingDirectory,
        preparationMode,
        onWorkflowChange,
        preserveExecutionContext = false,
    }) {
        const controller = createWorkflowExecutionController({
            definition: DJANGO_MODEL_WORKFLOW,

            readFile: async (path) => (
                readNativeProjectFile(
                    runProjectId,
                    path,
                    runWorkingDirectory
                )
            ),

            writeFile: async (path, content) => (
                writeNativeProjectFile(
                    runProjectId,
                    path,
                    content,
                    runWorkingDirectory
                )
            ),

            listFiles: async () => (
                getNativeProjectFiles(
                    runProjectId,
                    runWorkingDirectory
                )
            ),

            sendPrompt: async (prompt) => (
                sendPromptToChatGPT(
                    prompt,
                    true,
                    true,
                    600000,
                    runTabId
                )
            ),

            confirmDestinations: async (confirmation) => {
                const contextIsCurrent =
                    mountedRef.current &&
                    activeTabIdRef.current === runTabId &&
                    nativeProjectIdRef.current === runProjectId &&
                    nativeWorkingDirectoryRef.current ===
                        runWorkingDirectory &&
                    !stopRequestedRef.current;

                if (!contextIsCurrent) {
                    return null;
                }

                return requestDestinationConfirmation(
                    confirmation
                );
            },

            onStateChange: (updatedWorkflow) => {
                if (
                    !mountedRef.current ||
                    activeTabIdRef.current !== runTabId ||
                    nativeProjectIdRef.current !== runProjectId
                ) {
                    return;
                }

                setWorkflow(updatedWorkflow);
                onWorkflowChange?.(updatedWorkflow);
            },

            onEvent: (event) => {
                if (
                    !mountedRef.current ||
                    activeTabIdRef.current !== runTabId ||
                    nativeProjectIdRef.current !== runProjectId
                ) {
                    return;
                }

                setEvents((previous) => [
                    ...previous,
                    event,
                ].slice(-40));
            },

            shouldStop: () => (
                stopRequestedRef.current ||
                activeTabIdRef.current !== runTabId ||
                nativeProjectIdRef.current !== runProjectId ||
                nativeWorkingDirectoryRef.current !==
                    runWorkingDirectory
            ),
        });

        try {
            return await controller.run({
                tabId: runTabId,
                workflow: initialWorkflow,
                sourceModes: {
                    model: preparationMode,
                },
            });

        } finally {
            if (!preserveExecutionContext) {
                const execution = executionContextRef.current;

                if (
                    execution?.tabId === runTabId &&
                    execution?.projectId === runProjectId &&
                    execution?.workingDirectory ===
                        runWorkingDirectory
                ) {
                    executionContextRef.current = null;
                }
            }
        }
    }


    // ---------------------------------------------------------
    // EXECUTE ONE WORKFLOW
    // ---------------------------------------------------------



async function executeWorkflow(initialWorkflow) {
    if (
        isRunning ||
        !nativeProjectId ||
        !initialWorkflow
    ) {
        return null;
    }

    const runTabId = activeTabId;
    const runProjectId = nativeProjectId;
    const runWorkingDirectory =
        nativeWorkingDirectory || "";

    if (
        initialWorkflow.project?.id !== runProjectId ||
        (initialWorkflow.input?.workingDirectory || "") !==
            runWorkingDirectory
    ) {
        setError(
            "The saved workflow belongs to a different project or working directory."
        );
        return null;
    }

    try {
        const {
            readToken,
            writeToken,
        } = await getWorkflowAuthorization();

        if (!readToken || !writeToken) {
            throw new Error(
                "Project authorization is incomplete."
            );
        }

        const response = await browser.runtime.sendMessage({
            type: "PROMPTFLOW_BACKGROUND_WORKFLOW_START",
            workflow: initialWorkflow,
            workflowTabId: runTabId,
            chatTabId: runTabId,
            projectId: runProjectId,
            workingDirectory: runWorkingDirectory,
            readToken,
            writeToken,
            sourceModes: {
                model: sourceMode,
            },
            additionalInstructions: {},
        });

        if (!response?.success || !response.accepted) {
            throw new Error(
                response?.error ||
                "The background workflow could not be started."
            );
        }

        stopRequestedRef.current = false;

        executionContextRef.current = {
            tabId: runTabId,
            projectId: runProjectId,
            workingDirectory: runWorkingDirectory,
        };

        setIsRunning(true);
        setIsStopping(false);
        setError("");
        setNotice(
            "Workflow accepted by the background coordinator. It will continue when you switch tabs."
        );

        return response;

    } catch (err) {
        setIsRunning(false);
        setIsStopping(false);

        setError(
            err.message ||
            "Unable to start the background workflow."
        );

        return null;
    }
}

    // ---------------------------------------------------------
    // SEED AN EXISTING MODEL FOR SINGLE-MODE EXECUTION
    // ---------------------------------------------------------

    async function seedExistingModelWorkflow(
        initialWorkflow,
        path
    ) {
        const response = await readNativeProjectFile(
            nativeProjectId,
            path,
            nativeWorkingDirectory || ""
        );

        const content =
            typeof response === "string"
                ? response
                : response?.content;

        if (
            typeof content !== "string" ||
            !content.trim()
        ) {
            throw new Error(
                `The existing model "${path}" is empty or could not be read.`
            );
        }

        const taskDefinition =
            DJANGO_MODEL_WORKFLOW.tasks.find(
                (task) => task.id === "create_model"
            );

        const outputDefinition =
            taskDefinition?.outputs?.[0];

        if (!outputDefinition) {
            throw new Error(
                'The "create_model" task has no model output definition.'
            );
        }

        let nextWorkflow = startWorkflowTask(
            initialWorkflow,
            "create_model",
            DJANGO_MODEL_WORKFLOW
        );

        nextWorkflow = storeWorkflowOutput(
            nextWorkflow,
            {
                taskId: "create_model",
                outputId: outputDefinition.id,
                content,
            }
        );

        nextWorkflow = validateWorkflowOutput(
            nextWorkflow,
            {
                taskId: "create_model",
                outputId: outputDefinition.id,
            }
        );

        nextWorkflow = assignWorkflowOutputDestination(
            nextWorkflow,
            {
                taskId: "create_model",
                outputId: outputDefinition.id,
                path,
                confirmed: true,
            }
        );

        nextWorkflow = markWorkflowOutputWritten(
            nextWorkflow,
            {
                taskId: "create_model",
                outputId: outputDefinition.id,
            }
        );

        nextWorkflow = completeWorkflowTask(
            nextWorkflow,
            "create_model"
        );

        return nextWorkflow;
    }


    // ---------------------------------------------------------
    // START SINGLE WORKFLOW
    // ---------------------------------------------------------

    async function handleStartWorkflow() {
        if (!nativeProjectId) {
            setError(
                "Connect a registered native project first."
            );
            return;
        }

        if (!modelPath.trim()) {
            setError("Select the model file path.");
            return;
        }

        if (isInitFilePath(modelPath.trim())) {
            setError(
                "__init__.py cannot be selected as a model file."
            );
            return;
        }

        if (!treeText?.trim()) {
            setError("The project file tree is required.");
            return;
        }

        if (workflow && (
            workflow.status === "running" ||
            workflow.status === "ready"
        )) {
            const confirmed = window.confirm(
                "An unfinished workflow already exists. Starting a new workflow will replace its saved state. Files already written will not be deleted. Continue?"
            );

            if (!confirmed) return;
        }

        setError("");
        setNotice("");

        try {
            let newWorkflow = createWorkflowInstance({
                definition: DJANGO_MODEL_WORKFLOW,
                projectId: nativeProjectId,
                projectName: nativeProjectName,
                modelPath: modelPath.trim(),
                projectTree: treeText,
            });

            newWorkflow.input.workingDirectory =
                nativeWorkingDirectory || "";

            if (modelSourceMode === "existing") {
                newWorkflow = await seedExistingModelWorkflow(
                    newWorkflow,
                    modelPath.trim()
                );
            }

            await saveWorkflowState(
                activeTabId,
                newWorkflow
            );

            setWorkflow(newWorkflow);
            setEvents([]);

            setNotice(
                modelSourceMode === "existing"
                    ? "Existing model loaded. Continuing with the remaining workflow tasks."
                    : "New Django model workflow created."
            );

            await executeWorkflow(newWorkflow);

        } catch (err) {
            setError(
                err.message ||
                "Unable to start the Django model workflow."
            );
        }
    }


    // ---------------------------------------------------------
    // RESUME OR RETRY SINGLE WORKFLOW
    // ---------------------------------------------------------

    async function handleResumeWorkflow() {
        if (!workflow) return;

        setError("");
        setNotice("");

        try {
            let nextWorkflow = workflow;

            if (workflow.status === "failed") {
                if (!failedTask) {
                    throw new Error(
                        "The workflow is failed, but no failed task was found."
                    );
                }

                nextWorkflow = retryWorkflowTask(
                    workflow,
                    failedTask.id
                );

                await saveWorkflowState(
                    activeTabId,
                    nextWorkflow
                );

                setWorkflow(nextWorkflow);
            }

            await executeWorkflow(nextWorkflow);

        } catch (err) {
            setError(
                err.message ||
                "Unable to resume the workflow."
            );
        }
    }


    // ---------------------------------------------------------
    // SINGLE WORKFLOW STOP
    // ---------------------------------------------------------

    async function handleStopWorkflow() {
        stopRequestedRef.current = true;
        setIsStopping(true);

        setNotice(
            "Stop requested. PromptFlow will stop the current workflow operation."
        );

        try {
            const response = await browser.runtime.sendMessage({
                type: "PROMPTFLOW_BACKGROUND_WORKFLOW_STOP",
                workflowTabId: activeTabId,
            });

            if (!response?.success) {
                setIsStopping(false);
                setError(
                    response?.error || "Unable to stop the workflow."
                );
            }
        } catch (err) {
            setIsStopping(false);
            setError(err.message);
        }
    }

    // ---------------------------------------------------------
    // RESET SINGLE WORKFLOW
    // ---------------------------------------------------------

    async function handleResetWorkflow() {
        if (isRunning) return;

        const confirmed = window.confirm(
            "Create a new workflow? The current workflow state will be replaced. Files already written will not be deleted."
        );

        if (!confirmed) return;

        try {
            const newWorkflow = createWorkflowInstance({
                definition: DJANGO_MODEL_WORKFLOW,
                projectId: nativeProjectId,
                projectName: nativeProjectName,
                modelPath,
                projectTree: treeText,
            });

            newWorkflow.input.workingDirectory =
                nativeWorkingDirectory || "";

            await saveWorkflowState(
                activeTabId,
                newWorkflow
            );

            setWorkflow(newWorkflow);
            setEvents([]);
            setError("");
            setNotice("Workflow reset successfully.");

        } catch (err) {
            setError(
                err.message ||
                "Unable to reset the workflow."
            );
        }
    }


    // ---------------------------------------------------------
    // CREATE BATCH
    // ---------------------------------------------------------

    async function handleCreateBatch() {
        if (!nativeProjectId) {
            setError(
                "Connect a registered native project first."
            );
            return;
        }

        if (!treeText?.trim()) {
            setError("The project file tree is required.");
            return;
        }

        if (!selectedModels.length) {
            setError(
                "Select at least one model file for the batch."
            );
            return;
        }

        if (batch && [
            BATCH_STATUS.READY,
            BATCH_STATUS.RUNNING,
            BATCH_STATUS.PAUSED,
            BATCH_STATUS.FAILED,
        ].includes(batch.status)) {
            const confirmed = window.confirm(
                "A saved batch already exists for this tab. Creating a new batch will replace its saved batch state. Existing project files will not be deleted. Continue?"
            );

            if (!confirmed) return;
        }

        setError("");
        setNotice("");

        try {
            const newBatch = await createWorkflowBatch({
                tabId: activeTabId,
                projectId: nativeProjectId,
                projectName: nativeProjectName,
                workingDirectory: nativeWorkingDirectory || "",
                projectTree: treeText,

                // Manual/automatic is independent of single/batch UI.
                mode: batchMode,

                // Keep model source separate from source preparation.
                models: selectedModels.map((path) => ({
                    path,
                    modelSource: batchModelSourceMode,
                    sourceMode,
                })),
            });

            setBatch(newBatch);
            setWorkflow(null);
            setEvents([]);

            setExecutionMode("batch");

            setNotice(
                `${newBatch.models.length} model(s) added to the batch.`
            );

        } catch (err) {
            setError(
                err.message ||
                "Unable to create the model batch."
            );
        }
    }


    // ---------------------------------------------------------
    // RUN OR RESUME BATCH
    // ---------------------------------------------------------

    async function executeBatch() {
        if (
            !batch ||
            isRunning ||
            !nativeProjectId
        ) {
            return;
        }

        if (
            batch.project.id !== nativeProjectId ||
            (batch.workingDirectory || "") !==
                (nativeWorkingDirectory || "")
        ) {
            setError(
                "This batch belongs to a different project or working directory."
            );
            return;
        }

        try {
            await ensureWriteAuthorization();

        } catch (err) {
            setError(
                err.message ||
                "Local write authorization is required before running the batch."
            );
            return;
        }

        const runTabId = activeTabId;
        const runProjectId = nativeProjectId;
        const runWorkingDirectory =
            nativeWorkingDirectory || "";

        stopRequestedRef.current = false;

        executionContextRef.current = {
            tabId: runTabId,
            projectId: runProjectId,
            workingDirectory: runWorkingDirectory,
        };

        setIsRunning(true);
        setIsStopping(false);
        setError("");
        setNotice("");
        setEvents([]);

        try {
            const result = await startWorkflowBatch({
                tabId: runTabId,
                batchId: batch.id,

                readFile: async (path) => (
                    readNativeProjectFile(
                        runProjectId,
                        path,
                        runWorkingDirectory
                    )
                ),

                runModel: async ({
                    workflow: modelWorkflow,
                    sourceMode: preparationMode,
                    onWorkflowChange,
                }) => {
                    if (
                        activeTabIdRef.current !== runTabId ||
                        nativeProjectIdRef.current !== runProjectId ||
                        nativeWorkingDirectoryRef.current !==
                            runWorkingDirectory
                    ) {
                        throw new Error(
                            "The active project context changed during batch execution."
                        );
                    }

                    setWorkflow(modelWorkflow);

                    return runWorkflowController({
                        initialWorkflow: modelWorkflow,
                        runTabId,
                        runProjectId,
                        runWorkingDirectory,
                        preparationMode,
                        onWorkflowChange,
                        preserveExecutionContext: true,
                    });
                },

                onBatchChange: (updatedBatch) => {
                    if (
                        mountedRef.current &&
                        activeTabIdRef.current === runTabId
                    ) {
                        setBatch(updatedBatch);
                    }
                },

                onModelChange: (event) => {
                    if (
                        mountedRef.current &&
                        activeTabIdRef.current === runTabId
                    ) {
                        setEvents((previous) => [
                            ...previous,
                            {
                                type: event.type,
                                message: event.model?.path || "",
                                timestamp: new Date().toISOString(),
                            },
                        ].slice(-40));

                        if (event.model?.workflow) {
                            setWorkflow(event.model.workflow);
                        }
                    }
                },
            });

            if (
                !mountedRef.current ||
                activeTabIdRef.current !== runTabId ||
                nativeProjectIdRef.current !== runProjectId
            ) {
                return;
            }

            if (result?.batch) {
                setBatch(result.batch);
            }

            if (
                result?.batch?.status === BATCH_STATUS.COMPLETED
            ) {
                setNotice(
                    "All selected model workflows have been processed."
                );

            } else if (
                result?.batch?.status === BATCH_STATUS.PAUSED
            ) {
                setNotice(
                    result.batch.awaitingNext
                        ? "The model workflow is complete. Start the next model when ready."
                        : "Batch paused. You can resume it at any time."
                );

            } else if (
                result?.batch?.status === BATCH_STATUS.STOPPED
            ) {
                setNotice(
                    "Batch stopped. Completed models and saved progress have been preserved."
                );

            } else if (
                result?.batch?.status === BATCH_STATUS.FAILED
            ) {
                setError(
                    result.error ||
                    "A model workflow failed. Retry or skip that model to continue."
                );
            }

        } catch (err) {
            setError(
                err.message ||
                "Unable to execute the model batch."
            );

        } finally {
            const execution = executionContextRef.current;

            if (
                execution?.tabId === runTabId &&
                execution?.projectId === runProjectId &&
                execution?.workingDirectory === runWorkingDirectory
            ) {
                executionContextRef.current = null;
            }

            if (mountedRef.current) {
                setIsRunning(false);
                setIsStopping(false);
            }
        }
    }


    // ---------------------------------------------------------
    // PAUSE BATCH
    // ---------------------------------------------------------

    async function handlePauseBatch() {
        if (!batch) return;

        try {
            const updated = await pauseWorkflowBatch(
                activeTabId,
                batch.id
            );

            setBatch(updated);

            setNotice(
                "Pause requested. The current model will finish before the batch pauses."
            );

        } catch (err) {
            setError(
                err.message ||
                "Unable to pause the batch."
            );
        }
    }


    // ---------------------------------------------------------
    // STOP BATCH
    // ---------------------------------------------------------

    async function handleStopBatch() {
        if (!batch) return;

        try {
            const updated = await stopWorkflowBatch(
                activeTabId,
                batch.id
            );

            setBatch(updated);

            setNotice(
                "Stop requested. The current model will finish before the batch stops."
            );

        } catch (err) {
            setError(
                err.message ||
                "Unable to stop the batch."
            );
        }
    }


    // ---------------------------------------------------------
    // RETRY FAILED BATCH MODEL
    // ---------------------------------------------------------

    async function handleRetryBatchModel() {
        if (!batch) return;

        try {
            const updated = await retryBatchModel(
                activeTabId,
                batch.id
            );

            setBatch(updated);
            setError("");

            setNotice(
                "Failed model prepared for retry. Start the batch to continue."
            );

        } catch (err) {
            setError(
                err.message ||
                "Unable to retry the failed model."
            );
        }
    }


    // ---------------------------------------------------------
    // SKIP BATCH MODEL
    // ---------------------------------------------------------

    async function handleSkipBatchModel(path) {
        if (!batch) return;

        const confirmed = window.confirm(
            `Skip "${path}" and continue with the remaining models?`
        );

        if (!confirmed) return;

        try {
            const updated = await skipBatchModel(
                activeTabId,
                batch.id,
                path
            );

            setBatch(updated);
            setError("");
            setNotice(`Skipped ${path}.`);

        } catch (err) {
            setError(
                err.message ||
                "Unable to skip this model."
            );
        }
    }


    // ---------------------------------------------------------
    // RENDER
    // ---------------------------------------------------------

    const canConfigureBatch =
        !isRunning &&
        (
            !batch ||
            [
                BATCH_STATUS.COMPLETED,
                BATCH_STATUS.STOPPED,
            ].includes(batch.status)
        );

    return (
        <section className="rounded-xl border border-indigo-200 bg-white p-4">

            <div className="mb-3 flex items-center justify-between gap-2">

                <div className="flex items-center gap-2">
                    <FolderTree
                        size={18}
                        className="text-indigo-600"
                    />

                    <h2 className="font-semibold">
                        Django Model Workflow
                    </h2>
                </div>

                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    isRunning
                        ? "bg-indigo-100 text-indigo-700"
                        : batch
                            ? "bg-slate-100 text-slate-700"
                            : workflow?.status === "completed"
                                ? "bg-green-100 text-green-700"
                                : workflow?.status === "failed"
                                    ? "bg-red-100 text-red-700"
                                    : "bg-slate-100 text-slate-600"
                }`}>
                    {batch
                        ? getBatchStatusLabel(batch)
                        : getWorkflowStatusLabel(workflow)}
                </span>

            </div>

            <p className="mb-4 text-xs leading-relaxed text-slate-500">
                Generate Django models, factories, tests, selectors,
                and services. Run one model at a time or process
                multiple discovered models sequentially.
            </p>

            {!nativeProjectId ? (

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    Connect a registered project through Native
                    Companion before starting a workflow.
                </div>

            ) : (

                <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3">

                    <p className="text-sm font-semibold text-green-800">
                        {nativeProjectName}
                    </p>

                    <p className="mt-1 text-xs text-green-700">
                        {nativeProjectFiles?.length || 0} project files available.
                    </p>

                    {nativeWorkingDirectory && (
                        <p className="mt-1 break-all text-xs text-green-700">
                            Directory: {nativeWorkingDirectory}
                        </p>
                    )}

                </div>
            )}


            {/* EXECUTION MODE */}

            <div className="mb-4">

                <label className="mb-2 block text-xs font-semibold">
                    Execution mode
                </label>

                <div className="grid grid-cols-2 gap-2">

                    <button
                        type="button"
                        onClick={() => setExecutionMode("single")}
                        disabled={isRunning}
                        className={`rounded-lg border px-3 py-3 text-xs font-semibold ${
                            executionMode === "single"
                                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                : "border-slate-200 text-slate-600"
                        }`}
                    >
                        Single model
                    </button>

                    <button
                        type="button"
                        onClick={() => setExecutionMode("batch")}
                        disabled={isRunning}
                        className={`rounded-lg border px-3 py-3 text-xs font-semibold ${
                            executionMode === "batch"
                                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                : "border-slate-200 text-slate-600"
                        }`}
                    >
                        Multiple models
                    </button>

                </div>

            </div>


            {/* SOURCE PREPARATION */}

            <div className="mb-4">

                <label className="mb-1 block text-xs font-semibold">
                    Model source preparation
                </label>

                <select
                    value={sourceMode}
                    onChange={(event) =>
                        setSourceMode(event.target.value)
                    }
                    disabled={isRunning}
                    className="w-full rounded-lg border p-3 text-xs outline-none focus:border-indigo-500 disabled:bg-slate-50"
                >
                    {SOURCE_PREPARATION_MODES.map((mode) => (
                        <option
                            key={mode.value}
                            value={mode.value}
                        >
                            {mode.label}
                        </option>
                    ))}
                </select>

                <p className="mt-1 text-xs text-slate-500">
                    Controls how source code is prepared before it is
                    included in prompts. Original project files are
                    never modified by source preparation.
                </p>

            </div>


            {/* SINGLE MODEL INTERFACE */}

            {executionMode === "single" && (

                <>
                    <div className="mb-3">

                        <label className="mb-1 block text-xs font-semibold">
                            Model source
                        </label>

                        <select
                            value={modelSourceMode}
                            onChange={(event) =>
                                setModelSourceMode(event.target.value)
                            }
                            disabled={isRunning}
                            className="w-full rounded-lg border p-3 text-xs outline-none focus:border-indigo-500 disabled:bg-slate-50"
                        >
                            {MODEL_SOURCE_MODES.map((mode) => (
                                <option
                                    key={mode.value}
                                    value={mode.value}
                                >
                                    {mode.label}
                                </option>
                            ))}
                        </select>

                        <p className="mt-1 text-xs text-slate-500">
                            Existing mode reads the model file and
                            continues with the factory, tests,
                            selector and service tasks without
                            regenerating the model.
                        </p>

                    </div>

                    <div className="mb-4">

                        <label className="mb-1 block text-xs font-semibold">
                            Django model path
                        </label>

                        <input
                            type="text"
                            list="promptflow-model-paths"
                            value={modelPath}
                            onChange={(event) =>
                                setModelPath(event.target.value)
                            }
                            disabled={
                                isRunning ||
                                Boolean(
                                    workflow &&
                                    projectMatchesWorkflow &&
                                    !["completed", "failed"].includes(
                                        workflow.status
                                    )
                                )
                            }
                            placeholder="core/finance/payments/models/payment.py"
                            className="w-full rounded-lg border p-3 font-mono text-xs outline-none focus:border-indigo-500 disabled:bg-slate-50"
                        />

                        <datalist id="promptflow-model-paths">
                            {(nativeProjectFiles || [])
                                .filter((path) =>
                                    !isInitFilePath(path) &&
                                    path.endsWith(".py") &&
                                    path.replace(/\\/g, "/")
                                        .split("/")
                                        .includes("models")
                                )
                                .map((path) => (
                                    <option
                                        key={path}
                                        value={path}
                                    />
                                ))}
                        </datalist>

                    </div>

                    {workflow && (
                        <div className="mb-4 rounded-lg border p-3">

                            <div className="mb-2 flex justify-between text-xs">
                                <span className="font-semibold">
                                    Workflow progress
                                </span>

                                <span className="font-semibold text-indigo-600">
                                    {progress.percentage}%
                                </span>
                            </div>

                            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                <div
                                    className="h-full rounded-full bg-indigo-600 transition-all"
                                    style={{
                                        width: `${progress.percentage}%`,
                                    }}
                                />
                            </div>

                            <div className="mt-2 flex justify-between text-xs text-slate-500">
                                <span>Completed: {progress.completed}</span>
                                <span>Remaining: {progress.remaining}</span>
                            </div>

                        </div>
                    )}

                    {workflow && (
                        <div className="mb-4 space-y-2">

                            {DJANGO_MODEL_WORKFLOW.tasks.map((definition) => {
                                const task = workflow.tasks?.find(
                                    (item) => item.id === definition.id
                                );

                                const status = task?.status || "pending";

                                const completed =
                                    status === WORKFLOW_TASK_STATUS.COMPLETED;

                                const failed =
                                    status === WORKFLOW_TASK_STATUS.FAILED;

                                const running =
                                    status === WORKFLOW_TASK_STATUS.RUNNING;

                                return (
                                    <div
                                        key={definition.id}
                                        className={`rounded-lg border p-3 ${
                                            completed
                                                ? "border-green-200 bg-green-50"
                                                : failed
                                                    ? "border-red-200 bg-red-50"
                                                    : running
                                                        ? "border-indigo-200 bg-indigo-50"
                                                        : "border-slate-200"
                                        }`}
                                    >

                                        <div className="flex items-center gap-2">

                                            {completed ? (
                                                <CheckCircle2
                                                    size={16}
                                                    className="text-green-600"
                                                />
                                            ) : failed ? (
                                                <AlertCircle
                                                    size={16}
                                                    className="text-red-600"
                                                />
                                            ) : running ? (
                                                <Clock
                                                    size={16}
                                                    className="animate-pulse text-indigo-600"
                                                />
                                            ) : (
                                                <Circle
                                                    size={16}
                                                    className="text-slate-400"
                                                />
                                            )}

                                            <span className="min-w-0 flex-1 text-xs font-semibold">
                                                {definition.order}. {definition.name}
                                            </span>

                                            <span className="text-xs capitalize text-slate-500">
                                                {status.replace(/_/g, " ")}
                                            </span>

                                        </div>

                                        {task?.outputs?.map((output) => (
                                            <div
                                                key={output.id}
                                                className="mt-2 break-all pl-6 text-xs text-slate-500"
                                            >
                                                {output.name}:{" "}
                                                {output.destination?.path ||
                                                    "Destination pending"}
                                                {" · "}
                                                {output.status.replace(/_/g, " ")}
                                            </div>
                                        ))}

                                        {task?.error && (
                                            <p className="mt-2 pl-6 text-xs text-red-700">
                                                {task.error}
                                            </p>
                                        )}

                                    </div>
                                );
                            })}

                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">

                        {canStartNewWorkflow ? (

                            <button
                                onClick={handleStartWorkflow}
                                disabled={
                                    isLoading ||
                                    isRunning ||
                                    !nativeProjectId ||
                                    !modelPath.trim() ||
                                    !treeText?.trim() ||
                                    isInitFilePath(modelPath.trim())
                                }
                                className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                                <Play size={16} />
                                {workflow
                                    ? "Start New Workflow"
                                    : "Start Django Workflow"}
                            </button>

                        ) : workflow.status === "failed" ? (

                            <button
                                onClick={handleResumeWorkflow}
                                disabled={isRunning || !projectMatchesWorkflow}
                                className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-3 py-3 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                            >
                                <RotateCcw size={16} />
                                Retry Failed Task
                            </button>

                        ) : (

                            <button
                                onClick={handleResumeWorkflow}
                                disabled={isRunning || !projectMatchesWorkflow}
                                className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                                <Play size={15} />
                                Resume Workflow
                            </button>

                        )}

                        {isRunning && (
                            <button
                                onClick={handleStopWorkflow}
                                disabled={isStopping}
                                className="flex items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-3 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                                <Square size={14} />
                                {isStopping ? "Stopping..." : "Stop"}
                            </button>
                        )}

                        {workflow && !isRunning && (
                            <button
                                onClick={handleResetWorkflow}
                                className="col-span-2 flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50"
                            >
                                <RotateCcw size={14} />
                                Create New Workflow
                            </button>
                        )}

                    </div>
                </>
            )}


            {/* BATCH INTERFACE */}

            {executionMode === "batch" && (

                <div className="space-y-4">

                    {/* DISCOVERY */}

                    <div className="rounded-lg border p-3">

                        <div className="mb-2 flex items-center justify-between gap-2">

                            <h3 className="text-xs font-semibold">
                                Discovered Django models
                            </h3>

                            <span className="text-xs text-slate-500">
                                {discoveredModels.length} found
                            </span>

                        </div>

                        <p className="mb-3 text-xs text-slate-500">
                            PromptFlow searches Python files below
                            every directory named <code>models</code>.
                            All <code>__init__.py</code> files are excluded.
                        </p>

                        <div className="mb-3 flex gap-2">

                            <button
                                type="button"
                                onClick={handleSelectAllModels}
                                disabled={isRunning || !discoveredModels.length}
                                className="rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            >
                                Select all
                            </button>

                            <button
                                type="button"
                                onClick={handleClearModelSelection}
                                disabled={isRunning || !selectedModels.length}
                                className="rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            >
                                Clear selection
                            </button>

                            <span className="ml-auto self-center text-xs text-indigo-600">
                                {selectedModels.length} selected
                            </span>

                        </div>

                        {discoveredModels.length ? (

                            <div className="max-h-64 space-y-1 overflow-y-auto">

                                {discoveredModels.map((path) => {
                                    const selected =
                                        selectedModels.includes(path);

                                    return (
                                        <label
                                            key={path}
                                            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 ${
                                                selected
                                                    ? "border-indigo-300 bg-indigo-50"
                                                    : "border-transparent hover:bg-slate-50"
                                            }`}
                                        >

                                            <input
                                                type="checkbox"
                                                checked={selected}
                                                disabled={isRunning}
                                                onChange={() =>
                                                    handleToggleModel(path)
                                                }
                                                className="mt-0.5"
                                            />

                                            <span className="break-all font-mono text-xs text-slate-700">
                                                {path}
                                            </span>

                                        </label>
                                    );
                                })}

                            </div>

                        ) : (

                            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                                No Django model files were found in
                                the current project directory.
                            </p>

                        )}

                    </div>


                    {/* BATCH OPTIONS */}

                    <div className="rounded-lg border p-3">

                        <h3 className="mb-3 text-xs font-semibold">
                            Batch configuration
                        </h3>

                        <div className="mb-3">

                            <label className="mb-1 block text-xs font-medium">
                                Execution behavior
                            </label>

                            <select
                                value={batchMode}
                                onChange={(event) =>
                                    setBatchMode(event.target.value)
                                }
                                disabled={!canConfigureBatch}
                                className="w-full rounded-lg border p-3 text-xs disabled:bg-slate-50"
                            >
                                <option value={BATCH_MODE.MANUAL}>
                                    Manual — stop after each model
                                </option>

                                <option value={BATCH_MODE.AUTOMATIC}>
                                    Automatic — continue through all models
                                </option>
                            </select>

                        </div>

                        <div>

                            <label className="mb-1 block text-xs font-medium">
                                Selected model source
                            </label>

                            <select
                                value={batchModelSourceMode}
                                onChange={(event) =>
                                    setBatchModelSourceMode(
                                        event.target.value
                                    )
                                }
                                disabled={!canConfigureBatch}
                                className="w-full rounded-lg border p-3 text-xs disabled:bg-slate-50"
                            >
                                <option value="existing">
                                    Continue from existing models
                                </option>

                                <option value="create">
                                    Create models from scratch
                                </option>
                            </select>

                            <p className="mt-1 text-xs text-slate-500">
                                Existing mode reads each selected model
                                and skips its model-generation task.
                            </p>

                        </div>

                        {!batch || [
                            BATCH_STATUS.COMPLETED,
                            BATCH_STATUS.STOPPED,
                        ].includes(batch.status) ? (

                            <button
                                type="button"
                                onClick={handleCreateBatch}
                                disabled={
                                    isRunning ||
                                    !selectedModels.length ||
                                    !nativeProjectId ||
                                    !treeText?.trim()
                                }
                                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                                <Save size={16} />
                                Create Batch
                            </button>

                        ) : null}

                    </div>


                    {/* BATCH PROGRESS */}

                    {batch && (

                        <div className="rounded-lg border p-3">

                            <div className="mb-2 flex items-center justify-between">

                                <h3 className="text-xs font-semibold">
                                    Batch progress
                                </h3>

                                <span className="text-xs font-semibold text-indigo-600">
                                    {batchProgress.percentage}%
                                </span>

                            </div>

                            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                                <div
                                    className="h-full rounded-full bg-indigo-600 transition-all"
                                    style={{
                                        width: `${batchProgress.percentage}%`,
                                    }}
                                />
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">

                                <div className="rounded-lg bg-green-50 p-2 text-green-700">
                                    Completed: {batchProgress.completed}
                                </div>

                                <div className="rounded-lg bg-red-50 p-2 text-red-700">
                                    Failed: {batchProgress.failed}
                                </div>

                                <div className="rounded-lg bg-indigo-50 p-2 text-indigo-700">
                                    Running: {batchProgress.running}
                                </div>

                                <div className="rounded-lg bg-slate-50 p-2 text-slate-600">
                                    Pending: {batchProgress.pending}
                                </div>

                                <div className="rounded-lg bg-slate-50 p-2 text-slate-600">
                                    Skipped: {batchProgress.skipped}
                                </div>

                                <div className="rounded-lg bg-slate-50 p-2 text-slate-600">
                                    Total: {batchProgress.total}
                                </div>

                            </div>

                        </div>
                    )}


                    {/* BATCH MODEL STATUS */}

                    {batch && (

                        <div className="rounded-lg border p-3">

                            <h3 className="mb-3 text-xs font-semibold">
                                Model execution list
                            </h3>

                            <div className="space-y-2">

                                {batch.models.map((model, index) => (

                                    <div
                                        key={model.path}
                                        className="rounded-lg border p-3"
                                    >

                                        <div className="flex items-start gap-2">

                                            <span className="mt-0.5 text-xs text-slate-400">
                                                {index + 1}.
                                            </span>

                                            <div className="min-w-0 flex-1">

                                                <p className="break-all font-mono text-xs">
                                                    {model.path}
                                                </p>

                                                <div className="mt-2 flex flex-wrap items-center gap-2">

                                                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${getModelStatusClass(model.status)}`}>
                                                        {getModelStatusLabel(model.status)}
                                                    </span>

                                                    <span className="text-xs text-slate-400">
                                                        {model.modelSource === "existing"
                                                            ? "Existing model"
                                                            : "New model"}
                                                    </span>

                                                </div>

                                                {model.error && (
                                                    <p className="mt-2 break-words text-xs text-red-700">
                                                        {model.error}
                                                    </p>
                                                )}

                                                {model.status === BATCH_MODEL_STATUS.FAILED &&
                                                    !isRunning && (
                                                        <button
                                                            type="button"
                                                            onClick={handleRetryBatchModel}
                                                            className="mt-2 rounded-lg border border-amber-200 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50"
                                                        >
                                                            Retry failed model
                                                        </button>
                                                    )}

                                                {[
                                                    BATCH_MODEL_STATUS.PENDING,
                                                    BATCH_MODEL_STATUS.FAILED,
                                                ].includes(model.status) &&
                                                    !isRunning && (
                                                        <button
                                                            type="button"
                                                            onClick={() =>
                                                                handleSkipBatchModel(model.path)
                                                            }
                                                            className="ml-2 mt-2 rounded-lg border px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                                                        >
                                                            Skip
                                                        </button>
                                                    )}

                                            </div>

                                        </div>

                                    </div>

                                ))}

                            </div>

                        </div>
                    )}


                    {/* BATCH CONTROLS */}

                    {batch && (

                        <div className="grid grid-cols-2 gap-2">

                            {batch.status === BATCH_STATUS.RUNNING ? (

                                <>
                                    <button
                                        type="button"
                                        onClick={handlePauseBatch}
                                        className="flex items-center justify-center gap-2 rounded-lg border border-amber-200 px-3 py-3 text-xs font-semibold text-amber-700 hover:bg-amber-50"
                                    >
                                        <Clock size={15} />
                                        Pause after model
                                    </button>

                                    <button
                                        type="button"
                                        onClick={handleStopBatch}
                                        className="flex items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-3 text-xs font-semibold text-red-600 hover:bg-red-50"
                                    >
                                        <Square size={14} />
                                        Stop after model
                                    </button>
                                </>

                            ) : batch.status === BATCH_STATUS.FAILED ? (

                                <button
                                    type="button"
                                    onClick={handleRetryBatchModel}
                                    className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-3 py-3 text-xs font-semibold text-white hover:bg-amber-700"
                                >
                                    <RotateCcw size={15} />
                                    Prepare Failed Model for Retry
                                </button>

                            ) : batch.status !== BATCH_STATUS.COMPLETED &&
                                batch.status !== BATCH_STATUS.STOPPED ? (

                                <button
                                    type="button"
                                    onClick={executeBatch}
                                    disabled={isRunning}
                                    className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    <Play size={16} />
                                    {batch.awaitingNext
                                        ? "Start Next Model"
                                        : batch.status === BATCH_STATUS.PAUSED
                                            ? "Resume Batch"
                                            : "Start Batch"}
                                </button>

                            ) : null}

                            {batch.status === BATCH_STATUS.COMPLETED && (
                                <p className="col-span-2 rounded-lg bg-green-50 p-3 text-center text-xs font-semibold text-green-700">
                                    All selected models have been processed.
                                </p>
                            )}

                            {batch.status === BATCH_STATUS.STOPPED && (
                                <p className="col-span-2 rounded-lg bg-slate-50 p-3 text-center text-xs text-slate-600">
                                    This batch was stopped. Create a new batch to process another selection.
                                </p>
                            )}

                        </div>
                    )}

                </div>
            )}


            {/* ERRORS AND NOTICES */}

            {error && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">

                    <AlertCircle
                        size={15}
                        className="mt-0.5 shrink-0"
                    />

                    <span className="break-words">
                        {error}
                    </span>

                </div>
            )}

            {notice && (
                <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-xs text-green-700">
                    {notice}
                </div>
            )}


            {/* EXECUTION EVENTS */}

            {events.length > 0 && (

                <div className="mt-4 border-t pt-3">

                    <h3 className="mb-2 text-xs font-semibold">
                        Execution Activity
                    </h3>

                    <div className="max-h-48 space-y-2 overflow-y-auto">

                        {events.slice().reverse().map((event, index) => (
                            <div
                                key={`${event.timestamp || ""}-${index}`}
                                className="break-words text-xs text-slate-500"
                            >
                                <span className="font-semibold text-slate-700">
                                    {event.type || "Event"}
                                </span>

                                {event.message
                                    ? ` — ${event.message}`
                                    : ""}

                                {event.taskId
                                    ? ` (${event.taskId})`
                                    : ""}
                            </div>
                        ))}

                    </div>

                </div>
            )}


            {/* DESTINATION CONFIRMATION */}

            {destinationDialog && (

                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">

                    <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-xl">

                        <div className="mb-3 flex items-center gap-2">

                            <Save
                                size={19}
                                className="text-indigo-600"
                            />

                            <h3 className="font-semibold">
                                Confirm Output Destinations
                            </h3>

                        </div>

                        <p className="mb-4 text-xs leading-relaxed text-slate-500">
                            Review the suggested project-relative paths.
                            Existing files are not silently overwritten.
                        </p>

                        <div className="space-y-3">

                            {destinationDialog.entries.map((entry) => (

                                <div key={entry.key}>

                                    <label className="mb-1 block text-xs font-semibold">
                                        {entry.name}
                                    </label>

                                    <input
                                        type="text"
                                        value={entry.path}
                                        onChange={(event) =>
                                            handleDestinationPathChange(
                                                entry.key,
                                                event.target.value
                                            )
                                        }
                                        className="w-full rounded-lg border p-3 font-mono text-xs outline-none focus:border-indigo-500"
                                        placeholder="relative/path/to/file.py"
                                    />

                                </div>
                            ))}

                        </div>

                        <div className="mt-5 grid grid-cols-2 gap-2">

                            <button
                                onClick={handleCancelDestinations}
                                className="rounded-lg border px-3 py-3 text-xs font-medium hover:bg-slate-50"
                            >
                                Cancel
                            </button>

                            <button
                                onClick={handleConfirmDestinations}
                                className="rounded-lg bg-indigo-600 px-3 py-3 text-xs font-semibold text-white hover:bg-indigo-700"
                            >
                                Confirm Destinations
                            </button>

                        </div>

                    </div>

                </div>
            )}

        </section>
    );
}