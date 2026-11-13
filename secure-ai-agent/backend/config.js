// config.js
// One place for every setting. Everything is read from environment variables
// (your backend/.env file locally, or the hosting dashboard when deployed).

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const env = process.env;
const bool = (v, d = false) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
const num = (v, d) => {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const NODE_ENV = env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

// ---- Signing secret for login tokens --------------------------------------
let JWT_SECRET = env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.includes("replace_this")) {
  JWT_SECRET = crypto.randomBytes(48).toString("hex");
  if (IS_PROD) {
    console.warn(
      "\n⚠️  JWT_SECRET is missing or too short in production. Using a secure random secret for this session.\n" +
        "   Set a persistent 32+ character JWT_SECRET in your environment variables to keep users logged in across restarts.\n"
    );
  } else {
    console.warn(
      "\n⚠️  JWT_SECRET is missing or too short. Using a temporary secret, so everyone is signed out\n" +
        "   whenever the server restarts. Set a real one in backend/.env.\n"
    );
  }
}

// ---- Folders ---------------------------------------------------------------
// Locally these stay exactly where they were (backend/data and backend/uploads).
// On a host with a persistent disk, set DATA_DIR to that disk's mount path.
const DATA_DIR = env.DATA_DIR ? path.resolve(env.DATA_DIR) : null;
const DB_DIR = DATA_DIR ? path.join(DATA_DIR, "db") : path.join(__dirname, "data");
const UPLOAD_DIR = DATA_DIR ? path.join(DATA_DIR, "uploads") : path.join(__dirname, "uploads");
const FRONTEND_DIR = env.FRONTEND_DIR ? path.resolve(env.FRONTEND_DIR) : path.join(__dirname, "..", "frontend");

[DB_DIR, UPLOAD_DIR].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

module.exports = {
  NODE_ENV,
  IS_PROD,
  PORT: num(env.PORT, 4000),
  JWT_SECRET,

  DB_DIR,
  UPLOAD_DIR,
  FRONTEND_DIR,

  // Accounts
  ALLOW_REGISTRATION: bool(env.ALLOW_REGISTRATION, true),
  SESSION_MINUTES: num(env.SESSION_MINUTES, 45),
  // First person to register takes over data from the old single-user version.
  CLAIM_LEGACY_DATA: bool(env.CLAIM_LEGACY_DATA, false),

  // Face matching: smaller = stricter. 0.6 is face-api.js's own default; 0.5 is safer.
  FACE_MAX_DISTANCE: num(env.FACE_MAX_DISTANCE, 0.5),

  // Fair-use cap on AI requests (chat, images, files, documents) per person per day.
  DAILY_AI_LIMIT: num(env.DAILY_AI_LIMIT, 60),

  // Windows quick-launch buttons and the Windows lock only make sense when the
  // server IS your own laptop. Keep this false on any website.
  ENABLE_LOCAL_CONTROLS: bool(env.ENABLE_LOCAL_CONTROLS, false),

  // Set to 1 when the app sits behind a hosting provider's proxy (so rate limits see real IPs).
  TRUST_PROXY: num(env.TRUST_PROXY, 0),

  // Only needed if the frontend is hosted on a different address than the backend.
  CORS_ORIGIN: env.CORS_ORIGIN || "",

  GEMINI_API_KEY: env.GEMINI_API_KEY || "",
  VIRUSTOTAL_API_KEY: env.VIRUSTOTAL_API_KEY || "",
};
