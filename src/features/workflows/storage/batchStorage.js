// src/features/workflows/storage/batchStorage.js

const STORAGE_KEY_PREFIX = "promptflow_batch_";
const STORAGE_VERSION = 1;

const updateLocks = new Map();

export const BATCH_STATUS = Object.freeze({
    READY: "ready",
    RUNNING: "running",
    PAUSED: "paused",
    FAILED: "failed",
    COMPLETED: "completed",
    STOPPED: "stopped",
});

export const BATCH_MODE = Object.freeze({
    SINGLE: "single",
    MANUAL: "manual",
    AUTOMATIC: "automatic",
});

export const BATCH_MODEL_STATUS = Object.freeze({
    PENDING: "pending",
    RUNNING: "running",
    COMPLETED: "completed",
    FAILED: "failed",
    SKIPPED: "skipped",
});

function getStorage() {
    if (!globalThis.browser?.storage?.local) {
        throw new Error(
            "Firefox extension storage is unavailable. Check the storage permission."
        );
    }

    return globalThis.browser.storage.local;
}

function getStorageKey(tabId) {
    if (
        tabId === undefined ||
        tabId === null ||
        !Number.isInteger(Number(tabId)) ||
        Number(tabId) < 0
    ) {
        throw new TypeError("A valid Firefox tab ID is required.");
    }

    return `${STORAGE_KEY_PREFIX}${Number(tabId)}`;
}

function cloneState(value) {
    return structuredClone(value);
}

function validateBatchState(batch) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
        throw new TypeError("Batch state must be an object.");
    }

    if (!batch.id) {
        throw new Error("Batch state must have an ID.");
    }

    if (!Object.values(BATCH_MODE).includes(batch.mode)) {
        throw new Error(`Invalid batch execution mode: "${batch.mode}".`);
    }

    if (!Object.values(BATCH_STATUS).includes(batch.status)) {
        throw new Error(`Invalid batch status: "${batch.status}".`);
    }

    if (
        !batch.project ||
        typeof batch.project !== "object" ||
        !batch.project.id
    ) {
        throw new Error("Batch state must identify its native project.");
    }

    if (!Array.isArray(batch.models) || batch.models.length === 0) {
        throw new Error("Batch state must contain at least one model.");
    }

    if (
        !Number.isInteger(batch.currentIndex) ||
        batch.currentIndex < 0 ||
        batch.currentIndex > batch.models.length
    ) {
        throw new Error("Batch currentIndex is invalid.");
    }

    const paths = new Set();

    for (const model of batch.models) {
        if (!model || typeof model !== "object" || !model.path) {
            throw new Error("Every batch model must have a file path.");
        }

        if (typeof model.path !== "string") {
            throw new TypeError("Batch model paths must be strings.");
        }

        if (paths.has(model.path)) {
            throw new Error(
                `Duplicate model path in batch: "${model.path}".`
            );
        }

        paths.add(model.path);

        if (
            !Object.values(BATCH_MODEL_STATUS).includes(model.status)
        ) {
            throw new Error(
                `Invalid status for batch model "${model.path}".`
            );
        }

        if (
            model.workflow !== null &&
            model.workflow !== undefined &&
            (
                typeof model.workflow !== "object" ||
                !model.workflow.id ||
                !Array.isArray(model.workflow.tasks)
            )
        ) {
            throw new Error(
                `Invalid workflow snapshot for "${model.path}".`
            );
        }
    }

    return batch;
}

/**
 * Save batch state for a specific Firefox tab.
 *
 * The batch object must contain only serializable data.
 *
 * @param {number|string} tabId
 * @param {Object} batch
 * @returns {Promise<Object>}
 */
export async function saveBatchState(tabId, batch) {
    const storage = getStorage();
    const key = getStorageKey(tabId);

    validateBatchState(batch);

    const record = {
        storageVersion: STORAGE_VERSION,
        tabId: Number(tabId),
        batch: cloneState(batch),
        savedAt: new Date().toISOString(),
    };

    await storage.set({
        [key]: record,
    });

    return cloneState(record);
}

/**
 * Retrieve the saved batch for a specific Firefox tab.
 *
 * Returns null when no batch has been saved.
 *
 * @param {number|string} tabId
 * @returns {Promise<Object|null>}
 */
export async function getBatchState(tabId) {
    const storage = getStorage();
    const key = getStorageKey(tabId);

    const result = await storage.get(key);
    const record = result[key];

    if (!record) {
        return null;
    }

    if (record.storageVersion !== STORAGE_VERSION) {
        throw new Error(
            `Unsupported batch storage version: ${record.storageVersion}`
        );
    }

    validateBatchState(record.batch);

    return cloneState(record);
}

/**
 * Update an existing batch state safely within this extension context.
 *
 * The updater receives a cloned batch object and must return
 * the updated batch object.
 *
 * @param {number|string} tabId
 * @param {(batch: Object) => Object|Promise<Object>} updater
 * @returns {Promise<Object>}
 */
export async function updateBatchState(tabId, updater) {
    if (typeof updater !== "function") {
        throw new TypeError("Batch updater must be a function.");
    }

    const key = getStorageKey(tabId);
    const previousLock = updateLocks.get(key) || Promise.resolve();

    let releaseLock;

    const currentLock = new Promise((resolve) => {
        releaseLock = resolve;
    });

    updateLocks.set(key, currentLock);

    await previousLock;

    try {
        const record = await getBatchState(tabId);

        if (!record) {
            throw new Error(
                `No saved batch exists for Firefox tab ${tabId}.`
            );
        }

        const currentBatch = cloneState(record.batch);
        const updatedBatch = await updater(currentBatch);

        validateBatchState(updatedBatch);

        if (updatedBatch.id !== currentBatch.id) {
            throw new Error("An update cannot change the batch ID.");
        }

        return await saveBatchState(tabId, updatedBatch);
    } finally {
        releaseLock();

        if (updateLocks.get(key) === currentLock) {
            updateLocks.delete(key);
        }
    }
}

/**
 * Remove the saved batch for a specific Firefox tab.
 *
 * @param {number|string} tabId
 * @returns {Promise<void>}
 */
export async function removeBatchState(tabId) {
    const storage = getStorage();
    const key = getStorageKey(tabId);

    await storage.remove(key);
}

/**
 * Check whether a tab has a saved batch.
 *
 * @param {number|string} tabId
 * @returns {Promise<boolean>}
 */
export async function hasBatchState(tabId) {
    const record = await getBatchState(tabId);

    return record !== null;
}

/**
 * Retrieve all valid saved batch records.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getAllBatchStates() {
    const storage = getStorage();
    const allItems = await storage.get(null);

    return Object.entries(allItems)
        .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
        .map(([key, record]) => {
            if (record.storageVersion !== STORAGE_VERSION) {
                return null;
            }

            try {
                validateBatchState(record.batch);

                return {
                    key,
                    ...cloneState(record),
                };
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * Remove all saved batch records.
 *
 * This does not affect individual workflow states or the manual prompt queue.
 *
 * @returns {Promise<number>}
 */
export async function clearAllBatchStates() {
    const storage = getStorage();
    const allItems = await storage.get(null);

    const keys = Object.keys(allItems).filter((key) =>
        key.startsWith(STORAGE_KEY_PREFIX)
    );

    if (keys.length > 0) {
        await storage.remove(keys);
    }

    return keys.length;
}