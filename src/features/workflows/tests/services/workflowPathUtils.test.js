import test from "node:test";
import assert from "node:assert/strict";

import {
    filterModelProjectTree,
    filterProjectTree,
} from "../../services/workflowPathUtils.js";


const projectTree = [
    "educational",
    "└── core/",
    "    └── finance/",
    "        └── payments/",
    "            ├── models/",
    "            │   ├── analytics/",
    "            │   │   └── payment_event.py",
    "            │   └── payment.py",
    "            ├── selectors/",
    "            │   └── payment_selector.py",
    "            ├── services/",
    "            │   └── payment_service.py",
    "            └── tests/",
    "                └── models/",
    "                    └── test_payment.py",
].join("\n");


test("keeps model directories and their parent directories", () => {
    const result = filterModelProjectTree(projectTree);

    assert.match(result, /core\//);
    assert.match(result, /finance\//);
    assert.match(result, /payments\//);
    assert.match(result, /models\//);
    assert.match(result, /payment\.py/);
    assert.match(result, /analytics\//);
    assert.match(result, /payment_event\.py/);
});

test("excludes selectors, services, and test directories", () => {
    const result = filterModelProjectTree(projectTree);

    assert.doesNotMatch(result, /selectors/);
    assert.doesNotMatch(result, /services/);
    assert.doesNotMatch(result, /tests/);
    assert.doesNotMatch(result, /payment_selector\.py/);
    assert.doesNotMatch(result, /payment_service\.py/);
    assert.doesNotMatch(result, /test_payment\.py/);
});

test("excludes nested test directories inside models", () => {
    const tree = [
        "educational",
        "└── core/",
        "    └── payments/",
        "        └── models/",
        "            ├── payment.py",
        "            └── tests/",
        "                └── test_payment.py",
    ].join("\n");

    const result = filterModelProjectTree(tree);

    assert.match(result, /payment\.py/);
    assert.doesNotMatch(result, /tests/);
    assert.doesNotMatch(result, /test_payment\.py/);
});

test("returns only the root when no models directory exists", () => {
    const tree = [
        "educational",
        "└── core/",
        "    └── finance/",
        "        └── services/",
    ].join("\n");

    assert.equal(
        filterModelProjectTree(tree),
        "educational"
    );
});

test("returns an empty string for invalid input", () => {
    assert.equal(filterModelProjectTree(null), "");
    assert.equal(filterModelProjectTree(""), "");
});

test("keeps the original project tree filter behavior unchanged", () => {
    const tree = [
        "educational",
        "└── core/",
        "    ├── __init__.py",
        "    └── payment.py",
    ].join("\n");

    const result = filterProjectTree(tree);

    assert.match(result, /core\//);
    assert.match(result, /payment\.py/);
    assert.doesNotMatch(result, /__init__\.py/);
});