const DATABASE_NAME = "promptflow_projects";
const DATABASE_VERSION = 1;

const FILE_STORE = "projectFiles";
const PROJECT_STORE = "projects";

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            DATABASE_NAME,
            DATABASE_VERSION
        );

        request.onupgradeneeded = () => {
            const database = request.result;

            if (!database.objectStoreNames.contains(FILE_STORE)) {
                const store = database.createObjectStore(FILE_STORE, {
                    keyPath: ["tabId", "path"],
                });

                store.createIndex("tabId", "tabId", {
                    unique: false,
                });
            }

            if (!database.objectStoreNames.contains(PROJECT_STORE)) {
                database.createObjectStore(PROJECT_STORE, {
                    keyPath: "tabId",
                });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function saveProject(tabId, project) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(
            [FILE_STORE, PROJECT_STORE],
            "readwrite"
        );

        const fileStore = transaction.objectStore(FILE_STORE);
        const projectStore = transaction.objectStore(PROJECT_STORE);

        const index = fileStore.index("tabId");
        const cursorRequest = index.openCursor(
            IDBKeyRange.only(tabId)
        );

        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;

            if (cursor) {
                cursor.delete();
                cursor.continue();
                return;
            }

            projectStore.put({
                tabId,
                name: project.name,
                fileCount: project.files.length,
                updatedAt: new Date().toISOString(),
            });

            project.files.forEach((file) => {
                fileStore.put({
                    tabId,
                    path: file.path,
                    name: file.name,
                    size: file.size,
                    content: file.content,
                });
            });
        };

        transaction.oncomplete = () => {
            database.close();
            resolve(true);
        };

        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };

        transaction.onabort = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

export async function loadProject(tabId) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(
            [FILE_STORE, PROJECT_STORE],
            "readonly"
        );

        const projectRequest = transaction
            .objectStore(PROJECT_STORE)
            .get(tabId);

        const filesRequest = transaction
            .objectStore(FILE_STORE)
            .index("tabId")
            .getAll(IDBKeyRange.only(tabId));

        transaction.oncomplete = () => {
            database.close();

            const project = projectRequest.result;

            if (!project) {
                resolve(null);
                return;
            }

            resolve({
                name: project.name,
                files: filesRequest.result || [],
            });
        };

        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

export async function clearProject(tabId) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(
            [FILE_STORE, PROJECT_STORE],
            "readwrite"
        );

        const fileStore = transaction.objectStore(FILE_STORE);
        const index = fileStore.index("tabId");

        const cursorRequest = index.openCursor(
            IDBKeyRange.only(tabId)
        );

        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;

            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };

        transaction.objectStore(PROJECT_STORE).delete(tabId);

        transaction.oncomplete = () => {
            database.close();
            resolve(true);
        };

        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}