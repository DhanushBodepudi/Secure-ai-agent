# Aperture — Secure AI Image Generation Agent

A local, single-user image-generation app with:
- Face-recognition unlock (with password as the real security boundary)
- Password-gated uploads for code/executable file types
- Persistent chat history with multiple sessions
- A dark, distinctive "studio" interface

This README walks through running the whole thing in VS Code from a completely empty folder.

---

## 0. Honest security notes (read this first)

- **Face recognition here is a convenience layer, not strong security.** Webcam face matching can be fooled by a photo or video unless you add liveness detection (blink/head-turn challenges). Treat it as "recognize the usual person quickly," and always keep the password as the real gate.
- **File-extension blocking alone is not real protection** — anyone can rename `script.py` to `script.txt`. That's why `fileFilter.js` also sniffs the actual file content (magic bytes) and flags mismatches, in addition to checking the extension.
- This app runs entirely on `localhost` for one person. If you ever expose it to the internet or multiple users, you'll want HTTPS, a real user table, and hardened rate limiting.

---

## 1. Prerequisites

- [Node.js](https://nodejs.org) v18 or later (check with `node -v` in a terminal)
- [VS Code](https://code.visualstudio.com)
- A webcam (for the face-lock feature — everything else works without one)

---

## 2. Project structure

```
secure-ai-agent/
├── backend/
│   ├── server.js          # Express API: auth, chat, uploads
│   ├── auth.js             # password check + JWT session/elevated tokens
│   ├── faceMatch.js        # face embedding comparison
│   ├── fileFilter.js       # upload extension + content-type gating
│   ├── db.js                # SQLite schema/setup
│   ├── hash-password.js    # helper to generate your password hash
│   ├── .env.example        # copy to .env and fill in
│   ├── package.json
│   ├── data/                # SQLite database file lives here
│   └── uploads/             # uploaded files are stored here (not web-servable)
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```

---

## 3. Step-by-step setup in VS Code

### Step 1 — Open the project
Open the `secure-ai-agent` folder in VS Code (`File → Open Folder…`).

### Step 2 — Open a terminal
`Terminal → New Terminal` in VS Code. You'll run all commands from here.

### Step 3 — Install backend dependencies
```bash
cd backend
npm install
```
This pulls in Express, SQLite, JWT, bcrypt, multer, and the file-type sniffer.

### Step 4 — Create your environment file
```bash
cp .env.example .env
```
Open the new `.env` in VS Code and fill in two things:

**a) Generate a JWT secret:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Paste the output as `JWT_SECRET`.

**b) Generate your password hash** (pick a real password of your own):
```bash
node hash-password.js "YourStrongPassword123!"
```
Copy the printed hash into `ACCOUNT_PASSWORD_HASH` in `.env`.

Leave `IMAGE_API_KEY` for later — the generation endpoint is a placeholder until you wire up a real provider (see Step 8).

### Step 5 — Start the backend
```bash
npm start
```
You should see:
```
Database ready at .../backend/data/app.db
Secure AI agent backend running on http://localhost:4000
```
Leave this terminal running.

### Step 6 — Serve the frontend
The frontend is plain HTML/CSS/JS — no build step. Easiest option inside VS Code:
1. Install the **Live Server** extension (search it in the Extensions panel).
2. Right-click `frontend/index.html` → **Open with Live Server**.

(Alternatively: `cd frontend && npx serve` in a second terminal.)

### Step 7 — First run
1. Your browser opens the app and asks for camera permission — allow it.
2. Since no face is enrolled yet, you'll see the enrollment form: type the **same password** you hashed in Step 4, then click **Capture my face**.
3. You're logged in. Try:
   - **New chat** to start a session
   - Typing a prompt and clicking **Generate** (this returns a placeholder message until you connect a real image API — see Step 8)
   - Clicking the 📎 to upload a file — try a `.txt` (goes straight through) and then a `.py` (it'll ask you to re-enter your password before it uploads)
4. Click **Lock screen** in the sidebar to test the face-login path again.

### Step 8 — Connect a real image generation API
Open `backend/server.js` and find the `/api/generate` route. Replace the placeholder block with a real call to whichever image API you're using, using `process.env.IMAGE_API_KEY`. Save the returned image (or its URL) and set `placeholderImagePath` to it before it's stored in the database.

---

## 4. How each requirement is implemented

### Face-recognition lock + password fallback
- `frontend/app.js` uses **face-api.js** to compute a face embedding (a list of numbers describing the face) directly in the browser — no raw photo is ever sent to the server.
- The embedding is POSTed to `/api/auth/face-login`. `faceMatch.js` compares it against stored embeddings **on the server** using cosine similarity, so the match decision can't be spoofed by tampering with the client.
- If there's no match (or no camera, or the person clicks "Use password instead"), the password form appears. `/api/auth/password-login` checks it against a bcrypt hash in `.env`.
- Both paths issue the same kind of session JWT — from the app's perspective, a successful login is a successful login, but the *elevated* upload permission (next section) can only ever come from a fresh password check, never from a face match alone.

### File upload restrictions
- `fileFilter.js` maintains a denylist of code/executable extensions (`.py`, `.js`, `.exe`, etc.).
- It also sniffs the file's real content type from its bytes (via the `file-type` package) and flags any mismatch between what the extension claims and what the content actually is — this stops the classic "rename `.py` to `.txt`" bypass.
- Flagged files return `403 ELEVATION_REQUIRED` from `/api/upload`. The frontend then shows a password modal; on success it gets a **short-lived (15 minute) elevated JWT** from `/api/auth/elevate` and retries the upload against `/api/upload/elevated`.
- Every upload (elevated or not) is logged to the `upload_events` table with a SHA-256 hash, for auditing.
- Files are stored with randomized names in a non-web-servable folder with restrictive permissions, and are never executed by the server.

### Chat history + new sessions
- `db.js` defines `chats` and `messages` tables in SQLite.
- `/api/chats` (GET/POST) lists and creates chats; `/api/chats/:id/messages` reads and appends messages.
- The frontend sidebar lists chats by auto-generated title (from the first message) and lets you switch between them or start a new one instantly.

### Interface
- No build tooling required — plain HTML/CSS/JS, so it's easy to read and modify.
- Dark "studio" theme with a brass accent, serif display headline, and a circular camera viewfinder on the lock screen, avoiding generic dashboard/SaaS defaults.
- Responsive down to a single column on narrow screens; motion is minimal and respects `prefers-reduced-motion`.

---

## 5. Suggested next steps

- Swap the in-browser face model loading (`cdn.jsdelivr.net`) for locally hosted model files if you want this fully offline.
- Add TOTP-based 2FA on top of the password for a real second factor.
- Add a "sessions" table to support multiple enrolled users, if this ever needs to serve more than one person.
- Add ClamAV or a similar scanner to the elevated upload path before saving the file to disk.
