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

import {
    prepareSourceContent,
} from "../../services/sourcePreparationService.js";

import {
    generateWorkflowPrompt,
} from "../../services/workflowPromptService.js";


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
    sendPrompt,
    definition = MODEL_RECOVERY_WORKFLOW,
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
        definition,

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

        sendPrompt: async (prompt) => {
            calls.sendPrompt += 1;

            if (sendPrompt) {
                return sendPrompt(prompt);
            }

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



const PARTIAL_FACTORY_WORKFLOW = {
    ...DJANGO_MODEL_WORKFLOW,
    tasks: DJANGO_MODEL_WORKFLOW.tasks.filter((task) =>
        ["create_model", "create_factory_and_model_test"].includes(task.id)
    ),
};


test(
    "resumes a multi-output stage by preserving existing factory and creating only the missing model test",
    async () => {
        const factoryPath =
            "core/finance/payments/tests/factories/payment_factory.py";
        const modelTestPath =
            "core/finance/payments/tests/models/test_payment.py";
        const factoryContent =
            "class PaymentFactory:\n    pass\n";
        const modelTestContent =
            "class PaymentTest:\n    pass\n";

        const workflow = createWorkflowInstance({
            definition: PARTIAL_FACTORY_WORKFLOW,
            projectId: "test-project",
            projectName: "Test Project",
            modelPath: MODEL_PATH,
            projectTree: [
                MODEL_PATH,
                factoryPath,
                modelTestPath,
            ].join("\n"),
            explicitDestinations: {
                "create_factory_and_model_test.model_test": modelTestPath,
            },
        });

        workflow.input.existingFiles = {
            "create_model.model": {
                path: MODEL_PATH,
                content: MODEL_CONTENT,
            },
            "create_factory_and_model_test.model_factory": {
                path: factoryPath,
                content: factoryContent,
            },
        };
        workflow.input.automaticContinuation = true;
        workflow.input.implementationPlan = {
            modelPath: MODEL_PATH,
            existingFiles: workflow.input.existingFiles,
            deliverables: [
                {
                    taskId: "create_model",
                    outputId: "model",
                    path: MODEL_PATH,
                    status: "existing",
                    hasContent: true,
                },
                {
                    taskId: "create_factory_and_model_test",
                    outputId: "model_factory",
                    path: factoryPath,
                    status: "existing",
                    hasContent: true,
                },
                {
                    taskId: "create_factory_and_model_test",
                    outputId: "model_test",
                    path: modelTestPath,
                    status: "missing",
                    hasContent: false,
                },
            ],
        };

        const environment = createExecutionEnvironment({
            workflow,
            definition: PARTIAL_FACTORY_WORKFLOW,
            initialFiles: {
                [MODEL_PATH]: MODEL_CONTENT,
                [factoryPath]: factoryContent,
            },
            sendPrompt: async (prompt) => {
                assert.match(prompt, /model_test/);
                assert.match(prompt, /class PaymentFactory/);
                assert.doesNotMatch(prompt, /<<<PROMPTFLOW_OUTPUT_START:model_factory>>>/);
                return [
                    "<<<PROMPTFLOW_OUTPUT_START:model_test>>>",
                    modelTestContent,
                    "<<<PROMPTFLOW_OUTPUT_END:model_test>>>",
                ].join("\n");
            },
        });

        const result = await environment.controller.run({
            tabId: 10,
            workflow,
        });

        assert.equal(result.success, true);
        assert.equal(environment.calls.sendPrompt, 1);
        assert.deepEqual(
            environment.calls.writeFile.map((item) => item.path),
            [modelTestPath]
        );
        assert.equal(environment.files.get(factoryPath), factoryContent);
        assert.equal(environment.files.get(modelTestPath), modelTestContent.trimEnd());
        assert.equal(
            result.workflow.tasks.find(
                (task) => task.id === "create_factory_and_model_test"
            ).status,
            "completed"
        );
    }
);

test(
    "includes only the model file tree once in the generated prompt",
    () => {
        const projectTree = [
            "educational/",
            "└── core/",
            "    └── finance/",
            "        └── payments/",
            "            ├── models/",
            "            │   └── payment.py",
            "            ├── services/",
            "            │   └── payment_service.py",
            "            └── views.py",
            "    └── communication/",
            "        └── email/",
            "            └── models/",
            "                └── email_message.py",
            "└── config/",
            "    └── settings.py",
        ].join("\n");

        const workflow = createWorkflowInstance({
            definition: MODEL_RECOVERY_WORKFLOW,
            projectId: "test-project",
            projectName: "Test Project",
            modelPath: MODEL_PATH,
            projectTree,
        });

        const prompt = generateWorkflowPrompt({
            workflow,
            taskId: "create_model",
            sourceContents: {
                project_tree: projectTree,
            },
            sourcePaths: {
                project_tree: "Project file tree",
            },
        });

        assert.match(prompt, /MODEL FILE TREE/);
        assert.match(prompt, /payment\.py/);
        assert.match(prompt, /email_message\.py/);
        assert.doesNotMatch(prompt, /payment_service\.py/);
        assert.doesNotMatch(prompt, /views\.py/);
        assert.doesNotMatch(prompt, /settings\.py/);
        assert.doesNotMatch(prompt, /SOURCE FILE: Project file tree/);
    }
);

test(
    "preserves a complete existing model without rewriting it",
    async () => {
        const workflow = createWorkflowInstance({
            definition: MODEL_RECOVERY_WORKFLOW,
            projectId: "test-project",
            projectName: "Test Project",
            modelPath: MODEL_PATH,
            projectTree: "core/finance/payments/models/payment.py",
        });

        const plan = {
            modelPath: MODEL_PATH,
            deliverables: [{
                taskId: "create_model",
                outputId: "model",
                path: MODEL_PATH,
                status: "existing",
                hasContent: true,
            }],
            existingFiles: {
                "create_model.model": {
                    path: MODEL_PATH,
                    content: MODEL_CONTENT,
                },
            },
            summary: {
                total: 1,
                missing: 0,
                empty: 0,
                existing: 1,
            },
        };

        workflow.input.existingFiles = plan.existingFiles;
        workflow.input.implementationPlan = plan;
        workflow.input.automaticContinuation = true;

        const environment = createExecutionEnvironment({
            workflow,
            initialFiles: {
                [MODEL_PATH]: MODEL_CONTENT,
            },
            sendPrompt: async () => {
                throw new Error(
                    "An existing non-empty model must be preserved without prompting."
                );
            },
        });

        const result = await environment.controller.run({
            tabId: 10,
            workflow,
        });

        assert.equal(result.success, true);
        assert.equal(result.workflow.status, "completed");
        assert.equal(environment.calls.sendPrompt, 0);
        assert.equal(environment.calls.writeFile.length, 0);
        assert.equal(environment.files.get(MODEL_PATH), MODEL_CONTENT);
        assert.equal(
            getWorkflowOutput(result.workflow, "create_model", "model").status,
            WORKFLOW_OUTPUT_STATUS.WRITTEN
        );
    }
);


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
            /Protected-file conflict/
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
    "compact source preparation removes blank lines without changing executable strings",
    () => {
        const source = [
            "class Example:",
            '    """A description',
            "",
            "    with an intentional blank line",
            '    """',
            "",
            "    def value(self):",
            '        text = "keep  internal spaces  "',
            "        return text  ",
            "",
            "# removable comment",
            "",
        ].join("\n");

        const prepared = prepareSourceContent({
            content: source,
            path: "example.py",
            mode: "compact",
        });

        assert.equal(prepared.originalContent, source);
        assert.equal(prepared.changed, true);
        assert.match(prepared.content, /with an intentional blank line/);
        assert.match(prepared.content, /text = "keep  internal spaces  "/);
        assert.match(prepared.content, /return text\n/);
        assert.doesNotMatch(prepared.content, /removable comment/);
        assert.ok(prepared.content.length < source.length);
    }
);

test(
    "model contract preparation preserves model structure and method signatures while omitting method bodies",
    () => {
        const source = [
            "from django.db import models",
            "",
            "class Payment(models.Model):",
            "    amount = models.DecimalField(max_digits=10, decimal_places=2)",
            "    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)",
            "",
            "    class Meta:",
            "        ordering = [\"-created_at\"]",
            "        indexes = [models.Index(fields=[\"customer\"])]",
            "",
            "    def clean(self):",
            "        if self.amount < 0:",
            "            raise ValidationError(\"Amount cannot be negative.\")",
            "",
            "    def save(self, *args, **kwargs):",
            "        self.full_clean()",
            "        return super().save(*args, **kwargs)",
            "",
        ].join("\n");

        const prepared = prepareSourceContent({
            content: source,
            path: "payment.py",
            mode: "model_contract",
        });

        assert.equal(prepared.originalContent, source);
        assert.match(prepared.content, /from django\.db import models/);
        assert.match(prepared.content, /amount = models\.DecimalField/);
        assert.match(prepared.content, /models\.ForeignKey/);
        assert.match(prepared.content, /class Meta:/);
        assert.match(prepared.content, /ordering =/);
        assert.match(prepared.content, /def clean\(self\):/);
        assert.match(prepared.content, /def save\(self, \*args, \*\*kwargs\):/);
        assert.match(prepared.content, /    pass/);
        assert.doesNotMatch(prepared.content, /Amount cannot be negative/);
        assert.doesNotMatch(prepared.content, /self\.full_clean\(\)/);
        assert.ok(prepared.content.length < source.length);
    }
);

test(
    "create_selector_test supports the model contract preparation mode",
    () => {
        const task = DJANGO_MODEL_WORKFLOW.tasks.find(
            (item) => item.id === "create_selector_test"
        );

        const modelSource = task.sources.find(
            (source) => source.id === "model"
        );

        assert.ok(
            modelSource.preparation.supportedModes.includes("model_contract")
        );
    }
);

test(
    "estimates prompt tokens conservatively and exposes the configured budget",
    () => {
        assert.equal(estimatePromptTokens(""), 0);
        assert.equal(estimatePromptTokens("x".repeat(350)), 100);
        assert.equal(MAX_PROMPT_TOKENS, 24000);
    }
);

test(
    "provides an existing dependency separately and resends the exact original prompt",
    async () => {
        const workflow = createWorkflowInstance({
            definition: MODEL_RECOVERY_WORKFLOW,
            projectId: "test-project",
            projectName: "Test Project",
            modelPath: MODEL_PATH,
            projectTree: "core/finance/payments/models/payment.py",
        });
        const dependencyPath = "core/finance/payments/models/customer.py";
        const dependencyContent = "class Customer:\n    pass\n";
        const originalPrompts = [];
        const sentPrompts = [];
        let call = 0;

        const dependencyRequest = [
            "<<<PROMPTFLOW_DEPENDENCY_REQUEST_START>>>",
            JSON.stringify({
                path: dependencyPath,
                reason: "The relationship requires the customer model.",
                requiredFor: "Payment.customer",
            }),
            "<<<PROMPTFLOW_DEPENDENCY_REQUEST_END>>>",
        ].join("\n");

        const outputResponse = [
            "<<<PROMPTFLOW_OUTPUT_START:model>>>",
            "```python",
            MODEL_CONTENT.trimEnd(),
            "```",
            "<<<PROMPTFLOW_OUTPUT_END:model>>>",
        ].join("\n");

        const environment = createExecutionEnvironment({
            workflow,
            initialFiles: {
                [dependencyPath]: dependencyContent,
            },
            sendPrompt: async (prompt) => {
                sentPrompts.push(prompt);
                call += 1;
                if (call === 1) {
                    originalPrompts.push(prompt);
                    return dependencyRequest;
                }
                if (call === 2) {
                    assert.match(prompt, /PROMPTFLOW ADDITIONAL SOURCE FILE/);
                    assert.match(prompt, /class Customer/);
                    assert.doesNotMatch(prompt, /PROMPTFLOW WORKFLOW TASK/);
                    return "Source received.";
                }
                originalPrompts.push(prompt);
                return outputResponse;
            },
        });

        const result = await environment.controller.run({
            tabId: 10,
            workflow,
        });

        assert.equal(result.success, true);
        assert.equal(call, 3);
        assert.equal(originalPrompts.length, 2);
        assert.equal(originalPrompts[0], originalPrompts[1]);
        assert.match(originalPrompts[0], /TASK INSTRUCTIONS/);
        assert.equal(sentPrompts[0], sentPrompts[2]);
        assert.equal(environment.calls.writeFile.length, 1);
        assert.equal(environment.files.get(MODEL_PATH), MODEL_CONTENT.trimEnd());
    }
);

