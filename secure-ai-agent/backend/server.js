// server.js
// Aperture backend (multi-user). Every route that touches personal data first
// works out WHO is asking (requireAuth) and only ever reads or writes rows
// that belong to that person.

"use strict";
const cfg = require("./config");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const FileType = require("file-type");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const { exec } = require("child_process");
const mammoth = require("mammoth");

const db = require("./db");
const auth = require("./auth");
const face = require("./faceMatch");
const { classifyUpload, sha256 } = require("./fileFilter");
const { registerCreateRoutes } = require("./generators");

const { requireAuth, requireElevated } = auth;

const CAPTURE_DIR = path.join(cfg.UPLOAD_DIR, "security-captures");
const USER_UPLOAD_DIR = path.join(cfg.UPLOAD_DIR, "user-uploads");
const CREATED_DIR = path.join(cfg.UPLOAD_DIR, "created-files");
const MAX_PROMPT = 4000;

const app = express();
app.disable("x-powered-by");
if (cfg.TRUST_PROXY) app.set("trust proxy", cfg.TRUST_PROXY);

// ---------------------------------------------------------------------------
// Basics: headers, body parsing, rate limits
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  if (cfg.IS_PROD) res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

app.use(
  cors({
    origin: cfg.CORS_ORIGIN ? cfg.CORS_ORIGIN.split(",").map((s) => s.trim()) : true,
    credentials: true,
  })
);
app.use(express.json({ limit: "6mb" }));
const limiter = (windowMs, max, message) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });

// Limits are per network address. Many students share one college IP, so these are
// generous on purpose; the per-account lockout in auth.js is what stops password guessing.
const registerLimiter = limiter(60 * 60 * 1000, 60, "Too many sign-ups from this network. Please try again later.");
const loginLimiter = limiter(60 * 1000, 30, "Too many attempts. Please wait a minute and try again.");
const sensitiveLimiter = limiter(60 * 1000, 20, "Too many attempts. Please wait a minute and try again.");
const captureLimiter = limiter(60 * 1000, 20, "Too many requests.");
const forgotLimiter = limiter(15 * 60 * 1000, 20, "Too many password reset requests. Please wait a bit and try again.");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 21 * 1024 * 1024, files: 1 } });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 4 doesn't catch errors thrown inside async handlers; this does.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function logAuthEvent(userId, method, success) {
  db.prepare("INSERT INTO auth_events (user_id, method, success) VALUES (?, ?, ?)").run(userId || null, method, success ? 1 : 0);
}

function ownChat(chatId, userId) {
  return db.prepare("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(chatId, userId);
}

function safeUnlink(file) {
  try {
    if (file) fs.unlinkSync(file);
  } catch (err) {
    /* already gone */
  }
}

// Maps a stored message path (like /generated/abc.png) to its file on disk.
function resolveMediaPath(p) {
  if (typeof p !== "string") return null;
  let m = /^\/generated\/([0-9a-f-]{36}\.(?:png|jpg|webp|gif))$/.exec(p);
  if (m) return path.join(cfg.UPLOAD_DIR, m[1]);
  m = /^\/files\/([A-Za-z0-9._-]+)$/.exec(p);
  if (m) return path.join(CREATED_DIR, m[1]);
  return null;
}

// Counts one AI request against today's allowance. Sends the 429 itself.
function takeQuota(req, res) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ?").get(req.user.id, day);
  if ((row ? row.count : 0) >= cfg.DAILY_AI_LIMIT) {
    res.status(429).json({
      error: `You've reached today's limit of ${cfg.DAILY_AI_LIMIT} AI requests. It resets at midnight UTC.`,
      code: "QUOTA",
    });
    return false;
  }
  db.prepare(
    "INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1"
  ).run(req.user.id, day);
  return true;
}

function usageFor(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT count FROM usage WHERE user_id = ? AND day = ?").get(userId, day);
  return { used: row ? row.count : 0, limit: cfg.DAILY_AI_LIMIT };
}

// Old single-user rows have no owner. The first person to register can take them over.
function claimLegacyData(userId) {
  db.transaction(() => {
    ["chats", "face_embeddings", "security_captures", "upload_events"].forEach((table) => {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(userId);
    });
  })();
}

// Checks a password for an already-signed-in user, with its own lockout.
async function confirmPassword(req, res, purpose) {
  const key = `${purpose}:${req.user.id}`;
  const wait = auth.lockRemainingMs(key);
  if (wait) {
    res.status(429).json({ error: auth.lockMessage(wait) });
    return false;
  }
  const ok = await auth.checkPassword(req.user, req.body && req.body.password);
  if (!ok) {
    auth.recordFailure(key);
    logAuthEvent(req.user.id, "password", false);
    res.status(403).json({ error: "Incorrect password.", code: "BAD_PASSWORD" });
    return false;
  }
  auth.clearFailures(key);
  return true;
}

// ---------------------------------------------------------------------------
// Public: configuration the login screen needs
// ---------------------------------------------------------------------------

app.get("/api/config", (req, res) => {
  res.json({ registrationOpen: cfg.ALLOW_REGISTRATION, localControls: cfg.ENABLE_LOCAL_CONTROLS });
});

// ---------------------------------------------------------------------------
// Accounts: register, sign in (password or face), session upkeep
// ---------------------------------------------------------------------------

app.post(
  "/api/auth/register",
  registerLimiter,
  wrap(async (req, res) => {
    if (!cfg.ALLOW_REGISTRATION) return res.status(403).json({ error: "New sign-ups are currently closed." });

    const name = auth.cleanName(req.body.name);
    const email = auth.normalizeEmail(req.body.email);
    if (!name) return res.status(400).json({ error: "Please enter your name." });
    if (!email) return res.status(400).json({ error: "Please enter a valid email address." });
    const problem = auth.passwordProblem(req.body.password, email);
    if (problem) return res.status(400).json({ error: problem });

    if (auth.findUserByEmail(email)) {
      return res.status(409).json({ error: "An account with that email already exists. Try signing in or use 'Forgot password'." });
    }

    const isFirstUser = db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0;
    const hash = await auth.hashPassword(req.body.password);

    let user;
    try {
      user = auth.insertUser(name, email, hash);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) {
        return res.status(409).json({ error: "An account with that email already exists. Try signing in or use 'Forgot password'." });
      }
      throw err;
    }

    if (isFirstUser && cfg.CLAIM_LEGACY_DATA) claimLegacyData(user.id);
    logAuthEvent(user.id, "register", true);
    res.status(201).json({ token: auth.issueSessionToken(user), user: auth.publicUser(user) });
  })
);

app.post(
  "/api/auth/login",
  loginLimiter,
  wrap(async (req, res) => {
    const email = auth.normalizeEmail(req.body.email);
    const key = `login:${email || "invalid"}`;

    const wait = auth.lockRemainingMs(key);
    if (wait) return res.status(429).json({ error: auth.lockMessage(wait) });

    const user = email ? auth.findUserByEmail(email) : null;
    const ok = await auth.checkPassword(user, req.body.password); // same work whether or not the email exists

    if (!user || !ok) {
      auth.recordFailure(key);
      if (user) logAuthEvent(user.id, "password", false);
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    auth.clearFailures(key);
    logAuthEvent(user.id, "password", true);
    res.json({ token: auth.issueSessionToken(user), user: auth.publicUser(user) });
  })
);

// Optional fast path. The login screen sends the email it remembers plus a face
// reading. Every failure looks identical (unknown email, no face set up, or wrong
// face), so this can't be used to find out who has an account.
app.post(
  "/api/auth/face-login",
  loginLimiter,
  wrap(async (req, res) => {
    const email = auth.normalizeEmail(req.body.email);
    const embedding = req.body.embedding;
    if (!email || !face.isValidEmbedding(embedding)) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const key = `facelogin:${email}`;
    const wait = auth.lockRemainingMs(key);
    if (wait) return res.status(429).json({ error: auth.lockMessage(wait) });

    const user = auth.findUserByEmail(email);
    const result = user ? face.matchFace(user.id, embedding) : { enrolled: false, isMatch: false };

    if (!user || !result.isMatch) {
      auth.recordFailure(key, 8);
      if (user && result.enrolled) logAuthEvent(user.id, "face", false);
      return res.status(401).json({
        error: "You are an unauthorized user.",
        captureToken: auth.issueCaptureToken(user && result.enrolled ? user.id : null),
      });
    }

    auth.clearFailures(key);
    logAuthEvent(user.id, "face", true);
    res.json({ token: auth.issueSessionToken(user), user: auth.publicUser(user) });
  })
);

// ---------------------------------------------------------------------------
// Forgot password & reset
// ---------------------------------------------------------------------------

app.post(
  "/api/auth/forgot-password/request",
  forgotLimiter,
  wrap(async (req, res) => {
    const email = auth.normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: "Please enter a valid email address." });

    const user = auth.findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "No account found with that email address. Check the spelling or create an account." });
    }

    const resetData = auth.createPasswordReset(email);
    const hasFace = face.hasFace(user.id);

    console.log(`[PASSWORD RESET] Verification code for ${email}: ${resetData.code}`);

    res.json({
      success: true,
      message: "Verification code generated.",
      code: resetData.code,
      hasFace,
    });
  })
);

app.post(
  "/api/auth/forgot-password/reset",
  forgotLimiter,
  wrap(async (req, res) => {
    const email = auth.normalizeEmail(req.body.email);
    const code = req.body.code ? String(req.body.code).trim() : "";
    const newPassword = req.body.newPassword;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: "Please provide your email, verification code, and new password." });
    }

    const result = await auth.applyPasswordReset(email, code, newPassword);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    logAuthEvent(result.user.id, "password_reset", true);
    res.json({ success: true, message: "Password has been reset successfully! You can now sign in." });
  })
);

app.post(
  "/api/auth/forgot-password/verify-face",
  forgotLimiter,
  wrap(async (req, res) => {
    const email = auth.normalizeEmail(req.body.email);
    const embedding = req.body.embedding;
    if (!email || !face.isValidEmbedding(embedding)) {
      return res.status(400).json({ error: "Invalid request or face reading." });
    }

    const user = auth.findUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: "No account found with that email." });
    }

    const match = face.matchFace(user.id, embedding);
    if (!match.enrolled || !match.isMatch) {
      return res.status(401).json({ error: "Face does not match the enrolled face for this account." });
    }

    const resetToken = auth.issueResetToken(user);
    res.json({ success: true, resetToken });
  })
);

app.post(
  "/api/auth/forgot-password/reset-with-token",
  forgotLimiter,
  wrap(async (req, res) => {
    const token = req.body.resetToken;
    const newPassword = req.body.newPassword;
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Missing reset token or new password." });
    }

    const result = await auth.applyPasswordResetWithToken(token, newPassword);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    logAuthEvent(result.user.id, "password_reset", true);
    res.json({ success: true, message: "Password has been reset successfully! You can now sign in." });
  })
);

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user), usage: usageFor(req.user.id), localControls: cfg.ENABLE_LOCAL_CONTROLS });
});

// Quietly swaps in a fresh token while the person is actively working.
app.post("/api/auth/refresh", requireAuth, (req, res) => {
  res.json({ token: auth.issueSessionToken(req.user) });
});

// Re-checks the person's own password and returns a short-lived elevated token.
app.post(
  "/api/auth/elevate",
  sensitiveLimiter,
  requireAuth,
  wrap(async (req, res) => {
    if (!(await confirmPassword(req, res, "elevate"))) return;
    logAuthEvent(req.user.id, "elevate", true);
    res.json({ token: auth.issueElevatedToken(req.user), expiresInMinutes: 15 });
  })
);

// Used by presence monitoring after sign-in. Never returns a score.
app.post("/api/auth/verify-face", requireAuth, (req, res) => {
  if (!face.isValidEmbedding(req.body.embedding)) return res.status(400).json({ error: "Invalid request." });
  const { enrolled, isMatch } = face.matchFace(req.user.id, req.body.embedding);
  res.json({ enrolled, isMatch });
});

// ---------------------------------------------------------------------------
// Face login settings (changing these always needs the password)
// ---------------------------------------------------------------------------

app.post(
  "/api/face/enroll",
  sensitiveLimiter,
  requireAuth,
  wrap(async (req, res) => {
    const embeddings = req.body.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length < 1 || embeddings.length > 5 || !embeddings.every(face.isValidEmbedding)) {
      return res.status(400).json({ error: "We couldn't read your face clearly. Please try again." });
    }
    if (!(await confirmPassword(req, res, "elevate"))) return;
    face.enrollFace(req.user.id, embeddings);
    res.json({ success: true, user: auth.publicUser(req.user) });
  })
);

app.delete(
  "/api/face",
  sensitiveLimiter,
  requireAuth,
  wrap(async (req, res) => {
    if (!(await confirmPassword(req, res, "elevate"))) return;
    face.removeFace(req.user.id);
    res.json({ success: true, user: auth.publicUser(req.user) });
  })
);

// ---------------------------------------------------------------------------
// Account: change password, delete everything
// ---------------------------------------------------------------------------

app.post(
  "/api/account/password",
  sensitiveLimiter,
  requireAuth,
  wrap(async (req, res) => {
    const problem = auth.passwordProblem(req.body.newPassword, req.user.email);
    if (problem) return res.status(400).json({ error: problem });
    req.body.password = req.body.currentPassword;
    if (!(await confirmPassword(req, res, "elevate"))) return;

    const hash = await auth.hashPassword(req.body.newPassword);
    // Raising token_version signs out every other device straight away.
    db.prepare("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?").run(hash, req.user.id);
    const fresh = auth.findUserById(req.user.id);
    res.json({ success: true, token: auth.issueSessionToken(fresh) });
  })
);

function eraseUser(userId) {
  const files = [];
  db.prepare(
    "SELECT m.image_path FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ? AND m.image_path IS NOT NULL"
  )
    .all(userId)
    .forEach((m) => files.push(resolveMediaPath(m.image_path)));
  db.prepare("SELECT filename FROM security_captures WHERE user_id = ?")
    .all(userId)
    .forEach((c) => files.push(path.join(CAPTURE_DIR, c.filename)));
  db.prepare("SELECT filename FROM upload_events WHERE user_id = ? AND filename NOT LIKE '(%'")
    .all(userId)
    .forEach((u) => files.push(path.join(USER_UPLOAD_DIR, u.filename)));

  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)").run(userId);
    ["chats", "face_embeddings", "security_captures", "upload_events", "usage"].forEach((t) =>
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId)
    );
    db.prepare("DELETE FROM auth_events WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();

  files.forEach(safeUnlink);
}

app.delete(
  "/api/account",
  sensitiveLimiter,
  requireAuth,
  wrap(async (req, res) => {
    if (!(await confirmPassword(req, res, "elevate"))) return;
    eraseUser(req.user.id);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// Chats (always limited to the signed-in user's own)
// ---------------------------------------------------------------------------

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = db
    .prepare(
      `SELECT id, title, pinned, share_token, created_at, updated_at
       FROM chats WHERE user_id = ?
       ORDER BY pinned DESC, updated_at DESC, rowid DESC`
    )
    .all(req.user.id);
  res.json({ chats });
});

app.get("/api/chats/search", requireAuth, (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 100);
  if (!query) return res.json({ results: [] });

  const like = "%" + query.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const rows = db
    .prepare(
      `SELECT m.chat_id, m.content, c.title
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE c.user_id = ? AND m.content LIKE ? ESCAPE '\\'
       ORDER BY m.rowid DESC LIMIT 30`
    )
    .all(req.user.id, like);

  const seen = new Set();
  const results = [];
  for (const row of rows) {
    if (seen.has(row.chat_id)) continue;
    seen.add(row.chat_id);
    const idx = Math.max(0, row.content.toLowerCase().indexOf(query.toLowerCase()));
    const start = Math.max(0, idx - 30);
    const end = idx + query.length + 30;
    results.push({
      chatId: row.chat_id,
      chatTitle: row.title,
      snippet: (start > 0 ? "…" : "") + row.content.slice(start, end) + (end < row.content.length ? "…" : ""),
    });
  }
  res.json({ results });
});

app.post("/api/chats", requireAuth, (req, res) => {
  const id = uuidv4();
  db.prepare("INSERT INTO chats (id, user_id, title) VALUES (?, ?, 'New chat')").run(id, req.user.id);
  res.json({ chat: db.prepare("SELECT id, title, pinned, share_token, created_at, updated_at FROM chats WHERE id = ?").get(id) });
});

app.patch("/api/chats/:id/pin", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  const pinned = chat.pinned ? 0 : 1;
  db.prepare("UPDATE chats SET pinned = ? WHERE id = ?").run(pinned, chat.id);
  res.json({ success: true, pinned: !!pinned });
});

app.patch("/api/chats/:id/rename", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  if (!isText(req.body.title, 200)) return res.status(400).json({ error: "Please enter a title (200 characters at most)." });
  db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(req.body.title.trim(), chat.id);
  res.json({ success: true });
});

app.delete("/api/chats/:id", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  db.prepare("SELECT image_path FROM messages WHERE chat_id = ? AND image_path IS NOT NULL")
    .all(chat.id)
    .forEach((m) => safeUnlink(resolveMediaPath(m.image_path)));
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chat.id);
  db.prepare("DELETE FROM chats WHERE id = ?").run(chat.id);
  res.json({ success: true });
});

// Sharing: creates (or reuses) a private link. Anyone with the link can read that one chat.
app.post("/api/chats/:id/share", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  let token = chat.share_token;
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    db.prepare("UPDATE chats SET share_token = ? WHERE id = ?").run(token, chat.id);
  }
  res.json({ shareToken: token });
});

app.delete("/api/chats/:id/share", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  db.prepare("UPDATE chats SET share_token = NULL WHERE id = ?").run(chat.id);
  res.json({ success: true });
});

// Masks all passwords, emails, phone numbers, and secrets before a chat is shown publicly.
// The stored chat is never changed; only the shared copy is masked.
function redactSensitiveContent(text) {
  if (text === null || text === undefined) return "";
  let r = String(text);

  // 1. API keys & long secret tokens
  r = r.replace(/\b(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z-_]{35}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED API KEY]");
  r = r.replace(/\b(?=[A-Za-z0-9]{32,}\b)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{32,}\b/g, "[REDACTED TOKEN]");

  // 2. Email addresses
  r = r.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED EMAIL]");

  // 3. Credit cards (13-16 digits with spaces or dashes)
  r = r.replace(/\b(?:\d{4}[ -]?){3}\d{1,4}\b/g, "[REDACTED CARD NUMBER]");

  // 4. Phone numbers (international, with + country code, brackets, dots, dashes, spaces, 10-digit mobiles)
  r = r.replace(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15 ? "[REDACTED PHONE]" : m;
  });
  // 10-digit mobile numbers without separators starting with 6-9
  r = r.replace(/\b[6-9]\d{9}\b/g, "[REDACTED PHONE]");
  // Standard 10-digit US/North America numbers
  r = r.replace(/\b[2-9]\d{2}[2-9]\d{6}\b/g, "[REDACTED PHONE]");

  // 5. Passwords / Secrets / PINs / Credentials
  // Key-value or JSON patterns: password: xyz, "password": "xyz", pwd = xyz, pass: xyz, pin: 1234
  r = r.replace(
    /(["']?(?:password|passwd|pwd|passcode|pass|secret|pin|credentials?|api_?key|access_?token|auth_?token)["']?\s*[:=]\s*)(["'][^"'\r\n]+["']|\S+)/gi,
    (m, prefix, val) => {
      if (val.startsWith("[REDACTED")) return m;
      return `${prefix}[REDACTED PASSWORD]`;
    }
  );

  // Natural language phrases: 'my password is xyz', 'password was secret123', 'pin is 1234', 'passcode is 54321'
  r = r.replace(
    /\b((?:my|the|user's|account|current|new|temp(?:orary)?)?\s*(?:password|passcode|pwd|pass|pin)\s+(?:is|was|set to|changed to)\s+)(["'][^"'\r\n]+["']|\S+)/gi,
    (m, prefix, val) => {
      if (val.startsWith("[REDACTED")) return m;
      return `${prefix}[REDACTED PASSWORD]`;
    }
  );

  return r;
}

// PUBLIC: no sign-in needed, but the 32-character random token is required.
app.get("/api/shared/:token", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(404).json({ error: "This shared chat doesn't exist or has been revoked." });
  const chat = db.prepare("SELECT id, title FROM chats WHERE share_token = ?").get(req.params.token);
  if (!chat) return res.status(404).json({ error: "This shared chat doesn't exist or has been revoked." });

  const messages = db
    .prepare("SELECT role, content, image_path, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(chat.id)
    .map((m) => ({ ...m, content: redactSensitiveContent(m.content) }));
  res.json({ title: redactSensitiveContent(chat.title), messages });
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

app.get("/api/chats/:id/messages", requireAuth, (req, res) => {
  if (!ownChat(req.params.id, req.user.id)) return res.status(404).json({ error: "Chat not found." });
  const messages = db
    .prepare("SELECT id, role, content, image_path, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(req.params.id);
  res.json({ messages });
});

// The browser may only add the person's own messages. Replies are written by the server.
app.post("/api/chats/:id/messages", requireAuth, (req, res) => {
  const chat = ownChat(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  const { role, content } = req.body;
  if (role !== "user") return res.status(400).json({ error: "Invalid message." });
  if (!isText(content, 8000)) return res.status(400).json({ error: "Please enter a message (8000 characters at most)." });

  const id = uuidv4();
  db.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)").run(id, chat.id, content);
  db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chat.id);
  if (chat.title === "New chat") {
    const title = content.slice(0, 50) + (content.length > 50 ? "…" : "");
    db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, chat.id);
  }
  res.json({ message: db.prepare("SELECT id, role, content, image_path, created_at FROM messages WHERE id = ?").get(id) });
});

app.delete("/api/messages/:id", requireAuth, (req, res) => {
  const row = db
    .prepare("SELECT m.id, m.image_path FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ? AND c.user_id = ?")
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: "Message not found." });
  safeUnlink(resolveMediaPath(row.image_path));
  db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
  res.json({ success: true });
});

function saveAssistantMessage(chatId, content, imagePath) {
  const id = uuidv4();
  db.prepare("INSERT INTO messages (id, chat_id, role, content, image_path) VALUES (?, ?, 'assistant', ?, ?)").run(
    id,
    chatId,
    content,
    imagePath || null
  );
  db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chatId);
  return db.prepare("SELECT id, role, content, image_path, created_at FROM messages WHERE id = ?").get(id);
}

// ---------------------------------------------------------------------------
// AI: text chat (Gemini)
// ---------------------------------------------------------------------------

const FORMATTING_RULES = `Formatting rules for your reply: write in plain, natural prose. Do NOT use markdown symbols like #, ##, **, or --- anywhere in your answer. Break your answer into short paragraphs of no more than 4 lines each, then move to a new paragraph. Only use a bulleted list (plain dashes, one item per line) when listing multiple distinct items — otherwise write in full sentences and paragraphs.`;

const GEMINI_URL = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${cfg.GEMINI_API_KEY}`;

async function callGemini(contents, attempt = 1) {
  if (!cfg.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
  const response = await fetch(GEMINI_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });
  if (response.status === 503 && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 1500));
    return callGemini(contents, attempt + 1);
  }
  if (!response.ok) throw new Error(`Gemini returned status ${response.status}`);
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

function askTextModel(userText, history = []) {
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  contents.push({ role: "user", parts: [{ text: `${FORMATTING_RULES}\n\n${userText}` }] });
  return callGemini(contents);
}

async function analyzeImageFile(buffer, ext, task) {
  try {
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : `image/${ext.replace(".", "")}`;
    return await callGemini([
      {
        parts: [
          { text: `${FORMATTING_RULES}\n\n${task || "Describe and analyze this image in detail."}` },
          { inline_data: { mime_type: mime, data: buffer.toString("base64") } },
        ],
      },
    ]);
  } catch (err) {
    console.error("Image analysis failed:", err.message);
    return "I received the image, but analysis failed. Please try again.";
  }
}

app.post(
  "/api/chat",
  requireAuth,
  wrap(async (req, res) => {
    const { prompt, chatId } = req.body;
    if (!isText(prompt, MAX_PROMPT)) return res.status(400).json({ error: `Please enter a message (up to ${MAX_PROMPT} characters).` });
    const chat = ownChat(chatId, req.user.id);
    if (!chat) return res.status(404).json({ error: "Chat not found." });
    if (!takeQuota(req, res)) return;

    // The most recent 20 messages give the model context.
    const history = db
      .prepare(
        `SELECT role, content FROM (
           SELECT role, content, rowid AS rid FROM messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT 20
         ) ORDER BY rid ASC`
      )
      .all(chat.id);
    // The browser saves the question before asking for the answer; don't send it twice.
    const last = history[history.length - 1];
    if (last && last.role === "user" && last.content === prompt) history.pop();

    try {
      const reply = await askTextModel(prompt, history);
      res.json({ message: saveAssistantMessage(chat.id, reply) });
    } catch (err) {
      console.error("Chat failed:", err.message);
      res.status(502).json({ error: "The AI service didn't respond. Please try again in a moment." });
    }
  })
);

// ---------------------------------------------------------------------------
// AI: image generation (Pollinations, free, no key)
// ---------------------------------------------------------------------------

app.post(
  "/api/generate",
  requireAuth,
  wrap(async (req, res) => {
    const { prompt, chatId } = req.body;
    if (!isText(prompt, 800)) return res.status(400).json({ error: "Please describe the image in 800 characters or fewer." });
    const chat = ownChat(chatId, req.user.id);
    if (!chat) return res.status(404).json({ error: "Chat not found." });
    if (!takeQuota(req, res)) return;

    try {
      const seed = Math.floor(Math.random() * 1_000_000);
      const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux&enhance=true`;
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`Image service returned status ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const type = await FileType.fromBuffer(buffer);
      if (!type || !["png", "jpg", "webp", "gif"].includes(type.ext)) throw new Error("Image service returned something that isn't an image.");

      const filename = `${uuidv4()}.${type.ext}`;
      fs.writeFileSync(path.join(cfg.UPLOAD_DIR, filename), buffer);
      res.json({ message: saveAssistantMessage(chat.id, `Generated image for: "${prompt}"`, `/generated/${filename}`) });
    } catch (err) {
      console.error("Image generation failed:", err.message);
      res.status(502).json({ error: "Image generation failed. Please try again." });
    }
  })
);

// Generated images are served by exact file name only (an unguessable UUID), and
// nothing else in the uploads folder can be reached through this route.
app.get("/generated/:file", (req, res) => {
  if (!/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(req.params.file)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(cfg.UPLOAD_DIR, req.params.file), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------------------------------------------------------------------------
// Files: scanning, analysis, upload (all need the person's own chat and, for code files, password)
// ---------------------------------------------------------------------------

// Hash lookup against VirusTotal. A file it has never seen counts as unknown, not malicious.
async function scanFileForMalware(buffer) {
  if (!cfg.VIRUSTOTAL_API_KEY) return { clean: true, skipped: true };
  try {
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const response = await fetch(`https://www.virustotal.com/api/v3/files/${hash}`, {
      headers: { "x-apikey": cfg.VIRUSTOTAL_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return { clean: true, unknown: true };
    if (!response.ok) return { clean: true, skipped: true };
    const stats = (await response.json()).data.attributes.last_analysis_stats;
    const detections = stats.malicious + stats.suspicious;
    return { clean: detections === 0, detections };
  } catch (err) {
    console.error("Malware scan unavailable:", err.message);
    return { clean: true, skipped: true };
  }
}

function logUpload(userId, file, wasElevated, storedName) {
  const ext = path.extname(file.originalname).replace(".", "").toLowerCase().slice(0, 12);
  db.prepare(
    "INSERT INTO upload_events (user_id, filename, original_name, extension, sha256, was_elevated) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, storedName || "(analysed, not stored)", String(file.originalname).slice(0, 200), ext, sha256(file.buffer), wasElevated ? 1 : 0);
}

async function runAnalysis(file, chat, instruction) {
  const ext = path.extname(file.originalname).toLowerCase();
  const task = isText(instruction, 2000) ? instruction.trim() : "Analyze this file and summarize its key points.";
  let analysis;

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    analysis = await askTextModel(`${task}\n\nDocument content:\n\n${result.value.slice(0, 8000)}`);
  } else if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext)) {
    analysis = await askTextModel(`${task}\n\nFile content:\n\n${file.buffer.toString("utf-8").slice(0, 8000)}`);
  } else if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    analysis = await analyzeImageFile(file.buffer, ext, task);
  } else {
    analysis = `I received "${file.originalname}" (${ext || "unknown type"}), but I can only analyze text files (.txt, .md, .csv, .json, .log, .docx) and common image formats right now.`;
  }
  return saveAssistantMessage(chat.id, analysis);
}

// Shared by both analyze routes. `elevated` is true on the password-verified route.
async function handleAnalyze(req, res, elevated) {
  const chat = ownChat(req.body.chatId, req.user.id);
  if (!req.file || !chat) return res.status(400).json({ error: "A file and one of your chats are required." });

  const verdict = await classifyUpload(req.file);
  if (verdict.verdict === "reject") return res.status(400).json({ error: verdict.reason });
  if (verdict.verdict === "needs_elevation" && !elevated) {
    return res.status(403).json({ error: verdict.reason, code: "ELEVATION_REQUIRED" });
  }

  const scan = await scanFileForMalware(req.file.buffer);
  if (!scan.clean) {
    return res.status(400).json({ error: `This file was flagged by ${scan.detections} security engine(s) and can't be used.` });
  }
  if (!takeQuota(req, res)) return;

  logUpload(req.user.id, req.file, elevated);
  try {
    res.json({ message: await runAnalysis(req.file, chat, req.body.instruction) });
  } catch (err) {
    console.error("File analysis failed:", err.message);
    res.status(502).json({ error: "File analysis failed. Please try again." });
  }
}

app.post("/api/analyze", requireAuth, upload.single("file"), wrap((req, res) => handleAnalyze(req, res, false)));
app.post("/api/analyze/elevated", requireElevated, upload.single("file"), wrap((req, res) => handleAnalyze(req, res, true)));

async function handleStore(req, res, elevated) {
  if (!req.file) return res.status(400).json({ error: "No file provided." });
  const verdict = await classifyUpload(req.file);
  if (verdict.verdict === "reject") return res.status(400).json({ error: verdict.reason });
  if (verdict.verdict === "needs_elevation" && !elevated) {
    return res.status(403).json({ error: verdict.reason, code: "ELEVATION_REQUIRED" });
  }
  const scan = await scanFileForMalware(req.file.buffer);
  if (!scan.clean) return res.status(400).json({ error: `This file was flagged by ${scan.detections} security engine(s).` });

  fs.mkdirSync(USER_UPLOAD_DIR, { recursive: true });
  const ext = path.extname(req.file.originalname).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
  const storedName = `${uuidv4()}${ext}`;
  fs.writeFileSync(path.join(USER_UPLOAD_DIR, storedName), req.file.buffer, { mode: 0o600 });
  logUpload(req.user.id, req.file, elevated, storedName);
  res.json({ success: true, storedName });
}

app.post("/api/upload", requireAuth, upload.single("file"), wrap((req, res) => handleStore(req, res, false)));
app.post("/api/upload/elevated", requireElevated, upload.single("file"), wrap((req, res) => handleStore(req, res, true)));

// ---------------------------------------------------------------------------
// Security photos: evidence from failed logins and monitoring mismatches
// ---------------------------------------------------------------------------

function saveCapture(userId, imageData, reason) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(typeof imageData === "string" ? imageData : "");
  if (!m) throw new HttpError(400, "Invalid image.");
  const buffer = Buffer.from(m[2], "base64");
  const isPng = buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (buffer.length > 2 * 1024 * 1024 || !(isPng || isJpg)) throw new HttpError(400, "Invalid image.");

  const dir = path.join(CAPTURE_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${isPng ? "png" : "jpg"}`;
  fs.writeFileSync(path.join(dir, name), buffer, { mode: 0o600 });
  const relative = `${userId}/${name}`;
  db.prepare("INSERT INTO security_captures (user_id, filename, reason) VALUES (?, ?, ?)").run(userId, relative, reason);
  return relative;
}

// Signed in: a different face showed up during monitoring.
app.post("/api/security/capture", requireAuth, captureLimiter, (req, res) => {
  saveCapture(req.user.id, req.body.imageData, "monitoring_mismatch");
  res.json({ success: true });
});

// Not signed in: a failed face login. The photo is only accepted with the one-time
// token the failed attempt returned, so strangers can't fill your log with junk.
const usedCaptureTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [jti, expires] of usedCaptureTokens) if (expires < now) usedCaptureTokens.delete(jti);
}, 5 * 60 * 1000).unref();

app.post("/api/security/capture-failed", captureLimiter, (req, res) => {
  const payload = auth.verifyCaptureToken(req.body.captureToken);
  if (!payload || usedCaptureTokens.has(payload.jti)) return res.status(400).json({ error: "Capture token invalid or expired." });
  usedCaptureTokens.set(payload.jti, Date.now() + 5 * 60 * 1000);
  if (payload.uid) saveCapture(payload.uid, req.body.imageData, "failed_login");
  res.json({ success: true });
});

app.get("/api/security/captures", requireAuth, (req, res) => {
  const captures = db
    .prepare("SELECT id, reason, created_at FROM security_captures WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50")
    .all(req.user.id)
    .map((c) => ({ ...c, imageUrl: `/api/security/captures/${c.id}/image` }));
  res.json({ captures });
});

function captureFile(row) {
  const root = path.resolve(CAPTURE_DIR);
  const full = path.resolve(root, row.filename);
  return full.startsWith(root + path.sep) ? full : null;
}

app.get("/api/security/captures/:id/image", requireAuth, (req, res) => {
  const row = db.prepare("SELECT filename FROM security_captures WHERE id = ? AND user_id = ?").get(Number(req.params.id) || 0, req.user.id);
  const full = row && captureFile(row);
  if (!full) return res.status(404).json({ error: "Photo not found." });
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Photo not found." });
  });
});

app.delete("/api/security/captures/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT id, filename FROM security_captures WHERE id = ? AND user_id = ?").get(Number(req.params.id) || 0, req.user.id);
  if (!row) return res.status(404).json({ error: "Photo not found." });
  safeUnlink(captureFile(row));
  db.prepare("DELETE FROM security_captures WHERE id = ?").run(row.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Documents: PDF, PowerPoint, code files, ZIP projects
// ---------------------------------------------------------------------------

registerCreateRoutes(app, { db, requireAuth, uploadDir: cfg.UPLOAD_DIR, takeQuota });

// ---------------------------------------------------------------------------
// Windows controls — ONLY when this server is your own laptop (ENABLE_LOCAL_CONTROLS=true).
// On a website these would run on the server, not the visitor's PC, so they stay off.
// ---------------------------------------------------------------------------

if (cfg.ENABLE_LOCAL_CONTROLS) {
  const ALLOWED_APPS = {
    notepad: "notepad.exe",
    explorer: "explorer.exe",
    calculator: "calc.exe",
    whatsapp: "start whatsapp:",
    vscode: "code",
    chrome: "start chrome",
    taskmanager: "taskmgr.exe",
    settings: "start ms-settings:",
    snip: "start ms-screenclip:",
    terminal: "start wt",
  };

  app.post("/api/launch/:appName", requireAuth, (req, res) => {
    const cmd = Object.prototype.hasOwnProperty.call(ALLOWED_APPS, req.params.appName) ? ALLOWED_APPS[req.params.appName] : null;
    if (!cmd) return res.status(400).json({ error: "That app isn't in the allowed list." });
    exec(cmd.startsWith("start ") ? cmd : `start "" ${cmd}`, { shell: "cmd.exe" }, (err) => {
      if (err) console.error(`Failed to launch ${req.params.appName}:`, err.message);
    });
    res.json({ success: true });
  });

  app.post("/api/lock-system", requireAuth, (req, res) => {
    exec("rundll32.exe user32.dll,LockWorkStation", (err) => {
      if (err) console.error("Failed to lock system:", err.message);
    });
    res.json({ success: true });
  });
}

// ---------------------------------------------------------------------------
// The website itself, then errors
// ---------------------------------------------------------------------------

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use(express.static(cfg.FRONTEND_DIR));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: err.code === "LIMIT_FILE_SIZE" ? "That file is larger than 20 MB." : "The upload didn't work.",
    });
  }
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That request is too large." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

module.exports = app;

if (require.main === module) {
  app.listen(cfg.PORT, () => {
    console.log(`Aperture is running at http://localhost:${cfg.PORT}`);
    console.log(
      `  accounts: ${cfg.ALLOW_REGISTRATION ? "sign-ups open" : "sign-ups closed"} | ` +
        `Windows controls: ${cfg.ENABLE_LOCAL_CONTROLS ? "ON (local use only)" : "off"} | ` +
        `daily AI limit: ${cfg.DAILY_AI_LIMIT} per person`
    );
  });
}
