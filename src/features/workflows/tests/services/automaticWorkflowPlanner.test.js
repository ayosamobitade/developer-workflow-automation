import test from "node:test";
import assert from "node:assert/strict";

import {
    planAutomaticWorkflow,
} from "../../services/automaticWorkflowPlanner.js";

const modelPath =
    "core/website/content/models/content_composition_and_structure/website_content_section.py";

test("plans every conventional deliverable and classifies missing files", async () => {
    const plan = await planAutomaticWorkflow({
        modelPath,
        listFiles: async () => [],
        readFile: async () => {
            throw new Error("No files should be read when none exist.");
        },
    });

    assert.equal(plan.summary.total, 7);
    assert.equal(plan.summary.missing, 7);
    assert.equal(plan.summary.empty, 0);
    assert.equal(plan.summary.existing, 0);
    assert.equal(plan.existingFiles["create_model.model"], undefined);
    assert.equal(
        plan.deliverables.find((item) => item.taskId === "create_service")
            .path,
        "core/website/content/services/content_composition_and_structure/website_content_section_service.py"
    );
});

test("classifies empty files separately from non-empty existing implementations", async () => {
    const paths = [
        modelPath,
        "core/website/content/selectors/content_composition_and_structure/website_content_section_selector.py",
        "core/website/content/services/content_composition_and_structure/website_content_section_service.py",
    ];
    const contents = new Map([
        [paths[0], "  \n"],
        [paths[1], "class WebsiteContentSectionSelector:\n    pass\n"],
        [paths[2], "class WebsiteContentSectionService:\n    pass\n"],
    ]);

    const plan = await planAutomaticWorkflow({
        modelPath,
        listFiles: async () => paths,
        readFile: async (path) => ({ content: contents.get(path) }),
    });

    assert.equal(plan.summary.empty, 1);
    assert.equal(plan.summary.existing, 2);
    assert.equal(plan.summary.missing, 4);
    assert.equal(plan.existingFiles["create_model.model"], undefined);
    assert.equal(
        plan.existingFiles["create_selector.selector"].content,
        contents.get(paths[1])
    );
    assert.equal(
        plan.existingFiles["create_service.service"].content,
        contents.get(paths[2])
    );
});

test("rejects invalid model paths and unreadable existing files", async () => {
    await assert.rejects(
        () => planAutomaticWorkflow({
            modelPath: "core/app/models/../secrets.py",
            listFiles: async () => [],
            readFile: async () => ({ content: "" }),
        }),
        /Invalid project-relative path/
    );

    await assert.rejects(
        () => planAutomaticWorkflow({
            modelPath,
            listFiles: async () => [modelPath],
            readFile: async () => null,
        }),
        /Unable to inspect existing file/
    );
});
