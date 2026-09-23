// app.js
// Frontend logic: camera capture + face embedding (via face-api.js, entirely
// client-side), talking to the backend for the real auth decision, chat
// management, and the upload flow including the elevation modal.

const API_BASE = "http://localhost:4000/api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sessionToken = null;
let elevatedToken = null; // present only for ~15 min after password re-verification
let currentChatId = null;
let pendingUploadFile = null;
let pendingAttachment = null; // holds the selected File until Send is clicked
let pendingAction = null;     // 'upload' or 'analyze' — set when elevation is needed
let monitorStream = null;
let monitorInterval = null;
let isMonitoring = false;
let awayTimer = null;
let searchDebounceTimer = null;
let promptRecognizer = null;
let promptListening = false;
let passwordRecognizer = null;
let passwordListening = false;

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const searchInput = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");

const attachmentChip = document.getElementById("attachment-chip");
const attachmentName = document.getElementById("attachment-name");
const removeAttachmentBtn = document.getElementById("remove-attachment-btn");
const passwordMicBtn = document.getElementById("password-mic-btn");
const promptMicBtn = document.getElementById("prompt-mic-btn");
const monitorToggleBtn = document.getElementById("monitor-toggle-btn");
const monitorFeed = document.getElementById("monitor-feed");
const lockScreen = document.getElementById("lock-screen");
const appShell = document.getElementById("app-shell");
const cameraFeed = document.getElementById("camera-feed");
const lockStatus = document.getElementById("lock-status");
const usePasswordBtn = document.getElementById("use-password-btn");
const passwordForm = document.getElementById("password-form");
const passwordInput = document.getElementById("password-input");
const passwordError = document.getElementById("password-error");
const enrollForm = document.getElementById("enroll-form");
const enrollFaceBtn = document.getElementById("enroll-face-btn");
const enrollError = document.getElementById("enroll-error");

const newChatBtn = document.getElementById("new-chat-btn");
const chatListEl = document.getElementById("chat-list");
const currentChatTitle = document.getElementById("current-chat-title");
const messageListEl = document.getElementById("message-list");
const promptInput = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const lockAppBtn = document.getElementById("lock-app-btn");

const elevateModal = document.getElementById("elevate-modal");
const elevateReason = document.getElementById("elevate-reason");
const elevatePasswordInput = document.getElementById("elevate-password-input");
const elevateConfirmBtn = document.getElementById("elevate-confirm-btn");
const elevateCancelBtn = document.getElementById("elevate-cancel-btn");
const elevateError = document.getElementById("elevate-error");

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function init() {
  await loadFaceModels();
  const status = await fetch(`${API_BASE}/auth/status`).then((r) => r.json());

  if (status.faceEnrolled) {
    startCameraAndAttemptFaceLogin();
  } else {
    lockStatus.textContent = "Let's get you set up.";
    enrollForm.classList.remove("hidden");
    startCameraOnly();
  }
}

async function loadFaceModels() {
  const MODEL_URL =
    "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
}

async function startCameraOnly() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraFeed.srcObject = stream;
  } catch (err) {
    lockStatus.textContent = "Camera unavailable — use your password.";
    showPasswordForm();
  }
}
// ---------------------------------------------------------------------------
// Liveness check (random head-turn challenge) — asks for a randomly chosen
// direction each login, so a static photo (can't move) or a pre-recorded
// video (unlikely to match the random direction at the right moment) can't
// easily pass.
// ---------------------------------------------------------------------------

const TURN_CHECK_DURATION_MS = 6000;
const TURN_THRESHOLD = 0.12; // how far the nose must shift, as a fraction of face width

function getNoseOffset(landmarks) {
  const nose = landmarks.getNose();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();

  const noseTip = nose[3]; // tip of the nose
  const eyeMidX = (leftEye[0].x + rightEye[3].x) / 2;
  const faceWidth = Math.abs(rightEye[3].x - leftEye[0].x);

  if (faceWidth === 0) return 0;
  return (noseTip.x - eyeMidX) / faceWidth; // negative = turned left, positive = turned right
}

async function waitForHeadTurn(videoEl, direction) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const interval = setInterval(async () => {
      if (Date.now() - startTime > TURN_CHECK_DURATION_MS) {
        clearInterval(interval);
        resolve(false);
        return;
      }

      const detection = await faceapi
        .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks();

      if (!detection) return;

      const offset = getNoseOffset(detection.landmarks);

      // Camera image is mirrored (scaleX(-1) in CSS), so a viewer's "left"
      // corresponds to a positive offset here, and "right" to negative.
      const turnedLeft = offset > TURN_THRESHOLD;
      const turnedRight = offset < -TURN_THRESHOLD;

      if ((direction === "left" && turnedLeft) || (direction === "right" && turnedRight)) {
        clearInterval(interval);
        resolve(true);
      }
    }, 150);
  });
}

function pickRandomDirection() {
  return Math.random() < 0.5 ? "left" : "right";
}
async function startCameraAndAttemptFaceLogin() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraFeed.srcObject = stream;
    setTimeout(attemptFaceLogin, 1200);
  } catch (err) {
    lockStatus.textContent = "Camera unavailable — use your password.";
    showPasswordForm();
  }
}

async function attemptFaceLogin() {
  const detection = await faceapi
    .detectSingleFace(cameraFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    lockStatus.textContent = "No face detected — try again or use your password.";
    return; // leave camera running; user can retry or switch to password
  }

  // --- Liveness check: require a randomly-chosen head turn ---
  const direction = pickRandomDirection();
  lockStatus.textContent = `Please turn your head ${direction} to verify it's really you…`;
  const turned = await waitForHeadTurn(cameraFeed, direction);

  if (!turned) {
    lockStatus.textContent = `No ${direction} turn detected — try again or use your password.`;
    return;
  }

  lockStatus.textContent = "Verifying…";

  // Take a fresh detection after the turn check, since some time has passed.
  const freshDetection = await faceapi
    .detectSingleFace(cameraFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!freshDetection) {
    lockStatus.textContent = "Lost track of your face — try again.";
    return;
  }

  const embedding = Array.from(freshDetection.descriptor);

  const res = await fetch(`${API_BASE}/auth/face-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embedding }),
  });
  const data = await res.json();

  if (res.ok && data.success) {
    sessionToken = data.token;
    lockStatus.textContent = "Welcome back.";
    setTimeout(enterApp, 400);
  } else {
    lockStatus.textContent = "Face not recognized.";
    showPasswordForm();
  }
}
function showPasswordForm() {
  passwordForm.classList.remove("hidden");
  passwordInput.focus();
}

usePasswordBtn.addEventListener("click", showPasswordForm);

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  passwordError.textContent = "";

  const res = await fetch(`${API_BASE}/auth/password-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: passwordInput.value }),
  });
  const data = await res.json();

  if (res.ok && data.success) {
    sessionToken = data.token;
    enterApp();
  } else {
    passwordError.textContent = data.error || "Incorrect password.";
  }
});

// --- First-run enrollment ---
enrollFaceBtn.addEventListener("click", async () => {
  enrollError.textContent = "";
  const password = document.getElementById("enroll-password-input").value;

  if (!password || password.length < 8) {
    enrollError.textContent = "Choose a password with at least 8 characters, set it in your .env first (see README).";
    return;
  }

  const detection = await faceapi
    .detectSingleFace(cameraFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    enrollError.textContent = "No face detected. Center your face in the frame and try again.";
    return;
  }

  const embedding = Array.from(detection.descriptor);
  const res = await fetch(`${API_BASE}/auth/enroll-face`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embedding }),
  });

  if (res.ok) {
    lockStatus.textContent = "Face saved. Logging you in…";
    const loginRes = await fetch(`${API_BASE}/auth/password-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const loginData = await loginRes.json();
    if (loginRes.ok) {
      sessionToken = loginData.token;
      enterApp();
    }
  } else {
    const data = await res.json();
    enrollError.textContent = data.error || "Could not save face.";
  }
});

function stopCamera() {
  const stream = cameraFeed.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

function enterApp() {
  stopCamera();
  lockScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  loadChats();
}

lockAppBtn.addEventListener("click", () => {
  stopMonitoring();
  sessionToken = null;
  elevatedToken = null;
  appShell.classList.add("hidden");
  lockScreen.classList.remove("hidden");
  passwordForm.classList.add("hidden");
  passwordInput.value = "";
  init();
});

// ---------------------------------------------------------------------------
// Chat management
// ---------------------------------------------------------------------------

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${sessionToken}`, ...extra };
}

async function loadChats() {
  const res = await fetch(`${API_BASE}/chats`, { headers: authHeaders() });
  const { chats } = await res.json();

  chatListEl.innerHTML = "";

  const pinned = chats.filter((c) => c.pinned);
  const unpinned = chats.filter((c) => !c.pinned);

  if (pinned.length > 0) {
    const label = document.createElement("div");
    label.className = "chat-section-label";
    label.textContent = "Pinned";
    chatListEl.appendChild(label);
    pinned.forEach((chat) => chatListEl.appendChild(buildChatItem(chat)));
  }

  if (unpinned.length > 0) {
    if (pinned.length > 0) {
      const label = document.createElement("div");
      label.className = "chat-section-label";
      label.textContent = "Recent";
      chatListEl.appendChild(label);
    }
    unpinned.forEach((chat) => chatListEl.appendChild(buildChatItem(chat)));
  }

  if (!currentChatId && chats.length > 0) {
    openChat(chats[0].id, chats[0].title);
  } else if (chats.length === 0) {
    createNewChat();
  }
}

function buildChatItem(chat) {
  const el = document.createElement("div");
  el.className = "chat-item" + (chat.id === currentChatId ? " active" : "");

  const titleSpan = document.createElement("span");
  titleSpan.className = "chat-item-title";
  titleSpan.textContent = chat.title;
  titleSpan.addEventListener("click", () => openChat(chat.id, chat.title));

  const menuBtn = document.createElement("button");
  menuBtn.className = "chat-menu-btn";
  menuBtn.textContent = "⋯";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleChatMenu(chat, el);
  });

  el.appendChild(titleSpan);
  el.appendChild(menuBtn);
  return el;
}

function toggleChatMenu(chat, chatEl) {
  const existing = document.querySelector(".chat-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "chat-context-menu";

  const pinItem = document.createElement("div");
  pinItem.className = "chat-context-item";
  pinItem.textContent = chat.pinned ? "Unpin" : "Pin";
  pinItem.addEventListener("click", async (e) => {
    e.stopPropagation();
    await fetch(`${API_BASE}/chats/${chat.id}/pin`, {
      method: "PATCH",
      headers: authHeaders(),
    });
    menu.remove();
    loadChats();
  });

  const renameItem = document.createElement("div");
  renameItem.className = "chat-context-item";
  renameItem.textContent = "Rename";
  renameItem.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newTitle = prompt("Rename chat:", chat.title);
    if (newTitle && newTitle.trim()) {
      await fetch(`${API_BASE}/chats/${chat.id}/rename`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ title: newTitle.trim() }),
      });
    }
    menu.remove();
    loadChats();
  });

  const deleteItem = document.createElement("div");
  deleteItem.className = "chat-context-item danger";
  deleteItem.textContent = "Delete";
  deleteItem.addEventListener("click", async (e) => {
    e.stopPropagation();
    const confirmed = confirm(`Delete "${chat.title}"? This can't be undone.`);
    if (confirmed) {
      await fetch(`${API_BASE}/chats/${chat.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (currentChatId === chat.id) currentChatId = null;
    }
    menu.remove();
    loadChats();
  });

  menu.appendChild(pinItem);
  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);

  // Append to <body> (not inside the scrollable chat-list) and position it
  // using the clicked item's actual on-screen coordinates, so the sidebar's
  // overflow:auto scroll area can't clip it.
  document.body.appendChild(menu);
  const rect = chatEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right - 130}px`; // align right edge to the item

  setTimeout(() => {
    document.addEventListener("click", function closeMenu() {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    });
  }, 0);
}

async function createNewChat() {
  const res = await fetch(`${API_BASE}/chats`, {
    method: "POST",
    headers: authHeaders(),
  });
  const { chat } = await res.json();
  currentChatId = chat.id;
  currentChatTitle.textContent = chat.title;
  messageListEl.innerHTML = `<div class="empty-state"><p>Describe an image, and it'll appear here.</p></div>`;
  loadChats();
}

newChatBtn.addEventListener("click", createNewChat);

async function openChat(chatId, title) {
  currentChatId = chatId;
  currentChatTitle.textContent = title;
  loadChats();

  const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
    headers: authHeaders(),
  });
  const { messages } = await res.json();

  messageListEl.innerHTML = "";
  if (messages.length === 0) {
    messageListEl.innerHTML = `<div class="empty-state"><p>Describe an image, and it'll appear here.</p></div>`;
  }
  messages.forEach(renderMessage);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function renderMessage(msg) {
  const wrapper = document.createElement("div");
  wrapper.className = `message-wrapper ${msg.role}`;
  wrapper.dataset.messageId = msg.id;

  const el = document.createElement("div");
  el.className = `message ${msg.role}`;

  if (msg.role === "assistant") {
    el.innerHTML = formatAssistantText(msg.content || "");
  } else {
    el.textContent = msg.content;
  }

  if (msg.image_path) {
    const img = document.createElement("img");
    img.src = msg.image_path.startsWith("http")
      ? msg.image_path
      : `http://localhost:4000${msg.image_path}`;
    el.appendChild(img);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "message-delete-btn";
  deleteBtn.title = "Delete this message";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", () => deleteMessage(msg.id, wrapper));

  wrapper.appendChild(el);
  wrapper.appendChild(deleteBtn);
  messageListEl.appendChild(wrapper);
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

async function deleteMessage(messageId, wrapperEl) {
  const confirmed = confirm("Delete this message? This can't be undone.");
  if (!confirmed) return;

  const res = await fetch(`${API_BASE}/messages/${messageId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });

  if (res.ok) {
    wrapperEl.remove();
  } else {
    uploadStatus.textContent = "Failed to delete message.";
  }
}

function formatAssistantText(text) {
  if (!text) return "";

  const cleaned = text
    .replace(/^#{1,6}\s*/gm, "")     // strip leading #, ##, ### etc.
    .replace(/\*\*(.*?)\*\*/g, "$1") // strip bold markers, keep the text
    .replace(/^-{3,}$/gm, "");       // strip standalone --- divider lines

  const lines = cleaned.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  let html = "";
  let bulletBuffer = [];

  function flushBullets() {
    if (bulletBuffer.length > 0) {
      html += "<ul>" + bulletBuffer.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
      bulletBuffer = [];
    }
  }

  lines.forEach((line) => {
    const bulletMatch = line.match(/^[-*•]\s+(.*)/);
    if (bulletMatch) {
      bulletBuffer.push(bulletMatch[1]);
    } else {
      flushBullets();
      html += `<p>${escapeHtml(line)}</p>`;
    }
  });
  flushBullets();

  return html;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Sending messages / image generation / chat
// ---------------------------------------------------------------------------

async function sendMessage() {
  const text = promptInput.value.trim();
  if (!currentChatId) return;
  if (!text && !pendingAttachment) return;

  const mode = document.getElementById("mode-select").value;
  const attachment = pendingAttachment;

  promptInput.value = "";
  pendingAttachment = null;
  attachmentChip.classList.add("hidden");

  const displayText = attachment
    ? (text ? `${text} [attached: ${attachment.name}]` : `[attached: ${attachment.name}]`)
    : text;

  const userMsgRes = await fetch(`${API_BASE}/chats/${currentChatId}/messages`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ role: "user", content: displayText }),
  });
  const { message: userMsg } = await userMsgRes.json();
  renderMessage(userMsg);

  if (attachment) {
    await sendAnalyzeRequest(attachment, text);
    return;
  }

  const endpoint = mode === "image" ? "/generate" : "/chat";
  const genRes = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt: text, chatId: currentChatId }),
  });
  const { message: assistantMsg } = await genRes.json();
  renderMessage(assistantMsg);

  loadChats();
}

async function sendAnalyzeRequest(file, instruction) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("chatId", currentChatId);
  formData.append("instruction", instruction || "");

  const res = await fetch(`${API_BASE}/analyze`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });

  if (res.ok) {
    const { message } = await res.json();
    renderMessage(message);
    loadChats();
    return;
  }

  const data = await res.json();

  if (data.code === "ELEVATION_REQUIRED") {
    pendingUploadFile = file;
    pendingAction = "analyze";
    elevateReason.textContent = data.error;
    elevateModal.classList.remove("hidden");
    elevatePasswordInput.focus();
  } else {
    uploadStatus.textContent = data.error || "File analysis failed.";
  }
}

// ---------------------------------------------------------------------------
// File uploads (with the elevation flow for code files)
// ---------------------------------------------------------------------------

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  pendingAttachment = file;
  attachmentName.textContent = file.name;
  attachmentChip.classList.remove("hidden");
  fileInput.value = "";
});

removeAttachmentBtn.addEventListener("click", () => {
  pendingAttachment = null;
  attachmentChip.classList.add("hidden");
});

elevateCancelBtn.addEventListener("click", () => {
  elevateModal.classList.add("hidden");
  elevatePasswordInput.value = "";
  elevateError.textContent = "";
  pendingUploadFile = null;
  uploadStatus.textContent = "Upload cancelled.";
});

elevateConfirmBtn.addEventListener("click", async () => {
  elevateError.textContent = "";
  const password = elevatePasswordInput.value;

  const elevateRes = await fetch(`${API_BASE}/auth/elevate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ password }),
  });
  const elevateData = await elevateRes.json();

  if (!elevateRes.ok) {
    elevateError.textContent = elevateData.error || "Incorrect password.";
    return;
  }

  elevatedToken = elevateData.token;

  const formData = new FormData();
  formData.append("file", pendingUploadFile);

  const endpoint = pendingAction === "analyze" ? "/analyze/elevated" : "/upload/elevated";
  if (pendingAction === "analyze") {
    formData.append("chatId", currentChatId);
    formData.append("instruction", "");
  }

  const uploadRes = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${elevatedToken}` },
    body: formData,
  });

  if (uploadRes.ok) {
    if (pendingAction === "analyze") {
      const { message } = await uploadRes.json();
      renderMessage(message);
      loadChats();
    } else {
      uploadStatus.textContent = `${pendingUploadFile.name} uploaded (verified).`;
    }
    elevateModal.classList.add("hidden");
    elevatePasswordInput.value = "";
    pendingUploadFile = null;
    pendingAction = null;
  } else {
    const data = await uploadRes.json();
    elevateError.textContent = data.error || "Action failed.";
  }
});

// ---------------------------------------------------------------------------
// Presence monitoring (optional, toggled after login)
// ---------------------------------------------------------------------------

monitorToggleBtn.addEventListener("click", () => {
  if (isMonitoring) {
    stopMonitoring();
  } else {
    startMonitoring();
  }
});

async function startMonitoring() {
  try {
    monitorStream = await navigator.mediaDevices.getUserMedia({ video: true });
    monitorFeed.srcObject = monitorStream;
    isMonitoring = true;
    monitorToggleBtn.textContent = "Stop monitoring";
    monitorInterval = setInterval(checkPresence, 5000);
  } catch (err) {
    uploadStatus.textContent = "Camera unavailable for monitoring.";
  }
}

function stopMonitoring() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
  if (awayTimer) clearTimeout(awayTimer);
  awayTimer = null;
  if (monitorStream) monitorStream.getTracks().forEach((t) => t.stop());
  monitorStream = null;
  isMonitoring = false;
  monitorToggleBtn.textContent = "Start monitoring";
}

async function checkPresence() {
  if (!sessionToken) return;

  const detection = await faceapi
    .detectSingleFace(monitorFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    if (!awayTimer) {
      awayTimer = setTimeout(() => {
        stopMonitoring();
        lockAppBtn.click();
      }, 50000);
    }
    return;
  }

  if (awayTimer) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }

  const embedding = Array.from(detection.descriptor);

  const res = await fetch(`${API_BASE}/auth/verify-face`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ embedding }),
  });

  if (!res.ok) return;

  const data = await res.json();

  if (!data.isMatch) {
    stopMonitoring();
    lockAppBtn.click();
  }
}

// ---------------------------------------------------------------------------
// Voice input (Web Speech API — built into the browser, no key needed)
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function createRecognizer() {
  if (!SpeechRecognition) return null;
  const recognizer = new SpeechRecognition();
  recognizer.lang = "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = true;
  return recognizer;
}

// --- Voice for prompts ---
promptMicBtn.addEventListener("click", () => {
  if (promptListening) {
    promptListening = false;
    promptRecognizer.stop();
    return;
  }

  promptRecognizer = createRecognizer();
  if (!promptRecognizer) {
    uploadStatus.textContent = "Voice input isn't supported in this browser. Try Chrome or Edge.";
    return;
  }

  let finalText = "";

  promptListening = true;
  promptMicBtn.classList.add("listening");
  promptMicBtn.textContent = "⏹";

  promptRecognizer.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript + " ";
      } else {
        interim += transcript;
      }
    }
    promptInput.value = (finalText + interim).trim();
  };

  promptRecognizer.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    uploadStatus.textContent = `Voice error: ${event.error}`;
  };

  promptRecognizer.onend = () => {
    if (promptListening) {
      promptRecognizer.start();
    } else {
      promptMicBtn.classList.remove("listening");
      promptMicBtn.textContent = "🎤";
    }
  };

  promptRecognizer.start();
});

// --- Voice for password ---
passwordMicBtn.addEventListener("click", () => {
  if (passwordListening) {
    passwordListening = false;
    passwordRecognizer.stop();
    return;
  }

  passwordRecognizer = createRecognizer();
  if (!passwordRecognizer) {
    passwordError.textContent = "Voice input isn't supported in this browser. Try Chrome or Edge.";
    return;
  }

  let finalText = "";

  passwordListening = true;
  passwordMicBtn.classList.add("listening");
  passwordMicBtn.textContent = "⏹";
  passwordInput.type = "text";

  passwordRecognizer.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    passwordInput.value = (finalText + interim).replace(/\s+/g, "");
  };

  passwordRecognizer.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    passwordError.textContent = `Voice error: ${event.error}`;
  };

  passwordRecognizer.onend = () => {
    if (passwordListening) {
      passwordRecognizer.start();
    } else {
      passwordMicBtn.classList.remove("listening");
      passwordMicBtn.textContent = "🎤";
      passwordInput.focus();
    }
  };

  passwordRecognizer.start();
});

// ---------------------------------------------------------------------------
// Chat search
// ---------------------------------------------------------------------------

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  const query = searchInput.value.trim();

  if (!query) {
    searchResultsEl.classList.add("hidden");
    chatListEl.classList.remove("hidden");
    return;
  }

  searchDebounceTimer = setTimeout(() => runSearch(query), 300);
});

async function runSearch(query) {
  const res = await fetch(`${API_BASE}/chats/search?q=${encodeURIComponent(query)}`, {
    headers: authHeaders(),
  });
  const { results } = await res.json();

  chatListEl.classList.add("hidden");
  searchResultsEl.classList.remove("hidden");
  searchResultsEl.innerHTML = "";

  if (results.length === 0) {
    searchResultsEl.innerHTML = `<p style="padding:8px 10px; font-size:13px; color:var(--paper-dim);">No matches found.</p>`;
    return;
  }

  results.forEach((r) => {
    const el = document.createElement("div");
    el.className = "search-result-item";

    const highlighted = r.snippet.replace(
      new RegExp(`(${escapeRegex(query)})`, "ig"),
      "<mark>$1</mark>"
    );

    el.innerHTML = `
      <div class="search-result-title">${escapeHtml(r.chatTitle)}</div>
      <div class="search-result-snippet">${highlighted}</div>
    `;

    el.addEventListener("click", () => {
      searchInput.value = "";
      searchResultsEl.classList.add("hidden");
      chatListEl.classList.remove("hidden");
      openChat(r.chatId, r.chatTitle);
    });

    searchResultsEl.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// Final wiring
// ---------------------------------------------------------------------------

sendBtn.addEventListener("click", sendMessage);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

init();