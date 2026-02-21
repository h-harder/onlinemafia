const STORAGE_NAME_KEY = "texting_mafia_name";
const STORAGE_BACKEND_KEY = "texting_mafia_backend";

let ws = null;
let state = null;
let session = null;
let activeTab = "main";
let selectedDmPeerId = null;
let nextReqId = 1;
let expectedClose = false;

const pendingAcks = new Map();

const els = {
  nameModal: document.getElementById("name-modal"),
  nameForm: document.getElementById("name-form"),
  nameInput: document.getElementById("name-input"),
  nameDisplay: document.getElementById("name-display"),
  changeNameBtn: document.getElementById("change-name-btn"),

  menuScreen: document.getElementById("menu-screen"),
  lobbyScreen: document.getElementById("lobby-screen"),
  gameScreen: document.getElementById("game-screen"),

  backendUrlInput: document.getElementById("backend-url-input"),
  saveBackendBtn: document.getElementById("save-backend-btn"),
  backendStatus: document.getElementById("backend-status"),

  createLobbyBtn: document.getElementById("create-lobby-btn"),
  joinLobbyBtn: document.getElementById("join-lobby-btn"),
  joinCodeInput: document.getElementById("join-code-input"),
  menuError: document.getElementById("menu-error"),

  lobbyCode: document.getElementById("lobby-code"),
  copyCodeBtn: document.getElementById("copy-code-btn"),
  lobbyPlayers: document.getElementById("lobby-players"),
  startGameBtn: document.getElementById("start-game-btn"),
  leaveLobbyBtn: document.getElementById("leave-lobby-btn"),
  startHint: document.getElementById("start-hint"),

  roleValue: document.getElementById("role-value"),
  aliveValue: document.getElementById("alive-value"),
  roundValue: document.getElementById("round-value"),
  timerValue: document.getElementById("timer-value"),
  winnerValue: document.getElementById("winner-value"),
  roleReveal: document.getElementById("role-reveal"),
  cooldownText: document.getElementById("cooldown-text"),

  gamePlayers: document.getElementById("game-players"),
  leaveGameBtn: document.getElementById("leave-game-btn"),

  mainTabBtn: document.getElementById("main-tab-btn"),
  dmTabBtn: document.getElementById("dm-tab-btn"),
  mainChatView: document.getElementById("main-chat-view"),
  dmChatWrapper: document.getElementById("dm-chat-wrapper"),
  dmTargetSelect: document.getElementById("dm-target-select"),
  dmChatView: document.getElementById("dm-chat-view"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatError: document.getElementById("chat-error"),

  historyList: document.getElementById("history-list")
};

function normalizeBackendUrl(rawUrl) {
  let value = String(rawUrl || "").trim();
  if (!value) {
    return "";
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function fallbackBackendUrl() {
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:8787";
  }
  return "";
}

function getStoredName() {
  return (localStorage.getItem(STORAGE_NAME_KEY) || "").trim();
}

function setStoredName(name) {
  localStorage.setItem(STORAGE_NAME_KEY, name);
}

function getStoredBackendUrl() {
  const stored = normalizeBackendUrl(localStorage.getItem(STORAGE_BACKEND_KEY) || "");
  if (stored) {
    return stored;
  }
  return fallbackBackendUrl();
}

function setStoredBackendUrl(url) {
  const normalized = normalizeBackendUrl(url);
  if (!normalized) {
    localStorage.removeItem(STORAGE_BACKEND_KEY);
    return "";
  }
  localStorage.setItem(STORAGE_BACKEND_KEY, normalized);
  return normalized;
}

function cleanName(rawName) {
  return String(rawName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function cleanCode(rawCode) {
  return String(rawCode || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatTime(ts) {
  const dt = new Date(ts);
  return dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function roleLabel(role) {
  if (role === "mafia") return "Mafia";
  if (role === "guardian") return "Guardian Angel";
  if (role === "villager") return "Villager";
  return "-";
}

function setMenuError(text) {
  els.menuError.textContent = text || "";
}

function setChatError(text) {
  els.chatError.textContent = text || "";
}

function showNameModal(forceOpen) {
  const current = getStoredName();
  if (!current || forceOpen) {
    els.nameInput.value = current;
    els.nameModal.classList.remove("hidden");
  } else {
    els.nameModal.classList.add("hidden");
  }
  els.nameDisplay.textContent = `Name: ${current || "-"}`;
}

function updateBackendStatus() {
  const backend = getStoredBackendUrl();
  els.backendStatus.textContent = backend
    ? `Backend: ${backend}`
    : "Set your Cloudflare Worker URL first.";
}

function requireName() {
  const name = getStoredName();
  if (!name) {
    showNameModal(true);
    setMenuError("Set your name first.");
    return null;
  }
  return name;
}

function requireBackend() {
  const backend = getStoredBackendUrl();
  if (!backend) {
    setMenuError("Set backend URL first.");
    return null;
  }
  return backend;
}

function showScreen(screen) {
  els.menuScreen.classList.toggle("hidden", screen !== "menu");
  els.lobbyScreen.classList.toggle("hidden", screen !== "lobby");
  els.gameScreen.classList.toggle("hidden", screen !== "game");
}

function currentMafiaCooldownMs() {
  if (!state || state.youRole !== "mafia") {
    return 0;
  }
  return Math.max(0, (state.mafiaCooldownEndsAt || 0) - Date.now());
}

function wsUrlFromBackend(sessionData) {
  const backend = new URL(getStoredBackendUrl());
  backend.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  backend.pathname = `/ws/${encodeURIComponent(sessionData.code)}`;
  backend.search = `pid=${encodeURIComponent(sessionData.playerId)}&sec=${encodeURIComponent(
    sessionData.sessionSecret
  )}`;
  return backend.toString();
}

async function apiPost(path, payload) {
  const backend = requireBackend();
  if (!backend) {
    throw new Error("Backend URL is missing.");
  }

  const response = await fetch(`${backend}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  return body;
}

function clearPendingAcks(reason) {
  for (const entry of pendingAcks.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason || "Request canceled."));
  }
  pendingAcks.clear();
}

function handleSocketMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type === "state") {
    state = message.state;
    render();
    return;
  }

  if (message.type === "round_result") {
    if (message.result?.youWereEliminated) {
      setChatError("You were eliminated this round.");
    }
    return;
  }

  if (message.type === "ack" && typeof message.reqId === "string") {
    const pending = pendingAcks.get(message.reqId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingAcks.delete(message.reqId);
    if (message.ok) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error || "Action failed."));
    }
    return;
  }

  if (message.type === "error") {
    setChatError(message.error || "Action failed.");
    return;
  }

  if (message.type === "session_invalid") {
    setMenuError(message.error || "Your session is no longer valid.");
    leaveLobbyLocally();
  }
}

function handleSocketClose() {
  clearPendingAcks("Connection closed.");
  ws = null;
  if (expectedClose) {
    expectedClose = false;
    return;
  }
  if (session) {
    state = null;
    session = null;
    activeTab = "main";
    selectedDmPeerId = null;
    render();
    setMenuError("Disconnected from lobby.");
  }
}

function connectLobbySocket(sessionData) {
  return new Promise((resolve, reject) => {
    const url = wsUrlFromBackend(sessionData);
    const socket = new WebSocket(url);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
      reject(new Error("Socket connection timed out."));
    }, 12000);

    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      expectedClose = false;
      ws = socket;
      session = sessionData;
      setMenuError("");
      resolve();
    };

    socket.onmessage = (event) => {
      handleSocketMessage(event.data);
    };

    socket.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("Could not open WebSocket to backend."));
    };

    socket.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Connection closed before joining lobby."));
        return;
      }
      handleSocketClose();
    };
  });
}

function sendAction(type, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected to a lobby."));
  }
  const reqId = `req-${Date.now()}-${nextReqId++}`;
  ws.send(JSON.stringify({ type, reqId, ...payload }));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(reqId);
      reject(new Error("Request timed out."));
    }, 12000);
    pendingAcks.set(reqId, { resolve, reject, timer });
  });
}

function leaveLobbyLocally() {
  clearPendingAcks("Left lobby.");
  if (ws) {
    expectedClose = true;
    try {
      ws.close(1000, "Left lobby");
    } catch {
      // Ignore close errors.
    }
  } else {
    expectedClose = false;
  }
  ws = null;
  session = null;
  state = null;
  activeTab = "main";
  selectedDmPeerId = null;
  setChatError("");
  render();
}

async function leaveLobby() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    expectedClose = true;
    try {
      await sendAction("leave_lobby");
    } catch {
      // Ignore leave errors and close locally.
    }
  }
  leaveLobbyLocally();
}

function renderLobbyPlayers() {
  els.lobbyPlayers.innerHTML = "";
  for (const player of state.players) {
    const li = document.createElement("li");
    const badges = [];
    if (player.isHost) badges.push("host");
    li.textContent = badges.length ? `${player.name} (${badges.join(", ")})` : player.name;
    els.lobbyPlayers.appendChild(li);
  }
}

function renderHistory() {
  els.historyList.innerHTML = "";
  if (!state.history.length) {
    const li = document.createElement("li");
    li.textContent = "No rounds ended yet.";
    els.historyList.appendChild(li);
    return;
  }

  const rows = [...state.history].reverse();
  for (const item of rows) {
    const li = document.createElement("li");
    const parts = [`Round ${item.round}`];
    parts.push(`Killed: ${item.killedName || "No one"}`);
    parts.push(`Saved: ${item.savedName || "No one"}`);
    if (item.survivedBySaveName) {
      parts.push(`${item.survivedBySaveName} survived because they were saved`);
    } else if (item.eliminatedName) {
      parts.push(`${item.eliminatedName} was eliminated`);
    } else {
      parts.push("No elimination");
    }
    li.textContent = parts.join(" | ");
    els.historyList.appendChild(li);
  }
}

function activeDmThread() {
  if (!state || !state.dmThreads) return null;
  return state.dmThreads.find((thread) => thread.peerId === selectedDmPeerId) || null;
}

function renderMessage(container, message) {
  const card = document.createElement("div");
  card.className = "message";
  if (message.type === "system") {
    card.classList.add("system");
  }
  if (message.fromId && state && message.fromId === state.youId) {
    card.classList.add("self");
  }

  const head = document.createElement("div");
  head.className = "message-head";
  const from = document.createElement("strong");
  from.textContent = message.fromName || "System";
  const time = document.createElement("span");
  time.textContent = formatTime(message.at);
  head.appendChild(from);
  head.appendChild(time);

  const body = document.createElement("div");
  body.textContent = message.text;

  card.appendChild(head);
  card.appendChild(body);
  container.appendChild(card);
}

function renderMainChat() {
  els.mainChatView.innerHTML = "";
  for (const msg of state.mainMessages) {
    renderMessage(els.mainChatView, msg);
  }
  els.mainChatView.scrollTop = els.mainChatView.scrollHeight;
}

function renderDmTargets() {
  const peers = state.players.filter((player) => !player.isSelf);
  const validIds = new Set(peers.map((player) => player.id));
  if (!selectedDmPeerId || !validIds.has(selectedDmPeerId)) {
    selectedDmPeerId = peers[0]?.id || null;
  }

  els.dmTargetSelect.innerHTML = "";
  for (const peer of peers) {
    const opt = document.createElement("option");
    opt.value = peer.id;
    opt.textContent = `${peer.name}${peer.isAlive ? "" : " (dead)"}`;
    els.dmTargetSelect.appendChild(opt);
  }
  if (selectedDmPeerId) {
    els.dmTargetSelect.value = selectedDmPeerId;
  }
}

function renderDmChat() {
  els.dmChatView.innerHTML = "";
  const thread = activeDmThread();
  if (!thread || !thread.messages.length) {
    const empty = document.createElement("div");
    empty.className = "message system";
    empty.textContent = "No private messages yet.";
    els.dmChatView.appendChild(empty);
    return;
  }

  for (const msg of thread.messages) {
    renderMessage(els.dmChatView, msg);
  }
  els.dmChatView.scrollTop = els.dmChatView.scrollHeight;
}

function makePlayerRow(player) {
  const li = document.createElement("li");

  const meta = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = player.name;
  const sub = document.createElement("div");
  sub.className = "player-meta";

  const labels = [];
  labels.push(player.isAlive ? "alive" : "dead");
  if (player.isHost) labels.push("host");
  if (player.roleVisible && player.roleVisible !== "villager") {
    labels.push(roleLabel(player.roleVisible).toLowerCase());
  }
  if (player.isSelf) labels.push("you");
  sub.textContent = labels.join(" • ");
  meta.appendChild(name);
  meta.appendChild(sub);

  const actions = document.createElement("div");
  actions.className = "player-actions";

  if (!player.isSelf) {
    const dmBtn = document.createElement("button");
    dmBtn.className = "small-btn ghost-btn";
    dmBtn.textContent = "DM";
    dmBtn.addEventListener("click", () => {
      activeTab = "dm";
      selectedDmPeerId = player.id;
      renderChatArea();
    });
    actions.appendChild(dmBtn);
  }

  if (state.phase === "in_round" && state.youAreAlive && player.isAlive && !player.isSelf) {
    if (state.youRole === "mafia") {
      const cooldownMs = currentMafiaCooldownMs();
      const killBtn = document.createElement("button");
      killBtn.className = "small-btn kill-btn";
      killBtn.dataset.targetId = player.id;
      if (state.pendingKillId === player.id) {
        killBtn.textContent = "💀 Set";
      } else if (state.mafiaKillUsedThisRound) {
        killBtn.textContent = "💀 Used";
      } else {
        killBtn.textContent = "💀";
      }
      killBtn.disabled = cooldownMs > 0 || state.mafiaKillUsedThisRound;
      killBtn.addEventListener("click", async () => {
        try {
          await sendAction("mafia_kill", { targetId: player.id });
          setChatError("");
        } catch (error) {
          setChatError(error.message);
        }
      });
      actions.appendChild(killBtn);
    }

    if (state.youRole === "guardian") {
      const saveBtn = document.createElement("button");
      saveBtn.className = "small-btn save-btn";
      saveBtn.textContent = state.pendingSaveId === player.id ? "🙏 Set" : "🙏";
      saveBtn.addEventListener("click", async () => {
        try {
          await sendAction("guardian_save", { targetId: player.id });
          setChatError("");
        } catch (error) {
          setChatError(error.message);
        }
      });
      actions.appendChild(saveBtn);
    }
  }

  li.appendChild(meta);
  li.appendChild(actions);
  return li;
}

function renderPlayersPanel() {
  els.gamePlayers.innerHTML = "";
  for (const player of state.players) {
    els.gamePlayers.appendChild(makePlayerRow(player));
  }
}

function renderChatArea() {
  const isMain = activeTab === "main";
  els.mainTabBtn.classList.toggle("active", isMain);
  els.dmTabBtn.classList.toggle("active", !isMain);

  els.mainChatView.classList.toggle("hidden", !isMain);
  els.dmChatWrapper.classList.toggle("hidden", isMain);

  renderMainChat();
  renderDmTargets();
  renderDmChat();
}

function renderLobbyScreen() {
  els.lobbyCode.textContent = state.lobbyCode;
  renderLobbyPlayers();

  const isHost = state.youId === state.hostId;
  els.startGameBtn.classList.toggle("hidden", !isHost);
  els.startGameBtn.disabled = state.players.length < state.minPlayers;
  if (isHost && state.players.length < state.minPlayers) {
    els.startHint.textContent = `Need ${state.minPlayers} players to start.`;
  } else if (isHost) {
    els.startHint.textContent = "You can start the game.";
  } else {
    els.startHint.textContent = "Waiting for host to start.";
  }
}

function renderLiveRoundBits() {
  if (!state || state.phase !== "in_round") {
    return;
  }

  const timeLeftMs = Math.max(0, (state.roundEndsAt || 0) - Date.now());
  els.timerValue.textContent = formatClock(timeLeftMs);

  if (state.youRole === "mafia" && state.youAreAlive) {
    const cooldownMs = currentMafiaCooldownMs();
    if (state.mafiaKillUsedThisRound) {
      els.cooldownText.textContent = "Skull action used for this round.";
    } else if (cooldownMs > 0) {
      els.cooldownText.textContent = `Skull cooldown: ${Math.ceil(cooldownMs / 1000)}s`;
    } else {
      els.cooldownText.textContent = "Skull cooldown ready.";
    }

    const killButtons = els.gamePlayers.querySelectorAll(".kill-btn");
    for (const button of killButtons) {
      if (state.pendingKillId === button.dataset.targetId) {
        button.textContent = "💀 Set";
      } else if (state.mafiaKillUsedThisRound) {
        button.textContent = "💀 Used";
      } else {
        button.textContent = "💀";
      }
      button.disabled = cooldownMs > 0 || state.mafiaKillUsedThisRound;
    }
  } else {
    els.cooldownText.textContent = "";
  }
}

function renderGameScreen() {
  els.roleValue.textContent = roleLabel(state.youRole);
  els.aliveValue.textContent = state.youAreAlive ? "Alive" : "Dead / Spectator";
  els.roundValue.textContent = state.roundNumber || "-";
  els.timerValue.textContent = state.phase === "in_round" ? formatClock(state.timeLeftMs || 0) : "00:00";
  els.winnerValue.textContent = state.winner || "None yet";

  if (!state.youAreAlive && state.revealRoles) {
    els.roleReveal.classList.remove("hidden");
    els.roleReveal.textContent = `You are eliminated. Mafia: ${state.revealRoles.mafiaName || "unknown"} | Guardian: ${
      state.revealRoles.guardianName || "unknown"
    }`;
  } else {
    els.roleReveal.classList.add("hidden");
    els.roleReveal.textContent = "";
  }

  renderPlayersPanel();
  renderChatArea();
  renderHistory();
  renderLiveRoundBits();

  els.chatInput.disabled = !state.canChat;
  if (!state.canChat) {
    setChatError("Eliminated players cannot send chat messages.");
  }
}

function render() {
  const currentName = getStoredName();
  els.nameDisplay.textContent = `Name: ${currentName || "-"}`;
  els.backendUrlInput.value = getStoredBackendUrl();
  updateBackendStatus();

  if (!state) {
    showScreen("menu");
    return;
  }

  if (state.phase === "lobby") {
    showScreen("lobby");
    renderLobbyScreen();
    return;
  }

  showScreen("game");
  renderGameScreen();
}

els.nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = cleanName(els.nameInput.value);
  if (!name) return;
  setStoredName(name);
  showNameModal(false);
  render();
});

els.changeNameBtn.addEventListener("click", () => {
  showNameModal(true);
});

els.saveBackendBtn.addEventListener("click", () => {
  const stored = setStoredBackendUrl(els.backendUrlInput.value);
  if (!stored) {
    setMenuError("Invalid backend URL.");
  } else {
    setMenuError("");
  }
  render();
});

els.createLobbyBtn.addEventListener("click", async () => {
  const name = requireName();
  if (!name || !requireBackend()) return;

  setMenuError("Creating lobby...");
  try {
    const created = await apiPost("/api/create-lobby", { name });
    await connectLobbySocket({
      code: created.code,
      playerId: created.playerId,
      sessionSecret: created.sessionSecret
    });
    setMenuError("");
  } catch (error) {
    setMenuError(error.message);
  }
});

els.joinLobbyBtn.addEventListener("click", async () => {
  const name = requireName();
  if (!name || !requireBackend()) return;

  const code = cleanCode(els.joinCodeInput.value);
  if (code.length !== 5) {
    setMenuError("Join code must be 5 characters.");
    return;
  }

  setMenuError("Joining lobby...");
  try {
    const joined = await apiPost("/api/join-lobby", { name, code });
    await connectLobbySocket({
      code: joined.code,
      playerId: joined.playerId,
      sessionSecret: joined.sessionSecret
    });
    setMenuError("");
  } catch (error) {
    setMenuError(error.message);
  }
});

els.copyCodeBtn.addEventListener("click", async () => {
  if (!state?.lobbyCode) return;
  try {
    await navigator.clipboard.writeText(state.lobbyCode);
    els.startHint.textContent = "Join code copied.";
  } catch {
    els.startHint.textContent = `Code: ${state.lobbyCode}`;
  }
});

els.startGameBtn.addEventListener("click", async () => {
  try {
    await sendAction("start_game");
    els.startHint.textContent = "";
  } catch (error) {
    els.startHint.textContent = error.message;
  }
});

els.leaveLobbyBtn.addEventListener("click", async () => {
  await leaveLobby();
});

els.leaveGameBtn.addEventListener("click", async () => {
  await leaveLobby();
});

els.mainTabBtn.addEventListener("click", () => {
  activeTab = "main";
  renderChatArea();
});

els.dmTabBtn.addEventListener("click", () => {
  activeTab = "dm";
  renderChatArea();
});

els.dmTargetSelect.addEventListener("change", () => {
  selectedDmPeerId = els.dmTargetSelect.value;
  renderDmChat();
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state) return;

  const text = String(els.chatInput.value || "").trim();
  if (!text) return;
  if (!state.canChat) {
    setChatError("Eliminated players cannot send chat messages.");
    return;
  }

  try {
    if (activeTab === "main") {
      await sendAction("send_main_message", { text });
    } else {
      if (!selectedDmPeerId) {
        setChatError("Pick a player for private chat.");
        return;
      }
      await sendAction("send_private_message", { toId: selectedDmPeerId, text });
    }
    els.chatInput.value = "";
    setChatError("");
  } catch (error) {
    setChatError(error.message);
  }
});

setInterval(() => {
  if (!state || state.phase !== "in_round") {
    return;
  }
  renderLiveRoundBits();
}, 1000);

showNameModal(false);
render();
