[1mdiff --git a/src/features/workflows/services/workflowPromptService.js b/src/features/workflows/services/workflowPromptService.js[m
[1mindex 9107fe7..22da440 100644[m
[1m--- a/src/features/workflows/services/workflowPromptService.js[m
[1m+++ b/src/features/workflows/services/workflowPromptService.js[m
[36m@@ -3,7 +3,7 @@[m [mimport {[m
 } from "../definitions/django-model-workflow.js";[m
 [m
 import {[m
[31m-    filterProjectTree,[m
[32m+[m[32m    filterModelProjectTree,[m
     isInitFilePath,[m
 } from "./workflowPathUtils.js";[m
 [m
[36m@@ -45,7 +45,7 @@[m [mfunction validateSourceContents(task, sourceContents) {[m
 [m
 [m
 function formatProjectTree(projectTree) {[m
[31m-    const filteredTree = filterProjectTree(projectTree);[m
[32m+[m[32m    const filteredTree = filterModelProjectTree(projectTree);[m
 [m
     if (!filteredTree.trim()) {[m
         throw new Error([m
[36m@@ -128,6 +128,38 @@[m [mfunction formatExpectedOutputs(task, destinationHints = {}) {[m
 }[m
 [m
 [m
[32m+[m[32m// function formatOutputInstructions(task) {[m
[32m+[m[32m//     const instructions = task.outputs.map((output, index) => {[m
[32m+[m[32m//         const startMarker =[m
[32m+[m[32m//             `<<<PROMPTFLOW_OUTPUT_START:${output.id}>>>`;[m
[32m+[m
[32m+[m[32m//         const endMarker =[m
[32m+[m[32m//             `<<<PROMPTFLOW_OUTPUT_END:${output.id}>>>`;[m
[32m+[m
[32m+[m[32m//         return [[m
[32m+[m[32m//             `${index + 1}. ${output.name}`,[m
[32m+[m[32m//             "",[m
[32m+[m[32m//             `Begin this file with exactly: ${startMarker}`,[m
[32m+[m[32m//             `End this file with exactly: ${endMarker}`,[m
[32m+[m[32m//             "",[m
[32m+[m[32m//             "Put only the complete file content between these markers.",[m
[32m+[m[32m//         ].join("\n");[m
[32m+[m[32m//     });[m
[32m+[m
[32m+[m[32m//     return [[m
[32m+[m[32m//         "OUTPUT FORMATTING REQUIREMENTS",[m
[32m+[m[32m//         "==============================",[m
[32m+[m[32m//         "",[m
[32m+[m[32m//         "You must produce every required output as a separate, clearly marked file.",[m
[32m+[m[32m//         "Do not combine multiple files into one code block.",[m
[32m+[m[32m//         "Do not omit any required output.",[m
[32m+[m[32m//         "Do not place explanations inside the file content.",[m
[32m+[m[32m//         "Do not change the output marker identifiers.",[m
[32m+[m[32m//         "",[m
[32m+[m[32m//         ...instructions,[m
[32m+[m[32m//     ].join("\n");[m
[32m+[m[32m// }[m
[32m+[m
 function formatOutputInstructions(task) {[m
     const instructions = task.outputs.map((output, index) => {[m
         const startMarker =[m
[36m@@ -136,25 +168,53 @@[m [mfunction formatOutputInstructions(task) {[m
         const endMarker =[m
             `<<<PROMPTFLOW_OUTPUT_END:${output.id}>>>`;[m
 [m
[32m+[m[32m        const language =[m
[32m+[m[32m            output.type === "python" ? "python" : "";[m
[32m+[m
         return [[m
[31m-            `${index + 1}. ${output.name}`,[m
[32m+[m[32m            `OUTPUT ${index + 1}: ${output.name}`,[m
             "",[m
[31m-            `Begin this file with exactly: ${startMarker}`,[m
[31m-            `End this file with exactly: ${endMarker}`,[m
[32m+[m[32m            `Start marker: ${startMarker}`,[m
[32m+[m[32m            `End marker: ${endMarker}`,[m
[32m+[m[32m            "",[m
[32m+[m[32m            "Required structure:",[m
[32m+[m[32m            startMarker,[m
[32m+[m[32m            `\`\`\`${language}`,[m
[32m+[m[32m            "[THE ENTIRE FILE CONTENT MUST BE HERE]",[m
[32m+[m[32m            "```",[m
[32m+[m[32m            endMarker,[m
             "",[m
[31m-            "Put only the complete file content between these markers.",[m
[32m+[m[32m            "The markers must be outside the code fence.",[m
[32m+[m[32m            "The opening and closing code fences must be inside the markers.",[m
[32m+[m[32m            "Replace the placeholder with the complete file content.",[m
         ].join("\n");[m
     });[m
 [m
     return [[m
[31m-        "OUTPUT FORMATTING REQUIREMENTS",[m
[31m-        "==============================",[m
[32m+[m[32m        "STRICT OUTPUT FORMATTING REQUIREMENTS",[m
[32m+[m[32m        "======================================",[m
         "",[m
[31m-        "You must produce every required output as a separate, clearly marked file.",[m
[31m-        "Do not combine multiple files into one code block.",[m
[31m-        "Do not omit any required output.",[m
[31m-        "Do not place explanations inside the file content.",[m
[31m-        "Do not change the output marker identifiers.",[m
[32m+[m[32m        "Every required output MUST be returned as a complete file.",[m
[32m+[m[32m        "",[m
[32m+[m[32m        "MANDATORY RULES:",[m
[32m+[m[32m        "1. Put the ENTIRE file inside exactly ONE Markdown fenced code block.",[m
[32m+[m[32m        "2. The code block must contain everything, from the first line to the last line of the file.",[m
[32m+[m[32m        "3. Do not put any source code before the opening code fence.",[m
[32m+[m[32m        "4. Do not put any source code after the closing code fence.",[m
[32m+[m[32m        "5. Never split a file across multiple code blocks.",[m
[32m+[m[32m        "6. Never put class declarations, function declarations, imports, docstrings, comments, decorators, or variable assignments in ordinary Markdown paragraphs.",[m
[32m+[m[32m        "7. Preserve the correct indentation throughout the entire file.",[m
[32m+[m[32m        "8. For Python, use four spaces for each indentation level. Never use tabs.",[m
[32m+[m[32m        "9. Do not include explanations, headings, labels, or commentary inside the code block.",[m
[32m+[m[32m        "10. Do not include the word Code or any interface label in the source file.",[m
[32m+[m[32m        "11. Do not use placeholders, omissions, or abbreviated implementations.",[m
[32m+[m[32m        "12. Generate all required files independently.",[m
[32m+[m[32m        "13. Do not put Markdown code fences around the output markers.",[m
[32m+[m[32m        "14. Do not change, omit, or modify any output marker.",[m
[32m+[m[32m        "",[m
[32m+[m[32m        "IMPORTANT: The output markers are plain text delimiters. The code fence belongs INSIDE each pair of markers, not outside them.",[m
[32m+[m[32m        "",[m
[32m+[m[32m        "OUTPUT STRUCTURES:",[m
         "",[m
         ...instructions,[m
     ].join("\n");[m
[36m@@ -219,9 +279,15 @@[m [mexport function generateWorkflowPrompt({[m
             `Model file: ${workflow.input.modelPath}`,[m
         ].join("\n"),[m
 [m
[31m-        formatProjectTree([m
[31m-            workflow.input.projectTree[m
[31m-        ),[m
[32m+[m[32m        ...(task.sources.some([m
[32m+[m[32m            (source) => source.type === "project_tree"[m
[32m+[m[32m        )[m
[32m+[m[32m            ? [[m
[32m+[m[32m                formatProjectTree([m
[32m+[m[32m                    workflow.input.projectTree[m
[32m+[m[32m                ),[m
[32m+[m[32m            ][m
[32m+[m[32m            : []),[m
 [m
         [[m
             "TASK INSTRUCTIONS",[m
[36m@@ -259,6 +325,21 @@[m [mexport function generateWorkflowPrompt({[m
         ].join("\n"));[m
     }[m
 [m
[32m+[m[32m    // sections.push([[m
[32m+[m[32m    //     "IMPORTANT REQUIREMENTS",[m
[32m+[m[32m    //     "======================",[m
[32m+[m[32m    //     "1. Follow the supplied project architecture and naming conventions.",[m
[32m+[m[32m    //     "2. Do not invent models, files, or project structures that were not requested.",[m
[32m+[m[32m    //     "3. Preserve compatibility with the supplied source files.",[m
[32m+[m[32m    //     "4. Generate complete, production-quality Python files.",[m
[32m+[m[32m    //     "5. Produce all required outputs.",[m
[32m+[m[32m    //     "6. Keep every output between its exact PromptFlow markers.",[m
[32m+[m[32m    //     "7. Do not put Markdown code fences around the output markers.",[m
[32m+[m[32m    //     "8. Do not include commentary between output markers.",[m
[32m+[m[32m    //     "9. Never generate, modify, or include Python __init__.py files.",[m
[32m+[m[32m    //     "10. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",[m
[32m+[m[32m    // ].join("\n"));[m
[32m+[m
     sections.push([[m
         "IMPORTANT REQUIREMENTS",[m
         "======================",[m
[36m@@ -266,12 +347,15 @@[m [mexport function generateWorkflowPrompt({[m
         "2. Do not invent models, files, or project structures that were not requested.",[m
         "3. Preserve compatibility with the supplied source files.",[m
         "4. Generate complete, production-quality Python files.",[m
[31m-        "5. Produce all required outputs.",[m
[31m-        "6. Keep every output between its exact PromptFlow markers.",[m
[31m-        "7. Do not put Markdown code fences around the output markers.",[m
[31m-        "8. Do not include commentary between output markers.",[m
[31m-        "9. Never generate, modify, or include Python __init__.py files.",[m
[31m-        "10. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",[m
[32m+[m[32m        "5. Produce every required output.",[m
[32m+[m[32m        "6. Put the entire content of each output inside exactly one Python code block.",[m
[32m+[m[32m        "7. Nothing belonging to a generated file may appear outside its code block.",[m
[32m+[m[32m        "8. Keep the output markers outside the code fences.",[m
[32m+[m[32m        "9. Keep the opening and closing code fences inside the corresponding output markers.",[m
[32m+[m[32m        "10. Preserve all Python indentation using four spaces per indentation level.",[m
[32m+[m[32m        "11. Do not include explanations, commentary, or Markdown headings between output markers.",[m
[32m+[m[32m        "12. Never generate, modify, or include Python __init__.py files.",[m
[32m+[m[32m        "13. If a requirement is ambiguous or necessary information is missing, explain the issue instead of inventing implementation details.",[m
     ].join("\n"));[m
 [m
     return sections.join("\n\n");[m
