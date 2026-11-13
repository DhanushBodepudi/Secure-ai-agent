// fileFilter.js
//
// Checking a file's extension alone is not real security: anyone can rename
// "script.py" to "script.txt". So the extension rule ("code files need your
// password") is backed up by a content check on the file's real type, and a
// file whose name and content disagree is treated as suspicious.

const FileType = require("file-type"); // v16: pinned in package.json
const crypto = require("crypto");

// Blocked by default; need an "elevated" (password re-checked) token to upload.
const CODE_EXTENSIONS = new Set([
  "py", "js", "ts", "jsx", "tsx", "php", "rb", "sh", "bat", "ps1", "vbs",
  "exe", "dll", "so", "jar", "java", "c", "cpp", "h", "hpp", "cs", "go",
  "rs", "pl", "sql", "html", "htm", "jsp", "asp", "aspx", "apk", "com",
  "msi", "scr", "cmd",
]);

// Accepted without extra verification.
const ALLOWED_GENERAL_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "pdf", "txt", "md",
  "csv", "json", "log", "docx",
]);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

// The same format can be named two ways; they must not count as a mismatch.
const normalize = (ext) => ({ jpeg: "jpg", htm: "html" }[ext] || ext);

function getExtension(filename) {
  const parts = String(filename).toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Returns { verdict: "allow" | "needs_elevation" | "reject", reason }
async function classifyUpload(file) {
  const declaredExt = getExtension(file.originalname);

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { verdict: "reject", reason: "File exceeds the 20MB size limit." };
  }

  const sniffed = await FileType.fromBuffer(file.buffer);
  const sniffedExt = sniffed ? sniffed.ext : null;

  const mismatch = Boolean(sniffedExt) && normalize(sniffedExt) !== normalize(declaredExt);

  if (CODE_EXTENSIONS.has(declaredExt) || mismatch) {
    return {
      verdict: "needs_elevation",
      reason: mismatch
        ? `File content (${sniffedExt}) doesn't match its extension (.${declaredExt || "none"}). Verification required.`
        : `.${declaredExt} files require password verification before they can be used.`,
    };
  }

  if (ALLOWED_GENERAL_EXTENSIONS.has(declaredExt)) {
    return { verdict: "allow", reason: "OK" };
  }

  // Unknown types are never silently accepted.
  return {
    verdict: "needs_elevation",
    reason: `Unrecognized file type (.${declaredExt || "unknown"}). Verification required.`,
  };
}

module.exports = { classifyUpload, getExtension, sha256, CODE_EXTENSIONS, MAX_FILE_SIZE_BYTES };
