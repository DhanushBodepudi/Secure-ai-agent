// faceMatch.js
// Face templates are stored per user, and a login is only ever compared with the
// templates of the ONE account being signed in to (never against everyone).
//
// The browser sends numbers (a 128-value "embedding" computed by face-api.js),
// never a photo. Matching uses Euclidean distance, the measure face-api.js itself
// recommends. The distance is never sent back to the browser, because a score
// would let an attacker tune guesses until one passes.

const db = require("./db");
const cfg = require("./config");

function isValidEmbedding(e) {
  return (
    Array.isArray(e) &&
    e.length === 128 &&
    e.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 10)
  );
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function getTemplates(userId) {
  return db
    .prepare("SELECT embedding FROM face_embeddings WHERE user_id = ?")
    .all(userId)
    .map((row) => JSON.parse(row.embedding));
}

function hasFace(userId) {
  return db.prepare("SELECT 1 FROM face_embeddings WHERE user_id = ? LIMIT 1").get(userId) !== undefined;
}

// Replaces whatever this user had before with the new set of templates.
function enrollFace(userId, embeddings) {
  const insert = db.prepare("INSERT INTO face_embeddings (user_id, embedding) VALUES (?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM face_embeddings WHERE user_id = ?").run(userId);
    embeddings.forEach((e) => insert.run(userId, JSON.stringify(e)));
  })();
}

function removeFace(userId) {
  db.prepare("DELETE FROM face_embeddings WHERE user_id = ?").run(userId);
}

function matchFace(userId, embedding) {
  const templates = getTemplates(userId);
  if (templates.length === 0) return { enrolled: false, isMatch: false };
  const best = Math.min(...templates.map((t) => euclidean(embedding, t)));
  return { enrolled: true, isMatch: best <= cfg.FACE_MAX_DISTANCE };
}

module.exports = { isValidEmbedding, hasFace, enrollFace, removeFace, matchFace };
