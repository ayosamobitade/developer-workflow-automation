const MAX_FILE_SIZE = 1024 * 1024;
const MAX_FILE_COUNT = 5000;

const EXCLUDED_DIRECTORIES = new Set([
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    ".vscode",
    "vendor",
]);

const EXCLUDED_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".rar",
    ".7z",
    ".mp3",
    ".mp4",
    ".wav",
    ".avi",
    ".mov",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".exe",
    ".dll",
    ".so",
    ".bin",
    ".pyc",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".cer",
    ".crt",
]);

const EXCLUDED_FILENAMES = new Set([
    ".ds_store",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
]);

function shouldExcludeFile(path) {
    const segments = path.split("/");
    const filename = segments.at(-1) || "";
    const lowerFilename = filename.toLowerCase();

    const extension = filename.includes(".")
        ? `.${filename.split(".").pop().toLowerCase()}`
        : "";

    // Exclude dependency, build, version-control, and cache directories.
    if (
        segments.some((segment) =>
            EXCLUDED_DIRECTORIES.has(segment.toLowerCase())
        )
    ) {
        return true;
    }

    // Exclude binary files and private-key/certificate formats.
    if (EXCLUDED_EXTENSIONS.has(extension)) {
        return true;
    }

    // Exclude known sensitive filenames.
    if (EXCLUDED_FILENAMES.has(lowerFilename)) {
        return true;
    }

    // Exclude environment files, including .env.local and .env.production.
    if (
        lowerFilename === ".env" ||
        lowerFilename.startsWith(".env.")
    ) {
        return true;
    }

    // Exclude files whose names suggest they contain secrets or credentials.
    if (
        lowerFilename.includes("secret") ||
        lowerFilename.includes("credential")
    ) {
        return true;
    }

    return false;
}

export async function readProjectDirectory(fileList) {
    const selectedFiles = Array.from(fileList || []);

    if (!selectedFiles.length) {
        throw new Error("No project files were selected.");
    }

    const rootPath = selectedFiles[0].webkitRelativePath || "";
    const projectName = rootPath.split("/")[0] || "Local Project";

    const eligibleFiles = selectedFiles
        .map((file) => ({
            file,
            path: (file.webkitRelativePath || "")
                .split("/")
                .slice(1)
                .join("/"),
        }))
        .filter(({ file, path }) => {
            return (
                path &&
                !shouldExcludeFile(path) &&
                file.size <= MAX_FILE_SIZE
            );
        })
        .slice(0, MAX_FILE_COUNT);

    if (!eligibleFiles.length) {
        throw new Error(
            "No eligible source files were found in this directory."
        );
    }

    const files = [];

    for (const { file, path } of eligibleFiles) {
        try {
            const content = await file.text();

            // Ignore binary content detected by null bytes.
            if (content.includes("\0")) {
                continue;
            }

            files.push({
                name: path.split("/").pop(),
                path,
                size: file.size,
                content,
            });
        } catch (error) {
            console.warn(`Could not read ${path}:`, error);
        }
    }

    if (!files.length) {
        throw new Error("No readable text files were found.");
    }

    return {
        name: projectName,
        files,
    };
}