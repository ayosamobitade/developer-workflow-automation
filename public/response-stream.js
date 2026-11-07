(() => {
    "use strict";

    const BRIDGE_SOURCE = "PROMPTFLOW_MAIN_WORLD";
    const CONTENT_SOURCE = "PROMPTFLOW_CONTENT";

    const CONVERSATION_PATH = "/backend-api/f/conversation";

    if (window.__PROMPTFLOW_STREAM_OBSERVER__) {
        return;
    }

    window.__PROMPTFLOW_STREAM_OBSERVER__ = true;

    let armedCaptureId = null;

    function sendToContent(type, captureId, payload = {}) {
        window.postMessage(
            {
                source: BRIDGE_SOURCE,
                type,
                captureId,
                ...payload,
            },
            location.origin
        );
    }

    function isConversationRequest(input) {
        try {
            let requestUrl = null;

            if (typeof input === "string") {
                requestUrl = input;
            } else if (
                input instanceof URL ||
                input instanceof Request
            ) {
                requestUrl = input.href || input.url;
            } else if (input && typeof input === "object") {
                requestUrl = input.url || input.href;
            }

            if (!requestUrl) {
                return false;
            }

            const url = new URL(requestUrl, location.href);

            return (
                url.origin === location.origin &&
                url.pathname === CONVERSATION_PATH
            );
        } catch (error) {
            console.warn(
                "[PromptFlow] Could not inspect fetch request URL.",
                error
            );

            return false;
        }
    }

    function parseSSEBlock(block) {
        let eventName = "";

        const dataLines = [];

        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
            }

            if (line.startsWith("data:")) {
                dataLines.push(
                    line.slice(5).replace(/^ /, "")
                );
            }
        }

        if (!dataLines.length) {
            return null;
        }

        let data;

        try {
            data = JSON.parse(dataLines.join("\n"));
        } catch {
            return null;
        }

        return { eventName, data };
    }

    function createCaptureState(captureId) {
        return {
            captureId,

            text: "",
            sawContent: false,

            status: null,
            endTurn: false,
            isComplete: false,

            terminalSeen: false,
            startedAt: Date.now(),
        };
    }

    /*
     * APPLY ONE JSON PATCH OPERATION
     */

    function applyPatch(state, patch) {
        if (!patch || typeof patch !== "object") {
            return;
        }

        if (
            patch.p === "/message/content/parts/0" &&
            typeof patch.v === "string"
        ) {
            if (
                patch.o === "replace" ||
                patch.o === "add"
            ) {
                state.text = patch.v;
            } else if (patch.o === "append") {
                state.text += patch.v;
            } else {
                return;
            }

            state.sawContent = true;
            return;
        }

        if (patch.p === "/message/status") {
            if (
                patch.o === "replace" ||
                patch.o === "add"
            ) {
                state.status = patch.v;
            }

            return;
        }

        if (patch.p === "/message/end_turn") {
            state.endTurn = patch.v === true;
            return;
        }

        if (
            patch.p === "/message/metadata" &&
            patch.v &&
            typeof patch.v === "object"
        ) {
            state.isComplete =
                patch.v.is_complete === true ||
                state.isComplete;
        }
    }

    /*
     * APPLY CHATGPT DELTA
     */

    function applyDelta(state, eventName, item) {
        if (eventName !== "delta") {
            return;
        }

        if (!item || typeof item !== "object") {
            return;
        }

        // Current ChatGPT format: batched JSON Patch operations.
        if (Array.isArray(item.v)) {
            for (const patch of item.v) {
                applyPatch(state, patch);
            }

            return;
        }

        // Individual JSON Patch operation.
        if (typeof item.p === "string") {
            applyPatch(state, item);
            return;
        }

        // Compact ChatGPT text delta.
        if (
            typeof item.v === "string" &&
            !Object.prototype.hasOwnProperty.call(item, "p")
        ) {
            state.text += item.v;
            state.sawContent = true;
        }
    }

    /*
     * FINAL RESPONSE VALIDATION
     */

    function validateCompletedCapture(state) {
        if (!state.terminalSeen) {
            throw new Error(
                "ChatGPT did not send its message_stream_complete event."
            );
        }

        if (state.status !== "finished_successfully") {
            throw new Error(
                "ChatGPT did not confirm successful message completion."
            );
        }

        if (!state.endTurn) {
            throw new Error(
                "ChatGPT did not confirm that the assistant turn ended."
            );
        }

        if (!state.isComplete) {
            throw new Error(
                "ChatGPT did not confirm that the message is complete."
            );
        }

        if (!state.sawContent || !state.text.trim()) {
            throw new Error(
                "ChatGPT completed the stream without providing response text."
            );
        }

        return {
            text: state.text,
            completedAt: Date.now(),
            duration: Date.now() - state.startedAt,
            source: "chatgpt_stream",
        };
    }

    /*
     * STREAM CAPTURE
     */

    async function captureResponse(response, captureId) {
        if (!response.ok) {
            sendToContent("ERROR", captureId, {
                error: `ChatGPT returned HTTP ${response.status}.`,
            });

            return;
        }

        const contentType =
            response.headers.get("content-type") || "";

        if (
            !contentType.toLowerCase().includes(
                "text/event-stream"
            )
        ) {
            sendToContent("ERROR", captureId, {
                error:
                    "ChatGPT's response was not an SSE stream.",
            });

            return;
        }

        if (!response.body) {
            sendToContent("ERROR", captureId, {
                error:
                    "ChatGPT returned an empty response stream.",
            });

            return;
        }

        sendToContent("STARTED", captureId);

        const state = createCaptureState(captureId);

        const reader = response.clone().body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";

        function processBlock(block) {
            const parsed = parseSSEBlock(block);

            if (!parsed) {
                return;
            }

            const { eventName, data } = parsed;

            if (
                data.type === "message_stream_complete"
            ) {
                console.info(
                    "[PromptFlow] Terminal stream event:",
                    data
                );

                console.info(
                    "[PromptFlow] Capture state at completion:",
                    {
                        status: state.status,
                        endTurn: state.endTurn,
                        isComplete: state.isComplete,
                        sawContent: state.sawContent,
                        textLength: state.text.length,
                    }
                );

                state.terminalSeen = true;
                return;
            }

            applyDelta(state, eventName, data);
        }

        function processBuffer() {
            const blocks = buffer.split(/\r?\n\r?\n/);

            buffer = blocks.pop() || "";

            for (const block of blocks) {
                if (!block.trim()) {
                    continue;
                }

                processBlock(block);

                if (state.terminalSeen) {
                    break;
                }
            }
        }

        try {
            while (!state.terminalSeen) {
                const { value, done } = await reader.read();

                if (done) {
                    buffer += decoder.decode();
                    processBuffer();

                    if (
                        buffer.trim() &&
                        !state.terminalSeen
                    ) {
                        processBlock(buffer);
                    }

                    buffer = "";
                    break;
                }

                buffer += decoder.decode(value, {
                    stream: true,
                });

                processBuffer();
            }

            if (!state.terminalSeen) {
                throw new Error(
                    "ChatGPT's response stream ended before its completion event."
                );
            }

            const result = validateCompletedCapture(state);

            sendToContent("COMPLETE", captureId, {
                response: result,
            });
        } catch (error) {
            if (state.terminalSeen) {
                try {
                    const result = validateCompletedCapture(state);

                    sendToContent("COMPLETE", captureId, {
                        response: result,
                    });

                    return;
                } catch (validationError) {
                    error = validationError;
                }
            }

            sendToContent("ERROR", captureId, {
                error:
                    error.message ||
                    "ChatGPT response capture failed.",
            });
        } finally {
            try {
                await reader.cancel();
            } catch {
                // ChatGPT may already have aborted the cloned stream.
            }
        }
    }

    /*
     * CONTENT SCRIPT BRIDGE
     */

    window.addEventListener("message", (event) => {
        if (
            event.source !== window ||
            event.origin !== location.origin
        ) {
            return;
        }

        const message = event.data;

        if (message?.source !== CONTENT_SOURCE) {
            return;
        }

        if (message.type === "PING") {
            sendToContent("READY", null);
            return;
        }

        if (
            message.type === "ARM" &&
            typeof message.captureId === "string"
        ) {
            armedCaptureId = message.captureId;

            console.info("[PromptFlow] MAIN received ARM.", {
                captureId: armedCaptureId,
            });

            sendToContent("ARMED", armedCaptureId);
            return;
        }

        if (
            message.type === "CANCEL" &&
            message.captureId === armedCaptureId
        ) {
            console.info("[PromptFlow] MAIN received CANCEL.");
            armedCaptureId = null;
        }
    });

    /*
     * FETCH INTERCEPTION
     */

    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const isConversation = isConversationRequest(args[0]);

        const captureId = isConversation
            ? armedCaptureId
            : null;

        if (isConversation) {
            console.info(
                "[PromptFlow] Conversation fetch detected.",
                {
                    armed: Boolean(armedCaptureId),
                    captureId: captureId || null,
                }
            );
        }

        let response;

        try {
            response = await Reflect.apply(
                originalFetch,
                this,
                args
            );
        } catch (error) {
            if (captureId) {
                sendToContent("ERROR", captureId, {
                    error:
                        error.message ||
                        "ChatGPT's conversation request failed.",
                });
            }

            throw error;
        }

        if (captureId) {
            armedCaptureId = null;

            console.info(
                "[PromptFlow] Starting response capture.",
                { captureId }
            );

            captureResponse(response, captureId).catch((error) => {
                sendToContent("ERROR", captureId, {
                    error:
                        error.message ||
                        "Unexpected response capture failure.",
                });
            });
        }

        return response;
    };

    console.log(
        "[PromptFlow] MAIN-world response observer installed."
    );
})();