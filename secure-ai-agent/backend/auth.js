// auth.js
// Accounts, passwords, login tokens and the middleware that protects routes.
//
// Token types (all signed with JWT_SECRET):
//   standard : proves who you are for normal use (45 min, renewed while you work)
//   elevated : issued only after re-entering your password; unlocks code-file uploads (15 min)
//   capture  : lets the login screen upload ONE photo after a failed face attempt (2 min)
// Standard and elevated tokens carry a token_version, so changing your password
// signs out every other device straight away.

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("./db");
const cfg = require("./config");
const face = require("./faceMatch");

const BCRYPT_ROUNDS = 12;
// Compared against when an email doesn't exist, so a wrong email and a wrong
// password take about the same time and look identical to an attacker.
const DUMMY_HASH = bcrypt.hashSync("aperture-timing-padding", BCRYPT_ROUNDS);

// ---------------------------------------------------------------------------
// Input rules
// ---------------------------------------------------------------------------

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyuiop", "qwerty123", "iloveyou", "11111111", "00000000", "abcd1234", "admin123",
]);

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

// Returns a message describing the problem, or null if the password is fine.
function passwordProblem(password, email) {
  if (typeof password !== "string") return "Please enter a password.";
  if (password.length < 8) return "Your password must be at least 8 characters long.";
  if (password.length > 128) return "Your password is too long (128 characters at most).";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "That password is too common. Please choose another.";
  if (email && password.toLowerCase() === email) return "Your password can't be the same as your email.";
  return null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

async function checkPassword(user, password) {
  const ok = await bcrypt.compare(typeof password === "string" ? password : "", user ? user.password_hash : DUMMY_HASH);
  return Boolean(user) && ok;
}

const findUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
const findUserById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

function insertUser(name, email, passwordHash) {
  const info = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, passwordHash);
  return findUserById(info.lastInsertRowid);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    faceEnabled: face.hasFace(user.id),
    createdAt: user.created_at,
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function issueSessionToken(user) {
  return jwt.sign({ uid: user.id, tv: user.token_version, level: "standard" }, cfg.JWT_SECRET, {
    expiresIn: `${cfg.SESSION_MINUTES}m`,
  });
}

function issueElevatedToken(user) {
  return jwt.sign({ uid: user.id, tv: user.token_version, level: "elevated" }, cfg.JWT_SECRET, { expiresIn: "15m" });
}

// uid may be null: the login screen gets the same kind of token whether or not
// the email exists, so the response never reveals which emails are registered.
function issueCaptureToken(uid) {
  return jwt.sign({ purpose: "capture", uid: uid || null, jti: crypto.randomBytes(12).toString("hex") }, cfg.JWT_SECRET, {
    expiresIn: "2m",
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, cfg.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function verifyCaptureToken(token) {
  const payload = typeof token === "string" ? verifyToken(token) : null;
  return payload && payload.purpose === "capture" ? payload : null;
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

// Loads the user behind a token and checks it hasn't been invalidated.
function userFromPayload(payload) {
  if (!payload || !payload.uid || (payload.level !== "standard" && payload.level !== "elevated")) return null;
  const user = findUserById(payload.uid);
  return user && user.token_version === payload.tv ? user : null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  const token = bearer(req);
  const payload = token ? verifyToken(token) : null;
  const user = userFromPayload(payload);
  if (!user) {
    return res.status(401).json({ error: "Please sign in again.", code: "SESSION_EXPIRED" });
  }
  req.user = user;
  req.authLevel = payload.level;
  next();
}

// Same as requireAuth, but the token must have come from re-entering the password.
function requireElevated(req, res, next) {
  const token = bearer(req);
  const payload = token ? verifyToken(token) : null;
  const user = userFromPayload(payload);
  if (!user || payload.level !== "elevated") {
    return res.status(403).json({
      error: "This action needs password verification first.",
      code: "ELEVATION_REQUIRED",
    });
  }
  req.user = user;
  req.authLevel = "elevated";
  next();
}

// ---------------------------------------------------------------------------
// Failed-attempt lockout (per email / per account, on top of per-IP limits)
// ---------------------------------------------------------------------------

const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function lockRemainingMs(key) {
  const f = failures.get(key);
  if (!f || !f.until) return 0;
  if (f.until > Date.now()) return f.until - Date.now();
  failures.delete(key);
  return 0;
}

function recordFailure(key, max = 5) {
  const now = Date.now();
  let f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) f = { count: 0, first: now, until: 0 };
  f.count += 1;
  if (f.count >= max) f.until = now + LOCK_MS;
  failures.set(key, f);
}

const clearFailures = (key) => failures.delete(key);

// ---------------------------------------------------------------------------
// Password resets
// ---------------------------------------------------------------------------

function createPasswordReset(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const user = findUserByEmail(normalized);
  if (!user) return null;

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare("UPDATE password_resets SET used = 1 WHERE email = ?").run(normalized);
  db.prepare("INSERT INTO password_resets (email, code, expires_at) VALUES (?, ?, ?)").run(normalized, code, expiresAt);

  return { code, user };
}

function verifyResetCode(email, code) {
  const normalized = normalizeEmail(email);
  if (!normalized || !code) return null;
  const now = new Date().toISOString();
  return db.prepare(
    "SELECT * FROM password_resets WHERE email = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1"
  ).get(normalized, String(code).trim(), now);
}

async function applyPasswordReset(email, code, newPassword) {
  const resetRow = verifyResetCode(email, code);
  if (!resetRow) return { ok: false, error: "Invalid or expired verification code." };

  const normalized = normalizeEmail(email);
  const prob = passwordProblem(newPassword, normalized);
  if (prob) return { ok: false, error: prob };

  const user = findUserByEmail(normalized);
  if (!user) return { ok: false, error: "Account not found." };

  const hash = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").run(resetRow.id);
    db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").run(hash, user.id);
  })();

  return { ok: true, user: findUserById(user.id) };
}

function issueResetToken(user) {
  return jwt.sign({ purpose: "password_reset", uid: user.id }, cfg.JWT_SECRET, { expiresIn: "10m" });
}

async function applyPasswordResetWithToken(token, newPassword) {
  let payload;
  try {
    payload = jwt.verify(token, cfg.JWT_SECRET);
  } catch (e) {
    return { ok: false, error: "Reset session expired. Please start again." };
  }
  if (!payload || payload.purpose !== "password_reset" || !payload.uid) {
    return { ok: false, error: "Invalid reset session." };
  }
  const user = findUserById(payload.uid);
  if (!user) return { ok: false, error: "Account not found." };

  const prob = passwordProblem(newPassword, user.email);
  if (prob) return { ok: false, error: prob };

  const hash = await hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").run(hash, user.id);
  return { ok: true, user: findUserById(user.id) };
}

function lockMessage(ms) {
  return `Too many failed attempts. Please try again in ${Math.max(1, Math.ceil(ms / 60000))} minute(s).`;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, f] of failures) {
    if (now - f.first > WINDOW_MS && (!f.until || f.until < now)) failures.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  normalizeEmail,
  cleanName,
  passwordProblem,
  hashPassword,
  checkPassword,
  findUserByEmail,
  findUserById,
  insertUser,
  publicUser,
  issueSessionToken,
  issueElevatedToken,
  issueCaptureToken,
  verifyToken,
  verifyCaptureToken,
  requireAuth,
  requireElevated,
  lockRemainingMs,
  recordFailure,
  clearFailures,
  lockMessage,
  createPasswordReset,
  verifyResetCode,
  applyPasswordReset,
  issueResetToken,
  applyPasswordResetWithToken,
};
