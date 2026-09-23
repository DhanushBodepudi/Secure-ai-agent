// faceMatch.js
// Server-side face embedding comparison. The browser only ever sends numeric
// embedding vectors (computed by face-api.js), never raw images, and the
// match decision is made HERE, not trusted from the client.

const db = require("./db");

const THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || "0.92");

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return -1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hasEnrolledFace() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM face_embeddings").get();
  return row.count > 0;
}

function enrollFace(embedding) {
  db.prepare("INSERT INTO face_embeddings (embedding) VALUES (?)").run(
    JSON.stringify(embedding)
  );
}

function findBestMatch(candidateEmbedding) {
  const rows = db.prepare("SELECT embedding FROM face_embeddings").all();
  let best = -1;

  for (const row of rows) {
    const stored = JSON.parse(row.embedding);
    const sim = cosineSimilarity(candidateEmbedding, stored);
    if (sim > best) best = sim;
  }

  return { similarity: best, isMatch: best >= THRESHOLD };
}

module.exports = { hasEnrolledFace, enrollFace, findBestMatch, THRESHOLD };
