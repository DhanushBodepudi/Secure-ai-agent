// generators.js
// Creates downloadable files (PDF, PowerPoint, code file, ZIP project) from a
// text prompt. The AI model returns structured JSON; this module turns that
// JSON into a real file. Nothing generated here is ever executed by the server.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const PDFDocument = require("pdfkit");
const PptxGenJS = require("pptxgenjs");
const archiver = require("archiver");

const MAX_ZIP_FILES = 20;
const MAX_FILE_CHARS = 60000;

// Only these extensions are kept for generated code files; anything else gets
// ".txt" appended so the server never hands out an unexpected file type.
const CODE_EXTENSIONS = new Set([
  "py", "js", "ts", "jsx", "tsx", "html", "css", "json", "java", "c", "cpp",
  "h", "cs", "go", "rs", "php", "rb", "sh", "bat", "ps1", "sql", "md", "txt",
  "yml", "yaml", "xml", "kt", "swift", "dart", "r", "lua",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Download links are only as private as their file names, so each name ends in
// 12 random hex characters that nobody can guess.
const randomSuffix = () => crypto.randomBytes(6).toString("hex");

function safeFileName(name, fallback) {
  const base = path
    .basename(String(name || ""))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return base.slice(0, 60) || fallback;
}

// Cleans a path from the model so it can never escape its own folder
// (no "..", no absolute paths, no odd characters).
function safeRelPath(p) {
  const parts = String(p || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "_"));
  return parts.join("/").slice(0, 150);
}

function parseJsonLoosely(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  }
}

// Asks Gemini for a JSON-only answer. Retries briefly on temporary 503s.
async function askModelForJson(prompt, attempt = 1) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (response.status === 503 && attempt < 3) {
    await new Promise((r) => setTimeout(r, attempt * 1500));
    return askModelForJson(prompt, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Gemini returned status ${response.status}`);
  }

  const data = await response.json();
  return parseJsonLoosely(data.candidates[0].content.parts[0].text);
}

// ---------------------------------------------------------------------------
// What we ask the model for, per file type
// ---------------------------------------------------------------------------

const PROMPTS = {
  pdf: (p) =>
    `Create a well-structured document for this request: "${p}". ` +
    `Respond ONLY with JSON in exactly this shape: ` +
    `{"title": string, "sections": [{"heading": string, "paragraphs": [string]}]}. ` +
    `Write 3 to 8 sections with accurate, substantive content. Plain text only, no markdown symbols.`,

  ppt: (p) =>
    `Create a presentation for this request: "${p}". ` +
    `Respond ONLY with JSON in exactly this shape: ` +
    `{"title": string, "slides": [{"title": string, "bullets": [string]}]}. ` +
    `Make 5 to 10 slides with 3 to 5 concise bullets each. The first slide is the title slide ` +
    `and has a single one-line subtitle as its only bullet. Plain text only, no markdown symbols.`,

  code: (p) =>
    `Write a single complete, working code file for this request: "${p}". ` +
    `Respond ONLY with JSON in exactly this shape: ` +
    `{"filename": string, "language": string, "code": string}. ` +
    `The filename must include the correct extension. Include helpful comments.`,

  zip: (p) =>
    `Create a small but complete project for this request: "${p}". ` +
    `Respond ONLY with JSON in exactly this shape: ` +
    `{"zipName": string, "files": [{"path": string, "content": string}]}. ` +
    `Use at most 15 files, relative paths with forward slashes, and include a README.md ` +
    `explaining how to run it.`,
};

// ---------------------------------------------------------------------------
// Builders — each returns { storedName, summary }
// ---------------------------------------------------------------------------

async function buildPdf(data, outDir) {
  const sections = Array.isArray(data.sections) ? data.sections : [];
  if (sections.length === 0) throw new Error("Model returned no sections.");

  const title = String(data.title || "Document");
  const storedName = `${safeFileName(title, "document")}-${randomSuffix()}.pdf`;
  const filePath = path.join(outDir, storedName);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);

    doc.fontSize(26).font("Helvetica-Bold").text(title);
    doc.moveDown(1);

    sections.forEach((section) => {
      doc.fontSize(16).font("Helvetica-Bold").text(String(section.heading || ""));
      doc.moveDown(0.4);
      const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : [];
      paragraphs.forEach((para) => {
        doc.fontSize(11.5).font("Helvetica").text(String(para), { lineGap: 3 });
        doc.moveDown(0.6);
      });
      doc.moveDown(0.6);
    });

    doc.end();
  });

  return {
    storedName,
    summary: `Created your PDF "${title}" with ${sections.length} sections.`,
  };
}

async function buildPpt(data, outDir) {
  const slides = Array.isArray(data.slides) ? data.slides : [];
  if (slides.length === 0) throw new Error("Model returned no slides.");

  const title = String(data.title || "Presentation");
  const storedName = `${safeFileName(title, "presentation")}-${randomSuffix()}.pptx`;
  const filePath = path.join(outDir, storedName);

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";

  slides.forEach((s, index) => {
    const slide = pptx.addSlide();
    slide.background = { color: "16171C" };
    const bullets = (Array.isArray(s.bullets) ? s.bullets : []).map(String);

    if (index === 0) {
      slide.addText(String(s.title || title), {
        x: 0.7, y: 2.0, w: 8.6, h: 1.4,
        fontSize: 38, bold: true, color: "E0B569",
      });
      slide.addText(bullets[0] || "", {
        x: 0.7, y: 3.5, w: 8.6, h: 0.9,
        fontSize: 20, color: "EDE9E2",
      });
    } else {
      slide.addText(String(s.title || ""), {
        x: 0.6, y: 0.4, w: 8.8, h: 0.9,
        fontSize: 28, bold: true, color: "E0B569",
      });
      // thin accent line under the title
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.6, y: 1.3, w: 1.2, h: 0.05, fill: { color: "C99B4A" },
      });
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.7, w: 8.6, h: 3.6, fontSize: 20, color: "EDE9E2", valign: "top", paraSpaceAfter: 10 }
      );
    }
  });

  await pptx.writeFile({ fileName: filePath });

  return {
    storedName,
    summary: `Created your presentation "${title}" with ${slides.length} slides.`,
  };
}

async function buildCode(data, outDir) {
  const code = String(data.code || "");
  if (!code.trim()) throw new Error("Model returned no code.");

  let name = safeFileName(data.filename, "generated-code.txt");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!CODE_EXTENSIONS.has(ext)) name = `${name}.txt`;

  const storedName = `${randomSuffix()}-${name}`;
  fs.writeFileSync(path.join(outDir, storedName), code.slice(0, MAX_FILE_CHARS), "utf-8");

  return {
    storedName,
    summary: `Created your ${data.language || "code"} file "${name}".`,
  };
}

async function buildZip(data, outDir) {
  const files = (Array.isArray(data.files) ? data.files : [])
    .map((f) => ({ rel: safeRelPath(f.path), content: String(f.content || "") }))
    .filter((f) => f.rel)
    .slice(0, MAX_ZIP_FILES);
  if (files.length === 0) throw new Error("Model returned no files.");

  const baseName = safeFileName(String(data.zipName || "project").replace(/\.zip$/i, ""), "project");
  const storedName = `${baseName}-${randomSuffix()}.zip`;
  const zipPath = path.join(outDir, storedName);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    files.forEach((f) => archive.append(f.content.slice(0, MAX_FILE_CHARS), { name: f.rel }));
    archive.finalize();
  });

  return {
    storedName,
    summary: `Created your ZIP "${baseName}.zip" containing ${files.length} files.`,
  };
}

const BUILDERS = { pdf: buildPdf, ppt: buildPpt, code: buildCode, zip: buildZip };

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function registerCreateRoutes(app, { db, requireAuth, uploadDir, takeQuota }) {
  const outDir = path.join(uploadDir, "created-files");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Files are always sent as downloads and never rendered by the browser, so a
  // generated .html file can't run as a page on the backend's origin.
  app.use(
    "/files",
    (req, res, next) => {
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    express.static(outDir)
  );

  app.post("/api/create/:type", requireAuth, async (req, res) => {
    const { type } = req.params;
    const { prompt, chatId } = req.body;

    if (!BUILDERS[type]) {
      return res.status(400).json({ error: "Unknown file type." });
    }
    if (!prompt || !chatId) {
      return res.status(400).json({ error: "prompt and chatId are required." });
    }

    if (typeof prompt !== "string" || prompt.length > 4000) {
      return res.status(400).json({ error: "Please keep your request under 4000 characters." });
    }

    // The chat must belong to the signed-in user.
    const chat = db.prepare("SELECT id FROM chats WHERE id = ? AND user_id = ?").get(chatId, req.user.id);
    if (!chat) return res.status(404).json({ error: "Chat not found." });

    if (!takeQuota(req, res)) return;

    try {
      const data = await askModelForJson(PROMPTS[type](prompt));
      const result = await BUILDERS[type](data, outDir);

      const id = uuidv4();
      db.prepare(
        "INSERT INTO messages (id, chat_id, role, content, image_path) VALUES (?, ?, 'assistant', ?, ?)"
      ).run(id, chatId, result.summary, `/files/${result.storedName}`);

      db.prepare("UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chatId);

      const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
      res.json({ message });
    } catch (err) {
      console.error(`Create ${type} failed:`, err.message);
      res.status(500).json({
        error: `Could not create the ${type.toUpperCase()}. Please try again.`,
      });
    }
  });
}

module.exports = { registerCreateRoutes };
