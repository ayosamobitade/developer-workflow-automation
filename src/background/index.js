import { createWorkflowExecutionController } from "../features/workflows/services/workflowExecutionService";
import { DJANGO_MODEL_WORKFLOW } from "../features/workflows/definitions/django-model-workflow";
import {
    extractDependencyRequest,
    buildDependencyFilePrompt,
    extractDependencyFile,
    buildPromptWithDependencySources,
    normalizeDependencyPath,
} from "../features/workflows/services/dependencyResolutionService";
import {
    startWorkflowBatch,
    pauseWorkflowBatch,
    stopWorkflowBatch,
} from "../features/workflows/services/batchWorkflowService";

const NATIVE_HOST = "com.samworld.promptflow";
const NATIVE_MESSAGE_TYPE = "PROMPTFLOW_NATIVE";

const MESSAGE_TYPES = {
    START: "PROMPTFLOW_BACKGROUND_WORKFLOW_START",
    STOP: "PROMPTFLOW_BACKGROUND_WORKFLOW_STOP",
    STATUS: "PROMPTFLOW_BACKGROUND_WORKFLOW_STATUS",
    CONFIRM_DESTINATIONS: "PROMPTFLOW_BACKGROUND_DESTINATION_CONFIRMATION",
    CONFIRM_DESTINATIONS_RESULT:
        "PROMPTFLOW_BACKGROUND_DESTINATION_CONFIRMATION_RESULT",
    EVENT: "PROMPTFLOW_BACKGROUND_WORKFLOW_EVENT",
    START_BATCH: "PROMPTFLOW_BACKGROUND_BATCH_START",
    PAUSE_BATCH: "PROMPTFLOW_BACKGROUND_BATCH_PAUSE",
    STOP_BATCH: "PROMPTFLOW_BACKGROUND_BATCH_STOP",
    GET_PENDING_CONFIRMATIONS: "PROMPTFLOW_BACKGROUND_PENDING_CONFIRMATIONS",
};

const extensionBaseURL = browser.runtime.getURL("");

const activeRuns = new Map();
const pendingConfirmations = new Map();

function isExtensionMessage(sender) {
    return Boolean(
        sender?.url &&
        sender.url.startsWith(extensionBaseURL)
    );
}

async function broadcast(type, payload = {}) {
    try {
        await browser.runtime.sendMessage({
            type,
            ...payload,
        });
    } catch {
        // The panel may be closed. Execution must not depend on it.
    }
}

async function sendNativeRequest(request) {
    const response = await browser.runtime.sendNativeMessage(
        NATIVE_HOST,
        request
    );

    if (!response) {
        throw new Error("The native host returned an empty response.");
    }

    if (!response.ok) {
        throw new Error(
            response.error || "Native messaging request failed."
        );
    }

    return response;
}

async function readProjectFile({
    projectId,
    workingDirectory,
    readToken,
    path,
}) {
    return sendNativeRequest({
        action: "read_file",
        project_id: projectId,
        directory: workingDirectory,
        path,
        token: readToken,
    });
}

async function writeProjectFile({
    projectId,
    workingDirectory,
    writeToken,
    path,
    content,
}) {
    return sendNativeRequest({
        action: "write_file",
        project_id: projectId,
        directory: workingDirectory,
        path,
        content,
        token: writeToken,
    });
}

async function listProjectFiles({
    projectId,
    workingDirectory,
    readToken,
}) {
    const response = await sendNativeRequest({
        action: "list_files",
        project_id: projectId,
        directory: workingDirectory,
        token: readToken,
    });

    return response.files || [];
}

async function sendPromptToChatGPT(chatTabId, prompt) {
    if (!Number.isInteger(chatTabId)) {
        throw new Error("A valid ChatGPT tab ID is required.");
    }

    const tab = await browser.tabs.get(chatTabId);

    const isChatGPT =
        tab.url?.startsWith("https://chatgpt.com/") ||
        tab.url?.startsWith("https://chat.openai.com/");

    if (!isChatGPT) {
        throw new Error(
            "The workflow's ChatGPT tab is no longer a ChatGPT tab."
        );
    }

    const response = await browser.tabs.sendMessage(
        chatTabId,
        {
            type: "PROMPTFLOW_INSERT_AND_WAIT",
            prompt,
            timeout: 600000,
        }
    );

    if (!response?.success) {
        throw new Error(
            response?.error || "Unable to complete the ChatGPT request."
        );
    }

    if (typeof response.response?.text !== "string") {
        throw new Error(
            "ChatGPT completed, but PromptFlow did not receive a valid response."
        );
    }

    return response;
}

async function sendPromptWithDependencyResolution({
    chatTabId,
    prompt,
    projectId,
    workingDirectory,
    readToken,
    writeToken,
    workflowTabId,
    runId,
}) {
    const originalPrompt = prompt;
    const dependencies = [];
    const resolvedPaths = new Set();
    const maxDependencies = 5;

    for (let attempt = 0; attempt <= maxDependencies; attempt += 1) {
        const currentPrompt = dependencies.length
            ? buildPromptWithDependencySources(originalPrompt, dependencies)
            : originalPrompt;

        const response = await sendPromptToChatGPT(chatTabId, currentPrompt);
        const request = extractDependencyRequest(response.response.text);

        if (!request) {
            return response;
        }

        if (resolvedPaths.has(request.path)) {
            throw new Error(
                `ChatGPT repeatedly requested the same dependency "${request.path}" after it was supplied.`
            );
        }

        if (dependencies.length >= maxDependencies) {
            throw new Error("The task requested too many additional dependency files.");
        }

        const dependencyPath = normalizeDependencyPath(request.path);
        const files = await listProjectFiles({
            projectId,
            workingDirectory,
            readToken,
        });

        const exists = files.some((file) => {
            const path = typeof file === "string" ? file : file?.path;
            return path?.replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "") === dependencyPath;
        });

        let content = "";

        if (exists) {
            const existing = await readProjectFile({
                projectId,
                workingDirectory,
                readToken,
                path: dependencyPath,
            });

            if (typeof existing.content !== "string") {
                throw new Error(
                    `PromptFlow could not read requested dependency "${dependencyPath}".`
                );
            }

            content = existing.content;
        }

        if (!content.trim()) {
            void broadcast(MESSAGE_TYPES.EVENT, {
                event: "dependency_generation_started",
                runId,
                workflowTabId,
                path: dependencyPath,
                reason: request.reason,
            });

            const generatedResponse = await sendPromptToChatGPT(
                chatTabId,
                buildDependencyFilePrompt(request)
            );
            const generatedContent = extractDependencyFile(
                generatedResponse.response.text
            );

            // Recheck immediately before writing. Never replace a non-empty
            // file that appeared while ChatGPT was generating the dependency.
            const refreshedFiles = await listProjectFiles({
                projectId,
                workingDirectory,
                readToken,
            });
            const appeared = refreshedFiles.some((file) => {
                const path = typeof file === "string" ? file : file?.path;
                return path?.replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "") === dependencyPath;
            });

            if (appeared) {
                const current = await readProjectFile({
                    projectId,
                    workingDirectory,
                    readToken,
                    path: dependencyPath,
                });

                if (typeof current.content !== "string") {
                    throw new Error(
                        `PromptFlow could not verify dependency "${dependencyPath}" before writing.`
                    );
                }

                if (current.content.trim()) {
                    content = current.content;
                } else {
                    await writeProjectFile({
                        projectId,
                        workingDirectory,
                        writeToken,
                        path: dependencyPath,
                        content: generatedContent,
                    });
                    content = generatedContent;
                }
            } else {
                await writeProjectFile({
                    projectId,
                    workingDirectory,
                    writeToken,
                    path: dependencyPath,
                    content: generatedContent,
                });
                content = generatedContent;
            }

            const verified = await readProjectFile({
                projectId,
                workingDirectory,
                readToken,
                path: dependencyPath,
            });

            if (
                typeof verified.content !== "string" ||
                !verified.content.trim()
            ) {
                throw new Error(
                    `PromptFlow saved dependency "${dependencyPath}" but could not verify its contents.`
                );
            }

            content = verified.content;

            void broadcast(MESSAGE_TYPES.EVENT, {
                event: "dependency_file_ready",
                runId,
                workflowTabId,
                path: dependencyPath,
                generated: true,
            });
        } else {
            void broadcast(MESSAGE_TYPES.EVENT, {
                event: "dependency_file_found",
                runId,
                workflowTabId,
                path: dependencyPath,
                generated: false,
            });
        }

        resolvedPaths.add(dependencyPath);
        dependencies.push({
            path: dependencyPath,
            reason: request.reason,
            content,
        });
    }

    throw new Error("PromptFlow could not resolve all requested dependency files.");
}



function createConfirmationRequest({
    runId,
    workflowTabId,
    taskId,
    destinations,
}) {
    const requestId = crypto.randomUUID();

    const request = {
        requestId,
        runId,
        workflowTabId,
        taskId,
        destinations,
        createdAt: new Date().toISOString(),
    };

    return new Promise((resolve) => {
        pendingConfirmations.set(requestId, {
            resolve,
            request,
        });

        browser.storage.local.set({
            [`promptflow_pending_confirmation_${requestId}`]: request,
        });

        broadcast(MESSAGE_TYPES.CONFIRM_DESTINATIONS, {
            request,
        });
    });
}




async function getPendingConfirmations(workflowTabId) {
    const stored = await browser.storage.local.get(null);

    return Object.entries(stored)
        .filter(([key, request]) =>
            key.startsWith("promptflow_pending_confirmation_") &&
            request?.workflowTabId === workflowTabId
        )
        .map(([, request]) => request);
}

async function resolveConfirmation(message) {
    const pending = pendingConfirmations.get(message.requestId);

    if (!pending) {
        return {
            success: false,
            error: "This destination confirmation is no longer active.",
        };
    }

    pendingConfirmations.delete(message.requestId);

    await browser.storage.local.remove(
        `promptflow_pending_confirmation_${message.requestId}`
    );

    pending.resolve(message.confirmation || null);

    return {
        success: true,
    };
}

async function runWorkflow(message) {
    const {
        workflow,
        workflowTabId,
        chatTabId,
        projectId,
        workingDirectory = "",
        readToken,
        writeToken,
        sourceModes = {},
        additionalInstructions = {},
    } = message;

    if (!workflow) {
        throw new Error("A workflow is required.");
    }

    if (!Number.isInteger(workflowTabId)) {
        throw new Error("A valid workflow tab ID is required.");
    }

    if (!Number.isInteger(chatTabId)) {
        throw new Error("A valid ChatGPT tab ID is required.");
    }

    if (!projectId || !readToken || !writeToken) {
        throw new Error(
            "Project authorization is incomplete. Reauthorize project access and try again."
        );
    }

    if (activeRuns.has(workflowTabId)) {
        throw new Error(
            "A workflow is already running for this tab."
        );
    }

    const runId = crypto.randomUUID();

    const runRecord = {
        runId,
        runType: "workflow",
        workflowTabId,
        chatTabId,
        projectId,
        workingDirectory,
        stopRequested: false,
        status: "RUNNING",
        startedAt: new Date().toISOString(),
    };

    activeRuns.set(workflowTabId, runRecord);

    await broadcast(MESSAGE_TYPES.EVENT, {
        event: "workflow_started",
        runId,
        workflowTabId,
    });

    try {
        const controller = createWorkflowExecutionController({
            definition: DJANGO_MODEL_WORKFLOW,

            readFile: (path) => readProjectFile({
                projectId,
                workingDirectory,
                readToken,
                path,
            }),

            writeFile: (path, content) => writeProjectFile({
                projectId,
                workingDirectory,
                writeToken,
                path,
                content,
            }),

            listFiles: () => listProjectFiles({
                projectId,
                workingDirectory,
                readToken,
            }),

            sendPrompt: (prompt) => sendPromptWithDependencyResolution({
                chatTabId,
                prompt,
                projectId,
                workingDirectory,
                readToken,
                writeToken,
                workflowTabId,
                runId,
            }),

            confirmDestinations: (confirmation) => (
                createConfirmationRequest({
                    runId,
                    workflowTabId,
                    taskId: confirmation.taskId,
                    destinations: confirmation.destinations,
                })
            ),

            onStateChange: (updatedWorkflow) => {
                broadcast(MESSAGE_TYPES.EVENT, {
                    event: "workflow_state_changed",
                    runId,
                    workflowTabId,
                    workflow: updatedWorkflow,
                });
            },

            onEvent: (event) => {
                broadcast(MESSAGE_TYPES.EVENT, {
                    event: "workflow_event",
                    runId,
                    workflowTabId,
                    workflowEvent: event,
                });
            },

            shouldStop: () => runRecord.stopRequested,
        });

        const result = await controller.run({
            tabId: workflowTabId,
            workflow,
            sourceModes,
            additionalInstructions,
        });

        runRecord.status = result.success
            ? "COMPLETED"
            : "FAILED";

        runRecord.completedAt = new Date().toISOString();

        await broadcast(MESSAGE_TYPES.EVENT, {
            event: "workflow_finished",
            runId,
            workflowTabId,
            result,
        });

        return result;

    } catch (error) {
        runRecord.status = "FAILED";

        await broadcast(MESSAGE_TYPES.EVENT, {
            event: "workflow_failed",
            runId,
            workflowTabId,
            error: error.message,
        });

        throw error;

    } finally {
        activeRuns.delete(workflowTabId);
    }
}


async function runBatch(message) {
    const {
        batchId,
        workflowTabId,
        chatTabId,
        projectId,
        workingDirectory = "",
        readToken,
        writeToken,
    } = message;

    if (!batchId) {
        throw new Error("A batch ID is required.");
    }

    if (!Number.isInteger(workflowTabId) || workflowTabId < 0) {
        throw new Error("A valid workflow tab ID is required.");
    }

    if (!Number.isInteger(chatTabId) || chatTabId < 0) {
        throw new Error("A valid ChatGPT tab ID is required.");
    }

    if (!projectId || !readToken || !writeToken) {
        throw new Error(
            "Project authorization is incomplete. Reauthorize project access and try again."
        );
    }

    if (activeRuns.has(workflowTabId)) {
        throw new Error(
            "An execution is already running for this Firefox tab."
        );
    }

    const runId = crypto.randomUUID();

    const runRecord = {
        runId,
        runType: "batch",
        batchId,
        workflowTabId,
        chatTabId,
        projectId,
        workingDirectory,
        stopRequested: false,
        status: "RUNNING",
        startedAt: new Date().toISOString(),
    };

    activeRuns.set(workflowTabId, runRecord);

    await broadcast(MESSAGE_TYPES.EVENT, {
        event: "batch_started",
        runId,
        batchId,
        workflowTabId,
    });

    try {
        const result = await startWorkflowBatch({
            tabId: workflowTabId,
            batchId,

            readFile: (path) => readProjectFile({
                projectId,
                workingDirectory,
                readToken,
                path,
            }),

            runModel: async ({
                workflow,
                preparationMode,
                onWorkflowChange,
            }) => {
                const controller = createWorkflowExecutionController({
                    definition: DJANGO_MODEL_WORKFLOW,

                    readFile: (path) => readProjectFile({
                        projectId,
                        workingDirectory,
                        readToken,
                        path,
                    }),

                    writeFile: (path, content) => writeProjectFile({
                        projectId,
                        workingDirectory,
                        writeToken,
                        path,
                        content,
                    }),

                    listFiles: () => listProjectFiles({
                        projectId,
                        workingDirectory,
                        readToken,
                    }),

                    sendPrompt: (prompt) => sendPromptWithDependencyResolution({
                        chatTabId,
                        prompt,
                        projectId,
                        workingDirectory,
                        readToken,
                        writeToken,
                        workflowTabId,
                        runId,
                    }),

                    confirmDestinations: (confirmation) => (
                        createConfirmationRequest({
                            runId,
                            workflowTabId,
                            taskId: confirmation.taskId,
                            destinations: confirmation.destinations,
                        })
                    ),

                    onStateChange: (updatedWorkflow) => {
                        onWorkflowChange?.(updatedWorkflow);

                        void broadcast(MESSAGE_TYPES.EVENT, {
                            event: "batch_workflow_state_changed",
                            runId,
                            batchId,
                            workflowTabId,
                            workflow: updatedWorkflow,
                        });
                    },

                    onEvent: (event) => {
                        void broadcast(MESSAGE_TYPES.EVENT, {
                            event: "batch_workflow_event",
                            runId,
                            batchId,
                            workflowTabId,
                            workflowEvent: event,
                        });
                    },

                    shouldStop: () => runRecord.stopRequested,
                });

                return controller.run({
                    tabId: workflowTabId,
                    workflow,
                    sourceModes: {
                        model: preparationMode,
                    },
                });
            },

            onBatchChange: (batch) => {
                void broadcast(MESSAGE_TYPES.EVENT, {
                    event: "batch_state_changed",
                    runId,
                    batchId,
                    workflowTabId,
                    batch,
                });
            },

            onModelChange: (modelEvent) => {
                void broadcast(MESSAGE_TYPES.EVENT, {
                    event: "batch_model_changed",
                    runId,
                    batchId,
                    workflowTabId,
                    modelEvent,
                });
            },
        });

        runRecord.status = result?.batch?.status?.toUpperCase() ||
            (result?.success ? "COMPLETED" : "FAILED");
        runRecord.completedAt = new Date().toISOString();

        await broadcast(MESSAGE_TYPES.EVENT, {
            event: "batch_finished",
            runId,
            batchId,
            workflowTabId,
            result,
        });

        return result;

    } catch (error) {
        runRecord.status = "FAILED";

        await broadcast(MESSAGE_TYPES.EVENT, {
            event: "batch_failed",
            runId,
            batchId,
            workflowTabId,
            error: error.message || String(error),
        });

        return {
            success: false,
            error: error.message || String(error),
        };

    } finally {
        activeRuns.delete(workflowTabId);
    }
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (!isExtensionMessage(sender)) {
        return undefined;
    }

    switch (message?.type) {
        case MESSAGE_TYPES.START: {
            const workflowTabId = message.workflowTabId;

            if (activeRuns.has(workflowTabId)) {
                return Promise.resolve({
                    success: false,
                    error: "A workflow is already running for this tab.",
                });
            }

            void runWorkflow(message).catch((error) => {
                broadcast(MESSAGE_TYPES.EVENT, {
                    event: "workflow_start_failed",
                    workflowTabId,
                    error: error.message,
                });
            });

            return Promise.resolve({
                success: true,
                accepted: true,
            });
        }

        case MESSAGE_TYPES.START_BATCH: {
            const workflowTabId = message.workflowTabId;

            if (activeRuns.has(workflowTabId)) {
                return Promise.resolve({
                    success: false,
                    error: "An execution is already running for this tab.",
                });
            }

            void runBatch(message).catch((error) => {
                broadcast(MESSAGE_TYPES.EVENT, {
                    event: "batch_start_failed",
                    batchId: message.batchId,
                    workflowTabId,
                    error: error.message || String(error),
                });
            });

            return Promise.resolve({
                success: true,
                accepted: true,
            });
        }

        case MESSAGE_TYPES.PAUSE_BATCH: {
            const run = activeRuns.get(message.workflowTabId);

            if (
                !run ||
                run.runType !== "batch" ||
                run.batchId !== message.batchId
            ) {
                return Promise.resolve({
                    success: false,
                    error: "No matching active batch was found.",
                });
            }

            return pauseWorkflowBatch(
                message.workflowTabId,
                message.batchId
            ).then(async (batch) => {
                await broadcast(MESSAGE_TYPES.EVENT, {
                    event: "batch_state_changed",
                    runId: run.runId,
                    batchId: run.batchId,
                    workflowTabId: run.workflowTabId,
                    batch,
                });

                return { success: true, batch };
            }).catch((error) => ({
                success: false,
                error: error.message || String(error),
            }));
        }

        case MESSAGE_TYPES.STOP_BATCH: {
            const run = activeRuns.get(message.workflowTabId);

            if (
                !run ||
                run.runType !== "batch" ||
                run.batchId !== message.batchId
            ) {
                return Promise.resolve({
                    success: false,
                    error: "No matching active batch was found.",
                });
            }

            return stopWorkflowBatch(
                message.workflowTabId,
                message.batchId
            ).then(async (batch) => {
                await broadcast(MESSAGE_TYPES.EVENT, {
                    event: "batch_state_changed",
                    runId: run.runId,
                    batchId: run.batchId,
                    workflowTabId: run.workflowTabId,
                    batch,
                });

                return { success: true, batch };
            }).catch((error) => ({
                success: false,
                error: error.message || String(error),
            }));
        }

        case MESSAGE_TYPES.STOP: {
            const run = activeRuns.get(message.workflowTabId);

            if (!run) {
                return Promise.resolve({
                    success: false,
                    error: "No active workflow was found.",
                });
            }

            run.stopRequested = true;

            return Promise.resolve({
                success: true,
            });
        }

        case MESSAGE_TYPES.STATUS: {
            const run = activeRuns.get(message.workflowTabId);

            return Promise.resolve({
                success: true,
                running: Boolean(run),
                run: run
                    ? {
                        runId: run.runId,
                        runType: run.runType,
                        batchId: run.batchId || null,
                        status: run.status,
                        workflowTabId: run.workflowTabId,
                        chatTabId: run.chatTabId,
                        startedAt: run.startedAt,
                    }
                    : null,
            });
        }

        case MESSAGE_TYPES.GET_PENDING_CONFIRMATIONS:
            return getPendingConfirmations(message.workflowTabId).then(
                (requests) => ({
                    success: true,
                    requests,
                })
            );

        case MESSAGE_TYPES.CONFIRM_DESTINATIONS_RESULT:
            return resolveConfirmation(message);

        default:
            return undefined;
    }
});

console.log("[PromptFlow] Background workflow coordinator loaded.");