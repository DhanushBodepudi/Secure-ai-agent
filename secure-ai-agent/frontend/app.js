// app.js — Aperture frontend (multi-user)
//
// Everything runs on one address, so the API is simply "/api". The login token
// lives only in memory: reloading the page locks the app again, by design.
// splash.js calls init() when the opening screen is clicked.

"use strict";

const IS_LOCAL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" || !window.location.hostname;
const BACKEND_BASE = IS_LOCAL
  ? (window.location.port === "4000" ? "" : "http://localhost:4000")
  : (window.location.hostname.includes("apeture.shop")
      ? "https://aperture-backend-s79c.onrender.com"
      : "");
const API = `${BACKEND_BASE}/api`;
const toAssetUrl = (url) => (!url ? "" : url.startsWith("http") ? url : `${BACKEND_BASE}${url.startsWith("/") ? "" : "/"}${url}`);

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The server stores times in UTC without a "Z"; add it so they show in local time.
const utcDate = (s) => new Date(String(s).replace(" ", "T") + "Z");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionToken = null;
let currentUser = null;
let appConfig = { registrationOpen: true, localControls: false };
let currentChatId = null;
let chatsCache = [];
let pendingAttachment = null;
let sendInFlight = false;
let lastActivity = Date.now();
let refreshTimer = null;
let expiring = false;

// Remembers who last signed in on THIS browser (name, email, whether face login is on).
// It holds no password and no token; it only decides which sign-in screen to start on.
const LAST_KEY = "aperture.lastUser";
function getLastUser() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY));
  } catch (e) {
    return null;
  }
}
function setLastUser(user) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ email: user.email, name: user.name, face: !!user.faceEnabled }));
  } catch (e) {
    /* storage blocked: fine */
  }
}
function clearLastUser() {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Element references
// ---------------------------------------------------------------------------

const lockScreen = $("lock-screen");
const appShell = $("app-shell");
const lockStatus = $("lock-status");
const faceView = $("face-view");
const faceWelcome = $("face-welcome");
const cameraFeed = $("camera-feed");
const signinForm = $("signin-form");
const signinEmail = $("signin-email");
const signinPassword = $("signin-password");
const signinError = $("signin-error");
const registerForm = $("register-form");
const registerError = $("register-error");
const forgotForm = $("forgot-form");
const forgotEmail = $("forgot-email");
const forgotError = $("forgot-error");
const forgotInfo = $("forgot-info");
const forgotSuccess = $("forgot-success");
const forgotResetSection = $("forgot-reset-section");
const forgotFaceOption = $("forgot-face-option");
let forgotResetToken = null;

const newChatBtn = $("new-chat-btn");
const chatListEl = $("chat-list");
const searchInput = $("search-input");
const searchResultsEl = $("search-results");
const sidebarUser = $("sidebar-user");
const currentChatTitle = $("current-chat-title");
const messageListEl = $("message-list");
const attachmentChip = $("attachment-chip");
const attachmentName = $("attachment-name");
const modeSelect = $("mode-select");
const fileInput = $("file-input");
const promptInput = $("prompt-input");
const sendBtn = $("send-btn");
const uploadStatus = $("upload-status");
const monitorFeed = $("monitor-feed");
const monitorToggleBtn = $("monitor-toggle-btn");

const setStatus = (text) => {
  uploadStatus.textContent = text || "";
};

const EMPTY_STATE_HTML = `<div class="empty-state"><p>Describe an image, and it'll appear here.</p></div>`;

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  const { auth = true, json, token, noLock, ...rest } = options;
  const headers = { ...(rest.headers || {}) };
  const useToken = token || (auth ? sessionToken : null);
  if (useToken) headers.Authorization = `Bearer ${useToken}`;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    rest.body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(API + path, { ...rest, headers });
  } catch (err) {
    throw new Error("Can't reach the server. Check your connection.");
  }
  // A 401 on a signed-in call means the session ran out or was ended elsewhere.
  if (res.status === 401 && auth && sessionToken && !noLock) handleSessionExpired();
  return res;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch (e) {
    return {};
  }
}

function handleSessionExpired() {
  if (expiring || !sessionToken) return;
  expiring = true;
  lockApp("Your session expired. Please sign in again.");
  setTimeout(() => (expiring = false), 500);
}

// ---------------------------------------------------------------------------
// Face recognition helpers (face-api.js runs in the browser; only numbers are sent)
// ---------------------------------------------------------------------------

let faceModelsPromise = null;
function ensureFaceModels() {
  if (typeof faceapi === "undefined") return Promise.reject(new Error("Face recognition library not loaded."));
  if (!faceModelsPromise) {
    const URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
    faceModelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(URL),
    ]).catch((err) => {
      faceModelsPromise = null; // allow a retry
      throw err;
    });
  }
  return faceModelsPromise;
}

const detectorOptions = () => new faceapi.TinyFaceDetectorOptions();

async function detectFull(video) {
  try {
    return (await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor()) || null;
  } catch (e) {
    return null;
  }
}

async function detectLandmarksOnly(video) {
  try {
    return (await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks()) || null;
  } catch (e) {
    return null;
  }
}

// Waits up to `ms` for any face to appear in the camera view.
async function waitForFace(video, ms, cancelled) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cancelled()) return false;
    try {
      if (await faceapi.detectSingleFace(video, detectorOptions())) return true;
    } catch (e) {
      /* keep trying */
    }
    await sleep(400);
  }
  return false;
}

// --- Liveness: a randomly chosen head turn. A still photo can't do it, and a
// pre-recorded video is unlikely to turn the way we happen to ask. ---

const TURN_CHECK_DURATION_MS = 6000;
const TURN_THRESHOLD = 0.12;

function getNoseOffset(landmarks) {
  const nose = landmarks.getNose();
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const faceWidth = Math.abs(rightEye[3].x - leftEye[0].x);
  if (faceWidth === 0) return 0;
  const eyeMidX = (leftEye[0].x + rightEye[3].x) / 2;
  return (nose[3].x - eyeMidX) / faceWidth;
}

async function waitForHeadTurn(video, direction, cancelled) {
  const end = Date.now() + TURN_CHECK_DURATION_MS;
  while (Date.now() < end) {
    if (cancelled()) return false;
    const detection = await detectLandmarksOnly(video);
    if (detection) {
      // The camera view is mirrored, so a viewer's "left" is a positive offset.
      const offset = getNoseOffset(detection.landmarks);
      if (direction === "left" && offset > TURN_THRESHOLD) return true;
      if (direction === "right" && offset < -TURN_THRESHOLD) return true;
    }
    await sleep(150);
  }
  return false;
}

const pickRandomDirection = () => (Math.random() < 0.5 ? "left" : "right");

// --- Camera photo of whoever is in front of the camera (evidence) ---

function frameToDataUrl(video) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 240;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sign-in screen
// ---------------------------------------------------------------------------

let cameraStream = null;
let faceFlowId = 0; // bumping this cancels any face sign-in that is still running
const faceCancelled = (id) => id !== faceFlowId;

function stopCamera() {
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraFeed.srcObject = null;
}

function showView(name) {
  faceView.classList.toggle("hidden", name !== "face");
  signinForm.classList.toggle("hidden", name !== "signin");
  registerForm.classList.toggle("hidden", name !== "register");
  if (forgotForm) forgotForm.classList.toggle("hidden", name !== "forgot");
}

function setStatusText(text) {
  lockStatus.textContent = text;
}

function showSignin(message) {
  signinError.textContent = "";
  setStatusText(message || "Sign in to continue");
  showView("signin");
  (signinEmail.value ? signinPassword : signinEmail).focus();
}

function showForgot(message) {
  forgotResetToken = null;
  if (forgotResetSection) hide(forgotResetSection);
  if (forgotFaceOption) hide(forgotFaceOption);
  if (forgotInfo) hide(forgotInfo);
  if (forgotSuccess) hide(forgotSuccess);
  if (forgotError) forgotError.textContent = "";
  if ($("forgot-code")) $("forgot-code").value = "";
  if ($("forgot-new-password")) $("forgot-new-password").value = "";
  if ($("forgot-confirm-password")) $("forgot-confirm-password").value = "";
  if (forgotEmail) {
    forgotEmail.value = signinEmail.value.trim() || $("register-email").value.trim() || "";
  }
  setStatusText(message || "Reset your password");
  showView("forgot");
  if (forgotEmail) forgotEmail.focus();
}

function showRegister() {
  registerError.textContent = "";
  setStatusText("Create your account");
  showView("register");
  $("register-name").focus();
}

function showUnauthorized() {
  lockStatus.textContent = "";
  const span = document.createElement("span");
  span.className = "unauthorized-text";
  span.textContent = "You are not an authorized user";
  lockStatus.appendChild(span);
}

function applyConfigToAuth() {
  $("to-register-row").classList.toggle("hidden", !appConfig.registrationOpen);
}

// Called by splash.js once the opening screen is clicked (and by Lock / Sign out).
async function init() {
  try {
    const res = await fetch(API + "/config");
    if (res.ok) appConfig = await res.json();
  } catch (e) {
    /* the sign-in screen still works with defaults */
  }
  beginAuth();
}

function beginAuth(message) {
  faceFlowId++;
  stopCamera();
  applyConfigToAuth();
  const last = getLastUser();
  if (last && last.email) signinEmail.value = last.email;
  if (last && last.email && last.face) startFaceFlow(last);
  else showSignin(message);
}

async function startFaceFlow(last) {
  const flow = ++faceFlowId;
  const cancelled = () => faceCancelled(flow);

  const fallback = (message) => {
    if (cancelled()) return;
    faceFlowId++;
    stopCamera();
    showSignin(message);
  };

  faceWelcome.textContent = last.name ? `Welcome back, ${last.name.split(" ")[0]}` : "Welcome back";
  setStatusText("Looking for a familiar face…");
  showView("face");

  try {
    await ensureFaceModels();
    if (cancelled()) return;
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    return fallback("Face login isn't available right now. Please sign in with your password.");
  }
  if (cancelled()) return stopCamera();
  cameraFeed.srcObject = cameraStream;
  await sleep(1200); // let the camera adjust

  // 1. Is there a face at all? If not within 8 seconds, treat it as unauthorized.
  const found = await waitForFace(cameraFeed, 8000, cancelled);
  if (cancelled()) return;
  if (!found) {
    faceFlowId++;
    stopCamera();
    showSignin();
    showUnauthorized();
    return;
  }

  // 2. Liveness check.
  const direction = pickRandomDirection();
  setStatusText(`Please turn your head ${direction} to verify it's really you…`);
  const turned = await waitForHeadTurn(cameraFeed, direction, cancelled);
  if (cancelled()) return;
  if (!turned) return fallback(`No ${direction} turn detected. Please sign in with your password.`);

  // 3. Fresh reading, then ask the server (it compares only with THIS account's face).
  setStatusText("Verifying…");
  const fresh = await detectFull(cameraFeed);
  if (cancelled()) return;
  if (!fresh) return fallback("Lost track of your face. Please sign in with your password.");

  let res;
  try {
    res = await apiFetch("/auth/face-login", {
      auth: false,
      method: "POST",
      json: { email: last.email, embedding: Array.from(fresh.descriptor) },
    });
  } catch (err) {
    return fallback(err.message);
  }
  const data = await readJson(res);
  if (cancelled()) return;

  if (res.ok && data.token) {
    sessionToken = data.token;
    faceFlowId++;
    stopCamera();
    return enterApp(data.user);
  }

  // Not recognised: keep a photo as evidence (the one-time token proves this was a real attempt).
  if (data.captureToken) {
    const imageData = frameToDataUrl(cameraFeed);
    if (imageData) {
      apiFetch("/security/capture-failed", { auth: false, method: "POST", json: { captureToken: data.captureToken, imageData } }).catch(() => {});
    }
  }
  faceFlowId++;
  stopCamera();
  showSignin();
  if (res.status === 429) signinError.textContent = data.error || "Too many attempts.";
  else showUnauthorized();
}

$("use-password-btn").addEventListener("click", () => {
  faceFlowId++;
  stopCamera();
  showSignin();
});

$("not-you-btn").addEventListener("click", () => {
  faceFlowId++;
  stopCamera();
  clearLastUser();
  signinEmail.value = "";
  showSignin();
});

$("to-register-btn").addEventListener("click", showRegister);
$("to-signin-btn").addEventListener("click", () => showSignin());
$("to-forgot-btn").addEventListener("click", () => showForgot());
$("to-signin-from-forgot-btn").addEventListener("click", () => showSignin());

signinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signinError.textContent = "";
  const email = signinEmail.value.trim();
  const password = signinPassword.value;
  if (!email || !password) {
    signinError.textContent = "Please enter your email and password.";
    return;
  }
  $("signin-submit").disabled = true;
  try {
    const res = await apiFetch("/auth/login", { auth: false, method: "POST", json: { email, password } });
    const data = await readJson(res);
    if (res.ok) {
      sessionToken = data.token;
      signinPassword.value = "";
      await enterApp(data.user);
    } else {
      signinError.textContent = data.error || "Couldn't sign in.";
    }
  } catch (err) {
    signinError.textContent = err.message;
  } finally {
    $("signin-submit").disabled = false;
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.textContent = "";
  const name = $("register-name").value.trim();
  const email = $("register-email").value.trim();
  const password = $("register-password").value;
  if (!name || !email) {
    registerError.textContent = "Please enter your name and email.";
    return;
  }
  if (password.length < 8) {
    registerError.textContent = "Your password must be at least 8 characters long.";
    return;
  }
  if (password !== $("register-confirm").value) {
    registerError.textContent = "The two passwords don't match.";
    return;
  }
  $("register-submit").disabled = true;
  try {
    const res = await apiFetch("/auth/register", { auth: false, method: "POST", json: { name, email, password } });
    const data = await readJson(res);
    if (res.ok) {
      sessionToken = data.token;
      ["register-name", "register-email", "register-password", "register-confirm"].forEach((id) => ($(id).value = ""));
      await enterApp(data.user, { welcome: true });
    } else {
      if (res.status === 409) {
        registerError.innerHTML = escapeHtml(data.error || "An account with that email already exists.") +
          ' <button type="button" class="link-btn" id="reg-to-forgot" style="display:inline; padding:0 2px;">Forgot password?</button>';
        const btn = $("reg-to-forgot");
        if (btn) btn.addEventListener("click", () => showForgot());
      } else {
        registerError.textContent = data.error || "Couldn't create the account.";
      }
    }
  } catch (err) {
    registerError.textContent = err.message;
  } finally {
    $("register-submit").disabled = false;
  }
});

$("forgot-send-code-btn").addEventListener("click", async () => {
  forgotError.textContent = "";
  hide(forgotInfo);
  hide(forgotSuccess);
  forgotResetToken = null;

  const email = forgotEmail.value.trim();
  if (!email) {
    forgotError.textContent = "Please enter your account email address.";
    return;
  }

  $("forgot-send-code-btn").disabled = true;
  $("forgot-send-code-btn").textContent = "Sending…";

  try {
    const res = await apiFetch("/auth/forgot-password/request", {
      auth: false,
      method: "POST",
      json: { email },
    });
    const data = await readJson(res);
    if (res.ok) {
      show(forgotResetSection);
      if (data.hasFace) {
        show(forgotFaceOption);
      } else {
        hide(forgotFaceOption);
      }
      forgotInfo.textContent = `Verification code sent! (Your code: ${data.code})`;
      show(forgotInfo);
      if ($("forgot-code")) {
        $("forgot-code").value = data.code;
        $("forgot-new-password").focus();
      }
    } else {
      forgotError.textContent = data.error || "Could not request password reset.";
    }
  } catch (err) {
    forgotError.textContent = err.message;
  } finally {
    $("forgot-send-code-btn").disabled = false;
    $("forgot-send-code-btn").textContent = "Get Verification Code";
  }
});

$("forgot-face-btn").addEventListener("click", async () => {
  const email = forgotEmail.value.trim();
  if (!email) return;

  forgotError.textContent = "";
  hide(forgotInfo);
  hide(forgotSuccess);

  setStatusText("Looking for your face…");
  showView("face");

  try {
    await ensureFaceModels();
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraFeed.srcObject = cameraStream;
    await sleep(1000);

    const fresh = await detectFull(cameraFeed);
    stopCamera();

    if (!fresh) {
      showForgot("Could not detect face clearly. Please use the verification code.");
      return;
    }

    setStatusText("Verifying face…");
    const res = await apiFetch("/auth/forgot-password/verify-face", {
      auth: false,
      method: "POST",
      json: { email, embedding: Array.from(fresh.descriptor) },
    });
    const data = await readJson(res);

    if (res.ok && data.resetToken) {
      forgotResetToken = data.resetToken;
      showForgot("Face verified successfully!");
      show(forgotResetSection);
      hide(forgotFaceOption);
      forgotSuccess.textContent = "Face verified! Enter your new password below.";
      show(forgotSuccess);
      $("forgot-new-password").focus();
    } else {
      showForgot(data.error || "Face verification failed. Please use verification code.");
    }
  } catch (err) {
    stopCamera();
    showForgot("Face verification error: " + err.message);
  }
});

forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotError.textContent = "";
  hide(forgotSuccess);

  const email = forgotEmail.value.trim();
  const code = $("forgot-code").value.trim();
  const newPassword = $("forgot-new-password").value;
  const confirmPassword = $("forgot-confirm-password").value;

  if (!email) {
    forgotError.textContent = "Please enter your email.";
    return;
  }
  if (!forgotResetToken && !code) {
    forgotError.textContent = "Please enter the 6-digit verification code.";
    return;
  }
  if (!newPassword || newPassword.length < 8) {
    forgotError.textContent = "Your new password must be at least 8 characters long.";
    return;
  }
  if (newPassword !== confirmPassword) {
    forgotError.textContent = "The two passwords don't match.";
    return;
  }

  $("forgot-submit-btn").disabled = true;

  try {
    let res;
    if (forgotResetToken) {
      res = await apiFetch("/auth/forgot-password/reset-with-token", {
        auth: false,
        method: "POST",
        json: { resetToken: forgotResetToken, newPassword },
      });
    } else {
      res = await apiFetch("/auth/forgot-password/reset", {
        auth: false,
        method: "POST",
        json: { email, code, newPassword },
      });
    }

    const data = await readJson(res);
    if (res.ok) {
      forgotSuccess.textContent = "Password reset successfully! Redirecting to sign in…";
      show(forgotSuccess);
      hide(forgotInfo);
      hide(forgotResetSection);
      signinEmail.value = email;
      setTimeout(() => {
        showSignin("Password updated. Sign in with your new password.");
      }, 1500);
    } else {
      forgotError.textContent = data.error || "Couldn't reset password.";
    }
  } catch (err) {
    forgotError.textContent = err.message;
  } finally {
    $("forgot-submit-btn").disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Entering, locking and leaving the app
// ---------------------------------------------------------------------------

function resetAppUI() {
  currentChatId = null;
  chatsCache = [];
  chatListEl.innerHTML = "";
  messageListEl.innerHTML = EMPTY_STATE_HTML;
  currentChatTitle.textContent = "New chat";
  searchInput.value = "";
  hide(searchResultsEl);
  show(chatListEl);
  searchResultsEl.innerHTML = "";
  clearAttachment();
  promptInput.value = "";
  sidebarUser.textContent = "";
  setStatus("");
  document.querySelectorAll(".chat-context-menu").forEach((m) => m.remove());
  ["pw-modal", "settings-modal", "face-setup-modal", "security-log-modal"].forEach((id) => hide($(id)));
  closeFaceSetupCamera();
  revokeSecurityImages();
  document.body.classList.remove("shoulder-surf-blur");
  const banner = $("shoulder-surf-banner");
  if (banner) banner.remove();
}

async function enterApp(user, { welcome = false } = {}) {
  faceFlowId++;
  stopCamera();
  resetAppUI();
  currentUser = user;
  setLastUser(user);
  hide(lockScreen);
  show(appShell);
  sidebarUser.textContent = user.name;
  $("quick-launch-row").classList.toggle("hidden", !appConfig.localControls);
  lastActivity = Date.now();
  startRefresh();
  updateMonitorButton();
  if (welcome) setStatus("Welcome! You can turn on face login in Settings.");
  await loadChats();
  startMonitoring().catch(() => {});
}

// Lock: ends this session but remembers the account, so the next screen is quick.
function lockApp(message) {
  stopMonitoring();
  stopRefresh();
  sessionToken = null;
  currentUser = null;
  resetAppUI();
  hide(appShell);
  show(lockScreen);
  beginAuth(message);
}

// Sign out: also forgets the account on this browser.
function signOut(message) {
  clearLastUser();
  signinEmail.value = "";
  lockApp(message);
}

$("lock-app-btn").addEventListener("click", () => lockApp());
$("signout-btn").addEventListener("click", () => signOut());

// While the person is actively working, quietly renew the token so it never runs out mid-chat.
["pointerdown", "keydown"].forEach((evt) =>
  window.addEventListener(evt, () => (lastActivity = Date.now()), { passive: true })
);

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(async () => {
    if (!sessionToken || Date.now() - lastActivity > 30 * 60 * 1000) return;
    try {
      const res = await apiFetch("/auth/refresh", { method: "POST" });
      if (res.ok) sessionToken = (await readJson(res)).token;
    } catch (e) {
      /* try again next time */
    }
  }, 20 * 60 * 1000);
}
function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---------------------------------------------------------------------------
// Chat list
// ---------------------------------------------------------------------------

async function loadChats() {
  const res = await apiFetch("/chats");
  if (!res.ok) return;
  chatsCache = (await readJson(res)).chats || [];
  renderChatList();

  if (chatsCache.length === 0) return createNewChat();
  if (!currentChatId || !chatsCache.some((c) => c.id === currentChatId)) {
    openChat(chatsCache[0].id, chatsCache[0].title);
  }
}

function renderChatList() {
  chatListEl.innerHTML = "";
  const pinned = chatsCache.filter((c) => c.pinned);
  const others = chatsCache.filter((c) => !c.pinned);
  const label = (text) => {
    const el = document.createElement("div");
    el.className = "chat-section-label";
    el.textContent = text;
    chatListEl.appendChild(el);
  };
  if (pinned.length) {
    label("Pinned");
    pinned.forEach((c) => chatListEl.appendChild(buildChatItem(c)));
  }
  if (others.length) {
    if (pinned.length) label("Recent");
    others.forEach((c) => chatListEl.appendChild(buildChatItem(c)));
  }
  const current = chatsCache.find((c) => c.id === currentChatId);
  if (current) currentChatTitle.textContent = current.title;
}

function buildChatItem(chat) {
  const el = document.createElement("div");
  el.className = "chat-item" + (chat.id === currentChatId ? " active" : "");

  const title = document.createElement("span");
  title.className = "chat-item-title";
  title.textContent = chat.title;
  title.addEventListener("click", () => openChat(chat.id, chat.title));

  const menuBtn = document.createElement("button");
  menuBtn.className = "chat-menu-btn";
  menuBtn.textContent = "⋯";
  menuBtn.title = "More";
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleChatMenu(chat, el);
  });

  el.append(title, menuBtn);
  return el;
}

async function createNewChat() {
  const res = await apiFetch("/chats", { method: "POST" });
  if (!res.ok) return;
  const { chat } = await readJson(res);
  currentChatId = chat.id;
  currentChatTitle.textContent = chat.title;
  messageListEl.innerHTML = EMPTY_STATE_HTML;
  await loadChats();
}

async function openChat(chatId, title) {
  currentChatId = chatId;
  currentChatTitle.textContent = title;
  renderChatList(); // refreshes which chat is highlighted

  const res = await apiFetch(`/chats/${chatId}/messages`);
  if (!res.ok) {
    if (res.status === 404) {
      currentChatId = null;
      await loadChats();
    }
    return;
  }
  if (chatId !== currentChatId) return; // the person already switched to another chat
  const { messages } = await readJson(res);
  messageListEl.innerHTML = messages.length ? "" : EMPTY_STATE_HTML;
  messages.forEach(renderMessage);
}

newChatBtn.addEventListener("click", createNewChat);

// --- Pin / share / rename / delete menu ---

function toggleChatMenu(chat, chatEl) {
  const existing = document.querySelector(".chat-context-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "chat-context-menu";

  const item = (text, onClick, extraClass = "") => {
    const el = document.createElement("div");
    el.className = "chat-context-item " + extraClass;
    el.textContent = text;
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.remove();
      await onClick();
    });
    menu.appendChild(el);
  };

  item(chat.pinned ? "Unpin" : "Pin", async () => {
    await apiFetch(`/chats/${chat.id}/pin`, { method: "PATCH" });
    loadChats();
  });

  item("Share", async () => {
    const res = await apiFetch(`/chats/${chat.id}/share`, { method: "POST" });
    const { shareToken } = await readJson(res);
    if (!shareToken) return setStatus("Couldn't create a share link.");
    const origin = window.location.protocol.startsWith("http") ? window.location.origin : "http://localhost:4000";
    const url = `${origin}/shared.html?token=${shareToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setStatus("Share link copied. Anything that looks like a password, email, phone number or key is hidden in the shared copy.");
    } catch (e) {
      prompt("Copy this share link:", url);
    }
    loadChats();
  });

  if (chat.share_token) {
    item("Stop sharing", async () => {
      await apiFetch(`/chats/${chat.id}/share`, { method: "DELETE" });
      setStatus("The share link no longer works.");
      loadChats();
    });
  }

  item("Rename", async () => {
    const title = prompt("Rename chat:", chat.title);
    if (title && title.trim()) {
      await apiFetch(`/chats/${chat.id}/rename`, { method: "PATCH", json: { title: title.trim() } });
      loadChats();
    }
  });

  item(
    "Delete",
    async () => {
      if (!confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
      await apiFetch(`/chats/${chat.id}`, { method: "DELETE" });
      if (currentChatId === chat.id) {
        currentChatId = null;
        messageListEl.innerHTML = EMPTY_STATE_HTML;
      }
      loadChats();
    },
    "danger"
  );

  document.body.appendChild(menu);
  const rect = chatEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - 160)}px`;

  setTimeout(() => {
    document.addEventListener("click", function close() {
      menu.remove();
      document.removeEventListener("click", close);
    });
  }, 0);
}

// --- Search across the person's own chats ---

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = searchInput.value.trim();
  if (!query) {
    hide(searchResultsEl);
    show(chatListEl);
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 300);
});

async function runSearch(query) {
  const res = await apiFetch(`/chats/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return;
  const { results } = await readJson(res);

  hide(chatListEl);
  show(searchResultsEl);
  searchResultsEl.innerHTML = "";

  if (results.length === 0) {
    searchResultsEl.innerHTML = `<p class="security-empty" style="padding:8px 14px">No matches found.</p>`;
    return;
  }

  results.forEach((r) => {
    const el = document.createElement("div");
    el.className = "search-result-item";
    const highlighted = escapeHtml(r.snippet).replace(new RegExp(`(${escapeRegex(escapeHtml(query))})`, "ig"), "<mark>$1</mark>");
    el.innerHTML = `<div class="search-result-title">${escapeHtml(r.chatTitle)}</div><div class="search-result-snippet">${highlighted}</div>`;
    el.addEventListener("click", () => {
      searchInput.value = "";
      hide(searchResultsEl);
      show(chatListEl);
      openChat(r.chatId, r.chatTitle);
    });
    searchResultsEl.appendChild(el);
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function renderMessage(msg) {
  const empty = messageListEl.querySelector(".empty-state");
  if (empty) empty.remove();

  const wrapper = document.createElement("div");
  wrapper.className = `message-wrapper ${msg.role}`;

  const el = document.createElement("div");
  el.className = `message ${msg.role}`;
  if (msg.role === "assistant") el.innerHTML = formatAssistantText(msg.content || "");
  else el.textContent = msg.content;

  if (msg.image_path) {
    const assetUrl = toAssetUrl(msg.image_path);
    if (/\.(png|jpe?g|webp|gif)$/i.test(msg.image_path)) {
      const img = document.createElement("img");
      img.src = assetUrl;
      img.alt = "Generated image";
      el.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.href = assetUrl;
      link.className = "file-download";
      let fileName = msg.image_path.split("/").pop();
      try {
        fileName = decodeURIComponent(fileName);
      } catch (e) {
        /* keep the raw name */
      }
      link.textContent = "⬇ Download " + fileName;
      el.appendChild(link);
    }
  }

  const del = document.createElement("button");
  del.className = "message-delete-btn";
  del.title = "Delete this message";
  del.textContent = "✕";
  del.addEventListener("click", async () => {
    if (!confirm("Delete this message? This can't be undone.")) return;
    const res = await apiFetch(`/messages/${msg.id}`, { method: "DELETE" });
    if (res.ok) wrapper.remove();
    else setStatus("Couldn't delete that message.");
  });

  wrapper.append(el, del);
  messageListEl.appendChild(wrapper);
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

// The AI is asked not to use markdown, but if some slips through, tidy it into
// plain paragraphs and bullet lists.
function formatAssistantText(text) {
  if (!text) return "";
  const cleaned = text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^-{3,}$/gm, "");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);

  let html = "";
  let bullets = [];
  const flush = () => {
    if (bullets.length) html += "<ul>" + bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("") + "</ul>";
    bullets = [];
  };
  lines.forEach((line) => {
    const m = line.match(/^[-*•]\s+(.*)/);
    if (m) bullets.push(m[1]);
    else {
      flush();
      html += `<p>${escapeHtml(line)}</p>`;
    }
  });
  flush();
  return html;
}

// ---------------------------------------------------------------------------
// Sending: chat, image, documents, and attached files
// ---------------------------------------------------------------------------

const ENDPOINTS = { chat: "/chat", image: "/generate", pdf: "/create/pdf", ppt: "/create/ppt", code: "/create/code", zip: "/create/zip" };
const STATUS_TEXT = {
  chat: "Thinking…",
  image: "Generating your image… this can take a little while.",
  pdf: "Creating your PDF… this can take 10–30 seconds.",
  ppt: "Creating your presentation… this can take 10–30 seconds.",
  code: "Writing your code file… this can take 10–30 seconds.",
  zip: "Building your ZIP project… this can take 10–30 seconds.",
};

async function sendMessage() {
  if (sendInFlight) return;
  const text = promptInput.value.trim();
  if (!currentChatId || (!text && !pendingAttachment)) return;

  const chatId = currentChatId;
  const mode = modeSelect.value;
  const attachment = pendingAttachment;

  sendInFlight = true;
  sendBtn.disabled = true;
  try {
    const shownText = attachment ? (text ? `${text} [attached: ${attachment.name}]` : `[attached: ${attachment.name}]`) : text;
    const saved = await apiFetch(`/chats/${chatId}/messages`, { method: "POST", json: { role: "user", content: shownText } });
    const savedData = await readJson(saved);
    if (!saved.ok) {
      setStatus(savedData.error || "Couldn't send that message.");
      return;
    }
    promptInput.value = "";
    clearAttachment();
    if (chatId === currentChatId) renderMessage(savedData.message);

    if (attachment) {
      await sendAnalyzeRequest(attachment, text, chatId);
    } else {
      setStatus(STATUS_TEXT[mode] || STATUS_TEXT.chat);
      const res = await apiFetch(ENDPOINTS[mode] || ENDPOINTS.chat, { method: "POST", json: { prompt: text, chatId } });
      const data = await readJson(res);
      if (!res.ok || !data.message) {
        setStatus(data.error || "Something went wrong. Please try again.");
      } else {
        setStatus("");
        if (chatId === currentChatId) renderMessage(data.message);
      }
    }
    await loadChats();
  } catch (err) {
    setStatus(err.message);
  } finally {
    sendInFlight = false;
    sendBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", sendMessage);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) sendMessage();
});

// --- Attachments: pick a file, add an instruction, then Send ---

$("attach-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return setStatus("That file is larger than 20 MB.");
  pendingAttachment = file;
  attachmentName.textContent = file.name;
  show(attachmentChip);
});
$("remove-attachment-btn").addEventListener("click", clearAttachment);

function clearAttachment() {
  pendingAttachment = null;
  hide(attachmentChip);
}

function analyzeForm(file, instruction, chatId) {
  const form = new FormData();
  form.append("chatId", chatId);
  form.append("instruction", instruction || "");
  form.append("file", file);
  return form;
}

async function sendAnalyzeRequest(file, instruction, chatId) {
  setStatus(`Analysing ${file.name}…`);
  const res = await apiFetch("/analyze", { method: "POST", body: analyzeForm(file, instruction, chatId) });
  const data = await readJson(res);

  if (res.ok) {
    setStatus("");
    if (chatId === currentChatId) renderMessage(data.message);
    return;
  }

  // Code and unrecognised files need the password re-entered first.
  if (data.code === "ELEVATION_REQUIRED") {
    setStatus("");
    requestElevation(data.error, async (elevatedToken) => {
      const res2 = await apiFetch("/analyze/elevated", {
        method: "POST",
        body: analyzeForm(file, instruction, chatId),
        token: elevatedToken,
        noLock: true,
      });
      const data2 = await readJson(res2);
      if (!res2.ok) return data2.error || "Couldn't process that file.";
      if (chatId === currentChatId) renderMessage(data2.message);
      loadChats();
      return null;
    }, () => setStatus("Cancelled."));
    return;
  }
  setStatus(data.error || "File analysis failed.");
}

// ---------------------------------------------------------------------------
// Password confirmation modal (reused for code files, turning off face login, deleting the account)
// ---------------------------------------------------------------------------

let pwSubmit = null;
let pwCancel = null;

function openPasswordModal({ title, text, confirmLabel = "Confirm", onSubmit, onCancel }) {
  $("pw-title").textContent = title;
  $("pw-text").textContent = text || "";
  $("pw-confirm").textContent = confirmLabel;
  $("pw-input").value = "";
  $("pw-error").textContent = "";
  pwSubmit = onSubmit;
  pwCancel = onCancel || null;
  show($("pw-modal"));
  $("pw-input").focus();
}

function closePasswordModal() {
  hide($("pw-modal"));
  $("pw-input").value = "";
  pwSubmit = null;
  pwCancel = null;
}

async function submitPasswordModal() {
  const password = $("pw-input").value;
  if (!password) {
    $("pw-error").textContent = "Please enter your password.";
    return;
  }
  $("pw-confirm").disabled = true;
  try {
    const error = await pwSubmit(password); // returns an error message, or null when it worked
    if (error) {
      $("pw-error").textContent = error;
      $("pw-input").select();
    } else {
      closePasswordModal();
    }
  } catch (err) {
    $("pw-error").textContent = err.message;
  } finally {
    $("pw-confirm").disabled = false;
  }
}

$("pw-confirm").addEventListener("click", submitPasswordModal);
$("pw-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPasswordModal();
});
$("pw-cancel").addEventListener("click", () => {
  const cb = pwCancel;
  closePasswordModal();
  if (cb) cb();
});

// Re-checks the person's own password, then runs `onElevated` with the short-lived token.
function requestElevation(reason, onElevated, onCancel) {
  openPasswordModal({
    title: "Verification required",
    text: reason,
    confirmLabel: "Verify",
    onCancel,
    onSubmit: async (password) => {
      const res = await apiFetch("/auth/elevate", { method: "POST", json: { password } });
      const data = await readJson(res);
      if (!res.ok) return data.error || "Verification failed.";
      return onElevated(data.token);
    },
  });
}

// ---------------------------------------------------------------------------
// Settings: profile, face login, password, delete account
// ---------------------------------------------------------------------------

async function refreshSettings() {
  const res = await apiFetch("/me");
  if (!res.ok) return;
  const data = await readJson(res);
  currentUser = data.user;
  setLastUser(currentUser);
  $("settings-account").textContent = `${currentUser.name} · ${currentUser.email}`;
  $("settings-usage").textContent = `AI requests today: ${data.usage.used} of ${data.usage.limit}`;
  $("settings-face-status").textContent = currentUser.faceEnabled ? "On — you can sign in with your face" : "Off";
  $("settings-face-setup-btn").textContent = currentUser.faceEnabled ? "Re-capture my face" : "Set up face login";
  $("settings-face-remove-btn").classList.toggle("hidden", !currentUser.faceEnabled);
}

$("settings-btn").addEventListener("click", async () => {
  ["settings-current-password", "settings-new-password"].forEach((id) => ($(id).value = ""));
  $("settings-password-msg").textContent = "";
  show($("settings-modal"));
  await refreshSettings();
});
$("settings-close-btn").addEventListener("click", () => hide($("settings-modal")));

$("settings-change-password-btn").addEventListener("click", async () => {
  const msg = $("settings-password-msg");
  const currentPassword = $("settings-current-password").value;
  const newPassword = $("settings-new-password").value;
  if (!currentPassword || !newPassword) {
    msg.textContent = "Please fill in both fields.";
    return;
  }
  const res = await apiFetch("/account/password", { method: "POST", json: { currentPassword, newPassword } });
  const data = await readJson(res);
  if (res.ok) {
    sessionToken = data.token;
    $("settings-current-password").value = "";
    $("settings-new-password").value = "";
    msg.textContent = "Password updated. Every other device was signed out.";
  } else {
    msg.textContent = data.error || "Couldn't update the password.";
  }
});

$("settings-face-remove-btn").addEventListener("click", () => {
  openPasswordModal({
    title: "Turn off face login",
    text: "Your face data will be deleted from Aperture. Enter your password to confirm.",
    confirmLabel: "Turn off",
    onSubmit: async (password) => {
      const res = await apiFetch("/face", { method: "DELETE", json: { password } });
      const data = await readJson(res);
      if (!res.ok) return data.error || "Couldn't turn off face login.";
      await refreshSettings();
      return null;
    },
  });
});

$("settings-delete-btn").addEventListener("click", () => {
  if (!confirm("Delete your account and everything in it? This can't be undone.")) return;
  openPasswordModal({
    title: "Delete account",
    text: "Enter your password to permanently delete your account, chats, files, face data and security photos.",
    confirmLabel: "Delete everything",
    onSubmit: async (password) => {
      const res = await apiFetch("/account", { method: "DELETE", json: { password } });
      const data = await readJson(res);
      if (!res.ok) return data.error || "Couldn't delete the account.";
      signOut();
      setStatusText("Your account and all its data were deleted.");
      return null;
    },
  });
});

// --- Face login set-up (three quick readings, so one bad frame can't spoil it) ---

let faceSetupStream = null;

function closeFaceSetupCamera() {
  if (faceSetupStream) faceSetupStream.getTracks().forEach((t) => t.stop());
  faceSetupStream = null;
  const feed = $("face-setup-feed");
  if (feed) feed.srcObject = null;
}

$("settings-face-setup-btn").addEventListener("click", async () => {
  $("face-consent").checked = false;
  $("face-setup-password").value = "";
  $("face-setup-error").textContent = "";
  show($("face-setup-modal"));
  try {
    await ensureFaceModels();
    faceSetupStream = await navigator.mediaDevices.getUserMedia({ video: true });
    $("face-setup-feed").srcObject = faceSetupStream;
  } catch (err) {
    $("face-setup-error").textContent = "Couldn't start the camera or face recognition.";
  }
});

$("face-setup-cancel").addEventListener("click", () => {
  closeFaceSetupCamera();
  hide($("face-setup-modal"));
});

async function captureFaceSamples(video) {
  const samples = [];
  for (let attempt = 0; attempt < 14 && samples.length < 3; attempt++) {
    const detection = await detectFull(video);
    if (detection) {
      samples.push(Array.from(detection.descriptor));
      await sleep(500);
    } else {
      await sleep(300);
    }
  }
  return samples.length >= 2 ? samples : null;
}

$("face-setup-capture").addEventListener("click", async () => {
  const error = $("face-setup-error");
  error.textContent = "";
  if (!$("face-consent").checked) {
    error.textContent = "Please tick the box to agree first.";
    return;
  }
  const password = $("face-setup-password").value;
  if (!password) {
    error.textContent = "Please enter your password.";
    return;
  }
  if (!faceSetupStream) {
    error.textContent = "The camera isn't running.";
    return;
  }

  const button = $("face-setup-capture");
  button.disabled = true;
  button.textContent = "Capturing…";
  try {
    const samples = await captureFaceSamples($("face-setup-feed"));
    if (!samples) {
      error.textContent = "We couldn't see your face clearly. Face the camera in good light and try again.";
      return;
    }
    const res = await apiFetch("/face/enroll", { method: "POST", json: { embeddings: samples, password } });
    const data = await readJson(res);
    if (!res.ok) {
      error.textContent = data.error || "Couldn't save your face.";
      return;
    }
    currentUser = data.user;
    setLastUser(currentUser);
    closeFaceSetupCamera();
    hide($("face-setup-modal"));
    await refreshSettings();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Capture my face";
  }
});

// ---------------------------------------------------------------------------
// Security activity: photos of failed face sign-ins and monitoring mismatches
// ---------------------------------------------------------------------------

let securityImageUrls = [];
function revokeSecurityImages() {
  securityImageUrls.forEach((u) => URL.revokeObjectURL(u));
  securityImageUrls = [];
}

$("security-log-btn").addEventListener("click", loadSecurityLog);
$("security-log-close-btn").addEventListener("click", () => {
  hide($("security-log-modal"));
  revokeSecurityImages();
});

async function loadSecurityLog() {
  const list = $("security-log-list");
  show($("security-log-modal"));
  list.innerHTML = `<div class="security-empty">Loading…</div>`;
  revokeSecurityImages();

  const res = await apiFetch("/security/captures");
  if (!res.ok) {
    list.innerHTML = `<div class="security-empty">Couldn't load your security activity.</div>`;
    return;
  }
  const { captures } = await readJson(res);
  list.innerHTML = "";
  if (!captures.length) {
    list.innerHTML = `<div class="security-empty">Nothing to report. No failed sign-ins have been recorded.</div>`;
    return;
  }

  for (const cap of captures) {
    const item = document.createElement("div");
    item.className = "security-item";

    // Photos are private, so they're fetched with the sign-in token, not a public link.
    const img = document.createElement("img");
    img.alt = "Captured photo";
    apiFetch(cap.imageUrl.replace(/^\/api/, ""))
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        securityImageUrls.push(url);
        img.src = url;
      })
      .catch(() => {});

    const info = document.createElement("div");
    info.className = "security-item-info";
    const reason = cap.reason === "failed_login" ? "Failed face sign-in" : "A different face appeared while monitoring";
    info.innerHTML = `<div class="security-item-title">${escapeHtml(reason)}</div><div class="security-item-time">${escapeHtml(utcDate(cap.created_at).toLocaleString())}</div>`;

    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      const r = await apiFetch(`/security/captures/${cap.id}`, { method: "DELETE" });
      if (r.ok) item.remove();
    });

    item.append(img, info, remove);
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Presence monitoring: lock when you walk away or someone else sits down
// ---------------------------------------------------------------------------

let monitorStream = null;
let monitorInterval = null;
let isMonitoring = false;
let awayTimer = null;
let checkingPresence = false;

monitorToggleBtn.addEventListener("click", () => (isMonitoring ? stopMonitoring() : startMonitoring()));

const testBlurBtn = $("test-blur-btn");
if (testBlurBtn) {
  testBlurBtn.addEventListener("click", () => {
    showShoulderSurfAlert();
    setStatus("🛡️ Demonstration: Screen blurred because shoulder surfing was simulated.");
    setTimeout(() => {
      clearShoulderSurfAlert();
      setStatus("");
    }, 4500);
  });
}

function updateMonitorButton() {
  if (!monitorToggleBtn) return;
  if (isMonitoring) {
    monitorToggleBtn.innerHTML = "🛡️ Privacy Guard: <span style='color:#16a34a; font-weight:600;'>Active</span>";
  } else {
    monitorToggleBtn.innerHTML = "🛡️ Privacy Guard: <span style='color:#64748b;'>Off</span>";
  }
}

async function startMonitoring() {
  try {
    await ensureFaceModels();
    monitorStream = await navigator.mediaDevices.getUserMedia({ video: true });
    monitorFeed.srcObject = monitorStream;
    isMonitoring = true;
    updateMonitorButton();
    monitorInterval = setInterval(checkPresence, 5000);
    startShoulderSurfDetection();
    setStatus("🛡️ Privacy Guard is active: Screen will blur if someone looks over your shoulder, and lock if you leave.");
  } catch (err) {
    updateMonitorButton();
    setStatus("Camera unavailable for Privacy Guard monitoring.");
  }
}

function stopMonitoring() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = null;
  if (awayTimer) clearTimeout(awayTimer);
  awayTimer = null;
  if (monitorStream) monitorStream.getTracks().forEach((t) => t.stop());
  monitorStream = null;
  monitorFeed.srcObject = null;
  isMonitoring = false;
  updateMonitorButton();
  stopShoulderSurfDetection();
  setStatus("Privacy Guard paused.");
}

async function lockBecauseAway() {
  // On your own laptop this also locks Windows. The call must happen BEFORE the
  // session ends, or the server would refuse it.
  if (appConfig.localControls && sessionToken) {
    try {
      await apiFetch("/lock-system", { method: "POST" });
    } catch (e) {
      /* lock the app anyway */
    }
  }
  lockApp();
}

async function checkPresence() {
  if (!sessionToken || checkingPresence) return;
  checkingPresence = true;
  try {
    const detection = await detectFull(monitorFeed);

    if (!detection) {
      // Nobody in view: lock after 10 seconds unless they come back.
      if (!awayTimer) awayTimer = setTimeout(lockBecauseAway, 10000);
      return;
    }
    if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = null;
    }

    // Someone is there. If this account has a face on file, check it is THEM.
    if (!currentUser || !currentUser.faceEnabled) return;
    const res = await apiFetch("/auth/verify-face", { method: "POST", json: { embedding: Array.from(detection.descriptor) } });
    if (!res.ok) return;
    const data = await readJson(res);
    if (data.enrolled && !data.isMatch) {
      const imageData = frameToDataUrl(monitorFeed);
      if (imageData) {
        try {
          await apiFetch("/security/capture", { method: "POST", json: { imageData } });
        } catch (e) {
          /* lock regardless */
        }
      }
      lockApp();
    }
  } finally {
    checkingPresence = false;
  }
}

// --- Shoulder-surfing: a second face looking at the screen blurs it ---

let shoulderInterval = null;
let lookingStreak = 0;
let clearStreak = 0;
let checkingShoulder = false;
let shoulderSurfPaused = false;
const LOOKING_STREAK_THRESHOLD = 1; // triggers blur immediately on detection (~400ms)
const UNBLUR_CLEAR_THRESHOLD = 2;   // require ~1s of clear view to unblur and avoid flickering

function startShoulderSurfDetection() {
  stopShoulderSurfDetection();
  lookingStreak = 0;
  clearStreak = 0;
  shoulderInterval = setInterval(checkForShoulderSurfing, 400);
}

function stopShoulderSurfDetection() {
  if (shoulderInterval) clearInterval(shoulderInterval);
  shoulderInterval = null;
  lookingStreak = 0;
  clearStreak = 0;
  clearShoulderSurfAlert();
}

async function checkForShoulderSurfing() {
  if (!monitorFeed.srcObject || checkingShoulder || shoulderSurfPaused) return;
  checkingShoulder = true;
  try {
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.28 });
    const faces = await faceapi.detectAllFaces(monitorFeed, options).withFaceLandmarks();

    if (faces.length < 2) {
      lookingStreak = 0;
      clearStreak++;
      if (clearStreak >= UNBLUR_CLEAR_THRESHOLD) {
        clearShoulderSurfAlert();
      }
      return;
    }

    clearStreak = 0;

    // Largest face is assumed to be the primary user
    let userIndex = 0;
    let biggest = 0;
    faces.forEach((f, i) => {
      const area = f.detection.box.width * f.detection.box.height;
      if (area > biggest) {
        biggest = area;
        userIndex = i;
      }
    });

    // Check if observer is facing generally towards screen/webcam
    const observerLooking = faces.some((f, i) => {
      if (i === userIndex) return false;
      const offset = Math.abs(getNoseOffset(f.landmarks));
      return offset < 0.42;
    });

    if (observerLooking || faces.length >= 2) {
      lookingStreak++;
      if (lookingStreak >= LOOKING_STREAK_THRESHOLD) {
        showShoulderSurfAlert();
      }
    } else {
      lookingStreak = 0;
      clearStreak++;
      if (clearStreak >= UNBLUR_CLEAR_THRESHOLD) {
        clearShoulderSurfAlert();
      }
    }
  } catch (e) {
    /* skip this round */
  } finally {
    checkingShoulder = false;
  }
}

function showShoulderSurfAlert() {
  document.body.classList.add("shoulder-surf-blur");
  let banner = $("shoulder-surf-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "shoulder-surf-banner";
    banner.className = "shoulder-surf-banner";
    banner.innerHTML = `
      <div class="shoulder-surf-content">
        <span class="shoulder-surf-icon">👁️ ⚠</span>
        <div class="shoulder-surf-text">
          <div class="shoulder-surf-title">Shoulder Surfing Detected</div>
          <div class="shoulder-surf-sub">Another person is viewing your screen. Content blurred for your privacy.</div>
        </div>
        <button type="button" class="shoulder-surf-dismiss" id="shoulder-surf-dismiss-btn" title="Temporarily unblur">Dismiss (5s)</button>
      </div>
    `;
    document.body.appendChild(banner);
    const dismissBtn = $("shoulder-surf-dismiss-btn");
    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => {
        shoulderSurfPaused = true;
        clearShoulderSurfAlert();
        setTimeout(() => { shoulderSurfPaused = false; }, 5000);
      });
    }
  }
}

function clearShoulderSurfAlert() {
  document.body.classList.remove("shoulder-surf-blur");
  const banner = $("shoulder-surf-banner");
  if (banner) banner.remove();
}

// ---------------------------------------------------------------------------
// Voice input (the browser's built-in speech recognition)
// ---------------------------------------------------------------------------

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function createRecognizer() {
  if (!SpeechRecognition) return null;
  const r = new SpeechRecognition();
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = true;
  return r;
}

// One toggle-able microphone: click to start, click again to stop.
function wireMic(button, { onText, onStart, onError }) {
  let recognizer = null;
  let listening = false;

  button.addEventListener("click", () => {
    if (listening) {
      listening = false;
      recognizer.stop();
      return;
    }
    recognizer = createRecognizer();
    if (!recognizer) return onError("Voice input isn't supported in this browser. Try Chrome or Edge.");

    let finalText = "";
    listening = true;
    button.classList.add("listening");
    button.textContent = "⏹";
    if (onStart) onStart();

    recognizer.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece + " ";
        else interim += piece;
      }
      onText((finalText + interim).trim());
    };
    recognizer.onerror = (event) => onError(`Voice error: ${event.error}`);
    // The browser sometimes ends continuous listening by itself; restart unless the person stopped it.
    recognizer.onend = () => {
      if (listening) {
        try {
          recognizer.start();
          return;
        } catch (e) {
          listening = false;
        }
      }
      button.classList.remove("listening");
      button.textContent = "🎤";
    };
    recognizer.start();
  });
}

wireMic($("prompt-mic-btn"), {
  onText: (t) => (promptInput.value = t),
  onError: (m) => setStatus(m),
});

// Speaking a password shows it briefly so you can check it was heard correctly,
// and hides it again as soon as you click away.
wireMic($("password-mic-btn"), {
  onStart: () => (signinPassword.type = "text"),
  onText: (t) => (signinPassword.value = t.replace(/\s+/g, "")),
  onError: (m) => (signinError.textContent = m),
});
signinPassword.addEventListener("blur", () => (signinPassword.type = "password"));

// ---------------------------------------------------------------------------
// Windows shortcuts (only when the server is your own laptop)
// ---------------------------------------------------------------------------

document.querySelectorAll(".launch-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const res = await apiFetch(`/launch/${btn.dataset.app}`, { method: "POST" });
    if (res.ok) setStatus(`Opened ${btn.title || btn.dataset.app}.`);
    else setStatus((await readJson(res)).error || "Couldn't open that app.");
  });
});
