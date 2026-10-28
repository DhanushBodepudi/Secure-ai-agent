// server.js
// Entry point. Wires together auth, face matching, file upload gating, chat
// storage, AI chat/image/analysis, sharing with redaction, malware scanning,
// security capture logging, quick-launch, and OS lock — behind a REST API.

require("dotenv").config();
const { registerCreateRoutes } = require("./generators");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const { exec } = require("child_process");
const mammoth = require("mammoth");

const db = require("./db");
const {
  verifyPassword,
  issueSessionToken,
  issueElevatedToken,
  requireAuth,
  requireElevated,
  verifyToken,
} = require("./auth");
const { hasEnrolledFace, enrollFace, findBestMatch } = require("./faceMatch");
const { classifyUpload, sha256 } = require("./fileFilter");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/generated", express.static(UPLOAD_DIR));
app.use("/security-captures", express.static(path.join(UPLOAD_DIR, "security-captures")));

const upload = multer({ storage: multer.memoryStorage() });

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a minute and try again." },
});

function logAuthEvent(method, success) {
  db.prepare("INSERT INTO auth_events (method, success) VALUES (?, ?)").run(
    method,
    success ? 1 : 0
  );
}

const FORMATTING_RULES = `Formatting rules for your reply: write in plain, natural prose. Do NOT use markdown symbols like #, ##, **, or --- anywhere in your answer. Break your answer into short paragraphs of no more than 4 lines each, then move to a new paragraph. Only use a bulleted list (plain dashes, one item per line) when listing multiple distinct items — otherwise write in full sentences and paragraphs.`;

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

app.get("/api/auth/status", (req, res) => {
  res.json({ faceEnrolled: hasEnrolledFace() });
});

app.post("/api/auth/enroll-face", (req, res) => {
  const { embedding } = req.body;
  if (!Array.isArray(embedding) || embedding.length < 32) {
    return res.status(400).json({ error: "Invalid face embedding." });
  }

  if (hasEnrolledFace()) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token || !verifyToken(token)) {
      return res.status(401).json({
        error: "A face is already enrolled. Log in first to add another.",
      });
    }
  }

  enrollFace(embedding);
  res.json({ success: true });
});

app.post("/api/auth/face-login", authLimiter, (req, res) => {
  const { embedding } = req.body;
  if (!Array.isArray(embedding)) {
    return res.status(400).json({ error: "Invalid embedding." });
  }

  if (!hasEnrolledFace()) {
    return res.status(400).json({ error: "No face enrolled yet." });
  }

  const { similarity, isMatch } = findBestMatch(embedding);
  logAuthEvent("face", isMatch);

  if (!isMatch) {
    return res.status(401).json({
      error: "You are an unauthorized user. Please enter your password instead.",
      similarity,
    });
  }

  const token = issueSessionToken();
  res.json({ success: true, token, level: "standard" });
});

app.post("/api/auth/verify-face", requireAuth, (req, res) => {
  const { embedding } = req.body;
  if (!Array.isArray(embedding)) {
    return res.status(400).json({ error: "Invalid embedding." });
  }

  const { similarity, isMatch } = findBestMatch(embedding);
  res.json({ isMatch, similarity });
});

app.post("/api/auth/password-login", authLimiter, (req, res) => {
  const { password } = req.body;
  const ok = typeof password === "string" && verifyPassword(password);
  logAuthEvent("password", ok);

  if (!ok) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const token = issueSessionToken();
  res.json({ success: true, token, level: "standard" });
});

app.post("/api/auth/elevate", authLimiter, requireAuth, (req, res) => {
  const { password } = req.body;
  const ok = typeof password === "string" && verifyPassword(password);
  logAuthEvent("password", ok);

  if (!ok) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const token = issueElevatedToken();
  res.json({ success: true, token, level: "elevated", expiresInMinutes: 15 });
});

// ---------------------------------------------------------------------------
// CHAT ROUTES
// ---------------------------------------------------------------------------

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = db
    .prepare("SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC")
    .all();
  res.json({ chats });
});

app.get("/api/chats/search", requireAuth, (req, res) => {
  const query = (req.query.q || "").trim();
  if (!query) {
    return res.json({ results: [] });
  }

  const rows = db
    .prepare(
      `SELECT messages.chat_id, messages.content, messages.created_at, chats.title
       FROM messages
       JOIN chats ON chats.id = messages.chat_id
       WHERE messages.content LIKE ?
       ORDER BY messages.created_at DESC
       LIMIT 30`
    )
    .all(`%${query}%`);

  const seenChats = new Set();
  const results = [];
  for (const row of rows) {
    if (seenChats.has(row.chat_id)) continue;
    seenChats.add(row.chat_id);

    const index = row.content.toLowerCase().indexOf(query.toLowerCase());
    const start = Math.max(0, index - 30);
    const snippet =
      (start > 0 ? "…" : "") +
      row.content.slice(start, index + query.length + 30) +
      (index + query.length + 30 < row.content.length ? "…" : "");

    results.push({ chatId: row.chat_id, chatTitle: row.title, snippet });
  }

  res.json({ results });
});

app.post("/api/chats", requireAuth, (req, res) => {
  const id = uuidv4();
  db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(id, "New chat");
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
  res.json({ chat });
});

app.patch("/api/chats/:id/pin", requireAuth, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  const newPinned = chat.pinned ? 0 : 1;
  db.prepare("UPDATE chats SET pinned = ? WHERE id = ?").run(newPinned, req.params.id);
  res.json({ success: true, pinned: !!newPinned });
});

app.patch("/api/chats/:id/rename", requireAuth, (req, res) => {
  const { title } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: "Title cannot be empty." });
  }

  db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title.trim(), req.params.id);
  res.json({ success: true });
});

app.post("/api/chats/:id/share", requireAuth, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(req.params.id);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  let token = chat.share_token;
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    db.prepare("UPDATE chats SET share_token = ? WHERE id = ?").run(token, req.params.id);
  }

  res.json({ shareToken: token });
});

app.delete("/api/chats/:id/share", requireAuth, (req, res) => {
  db.prepare("UPDATE chats SET share_token = NULL WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// PUBLIC route — no login required. Anyone with the exact token can view
// that one chat's messages, read-only, with sensitive-looking content masked.
app.get("/api/shared/:token", (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE share_token = ?").get(req.params.token);
  if (!chat) return res.status(404).json({ error: "This shared chat doesn't exist or has been revoked." });

  const messages = db
    .prepare("SELECT role, content, image_path, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC")
    .all(chat.id);

  const redactedMessages = messages.map((msg) => ({
    ...msg,
    content: redactSensitiveContent(msg.content),
  }));

  res.json({ title: chat.title, messages: redactedMessages });
});

app.get("/api/chats/:id/messages", requireAuth, (req, res) => {
  const messages = db
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC")
    .all(req.params.id);
  res.json({ messages });
});

app.post("/api/chats/:id/messages", requireAuth, (req, res) => {
  const { role, content } = req.body;
  const chatId = req.params.id;

  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  const id = uuidv4();
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)"
  ).run(id, chatId, role, content);

  db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chatId);

  if (chat.title === "New chat" && role === "user") {
    const title = content.slice(0, 50) + (content.length > 50 ? "…" : "");
    db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, chatId);
  }

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  res.json({ message });
});

app.delete("/api/chats/:id", requireAuth, (req, res) => {
  db.prepare("DELETE FROM chats WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.delete("/api/messages/:id", requireAuth, (req, res) => {
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!message) {
    return res.status(404).json({ error: "Message not found." });
  }

  db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// IMAGE GENERATION — Pollinations.ai, free, no API key required.
// ---------------------------------------------------------------------------

app.post("/api/generate", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  try {
    const encodedPrompt = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 1_000_000);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux&enhance=true`;

    const response = await fetch(pollinationsUrl);
    if (!response.ok) {
      throw new Error(`Pollinations returned status ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const filename = `${uuidv4()}.png`;
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    const imageUrl = `/generated/${filename}`;

    const id = uuidv4();
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, image_path) VALUES (?, ?, 'assistant', ?, ?)"
    ).run(id, chatId, `Generated image for: "${prompt}"`, imageUrl);

    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    res.json({ message });
  } catch (err) {
    console.error("Image generation failed:", err.message);
    res.status(500).json({ error: "Image generation failed. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// TEXT CHAT — Google Gemini free tier, with conversation history and
// consistent formatting rules, plus a short retry on transient 503s.
// ---------------------------------------------------------------------------

async function askTextModel(userText, history = [], attempt = 1) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const contents = history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));
  contents.push({ role: "user", parts: [{ text: `${FORMATTING_RULES}\n\n${userText}` }] });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });

  if (response.status === 503 && attempt < 3) {
    const waitMs = attempt * 1500;
    await new Promise((r) => setTimeout(r, waitMs));
    return askTextModel(userText, history, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini returned status ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

app.post("/api/chat", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  try {
    const history = db
      .prepare(
        "SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 20"
      )
      .all(chatId);

    const reply = await askTextModel(prompt, history);

    const id = uuidv4();
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', ?)"
    ).run(id, chatId, reply);

    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    res.json({ message });
  } catch (err) {
    console.error("Chat failed:", err.message);
    res.status(500).json({ error: "Chat failed. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// FILE ANALYSIS
// ---------------------------------------------------------------------------

async function analyzeImageFile(buffer, ext, task) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const mime = ext === ".jpg" ? "image/jpeg" : `image/${ext.replace(".", "")}`;
    const base64 = buffer.toString("base64");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `${FORMATTING_RULES}\n\n${task || "Describe and analyze this image in detail."}` },
              { inline_data: { mime_type: mime, data: base64 } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini vision returned status ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  } catch (err) {
    console.error("Image analysis failed:", err.message);
    return "I received the image, but analysis failed. Please try again.";
  }
}

async function runAnalysis(file, chatId, instruction) {
  const ext = path.extname(file.originalname).toLowerCase();
  const textExtensions = [".txt", ".md", ".csv", ".json", ".log"];
  const task = instruction && instruction.trim()
    ? instruction.trim()
    : "Analyze this file and summarize its key points.";

  let analysis;

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    const fileText = result.value.slice(0, 8000);
    analysis = await askTextModel(`${task}\n\nDocument content:\n\n${fileText}`);
  } else if (textExtensions.includes(ext)) {
    const fileText = file.buffer.toString("utf-8").slice(0, 8000);
    analysis = await askTextModel(`${task}\n\nFile content:\n\n${fileText}`);
  } else if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
    analysis = await analyzeImageFile(file.buffer, ext, task);
  } else {
    analysis = `I received "${file.originalname}" (${ext || "unknown type"}), but I can only analyze text-based files (.txt, .md, .csv, .json, .log, .docx) and common image formats right now.`;
  }

  const id = uuidv4();
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'assistant', ?)"
  ).run(id, chatId, analysis);

  return db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
}

app.post("/api/analyze", requireAuth, upload.single("file"), async (req, res) => {
  const { chatId, instruction } = req.body;
  if (!req.file || !chatId) {
    return res.status(400).json({ error: "file and chatId are required." });
  }

  const classification = await classifyUpload(req.file);
  if (classification.verdict === "reject") {
    return res.status(400).json({ error: classification.reason });
  }
  if (classification.verdict === "needs_elevation") {
    return res.status(403).json({ error: classification.reason, code: "ELEVATION_REQUIRED" });
  }

  const scanResult = await scanFileForMalware(req.file.buffer);
  if (!scanResult.clean) {
    return res.status(400).json({
      error: `This file was flagged by ${scanResult.detections} security engine(s) and cannot be uploaded.`,
    });
  }

  try {
    const message = await runAnalysis(req.file, chatId, instruction);
    res.json({ message });
  } catch (err) {
    console.error("File analysis failed:", err.message);
    res.status(500).json({ error: "File analysis failed. Please try again." });
  }
});

app.post("/api/analyze/elevated", requireElevated, upload.single("file"), async (req, res) => {
  const { chatId, instruction } = req.body;
  if (!req.file || !chatId) {
    return res.status(400).json({ error: "file and chatId are required." });
  }

  try {
    const message = await runAnalysis(req.file, chatId, instruction);
    res.json({ message });
  } catch (err) {
    console.error("File analysis failed:", err.message);
    res.status(500).json({ error: "File analysis failed. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// FILE UPLOAD
// ---------------------------------------------------------------------------

function saveUploadedFile(req, res, { wasElevated }) {
  const file = req.file;
  const ext = path.extname(file.originalname);
  const storedName = `${uuidv4()}${ext}`;
  const destPath = path.join(UPLOAD_DIR, storedName);

  fs.writeFile(destPath, file.buffer, { mode: 0o600 }, (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to store file." });
    }

    db.prepare(
      `INSERT INTO upload_events (filename, original_name, extension, sha256, was_elevated)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      storedName,
      file.originalname,
      ext.replace(".", "").toLowerCase(),
      sha256(file.buffer),
      wasElevated ? 1 : 0
    );

    res.json({ success: true, storedName });
  });
}

app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided." });

  const classification = await classifyUpload(req.file);

  if (classification.verdict === "reject") {
    return res.status(400).json({ error: classification.reason });
  }

  if (classification.verdict === "needs_elevation") {
    return res.status(403).json({
      error: classification.reason,
      code: "ELEVATION_REQUIRED",
    });
  }

  const scanResult = await scanFileForMalware(req.file.buffer);
  if (!scanResult.clean) {
    return res.status(400).json({
      error: `This file was flagged by ${scanResult.detections} security engine(s) and cannot be uploaded.`,
    });
  }

  return saveUploadedFile(req, res, { wasElevated: false });
});

app.post(
  "/api/upload/elevated",
  requireElevated,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided." });

    const classification = await classifyUpload(req.file);
    if (classification.verdict === "reject") {
      return res.status(400).json({ error: classification.reason });
    }

    return saveUploadedFile(req, res, { wasElevated: true });
  }
);

// ---------------------------------------------------------------------------
// MALWARE SCANNING — VirusTotal hash lookup (fails open if unset/unreachable)
// ---------------------------------------------------------------------------

async function scanFileForMalware(buffer) {
  const apiKey = process.env.VIRUSTOTAL_API_KEY;
  if (!apiKey) {
    console.warn("VIRUSTOTAL_API_KEY not set — skipping malware scan.");
    return { clean: true, skipped: true };
  }

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");

  const res = await fetch(`https://www.virustotal.com/api/v3/files/${hash}`, {
    headers: { "x-apikey": apiKey },
  });

  if (res.status === 404) {
    return { clean: true, unknown: true };
  }

  if (!res.ok) {
    console.error("VirusTotal check failed:", res.status);
    return { clean: true, skipped: true };
  }

  const data = await res.json();
  const stats = data.data.attributes.last_analysis_stats;
  const detections = stats.malicious + stats.suspicious;

  return { clean: detections === 0, detections };
}

// ---------------------------------------------------------------------------
// SHARE REDACTION
// ---------------------------------------------------------------------------

function redactSensitiveContent(text) {
  let redacted = text;

  redacted = redacted.replace(/\b(sk-|AIza|ghp_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/g, "[REDACTED API KEY]");
  redacted = redacted.replace(/\b(?=[A-Za-z0-9]{30,}\b)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{30,}\b/g, "[REDACTED TOKEN]");
  redacted = redacted.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[REDACTED EMAIL]");
  redacted = redacted.replace(/\b(\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, "[REDACTED PHONE]");
  redacted = redacted.replace(/\b(?:\d[ -]*?){13,16}\b/g, "[REDACTED NUMBER]");
  redacted = redacted.replace(/\b(password|pwd|pass)\s*[:=]\s*\S+/gi, "$1: [REDACTED]");

  return redacted;
}

// ---------------------------------------------------------------------------
// SECURITY CAPTURES (webcam evidence on unauthorized access attempts)
// ---------------------------------------------------------------------------

// Authenticated version — used for presence-monitoring mismatches (a valid
// session still exists at the moment of capture).
app.post("/api/security/capture", requireAuth, (req, res) => {
  const { imageData } = req.body;
  if (!imageData) {
    return res.status(400).json({ error: "No image data provided." });
  }

  try {
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const filename = `security-capture-${Date.now()}.png`;
    const captureDir = path.join(UPLOAD_DIR, "security-captures");
    if (!fs.existsSync(captureDir)) fs.mkdirSync(captureDir, { recursive: true });

    fs.writeFileSync(path.join(captureDir, filename), buffer);

    db.prepare(
      "INSERT INTO security_captures (filename, reason) VALUES (?, ?)"
    ).run(filename, "monitoring_mismatch");

    console.log(`Security capture saved: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error("Failed to save security capture:", err.message);
    res.status(500).json({ error: "Failed to save capture." });
  }
});

// Unauthenticated version — used during a failed LOGIN attempt, before any
// session token exists. Rate-limited to prevent abuse.
app.post("/api/security/capture-unauth", authLimiter, (req, res) => {
  const { imageData } = req.body;
  if (!imageData) {
    return res.status(400).json({ error: "No image data provided." });
  }

  try {
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const filename = `security-capture-${Date.now()}.png`;
    const captureDir = path.join(UPLOAD_DIR, "security-captures");
    if (!fs.existsSync(captureDir)) fs.mkdirSync(captureDir, { recursive: true });

    fs.writeFileSync(path.join(captureDir, filename), buffer);

    db.prepare(
      "INSERT INTO security_captures (filename, reason) VALUES (?, ?)"
    ).run(filename, "failed_login");

    console.log(`Unauthorized login attempt — capture saved: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error("Failed to save security capture:", err.message);
    res.status(500).json({ error: "Failed to save capture." });
  }
});

app.get("/api/security/captures", requireAuth, (req, res) => {
  const captures = db
    .prepare("SELECT * FROM security_captures ORDER BY created_at DESC LIMIT 50")
    .all();
  res.json({ captures });
});

// ---------------------------------------------------------------------------
// QUICK-LAUNCH (fixed, hardcoded app list only — never driven by free text)
// ---------------------------------------------------------------------------

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
  const appName = req.params.appName;
  const cmd = ALLOWED_APPS[appName];

  if (!cmd) {
    return res.status(400).json({ error: "That app isn't in the allowed list." });
  }

  const fullCommand = cmd.startsWith("start ") ? cmd : `start "" ${cmd}`;

  exec(fullCommand, { shell: "cmd.exe" }, (err) => {
    if (err) {
      console.error(`Failed to launch ${appName}:`, err.message);
    }
  });

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// OS-LEVEL LOCK
// ---------------------------------------------------------------------------

app.post("/api/lock-system", requireAuth, (req, res) => {
  exec("rundll32.exe user32.dll,LockWorkStation", (err) => {
    if (err) {
      console.error("Failed to lock system:", err.message);
    }
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
registerCreateRoutes(app, { db, requireAuth, uploadDir: UPLOAD_DIR });
app.listen(PORT, () => {
  console.log(`Secure AI agent backend running on http://localhost:${PORT}`);
});