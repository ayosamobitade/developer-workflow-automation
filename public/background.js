// const NATIVE_HOST = "com.samworld.promptflow";

// const extensionBaseURL = browser.runtime.getURL("");

// browser.runtime.onMessage.addListener((message, sender) => {
//     if (message?.type !== "PROMPTFLOW_NATIVE") {
//         return undefined;
//     }

//     if (
//         !sender.url ||
//         !sender.url.startsWith(extensionBaseURL)
//     ) {
//         return Promise.resolve({
//             ok: false,
//             error: "Unauthorized native messaging request.",
//         });
//     }

//     if (
//         !message.request ||
//         typeof message.request !== "object"
//     ) {
//         return Promise.resolve({
//             ok: false,
//             error: "Invalid native messaging request.",
//         });
//     }

//     // Log only the operation name. Never log tokens,
//     // source code, generated content, or full requests.
//     const action =
//         typeof message.request.action === "string"
//             ? message.request.action
//             : "unknown";

//     return browser.runtime
//         .sendNativeMessage(NATIVE_HOST, message.request)
//         .catch((error) => {
//             console.error(
//                 `[PromptFlow] Native operation failed: ${action}`,
//                 error.message || String(error)
//             );

//             return {
//                 ok: false,
//                 error: error.message || String(error),
//             };
//         });
// });



// console.log("[PromptFlow] Background script loaded.");

// const NATIVE_HOST = "com.samworld.promptflow";

// const extensionBaseURL = browser.runtime.getURL("");

// browser.runtime.onMessage.addListener((message, sender) => {
//     // Temporary clipboard test.
//     if (message?.type === "PROMPTFLOW_READ_CLIPBOARD") {
//         if (
//             !sender.url ||
//             !sender.url.startsWith(extensionBaseURL)
//         ) {
//             return Promise.resolve({
//                 ok: false,
//                 error: "Unauthorized clipboard request.",
//             });
//         }

//         return navigator.clipboard.readText()
//             .then((text) => ({
//                 ok: true,
//                 text,
//                 length: text.length,
//                 lineCount: text.split("\n").length,
//             }))
//             .catch((error) => ({
//                 ok: false,
//                 error: error.message || String(error),
//             }));
//     }

//     if (message?.type !== "PROMPTFLOW_NATIVE") {
//         return undefined;
//     }

//     if (
//         !sender.url ||
//         !sender.url.startsWith(extensionBaseURL)
//     ) {
//         return Promise.resolve({
//             ok: false,
//             error: "Unauthorized native messaging request.",
//         });
//     }

//     if (
//         !message.request ||
//         typeof message.request !== "object"
//     ) {
//         return Promise.resolve({
//             ok: false,
//             error: "Invalid native messaging request.",
//         });
//     }

//     const action =
//         typeof message.request.action === "string"
//             ? message.request.action
//             : "unknown";

//     return browser.runtime
//         .sendNativeMessage(NATIVE_HOST, message.request)
//         .catch((error) => {
//             console.error(
//                 `[PromptFlow] Native operation failed: ${action}`,
//                 error.message || String(error)
//             );

//             return {
//                 ok: false,
//                 error: error.message || String(error),
//             };
//         });
// });



console.log("[PromptFlow] Background script loaded.");

const NATIVE_HOST = "com.samworld.promptflow";

const extensionBaseURL = browser.runtime.getURL("");


browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "PROMPTFLOW_NATIVE") {
        return undefined;
    }

    if (
        !sender.url ||
        !sender.url.startsWith(extensionBaseURL)
    ) {
        return Promise.resolve({
            ok: false,
            error: "Unauthorized native messaging request.",
        });
    }

    if (
        !message.request ||
        typeof message.request !== "object"
    ) {
        return Promise.resolve({
            ok: false,
            error: "Invalid native messaging request.",
        });
    }

    const action =
        typeof message.request.action === "string"
            ? message.request.action
            : "unknown";

    return browser.runtime
        .sendNativeMessage(
            NATIVE_HOST,
            message.request
        )
        .catch((error) => {
            console.error(
                `[PromptFlow] Native operation failed: ${action}`,
                error.message || String(error)
            );

            return {
                ok: false,
                error: error.message || String(error),
            };
        });
});


import "./background-coordinator.js";