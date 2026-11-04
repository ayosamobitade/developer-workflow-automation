const STORAGE_PREFIX = "promptflow_workspace_";
const LEGACY_STORAGE_KEY = "promptflow_queue";

function getStorageKey(tabId) {
    if (!Number.isInteger(tabId)) {
        throw new Error("A valid Firefox tab ID is required.");
    }

    return `${STORAGE_PREFIX}${tabId}`;
}

export async function saveQueue(tabId, workspace) {
    try {
        if (!globalThis.browser?.storage?.local) {
            throw new Error("Firefox local storage API is unavailable.");
        }

        await browser.storage.local.set({
            [getStorageKey(tabId)]: workspace,
        });

        return true;
    } catch (error) {
        console.error("Failed to save PromptFlow workspace:", error);
        return false;
    }
}

export async function loadQueue(tabId) {
    try {
        if (!globalThis.browser?.storage?.local) {
            throw new Error("Firefox local storage API is unavailable.");
        }

        const key = getStorageKey(tabId);
        const result = await browser.storage.local.get(key);

        if (result[key]) {
            return result[key];
        }

        // Migrate the previous shared queue into the first
        // tab-specific workspace that requests it.
        const legacyQueue = localStorage.getItem(
            LEGACY_STORAGE_KEY
        );

        if (legacyQueue) {
            try {
                const parsedQueue = JSON.parse(legacyQueue);

                if (
                    parsedQueue &&
                    Array.isArray(parsedQueue.files)
                ) {
                    await saveQueue(tabId, {
                        ...parsedQueue,
                        autoSend: false,
                    });

                    localStorage.removeItem(LEGACY_STORAGE_KEY);

                    return {
                        ...parsedQueue,
                        autoSend: false,
                    };
                }
            } catch (migrationError) {
                console.error(
                    "Failed to migrate the previous PromptFlow queue:",
                    migrationError
                );
            }
        }

        return null;
    } catch (error) {
        console.error("Failed to load PromptFlow workspace:", error);
        return null;
    }
}

export async function clearQueue(tabId) {
    try {
        if (!globalThis.browser?.storage?.local) {
            return false;
        }

        await browser.storage.local.remove(
            getStorageKey(tabId)
        );

        return true;
    } catch (error) {
        console.error("Failed to clear PromptFlow workspace:", error);
        return false;
    }
}