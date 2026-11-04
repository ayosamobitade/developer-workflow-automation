// src/features/workflows/services/workflowOutputService.js

const MARKER_PREFIX = "<<<PROMPTFLOW_OUTPUT_";
const START_SUFFIX = ">>>";

function getTaskDefinition(taskId, definition) {
  if (!definition || !Array.isArray(definition.tasks)) {
    throw new Error("A valid workflow definition is required.");
  }

  const task = definition.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error(`Unknown workflow task: ${taskId}`);
  }

  return task;
}

function countOccurrences(source, marker) {
  let count = 0;
  let position = 0;

  while (true) {
    const found = source.indexOf(marker, position);

    if (found === -1) {
      break;
    }

    count += 1;
    position = found + marker.length;
  }

  return count;
}

/**
 * Removes a Markdown code fence only when it wraps the entire output.
 *
 * Internal code fences are preserved.
 */
export function stripOuterCodeFence(content) {
  const trimmed = content.trim();

  const match = trimmed.match(
    /^```(?:[a-zA-Z0-9_+.-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/
  );

  return match ? match[1] : trimmed;
}

/**
 * Extracts all expected output files from a ChatGPT response.
 *
 * Expected markers:
 * <<<PROMPTFLOW_OUTPUT_START:output_id>>>
 * ...file content...
 * <<<PROMPTFLOW_OUTPUT_END:output_id>>>
 *
 * @param {Object} options
 * @param {string} options.response
 * @param {string} options.taskId
 * @param {Object} [options.definition]
 *
 * @returns {{
 *   taskId: string,
 *   outputs: Array<{
 *     outputId: string,
 *     content: string
 *   }>
 * }}
 */
export function extractWorkflowOutputs({
  response,
  taskId,
  definition,
} = {}) {
  if (typeof response !== "string" || !response.trim()) {
    throw new Error("ChatGPT response is empty.");
  }

  if (!taskId) {
    throw new Error("A workflow task ID is required.");
  }

  const task = getTaskDefinition(taskId, definition);

  if (!Array.isArray(task.outputs) || task.outputs.length === 0) {
    throw new Error(`Task "${taskId}" has no expected outputs.`);
  }

  const expectedIds = new Set();
  const extractedOutputs = [];
  const markerPositions = [];

  for (const output of task.outputs) {
    if (!output?.id) {
      throw new Error(
        `Task "${taskId}" contains an output without an ID.`
      );
    }

    if (expectedIds.has(output.id)) {
      throw new Error(
        `Task "${taskId}" contains duplicate output ID "${output.id}".`
      );
    }

    expectedIds.add(output.id);

    const startMarker =
      `${MARKER_PREFIX}START:${output.id}${START_SUFFIX}`;

    const endMarker =
      `${MARKER_PREFIX}END:${output.id}${START_SUFFIX}`;

    const startCount = countOccurrences(response, startMarker);
    const endCount = countOccurrences(response, endMarker);

    if (startCount !== 1 || endCount !== 1) {
      throw new Error(
        `Output "${output.id}" must have exactly one start marker and one end marker. ` +
          `Found ${startCount} start marker(s) and ${endCount} end marker(s).`
      );
    }

    const startPosition = response.indexOf(startMarker);
    const endPosition = response.indexOf(endMarker);

    if (endPosition <= startPosition + startMarker.length) {
      throw new Error(
        `Output "${output.id}" has an invalid marker order or empty content.`
      );
    }

    const contentStart = startPosition + startMarker.length;
    const rawContent = response.slice(contentStart, endPosition);
    const content = stripOuterCodeFence(rawContent);

    if (!content.trim()) {
      throw new Error(`Output "${output.id}" contains no file content.`);
    }

    markerPositions.push({
      outputId: output.id,
      start: startPosition,
      end: endPosition + endMarker.length,
    });

    extractedOutputs.push({
      outputId: output.id,
      content,
    });
  }

  // Reject markers belonging to outputs that this task did not request.
  const unexpectedMarkerPattern =
    /<<<PROMPTFLOW_OUTPUT_(?:START|END):([^>]+)>>>/g;

  let markerMatch;

  while ((markerMatch = unexpectedMarkerPattern.exec(response)) !== null) {
    const markerOutputId = markerMatch[1];

    if (!expectedIds.has(markerOutputId)) {
      throw new Error(
        `Unexpected output marker found for "${markerOutputId}".`
      );
    }
  }

  // Ensure output blocks do not overlap or appear in an invalid order.
  markerPositions.sort((a, b) => a.start - b.start);

  for (let index = 1; index < markerPositions.length; index += 1) {
    const previous = markerPositions[index - 1];
    const current = markerPositions[index];

    if (current.start < previous.end) {
      throw new Error(
        `Output blocks "${previous.outputId}" and "${current.outputId}" overlap.`
      );
    }
  }

  return {
    taskId,
    outputs: extractedOutputs,
  };
}

/**
 * Extracts one specific output from a ChatGPT response.
 *
 * @param {Object} options
 * @param {string} options.response
 * @param {string} options.taskId
 * @param {string} options.outputId
 * @param {Object} [options.definition]
 *
 * @returns {{outputId: string, content: string}}
 */
export function extractWorkflowOutput({
  response,
  taskId,
  outputId,
  definition,
} = {}) {
  if (!outputId) {
    throw new Error("An output ID is required.");
  }

  const result = extractWorkflowOutputs({
    response,
    taskId,
    definition,
  });

  const output = result.outputs.find(
    (item) => item.outputId === outputId
  );

  if (!output) {
    throw new Error(
      `Output "${outputId}" was not found in task "${taskId}".`
    );
  }

  return output;
}

/**
 * Checks whether a response contains all expected output markers.
 *
 * This is a preliminary check only. Use extractWorkflowOutputs()
 * before accepting or writing generated files.
 */
export function hasCompleteWorkflowOutput({
  response,
  taskId,
  definition,
} = {}) {
  try {
    extractWorkflowOutputs({
      response,
      taskId,
      definition,
    });

    return true;
  } catch {
    return false;
  }
}