import test from "node:test";
import assert from "node:assert/strict";

import {
    DJANGO_MODEL_WORKFLOW,
} from "../../definitions/django-model-workflow.js";

import {
    WORKFLOW_TASK_STATUS,
    WORKFLOW_OUTPUT_STATUS,
    createWorkflowInstance,
    getWorkflowProgress,
    getNextReadyTask,
    startWorkflowTask,
    storeWorkflowOutput,
    validateWorkflowOutput,
    assignWorkflowOutputDestination,
    markWorkflowOutputWritten,
    completeWorkflowTask,
    failWorkflowTask,
    retryWorkflowTask,
    getWorkflowOutput,
    getWorkflowTaskDefinition,
    getWorkflowDefinition,
} from "../../services/workflowService.js";


const PROJECT_ID = "test-project";

const PROJECT_TREE = `
core/
└── finance/
    └── payments/
        ├── models/
        ├── selectors/
        ├── services/
        └── tests/
            ├── factories/
            ├── models/
            ├── selectors/
            └── services/
`;


const MODEL_PATH =
    "core/finance/payments/models/payment.py";


function createTestWorkflow(overrides = {}) {
    return createWorkflowInstance({
        projectId: PROJECT_ID,
        projectName: "Test Project",
        modelPath: MODEL_PATH,
        projectTree: PROJECT_TREE,
        ...overrides,
    });
}


function completeTaskWithOutputs(
    workflow,
    taskId,
    contents = {}
) {
    let next = startWorkflowTask(
        workflow,
        taskId
    );

    const taskDefinition =
        getWorkflowTaskDefinition(taskId);

    for (const outputDefinition of taskDefinition.outputs) {
        const outputId = outputDefinition.id;

        const content =
            contents[outputId] ||
            `# Generated ${outputId}\n\nclass Example:\n    pass\n`;

        next = storeWorkflowOutput(next, {
            taskId,
            outputId,
            content,
        });

        next = validateWorkflowOutput(next, {
            taskId,
            outputId,
        });

        const output = getWorkflowOutput(
            next,
            taskId,
            outputId
        );

        if (
            !output.destination.path ||
            !output.destination.confirmed
        ) {
            next = assignWorkflowOutputDestination(next, {
                taskId,
                outputId,
                path: `core/finance/payments/tests/${outputId}.py`,
                confirmed: true,
            });
        }

        next = markWorkflowOutputWritten(next, {
            taskId,
            outputId,
        });
    }

    return completeWorkflowTask(
        next,
        taskId
    );
}


function completeModelTask(workflow) {
    return completeTaskWithOutputs(
        workflow,
        "create_model",
        {
            model: `
from django.db import models


class Payment(models.Model):
    reference = models.CharField(max_length=100)
`,
        }
    );
}


test("creates a workflow with the expected initial state", () => {
    const workflow = createTestWorkflow();

    assert.ok(workflow.id);

    assert.equal(
        workflow.definitionId,
        "django-model-workflow"
    );

    assert.equal(
        workflow.definitionVersion,
        1
    );

    assert.equal(
        workflow.project.id,
        PROJECT_ID
    );

    assert.equal(
        workflow.input.modelPath,
        MODEL_PATH
    );

    assert.equal(
        workflow.status,
        "ready"
    );

    assert.equal(
        workflow.tasks.length,
        6
    );

    assert.equal(
        workflow.currentTaskId,
        "create_model"
    );

    assert.equal(
        getNextReadyTask(workflow).id,
        "create_model"
    );

    const modelOutput = getWorkflowOutput(
        workflow,
        "create_model",
        "model"
    );

    assert.equal(
        modelOutput.destination.path,
        MODEL_PATH
    );

    assert.equal(
        modelOutput.destination.confirmed,
        true
    );

    assert.equal(
        modelOutput.destination.source,
        "explicit_input"
    );

    assert.equal(
        modelOutput.status,
        WORKFLOW_OUTPUT_STATUS.PENDING
    );
});


test("rejects workflow creation without a registered project", () => {
    assert.throws(
        () => createTestWorkflow({
            projectId: null,
        }),
        /registered project/
    );
});


test("rejects workflow creation without a model path", () => {
    assert.throws(
        () => createTestWorkflow({
            modelPath: "",
        }),
        /model destination path/
    );
});


test("rejects workflow creation without a project tree", () => {
    assert.throws(
        () => createTestWorkflow({
            projectTree: "",
        }),
        /project file tree/
    );
});


test("rejects absolute and traversal model paths", () => {
    assert.throws(
        () => createTestWorkflow({
            modelPath: "/etc/passwd",
        }),
        /project-relative path/
    );

    assert.throws(
        () => createTestWorkflow({
            modelPath: "../outside/payment.py",
        }),
        /project-relative path/
    );

    assert.throws(
        () => createTestWorkflow({
            modelPath: "core/../outside/payment.py",
        }),
        /project-relative path/
    );
});


test("rejects duplicate task IDs in a workflow definition", () => {
    const definition = structuredClone(
        DJANGO_MODEL_WORKFLOW
    );

    definition.tasks[1].id =
        definition.tasks[0].id;

    assert.throws(
        () => createTestWorkflow({
            definition,
        }),
        /task IDs must be unique/
    );
});


test("rejects unknown task dependencies", () => {
    const definition = structuredClone(
        DJANGO_MODEL_WORKFLOW
    );

    definition.tasks[1].dependencies.push(
        "unknown_task"
    );

    assert.throws(
        () => createTestWorkflow({
            definition,
        }),
        /unknown task/
    );
});


test("rejects circular task dependencies", () => {
    const definition = structuredClone(
        DJANGO_MODEL_WORKFLOW
    );

    definition.tasks[0].dependencies.push(
        "create_service"
    );

    assert.throws(
        () => createTestWorkflow({
            definition,
        }),
        /Circular workflow dependency/
    );
});


test("keeps workflow instances independent of the shared definition", () => {
    const originalMode =
        DJANGO_MODEL_WORKFLOW.tasks[0]
            .outputs[0].destination.mode;

    const workflow = createTestWorkflow();

    const output = getWorkflowOutput(
        workflow,
        "create_model",
        "model"
    );

    assert.equal(
        output.destination.mode,
        "explicit"
    );

    assert.equal(
        DJANGO_MODEL_WORKFLOW.tasks[0]
            .outputs[0].destination.mode,
        originalMode
    );
});


test("only the first task is ready initially", () => {
    const workflow = createTestWorkflow();

    const readyTasks = workflow.tasks.filter(
        (task) =>
            task.status === WORKFLOW_TASK_STATUS.READY
    );

    assert.deepEqual(
        readyTasks.map((task) => task.id),
        ["create_model"]
    );
});


test("prevents a task from starting before its dependencies complete", () => {
    const workflow = createTestWorkflow();

    assert.throws(
        () => startWorkflowTask(
            workflow,
            "create_selector"
        ),
        /incomplete dependencies/
    );
});


test("starts a ready task and increments its attempt count", () => {
    const workflow = createTestWorkflow();

    const next = startWorkflowTask(
        workflow,
        "create_model"
    );

    const task = next.tasks.find(
        (item) => item.id === "create_model"
    );

    assert.equal(
        task.status,
        WORKFLOW_TASK_STATUS.RUNNING
    );

    assert.equal(task.attempts, 1);

    assert.ok(task.startedAt);

    assert.equal(
        next.status,
        "running"
    );

    assert.equal(
        next.currentTaskId,
        "create_model"
    );
});


test("rejects storing an output when its task is not running", () => {
    const workflow = createTestWorkflow();

    assert.throws(
        () => storeWorkflowOutput(workflow, {
            taskId: "create_model",
            outputId: "model",
            content: "class Payment: pass",
        }),
        /status is/
    );
});


test("stores extracted output content", () => {
    const workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    const next = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    const output = getWorkflowOutput(
        next,
        "create_model",
        "model"
    );

    assert.equal(
        output.status,
        WORKFLOW_OUTPUT_STATUS.EXTRACTED
    );

    assert.equal(
        output.content,
        "class Payment: pass"
    );
});


test("rejects empty output content", () => {
    const workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    assert.throws(
        () => storeWorkflowOutput(workflow, {
            taskId: "create_model",
            outputId: "model",
            content: "   ",
        }),
        /cannot be empty/
    );
});


test("validates an extracted output", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    assert.equal(
        getWorkflowOutput(
            workflow,
            "create_model",
            "model"
        ).status,
        WORKFLOW_OUTPUT_STATUS.VALIDATED
    );
});


test("requires a running task before validating output", () => {
    const workflow = createTestWorkflow();

    assert.throws(
        () => validateWorkflowOutput(workflow, {
            taskId: "create_model",
            outputId: "model",
        }),
        /status is/
    );
});


test("rejects output destinations with the wrong extension", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    assert.throws(
        () => assignWorkflowOutputDestination(workflow, {
            taskId: "create_model",
            outputId: "model",
            path: "core/finance/payments/payment.txt",
            confirmed: true,
        }),
        /\.py/
    );
});


test("requires destination confirmation before marking output written", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = assignWorkflowOutputDestination(workflow, {
        taskId: "create_model",
        outputId: "model",
        path: MODEL_PATH,
        confirmed: false,
    });

    assert.throws(
        () => markWorkflowOutputWritten(workflow, {
            taskId: "create_model",
            outputId: "model",
        }),
        /confirmed destination/
    );
});


test("completes the model task and unlocks dependent tasks", () => {
    const workflow = completeModelTask(
        createTestWorkflow()
    );

    const modelTask = workflow.tasks.find(
        (task) => task.id === "create_model"
    );

    const factoryTask = workflow.tasks.find(
        (task) =>
            task.id === "create_factory_and_model_test"
    );

    const selectorTask = workflow.tasks.find(
        (task) => task.id === "create_selector"
    );

    assert.equal(
        modelTask.status,
        WORKFLOW_TASK_STATUS.COMPLETED
    );

    assert.equal(
        factoryTask.status,
        WORKFLOW_TASK_STATUS.READY
    );

    assert.equal(
        selectorTask.status,
        WORKFLOW_TASK_STATUS.READY
    );

    assert.equal(
        workflow.status,
        "ready"
    );

    assert.equal(
        workflow.currentTaskId,
        "create_factory_and_model_test"
    );
});


test("requires every required output to be written before task completion", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    assert.throws(
        () => completeWorkflowTask(
            workflow,
            "create_model"
        ),
        /not been written/
    );
});


test("supports separate outputs in the factory and model test task", () => {
    let workflow = completeModelTask(
        createTestWorkflow()
    );

    workflow = completeTaskWithOutputs(
        workflow,
        "create_factory_and_model_test",
        {
            model_factory: "class PaymentFactory: pass",
            model_test: "def test_payment(): pass",
        }
    );

    const factory = getWorkflowOutput(
        workflow,
        "create_factory_and_model_test",
        "model_factory"
    );

    const modelTest = getWorkflowOutput(
        workflow,
        "create_factory_and_model_test",
        "model_test"
    );

    assert.equal(
        factory.status,
        WORKFLOW_OUTPUT_STATUS.WRITTEN
    );

    assert.equal(
        modelTest.status,
        WORKFLOW_OUTPUT_STATUS.WRITTEN
    );

    assert.notEqual(
        factory.destination.path,
        modelTest.destination.path
    );

    assert.equal(
        workflow.tasks.find(
            (task) =>
                task.id === "create_factory_and_model_test"
        ).status,
        WORKFLOW_TASK_STATUS.COMPLETED
    );
});


test("prevents changing a destination after its output is written", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = markWorkflowOutputWritten(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    assert.throws(
        () => assignWorkflowOutputDestination(workflow, {
            taskId: "create_model",
            outputId: "model",
            path: "core/finance/payments/models/another.py",
            confirmed: true,
        }),
        /cannot be changed after it has been written/
    );
});


test("prevents replacing an already written output", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = markWorkflowOutputWritten(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    assert.throws(
        () => storeWorkflowOutput(workflow, {
            taskId: "create_model",
            outputId: "model",
            content: "class Replacement: pass",
        }),
        /already been written/
    );
});


test("fails a running task and records its error", () => {
    const workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    const next = failWorkflowTask(
        workflow,
        "create_model",
        new Error("Generation failed.")
    );

    const task = next.tasks.find(
        (item) => item.id === "create_model"
    );

    assert.equal(
        task.status,
        WORKFLOW_TASK_STATUS.FAILED
    );

    assert.equal(
        task.error,
        "Generation failed."
    );

    assert.equal(
        next.status,
        "failed"
    );

    assert.equal(
        next.currentTaskId,
        "create_model"
    );
});


test("preserves the explicit model destination when retrying", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = failWorkflowTask(
        workflow,
        "create_model",
        new Error("Temporary failure.")
    );

    workflow = retryWorkflowTask(
        workflow,
        "create_model"
    );

    const output = getWorkflowOutput(
        workflow,
        "create_model",
        "model"
    );

    assert.equal(
        output.destination.path,
        MODEL_PATH
    );

    assert.equal(
        output.destination.confirmed,
        true
    );

    assert.equal(
        output.destination.source,
        "explicit_input"
    );

    assert.equal(
        output.status,
        WORKFLOW_OUTPUT_STATUS.PENDING
    );
});


test("rejects retrying a task that has not failed", () => {
    const workflow = createTestWorkflow();

    assert.throws(
        () => retryWorkflowTask(
            workflow,
            "create_model"
        ),
        /Only failed tasks/
    );
});


test("preserves generated output content when retrying", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = failWorkflowTask(
        workflow,
        "create_model",
        new Error("Simulated write failure")
    );

    workflow = retryWorkflowTask(
        workflow,
        "create_model"
    );

    const output = getWorkflowOutput(
        workflow,
        "create_model",
        "model"
    );

    assert.equal(
        output.content,
        "class Payment: pass"
    );

    assert.equal(
        output.status,
        WORKFLOW_OUTPUT_STATUS.VALIDATED
    );

    assert.equal(
        workflow.tasks.find(
            (task) => task.id === "create_model"
        ).status,
        WORKFLOW_TASK_STATUS.READY
    );
});

test("rejects execution with a different workflow definition ID", () => {
    const workflow = createTestWorkflow();

    const definition = structuredClone(
        DJANGO_MODEL_WORKFLOW
    );

    definition.id = "another-workflow";

    assert.throws(
        () => startWorkflowTask(
            workflow,
            "create_model",
            definition
        ),
        /definition mismatch/
    );
});


test("rejects execution with a different workflow definition version", () => {
    const definition = structuredClone(
        DJANGO_MODEL_WORKFLOW
    );

    definition.version = 2;

    const workflow = createTestWorkflow({
        definition,
    });

    const changedDefinition = structuredClone(
        definition
    );

    changedDefinition.version = 3;

    assert.throws(
        () => startWorkflowTask(
            workflow,
            "create_model",
            changedDefinition
        ),
        /definition version mismatch/
    );
});


test("returns workflow task definitions without exposing mutable originals", () => {
    const task = getWorkflowTaskDefinition(
        "create_model"
    );

    task.name = "Changed Task";

    assert.notEqual(
        DJANGO_MODEL_WORKFLOW.tasks[0].name,
        "Changed Task"
    );
});


test("returns an independent workflow definition copy", () => {
    const definition = getWorkflowDefinition();

    definition.name = "Changed Workflow";

    assert.notEqual(
        DJANGO_MODEL_WORKFLOW.name,
        "Changed Workflow"
    );
});


test("calculates workflow progress correctly", () => {
    let workflow = createTestWorkflow();

    assert.deepEqual(
        getWorkflowProgress(workflow),
        {
            total: 6,
            completed: 0,
            remaining: 6,
            percentage: 0,
        }
    );

    workflow = completeModelTask(workflow);

    assert.deepEqual(
        getWorkflowProgress(workflow),
        {
            total: 6,
            completed: 1,
            remaining: 5,
            percentage: 17,
        }
    );
});


test("does not allow a completed workflow task to be started again", () => {
    const workflow = completeModelTask(
        createTestWorkflow()
    );

    assert.throws(
        () => startWorkflowTask(
            workflow,
            "create_model"
        ),
        /cannot start/
    );
});



test("preserves successfully written outputs when retrying", () => {
    let workflow = startWorkflowTask(
        createTestWorkflow(),
        "create_model"
    );

    workflow = storeWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
        content: "class Payment: pass",
    });

    workflow = validateWorkflowOutput(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = markWorkflowOutputWritten(workflow, {
        taskId: "create_model",
        outputId: "model",
    });

    workflow = failWorkflowTask(
        workflow,
        "create_model",
        new Error("Simulated failure")
    );

    workflow = retryWorkflowTask(
        workflow,
        "create_model"
    );

    const output = getWorkflowOutput(
        workflow,
        "create_model",
        "model"
    );

    assert.equal(
        output.status,
        WORKFLOW_OUTPUT_STATUS.WRITTEN
    );

    assert.equal(
        output.content,
        "class Payment: pass"
    );
});