# PromptFlow

**From AI prompts to organized, working code — automatically.**

PromptFlow is a Firefox extension for automating multi-step AI-assisted coding workflows in ChatGPT. It combines a React-based extension interface, a ChatGPT page content script, and a Python native messaging host so developers can provide project context, run a sequence of coding tasks, review generated output, and write files into a registered local project.

The GitHub repository is named **developer-workflow-automation**; the product itself is **PromptFlow**.

> **Project status: Early development / experimental.** PromptFlow is being tested against real Django projects. ChatGPT's web interface can change, and the content-script selectors may need maintenance. Test on a disposable copy or Git branch before using it on important work.

## Table of contents

- [What PromptFlow does](#what-promptflow-does)
- [How it works](#how-it-works)
- [Django model workflow](#django-model-workflow)
- [Destination conventions](#destination-conventions)
- [File safety and recovery](#file-safety-and-recovery)
- [Project structure](#project-structure)
- [Requirements](#requirements)
- [Installation and setup](#installation-and-setup)
- [Using PromptFlow](#using-promptflow)
- [Batch workflows](#batch-workflows)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Current limitations](#current-limitations)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## What PromptFlow does

PromptFlow is intended to bridge the gap between asking an AI assistant to generate code and applying that code in an existing project in a controlled, repeatable way.

Its core capabilities include:

- **Project-aware prompts:** provide ChatGPT with a registered project's file tree and the source files required by a workflow task.
- **Sequential workflows:** execute dependent coding tasks in order, using outputs from earlier tasks as context for later tasks.
- **ChatGPT interaction:** insert prompts into the active ChatGPT composer, submit them, and wait for the assistant response when the workflow requires it.
- **Output extraction and validation:** extract expected files from assistant responses and validate their content and destination paths before writing.
- **Deterministic destinations:** apply known Django file-placement conventions instead of guessing destinations from nearby files.
- **Destination confirmation:** allow destinations to be reviewed and confirmed before writing.
- **Local project integration:** use a Python native messaging host to read project files and write generated files locally.
- **Persistence and recovery:** save workflow and batch state so execution can recover from some interruptions without unnecessarily asking ChatGPT to regenerate already saved output.
- **Batch processing:** run a sequence of model workflows for multiple model files, with manual or automatic batch behavior.

PromptFlow uses the ChatGPT session open in Firefox. It is not an OpenAI API client and does not require a separate API key for its ChatGPT page interaction.

## How it works

PromptFlow has three main parts:

1. **Firefox extension UI (`src/`)** — the React interface where a developer selects a registered project, configures a workflow, confirms destinations, and monitors execution.
2. **ChatGPT content script (`public/content.js`)** — runs on the ChatGPT page. It locates the active message composer, inserts prompts, submits them, and observes assistant responses.
3. **Python native messaging host (`native/`)** — communicates with the extension through Firefox Native Messaging and performs approved local-project file operations.

A typical execution follows this sequence:

1. The developer selects a registered local project and a workflow.
2. PromptFlow builds a task prompt using the workflow instructions and selected project context.
3. The extension sends the prompt to the ChatGPT content script.
4. The content script inserts and submits the prompt in the active ChatGPT conversation.
5. PromptFlow waits for the assistant response when required, extracts the expected output, and validates it.
6. PromptFlow resolves the output destination using the workflow's conventions and asks for confirmation when needed.
7. The native host writes the approved file, and PromptFlow verifies the result.
8. Once the task's required outputs are written, dependent tasks become eligible to run.

The workflow engine and the ChatGPT page integration are separate concerns: workflow dependencies, state, validation, destination handling, and file writing are managed by PromptFlow rather than being left to a single long prompt.

## Django model workflow

The initial built-in workflow focuses on implementing Django models and their supporting layers. It is designed around the following sequence:

| Step | Task | Expected output |
|---|---|---|
| 1 | Create model | Django model source file |
| 2 | Create factory and model test | Factory file and model test file |
| 3 | Create selector | Selector source file |
| 4 | Create selector test | Selector test file |
| 5 | Create service | Service source file |
| 6 | Create service test | Service test file |

The workflow uses task dependencies so later tasks can consume outputs from earlier tasks. For example, selector generation can use the model implementation, while selector tests can use both the model and selector source.

### Source preparation

The workflow supports source preparation modes for configurable source material:

- `full` — provide the complete source.
- `remove_comments` — remove comments from the prepared copy.
- `remove_tests` — remove tests from the prepared copy.
- `remove_comments_and_tests` — remove both comments and tests from the prepared copy.

Source preparation is intended to create prompt context without modifying the original project files.

## Destination conventions

For a model at:

```text
core/finance/payments/models/analytics_and_audit/payment_access_log.py
```

PromptFlow applies these destinations:

| Output | Destination |
|---|---|
| Model | The explicitly selected model path |
| Factory | `core/finance/payments/tests/factories/payment_access_log_factory.py` |
| Model test | `core/finance/payments/tests/models/test_payment_access_log.py` |
| Selector | `core/finance/payments/selectors/analytics_and_audit/payment_access_log_selector.py` |
| Selector test | `core/finance/payments/tests/selectors/analytics_and_audit/test_payment_access_log_selector.py` |
| Service | `core/finance/payments/services/analytics_and_audit/payment_access_log_service.py` |
| Service test | `core/finance/payments/tests/services/analytics_and_audit/test_payment_access_log_service.py` |

The model's group directory (for example, `analytics_and_audit`) is preserved for selectors, selector tests, services, and service tests. Factories and model tests use shared test directories rather than per-model subdirectories.

PromptFlow excludes `__init__.py` from generated workflow outputs and does not use it as a destination. Existing `__init__.py` files should remain untouched.

If a required destination directory does not exist, the native host can create the parent directories when writing the approved output.

## File safety and recovery

PromptFlow is designed to avoid silently replacing existing project code.

- Destination paths are validated before use.
- Path traversal and unsafe destination paths are rejected by the native host.
- The native host applies filesystem boundary checks and avoids following symlinks during protected file operations.
- Parent directories can be created when required.
- Existing non-empty files with different content are treated as conflicts rather than silently overwritten.
- If an existing file already contains exactly the generated content, PromptFlow can recognize it during recovery instead of writing it again.
- Empty or whitespace-only placeholder files may be replaced by generated content.
- File writes use the native host's backup and safe-write behavior.
- A write is verified after it completes before the workflow moves forward.

These safeguards reduce risk, but they are not a substitute for version control. Use a dedicated Git branch or a disposable project copy when testing.

## Project structure

The main areas of the repository are:

```text
promptflow/
├── native/                          # Python native messaging host
├── public/
│   └── content.js                   # ChatGPT page integration
├── scripts/                         # Development and host-related scripts
├── src/
│   └── features/
│       └── workflows/
│           ├── components/          # Workflow UI
│           ├── definitions/         # Workflow definitions and task instructions
│           ├── services/            # Workflow execution and batch orchestration
│           ├── storage/             # Persisted workflow and batch state
│           └── ...                  # Supporting workflow utilities and tests
├── manifest.json                    # Firefox extension manifest
├── package.json
├── package-lock.json
├── vite.config.js
└── README.md
```

The exact set of files may evolve as the project develops.

## Requirements

- Mozilla Firefox with support for WebExtensions and Native Messaging.
- Node.js and npm.
- Python 3 for the native messaging host.
- A ChatGPT account and an active ChatGPT session in Firefox.
- A local project directory registered with the PromptFlow native host.

The development environment used for the current implementation includes Node.js 24 and Python 3.12. Other compatible versions may work, but have not necessarily been tested.

## Installation and setup

### 1. Clone the repository

Using SSH:

```bash
git clone git@github.com:ayosamobitade/developer-workflow-automation.git
cd developer-workflow-automation
```

Or using HTTPS:

```bash
git clone https://github.com/ayosamobitade/developer-workflow-automation.git
cd developer-workflow-automation
```

### 2. Install JavaScript dependencies

```bash
npm ci
```

### 3. Build the extension

```bash
npm run build
```

### 4. Register the native messaging host

The Python host must be installed and registered with Firefox Native Messaging before local project operations can work.

At a minimum, the native messaging registration must:

- use the native host name expected by the extension;
- point to an executable launcher or host entry point using an absolute filesystem path;
- allow the extension ID declared by the Firefox extension manifest; and
- be installed in a native messaging host manifest location recognized by the Firefox installation being used.

The exact registration path and launcher requirements depend on the operating system and Firefox packaging. In particular, Firefox distributions installed through Snap may have different filesystem access considerations from a standard package installation. Use the native-host setup files in `native/` and `scripts/` as the source of truth for the current implementation. Do not copy a generic native-messaging manifest without checking the host name and extension ID used by this repository.

After registration, restart Firefox if required by the installation and verify that PromptFlow can connect to the host and list the registered projects.

### 5. Load the extension in Firefox

For development, use Firefox's temporary add-on loader:

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on…**.
3. Choose the extension's `manifest.json` file from the project directory.
4. Open the PromptFlow sidebar or extension interface.

Temporary add-ons are removed when Firefox is fully restarted. Load the add-on again after a restart unless you have packaged and installed it through a persistent distribution method.

### 6. Open ChatGPT

Open ChatGPT in the same Firefox profile, sign in, and keep the ChatGPT tab available while running a workflow. PromptFlow interacts with the page through its content script; it does not independently authenticate to ChatGPT.

## Using PromptFlow

A recommended first-use procedure is:

1. **Start with a safe project copy.** Create a Git branch or duplicate the project before testing.
2. **Connect to the native host.** Confirm that PromptFlow reports a successful connection.
3. **Select a registered project.** Check that the project name and file tree are correct.
4. **Open the Django model workflow.** Choose single-model execution for the first test.
5. **Select a model file.** Confirm the intended model path and project context.
6. **Review source preparation settings.** Use the full source mode unless you have a reason to reduce prompt context.
7. **Start the workflow.** Keep ChatGPT open and allow each task to complete.
8. **Review destination confirmations.** Confirm that every output path is where you expect it to be.
9. **Inspect generated files.** Review the model, factory, selectors, services, and tests before merging the changes into your main branch.
10. **Run the project's own checks.** For a Django project, run the relevant tests, linting, formatting, and migrations checks separately.

For the first real project test, use one model whose supporting factory, selector, service, and test files do not already exist. This makes it easier to verify each generated output and avoids unnecessary conflicts.

## Batch workflows

PromptFlow also includes batch orchestration for processing multiple Django model files.

Batch execution is intended to:

- maintain a queue of selected model paths;
- create and execute a workflow for each model in sequence;
- preserve per-model workflow snapshots in batch state;
- report model-level progress and failures; and
- support manual or automatic batch behavior.

Pause and stop operations are designed to take effect at model boundaries rather than interrupting a model workflow halfway through. An interruption caused by a changed execution context or other exceptional failure may still fail the current model workflow.

**Recommended practice:** validate a complete single-model workflow before using batch mode. Then test a small batch on a disposable project copy before processing a large set of models.

## Development

### Install dependencies

```bash
npm ci
```

### Run the development server

```bash
npm run dev
```

### Run tests

```bash
npm test
```

### Run ESLint

```bash
npm run lint
```

### Build for production

```bash
npm run build
```

### Preview the production build

```bash
npm run preview
```

The build output is generated in `dist/`. Generated build files and installed dependencies should not be committed unless a specific release process requires them.

## Troubleshooting

### PromptFlow cannot connect to the native host

- Confirm that the native messaging host is installed and registered with the Firefox profile in use.
- Check that the native host name in the registration matches the name requested by the extension.
- Confirm that the registration points to the correct absolute launcher path.
- Check executable permissions and Python availability.
- Confirm that the extension ID is included in the host manifest's allowed extension list.
- Restart Firefox after changing native messaging registration.

### The project list is empty

- Confirm that the native host is connected.
- Check that the project has been registered with the native host.
- Verify that the selected project path exists and is accessible to the host process.

### ChatGPT composer or Send button cannot be found

- Open ChatGPT in Firefox and wait until the page finishes loading.
- Make sure the PromptFlow content script is active on the ChatGPT tab.
- Reload the temporary extension from `about:debugging` after rebuilding.
- Refresh the ChatGPT tab after reloading the extension.
- Check whether ChatGPT has changed its composer or button markup. PromptFlow's page selectors may need to be updated when the ChatGPT interface changes.

### Prompt insertion works but the response is not detected

- Confirm that ChatGPT actually received and submitted the prompt.
- Check that ChatGPT is not waiting for user interaction or displaying an error.
- Inspect the browser console for content-script errors.
- ChatGPT's response markup and generation controls can change; response-detection selectors may need maintenance.

### A destination conflict is reported

PromptFlow intentionally avoids replacing an existing non-empty file whose content differs from the generated output. Inspect the existing file and decide manually whether to keep it, change the destination, or perform a controlled replacement. Do not bypass this protection simply to make a workflow continue.

## Current limitations

- The current primary workflow is focused on Django model implementation; this is not yet a general-purpose workflow builder for every language and framework.
- Prompt submission and response detection depend on ChatGPT's web interface and may need updates when its DOM changes.
- The extension requires an active ChatGPT session in Firefox.
- Native host installation and registration are platform- and Firefox-distribution-dependent.
- AI-generated code must be reviewed and tested by a developer. Successful extraction and file writing do not guarantee correctness, security, performance, or compatibility.
- The project is experimental. Do not treat it as a production-safe autonomous code deployment system.

## Security notes

- Only register project directories that you trust PromptFlow to access.
- Keep API keys, credentials, `.env` files, private keys, database dumps, and personal data out of prompts and source context unless you have deliberately assessed the risks.
- Prompts and project context sent through the content script are submitted to the ChatGPT service using your active browser session. Review what source material is included before starting a workflow.
- Keep native-host permissions and project access as narrow as practical.
- Use Git commits and backups before running automated file operations.
- Review generated code before running it, deploying it, or merging it into a shared branch.

## Contributing

PromptFlow is under active development. Contributions, bug reports, and suggestions are welcome.

When reporting an issue, include:

- operating system and Firefox distribution/version;
- Node.js and Python versions;
- the workflow task being run;
- the relevant PromptFlow error message;
- browser console or native-host logs with secrets removed; and
- steps to reproduce the issue.

Please do not include passwords, access tokens, private keys, session cookies, or unredacted project secrets in issue reports.

For code changes, run the relevant checks before submitting a pull request:

```bash
npm test
npm run lint
npm run build
```

## License

No license has been specified in this repository yet. Until a license is added, the source code remains subject to the default copyright protections; do not assume that it is available for unrestricted reuse, redistribution, or modification.
