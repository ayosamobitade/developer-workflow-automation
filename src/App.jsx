import { useEffect, useMemo, useRef, useState } from "react";

import DjangoModelWorkflowPanel from "./features/workflows/components/DjangoModelWorkflowPanel";

import {
    FolderTree,
    FileText,
    Settings,
    ListOrdered,
    ClipboardCopy,
    CheckCircle2,
    SkipForward,
    RotateCcw,
    AlertCircle,
    Circle,
    Send,
    Zap,
    HardDrive,
    RefreshCw,
    Save,
    ShieldCheck,
    Unplug,
} from "lucide-react";

import { parseFileTree } from "./features/file-tree/treeParser";
import { generateFileTree } from "./features/file-tree/treeGenerator";
import { generatePrompt } from "./features/prompt-queue/promptGenerator";

import {
    loadQueue,
    saveQueue,
} from "./features/prompt-queue/queueStorage";

import {
    readProjectDirectory,
} from "./features/local-project/projectReader";

import {
    loadProject,
    saveProject,
    clearProject,
} from "./features/local-project/projectStorage";


const DEFAULT_TEMPLATE =
    "Please, give me the comprehensive model file for {{file}}.";

const DEFAULT_STATE = {
    treeText: "",
    template: DEFAULT_TEMPLATE,
    files: [],
    currentIndex: 0,
    autoSend: false,
    includeSourceContext: false,
};

const NATIVE_MESSAGE_TYPE = "PROMPTFLOW_NATIVE";


/*
 * CHATGPT COMMUNICATION
 */

async function sendPromptToChatGPT(
    prompt,
    shouldSend = false,
    waitForResponse = false,
    timeout,
    targetTabId = null
) {
    if (!prompt?.trim()) {
        throw new Error("There is no prompt to send.");
    }

    if (!globalThis.browser?.tabs) {
        throw new Error(
            "Firefox extension APIs are unavailable. Open PromptFlow from the Firefox sidebar."
        );
    }

    if (waitForResponse && !shouldSend) {
        throw new Error(
            "Response monitoring requires the prompt to be sent."
        );
    }

    let targetTab;

    if (targetTabId !== null && targetTabId !== undefined) {
        try {
            targetTab = await browser.tabs.get(targetTabId);
        } catch {
            throw new Error(
                "The ChatGPT tab used by this workflow is no longer available."
            );
        }
    } else {
        const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
        });

        targetTab = tabs[0];
    }

    if (!targetTab?.id) {
        throw new Error("No target browser tab was found.");
    }

    const isChatGPT =
        targetTab.url?.startsWith("https://chatgpt.com/") ||
        targetTab.url?.startsWith("https://chat.openai.com/");

    if (!isChatGPT) {
        throw new Error(
            "The target tab is not a ChatGPT tab. Open ChatGPT in the selected tab before continuing."
        );
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

    const response = await browser.tabs.sendMessage(
        targetTab.id,
        message
    );

    if (!response?.success) {
        throw new Error(
            response?.error || "Unable to process the prompt."
        );
    }

    if (
        waitForResponse &&
        typeof response.response?.text !== "string"
    ) {
        throw new Error(
            "ChatGPT finished, but PromptFlow did not receive a valid response."
        );
    }

    return response;
}

// async function sendPromptToChatGPT(
//     prompt,
//     shouldSend = false,
//     waitForResponse = false,
//     timeout
// ) {
//     if (!prompt?.trim()) {
//         throw new Error("There is no prompt to send.");
//     }

//     if (!globalThis.browser?.tabs) {
//         throw new Error(
//             "Firefox extension APIs are unavailable. Open PromptFlow from the Firefox sidebar."
//         );
//     }

//     if (waitForResponse && !shouldSend) {
//         throw new Error(
//             "Response monitoring requires the prompt to be sent."
//         );
//     }

//     const tabs = await browser.tabs.query({
//         active: true,
//         currentWindow: true,
//     });

//     const activeTab = tabs[0];

//     if (!activeTab?.id) {
//         throw new Error("No active browser tab was found.");
//     }

//     const isChatGPT =
//         activeTab.url?.startsWith("https://chatgpt.com/") ||
//         activeTab.url?.startsWith("https://chat.openai.com/");

//     if (!isChatGPT) {
//         throw new Error(
//             "Open ChatGPT in the active tab before using this action."
//         );
//     }

//     const message = {
//         type: waitForResponse
//             ? "PROMPTFLOW_INSERT_AND_WAIT"
//             : shouldSend
//                 ? "PROMPTFLOW_INSERT_AND_SEND"
//                 : "PROMPTFLOW_INSERT_PROMPT",

//         prompt,
//     };

//     if (waitForResponse && timeout) {
//         message.timeout = timeout;
//     }

//     const response = await browser.tabs.sendMessage(
//         activeTab.id,
//         message
//     );

//     if (!response?.success) {
//         throw new Error(
//             response?.error || "Unable to process the prompt."
//         );
//     }

//     if (
//         waitForResponse &&
//         typeof response.response?.text !== "string"
//     ) {
//         throw new Error(
//             "ChatGPT finished, but PromptFlow did not receive a valid response."
//         );
//     }

//     return response;
// }


/*
 * NATIVE MESSAGING
 *
 * All native host requests go through background.js.
 */

async function sendNativeRequest(request) {
    if (!globalThis.browser?.runtime) {
        throw new Error(
            "Firefox extension runtime is unavailable."
        );
    }

    const response = await browser.runtime.sendMessage({
        type: NATIVE_MESSAGE_TYPE,
        request,
    });

    if (!response) {
        throw new Error(
            "The native host returned an empty response."
        );
    }

    if (!response.ok) {
        throw new Error(
            response.error || "Native messaging request failed."
        );
    }

    return response;
}


async function testNativeHost() {
    return sendNativeRequest({
        action: "ping",
    });
}


async function getNativeProjects() {
    const response = await sendNativeRequest({
        action: "list_projects",
    });

    return response.projects || [];
}


async function createNativeAuthorizationSession(
    projectId,
    directory = "",
    permission = "read",
    confirmed = false
) {
    return sendNativeRequest({
        action: "create_session",
        project_id: projectId,
        directory,
        permission,
        confirmed,
    });
}


async function revokeNativeAuthorizationSession(token) {
    if (!token) {
        return {
            ok: true,
            revoked: false,
        };
    }

    return sendNativeRequest({
        action: "revoke_session",
        token,
    });
}


async function getNativeProjectFiles(
    projectId,
    directory = "",
    token
) {
    const response = await sendNativeRequest({
        action: "list_files",
        project_id: projectId,
        directory,
        token,
    });

    return response.files || [];
}


async function getNativeProjectDirectories(
    projectId,
    directory = "",
    token
) {
    const response = await sendNativeRequest({
        action: "list_directories",
        project_id: projectId,
        directory,
        token,
    });

    return response.directories || [];
}


async function readNativeProjectFile(
    projectId,
    path,
    directory = "",
    token
) {
    return sendNativeRequest({
        action: "read_file",
        project_id: projectId,
        path,
        directory,
        token,
    });
}


async function writeNativeProjectFile(
    projectId,
    path,
    content,
    directory = "",
    token
) {
    return sendNativeRequest({
        action: "write_file",
        project_id: projectId,
        path,
        content,
        directory,
        token,
    });
}


function buildNativeProjectWorkspace(filePaths, projectName) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return {
            tree: "",
            files: [],
        };
    }

    const entries = filePaths.map((path) => ({
        path,
        name: path.split("/").pop(),
    }));

    const tree = generateFileTree(entries, projectName);

    return {
        tree,
        files: parseFileTree(tree),
    };
}

/*
 * APP
 */

function App() {
    // ---------------------------------------------------------
    // WORKSPACE STATE
    // ---------------------------------------------------------

    const [treeText, setTreeText] = useState(
        DEFAULT_STATE.treeText
    );

    const [template, setTemplate] = useState(
        DEFAULT_STATE.template
    );

    const [files, setFiles] = useState(
        DEFAULT_STATE.files
    );

    const [currentIndex, setCurrentIndex] = useState(
        DEFAULT_STATE.currentIndex
    );

    const [autoSend, setAutoSend] = useState(
        DEFAULT_STATE.autoSend
    );

    const [includeSourceContext, setIncludeSourceContext] =
        useState(DEFAULT_STATE.includeSourceContext);


    // ---------------------------------------------------------
    // BROWSER TAB STATE
    // ---------------------------------------------------------

    const [activeTabId, setActiveTabId] = useState(null);
    const [loadedTabId, setLoadedTabId] = useState(null);

    const isWorkspaceReady =
        activeTabId !== null && loadedTabId === activeTabId;

    // ---------------------------------------------------------
    // CHATGPT EXECUTION STATE
    // ---------------------------------------------------------

    const [isSending, setIsSending] = useState(false);


    // ---------------------------------------------------------
    // BROWSER-READ PROJECT STATE
    // ---------------------------------------------------------

    const [projectName, setProjectName] = useState("");
    const [projectFiles, setProjectFiles] = useState([]);
    const [isReadingProject, setIsReadingProject] = useState(false);

    const folderInputRef = useRef(null);


    // ---------------------------------------------------------
    // NATIVE PROJECT STATE
    // ---------------------------------------------------------
    const nativeSessionsRef = useRef(new Map());

    const [nativeConnected, setNativeConnected] = useState(false);
    const [nativeVersion, setNativeVersion] = useState("");

    const [nativeProjects, setNativeProjects] = useState([]);
    const [nativeProjectId, setNativeProjectId] = useState("");
    const [nativeProjectName, setNativeProjectName] = useState("");

    const [nativeProjectFiles, setNativeProjectFiles] = useState([]);

    const [nativeProjectAllFiles, setNativeProjectAllFiles] =
        useState([]);

    const [nativeProjectDirectories, setNativeProjectDirectories] =
    useState([]);

    const [nativeWorkingDirectory, setNativeWorkingDirectory] =
        useState("");

    const [isChangingWorkingDirectory, setIsChangingWorkingDirectory] =
        useState(false);

    const [isConnectingNative, setIsConnectingNative] = useState(false);
    const [isLoadingNativeFiles, setIsLoadingNativeFiles] = useState(false);
    const [isReadingNativeFile, setIsReadingNativeFile] = useState(false);
    const [isWritingNativeFile, setIsWritingNativeFile] = useState(false);

    const [nativeSourceContent, setNativeSourceContent] = useState("");
    const [nativeSourcePath, setNativeSourcePath] = useState("");

    const [nativeWriteContent, setNativeWriteContent] = useState("");
    const [nativeWritePath, setNativeWritePath] = useState("");

    const [showNativeWriteEditor, setShowNativeWriteEditor] =
        useState(false);

    const [nativeError, setNativeError] = useState("");


    // ---------------------------------------------------------
    // NOTIFICATIONS
    // ---------------------------------------------------------

    const [error, setError] = useState("");
    const [message, setMessage] = useState("");

// ---------------------------------------------------------
// NATIVE AUTHORIZATION SESSION MANAGEMENT
// ---------------------------------------------------------

const SESSION_RENEWAL_BUFFER_SECONDS = 60;


function isNativeSessionValid(token, expiresAt) {
    if (!token || !Number.isFinite(expiresAt)) {
        return false;
    }

    const currentTime = Date.now() / 1000;

    return (
        currentTime <
        expiresAt - SESSION_RENEWAL_BUFFER_SECONDS
    );
}


function getNativeSessionRecord(tabId, projectId) {
    if (tabId === null || tabId === undefined) {
        throw new Error("An active browser tab is required.");
    }

    const sessions = nativeSessionsRef.current;

    let record = sessions.get(tabId);

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

        sessions.set(tabId, record);
    }

    return record;
}


async function revokeNativeSessionTokens(record) {
    if (!record) return;

    const tokens = [
        record.rootReadToken,
        record.readToken,
        record.writeToken,
    ];

    const uniqueTokens = [
        ...new Set(tokens.filter(Boolean)),
    ];

    await Promise.allSettled(
        uniqueTokens.map((token) =>
            revokeNativeAuthorizationSession(token)
        )
    );
}


async function ensureNativeReadSession(
    projectId,
    directory = "",
    tabId = activeTabId
) {
    if (!projectId) {
        throw new Error("A registered project is required.");
    }

    const sessions = nativeSessionsRef.current;

    let record = sessions.get(tabId);

    // Revoke sessions belonging to a previously connected project.
    if (record && record.projectId !== projectId) {
        await revokeNativeSessionTokens(record);

        sessions.delete(tabId);

        record = null;
    }

    record = getNativeSessionRecord(tabId, projectId);

    // -----------------------------------------------------
    // ROOT READ SESSION
    // -----------------------------------------------------

    if (
        !isNativeSessionValid(
            record.rootReadToken,
            record.rootReadExpiresAt
        )
    ) {
        const previousRootToken = record.rootReadToken;

        const rootSession = await createNativeAuthorizationSession(
            projectId,
            "",
            "read"
        );

        record.rootReadToken = rootSession.token;
        record.rootReadExpiresAt = rootSession.expires_at;

        // Remove references to the previous root token.
        if (record.readToken === previousRootToken) {
            record.readToken = null;
            record.readExpiresAt = null;
            record.readDirectory = null;
        }

        if (previousRootToken) {
            await revokeNativeAuthorizationSession(
                previousRootToken
            );
        }
    }

    // -----------------------------------------------------
    // PROJECT ROOT DIRECTORY
    // -----------------------------------------------------

    if (directory === "") {
        const previousReadToken = record.readToken;
        const previousWriteToken = record.writeToken;

        record.readToken = record.rootReadToken;
        record.readExpiresAt = record.rootReadExpiresAt;
        record.readDirectory = "";

        record.writeToken = null;
        record.writeExpiresAt = null;
        record.writeDirectory = null;

        const tokensToRevoke = [
            previousReadToken !== record.rootReadToken
                ? previousReadToken
                : null,

            previousWriteToken,
        ].filter(Boolean);

        await Promise.allSettled(
            [...new Set(tokensToRevoke)].map((token) =>
                revokeNativeAuthorizationSession(token)
            )
        );

        return record.readToken;
    }

    // -----------------------------------------------------
    // WORKING DIRECTORY READ SESSION
    // -----------------------------------------------------

    if (
        record.readDirectory === directory &&
        isNativeSessionValid(
            record.readToken,
            record.readExpiresAt
        )
    ) {
        return record.readToken;
    }

    const previousReadToken = record.readToken;
    const previousWriteToken = record.writeToken;

    const scopedSession = await createNativeAuthorizationSession(
        projectId,
        directory,
        "read"
    );

    record.readToken = scopedSession.token;
    record.readExpiresAt = scopedSession.expires_at;
    record.readDirectory = directory;

    // A directory change invalidates the previous write authorization.
    record.writeToken = null;
    record.writeExpiresAt = null;
    record.writeDirectory = null;

    const tokensToRevoke = [
        previousReadToken !== record.rootReadToken
            ? previousReadToken
            : null,

        previousWriteToken,
    ].filter(Boolean);

    await Promise.allSettled(
        [...new Set(tokensToRevoke)].map((token) =>
            revokeNativeAuthorizationSession(token)
        )
    );

    return record.readToken;
}


async function ensureNativeWriteSession(
    projectId,
    directory = nativeWorkingDirectory,
    tabId = activeTabId
) {
    if (!projectId) {
        throw new Error("A registered project is required.");
    }

    // This also handles project changes and ensures the session
    // record belongs to the requested project.
    await ensureNativeReadSession(
        projectId,
        directory,
        tabId
    );

    const record = getNativeSessionRecord(
        tabId,
        projectId
    );

    // Reuse an unexpired write session for this exact directory.
    if (
        record.writeDirectory === directory &&
        isNativeSessionValid(
            record.writeToken,
            record.writeExpiresAt
        )
    ) {
        return record.writeToken;
    }

    // Revoke an expired or differently scoped write session.
    if (record.writeToken) {
        await revokeNativeAuthorizationSession(
            record.writeToken
        );

        record.writeToken = null;
        record.writeExpiresAt = null;
        record.writeDirectory = null;
    }

    // Explicit confirmation is required for every new write session.
    const confirmed = window.confirm(
        [
            "ENABLE LOCAL PROJECT WRITING",
            "",
            `Project: ${nativeProjectName}`,
            `Working directory: ${directory || "Project root"}`,
            "",
            "PromptFlow will be allowed to create and update files within this directory.",
            "Existing files will be backed up before they are overwritten.",
            "",
            "This authorization expires after 8 hours or when revoked.",
            "",
            "Do you explicitly authorize local file writing?",
        ].join("\n")
    );

    if (!confirmed) {
        throw new Error(
            "Write authorization was not granted."
        );
    }

    const response = await createNativeAuthorizationSession(
        projectId,
        directory,
        "write",
        true
    );

    record.writeToken = response.token;
    record.writeExpiresAt = response.expires_at;
    record.writeDirectory = directory;

    return record.writeToken;
}


async function revokeTabNativeSessions(tabId) {
    const sessions = nativeSessionsRef.current;

    const record = sessions.get(tabId);

    if (!record) return;

    // Remove the record immediately so it cannot be reused.
    sessions.delete(tabId);

    await revokeNativeSessionTokens(record);
}

    // ---------------------------------------------------------
    // CURRENT QUEUE INFORMATION
    // ---------------------------------------------------------

    const currentFile = files[currentIndex] || null;

    const completedCount = files.filter(
        (file) => file.status === "completed"
    ).length;

    const skippedCount = files.filter(
        (file) => file.status === "skipped"
    ).length;

    const processedCount = completedCount + skippedCount;

    const progress = files.length
        ? Math.round(
            (processedCount / files.length) * 100
        )
        : 0;


    // ---------------------------------------------------------
    // NATIVE PROJECT FILE LOOKUP
    // ---------------------------------------------------------

    const currentNativeFile = currentFile
        ? nativeProjectFiles.find(
            (file) => file === currentFile.path
        )
        : null;


    // ---------------------------------------------------------
    // LOAD ACTIVE TAB WORKSPACE
    // ---------------------------------------------------------

    useEffect(() => {
        let mounted = true;
        let requestSequence = 0;

        async function loadActiveTabWorkspace(tabId) {
            const requestId = ++requestSequence;

            setActiveTabId(tabId);
            setLoadedTabId(null);

            setError("");
            setMessage("");

            const savedWorkspace = await loadQueue(tabId);

            if (!mounted || requestId !== requestSequence) {
                return;
            }

            const workspace = {
                ...DEFAULT_STATE,
                ...(savedWorkspace || {}),
            };

            const restoredFiles = Array.isArray(workspace.files)
                ? workspace.files
                : [];

            const restoredIndex = Math.min(
                Math.max(
                    Number(workspace.currentIndex) || 0,
                    0
                ),
                restoredFiles.length
            );

            setTreeText(workspace.treeText || "");

            setTemplate(
                workspace.template || DEFAULT_TEMPLATE
            );

            setFiles(restoredFiles);
            setCurrentIndex(restoredIndex);

            setAutoSend(Boolean(workspace.autoSend));

            setIncludeSourceContext(
                Boolean(workspace.includeSourceContext)
            );

            setLoadedTabId(tabId);
        }

        function handleTabActivated(activeInfo) {
            loadActiveTabWorkspace(activeInfo.tabId)
                .catch((err) => {
                    if (mounted) {
                        setError(
                            err.message ||
                            "Unable to load the tab workspace."
                        );
                    }
                });
        }

        if (!globalThis.browser?.tabs) {
            return () => {
                mounted = false;
            };
        }

        browser.tabs.onActivated.addListener(
            handleTabActivated
        );

        browser.tabs.query({
            active: true,
            currentWindow: true,
        }).then((tabs) => {
            if (!mounted) return;

            const activeTab = tabs[0];

            if (activeTab?.id !== undefined) {
                loadActiveTabWorkspace(activeTab.id)
                    .catch((err) => {
                        if (mounted) {
                            setError(
                                err.message ||
                                "Unable to load the tab workspace."
                            );
                        }
                    });
            } else {
                setError(
                    "Could not identify the active browser tab."
                );
            }
        }).catch((err) => {
            if (mounted) {
                setError(
                    err.message ||
                    "Unable to identify the active browser tab."
                );
            }
        });

        return () => {
            mounted = false;

            browser.tabs.onActivated.removeListener(
                handleTabActivated
            );
        };
    }, []);


    // ---------------------------------------------------------
    // RESTORE BROWSER-READ PROJECT
    // ---------------------------------------------------------

    useEffect(() => {
        if (!isWorkspaceReady || activeTabId === null) {
            return;
        }

        let cancelled = false;

        async function restoreProject() {
            setProjectName("");
            setProjectFiles([]);

            try {
                const project = await loadProject(activeTabId);

                if (cancelled) return;

                setProjectName(project?.name || "");
                setProjectFiles(project?.files || []);
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err.message ||
                        "Unable to restore the local project."
                    );
                }
            }
        }

        restoreProject();

        return () => {
            cancelled = true;
        };
    }, [activeTabId, isWorkspaceReady]);


    // ---------------------------------------------------------
    // RESTORE NATIVE PROJECT WORKSPACE
    // ---------------------------------------------------------

    useEffect(() => {
        if (!isWorkspaceReady || activeTabId === null) {
            return;
        }

        let cancelled = false;

        async function restoreNativeProject() {
            const savedWorkspace = await loadQueue(activeTabId);

            if (cancelled || !savedWorkspace) return;

            if (
                savedWorkspace.nativeProjectId &&
                savedWorkspace.nativeProjectName
            ) {
                const projectId = savedWorkspace.nativeProjectId;
                const workingDirectory =
                    savedWorkspace.nativeWorkingDirectory || "";

                setNativeProjectId(projectId);
                setNativeProjectName(savedWorkspace.nativeProjectName);
                setNativeWorkingDirectory(workingDirectory);

                try {
 
                    const rootReadToken = await ensureNativeReadSession(
                        projectId,
                        "",
                        activeTabId
                    );

                    const [allFiles, directories] = await Promise.all([
                        getNativeProjectFiles(
                            projectId,
                            "",
                            rootReadToken
                        ),
                        getNativeProjectDirectories(
                            projectId,
                            "",
                            rootReadToken
                        ),
                    ]);

                    if (cancelled) return;

                    const scopedReadToken = await ensureNativeReadSession(
                        projectId,
                        workingDirectory,
                        activeTabId
                    );

                    const scopedFiles = await getNativeProjectFiles(
                        projectId,
                        workingDirectory,
                        scopedReadToken
                    );
                    if (cancelled) return;

                    setNativeProjectAllFiles(allFiles);
                    setNativeProjectDirectories(directories);
                    setNativeProjectFiles(scopedFiles);

                    const entries = scopedFiles.map((path) => ({
                        path,
                        name: path.split("/").pop(),
                    }));

                    const generatedTree = generateFileTree(
                        entries,
                        savedWorkspace.nativeProjectName
                    );

                    setTreeText(generatedTree);
                    setFiles(parseFileTree(generatedTree));
                    setCurrentIndex(0);
                    
                } catch {
                    if (!cancelled) {
                        await revokeTabNativeSessions(activeTabId);

                        setNativeProjectFiles([]);
                        setNativeProjectAllFiles([]);
                        setNativeProjectId("");
                        setNativeProjectName("");
                        setNativeWorkingDirectory("");
                        setNativeProjectDirectories([]);

                        setNativeSourceContent("");
                        setNativeSourcePath("");
                    }
                }
        
            }
        }

        restoreNativeProject();

        return () => {
            cancelled = true;
        };
    }, [activeTabId, isWorkspaceReady]);


    // ---------------------------------------------------------
    // PERSIST WORKSPACE
    // ---------------------------------------------------------

    // ---------------------------------------------------------
// PERSIST WORKSPACE
// ---------------------------------------------------------

useEffect(() => {
        if (!isWorkspaceReady) return;

        saveQueue(activeTabId, {
            treeText,
            template,
            files,
            currentIndex,
            autoSend,
            includeSourceContext,

            nativeProjectId,
            nativeProjectName,
            nativeWorkingDirectory,
        });
    }, [
        activeTabId,
        loadedTabId,
        isWorkspaceReady,
        treeText,
        template,
        files,
        currentIndex,
        autoSend,
        includeSourceContext,
        nativeProjectId,
        nativeProjectName,
        nativeWorkingDirectory,
    ]);
   
   

    // ---------------------------------------------------------
    // TEST NATIVE HOST
    // ---------------------------------------------------------

    async function handleTestNativeHost() {
        setNativeError("");
        setError("");
        setMessage("");

        setIsConnectingNative(true);

        try {
            const response = await testNativeHost();

            setNativeConnected(true);
            setNativeVersion(response.version || "");

            setMessage(
                `Native companion connected successfully. Version ${response.version || "unknown"}.`
            );

        } catch (err) {
            setNativeConnected(false);
            setNativeVersion("");

            setNativeError(
                err.message ||
                "Unable to connect to the PromptFlow native host."
            );

        } finally {
            setIsConnectingNative(false);
        }
    }


    // ---------------------------------------------------------
    // LOAD REGISTERED NATIVE PROJECTS
    // ---------------------------------------------------------

    async function handleLoadNativeProjects() {
        setNativeError("");
        setError("");
        setMessage("");

        setIsConnectingNative(true);

        try {
            const response = await testNativeHost();

            setNativeConnected(true);
            setNativeVersion(response.version || "");

            const projects = await getNativeProjects();

            setNativeProjects(projects);

            setMessage(
                projects.length
                    ? `${projects.length} registered local project(s) found.`
                    : "No registered projects found. Register a project from the terminal first."
            );

        } catch (err) {
            setNativeConnected(false);
            setNativeProjects([]);

            setNativeError(
                err.message ||
                "Unable to load registered native projects."
            );

        } finally {
            setIsConnectingNative(false);
        }
    }


    // ---------------------------------------------------------
    // CONNECT A NATIVE PROJECT
    // ---------------------------------------------------------

    async function handleConnectNativeProject(projectId) {
        if (!projectId || isLoadingNativeFiles) return;

        const project = nativeProjects.find(
            (item) => item.id === projectId
        );

        if (!project) {
            setNativeError("The selected registered project was not found.");
            return;
        }

        setIsLoadingNativeFiles(true);
        setNativeError("");
        setError("");
        setMessage("");

        try {
            const rootReadToken = await ensureNativeReadSession(
                projectId,
                "",
                activeTabId
            );

            const [allFiles, directories] = await Promise.all([
                getNativeProjectFiles(
                    projectId,
                    "",
                    rootReadToken
                ),
                getNativeProjectDirectories(
                    projectId,
                    "",
                    rootReadToken
                ),
            ]);

            const workspace = buildNativeProjectWorkspace(
                allFiles,
                project.name
            );

            setNativeProjectId(projectId);
            setNativeProjectName(project.name);

            setNativeProjectAllFiles(allFiles);
            setNativeProjectDirectories(directories);
            setNativeProjectFiles(allFiles);
            setNativeWorkingDirectory("");

            setProjectName("");
            setProjectFiles([]);

            setNativeSourceContent("");
            setNativeSourcePath("");

            setTreeText(workspace.tree);
            setFiles(workspace.files);
            setCurrentIndex(0);

            setIncludeSourceContext(false);

            setMessage(
                `${project.name} connected successfully. ${allFiles.length} files available.`
            );

        } catch (err) {
            setNativeError(
                err.message || "Unable to connect the selected native project."
            );

        } finally {
            setIsLoadingNativeFiles(false);
        }
    }


    async function handleChangeNativeWorkingDirectory(directory) {
        if (
            !nativeProjectId ||
            directory === nativeWorkingDirectory ||
            isChangingWorkingDirectory
        ) {
            return;
        }

        setIsChangingWorkingDirectory(true);
        setNativeError("");
        setError("");
        setMessage("");

        try {
            const scopedReadToken = await ensureNativeReadSession(
                nativeProjectId,
                directory,
                activeTabId
            );

            const scopedFiles = await getNativeProjectFiles(
                nativeProjectId,
                directory,
                scopedReadToken
            );

            const workspace = buildNativeProjectWorkspace(
                scopedFiles,
                nativeProjectName
            );

            setNativeWorkingDirectory(directory);
            setNativeProjectFiles(scopedFiles);

            setTreeText(workspace.tree);
            setFiles(workspace.files);
            setCurrentIndex(0);

            setNativeSourceContent("");
            setNativeSourcePath("");

            setMessage(
                directory
                    ? `Working directory changed to ${directory}. ${scopedFiles.length} files available.`
                    : `Working directory changed to project root. ${scopedFiles.length} files available.`
            );

        } catch (err) {
            setNativeError(
                err.message || "Unable to change the working directory."
            );

        } finally {
            setIsChangingWorkingDirectory(false);
        }
    }
    // ---------------------------------------------------------
    // READ CURRENT NATIVE FILE
    // ---------------------------------------------------------

    async function handleReadNativeFile(path = currentFile?.path) {
        if (!nativeProjectId || !path) {
            throw new Error(
                "Connect a native project and select a file first."
            );
        }

        setIsReadingNativeFile(true);
        setNativeError("");

        try {

            const readToken = await ensureNativeReadSession(
                nativeProjectId,
                nativeWorkingDirectory,
                activeTabId
            );

            const response = await readNativeProjectFile(
                nativeProjectId,
                path,
                nativeWorkingDirectory,
                readToken
            );

            setNativeSourcePath(path);
            setNativeSourceContent(response.content || "");

            return response;

        } catch (err) {
            setNativeSourceContent("");
            setNativeSourcePath("");

            setNativeError(
                err.message ||
                "Unable to read the selected project file."
            );

            throw err;

        } finally {
            setIsReadingNativeFile(false);
        }
    }


    // ---------------------------------------------------------
    // READ NATIVE SOURCE WHEN SOURCE CONTEXT IS ENABLED
    // ---------------------------------------------------------

    useEffect(() => {
        if (
            !isWorkspaceReady ||
            !nativeProjectId ||
            !currentFile ||
            !includeSourceContext ||
            !currentNativeFile
        ) {
            return;
        }

        let cancelled = false;

        async function loadCurrentNativeSource() {
            try {
       
                const readToken = await ensureNativeReadSession(
                    nativeProjectId,
                    nativeWorkingDirectory,
                    activeTabId
                );

                const response = await readNativeProjectFile(
                    nativeProjectId,
                    currentFile.path,
                    nativeWorkingDirectory,
                    readToken
                );

                if (cancelled) return;

                setNativeSourcePath(currentFile.path);
                setNativeSourceContent(response.content || "");

            } catch (err) {
                if (!cancelled) {
                    setNativeSourceContent("");
                    setNativeSourcePath("");

                    setNativeError(
                        err.message ||
                        "Unable to read the current native project file."
                    );
                }
            }
        }

        loadCurrentNativeSource();

        return () => {
            cancelled = true;
        };
    
    }, [
        isWorkspaceReady,
        nativeProjectId,
        nativeWorkingDirectory,
        currentFile,
        includeSourceContext,
        currentNativeFile,
    ]);

    // ---------------------------------------------------------
    // DISCONNECT NATIVE PROJECT
    // ---------------------------------------------------------

    async function handleDisconnectNativeProject() {
    if (!nativeProjectId) return;

    const confirmed = window.confirm(
        "Disconnect this native project from the current tab? The registered project and its files will not be deleted."
    );

    if (!confirmed) return;
    await revokeTabNativeSessions(activeTabId);

    setNativeProjectId("");
    setNativeProjectName("");
    setNativeProjectFiles([]);
    setNativeProjectAllFiles([]);
    setNativeWorkingDirectory("");

    setNativeProjectDirectories([]);

    setNativeSourceContent("");
    setNativeSourcePath("");

    setNativeWritePath("");
    setNativeWriteContent("");
    setShowNativeWriteEditor(false);

    setIncludeSourceContext(false);

    setMessage("Native project disconnected.");
    setNativeError("");
}

    // ---------------------------------------------------------
    // BROWSER PROJECT SOURCE LOOKUP
    // ---------------------------------------------------------

    const currentProjectFile = currentFile
        ? projectFiles.find(
            (file) => file.path === currentFile.path
        )
        : null;


    // ---------------------------------------------------------
    // GENERATE CURRENT PROMPT
    // ---------------------------------------------------------

    const currentPrompt = useMemo(() => {
        if (!currentFile) return "";

        try {
            const sourceContent = nativeProjectId
                ? (
                    nativeSourcePath === currentFile.path
                        ? nativeSourceContent
                        : ""
                )
                : (
                    currentProjectFile?.content || ""
                );

            return generatePrompt({
                tree: treeText,
                template,
                file: currentFile,

                sourceContent:
                    includeSourceContext
                        ? sourceContent
                        : "",
            });

        } catch {
            return "";
        }
    }, [
        treeText,
        template,
        currentFile,
        currentProjectFile,
        includeSourceContext,
        nativeProjectId,
        nativeSourcePath,
        nativeSourceContent,
    ]);


    // ---------------------------------------------------------
    // PARSE MANUAL FILE TREE
    // ---------------------------------------------------------

    function handleParseTree() {
        if (!isWorkspaceReady) return;

        setError("");
        setMessage("");

        try {
            const parsedFiles = parseFileTree(treeText);

            // Revoke native authorization when switching to a manual file tree.
            void revokeTabNativeSessions(activeTabId);

            setFiles(parsedFiles);
            setCurrentIndex(0);

            setNativeProjectId("");
            setNativeProjectName("");
            setNativeProjectFiles([]);

            setNativeSourceContent("");
            setNativeSourcePath("");

            setNativeProjectAllFiles([]);
            setNativeWorkingDirectory("");

            setMessage(
                `Successfully added ${parsedFiles.length} files to this tab's queue.`
            );

        } catch (err) {
            setError(err.message);
        }
    }



    // ---------------------------------------------------------
    // READ BROWSER PROJECT DIRECTORY
    // ---------------------------------------------------------

    async function handleProjectDirectorySelection(event) {
        const selectedFiles = event.target.files;

        if (!selectedFiles?.length || !isWorkspaceReady) {
            return;
        }

        setIsReadingProject(true);
        setError("");
        setMessage("");

        try {
            const project = await readProjectDirectory(
                selectedFiles
            );

            await saveProject(activeTabId, project);

            const generatedTree = generateFileTree(
                project.files,
                project.name
            );

            const parsedFiles = parseFileTree(
                generatedTree
            );

            // Revoke native authorization when switching to a browser-read project.
            await revokeTabNativeSessions(activeTabId);


            setProjectName(project.name);
            setProjectFiles(project.files);

            setNativeProjectId("");
            setNativeProjectName("");
            setNativeProjectFiles([]);

            setNativeProjectAllFiles([]);
            setNativeWorkingDirectory("");

            setNativeSourceContent("");
            setNativeSourcePath("");

            setTreeText(generatedTree);
            setFiles(parsedFiles);
            setCurrentIndex(0);

            setMessage(
                `${project.name} connected. ${project.files.length} source files read successfully.`
            );

        } catch (err) {
            setError(
                err.message ||
                "Unable to read the selected project."
            );

        } finally {
            setIsReadingProject(false);

            event.target.value = "";
        }
    }


    // ---------------------------------------------------------
    // DISCONNECT BROWSER PROJECT
    // ---------------------------------------------------------

    async function handleClearProject() {
        if (!projectName || !isWorkspaceReady) return;

        const confirmed = window.confirm(
            "Disconnect this project and remove its locally stored source contents?"
        );

        if (!confirmed) return;

        try {
            await clearProject(activeTabId);

            setProjectName("");
            setProjectFiles([]);

            setIncludeSourceContext(false);

            setMessage("Local project disconnected.");
            setError("");

        } catch (err) {
            setError(
                err.message ||
                "Unable to disconnect the project."
            );
        }
    }


    // ---------------------------------------------------------
    // COPY CURRENT PROMPT
    // ---------------------------------------------------------

    async function handleCopyPrompt() {
        if (!currentPrompt) return;

        try {
            await navigator.clipboard.writeText(
                currentPrompt
            );

            setMessage("Prompt copied to clipboard.");
            setError("");

        } catch {
            setError(
                "Unable to copy prompt. Check clipboard permissions."
            );
        }
    }


    // ---------------------------------------------------------
    // INSERT OR SEND PROMPT TO CHATGPT
    // ---------------------------------------------------------

    async function handleChatGPTAction(
        shouldSend = false,
        prompt = currentPrompt
    ) {
        if (
            !prompt ||
            isSending ||
            !isWorkspaceReady
        ) {
            return;
        }

        setError("");
        setMessage("");
        setIsSending(true);

        try {
            await sendPromptToChatGPT(
                prompt,
                shouldSend
            );

            setMessage(
                shouldSend
                    ? "Prompt successfully inserted and sent to ChatGPT."
                    : "Prompt inserted into ChatGPT. It has not been sent."
            );

        } catch (err) {
            setError(
                err.message ||
                "Could not communicate with the ChatGPT tab."
            );

        } finally {
            setIsSending(false);
        }
    }


    // ---------------------------------------------------------
    // ADVANCE QUEUE
    // ---------------------------------------------------------

    async function handleAdvance(status) {
        if (
            !currentFile ||
            isSending ||
            !isWorkspaceReady
        ) {
            return;
        }

        const nextIndex = currentIndex + 1;
        const nextFile = files[nextIndex] || null;

        setFiles((previousFiles) =>
            previousFiles.map((file, index) =>
                index === currentIndex
                    ? { ...file, status }
                    : file
            )
        );

        setCurrentIndex(nextIndex);
        setError("");

        setMessage(
            status === "completed"
                ? `${currentFile.name} marked as completed.`
                : `${currentFile.name} skipped.`
        );

        if (
            autoSend &&
            status === "completed" &&
            nextFile
        ) {
            try {
                let sourceContent = "";

                if (nativeProjectId) {
                    const readToken = await ensureNativeReadSession(
                        nativeProjectId,
                        nativeWorkingDirectory,
                        activeTabId
                    );

                    const response = await readNativeProjectFile(
                        nativeProjectId,
                        nextFile.path,
                        nativeWorkingDirectory,
                        readToken
                    );

                    sourceContent = response.content || "";

                    setNativeSourcePath(nextFile.path);
                    setNativeSourceContent(sourceContent);

                } else {
                    const nextProjectFile = projectFiles.find(
                        (file) => file.path === nextFile.path
                    );

                    sourceContent =
                        nextProjectFile?.content || "";
                }

                const nextPrompt = generatePrompt({
                    tree: treeText,
                    template,
                    file: nextFile,

                    sourceContent:
                        includeSourceContext
                            ? sourceContent
                            : "",
                });

                await handleChatGPTAction(
                    true,
                    nextPrompt
                );

            } catch (err) {
                setError(
                    err.message ||
                    "Unable to generate or send the next prompt."
                );
            }

        } else if (!nextFile) {
            setMessage(
                "All files have been processed."
            );
        }
    }


    // ---------------------------------------------------------
    // RESET QUEUE
    // ---------------------------------------------------------

    function handleResetQueue() {
        if (!window.confirm("Reset the entire processing queue?")) {
            return;
        }

        setFiles((previousFiles) =>
            previousFiles.map((file) => ({
                ...file,
                status: "pending",
            }))
        );

        setCurrentIndex(0);

        setMessage("Queue has been reset.");
        setError("");
    }


    // ---------------------------------------------------------
    // CLEAR QUEUE
    // ---------------------------------------------------------

    function handleClearQueue() {
        if (!window.confirm("Clear this tab's entire queue?")) {
            return;
        }

        setFiles([]);
        setCurrentIndex(0);

        setMessage("This tab's queue has been cleared.");
        setError("");
    }


    // ---------------------------------------------------------
    // OPEN NATIVE WRITE EDITOR
    // ---------------------------------------------------------

    function handleOpenNativeWriteEditor() {
        if (!nativeProjectId || !currentFile) {
            setNativeError(
                "Connect a native project and select a file first."
            );

            return;
        }

        setNativeWritePath(currentFile.path);
        setNativeWriteContent("");

        setShowNativeWriteEditor(true);

        setNativeError("");
    }


    // ---------------------------------------------------------
    // WRITE GENERATED CONTENT TO LOCAL FILE
    // ---------------------------------------------------------

    async function handleWriteNativeFile() {
        if (
            !nativeProjectId ||
            !nativeWritePath.trim() ||
            !nativeWriteContent.trim()
        ) {
            setNativeError(
                "A destination path and generated file content are required."
            );

            return;
        }

        const confirmed = window.confirm(
            [
                "You are about to write generated content to your local project.",
                "",
                `Project: ${nativeProjectName}`,
                `File: ${nativeWritePath}`,
                "",
                "An existing file will be backed up before it is overwritten.",
                "",
                "Continue?",
            ].join("\n")
        );

        if (!confirmed) return;

        let writeToken;

        try {
            writeToken = await ensureNativeWriteSession(
                nativeProjectId,
                nativeWorkingDirectory,
                activeTabId
            );
        } catch (err) {
            setNativeError(
                err.message || "Local write authorization was not granted."
            );
            return;
        }

        setIsWritingNativeFile(true);
        setNativeError("");
        setError("");
        setMessage("");

        try {

            const response = await writeNativeProjectFile(
                nativeProjectId,
                nativeWritePath,
                nativeWriteContent,
                nativeWorkingDirectory,
                writeToken
            );

            setMessage(
                response.created
                    ? `Created ${nativeWritePath} successfully.`
                    : `Updated ${nativeWritePath} successfully. Backup: ${response.backup}`
            );

            setShowNativeWriteEditor(false);

            setNativeWriteContent("");
            setNativeWritePath("");

            // Refresh the complete project listing.
            const rootReadToken = await ensureNativeReadSession(
                nativeProjectId,
                "",
                activeTabId
            );

            const refreshedAllFiles = await getNativeProjectFiles(
                nativeProjectId,
                "",
                rootReadToken
            );

            setNativeProjectAllFiles(refreshedAllFiles);

            const refreshedDirectories = await getNativeProjectDirectories(
                nativeProjectId,
                "",
                rootReadToken
            );

            setNativeProjectDirectories(refreshedDirectories);

            // Refresh the selected working directory.
            const scopedReadToken = await ensureNativeReadSession(
                nativeProjectId,
                nativeWorkingDirectory,
                activeTabId
            );

            const refreshedFiles = await getNativeProjectFiles(
                nativeProjectId,
                nativeWorkingDirectory,
                scopedReadToken
            );

            setNativeProjectFiles(refreshedFiles);

            
            const workspace = buildNativeProjectWorkspace(
                refreshedFiles,
                nativeProjectName
            );

            setTreeText(workspace.tree);

            // Update the queue only when the file was newly created.
            if (response.created) {
                setFiles(workspace.files);
                setCurrentIndex(0);
            }            

        } catch (err) {
            setNativeError(
                err.message ||
                "Unable to write the generated file."
            );

        } finally {
            setIsWritingNativeFile(false);
        }
    }


    // ---------------------------------------------------------
    // RENDER
    // ---------------------------------------------------------

    return (
        <main className="min-h-screen bg-slate-50 text-slate-800">

            {/* HEADER */}

            <header className="border-b bg-white px-5 py-4">

                <div className="flex items-center gap-3">

                    <div className="rounded-lg bg-indigo-600 p-2 text-white">
                        <FolderTree size={22} />
                    </div>

                    <div>
                        <h1 className="text-lg font-bold">
                            PromptFlow
                        </h1>

                        <p className="text-xs text-slate-500">
                            Intelligent Prompt Sequencer
                        </p>
                    </div>

                </div>

            </header>


            {!globalThis.browser?.tabs ? (

                <div className="flex min-h-64 items-center justify-center p-5">

                    <p className="text-sm text-red-600">
                        Firefox extension APIs are unavailable.
                        Open PromptFlow from the Firefox sidebar.
                    </p>

                </div>

            ) : !isWorkspaceReady ? (

                <div className="flex min-h-64 items-center justify-center p-5">

                    <p className="text-sm text-slate-500">
                        Loading workspace for the active tab...
                    </p>

                </div>

            ) : (

                <div className="space-y-5 p-5">

                    {/* NOTIFICATIONS */}

                    {error && (
                        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">

                            <AlertCircle
                                size={18}
                                className="shrink-0"
                            />

                            {error}

                        </div>
                    )}

                    {message && (
                        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                            {message}
                        </div>
                    )}


                    {/* NATIVE COMPANION */}

                    <section className="rounded-xl border bg-white p-4">

                        <div className="mb-3 flex items-center justify-between">

                            <div className="flex items-center gap-2">

                                <HardDrive size={18} />

                                <h2 className="font-semibold">
                                    Native Companion
                                </h2>

                            </div>

                            <span
                                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                    nativeConnected
                                        ? "bg-green-100 text-green-700"
                                        : "bg-slate-100 text-slate-600"
                                }`}
                            >
                                {nativeConnected
                                    ? "Connected"
                                    : "Disconnected"}
                            </span>

                        </div>


                        <p className="mb-3 text-xs leading-relaxed text-slate-500">
                            Connect PromptFlow to your local filesystem
                            to read project files and write generated
                            code directly into your project.
                        </p>


                        {nativeConnected && (

                            <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-3">

                                <div className="flex items-center gap-2 text-sm font-medium text-green-800">

                                    <ShieldCheck size={16} />

                                    Native host is available.

                                </div>

                                <p className="mt-1 text-xs text-green-700">
                                    Version: {nativeVersion || "Unknown"}
                                </p>

                            </div>

                        )}


                        <div className="grid grid-cols-2 gap-2">

                            <button
                                onClick={handleTestNativeHost}
                                disabled={isConnectingNative}
                                className="flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                            >

                                <RefreshCw
                                    size={15}
                                    className={
                                        isConnectingNative
                                            ? "animate-spin"
                                            : ""
                                    }
                                />

                                Test Connection

                            </button>


                            <button
                                onClick={handleLoadNativeProjects}
                                disabled={isConnectingNative}
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

                            <div className="mt-4">

                                <label className="mb-2 block text-xs font-semibold">
                                    Registered Projects
                                </label>

                                <div className="space-y-2">

                                    {nativeProjects.map((project) => (

                                        <button
                                            key={project.id}
                                            onClick={() =>
                                                handleConnectNativeProject(
                                                    project.id
                                                )
                                            }
                                            disabled={isLoadingNativeFiles}
                                            className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50"
                                        >

                                            <span className="min-w-0">

                                                <span className="block truncate text-sm font-semibold">
                                                    {project.name}
                                                </span>

                                                <span className="mt-1 block text-xs text-slate-500">
                                                    Approved local project
                                                </span>

                                            </span>

                                            <span className="shrink-0 text-xs font-semibold text-indigo-600">
                                                Connect
                                            </span>

                                        </button>

                                    ))}

                                </div>

                            </div>

                        )}


                        {isLoadingNativeFiles && (
                            <p className="mt-3 text-xs text-indigo-600">
                                Loading project files...
                            </p>
                        )}


                        {nativeProjectId && (

                            <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3">

                                <p className="break-all text-sm font-semibold text-green-800">
                                    {nativeProjectName}
                                </p>

                                <p className="mt-1 text-xs text-green-700">
                                    {nativeProjectFiles.length} files
                                    available through native messaging.
                                </p>

                                <label className="mb-2 mt-4 block text-xs font-semibold text-green-800">
                                    Working directory
                                </label>

                                <select
                                    value={nativeWorkingDirectory}
                                    onChange={(event) =>
                                        handleChangeNativeWorkingDirectory(event.target.value)
                                    }
                                    disabled={isChangingWorkingDirectory}
                                    className="w-full rounded-lg border border-green-300 bg-white p-2 text-xs text-slate-700 disabled:opacity-50"
                                >

                                    {nativeProjectDirectories.map((directory) => (
                                        <option
                                            key={directory || "__project_root__"}
                                            value={directory}
                                        >
                                            {directory || "Project Root (Entire Project)"}
                                        </option>
                                    ))}
                                </select>

                                {isChangingWorkingDirectory && (
                                    <p className="mt-2 text-xs text-green-700">
                                        Loading working directory...
                                    </p>
                                )}

                                <button
                                    onClick={handleDisconnectNativeProject}
                                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                                >

                                    <Unplug size={14} />

                                    Disconnect Native Project

                                </button>

                            </div>

                        )}


                        <p className="mt-3 text-xs leading-relaxed text-slate-500">
                            Projects must first be registered using
                            <code className="mx-1 rounded bg-slate-100 px-1 py-0.5">
                                python3 native/host.py --register-project PATH
                            </code>
                            in your terminal.
                        </p>

                    </section>


                    {/* FILE TREE */}

                    <section className="rounded-xl border bg-white p-4">

                        <div className="mb-3 flex items-center gap-2">

                            <FolderTree size={18} />

                            <h2 className="font-semibold">
                                File Tree
                            </h2>

                        </div>

                        <textarea
                            value={treeText}
                            onChange={(event) => {
                                setTreeText(event.target.value);
                                setError("");
                            }}
                            className="min-h-48 w-full rounded-lg border p-3 font-mono text-xs outline-none focus:border-indigo-500"
                            placeholder="Paste your complete project file tree..."
                        />

                        <button
                            onClick={handleParseTree}
                            disabled={!treeText.trim()}
                            className="mt-3 w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            Parse File Tree
                        </button>

                        <p className="mt-2 text-xs text-slate-500">
                            Files are extracted in their original tree
                            order. __init__.py files are excluded by default.
                        </p>

                    </section>


                    {/* BROWSER PROJECT DIRECTORY */}

                    <section className="rounded-xl border bg-white p-4">

                        <div className="mb-3 flex items-center gap-2">

                            <FileText size={18} />

                            <h2 className="font-semibold">
                                Browser Project Reader
                            </h2>

                        </div>

                        <input
                            ref={folderInputRef}
                            type="file"
                            multiple
                            webkitdirectory=""
                            onChange={handleProjectDirectorySelection}
                            className="hidden"
                        />

                        {projectName ? (

                            <div className="rounded-lg border border-green-200 bg-green-50 p-3">

                                <p className="break-all text-sm font-semibold text-green-800">
                                    {projectName}
                                </p>

                                <p className="mt-1 text-xs text-green-700">
                                    {projectFiles.length} readable source files
                                </p>

                                <div className="mt-3 flex gap-2">

                                    <button
                                        onClick={() =>
                                            folderInputRef.current?.click()
                                        }
                                        disabled={isReadingProject}
                                        className="flex-1 rounded-lg border border-green-300 px-3 py-2 text-xs font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
                                    >
                                        Change Project
                                    </button>

                                    <button
                                        onClick={handleClearProject}
                                        disabled={isReadingProject}
                                        className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                                    >
                                        Disconnect
                                    </button>

                                </div>

                            </div>

                        ) : (

                            <button
                                onClick={() =>
                                    folderInputRef.current?.click()
                                }
                                disabled={isReadingProject}
                                className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {isReadingProject
                                    ? "Reading Project Files..."
                                    : "Select Project Folder"}
                            </button>

                        )}

                        <p className="mt-3 text-xs leading-relaxed text-slate-500">
                            The browser reader can read selected files.
                            Use Native Companion when you also need to
                            write files directly to your filesystem.
                        </p>

                    </section>


                    {/* SOURCE CONTEXT */}

                    {(projectFiles.length > 0 || nativeProjectId) && (

                        <section className="rounded-xl border bg-white p-4">

                            <label className="flex cursor-pointer items-start gap-2">

                                <input
                                    type="checkbox"
                                    checked={includeSourceContext}
                                    onChange={(event) =>
                                        setIncludeSourceContext(
                                            event.target.checked
                                        )
                                    }
                                    className="mt-1 h-4 w-4 accent-indigo-600"
                                />

                                <span>

                                    <span className="block text-sm font-medium">
                                        Include current source file
                                    </span>

                                    <span className="mt-1 block text-xs text-slate-500">
                                        Include the actual file contents
                                        in the generated ChatGPT prompt.
                                    </span>

                                </span>

                            </label>


                            {nativeProjectId && currentFile && (

                                <div className="mt-3">

                                    <button
                                        onClick={() =>
                                            handleReadNativeFile()
                                        }
                                        disabled={isReadingNativeFile}
                                        className="flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                                    >

                                        <FileText size={14} />

                                        {isReadingNativeFile
                                            ? "Reading File..."
                                            : "Read Current File"}

                                    </button>

                                    {nativeSourcePath === currentFile.path && (

                                        <p className="mt-2 break-all text-xs text-green-700">
                                            Loaded: {nativeSourcePath}
                                        </p>

                                    )}

                                </div>

                            )}

                        </section>

                    )}


                    {/* NATIVE FILE WRITER */}

                    {nativeProjectId && (

                        <section className="rounded-xl border border-indigo-200 bg-white p-4">

                            <div className="mb-3 flex items-center gap-2">

                                <Save size={18} />

                                <h2 className="font-semibold">
                                    Write to Local Project
                                </h2>

                            </div>

                            <p className="mb-3 text-xs leading-relaxed text-slate-500">
                                Paste generated code below and save it
                                directly to your connected project.
                                Existing files are backed up before
                                they are overwritten.
                            </p>


                            {!showNativeWriteEditor ? (

                                <button
                                    onClick={handleOpenNativeWriteEditor}
                                    disabled={!currentFile}
                                    className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    Open File Writer
                                </button>

                            ) : (

                                <div className="space-y-3">

                                    <div>

                                        <label className="mb-1 block text-xs font-semibold">
                                            Destination file
                                        </label>

                                        <input
                                            type="text"
                                            value={nativeWritePath}
                                            onChange={(event) =>
                                                setNativeWritePath(
                                                    event.target.value
                                                )
                                            }
                                            className="w-full rounded-lg border p-3 font-mono text-xs outline-none focus:border-indigo-500"
                                            placeholder="relative/path/to/file.py"
                                        />

                                    </div>


                                    <div>

                                        <label className="mb-1 block text-xs font-semibold">
                                            Generated file content
                                        </label>

                                        <textarea
                                            value={nativeWriteContent}
                                            onChange={(event) =>
                                                setNativeWriteContent(
                                                    event.target.value
                                                )
                                            }
                                            className="min-h-64 w-full rounded-lg border p-3 font-mono text-xs outline-none focus:border-indigo-500"
                                            placeholder="Paste the complete generated file content here..."
                                        />

                                    </div>


                                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">

                                        <ShieldCheck
                                            size={15}
                                            className="mb-1"
                                        />

                                        Saving requires explicit confirmation.
                                        Existing files are backed up before
                                        replacement.

                                    </div>


                                    <div className="grid grid-cols-2 gap-2">

                                        <button
                                            onClick={() => {
                                                setShowNativeWriteEditor(false);
                                                setNativeWriteContent("");
                                                setNativeWritePath("");
                                            }}
                                            disabled={isWritingNativeFile}
                                            className="rounded-lg border px-3 py-3 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>


                                        <button
                                            onClick={handleWriteNativeFile}
                                            disabled={
                                                isWritingNativeFile ||
                                                !nativeWritePath.trim() ||
                                                !nativeWriteContent.trim()
                                            }
                                            className="flex items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-3 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                                        >

                                            <Save size={15} />

                                            {isWritingNativeFile
                                                ? "Saving..."
                                                : "Confirm & Save"}

                                        </button>

                                    </div>

                                </div>

                            )}

                        </section>

                    )}


                    {/* DJANGO MODEL WORKFLOW */}

                    {nativeProjectId && (

                        <DjangoModelWorkflowPanel
                            activeTabId={activeTabId}
                            nativeProjectId={nativeProjectId}
                            nativeProjectName={nativeProjectName}
                            nativeWorkingDirectory={nativeWorkingDirectory}
                            nativeProjectFiles={nativeProjectFiles}
                            treeText={treeText}
                            
                            readNativeProjectFile={async (projectId, path) => {
                                const readToken = await ensureNativeReadSession(
                                    projectId,
                                    nativeWorkingDirectory,
                                    activeTabId
                                );

                                return readNativeProjectFile(
                                    projectId,
                                    path,
                                    nativeWorkingDirectory,
                                    readToken
                                );
                            }}

                            writeNativeProjectFile={async (projectId, path, content) => {
                                const writeToken = await ensureNativeWriteSession(
                                    projectId,
                                    nativeWorkingDirectory,
                                    activeTabId
                                );

                                return writeNativeProjectFile(
                                    projectId,
                                    path,
                                    content,
                                    nativeWorkingDirectory,
                                    writeToken
                                );
                            }}

                            getNativeProjectFiles={async (projectId) => {
                                const readToken = await ensureNativeReadSession(
                                    projectId,
                                    nativeWorkingDirectory,
                                    activeTabId
                                );

                                return getNativeProjectFiles(
                                    projectId,
                                    nativeWorkingDirectory,
                                    readToken
                                );
                            }}
                            ensureWriteAuthorization={async () =>
                                ensureNativeWriteSession(
                                    nativeProjectId,
                                    nativeWorkingDirectory,
                                    activeTabId
                                )
                            }
                            sendPromptToChatGPT={sendPromptToChatGPT}
                        />

                    )}

                    {/* INSTRUCTION TEMPLATE */}

                    <section className="rounded-xl border bg-white p-4">

                        <div className="mb-3 flex items-center gap-2">

                            <Settings size={18} />

                            <h2 className="font-semibold">
                                Instruction Template
                            </h2>

                        </div>

                        <textarea
                            value={template}
                            onChange={(event) =>
                                setTemplate(event.target.value)
                            }
                            className="min-h-28 w-full rounded-lg border p-3 text-sm outline-none focus:border-indigo-500"
                            placeholder="Enter your instruction template..."
                        />

                        <p className="mt-2 text-xs text-slate-500">
                            Use {"{{file}}"} or [FILE] to insert the
                            current filename. Use {"{{path}}"} or [PATH]
                            to insert its relative path.
                        </p>

                    </section>


                    {/* PROCESSING QUEUE */}

                    <section className="rounded-xl border bg-white p-4">

                        <div className="mb-4 flex items-center justify-between">

                            <div className="flex items-center gap-2">

                                <ListOrdered size={18} />

                                <h2 className="font-semibold">
                                    Processing Queue
                                </h2>

                            </div>

                            <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                                {files.length} files
                            </span>

                        </div>


                        {files.length === 0 ? (

                            <p className="text-sm text-slate-500">
                                Connect a native project, select a local
                                project directory, or paste a file tree
                                to generate your processing queue.
                            </p>

                        ) : (

                            <>

                                {/* PROGRESS */}

                                <div className="mb-4">

                                    <div className="mb-2 flex justify-between text-xs">

                                        <span className="text-slate-500">
                                            Processing progress
                                        </span>

                                        <span className="font-semibold">
                                            {progress}%
                                        </span>

                                    </div>

                                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">

                                        <div
                                            className="h-full rounded-full bg-indigo-600 transition-all"
                                            style={{
                                                width: `${progress}%`,
                                            }}
                                        />

                                    </div>

                                    <div className="mt-2 flex justify-between text-xs text-slate-500">

                                        <span>
                                            Completed: {completedCount}
                                        </span>

                                        <span>
                                            Skipped: {skippedCount}
                                        </span>

                                        <span>
                                            Remaining: {files.length - processedCount}
                                        </span>

                                    </div>

                                </div>


                                {/* CURRENT FILE */}

                                {currentFile ? (

                                    <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 p-3">

                                        <p className="mb-1 text-xs font-medium text-indigo-600">
                                            CURRENT FILE
                                        </p>

                                        <p className="break-all text-sm font-semibold text-indigo-900">
                                            {currentFile.path}
                                        </p>

                                        <p className="mt-1 text-xs text-indigo-600">
                                            File {currentIndex + 1} of {files.length}
                                        </p>

                                    </div>

                                ) : (

                                    <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm font-medium text-green-700">
                                        All files have been processed.
                                    </div>

                                )}


                                {/* PROMPT PREVIEW */}

                                {currentFile && (

                                    <div className="mb-4">

                                        <h3 className="mb-2 text-sm font-semibold">
                                            Generated Prompt
                                        </h3>

                                        <textarea
                                            readOnly
                                            value={currentPrompt}
                                            className="min-h-52 w-full rounded-lg border bg-slate-50 p-3 font-mono text-xs leading-relaxed outline-none"
                                        />


                                        <div className="mt-3 grid grid-cols-2 gap-2">

                                            <button
                                                onClick={handleCopyPrompt}
                                                className="flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-xs font-medium hover:bg-slate-50"
                                            >

                                                <ClipboardCopy size={15} />

                                                Copy Prompt

                                            </button>


                                            <button
                                                onClick={() =>
                                                    handleChatGPTAction(false)
                                                }
                                                disabled={isSending}
                                                className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            >

                                                <FileText size={15} />

                                                Insert Prompt

                                            </button>


                                            <button
                                                onClick={() =>
                                                    handleChatGPTAction(true)
                                                }
                                                disabled={isSending}
                                                className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-3 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                                            >

                                                <Send size={16} />

                                                {isSending
                                                    ? "Processing..."
                                                    : "Insert & Send"}

                                            </button>

                                        </div>

                                    </div>

                                )}


                                {/* AUTO-SEND */}

                                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">

                                    <label className="flex cursor-pointer items-start gap-3">

                                        <input
                                            type="checkbox"
                                            checked={autoSend}
                                            onChange={(event) =>
                                                setAutoSend(
                                                    event.target.checked
                                                )
                                            }
                                            className="mt-1 h-4 w-4 accent-indigo-600"
                                        />

                                        <span className="flex-1">

                                            <span className="flex items-center gap-2 text-sm font-semibold text-amber-900">

                                                <Zap size={15} />

                                                Auto-send next prompt

                                            </span>

                                            <span className="mt-1 block text-xs leading-relaxed text-amber-800">
                                                When enabled, clicking
                                                Complete & Next automatically
                                                inserts and sends the next
                                                file's prompt to ChatGPT.
                                            </span>

                                        </span>

                                    </label>

                                </div>


                                {/* QUEUE ACTIONS */}

                                {currentFile && (

                                    <div className="grid grid-cols-2 gap-2">

                                        <button
                                            onClick={() =>
                                                handleAdvance("completed")
                                            }
                                            disabled={isSending}
                                            className="flex items-center justify-center gap-2 rounded-lg bg-green-600 px-3 py-3 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                                        >

                                            <CheckCircle2 size={16} />

                                            Complete & Next

                                        </button>


                                        <button
                                            onClick={() =>
                                                handleAdvance("skipped")
                                            }
                                            disabled={isSending}
                                            className="flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        >

                                            <SkipForward size={16} />

                                            Skip File

                                        </button>

                                    </div>

                                )}


                                {/* ALL FILES */}

                                <div className="mt-5">

                                    <h3 className="mb-2 text-sm font-semibold">
                                        All Files
                                    </h3>

                                    <div className="max-h-64 space-y-1 overflow-y-auto">

                                        {files.map((file, index) => {

                                            const isCurrent =
                                                index === currentIndex;

                                            const isCompleted =
                                                file.status === "completed";

                                            const isSkipped =
                                                file.status === "skipped";

                                            return (

                                                


                                                    <button
                                                        type="button"
                                                        key={file.id}
                                                        onClick={() => setCurrentIndex(index)}
                                                        className={`flex w-full items-center gap-2 rounded-lg p-2 text-left text-xs transition-colors ${
                                                            isCurrent
                                                                ? "bg-indigo-50 text-indigo-700"
                                                                : "text-slate-600 hover:bg-slate-50"
                                                        }`}
                                                    >

                                                    {/* key={file.id}
                                                    className={`flex items-center gap-2 rounded-lg p-2 text-xs ${
                                                        isCurrent
                                                            ? "bg-indigo-50 text-indigo-700"
                                                            : "text-slate-600"
                                                    }`}
                                                > */}

                                                    {isCompleted ? (

                                                        <CheckCircle2
                                                            size={15}
                                                            className="shrink-0 text-green-600"
                                                        />

                                                    ) : isSkipped ? (

                                                        <SkipForward
                                                            size={15}
                                                            className="shrink-0 text-amber-600"
                                                        />

                                                    ) : (

                                                        <Circle
                                                            size={15}
                                                            className="shrink-0"
                                                        />

                                                    )}

                                                    <span className="min-w-0 flex-1 break-all">
                                                        {file.path}
                                                    </span>

                                                    {isCurrent && (

                                                        <span className="shrink-0 font-semibold">
                                                            Current
                                                        </span>

                                                    )}

                                                {/* </div> */}
                                                </button>

                                            );
                                        })}

                                    </div>

                                </div>


                                {/* QUEUE MANAGEMENT */}

                                <div className="mt-4 flex gap-2 border-t pt-4">

                                    <button
                                        onClick={handleResetQueue}
                                        className="flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50"
                                    >

                                        <RotateCcw size={14} />

                                        Reset Queue

                                    </button>


                                    <button
                                        onClick={handleClearQueue}
                                        className="flex-1 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                                    >
                                        Clear Queue
                                    </button>

                                </div>

                            </>

                        )}

                    </section>

                </div>

            )}

        </main>
    );
}

export default App;