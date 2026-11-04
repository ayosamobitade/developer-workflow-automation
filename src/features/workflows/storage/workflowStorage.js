// src/features/workflows/storage/workflowStorage.js

const STORAGE_KEY_PREFIX = "promptflow_workflow_";
const STORAGE_VERSION = 1;

const updateLocks = new Map();

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

function validateWorkflowState(workflow) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new TypeError("Workflow state must be an object.");
  }

  if (!workflow.id) {
    throw new Error("Workflow state must have an ID.");
  }

  if (!workflow.definitionId) {
    throw new Error("Workflow state must have a definition ID.");
  }

  if (!Array.isArray(workflow.tasks)) {
    throw new Error("Workflow state must contain a tasks array.");
  }

  for (const task of workflow.tasks) {
    if (!task || typeof task !== "object" || !task.id) {
      throw new Error("Every workflow task must have an ID.");
    }

    if (!Array.isArray(task.outputs)) {
      throw new Error(
        `Workflow task "${task.id}" must contain an outputs array.`
      );
    }
  }

  return workflow;
}

function cloneState(value) {
  return structuredClone(value);
}

/**
 * Save workflow state for a specific Firefox tab.
 *
 * The workflow object should contain only serializable data.
 *
 * @param {number|string} tabId
 * @param {Object} workflow
 * @returns {Promise<Object>}
 */
export async function saveWorkflowState(tabId, workflow) {
  const storage = getStorage();
  const key = getStorageKey(tabId);

  validateWorkflowState(workflow);

  const record = {
    storageVersion: STORAGE_VERSION,
    tabId: Number(tabId),
    workflow: cloneState(workflow),
    savedAt: new Date().toISOString(),
  };

  await storage.set({
    [key]: record,
  });

  return cloneState(record);
}

/**
 * Retrieve the workflow saved for a specific Firefox tab.
 *
 * Returns null when no workflow has been saved.
 *
 * @param {number|string} tabId
 * @returns {Promise<Object|null>}
 */
export async function getWorkflowState(tabId) {
  const storage = getStorage();
  const key = getStorageKey(tabId);

  const result = await storage.get(key);
  const record = result[key];

  if (!record) {
    return null;
  }

  if (record.storageVersion !== STORAGE_VERSION) {
    throw new Error(
      `Unsupported workflow storage version: ${record.storageVersion}`
    );
  }

  validateWorkflowState(record.workflow);

  return cloneState(record);
}

/**
 * Remove the saved workflow for a specific Firefox tab.
 *
 * @param {number|string} tabId
 * @returns {Promise<void>}
 */
export async function removeWorkflowState(tabId) {
  const storage = getStorage();
  const key = getStorageKey(tabId);

  await storage.remove(key);
}

/**
 * Check whether a tab has a saved workflow.
 *
 * @param {number|string} tabId
 * @returns {Promise<boolean>}
 */
export async function hasWorkflowState(tabId) {
  const record = await getWorkflowState(tabId);

  return record !== null;
}

/**
 * Update an existing workflow state safely within this extension context.
 *
 * The updater receives a cloned workflow object and must return
 * the updated workflow object.
 *
 * @param {number|string} tabId
 * @param {(workflow: Object) => Object|Promise<Object>} updater
 * @returns {Promise<Object>}
 */
export async function updateWorkflowState(tabId, updater) {
  if (typeof updater !== "function") {
    throw new TypeError("Workflow updater must be a function.");
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
    const record = await getWorkflowState(tabId);

    if (!record) {
      throw new Error(
        `No saved workflow exists for Firefox tab ${tabId}.`
      );
    }

    const currentWorkflow = cloneState(record.workflow);
    const updatedWorkflow = await updater(currentWorkflow);

    validateWorkflowState(updatedWorkflow);

    if (updatedWorkflow.id !== currentWorkflow.id) {
      throw new Error("An update cannot change the workflow ID.");
    }

    return await saveWorkflowState(tabId, updatedWorkflow);
  } finally {
    releaseLock();

    if (updateLocks.get(key) === currentLock) {
      updateLocks.delete(key);
    }
  }
}

/**
 * Retrieve all saved workflow records.
 *
 * Useful for recovery and cleanup operations.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getAllWorkflowStates() {
  const storage = getStorage();
  const allItems = await storage.get(null);

  return Object.entries(allItems)
    .filter(([key]) => key.startsWith(STORAGE_KEY_PREFIX))
    .map(([key, record]) => {
      if (record.storageVersion !== STORAGE_VERSION) {
        return null;
      }

      try {
        validateWorkflowState(record.workflow);

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
 * Remove all saved workflow states.
 *
 * This does not affect the existing manual prompt queue.
 *
 * @returns {Promise<number>} Number of removed workflow records.
 */
export async function clearAllWorkflowStates() {
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