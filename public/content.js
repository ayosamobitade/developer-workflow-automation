const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const RESPONSE_START_TIMEOUT_MS = 2 * 60 * 1000;
const RESPONSE_STABLE_MS = 1800;
const RESPONSE_CHECK_INTERVAL_MS = 250;


function isVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
    );
}


function findChatGPTComposer() {
    const selectors = [
        "#prompt-textarea",
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]',
        '[contenteditable="true"][role="textbox"][aria-label="Ask anything"]',
        '[contenteditable="true"][role="textbox"]',
        "form textarea",
    ];

    const candidates = new Set();

    for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((element) => {
            candidates.add(element);
        });
    }

    const validCandidates = [...candidates].filter((element) => {
        const rect = element.getBoundingClientRect();

        if (
            !isVisible(element) ||
            rect.bottom <= 0 ||
            rect.top >= window.innerHeight ||
            rect.right <= 0 ||
            rect.left >= window.innerWidth
        ) {
            return false;
        }

        // Never select assistant writing blocks or code editors.
        if (
            element.closest(
                ".writing-block-editor, [data-markdown-copy-content='true'], .cm-content"
            )
        ) {
            return false;
        }

        if (
            element.matches("textarea") &&
            (element.disabled || element.readOnly)
        ) {
            return false;
        }

        return (
            element.isContentEditable ||
            element.matches("textarea")
        );
    });

    validCandidates.sort((a, b) => {
        const aIsComposer =
            a.getAttribute("aria-label") === "Ask ChatGPT";

        const bIsComposer =
            b.getAttribute("aria-label") === "Ask ChatGPT";

        if (aIsComposer !== bIsComposer) {
            return aIsComposer ? -1 : 1;
        }

        return (
            b.getBoundingClientRect().bottom -
            a.getBoundingClientRect().bottom
        );
    });

    return validCandidates[0] || null;
}


function insertIntoComposer(editor, prompt) {
    editor.focus();

    if (editor instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
        ).set;

        setter.call(editor, prompt);

        editor.dispatchEvent(
            new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: prompt,
            })
        );

        editor.dispatchEvent(
            new Event("change", { bubbles: true })
        );

        return;
    }

    const selection = window.getSelection();
    const range = document.createRange();

    range.selectNodeContents(editor);

    selection.removeAllRanges();
    selection.addRange(range);

    const inserted = document.execCommand(
        "insertText",
        false,
        prompt
    );

    if (!inserted) {
        editor.replaceChildren(
            document.createTextNode(prompt)
        );

        editor.dispatchEvent(
            new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: prompt,
            })
        );
    }

    editor.focus();
}



function findSendButton(editor) {
    const selectors = [
        'button[data-testid="send-button"]',
        '[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        'button[type="submit"]',
    ];

    let current = editor;

    // Search the composer and its surrounding containers.
    for (let depth = 0; current && depth < 10; depth++) {
        for (const selector of selectors) {
            const buttons = current.querySelectorAll(selector);

            for (const button of buttons) {
                const rect = button.getBoundingClientRect();

                if (
                    isVisible(button) &&
                    rect.bottom > 0 &&
                    rect.top < window.innerHeight &&
                    !button.disabled &&
                    button.getAttribute("aria-disabled") !== "true"
                ) {
                    return button;
                }
            }
        }

        current = current.parentElement;
    }

    return null;
}


async function waitForSendButton(editor, timeout = 3000) {
    const startedAt = Date.now();

    while (
        Date.now() - startedAt < timeout &&
        editor.isConnected
    ) {
        const button = findSendButton(editor);

        if (button) {
            return button;
        }

        await new Promise((resolve) =>
            setTimeout(resolve, 100)
        );
    }

    return null;
}


/*
 * CHATGPT RESPONSE DETECTION
 */


function getAssistantMessages() {
    return Array.from(
        document.querySelectorAll("main h4")
    )
        .filter(
            (heading) =>
                heading.innerText?.trim() === "ChatGPT said:"
        )
        .map((heading) => heading.parentElement)
        .filter(Boolean)
        .filter(isVisible);
}


function getLatestAssistantMessage() {
    const messages = getAssistantMessages();

    return messages.length
        ? messages[messages.length - 1]
        : null;
}


function getAssistantMessageText(element) {
    if (!element) return "";

    const contentElements = Array.from(element.children)
        .filter(
            (child) =>
                !(
                    child.tagName === "H4" &&
                    child.innerText?.trim() === "ChatGPT said:"
                )
        );

    return contentElements
        .map((child) => child.innerText || child.textContent || "")
        .join("\n")
        .trim();
}


function findStopGeneratingButton() {
    const selectors = [
        'button[data-testid*="stop" i]',
        'button[aria-label*="stop" i]',
        'button[title*="stop" i]',
    ];

    for (const selector of selectors) {
        const buttons = document.querySelectorAll(selector);

        for (const button of buttons) {
            if (isVisible(button) && !button.disabled) {
                return button;
            }
        }
    }

    return null;
}


function isChatGPTGenerating() {
    return Boolean(findStopGeneratingButton());
}

/*
 * WAIT FOR A NEW ASSISTANT RESPONSE
 *
 * Completion requires:
 *
 * 1. A new assistant message appears.
 * 2. The response contains text.
 * 3. ChatGPT's generation control disappears.
 * 4. The response remains unchanged for a stability period.
 *
 * MutationObserver detects DOM changes.
 * A short interval provides a fallback check.
 */

function waitForAssistantResponse({
    previousSnapshot,
    timeout = RESPONSE_TIMEOUT_MS,
}) {
    return new Promise((resolve, reject) => {
        let observer = null;
        let interval = null;
        let timeoutTimer = null;

        let responseStarted = false;
        let responseStartedAt = null;
        let lastResponseText = "";
        let lastChangeAt = null;

        let settled = false;

        const startedAt = Date.now();

        function cleanup() {
            observer?.disconnect();

            if (interval) {
                clearInterval(interval);
            }

            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
            }
        }

        function finish(error, result) {
            if (settled) return;

            settled = true;
            cleanup();

            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        }

        function checkResponse() {
            if (settled) return;

            const messages = getAssistantMessages();

            const latestMessage = messages.length
                ? messages[messages.length - 1]
                : null;

            if (!latestMessage) {
                if (
                    Date.now() - startedAt >=
                    RESPONSE_START_TIMEOUT_MS
                ) {
                    finish(
                        new Error(
                            "ChatGPT did not start a new assistant response within the allowed time."
                        )
                    );
                }

                return;
            }

            const responseText =
                getAssistantMessageText(latestMessage);

            const isNewResponse =
                latestMessage !== previousSnapshot?.element ||
                messages.length > (previousSnapshot?.count || 0) ||
                (
                    latestMessage === previousSnapshot?.element &&
                    responseText !== previousSnapshot?.text
                );

            if (!isNewResponse || !responseText) {
                if (
                    Date.now() - startedAt >=
                    RESPONSE_START_TIMEOUT_MS
                ) {
                    finish(
                        new Error(
                            "ChatGPT did not start a new assistant response within the allowed time."
                        )
                    );
                }

                return;
            }

            const now = Date.now();

            if (!responseStarted) {
                responseStarted = true;
                responseStartedAt = now;
                lastResponseText = responseText;
                lastChangeAt = now;
            } else if (responseText !== lastResponseText) {
                lastResponseText = responseText;
                lastChangeAt = now;
            }

            if (isChatGPTGenerating()) {
                lastChangeAt = now;
                return;
            }

            if (
                now - lastChangeAt >= RESPONSE_STABLE_MS
            ) {
                finish(null, {
                    text: responseText,
                    completedAt: now,
                    duration: now - responseStartedAt,
                });
            }
        }

        observer = new MutationObserver(checkResponse);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });

        interval = setInterval(
            checkResponse,
            RESPONSE_CHECK_INTERVAL_MS
        );

        timeoutTimer = setTimeout(() => {
            finish(
                new Error(
                    "Timed out while waiting for ChatGPT to complete its response."
                )
            );
        }, timeout);

        checkResponse();
    });
}

/*
 * PROMPT HANDLER
 */


async function handlePromptMessage(message) {
    const shouldSend =
        message.type === "PROMPTFLOW_INSERT_AND_SEND" ||
        message.type === "PROMPTFLOW_INSERT_AND_WAIT";

    const shouldWait =
        message.type === "PROMPTFLOW_INSERT_AND_WAIT";

    const prompt = message.prompt;

    if (
        typeof prompt !== "string" ||
        !prompt.trim()
    ) {
        return {
            success: false,
            error: "The prompt is empty.",
        };
    }

    const editor = findChatGPTComposer();

    if (!editor) {
        return {
            success: false,
            error:
                "Could not find ChatGPT's message composer. Make sure ChatGPT is open and the page has finished loading.",
        };
    }

    try {
        if (
            shouldWait &&
            isChatGPTGenerating()
        ) {
            return {
                success: false,
                error:
                    "ChatGPT is already generating a response. Wait for it to finish before starting another workflow task.",
            };
        }

        // Capture the previous response before submitting.
        const previousSnapshot = shouldWait
            ? (() => {
                const messages = getAssistantMessages();
                const latestMessage = messages.length
                    ? messages[messages.length - 1]
                    : null;

                return {
                    element: latestMessage,
                    count: messages.length,
                    text: getAssistantMessageText(latestMessage),
                };
            })()
            : null;

            insertIntoComposer(editor, prompt);

            await new Promise((resolve) =>
                setTimeout(resolve, 300)
            );

            const composerText =
                editor instanceof HTMLTextAreaElement
                    ? editor.value
                    : editor.innerText || editor.textContent || "";

            const normalizeText = (value) =>
                value.replace(/\s+/g, " ").trim();

            const expectedText = normalizeText(prompt);
            const actualText = normalizeText(composerText);

            if (
                !actualText.includes(
                    expectedText.slice(0, Math.min(80, expectedText.length))
                )
            ) {
                return {
                    success: false,
                    error:
                        "Prompt insertion could not be verified in ChatGPT's active composer.",
                };
            }

        if (!shouldSend) {
            return {
                success: true,
                message: "Prompt inserted into ChatGPT.",
            };
        }

        if (!editor.isConnected) {
            return {
                success: false,
                error:
                    "The ChatGPT composer changed before the prompt could be sent.",
            };
        }

        const sendButton = await waitForSendButton(editor);

        if (!sendButton) {
            return {
                success: false,
                error:
                    "The prompt was inserted, but ChatGPT's Send button could not be found.",
            };
        }

        sendButton.click();

        if (!shouldWait) {
            return {
                success: true,
                message:
                    "Prompt inserted and sent to ChatGPT.",
            };
        }

        const response = await waitForAssistantResponse({
            previousSnapshot,
            timeout: message.timeout || RESPONSE_TIMEOUT_MS,
        });

        return {
            success: true,
            message:
                "ChatGPT completed its response.",
            response,
        };

    } catch (error) {
        console.error(
            "[PromptFlow] Prompt processing error:",
            error
        );

        return {
            success: false,
            error:
                error.message ||
                "An error occurred while processing the prompt.",
        };
    }
}


/*
 * EXTENSION MESSAGE LISTENER
 */


browser.runtime.onMessage.addListener((message) => {
    const supportedTypes = [
        "PROMPTFLOW_INSERT_PROMPT",
        "PROMPTFLOW_INSERT_AND_SEND",
        "PROMPTFLOW_INSERT_AND_WAIT",
    ];

    if (!supportedTypes.includes(message?.type)) {
        return undefined;
    }

    return handlePromptMessage(message);
});