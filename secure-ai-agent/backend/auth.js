// auth.js
// Handles: password verification, JWT session tokens, and JWT "elevated" tokens
// (short-lived permission slips that unlock code-file uploads).

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const JWT_SECRET = process.env.JWT_SECRET;
const ACCOUNT_PASSWORD_HASH = process.env.ACCOUNT_PASSWORD_HASH;

if (!JWT_SECRET || JWT_SECRET.includes("replace_this")) {
  console.warn(
    "\n⚠️  WARNING: JWT_SECRET is missing or still set to the placeholder value.\n" +
    "   Generate a real one and put it in backend/.env before using this in anger.\n"
  );
}

// --- Password verification -------------------------------------------------

function verifyPassword(plainPassword) {
  if (!ACCOUNT_PASSWORD_HASH) return false;
  return bcrypt.compareSync(plainPassword, ACCOUNT_PASSWORD_HASH);
}

// --- Session tokens (standard access: view chats, generate images, upload
// normal files) ---

function issueSessionToken() {
  return jwt.sign({ level: "standard" }, JWT_SECRET, { expiresIn: "45m" });
}

// --- Elevated tokens (short-lived, required specifically to upload
// programming-language file types) ---

function issueElevatedToken() {
  return jwt.sign({ level: "elevated" }, JWT_SECRET, { expiresIn: "15m" });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// --- Express middleware ------------------------------------------------

// Requires a valid session token (standard or elevated both pass this).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }

  req.auth = payload;
  next();
}

// Requires a valid ELEVATED token specifically. Used only on the route that
// permits code-file uploads. A merely "standard" session is not enough here,
// by design — face recognition alone should never satisfy this check because
// the elevated token is only ever issued after a fresh password check.
function requireElevated(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;

  if (!payload || payload.level !== "elevated") {
    return res.status(403).json({
      error: "This upload type requires password verification first.",
      code: "ELEVATION_REQUIRED",
    });
  }

  req.auth = payload;
  next();
}

module.exports = {
  verifyPassword,
  issueSessionToken,
  issueElevatedToken,
  verifyToken,
  requireAuth,
  requireElevated,
};
