import test, {
    beforeEach,
    afterEach,
} from "node:test";

import assert from "node:assert/strict";

import {
    DJANGO_MODEL_WORKFLOW,
} from "../../definitions/django-model-workflow.js";

import {
    WORKFLOW_OUTPUT_STATUS,
    createWorkflowInstance,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    markWorkflowOutputWritten,
    failWorkflowTask,
    retryWorkflowTask,
    getWorkflowOutput,
} from "../../services/workflowService.js";

import {
    createWorkflowExecutionController,
    estimatePromptTokens,
    MAX_PROMPT_TOKENS,
} from "../../services/workflowExecutionService.js";


const MODEL_PATH =
    "core/finance/payments/models/payment.py";

const MODEL_CONTENT = [
    "class Payment:",
    "    pass",
    "",
].join("\n");


/*
 * Isolate model-output recovery.
 *
 * The full workflow normally continues to the next task after
 * create_model completes. These tests focus exclusively on recovery
 * and should not attempt to generate subsequent outputs.
 */
const MODEL_RECOVERY_WORKFLOW = {
    ...DJANGO_MODEL_WORKFLOW,

    tasks: DJANGO_MODEL_WORKFLOW.tasks.filter(
        (task) => task.id === "create_model"
    ),
};


let originalBrowserDescriptor;


beforeEach(() => {
    originalBrowserDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "browser"
    );

    globalThis.browser = {
        storage: {
            local: {
                set: async () => {},
                get: async () => ({}),
                remove: async () => {},
            },
        },
    };
});


afterEach(() => {
    if (originalBrowserDescriptor) {
        Object.defineProperty(
            globalThis,
            "browser",
            originalBrowserDescriptor
        );
    } else {
        delete globalThis.browser;
    }
});


function createFailedModelWorkflow({
    written = false,
} = {}) {
    let workflow = createWorkflowInstance({
        definition: MODEL_RECOVERY_WORKFLOW,
        projectId: "test-project",
        projectName: "Test Project",
        modelPath: MODEL_PATH,
        projectTree: [
            "core/",
            "└── finance/",
            "    └── payments/",
            "        └── models/",
            "            └── payment.py",
        ].join("\n"),
    });

    workflow = startWorkflowTask(
        workflow,
        "create_model"
    );

    workflow = storeWorkflowOutput(
        workflow,
        {
            taskId: "create_model",
            outputId: "model",
            content: MODEL_CONTENT,
        }
    );

    workflow = validateWorkflowOutput(
        workflow,
        {
            taskId: "create_model",
            outputId: "model",
        }
    );

    if (written) {
        workflow = markWorkflowOutputWritten(
            workflow,
            {
                taskId: "create_model",
                outputId: "model",
            }
        );
    }

    workflow = failWorkflowTask(
        workflow,
        "create_model",
        new Error("Simulated interruption")
    );

    workflow = retryWorkflowTask(
        workflow,
        "create_model"
    );

    return workflow;
}


function createExecutionEnvironment({
    workflow,
    initialFiles = {},
} = {}) {
    const files = new Map(
        Object.entries(initialFiles)
    );

    const calls = {
        readFile: [],
        writeFile: [],
        listFiles: 0,
        sendPrompt: 0,
        confirmDestinations: 0,
    };

    const controller = createWorkflowExecutionController({
        definition: MODEL_RECOVERY_WORKFLOW,

        readFile: async (path) => {
            calls.readFile.push(path);

            if (!files.has(path)) {
                return null;
            }

            return {
                path,
                content: files.get(path),
            };
        },

        writeFile: async (path, content) => {
            calls.writeFile.push({
                path,
                content,
            });

            files.set(path, content);

            return {
                ok: true,
            };
        },

        listFiles: async () => {
            calls.listFiles += 1;

            return [...files.keys()];
        },

        sendPrompt: async () => {
            calls.sendPrompt += 1;

            throw new Error(
                "ChatGPT should not be called during recovery."
            );
        },

        confirmDestinations: async () => {
            calls.confirmDestinations += 1;

            return {};
        },
    });

    return {
        controller,
        calls,
        files,
        workflow,
    };
}


async function executeRecovery(environment) {
    return environment.controller.run({
        tabId: 10,
        workflow: environment.workflow,
    });
}


test(
    "resumes saved outputs without sending another ChatGPT prompt",
    async () => {
        const workflow = createFailedModelWorkflow();

        const environment = createExecutionEnvironment({
            workflow,
        });

        const result = await executeRecovery(environment);

        assert.equal(result.success, true);

        assert.equal(
            result.workflow.status,
            "completed"
        );

        assert.equal(
            environment.calls.sendPrompt,
            0
        );

        assert.equal(
            environment.calls.confirmDestinations,
            0
        );

        assert.equal(
            environment.calls.writeFile.length,
            1
        );

        assert.equal(
            environment.files.get(MODEL_PATH),
            MODEL_CONTENT
        );

        const output = getWorkflowOutput(
            result.workflow,
            "create_model",
            "model"
        );

        assert.equal(
            output.status,
            WORKFLOW_OUTPUT_STATUS.WRITTEN
        );
    }
);


test(
    "recognizes a file written before interruption and does not write it again",
    async () => {
        const workflow = createFailedModelWorkflow();

        const environment = createExecutionEnvironment({
            workflow,

            initialFiles: {
                [MODEL_PATH]: MODEL_CONTENT,
            },
        });

        const result = await executeRecovery(environment);

        assert.equal(result.success, true);

        assert.equal(
            environment.calls.sendPrompt,
            0
        );

        assert.equal(
            environment.calls.writeFile.length,
            0
        );

        assert.equal(
            environment.files.get(MODEL_PATH),
            MODEL_CONTENT
        );

        const output = getWorkflowOutput(
            result.workflow,
            "create_model",
            "model"
        );

        assert.equal(
            output.status,
            WORKFLOW_OUTPUT_STATUS.WRITTEN
        );
    }
);


test(
    "accepts an existing file whose content matches an already written output",
    async () => {
        const workflow = createFailedModelWorkflow({
            written: true,
        });

        const environment = createExecutionEnvironment({
            workflow,

            initialFiles: {
                [MODEL_PATH]: MODEL_CONTENT,
            },
        });

        const result = await executeRecovery(environment);

        assert.equal(result.success, true);

        assert.equal(
            environment.calls.sendPrompt,
            0
        );

        assert.equal(
            environment.calls.writeFile.length,
            0
        );

        const output = getWorkflowOutput(
            result.workflow,
            "create_model",
            "model"
        );

        assert.equal(
            output.status,
            WORKFLOW_OUTPUT_STATUS.WRITTEN
        );
    }
);


test(
    "does not overwrite an existing file with different content",
    async () => {
        const workflow = createFailedModelWorkflow();

        const existingContent = [
            "class Payment:",
            "    amount = 100",
            "",
        ].join("\n");

        const environment = createExecutionEnvironment({
            workflow,

            initialFiles: {
                [MODEL_PATH]: existingContent,
            },
        });

        const result = await executeRecovery(environment);

        assert.equal(result.success, false);

        assert.match(
            result.error,
            /Recovery conflict/
        );

        assert.equal(
            environment.calls.sendPrompt,
            0
        );

        assert.equal(
            environment.calls.writeFile.length,
            0
        );

        assert.equal(
            environment.files.get(MODEL_PATH),
            existingContent
        );

        assert.equal(
            result.workflow.status,
            "failed"
        );
    }
);


test(
    "stops when an output marked written is missing from the project",
    async () => {
        const workflow = createFailedModelWorkflow({
            written: true,
        });

        const environment = createExecutionEnvironment({
            workflow,
        });

        const result = await executeRecovery(environment);

        assert.equal(result.success, false);

        assert.match(
            result.error,
            /marked as written.*missing/
        );

        assert.equal(
            environment.calls.sendPrompt,
            0
        );

        assert.equal(
            environment.calls.writeFile.length,
            0
        );

        assert.equal(
            result.workflow.status,
            "failed"
        );
    }
);

test(
    "estimates prompt tokens conservatively and exposes the configured budget",
    () => {
        assert.equal(estimatePromptTokens(""), 0);
        assert.equal(estimatePromptTokens("x".repeat(350)), 100);
        assert.equal(MAX_PROMPT_TOKENS, 12000);
    }
);
