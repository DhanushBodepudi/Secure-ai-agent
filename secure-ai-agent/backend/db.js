// db.js
// SQLite database. Every piece of personal data now has a user_id so one
// person can never see another's chats, face data, photos or logs.
//
// If you already have a database from the single-user version, it is upgraded
// in place: missing columns are added and your old rows are kept (they have no
// owner until you claim them, see CLAIM_LEGACY_DATA in .env.example).

const Database = require("better-sqlite3");
const path = require("path");
const cfg = require("./config");

const dbPath = path.join(cfg.DB_DIR, "app.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema (used for brand-new databases) ----------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 0,   -- bump to sign out every device
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS face_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    embedding TEXT NOT NULL,                    -- JSON array of 128 numbers, never a photo
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New chat',
    pinned INTEGER NOT NULL DEFAULT 0,
    share_token TEXT,
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
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    extension TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    was_elevated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    method TEXT NOT NULL,                       -- password | face | register | elevate
    success INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS security_captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,                     -- path inside the captures folder
    reason TEXT NOT NULL,                       -- failed_login | monitoring_mismatch
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,                          -- YYYY-MM-DD (UTC)
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Migrations (upgrade an existing single-user database) -------------------

function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("chats", "pinned", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("chats", "share_token", "TEXT");
addColumnIfMissing("chats", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
addColumnIfMissing("face_embeddings", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
addColumnIfMissing("security_captures", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
addColumnIfMissing("upload_events", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
addColumnIfMissing("auth_events", "user_id", "INTEGER");

// --- Indexes (after the columns above exist) --------------------------------

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_share ON chats(share_token) WHERE share_token IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  CREATE INDEX IF NOT EXISTS idx_faces_user ON face_embeddings(user_id);
  CREATE INDEX IF NOT EXISTS idx_captures_user ON security_captures(user_id);
  CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);
`);

module.exports = db;
