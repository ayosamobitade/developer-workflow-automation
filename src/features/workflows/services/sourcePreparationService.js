// src/features/workflows/services/sourcePreparationService.js

export const SOURCE_PREPARATION_MODES = Object.freeze({
  FULL: "full",
  REMOVE_COMMENTS: "remove_comments",
  REMOVE_TESTS: "remove_tests",
  REMOVE_COMMENTS_AND_TESTS: "remove_comments_and_tests",
});

const VALID_MODES = new Set(Object.values(SOURCE_PREPARATION_MODES));

function validateInput(content, mode) {
  if (typeof content !== "string") {
    throw new TypeError("Source content must be a string.");
  }

  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unsupported source preparation mode: ${mode}`);
  }
}

/**
 * Removes Python comments without removing # characters inside strings.
 *
 * Handles:
 * - Single-quoted strings.
 * - Double-quoted strings.
 * - Triple-quoted strings.
 * - Escaped quote characters.
 * - Multiline strings.
 */
export function removePythonComments(source) {
  let result = "";
  let index = 0;

  let quote = null;
  let tripleQuoted = false;
  let escaped = false;

  while (index < source.length) {
    const char = source[index];
    const nextThree = source.slice(index, index + 3);

    if (quote !== null) {
      if (escaped) {
        result += char;
        escaped = false;
        index += 1;
        continue;
      }

      if (char === "\\") {
        result += char;
        escaped = true;
        index += 1;
        continue;
      }

      if (tripleQuoted) {
        if (nextThree === quote.repeat(3)) {
          result += nextThree;
          index += 3;
          quote = null;
          tripleQuoted = false;
          continue;
        }

        result += char;
        index += 1;
        continue;
      }

      if (char === quote) {
        result += char;
        quote = null;
        index += 1;
        continue;
      }

      // A normal Python string cannot continue across an unescaped newline.
      if (char === "\n") {
        quote = null;
      }

      result += char;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;

      if (nextThree === char.repeat(3)) {
        tripleQuoted = true;
        result += nextThree;
        index += 3;
      } else {
        tripleQuoted = false;
        result += char;
        index += 1;
      }

      continue;
    }

    if (char === "#") {
      // Skip comment characters but preserve the line ending.
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }

      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

/**
 * Identifies top-level Python test functions and test classes.
 *
 * Targets:
 * - def test_something(...):
 * - async def test_something(...):
 * - class TestSomething:
 *
 * Decorators immediately preceding a target declaration are removed too.
 *
 * This deliberately avoids removing arbitrary functions or methods whose
 * names merely contain the word "test".
 */
export function removePythonTests(source) {
  const lines = source.split(/(?<=\n)/);
  const removedTests = [];
  const ranges = [];

  const declarationPattern =
    /^(?:async\s+)?def\s+test_[A-Za-z0-9_]*\s*\(|^class\s+Test[A-Za-z0-9_]*\s*[:(]/;

  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const normalizedLine = line.replace(/\r?\n$/, "");

    // Only target top-level declarations.
    if (!declarationPattern.test(normalizedLine)) {
      index += 1;
      continue;
    }

    let start = index;

    // Include decorators directly attached to the declaration.
    while (start > 0) {
      const previousLine = lines[start - 1].replace(/\r?\n$/, "");

      if (/^@\S/.test(previousLine)) {
        start -= 1;
        continue;
      }

      break;
    }

    // Find the next top-level, non-empty Python statement.
    let end = index + 1;

    while (end < lines.length) {
      const candidate = lines[end].replace(/\r?\n$/, "");

      if (
        candidate.trim() !== "" &&
        !candidate.trimStart().startsWith("#") &&
        !/^\s/.test(candidate)
      ) {
        break;
      }

      end += 1;
    }

    const declaration = normalizedLine.trim();

    ranges.push({ start, end });

    removedTests.push({
      declaration,
      startLine: start + 1,
      endLine: end,
    });

    index = end;
  }

  if (ranges.length === 0) {
    return {
      content: source,
      removedTests,
    };
  }

  const output = [];
  let currentLine = 0;

  for (const range of ranges) {
    output.push(...lines.slice(currentLine, range.start));
    currentLine = range.end;
  }

  output.push(...lines.slice(currentLine));

  return {
    content: output.join(""),
    removedTests,
  };
}

/**
 * Prepares one source file for workflow prompt generation.
 *
 * The supplied content is never mutated.
 *
 * @param {Object} options
 * @param {string} options.content
 * @param {string} [options.path]
 * @param {string} [options.mode]
 *
 * @returns {{
 *   path: string,
 *   mode: string,
 *   originalContent: string,
 *   content: string,
 *   changed: boolean,
 *   removedTests: Array
 * }}
 */
export function prepareSourceContent({
  content,
  path = "",
  mode = SOURCE_PREPARATION_MODES.FULL,
} = {}) {
  validateInput(content, mode);

  let preparedContent = content;
  let removedTests = [];

  const shouldRemoveTests =
    mode === SOURCE_PREPARATION_MODES.REMOVE_TESTS ||
    mode === SOURCE_PREPARATION_MODES.REMOVE_COMMENTS_AND_TESTS;

  const shouldRemoveComments =
    mode === SOURCE_PREPARATION_MODES.REMOVE_COMMENTS ||
    mode === SOURCE_PREPARATION_MODES.REMOVE_COMMENTS_AND_TESTS;

  if (shouldRemoveTests) {
    const result = removePythonTests(preparedContent);

    preparedContent = result.content;
    removedTests = result.removedTests;
  }

  if (shouldRemoveComments) {
    preparedContent = removePythonComments(preparedContent);
  }

  return {
    path,
    mode,
    originalContent: content,
    content: preparedContent,
    changed: preparedContent !== content,
    removedTests,
  };
}

/**
 * Prepares multiple source files.
 *
 * Each source can specify its own preparation mode.
 * The default mode is full.
 *
 * @param {Array<{
 *   path: string,
 *   content: string,
 *   mode?: string
 * }>} sources
 *
 * @returns {Array<Object>}
 */
export function prepareSourceFiles(sources = []) {
  if (!Array.isArray(sources)) {
    throw new TypeError("Sources must be an array.");
  }

  return sources.map((source) => {
    if (!source || typeof source !== "object") {
      throw new TypeError("Each source must be an object.");
    }

    return prepareSourceContent({
      path: source.path || "",
      content: source.content,
      mode: source.mode || SOURCE_PREPARATION_MODES.FULL,
    });
  });
}