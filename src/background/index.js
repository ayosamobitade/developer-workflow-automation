import { createWorkflowExecutionController } from "../features/workflows/services/workflowExecutionService";
import { DJANGO_MODEL_WORKFLOW } from "../features/workflows/definitions/django-model-workflow";

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

            sendPrompt: (prompt) => (
                sendPromptToChatGPT(chatTabId, prompt)
            ),

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
                        status: run.status,
                        workflowTabId: run.workflowTabId,
                        chatTabId: run.chatTabId,
                        startedAt: run.startedAt,
                    }
                    : null,
            });
        }

        case MESSAGE_TYPES.CONFIRM_DESTINATIONS_RESULT:
            return resolveConfirmation(message);

        default:
            return undefined;
    }
});

console.log("[PromptFlow] Background workflow coordinator loaded.");