// db.js
// Sets up a local SQLite database file and creates the tables the app needs.
// SQLite is fine for a single-user/local tool; swap for Postgres if you add multiple users.

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "data", "app.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL"); // better write performance/safety

// --- Schema ---------------------------------------------------------------


db.exec(`
  CREATE TABLE IF NOT EXISTS face_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    embedding TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    image_path TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS upload_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    was_elevated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS security_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);


// --- Migrations -------------------------------------------------------------
// For databases created before a given column existed. Each is wrapped in a
// try/catch since SQLite errors if the column is already there — that's
// expected and safe to ignore on every run after the first.

try {
  db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
} catch (err) {
  // Column already exists — safe to ignore.
}

console.log(`Database ready at ${dbPath}`);

module.exports = db;