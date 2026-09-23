// fileFilter.js
//
// IMPORTANT: checking a file's extension alone is not real security — anyone
// can rename "script.py" to "script.txt". We treat the extension check as a
// user-facing rule ("code files need verification") and back it up with a
// content-sniffing check so a renamed file can't sneak past either gate.

const FileType = require("file-type");
const crypto = require("crypto");

// Extensions that are blocked by default and require an elevated (password
// re-verified) token to upload.
const CODE_EXTENSIONS = new Set([
  "py", "js", "ts", "jsx", "tsx", "php", "rb", "sh", "bat", "ps1", "vbs",
  "exe", "dll", "so", "jar", "java", "c", "cpp", "h", "hpp", "cs", "go",
  "rs", "pl", "sql", "html", "htm", "jsp", "asp", "aspx", "apk", "com",
  "msi", "scr", "cmd",
]);

// Extensions we're happy to accept from anyone with a valid session
// (adjust to match what your image-generation feature actually needs).
const ALLOWED_GENERAL_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "pdf", "txt", "md",
  "csv", "json",
]);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

function getExtension(filename) {
  const parts = filename.toLowerCase().split(".");
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

  // Sniff the real content type from the file's magic bytes, not its name.
  const sniffed = await FileType.fromBuffer(file.buffer);
  const sniffedExt = sniffed ? sniffed.ext : null;

  // If the declared extension and the sniffed content disagree, treat the
  // file as suspicious and require elevation, regardless of which one
  // looks "safe" — this is exactly the renamed-file bypass case.
  const mismatch = sniffedExt && sniffedExt !== declaredExt;

  if (CODE_EXTENSIONS.has(declaredExt) || mismatch) {
    return {
      verdict: "needs_elevation",
      reason: mismatch
        ? `File content (${sniffedExt || "unknown"}) doesn't match its extension (${declaredExt}). Verification required.`
        : `.${declaredExt} files require password verification before upload.`,
    };
  }

  if (
    ALLOWED_GENERAL_EXTENSIONS.has(declaredExt) ||
    (sniffedExt && ALLOWED_GENERAL_EXTENSIONS.has(sniffedExt))
  ) {
    return { verdict: "allow", reason: "OK" };
  }

  // Unknown/unrecognized type: default to safe-by-default and require
  // verification rather than silently allowing something unclassified.
  return {
    verdict: "needs_elevation",
    reason: `Unrecognized file type (.${declaredExt || "unknown"}). Verification required.`,
  };
}

module.exports = {
  classifyUpload,
  getExtension,
  sha256,
  CODE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
};
