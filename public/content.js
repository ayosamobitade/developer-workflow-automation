// const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
// const RESPONSE_START_TIMEOUT_MS = 2 * 60 * 1000;
// const RESPONSE_STABLE_MS = 6000;
// const RESPONSE_CHECK_INTERVAL_MS = 250;


// function isVisible(element) {
//     if (!element) return false;

//     const style = window.getComputedStyle(element);
//     const rect = element.getBoundingClientRect();

//     return (
//         style.display !== "none" &&
//         style.visibility !== "hidden" &&
//         rect.width > 0 &&
//         rect.height > 0
//     );
// }


// function findChatGPTComposer() {
//     const selectors = [
//         "#prompt-textarea",
//         '[data-testid="prompt-textarea"]',
//         '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]',
//         '[contenteditable="true"][role="textbox"][aria-label="Ask anything"]',
//         '[contenteditable="true"][role="textbox"]',
//         "form textarea",
//     ];

//     const candidates = new Set();

//     for (const selector of selectors) {
//         document.querySelectorAll(selector).forEach((element) => {
//             candidates.add(element);
//         });
//     }

//     const validCandidates = [...candidates].filter((element) => {
//         const rect = element.getBoundingClientRect();

//         if (
//             !isVisible(element) ||
//             rect.bottom <= 0 ||
//             rect.top >= window.innerHeight ||
//             rect.right <= 0 ||
//             rect.left >= window.innerWidth
//         ) {
//             return false;
//         }

//         // Never select assistant writing blocks or code editors.
//         if (
//             element.closest(
//                 ".writing-block-editor, [data-markdown-copy-content='true'], .cm-content"
//             )
//         ) {
//             return false;
//         }

//         if (
//             element.matches("textarea") &&
//             (element.disabled || element.readOnly)
//         ) {
//             return false;
//         }

//         return (
//             element.isContentEditable ||
//             element.matches("textarea")
//         );
//     });

//     validCandidates.sort((a, b) => {
//         const aIsComposer =
//             a.getAttribute("aria-label") === "Ask ChatGPT";

//         const bIsComposer =
//             b.getAttribute("aria-label") === "Ask ChatGPT";

//         if (aIsComposer !== bIsComposer) {
//             return aIsComposer ? -1 : 1;
//         }

//         return (
//             b.getBoundingClientRect().bottom -
//             a.getBoundingClientRect().bottom
//         );
//     });

//     return validCandidates[0] || null;
// }


// function insertIntoComposer(editor, prompt) {
//     editor.focus();

//     if (editor instanceof HTMLTextAreaElement) {
//         const setter = Object.getOwnPropertyDescriptor(
//             HTMLTextAreaElement.prototype,
//             "value"
//         ).set;

//         setter.call(editor, prompt);

//         editor.dispatchEvent(
//             new InputEvent("input", {
//                 bubbles: true,
//                 inputType: "insertText",
//                 data: prompt,
//             })
//         );

//         editor.dispatchEvent(
//             new Event("change", { bubbles: true })
//         );

//         return;
//     }

//     const selection = window.getSelection();
//     const range = document.createRange();

//     range.selectNodeContents(editor);

//     selection.removeAllRanges();
//     selection.addRange(range);

//     const inserted = document.execCommand(
//         "insertText",
//         false,
//         prompt
//     );

//     if (!inserted) {
//         editor.replaceChildren(
//             document.createTextNode(prompt)
//         );

//         editor.dispatchEvent(
//             new InputEvent("input", {
//                 bubbles: true,
//                 inputType: "insertText",
//                 data: prompt,
//             })
//         );
//     }

//     editor.focus();
// }



// function findSendButton(editor) {
//     const selectors = [
//         'button[data-testid="send-button"]',
//         '[data-testid="send-button"]',
//         'button[aria-label="Send prompt"]',
//         'button[aria-label="Send message"]',
//         'button[aria-label="Send"]',
//         'button[type="submit"]',
//     ];

//     let current = editor;

//     // Search the composer and its surrounding containers.
//     for (let depth = 0; current && depth < 10; depth++) {
//         for (const selector of selectors) {
//             const buttons = current.querySelectorAll(selector);

//             for (const button of buttons) {
//                 const rect = button.getBoundingClientRect();

//                 if (
//                     isVisible(button) &&
//                     rect.bottom > 0 &&
//                     rect.top < window.innerHeight &&
//                     !button.disabled &&
//                     button.getAttribute("aria-disabled") !== "true"
//                 ) {
//                     return button;
//                 }
//             }
//         }

//         current = current.parentElement;
//     }

//     return null;
// }


// async function waitForSendButton(editor, timeout = 3000) {
//     const startedAt = Date.now();

//     while (
//         Date.now() - startedAt < timeout &&
//         editor.isConnected
//     ) {
//         const button = findSendButton(editor);

//         if (button) {
//             return button;
//         }

//         await new Promise((resolve) =>
//             setTimeout(resolve, 100)
//         );
//     }

//     return null;
// }


// /*
//  * CHATGPT RESPONSE DETECTION
//  */


// function getAssistantMessages() {
//     return Array.from(
//         document.querySelectorAll("main h4")
//     )
//         .filter(
//             (heading) =>
//                 heading.innerText?.trim() === "ChatGPT said:"
//         )
//         .map((heading) => heading.parentElement)
//         .filter(Boolean)
//         .filter(isVisible);
// }


// function getLatestAssistantMessage() {
//     const messages = getAssistantMessages();

//     return messages.length
//         ? messages[messages.length - 1]
//         : null;
// }


// // function getAssistantMessageText(element) {
// //     if (!element) return "";

// //     const contentElements = Array.from(element.children)
// //         .filter(
// //             (child) =>
// //                 !(
// //                     child.tagName === "H4" &&
// //                     child.innerText?.trim() === "ChatGPT said:"
// //                 )
// //         );

// //     return contentElements
// //         .map((child) => child.innerText || child.textContent || "")
// //         .join("\n")
// //         .trim();
// // }


// function getAssistantMessageText(element) {
//     if (!element) return "";

//     // Clone the message for safe DOM manipulation.
//     const clone = element.cloneNode(true);

//     // Get code surfaces from both the original and cloned messages.
//     const originalSurfaces = Array.from(
//         element.querySelectorAll('[class*="CodeSurface"]')
//     );

//     const clonedSurfaces = Array.from(
//         clone.querySelectorAll('[class*="CodeSurface"]')
//     );

//     // Retrieve the complete source from the ORIGINAL CodeMirror instances.
//     for (let index = 0; index < clonedSurfaces.length; index++) {
//         const originalSurface = originalSurfaces[index];
//         const clonedSurface = clonedSurfaces[index];

//         if (!originalSurface || !clonedSurface) continue;

//         const originalContent =
//             originalSurface.querySelector(".cm-content");

//         if (!originalContent) continue;

//         // Access CodeMirror on the original DOM, not the clone.
//         const editorView = originalContent.cmView?.view;

//         if (!editorView?.state?.doc) {
//             console.error(
//                 "[PromptFlow] Could not access the original CodeMirror editor."
//             );

//             throw new Error(
//                 "Could not retrieve the complete code block from ChatGPT. CodeMirror's editor instance was unavailable. The response was not captured."
//             );
//         }

//         // Read the entire document, including virtualized lines.
//         const sourceCode = editorView.state.doc.toString();

//         const pre = document.createElement("pre");
//         pre.textContent = sourceCode;

//         // Replace the cloned code surface with its complete source.
//         clonedSurface.replaceWith(pre);
//     }

//     // Exclude the assistant heading.
//     const contentElements = Array.from(clone.children).filter(
//         (child) =>
//             !(
//                 child.tagName === "H4" &&
//                 child.innerText?.trim() === "ChatGPT said:"
//             )
//     );

//     return contentElements
//         .map((child) => child.innerText || child.textContent || "")
//         .join("\n")
//         .trim();
// }

// // function findStopGeneratingButton() {
// //     const selectors = [
// //         'button[data-testid*="stop" i]',
// //         'button[aria-label*="stop" i]',
// //         'button[title*="stop" i]',
// //     ];

// //     for (const selector of selectors) {
// //         const buttons = document.querySelectorAll(selector);

// //         for (const button of buttons) {
// //             if (isVisible(button) && !button.disabled) {
// //                 return button;
// //             }
// //         }
// //     }

// //     return null;
// // }


// function findStopGeneratingButton() {
//     const selectors = [
//         'button[aria-label="Stop"]',
//         'button[data-testid*="stop" i]',
//         'button[aria-label*="stop" i]',
//         'button[title*="stop" i]',
//     ];

//     for (const selector of selectors) {
//         const buttons = document.querySelectorAll(selector);

//         for (const button of buttons) {
//             if (isVisible(button) && !button.disabled) {
//                 return button;
//             }
//         }
//     }

//     return null;
// }


// function isChatGPTGenerating() {
//     return Boolean(findStopGeneratingButton());
// }




// function getExpectedOutputIds(prompt) {
//     if (typeof prompt !== "string") return [];

//     const matches = prompt.matchAll(
//         /<<<PROMPTFLOW_OUTPUT_START:([^>\r\n]+)>>>/g
//     );

//     return [
//         ...new Set(
//             Array.from(matches, (match) => match[1].trim())
//                 .filter(Boolean)
//         ),
//     ];
// }


// /*
//  * WAIT FOR A NEW ASSISTANT RESPONSE
//  *
//  * Completion requires:
//  *
//  * 1. A new assistant message appears.
//  * 2. The response contains text.
//  * 3. ChatGPT's generation control disappears.
//  * 4. The response remains unchanged for a stability period.
//  *
//  * MutationObserver detects DOM changes.
//  * A short interval provides a fallback check.
//  */

// // function waitForAssistantResponse({
// //     previousSnapshot,
// //     timeout = RESPONSE_TIMEOUT_MS,
// // }) {
// //     return new Promise((resolve, reject) => {
// //         let observer = null;
// //         let interval = null;
// //         let timeoutTimer = null;

// //         let responseStarted = false;
// //         let responseStartedAt = null;
// //         let lastResponseText = "";
// //         let lastChangeAt = null;

// //         let settled = false;

// //         const startedAt = Date.now();

// //         function cleanup() {
// //             observer?.disconnect();

// //             if (interval) {
// //                 clearInterval(interval);
// //             }

// //             if (timeoutTimer) {
// //                 clearTimeout(timeoutTimer);
// //             }
// //         }

// //         function finish(error, result) {
// //             if (settled) return;

// //             settled = true;
// //             cleanup();

// //             if (error) {
// //                 reject(error);
// //             } else {
// //                 resolve(result);
// //             }
// //         }

// //         function checkResponse() {
// //             if (settled) return;

// //             const messages = getAssistantMessages();

// //             const latestMessage = messages.length
// //                 ? messages[messages.length - 1]
// //                 : null;

// //             if (!latestMessage) {
// //                 if (
// //                     Date.now() - startedAt >=
// //                     RESPONSE_START_TIMEOUT_MS
// //                 ) {
// //                     finish(
// //                         new Error(
// //                             "ChatGPT did not start a new assistant response within the allowed time."
// //                         )
// //                     );
// //                 }

// //                 return;
// //             }

// //             const responseText =
// //                 getAssistantMessageText(latestMessage);

// //             const isNewResponse =
// //                 latestMessage !== previousSnapshot?.element ||
// //                 messages.length > (previousSnapshot?.count || 0) ||
// //                 (
// //                     latestMessage === previousSnapshot?.element &&
// //                     responseText !== previousSnapshot?.text
// //                 );

// //             if (!isNewResponse || !responseText) {
// //                 if (
// //                     Date.now() - startedAt >=
// //                     RESPONSE_START_TIMEOUT_MS
// //                 ) {
// //                     finish(
// //                         new Error(
// //                             "ChatGPT did not start a new assistant response within the allowed time."
// //                         )
// //                     );
// //                 }

// //                 return;
// //             }

// //             const now = Date.now();

// //             if (!responseStarted) {
// //                 responseStarted = true;
// //                 responseStartedAt = now;
// //                 lastResponseText = responseText;
// //                 lastChangeAt = now;
// //             } else if (responseText !== lastResponseText) {
// //                 lastResponseText = responseText;
// //                 lastChangeAt = now;
// //             }

// //             if (isChatGPTGenerating()) {
// //                 lastChangeAt = now;
// //                 return;
// //             }

// //             if (
// //                 now - lastChangeAt >= RESPONSE_STABLE_MS
// //             ) {
// //                 finish(null, {
// //                     text: responseText,
// //                     completedAt: now,
// //                     duration: now - responseStartedAt,
// //                 });
// //             }
// //         }

// //         observer = new MutationObserver(checkResponse);

// //         observer.observe(document.body, {
// //             childList: true,
// //             subtree: true,
// //             characterData: true,
// //             attributes: true,
// //         });

// //         interval = setInterval(
// //             checkResponse,
// //             RESPONSE_CHECK_INTERVAL_MS
// //         );

// //         timeoutTimer = setTimeout(() => {
// //             finish(
// //                 new Error(
// //                     "Timed out while waiting for ChatGPT to complete its response."
// //                 )
// //             );
// //         }, timeout);

// //         checkResponse();
// //     });
// // }




// function waitForAssistantResponse({
//     previousSnapshot,
//     expectedOutputIds = [],
//     timeout = RESPONSE_TIMEOUT_MS,
// }) {
//     return new Promise((resolve, reject) => {
//         let observer = null;
//         let interval = null;
//         let timeoutTimer = null;

//         let responseStarted = false;
//         let responseStartedAt = null;

//         let generationObserved = false;

//         let lastResponseText = "";
//         let lastChangeAt = null;

//         let settled = false;

//         const startedAt = Date.now();

//         function cleanup() {
//             observer?.disconnect();

//             if (interval) {
//                 clearInterval(interval);
//             }

//             if (timeoutTimer) {
//                 clearTimeout(timeoutTimer);
//             }
//         }

//         function finish(error, result) {
//             if (settled) return;

//             settled = true;
//             cleanup();

//             if (error) {
//                 reject(error);
//             } else {
//                 resolve(result);
//             }
//         }

//         function hasAllExpectedEndMarkers(responseText) {
//             if (!expectedOutputIds.length) {
//                 return true;
//             }

//             return expectedOutputIds.every((id) =>
//                 responseText.includes(
//                     `<<<PROMPTFLOW_OUTPUT_END:${id}>>>`
//                 )
//             );
//         }

//         function checkResponse() {
//             if (settled) return;

//             const now = Date.now();
//             const isGenerating = isChatGPTGenerating();

//             // Record that ChatGPT genuinely entered generation.
//             if (isGenerating) {
//                 generationObserved = true;
//             }

//             const messages = getAssistantMessages();

//             const latestMessage = messages.length
//                 ? messages[messages.length - 1]
//                 : null;

//             if (!latestMessage) {
//                 if (
//                     now - startedAt >= RESPONSE_START_TIMEOUT_MS
//                 ) {
//                     finish(
//                         new Error(
//                             "ChatGPT did not start a new assistant response within the allowed time."
//                         )
//                     );
//                 }

//                 return;
//             }

//             const responseText =
//                 getAssistantMessageText(latestMessage);

//             const isNewResponse =
//                 latestMessage !== previousSnapshot?.element ||
//                 messages.length > (previousSnapshot?.count || 0) ||
//                 (
//                     latestMessage === previousSnapshot?.element &&
//                     responseText !== previousSnapshot?.text
//                 );

//             if (!isNewResponse || !responseText) {
//                 if (
//                     now - startedAt >= RESPONSE_START_TIMEOUT_MS
//                 ) {
//                     finish(
//                         new Error(
//                             "ChatGPT did not start a new assistant response within the allowed time."
//                         )
//                     );
//                 }

//                 return;
//             }

//             if (!responseStarted) {
//                 responseStarted = true;
//                 responseStartedAt = now;
//                 lastResponseText = responseText;
//                 lastChangeAt = now;
//             } else if (responseText !== lastResponseText) {
//                 lastResponseText = responseText;
//                 lastChangeAt = now;
//             }

//             // Never complete while ChatGPT is generating.
//             if (isGenerating) {
//                 lastChangeAt = now;
//                 return;
//             }

//             // Do not accept a response until generation was observed.
//             if (!generationObserved) {
//                 return;
//             }

//             // Workflow responses must contain all expected end markers.
//             // This prevents a partial response from being accepted.
//             if (!hasAllExpectedEndMarkers(responseText)) {
//                 return;
//             }

//             // Require the completed response to remain unchanged.
//             if (
//                 now - lastChangeAt >= RESPONSE_STABLE_MS
//             ) {
//                 finish(null, {
//                     text: responseText,
//                     completedAt: now,
//                     duration: now - responseStartedAt,
//                 });
//             }
//         }

//         observer = new MutationObserver(checkResponse);

//         observer.observe(document.body, {
//             childList: true,
//             subtree: true,
//             characterData: true,
//             attributes: true,
//         });

//         interval = setInterval(
//             checkResponse,
//             RESPONSE_CHECK_INTERVAL_MS
//         );

//         timeoutTimer = setTimeout(() => {
//             finish(
//                 new Error(
//                     "Timed out while waiting for ChatGPT to complete its response. The response may be incomplete or missing one or more expected output end markers."
//                 )
//             );
//         }, timeout);

//         checkResponse();
//     });
// }





// /*
//  * PROMPT HANDLER
//  */


// /*
 * RESPONSE RECOVERY
 *
 * If the network stream reports an error, inspect the rendered answer
 * before resending the original prompt.
 */
const RESPONSE_RECOVERY_STABILITY_MS = 4000;
const RESPONSE_RECOVERY_START_TIMEOUT_MS = 60000;
const MAX_RESPONSE_ATTEMPTS = 3;

function getExpectedOutputIds(prompt) {
    if (typeof prompt !== "string") return [];
    const matches = prompt.matchAll(/<<<PROMPTFLOW_OUTPUT_START:([^>\\r\\n]+)>>>/g);
    return [...new Set(Array.from(matches, (match) => match[1].trim()).filter(Boolean))];
}

function getAssistantMessages() {
    const messages = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"]')
    ).filter(isVisible);
    if (messages.length) return messages;

    return Array.from(document.querySelectorAll("main h4"))
        .filter((heading) => heading.innerText?.trim() === "ChatGPT said:")
        .map((heading) => heading.parentElement)
        .filter(Boolean)
        .filter(isVisible);
}

function getAssistantMessageText(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    const originalSurfaces = Array.from(element.querySelectorAll('[class*="CodeSurface"]'));
    const clonedSurfaces = Array.from(clone.querySelectorAll('[class*="CodeSurface"]'));

    for (let index = 0; index < clonedSurfaces.length; index += 1) {
        const originalContent = originalSurfaces[index]?.querySelector(".cm-content");
        const clonedSurface = clonedSurfaces[index];
        if (!originalContent || !clonedSurface) continue;

        const editorView = originalContent.cmView?.view;
        if (editorView?.state?.doc) {
            const pre = document.createElement("pre");
            pre.textContent = editorView.state.doc.toString();
            clonedSurface.replaceWith(pre);
        }
    }

    return (clone.innerText || clone.textContent || "").trim();
}

function getAssistantSnapshot() {
    const messages = getAssistantMessages();
    const element = messages.at(-1) || null;
    return {
        element,
        count: messages.length,
        text: getAssistantMessageText(element),
    };
}

function hasCompleteWorkflowOutput(responseText, expectedOutputIds) {
    if (typeof responseText !== "string" || !responseText.trim()) return false;
    if (!expectedOutputIds.length) return true;

    return expectedOutputIds.every((outputId) => {
        const startMarker = "<<<PROMPTFLOW_OUTPUT_START:" + outputId + ">>>";
        const endMarker = "<<<PROMPTFLOW_OUTPUT_END:" + outputId + ">>>";
        if (
            responseText.split(startMarker).length - 1 !== 1 ||
            responseText.split(endMarker).length - 1 !== 1
        ) return false;

        const startPosition = responseText.indexOf(startMarker);
        const endPosition = responseText.indexOf(endMarker);
        return endPosition > startPosition + startMarker.length;
    });
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAssistantResponseRecovery({
    previousSnapshot,
    expectedOutputIds,
    timeout = RESPONSE_TIMEOUT_MS,
}) {
    const startedAt = Date.now();
    let responseStarted = false;
    let lastResponseText = "";
    let lastChangeAt = 0;

    while (Date.now() - startedAt < timeout) {
        const now = Date.now();
        const generating = isChatGPTGenerating();
        let snapshot = null;

        try {
            snapshot = getAssistantSnapshot();
        } catch (error) {
            console.warn("[PromptFlow] Waiting for rendered response to become readable.", error);
        }

        if (snapshot?.text) {
            const isNewResponse =
                snapshot.element !== previousSnapshot?.element ||
                snapshot.count > (previousSnapshot?.count || 0) ||
                (
                    snapshot.element === previousSnapshot?.element &&
                    snapshot.text !== previousSnapshot?.text
                );

            if (isNewResponse) {
                if (!responseStarted || snapshot.text !== lastResponseText) {
                    responseStarted = true;
                    lastResponseText = snapshot.text;
                    lastChangeAt = now;
                }

                if (generating) {
                    lastChangeAt = now;
                } else if (now - lastChangeAt >= RESPONSE_RECOVERY_STABILITY_MS) {
                    return {
                        text: snapshot.text,
                        completedAt: now,
                        duration: now - startedAt,
                        source: "chatgpt_dom_recovery",
                        complete: hasCompleteWorkflowOutput(snapshot.text, expectedOutputIds),
                    };
                }
            }
        }

        if (
            !responseStarted &&
            !generating &&
            now - startedAt >= RESPONSE_RECOVERY_START_TIMEOUT_MS
        ) return null;

        await delay(250);
    }

    return null;
}

async function insertAndSendPrompt(prompt, shouldWait) {
    const editor = findChatGPTComposer();
    if (!editor) {
        throw new Error("Could not find ChatGPT's message composer. Make sure ChatGPT is open and the page has finished loading.");
    }

    insertIntoComposer(editor, prompt);
    await delay(300);

    const composerText = editor instanceof HTMLTextAreaElement
        ? editor.value
        : editor.innerText || editor.textContent || "";
    const normalizeText = (value) => value.replace(/\\s+/g, " ").trim();
    const expectedText = normalizeText(prompt);
    const actualText = normalizeText(composerText);

    if (!actualText.includes(expectedText.slice(0, Math.min(80, expectedText.length)))) {
        throw new Error("Prompt insertion could not be verified in ChatGPT's active composer.");
    }
    if (!editor.isConnected) {
        throw new Error("The ChatGPT composer changed before the prompt could be sent.");
    }

    const sendButton = await waitForSendButton(editor);
    if (!sendButton) {
        throw new Error("The prompt was inserted, but ChatGPT's Send button could not be found.");
    }

    let responseCapture = null;
    if (shouldWait) {
        responseCapture = await createResponseCapture({
            responseTimeout: RESPONSE_TIMEOUT_MS,
        });
    }
    sendButton.click();
    return { responseCapture, sent: true };
}

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

    try {
        if (!shouldSend) {
            await insertAndSendPrompt(prompt, false);

            return {
                success: true,
                message: "Prompt inserted into ChatGPT.",
            };
        }

        if (isChatGPTGenerating()) {
            return {
                success: false,
                error:
                    "ChatGPT is already generating a response. Wait for it to finish before starting another workflow task.",
            };
        }

        if (!shouldWait) {
            await insertAndSendPrompt(prompt, false);

            return {
                success: true,
                message: "Prompt inserted and sent to ChatGPT.",
            };
        }

        const expectedOutputIds = getExpectedOutputIds(prompt);
        let lastError = null;

        for (
            let attempt = 1;
            attempt <= MAX_RESPONSE_ATTEMPTS;
            attempt += 1
        ) {
            if (isChatGPTGenerating()) {
                throw new Error(
                    "ChatGPT is still generating a response. PromptFlow will not submit a duplicate prompt while generation is active."
                );
            }

            let previousSnapshot;

            try {
                previousSnapshot = getAssistantSnapshot();
            } catch {
                previousSnapshot = {
                    element: null,
                    count: 0,
                    text: "",
                };
            }

            let responseCapture = null;
            let promptWasSent = false;
            let capturedResponse = null;

            try {
                const sent = await insertAndSendPrompt(prompt, true);
                responseCapture = sent.responseCapture;
                promptWasSent = sent.sent;

                capturedResponse = await responseCapture.promise;

                if (
                    hasCompleteWorkflowOutput(
                        capturedResponse.text,
                        expectedOutputIds
                    )
                ) {
                    console.info(
                        "[PromptFlow] Complete response captured from ChatGPT's network stream.",
                        {
                            attempt,
                            length: capturedResponse.text.length,
                            duration: capturedResponse.duration,
                            source: capturedResponse.source,
                        }
                    );

                    return {
                        success: true,
                        message: "ChatGPT completed its response.",
                        response: capturedResponse,
                    };
                }

                lastError = new Error(
                    "The captured response did not contain every expected output block."
                );
            } catch (error) {
                lastError = error;
            } finally {
                if (responseCapture && activeResponseCapture) {
                    responseCapture.cancel(
                        "PromptFlow is checking the rendered response before retrying."
                    );
                }
            }

            if (!promptWasSent) {
                throw lastError || new Error(
                    "PromptFlow could not send the prompt."
                );
            }

            console.warn(
                "[PromptFlow] Network capture was incomplete. Checking ChatGPT's latest rendered answer before retrying.",
                {
                    attempt,
                    error: lastError?.message || "Unknown response capture error.",
                }
            );

            const recoveredResponse = await waitForAssistantResponseRecovery({
                previousSnapshot,
                expectedOutputIds,
                timeout: RESPONSE_TIMEOUT_MS,
            });

            if (
                recoveredResponse &&
                recoveredResponse.complete
            ) {
                console.info(
                    "[PromptFlow] Recovered the complete response from ChatGPT's conversation. The prompt will not be resent.",
                    {
                        attempt,
                        length: recoveredResponse.text.length,
                    }
                );

                return {
                    success: true,
                    message: "ChatGPT response recovered from the conversation.",
                    response: recoveredResponse,
                };
            }

            if (recoveredResponse) {
                lastError = new Error(
                    "ChatGPT finished responding, but the latest answer is still missing one or more expected output markers."
                );
            }

            if (attempt < MAX_RESPONSE_ATTEMPTS) {
                console.warn(
                    "[PromptFlow] The latest answer is still incomplete. Resending the original prompt.",
                    {
                        nextAttempt: attempt + 1,
                        maxAttempts: MAX_RESPONSE_ATTEMPTS,
                    }
                );

                await delay(1000 * attempt);
                continue;
            }
        }

        throw new Error(
            "PromptFlow could not recover a complete ChatGPT response after " +
            MAX_RESPONSE_ATTEMPTS +
            " attempts. " +
            (lastError?.message || "The response remained incomplete.")
        );

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


console.log(
    "[PromptFlow] Content script loaded."
);