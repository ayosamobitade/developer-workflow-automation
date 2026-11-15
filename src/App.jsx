import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, FolderTree, HardDrive, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import DjangoModelWorkflowPanel from "./features/workflows/components/DjangoModelWorkflowPanel";
import { generateFileTree } from "./features/file-tree/treeGenerator";

const NATIVE_MESSAGE_TYPE = "PROMPTFLOW_NATIVE";
const WORKSPACE_STORAGE_PREFIX = "promptflow_workspace_";
const SESSION_RENEWAL_BUFFER_SECONDS = 60;

async function sendNativeRequest(request) {
    if (!globalThis.browser?.runtime) {
        throw new Error("Firefox extension runtime is unavailable.");
    }

    const response = await browser.runtime.sendMessage({
        type: NATIVE_MESSAGE_TYPE,
        request,
    });

    if (!response) {
        throw new Error("The native host returned an empty response.");
    }

    if (!response.ok) {
        throw new Error(response.error || "Native messaging request failed.");
    }

    return response;
}

async function sendPromptToChatGPT(prompt, shouldSend = true, waitForResponse = false, timeout, targetTabId = null) {
    if (!prompt?.trim()) {
        throw new Error("There is no prompt to send.");
    }

    if (!globalThis.browser?.tabs) {
        throw new Error("Firefox extension APIs are unavailable. Open PromptFlow from the Firefox sidebar.");
    }

    if (waitForResponse && !shouldSend) {
        throw new Error("Response monitoring requires the prompt to be sent.");
    }

    let targetTab;
    if (targetTabId !== null && targetTabId !== undefined) {
        try {
            targetTab = await browser.tabs.get(targetTabId);
        } catch {
            throw new Error("The ChatGPT tab used by this workflow is no longer available.");
        }
    } else {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        targetTab = tabs[0];
    }

    if (!targetTab?.id) {
        throw new Error("No target browser tab was found.");
    }

    const isChatGPT =
        targetTab.url?.startsWith("https://chatgpt.com/") ||
        targetTab.url?.startsWith("https://chat.openai.com/");

    if (!isChatGPT) {
        throw new Error("The selected tab is not a ChatGPT tab. Open ChatGPT before starting the workflow.");
    }

    const message = {
        type: waitForResponse
            ? "PROMPTFLOW_INSERT_AND_WAIT"
            : shouldSend
                ? "PROMPTFLOW_INSERT_AND_SEND"
                : "PROMPTFLOW_INSERT_PROMPT",
        prompt,
    };

    if (waitForResponse && timeout) {
        message.timeout = timeout;
    }

    const response = await browser.tabs.sendMessage(targetTab.id, message);
    if (!response?.success) {
        throw new Error(response?.error || "Unable to process the prompt.");
    }

    if (waitForResponse && typeof response.response?.text !== "string") {
        throw new Error("ChatGPT finished, but PromptFlow did not receive a valid response.");
    }

    return response;
}

function isSessionValid(token, expiresAt) {
    return Boolean(token) &&
        Number.isFinite(expiresAt) &&
        Date.now() / 1000 < expiresAt - SESSION_RENEWAL_BUFFER_SECONDS;
}

function App() {
    const [activeTabId, setActiveTabId] = useState(null);
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const [nativeConnected, setNativeConnected] = useState(false);
    const [nativeVersion, setNativeVersion] = useState("");
    const [nativeProjects, setNativeProjects] = useState([]);
    const [nativeProjectId, setNativeProjectId] = useState("");
    const [nativeProjectName, setNativeProjectName] = useState("");
    const [nativeProjectFiles, setNativeProjectFiles] = useState([]);
    const [nativeWorkingDirectory, setNativeWorkingDirectory] = useState("");
    const [nativeProjectDirectories, setNativeProjectDirectories] = useState([]);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isChangingDirectory, setIsChangingDirectory] = useState(false);
    const [error, setError] = useState("");
    const [nativeError, setNativeError] = useState("");
    const [notice, setNotice] = useState("");
    const sessionsRef = useRef(new Map());
    const workspaceRestoreSequenceRef = useRef(0);

    const createSession = useCallback(async (projectId, directory = "", permission = "read", confirmed = false) => {
        return sendNativeRequest({
            action: "create_session",
            project_id: projectId,
            directory,
            permission,
            confirmed,
        });
    }, []);

    const revokeSession = useCallback(async (token) => {
        if (!token) return;
        await sendNativeRequest({ action: "revoke_session", token });
    }, []);

    const getSessionRecord = useCallback((tabId, projectId) => {
        if (tabId === null || tabId === undefined) {
            throw new Error("An active browser tab is required.");
        }

        let record = sessionsRef.current.get(tabId);
        if (!record || record.projectId !== projectId) {
            record = {
                projectId,
                rootReadToken: null,
                rootReadExpiresAt: null,
                readToken: null,
                readExpiresAt: null,
                readDirectory: null,
                writeToken: null,
                writeExpiresAt: null,
                writeDirectory: null,
            };
            sessionsRef.current.set(tabId, record);
        }
        return record;
    }, []);

    const revokeTabSessions = useCallback(async (tabId) => {
        const record = sessionsRef.current.get(tabId);
        if (!record) return;
        sessionsRef.current.delete(tabId);
        const tokens = [...new Set([
            record.rootReadToken,
            record.readToken,
            record.writeToken,
        ].filter(Boolean))];
        await Promise.allSettled(tokens.map(revokeSession));
    }, [revokeSession]);

    const ensureReadSession = useCallback(async (projectId, directory = "", tabId) => {
        if (!projectId) throw new Error("A registered project is required.");

        let record = sessionsRef.current.get(tabId);
        if (record && record.projectId !== projectId) {
            await revokeTabSessions(tabId);
            record = null;
        }
        record = getSessionRecord(tabId, projectId);

        if (!isSessionValid(record.rootReadToken, record.rootReadExpiresAt)) {
            const previousRootToken = record.rootReadToken;
            const rootSession = await createSession(projectId, "", "read");
            record.rootReadToken = rootSession.token;
            record.rootReadExpiresAt = rootSession.expires_at;

            if (record.readToken === previousRootToken) {
                record.readToken = null;
                record.readExpiresAt = null;
                record.readDirectory = null;
            }
            if (previousRootToken) await revokeSession(previousRootToken);
        }

        if (directory === "") {
            const previousReadToken = record.readToken;
            const previousWriteToken = record.writeToken;
            record.readToken = record.rootReadToken;
            record.readExpiresAt = record.rootReadExpiresAt;
            record.readDirectory = "";
            record.writeToken = null;
            record.writeExpiresAt = null;
            record.writeDirectory = null;

            const tokens = [...new Set([
                previousReadToken !== record.rootReadToken ? previousReadToken : null,
                previousWriteToken,
            ].filter(Boolean))];
            await Promise.allSettled(tokens.map(revokeSession));
            return record.readToken;
        }

        if (
            record.readDirectory === directory &&
            isSessionValid(record.readToken, record.readExpiresAt)
        ) {
            return record.readToken;
        }

        const previousReadToken = record.readToken;
        const previousWriteToken = record.writeToken;
        const scopedSession = await createSession(projectId, directory, "read");
        record.readToken = scopedSession.token;
        record.readExpiresAt = scopedSession.expires_at;
        record.readDirectory = directory;
        record.writeToken = null;
        record.writeExpiresAt = null;
        record.writeDirectory = null;

        const tokens = [...new Set([
            previousReadToken !== record.rootReadToken ? previousReadToken : null,
            previousWriteToken,
        ].filter(Boolean))];
        await Promise.allSettled(tokens.map(revokeSession));
        return record.readToken;
    }, [createSession, getSessionRecord, revokeSession, revokeTabSessions]);

    const ensureWriteSession = useCallback(async (projectId, directory = nativeWorkingDirectory, tabId = activeTabId) => {
        await ensureReadSession(projectId, directory, tabId);
        const record = getSessionRecord(tabId, projectId);

        if (
            record.writeDirectory === directory &&
            isSessionValid(record.writeToken, record.writeExpiresAt)
        ) {
            return record.writeToken;
        }

        if (record.writeToken) {
            await revokeSession(record.writeToken);
            record.writeToken = null;
            record.writeExpiresAt = null;
            record.writeDirectory = null;
        }

        const confirmed = window.confirm([
            "ENABLE LOCAL PROJECT WRITING",
            "",
            `Project: ${nativeProjectName}`,
            `Working directory: ${directory || "Project root"}`,
            "",
            "PromptFlow may create or update files within this directory.",
            "Existing files are backed up before they are overwritten.",
            "This authorization expires after 8 hours or when revoked.",
            "",
            "Do you explicitly authorize local file writing?",
        ].join("\n"));

        if (!confirmed) throw new Error("Write authorization was not granted.");

        const response = await createSession(projectId, directory, "write", true);
        record.writeToken = response.token;
        record.writeExpiresAt = response.expires_at;
        record.writeDirectory = directory;
        return record.writeToken;
    }, [activeTabId, createSession, ensureReadSession, getSessionRecord, nativeProjectName, nativeWorkingDirectory, revokeSession]);

    const getProjectFiles = useCallback(async (projectId, directory = nativeWorkingDirectory) => {
        const token = await ensureReadSession(projectId, directory, activeTabId);
        const response = await sendNativeRequest({
            action: "list_files",
            project_id: projectId,
            directory,
            token,
        });
        return response.files || [];
    }, [activeTabId, ensureReadSession, nativeWorkingDirectory]);

    const restoreWorkspace = useCallback(async (tabId) => {
        const restoreSequence = ++workspaceRestoreSequenceRef.current;
        const isCurrentRestore = () =>
            workspaceRestoreSequenceRef.current === restoreSequence;

        setWorkspaceReady(false);
        setError("");
        setNotice("");
        setNativeError("");

        // Clear the previous tab's workspace immediately. The new tab's
        // project context is loaded independently below.
        setNativeProjectId("");
        setNativeProjectName("");
        setNativeWorkingDirectory("");
        setNativeProjectFiles([]);
        setNativeProjectDirectories([]);

        try {
            const key = `${WORKSPACE_STORAGE_PREFIX}${tabId}`;
            const saved = await browser.storage.local.get(key);

            if (!isCurrentRestore()) return;

            const workspace = saved[key];
            const projectId = workspace?.nativeProjectId || workspace?.projectId;
            const projectName = workspace?.nativeProjectName || workspace?.projectName || "";
            const workingDirectory = workspace?.nativeWorkingDirectory || workspace?.workingDirectory || "";

            if (!projectId) {
                return;
            }

            setNativeProjectId(projectId);
            setNativeProjectName(projectName);
            setNativeWorkingDirectory(workingDirectory);

            const rootToken = await ensureReadSession(projectId, "", tabId);
            const [allFilesResponse, directoryResponse] = await Promise.all([
                sendNativeRequest({
                    action: "list_files",
                    project_id: projectId,
                    directory: "",
                    token: rootToken,
                }),
                sendNativeRequest({
                    action: "list_directories",
                    project_id: projectId,
                    directory: "",
                    token: rootToken,
                }),
            ]);

            if (!isCurrentRestore()) return;

            const scopedToken = await ensureReadSession(
                projectId,
                workingDirectory,
                tabId
            );
            const scopedResponse = await sendNativeRequest({
                action: "list_files",
                project_id: projectId,
                directory: workingDirectory,
                token: scopedToken,
            });

            if (!isCurrentRestore()) return;

            setNativeProjectFiles(scopedResponse.files || []);
            setNativeProjectDirectories(directoryResponse.directories || []);
            setNativeConnected(true);
            setNativeVersion("");
            setNotice(`${projectName} restored. ${(allFilesResponse.files || []).length} project files detected.`);

        } catch (restoreError) {
            if (!isCurrentRestore()) return;

            await revokeTabSessions(tabId);

            if (!isCurrentRestore()) return;

            setNativeProjectId("");
            setNativeProjectName("");
            setNativeWorkingDirectory("");
            setNativeProjectFiles([]);
            setNativeProjectDirectories([]);
            setNativeError(restoreError.message || "Unable to restore the registered project.");

        } finally {
            if (isCurrentRestore()) {
                setWorkspaceReady(true);
            }
        }
    }, [ensureReadSession, revokeTabSessions]);

    useEffect(() => {
        if (!globalThis.browser?.tabs || !globalThis.browser?.storage?.local) {
            setWorkspaceReady(true);
            return undefined;
        }

        let mounted = true;
        const activate = async (tabId) => {
            setActiveTabId(tabId);
            await restoreWorkspace(tabId);
        };
        const onActivated = (info) => {
            if (mounted) void activate(info.tabId);
        };
        const onRemoved = (tabId) => {
            if (mounted) void revokeTabSessions(tabId);
        };

        browser.tabs.onActivated.addListener(onActivated);
        browser.tabs.onRemoved.addListener(onRemoved);
        browser.tabs.query({ active: true, currentWindow: true })
            .then((tabs) => {
                if (mounted && tabs[0]?.id !== undefined) {
                    void activate(tabs[0].id);
                } else if (mounted) {
                    setWorkspaceReady(true);
                }
            })
            .catch(() => {
                if (mounted) setWorkspaceReady(true);
            });

        return () => {
            mounted = false;
            workspaceRestoreSequenceRef.current += 1;
            browser.tabs.onActivated.removeListener(onActivated);
            browser.tabs.onRemoved.removeListener(onRemoved);

            // Do not revoke every project token when the sidebar closes:
            // background workflows may still be using those tab-scoped tokens.
            // Tokens are revoked on explicit disconnect, tab removal, or expiry.
        };
    }, [restoreWorkspace, revokeTabSessions]);

    useEffect(() => {
        if (!workspaceReady || activeTabId === null || !browser?.storage?.local) return;
        const key = `${WORKSPACE_STORAGE_PREFIX}${activeTabId}`;
        if (!nativeProjectId) {
            void browser.storage.local.remove(key);
            return;
        }
        void browser.storage.local.set({
            [key]: {
                nativeProjectId,
                nativeProjectName,
                nativeWorkingDirectory,
            },
        });
    }, [activeTabId, nativeProjectId, nativeProjectName, nativeWorkingDirectory, workspaceReady]);

    async function handleTestConnection() {
        setNativeError("");
        setError("");
        try {
            const response = await sendNativeRequest({ action: "ping" });
            setNativeConnected(true);
            setNativeVersion(response.version || "");
            setNotice(`Native companion connected. Version ${response.version || "unknown"}.`);
        } catch (err) {
            setNativeConnected(false);
            setNativeVersion("");
            setNativeError(err.message || "Unable to connect to the native companion.");
        }
    }

    async function handleLoadProjects() {
        setIsConnecting(true);
        setNativeError("");
        setError("");
        try {
            const ping = await sendNativeRequest({ action: "ping" });
            const response = await sendNativeRequest({ action: "list_projects" });
            setNativeConnected(true);
            setNativeVersion(ping.version || "");
            setNativeProjects(response.projects || []);
            setNotice(response.projects?.length
                ? `${response.projects.length} registered project(s) found.`
                : "No registered projects found. Register a project from the terminal first.");
        } catch (err) {
            setNativeConnected(false);
            setNativeProjects([]);
            setNativeError(err.message || "Unable to load registered projects.");
        } finally {
            setIsConnecting(false);
        }
    }

    async function handleConnectProject(projectId) {
        if (!projectId || isConnecting) return;
        const project = nativeProjects.find((item) => item.id === projectId);
        if (!project) {
            setNativeError("The selected registered project was not found.");
            return;
        }

        setIsConnecting(true);
        setNativeError("");
        setError("");
        try {
            const rootToken = await ensureReadSession(projectId, "", activeTabId);
            const [filesResponse, directoriesResponse] = await Promise.all([
                sendNativeRequest({
                    action: "list_files",
                    project_id: projectId,
                    directory: "",
                    token: rootToken,
                }),
                sendNativeRequest({
                    action: "list_directories",
                    project_id: projectId,
                    directory: "",
                    token: rootToken,
                }),
            ]);
            setNativeProjectId(projectId);
            setNativeProjectName(project.name);
            setNativeWorkingDirectory("");
            setNativeProjectFiles(filesResponse.files || []);
            setNativeProjectDirectories(directoriesResponse.directories || []);
            setNotice(`${project.name} connected. ${(filesResponse.files || []).length} files detected.`);
        } catch (err) {
            setNativeError(err.message || "Unable to connect the selected project.");
        } finally {
            setIsConnecting(false);
        }
    }

    async function handleChangeWorkingDirectory(directory) {
        if (!nativeProjectId || directory === nativeWorkingDirectory || isChangingDirectory) return;
        setIsChangingDirectory(true);
        setNativeError("");
        try {
            const files = await getProjectFiles(nativeProjectId, directory);
            setNativeWorkingDirectory(directory);
            setNativeProjectFiles(files);
            setNotice(`Working directory changed to ${directory || "project root"}. ${files.length} files detected.`);
        } catch (err) {
            setNativeError(err.message || "Unable to change the working directory.");
        } finally {
            setIsChangingDirectory(false);
        }
    }

    async function handleDisconnectProject() {
        if (!nativeProjectId) return;
        if (!window.confirm("Disconnect this project from PromptFlow? The registered project and its files will not be deleted.")) return;
        await revokeTabSessions(activeTabId);
        setNativeProjectId("");
        setNativeProjectName("");
        setNativeWorkingDirectory("");
        setNativeProjectFiles([]);
        setNativeProjectDirectories([]);
        setNotice("Native project disconnected.");
        setNativeError("");
    }

    const readNativeProjectFile = useCallback(async (projectId, path) => {
        const token = await ensureReadSession(projectId, nativeWorkingDirectory, activeTabId);
        return sendNativeRequest({
            action: "read_file",
            project_id: projectId,
            path,
            directory: nativeWorkingDirectory,
            token,
        });
    }, [activeTabId, ensureReadSession, nativeWorkingDirectory]);

    const writeNativeProjectFile = useCallback(async (projectId, path, content) => {
        const token = await ensureWriteSession(projectId, nativeWorkingDirectory, activeTabId);
        return sendNativeRequest({
            action: "write_file",
            project_id: projectId,
            path,
            content,
            directory: nativeWorkingDirectory,
            token,
        });
    }, [activeTabId, ensureWriteSession, nativeWorkingDirectory]);

    const getWorkflowAuthorization = useCallback(async () => {
        const readToken = await ensureReadSession(nativeProjectId, nativeWorkingDirectory, activeTabId);
        const writeToken = await ensureWriteSession(nativeProjectId, nativeWorkingDirectory, activeTabId);
        return { readToken, writeToken };
    }, [activeTabId, ensureReadSession, ensureWriteSession, nativeProjectId, nativeWorkingDirectory]);

    const ensureWriteAuthorization = useCallback(() => {
        return ensureWriteSession(nativeProjectId, nativeWorkingDirectory, activeTabId);
    }, [activeTabId, ensureWriteSession, nativeProjectId, nativeWorkingDirectory]);

    const treeText = nativeProjectFiles.length
        ? generateFileTree(
            nativeProjectFiles.map((path) => ({ path, name: path.split("/").pop() })),
            nativeProjectName
        )
        : "";

    if (!globalThis.browser?.tabs) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-slate-50 p-5 text-sm text-red-600">
                Firefox extension APIs are unavailable. Open PromptFlow from the Firefox sidebar.
            </main>
        );
    }

    return (
        <main className="min-h-screen space-y-5 bg-slate-50 p-5 text-slate-800">
            <header className="flex items-center gap-3 border-b bg-white px-5 py-4">
                <div className="rounded-lg bg-indigo-600 p-2 text-white">
                    <FolderTree size={22} />
                </div>
                <div>
                    <h1 className="text-lg font-bold">PromptFlow</h1>
                    <p className="text-xs text-slate-500">Automated Django model implementation</p>
                </div>
            </header>

            {!workspaceReady ? (
                <div className="rounded-xl border bg-white p-5 text-sm text-slate-500">
                    Loading the native project workspace...
                </div>
            ) : (
                <>
                    {error && (
                        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                            <AlertCircle size={18} className="shrink-0" />
                            {error}
                        </div>
                    )}
                    {notice && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                            {notice}
                        </div>
                    )}

                    <section className="rounded-xl border bg-white p-4">
                        <div className="mb-3 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <HardDrive size={18} />
                                <h2 className="font-semibold">Native Companion</h2>
                            </div>
                            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${nativeConnected ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"}`}>
                                {nativeConnected ? "Connected" : "Disconnected"}
                            </span>
                        </div>

                        <p className="mb-3 text-xs leading-relaxed text-slate-500">
                            Connect to a registered local project. PromptFlow reads source files and writes generated workflow outputs through the scoped native host.
                        </p>

                        {nativeConnected && (
                            <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-3">
                                <div className="flex items-center gap-2 text-sm font-medium text-green-800">
                                    <ShieldCheck size={16} />
                                    Native host is available.
                                </div>
                                <p className="mt-1 text-xs text-green-700">Version: {nativeVersion || "Unknown"}</p>
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-2">
                            <button
                                type="button"
                                onClick={handleTestConnection}
                                disabled={isConnecting}
                                className="flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            >
                                <RefreshCw size={15} />
                                Test Connection
                            </button>
                            <button
                                type="button"
                                onClick={handleLoadProjects}
                                disabled={isConnecting}
                                className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                            >
                                <FolderTree size={15} />
                                Load Projects
                            </button>
                        </div>

                        {nativeError && (
                            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                                {nativeError}
                            </div>
                        )}

                        {nativeProjects.length > 0 && !nativeProjectId && (
                            <div className="mt-4 space-y-2">
                                <label className="block text-xs font-semibold">Registered Projects</label>
                                {nativeProjects.map((project) => (
                                    <button
                                        key={project.id}
                                        type="button"
                                        onClick={() => handleConnectProject(project.id)}
                                        disabled={isConnecting}
                                        className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
                                    >
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm font-semibold">{project.name}</span>
                                            <span className="mt-1 block text-xs text-slate-500">Approved local project</span>
                                        </span>
                                        <span className="shrink-0 text-xs font-semibold text-indigo-600">Connect</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {isConnecting && (
                            <p className="mt-3 text-xs text-indigo-600">Connecting to the native project...</p>
                        )}

                        {nativeProjectId && (
                            <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3">
                                <p className="break-all text-sm font-semibold text-green-800">{nativeProjectName}</p>
                                <p className="mt-1 text-xs text-green-700">{nativeProjectFiles.length} files available in the selected directory.</p>

                                <label className="mb-2 mt-4 block text-xs font-semibold text-green-800">Working directory</label>
                                <select
                                    value={nativeWorkingDirectory}
                                    onChange={(event) => handleChangeWorkingDirectory(event.target.value)}
                                    disabled={isChangingDirectory}
                                    className="w-full rounded-lg border border-green-300 bg-white p-2 text-xs text-slate-700 disabled:opacity-50"
                                >
                                    {nativeProjectDirectories.map((directory) => (
                                        <option key={directory || "__project_root__"} value={directory}>
                                            {directory || "Project Root (Entire Project)"}
                                        </option>
                                    ))}
                                </select>

                                {isChangingDirectory && (
                                    <p className="mt-2 text-xs text-green-700">Loading working directory...</p>
                                )}

                                <button
                                    type="button"
                                    onClick={handleDisconnectProject}
                                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                                >
                                    <Unplug size={14} />
                                    Disconnect Native Project
                                </button>
                            </div>
                        )}

                        <p className="mt-3 text-xs leading-relaxed text-slate-500">
                            Register projects with <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">python3 native/host.py --register-project PATH</code>.
                        </p>
                    </section>

                    {nativeProjectId && (
                        <DjangoModelWorkflowPanel
                            activeTabId={activeTabId}
                            nativeProjectId={nativeProjectId}
                            nativeProjectName={nativeProjectName}
                            nativeWorkingDirectory={nativeWorkingDirectory}
                            nativeProjectFiles={nativeProjectFiles}
                            treeText={treeText}
                            readNativeProjectFile={readNativeProjectFile}
                            writeNativeProjectFile={writeNativeProjectFile}
                            getNativeProjectFiles={getProjectFiles}
                            getWorkflowAuthorization={getWorkflowAuthorization}
                            ensureWriteAuthorization={ensureWriteAuthorization}
                            sendPromptToChatGPT={sendPromptToChatGPT}
                        />
                    )}
                </>
            )}
        </main>
    );
}

export default App;
