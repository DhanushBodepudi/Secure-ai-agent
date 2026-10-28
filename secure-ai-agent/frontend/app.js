// app.js
// Frontend logic: camera capture + face embedding (via face-api.js, entirely
// client-side), liveness check, talking to the backend for the real auth
// decision, chat management, uploads with elevation, voice input, search,
// presence monitoring, and chat sharing.

const API_BASE = "https://aperture-backend-s79c.onrender.com/api";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let sessionToken = null;
let elevatedToken = null;
let currentChatId = null;
let pendingUploadFile = null;
let pendingAttachment = null;
let pendingAction = null;
let monitorStream = null;
let monitorInterval = null;
let isMonitoring = false;
let awayTimer = null;
let searchDebounceTimer = null;
let promptRecognizer = null;
let promptListening = false;
let passwordRecognizer = null;
let passwordListening = false;
let faceScanTimeout = null;
let addFaceStream = null;

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const securityLogBtn = document.getElementById("security-log-btn");
const securityLogModal = document.getElementById("security-log-modal");
const securityLogList = document.getElementById("security-log-list");
const securityLogCloseBtn = document.getElementById("security-log-close-btn");
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

const addFaceBtn = document.getElementById("add-face-btn");
const addFaceModal = document.getElementById("add-face-modal");
const addFaceFeed = document.getElementById("add-face-feed");
const addFaceError = document.getElementById("add-face-error");
const addFaceCancelBtn = document.getElementById("add-face-cancel-btn");
const addFaceCaptureBtn = document.getElementById("add-face-capture-btn");

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

async function startCameraAndAttemptFaceLogin() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraFeed.srcObject = stream;
    setTimeout(attemptFaceLogin, 1200);

    // If no face has been successfully matched within 8 seconds total,
    // show the unauthorized message and fall back to password.
    faceScanTimeout = setTimeout(() => {
      if (!sessionToken) {
        showUnauthorizedMessage();
      }
    }, 8000);
  } catch (err) {
    lockStatus.textContent = "Camera unavailable — use your password.";
    showPasswordForm();
  }
}

function showUnauthorizedMessage() {
  lockStatus.innerHTML = `<span class="unauthorized-text">You are not an authorized user</span>`;
  showPasswordForm();
}

// ---------------------------------------------------------------------------
// Liveness check (random head-turn challenge)
// ---------------------------------------------------------------------------

const TURN_CHECK_DURATION_MS = 6000;
const TURN_THRESHOLD = 0.12;

function getNoseOffset(landmarks) {
  const nose = landmarks.getNose();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();

  const noseTip = nose[3];
  const eyeMidX = (leftEye[0].x + rightEye[3].x) / 2;
  const faceWidth = Math.abs(rightEye[3].x - leftEye[0].x);

  if (faceWidth === 0) return 0;
  return (noseTip.x - eyeMidX) / faceWidth;
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

async function attemptFaceLogin() {
  const detection = await faceapi
    .detectSingleFace(cameraFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    lockStatus.textContent = "No face detected — try again or use your password.";
    return;
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
    if (faceScanTimeout) clearTimeout(faceScanTimeout);
    sessionToken = data.token;
    lockStatus.textContent = "Welcome back.";
    setTimeout(enterApp, 400);
  }   else {
    if (faceScanTimeout) clearTimeout(faceScanTimeout);
    captureFrameUnauth(cameraFeed); // save evidence before showing the password fallback
    lockStatus.textContent = data.error || "You are an unauthorized user.";
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
// Add another enrolled face (while already logged in)
// ---------------------------------------------------------------------------

addFaceBtn.addEventListener("click", async () => {
  addFaceError.textContent = "";
  addFaceModal.classList.remove("hidden");
  try {
    addFaceStream = await navigator.mediaDevices.getUserMedia({ video: true });
    addFaceFeed.srcObject = addFaceStream;
  } catch (err) {
    addFaceError.textContent = "Camera unavailable.";
  }
});

function closeAddFaceModal() {
  if (addFaceStream) addFaceStream.getTracks().forEach((t) => t.stop());
  addFaceStream = null;
  addFaceModal.classList.add("hidden");
}

addFaceCancelBtn.addEventListener("click", closeAddFaceModal);

addFaceCaptureBtn.addEventListener("click", async () => {
  addFaceError.textContent = "";

  const detection = await faceapi
    .detectSingleFace(addFaceFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    addFaceError.textContent = "No face detected. Try again with better lighting.";
    return;
  }

  const embedding = Array.from(detection.descriptor);

  const res = await fetch(`${API_BASE}/auth/enroll-face`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ embedding }),
  });

  if (res.ok) {
    uploadStatus.textContent = "New face added — they can now log in too.";
    closeAddFaceModal();
  } else {
    const data = await res.json();
    addFaceError.textContent = data.error || "Could not save face.";
  }
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

  const shareItem = document.createElement("div");
  shareItem.className = "chat-context-item";
  shareItem.textContent = "Share";
shareItem.addEventListener("click", async (e) => {
  e.stopPropagation();
  const res = await fetch(`${API_BASE}/chats/${chat.id}/share`, {
    method: "POST",
    headers: authHeaders(),
  });
  const { shareToken } = await res.json();
  const shareUrl = `${window.location.origin}/shared?token=${shareToken}`;

  await navigator.clipboard.writeText(shareUrl);
  uploadStatus.textContent = "Share link copied. Anything that looked like a password, email, or key has been automatically masked in the shared version.";
  menu.remove();
});

  menu.appendChild(pinItem);
  menu.appendChild(shareItem);
  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  const rect = chatEl.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right - 130}px`;

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
   const emptyState = messageListEl.querySelector(".empty-state");
  if (emptyState) emptyState.remove();
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
    const fullUrl = msg.image_path.startsWith("http")
      ? msg.image_path
      : `http://localhost:4000${msg.image_path}`;

    if (/\.(png|jpe?g|webp|gif)$/i.test(msg.image_path)) {
      const img = document.createElement("img");
      img.src = fullUrl;
      el.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.href = fullUrl;
      link.className = "file-download";
      link.textContent = "⬇ Download " + decodeURIComponent(msg.image_path.split("/").pop());
      el.appendChild(link);
    }
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
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^-{3,}$/gm, "");

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

  const endpoints = {
    image: "/generate",
    chat: "/chat",
    pdf: "/create/pdf",
    ppt: "/create/ppt",
    code: "/create/code",
    zip: "/create/zip",
  };
  const endpoint = endpoints[mode] || "/chat";

  if (["pdf", "ppt", "code", "zip"].includes(mode)) {
    uploadStatus.textContent = `Creating your ${mode.toUpperCase()}… this can take 10–30 seconds.`;
  }

  const genRes = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt: text, chatId: currentChatId }),
  });
  const genData = await genRes.json();

  if (!genRes.ok || !genData.message) {
    uploadStatus.textContent = genData.error || "Something went wrong. Please try again.";
    return;
  }

  uploadStatus.textContent = "";
  renderMessage(genData.message);
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
// Captures the current frame from a given video element as a base64 image
// and sends it to the backend to be saved as evidence.
function captureAndSaveFrame(videoEl) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 320;
    canvas.height = videoEl.videoHeight || 240;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/png");

    fetch(`${API_BASE}/security/capture`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ imageData }),
    });
  } catch (err) {
    console.error("Failed to capture frame:", err);
  }
}
function captureFrameUnauth(videoEl) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 320;
    canvas.height = videoEl.videoHeight || 240;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/png");

    fetch(`${API_BASE}/security/capture-unauth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageData }),
    });
  } catch (err) {
    console.error("Failed to capture frame:", err);
  }
}
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
    startShoulderSurfDetection(); // add this line
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
  stopShoulderSurfDetection(); // add this line
}

async function checkPresence() {
  if (!sessionToken) return;

  const detection = await faceapi
    .detectSingleFace(monitorFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) {
    if (!awayTimer) {
      awayTimer = setTimeout(async () => {
        // Lock the OS first, while the session token is still valid.
        await fetch(`${API_BASE}/lock-system`, {
          method: "POST",
          headers: authHeaders(),
        });
        stopMonitoring();
        lockAppBtn.click();
      }, 10000);
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
    // A different face is in frame — capture evidence, then lock immediately.
    captureAndSaveFrame(monitorFeed);
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
// Shoulder-surfing detection — a lightweight, browser-based approximation:
// detects multiple faces, assumes the largest is the primary user, and flags
// any other face whose head is oriented toward the screen for a sustained
// number of frames.
// ---------------------------------------------------------------------------

let shoulderSurfInterval = null;
let shoulderSurfActive = false;
let lookingStreak = 0;
const LOOKING_STREAK_THRESHOLD = 4; // consecutive detections before alerting (~2 seconds at 500ms interval)
const OBSERVER_CENTER_THRESHOLD = 0.15; // how centered an observer's nose must be to count as "looking"

function startShoulderSurfDetection() {
  if (shoulderSurfActive) return;
  shoulderSurfActive = true;
  lookingStreak = 0;
  shoulderSurfInterval = setInterval(checkForShoulderSurfing, 500);
}

function stopShoulderSurfDetection() {
  shoulderSurfActive = false;
  if (shoulderSurfInterval) clearInterval(shoulderSurfInterval);
  shoulderSurfInterval = null;
  lookingStreak = 0;
  clearShoulderSurfAlert();
}

async function checkForShoulderSurfing() {
  if (!monitorFeed.srcObject) return; // only runs while presence-monitoring camera is active

  const detections = await faceapi
    .detectAllFaces(monitorFeed, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks();

  if (detections.length < 2) {
    lookingStreak = 0;
    clearShoulderSurfAlert();
    return; // only you (or nobody) in frame — no observer present
  }

  // Assume the largest detected face (by box area) is the primary user.
  let userIndex = 0;
  let largestArea = 0;
  detections.forEach((d, i) => {
    const area = d.detection.box.width * d.detection.box.height;
    if (area > largestArea) {
      largestArea = area;
      userIndex = i;
    }
  });

  const observers = detections.filter((_, i) => i !== userIndex);

  const anyObserverLooking = observers.some((obs) => {
    const offset = Math.abs(getNoseOffset(obs.landmarks));
    return offset < OBSERVER_CENTER_THRESHOLD; // roughly facing the camera = facing the screen
  });

  if (anyObserverLooking) {
    lookingStreak++;
    if (lookingStreak >= LOOKING_STREAK_THRESHOLD) {
      showShoulderSurfAlert();
    }
  } else {
    lookingStreak = 0;
    clearShoulderSurfAlert();
  }
}

function showShoulderSurfAlert() {
  document.body.classList.add("shoulder-surf-blur");
  let banner = document.getElementById("shoulder-surf-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "shoulder-surf-banner";
    banner.className = "shoulder-surf-banner";
    banner.textContent = "⚠ Possible shoulder surfing detected — someone may be viewing your screen";
    document.body.appendChild(banner);
  }
}

function clearShoulderSurfAlert() {
  document.body.classList.remove("shoulder-surf-blur");
  const banner = document.getElementById("shoulder-surf-banner");
  if (banner) banner.remove();
}
// ---------------------------------------------------------------------------
// Security activity viewer
// ---------------------------------------------------------------------------

securityLogBtn.addEventListener("click", async () => {
  securityLogModal.classList.remove("hidden");
  securityLogList.innerHTML = "<p style='color:var(--paper-dim)'>Loading…</p>";

  const res = await fetch(`${API_BASE}/security/captures`, { headers: authHeaders() });
  const { captures } = await res.json();

  securityLogList.innerHTML = "";

  if (captures.length === 0) {
    securityLogList.innerHTML = "<p style='color:var(--paper-dim)'>No security events recorded yet.</p>";
    return;
  }

  captures.forEach((cap) => {
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.gap = "12px";
    item.style.alignItems = "center";
    item.style.padding = "8px";
    item.style.background = "var(--ink-800)";
    item.style.borderRadius = "8px";

    const img = document.createElement("img");
    img.src = `http://localhost:4000/security-captures/${cap.filename}`;
    img.style.width = "70px";
    img.style.height = "70px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "6px";

    const info = document.createElement("div");
    const reasonLabel = cap.reason === "failed_login" ? "Failed login attempt" : "Monitoring mismatch";
    info.innerHTML = `<div style="font-weight:600; font-size:13.5px;">${reasonLabel}</div>
                       <div style="font-size:12px; color:var(--paper-dim);">${new Date(cap.created_at).toLocaleString()}</div>`;

    item.appendChild(img);
    item.appendChild(info);
    securityLogList.appendChild(item);
  });
});

securityLogCloseBtn.addEventListener("click", () => {
  securityLogModal.classList.add("hidden");
});
// ---------------------------------------------------------------------------
// Quick-launch (fixed app buttons — no free text ever reaches the backend)
// ---------------------------------------------------------------------------

document.querySelectorAll(".launch-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const appName = btn.dataset.app;
    const res = await fetch(`${API_BASE}/launch/${appName}`, {
      method: "POST",
      headers: authHeaders(),
    });

    if (res.ok) {
      uploadStatus.textContent = `Opened ${appName}.`;
    } else {
      const data = await res.json();
      uploadStatus.textContent = data.error || `Could not open ${appName}.`;
    }
  });
});

// ---------------------------------------------------------------------------
// Final wiring
// ---------------------------------------------------------------------------

sendBtn.addEventListener("click", sendMessage);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

