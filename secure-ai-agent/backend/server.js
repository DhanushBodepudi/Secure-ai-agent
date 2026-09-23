// server.js
// Entry point. Wires together auth, face matching, file upload gating, and
// chat storage behind a small REST API.
const OpenAI = require("openai");
const mammoth = require("mammoth");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");

const db = require("./db");
const {
  verifyPassword,
  issueSessionToken,
  issueElevatedToken,
  requireAuth,
  requireElevated,
} = require("./auth");
const { hasEnrolledFace, enrollFace, findBestMatch } = require("./faceMatch");
const { classifyUpload, sha256 } = require("./fileFilter");

const app = express();
const PORT = process.env.PORT || 4000;
const openai = new OpenAI({ apiKey: process.env.IMAGE_API_KEY });
app.use(cors());
app.use(express.json({ limit: "5mb" })); // face embeddings are smallish JSON arrays

// Uploaded files never get executed and are stored outside any web root,
// with randomized names so a client can't control the storage path.
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/generated", express.static(UPLOAD_DIR));
const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Rate limiting for auth endpoints: slows down brute-force password guessing.
// ---------------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
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

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

// GET /api/auth/status — tells the frontend whether a face has been enrolled
// yet, so it knows whether to offer face-login or go straight to password.
app.get("/api/auth/status", (req, res) => {
  res.json({ faceEnrolled: hasEnrolledFace() });
});

// POST /api/auth/enroll-face
// Only allowed if no face is enrolled yet, OR the caller already has a valid
// session (re-enrolling should require you to already be logged in).
app.post("/api/generate", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  try {
    // Pollinations.ai — free, no API key required. Build the request URL from
    // the prompt (URL-encoded) and fetch the raw image bytes.
    const encodedPrompt = encodeURIComponent(prompt);
    const seed = Math.floor(Math.random() * 1_000_000); // varies the result each time
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
// POST /api/auth/face-login
// Browser sends a computed embedding (never a raw photo). Server compares it
// against stored embeddings server-side and decides the match itself.
// POST /api/auth/verify-face
// Used for ongoing presence monitoring after login — checks a face WITHOUT
// issuing a new session token. Requires an existing valid session, so a
// stranger can't hammer this endpoint without already being logged in.
app.post("/api/auth/verify-face", requireAuth, (req, res) => {
  const { embedding } = req.body;
  if (!Array.isArray(embedding)) {
    return res.status(400).json({ error: "Invalid embedding." });
  }

  const { similarity, isMatch } = findBestMatch(embedding);
  res.json({ isMatch, similarity });
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
      error: "Face not recognized. Please enter your password instead.",
      similarity,
    });
  }

  const token = issueSessionToken();
  res.json({ success: true, token, level: "standard" });
});

// POST /api/auth/password-login
// The universal fallback. Always available, regardless of face result.
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

// POST /api/auth/elevate
// Requires an existing valid session AND a fresh correct password.
// Issues a short-lived elevated token used only to unlock code-file uploads.
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
// CHAT ROUTES (all require a standard session)
// ---------------------------------------------------------------------------

app.get("/api/chats", requireAuth, (req, res) => {
  const chats = db
    .prepare("SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC")
    .all();
  res.json({ chats });
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

app.post("/api/chats", requireAuth, (req, res) => {
  const id = uuidv4();
  db.prepare("INSERT INTO chats (id, title) VALUES (?, ?)").run(
    id,
    "New chat"
  );
  const chat = db.prepare("SELECT * FROM chats WHERE id = ?").get(id);
  res.json({ chat });
});
// GET /api/chats/search?q=keyword
// Searches message content across ALL chats and returns matching chats
// with a short snippet of the matching message.
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

  // Collapse to one result per chat (the most recent match), so a chat
  // with many matching messages doesn't flood the results list.
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

    results.push({
      chatId: row.chat_id,
      chatTitle: row.title,
      snippet,
    });
  }

  res.json({ results });
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

  // Auto-title the chat from the first user message.
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
// DELETE a single message from a chat
app.delete("/api/messages/:id", requireAuth, (req, res) => {
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(req.params.id);
  if (!message) {
    return res.status(404).json({ error: "Message not found." });
  }

  db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});
// ---------------------------------------------------------------------------
// IMAGE GENERATION (placeholder — wire up your provider of choice here)
// ---------------------------------------------------------------------------

app.post("/api/generate", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  // --- Replace this block with a real call to your image generation API ---
  // Example shape:
  // const result = await fetch("https://api.your-image-provider.com/v1/images", {
  //   method: "POST",
  //   headers: { Authorization: `Bearer ${process.env.IMAGE_API_KEY}` },
  //   body: JSON.stringify({ prompt }),
  // }).then(r => r.json());
  // const imageUrl = result.url;

  const placeholderImagePath = null; // set to the real generated file path/url
  // --------------------------------------------------------------------

  const id = uuidv4();
  db.prepare(
    "INSERT INTO messages (id, chat_id, role, content, image_path) VALUES (?, ?, 'assistant', ?, ?)"
  ).run(id, chatId, `Generated image for: "${prompt}"`, placeholderImagePath);

  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
  res.json({ message, note: "Wire up a real image API in server.js /api/generate" });
});
// ---------------------------------------------------------------------------
// TEXT CHAT (question answering) — uses Pollinations' free OpenAI-compatible
// text endpoint, no API key required.
// ---------------------------------------------------------------------------

app.post("/api/chat", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  try {
    const reply = await askTextModel(prompt);

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

// Helper: sends a prompt to Pollinations' free text model and returns the reply.
// Helper: sends a prompt to Pollinations' free, no-key text endpoint.
// Helper: sends a prompt to Google's Gemini free tier.
// Helper: sends a prompt + recent conversation history to Gemini.
const FORMATTING_RULES = `Formatting rules for your reply: write in plain, natural prose. Do NOT use markdown symbols like #, ##, **, or --- anywhere in your answer. Break your answer into short paragraphs of no more than 4 lines each, then move to a new paragraph. Only use a bulleted list (plain dashes, one item per line) when listing multiple distinct items — otherwise write in full sentences and paragraphs.`;

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
    const waitMs = attempt * 1500; // 1.5s, then 3s
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

// ---------------------------------------------------------------------------
// FILE ANALYSIS — reads an uploaded file's text content and asks the model
// to summarize/analyze it. Handles plain text-like files directly; for
// anything else it reports what it is without fabricating contents.
// ---------------------------------------------------------------------------

app.post("/api/chat", requireAuth, async (req, res) => {
  const { prompt, chatId } = req.body;
  if (!prompt || !chatId) {
    return res.status(400).json({ error: "prompt and chatId are required." });
  }

  try {
    // Pull recent messages from this chat so the model has context
    // (including any earlier file analysis).
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
// Helper: sends an image (as a data URL) to a vision-capable model for a description.
async function analyzeImageFile(buffer, ext) {
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
              { text: "Describe and analyze this image in detail." },
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

// ---------------------------------------------------------------------------
// FILE UPLOAD ROUTES
// ---------------------------------------------------------------------------

// Standard upload: allowed for any logged-in session, EXCEPT files that
// classify as code/unknown, which come back as needs_elevation.
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

  return saveUploadedFile(req, res, { wasElevated: false });
});

// Elevated upload: same route logic, but requires a valid elevated token.
// The frontend calls this one after the user re-enters their password.
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

    // Elevated token present → allow, whether it needed elevation or not.
    return saveUploadedFile(req, res, { wasElevated: true });
  }
);

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

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TEXT CHAT (question answering) — uses Google Gemini's free tier.
// ---------------------------------------------------------------------------

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

async function askTextModel(userText, history = [], attempt = 1) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const contents = history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });

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

// ---------------------------------------------------------------------------
// FILE ANALYSIS — reads an uploaded file's content and asks the model to
// summarize/analyze it.
// ---------------------------------------------------------------------------
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

async function analyzeImageFile(buffer, ext, task)  {
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
app.listen(PORT, () => {
  console.log(`Secure AI agent backend running on http://localhost:${PORT}`);
});
