const socket = io();

const STORAGE_NAME_KEY = "texting_mafia_name";

let state = null;
let activeTab = "main";
let selectedDmPeerId = null;

const els = {
  nameModal: document.getElementById("name-modal"),
  nameForm: document.getElementById("name-form"),
  nameInput: document.getElementById("name-input"),
  nameDisplay: document.getElementById("name-display"),
  changeNameBtn: document.getElementById("change-name-btn"),

  menuScreen: document.getElementById("menu-screen"),
  lobbyScreen: document.getElementById("lobby-screen"),
  gameScreen: document.getElementById("game-screen"),

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

function getStoredName() {
  return (localStorage.getItem(STORAGE_NAME_KEY) || "").trim();
}

function setStoredName(name) {
  localStorage.setItem(STORAGE_NAME_KEY, name);
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
  const total = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
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

function requireName() {
  const name = getStoredName();
  if (!name) {
    showNameModal(true);
    setMenuError("Set your name first.");
    return null;
  }
  return name;
}

function showScreen(screen) {
  els.menuScreen.classList.toggle("hidden", screen !== "menu");
  els.lobbyScreen.classList.toggle("hidden", screen !== "lobby");
  els.gameScreen.classList.toggle("hidden", screen !== "game");
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
    const empty = document.createElement("li");
    empty.textContent = "No rounds ended yet.";
    els.historyList.appendChild(empty);
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
    li.textContent = `${parts.join(" | ")}`;
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
      const killBtn = document.createElement("button");
      killBtn.className = "small-btn kill-btn";
      if (state.pendingKillId === player.id) {
        killBtn.textContent = "💀 Set";
      } else if (state.mafiaKillUsedThisRound) {
        killBtn.textContent = "💀 Used";
      } else {
        killBtn.textContent = "💀";
      }
      killBtn.disabled = state.mafiaCooldownMs > 0 || state.mafiaKillUsedThisRound;
      killBtn.addEventListener("click", () => {
        socket.emit("mafia_kill", { targetId: player.id }, (response) => {
          if (!response?.ok) setChatError(response?.error || "Kill action failed.");
        });
      });
      actions.appendChild(killBtn);
    }

    if (state.youRole === "guardian") {
      const saveBtn = document.createElement("button");
      saveBtn.className = "small-btn save-btn";
      saveBtn.textContent = state.pendingSaveId === player.id ? "🙏 Set" : "🙏";
      saveBtn.addEventListener("click", () => {
        socket.emit("guardian_save", { targetId: player.id }, (response) => {
          if (!response?.ok) setChatError(response?.error || "Save action failed.");
        });
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

function renderGameScreen() {
  els.roleValue.textContent = roleLabel(state.youRole);
  els.aliveValue.textContent = state.youAreAlive ? "Alive" : "Dead / Spectator";
  els.roundValue.textContent = state.roundNumber || "-";
  els.timerValue.textContent = formatClock(state.timeLeftMs || 0);
  els.winnerValue.textContent = state.winner || "None yet";

  if (state.youRole === "mafia" && state.youAreAlive && state.phase === "in_round") {
    const cooldown = state.mafiaCooldownMs || 0;
    if (state.mafiaKillUsedThisRound) {
      els.cooldownText.textContent = "Skull action used for this round.";
    } else {
      els.cooldownText.textContent =
        cooldown > 0 ? `Skull cooldown: ${Math.ceil(cooldown / 1000)}s` : "Skull cooldown ready.";
    }
  } else {
    els.cooldownText.textContent = "";
  }

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

  els.chatInput.disabled = !state.canChat;
  if (!state.canChat) {
    setChatError("Eliminated players cannot send chat messages.");
  }
}

function render() {
  const currentName = getStoredName();
  els.nameDisplay.textContent = `Name: ${currentName || "-"}`;

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

els.createLobbyBtn.addEventListener("click", () => {
  const name = requireName();
  if (!name) return;
  setMenuError("");
  socket.emit("create_lobby", { name }, (response) => {
    if (!response?.ok) {
      setMenuError(response?.error || "Could not create lobby.");
    }
  });
});

els.joinLobbyBtn.addEventListener("click", () => {
  const name = requireName();
  if (!name) return;
  const code = cleanCode(els.joinCodeInput.value);
  if (code.length !== 5) {
    setMenuError("Join code must be 5 characters.");
    return;
  }
  setMenuError("");
  socket.emit("join_lobby", { name, code }, (response) => {
    if (!response?.ok) {
      setMenuError(response?.error || "Could not join lobby.");
    }
  });
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

els.startGameBtn.addEventListener("click", () => {
  socket.emit("start_game", {}, (response) => {
    if (!response?.ok) {
      els.startHint.textContent = response?.error || "Could not start game.";
    }
  });
});

els.leaveLobbyBtn.addEventListener("click", () => {
  socket.emit("leave_lobby", {}, () => {
    state = null;
    setChatError("");
    render();
  });
});

els.leaveGameBtn.addEventListener("click", () => {
  socket.emit("leave_lobby", {}, () => {
    state = null;
    activeTab = "main";
    selectedDmPeerId = null;
    setChatError("");
    render();
  });
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

els.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state) return;

  const text = String(els.chatInput.value || "").trim();
  if (!text) return;
  if (!state.canChat) {
    setChatError("Eliminated players cannot send chat messages.");
    return;
  }

  const clearOnSuccess = (response) => {
    if (!response?.ok) {
      setChatError(response?.error || "Message failed.");
      return;
    }
    els.chatInput.value = "";
    setChatError("");
  };

  if (activeTab === "main") {
    socket.emit("send_main_message", { text }, clearOnSuccess);
    return;
  }

  if (!selectedDmPeerId) {
    setChatError("Pick a player for private chat.");
    return;
  }
  socket.emit("send_private_message", { toId: selectedDmPeerId, text }, clearOnSuccess);
});

socket.on("state", (nextState) => {
  state = nextState;
  if (state?.players) {
    const canKeepDm = state.players.some((player) => player.id === selectedDmPeerId && !player.isSelf);
    if (!canKeepDm) {
      selectedDmPeerId = null;
    }
  }
  render();
});

socket.on("round_result", (result) => {
  if (!result) return;
  if (result.youWereEliminated) {
    setChatError("You were eliminated this round.");
  }
});

socket.on("disconnect", () => {
  setMenuError("Disconnected from server. Reconnecting...");
});

socket.on("connect", () => {
  setMenuError("");
});

showNameModal(false);
render();
