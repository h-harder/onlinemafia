const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 4;
const ROUND_DURATION_MS = 2 * 60 * 1000;
const MAFIA_COOLDOWN_MS = 60 * 1000;
const MAX_NAME_LEN = 24;
const MAX_CHAT_LEN = 280;
const MAX_MAIN_MESSAGES = 200;
const MAX_DM_MESSAGES = 120;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const lobbies = new Map();
const socketLobby = new Map();

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeName(rawName) {
  const name = String(rawName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN);
  return name || "Player";
}

function sanitizeCode(rawCode) {
  return String(rawCode || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function sanitizeMessage(rawMessage) {
  const text = String(rawMessage || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_LEN);
  return text;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeLobbyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = "";
    for (let i = 0; i < 5; i += 1) {
      code += chars[randomInt(chars.length)];
    }
    if (!lobbies.has(code)) {
      return code;
    }
  }
  return null;
}

function sortedPairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function createPlayer(socket, name) {
  return {
    id: socket.id,
    name,
    role: "villager",
    isAlive: true,
    joinedAt: Date.now(),
    eliminatedAt: null
  };
}

function getLobbyForSocket(socket) {
  const code = socketLobby.get(socket.id);
  if (!code) {
    return null;
  }
  return lobbies.get(code) || null;
}

function applyRoles(lobby) {
  for (const player of lobby.players.values()) {
    player.role = "villager";
  }
  if (lobby.mafiaId && lobby.players.has(lobby.mafiaId)) {
    lobby.players.get(lobby.mafiaId).role = "mafia";
  }
  if (lobby.guardianId && lobby.players.has(lobby.guardianId)) {
    lobby.players.get(lobby.guardianId).role = "guardian";
  }
}

function addSystemMessage(lobby, text) {
  const message = {
    id: makeId(),
    type: "system",
    fromId: null,
    fromName: "System",
    text,
    at: Date.now()
  };
  lobby.mainMessages.push(message);
  if (lobby.mainMessages.length > MAX_MAIN_MESSAGES) {
    lobby.mainMessages.shift();
  }
}

function addMainMessage(lobby, fromPlayer, text) {
  const message = {
    id: makeId(),
    type: "chat",
    fromId: fromPlayer.id,
    fromName: fromPlayer.name,
    text,
    at: Date.now()
  };
  lobby.mainMessages.push(message);
  if (lobby.mainMessages.length > MAX_MAIN_MESSAGES) {
    lobby.mainMessages.shift();
  }
}

function addDmMessage(lobby, fromPlayer, toPlayer, text) {
  const key = sortedPairKey(fromPlayer.id, toPlayer.id);
  const existing = lobby.dmThreads.get(key) || [];
  existing.push({
    id: makeId(),
    fromId: fromPlayer.id,
    fromName: fromPlayer.name,
    toId: toPlayer.id,
    text,
    at: Date.now()
  });
  if (existing.length > MAX_DM_MESSAGES) {
    existing.shift();
  }
  lobby.dmThreads.set(key, existing);
}

function winnerForLobby(lobby) {
  const mafia = lobby.players.get(lobby.mafiaId);
  if (!mafia || !mafia.isAlive) {
    return "Villagers";
  }
  const aliveNonMafia = [...lobby.players.values()].filter(
    (player) => player.isAlive && player.id !== lobby.mafiaId
  ).length;
  if (aliveNonMafia <= 1) {
    return "Mafia";
  }
  return null;
}

function mapHistoryEntry(lobby, entry) {
  return {
    id: entry.id,
    round: entry.round,
    killedName: entry.killedId ? lobby.players.get(entry.killedId)?.name || "Unknown" : null,
    savedName: entry.savedId ? lobby.players.get(entry.savedId)?.name || "Unknown" : null,
    eliminatedName: entry.eliminatedId
      ? lobby.players.get(entry.eliminatedId)?.name || "Unknown"
      : null,
    survivedBySaveName: entry.survivedBySaveId
      ? lobby.players.get(entry.survivedBySaveId)?.name || "Unknown"
      : null,
    at: entry.at
  };
}

function shouldRevealRoles(lobby, viewerId) {
  const viewer = lobby.players.get(viewerId);
  if (!viewer) {
    return false;
  }
  return !viewer.isAlive || lobby.phase === "ended";
}

function dmThreadsForViewer(lobby, viewerId) {
  const threads = [];
  for (const [key, messages] of lobby.dmThreads.entries()) {
    const [a, b] = key.split(":");
    if (a !== viewerId && b !== viewerId) {
      continue;
    }
    const peerId = a === viewerId ? b : a;
    const peer = lobby.players.get(peerId);
    if (!peer) {
      continue;
    }
    threads.push({
      peerId,
      peerName: peer.name,
      messages
    });
  }
  threads.sort((x, y) => {
    const xLast = x.messages.length ? x.messages[x.messages.length - 1].at : 0;
    const yLast = y.messages.length ? y.messages[y.messages.length - 1].at : 0;
    return yLast - xLast;
  });
  return threads;
}

function buildStateForViewer(lobby, viewerId) {
  const viewer = lobby.players.get(viewerId);
  if (!viewer) {
    return null;
  }

  const now = Date.now();
  const revealRoles = shouldRevealRoles(lobby, viewerId);
  const mafiaCooldownMs =
    viewerId === lobby.mafiaId && lobby.phase === "in_round"
      ? Math.max(0, MAFIA_COOLDOWN_MS - (now - lobby.lastMafiaActionAt))
      : 0;
  const mafiaKillUsedThisRound =
    viewerId === lobby.mafiaId &&
    lobby.phase === "in_round" &&
    lobby.mafiaKillRound === lobby.roundNumber;

  const players = [...lobby.players.values()]
    .map((player) => {
      let roleVisible = null;
      if (lobby.phase !== "lobby") {
        if (player.id === viewerId) {
          roleVisible = player.role;
        } else if (revealRoles && player.id === lobby.mafiaId) {
          roleVisible = "mafia";
        } else if (revealRoles && player.id === lobby.guardianId) {
          roleVisible = "guardian";
        }
      }
      return {
        id: player.id,
        name: player.name,
        isSelf: player.id === viewerId,
        isHost: player.id === lobby.hostId,
        isAlive: player.isAlive,
        roleVisible
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const revealPanel =
    revealRoles && lobby.phase !== "lobby"
      ? {
          mafiaName: lobby.mafiaId ? lobby.players.get(lobby.mafiaId)?.name || null : null,
          guardianName: lobby.guardianId ? lobby.players.get(lobby.guardianId)?.name || null : null
        }
      : null;

  return {
    lobbyCode: lobby.code,
    phase: lobby.phase,
    started: lobby.phase !== "lobby",
    minPlayers: MIN_PLAYERS,
    hostId: lobby.hostId,
    winner: lobby.winner,
    youId: viewer.id,
    youName: viewer.name,
    youRole: lobby.phase === "lobby" ? null : viewer.role,
    youAreAlive: viewer.isAlive,
    canChat: lobby.phase === "lobby" || viewer.isAlive,
    roundNumber: lobby.roundNumber,
    roundDurationMs: ROUND_DURATION_MS,
    roundEndsAt: lobby.roundEndsAt,
    timeLeftMs:
      lobby.phase === "in_round" && lobby.roundEndsAt ? Math.max(0, lobby.roundEndsAt - now) : 0,
    mafiaCooldownMs,
    mafiaKillUsedThisRound,
    pendingKillId: viewer.id === lobby.mafiaId ? lobby.pendingKillId : null,
    pendingSaveId: viewer.id === lobby.guardianId ? lobby.pendingSaveId : null,
    players,
    mainMessages: lobby.mainMessages,
    dmThreads: dmThreadsForViewer(lobby, viewerId),
    history: lobby.history.map((entry) => mapHistoryEntry(lobby, entry)),
    revealRoles: revealPanel
  };
}

function emitLobbyState(lobby) {
  for (const playerId of lobby.players.keys()) {
    const state = buildStateForViewer(lobby, playerId);
    if (state) {
      io.to(playerId).emit("state", state);
    }
  }
}

function buildRoundResultForViewer(lobby, viewerId, summary) {
  const viewer = lobby.players.get(viewerId);
  const revealRoles = viewer && !viewer.isAlive;
  return {
    round: summary.round,
    killedName: summary.killedId ? lobby.players.get(summary.killedId)?.name || null : null,
    savedName: summary.savedId ? lobby.players.get(summary.savedId)?.name || null : null,
    eliminatedName: summary.eliminatedId
      ? lobby.players.get(summary.eliminatedId)?.name || null
      : null,
    survivedBySaveName: summary.survivedBySaveId
      ? lobby.players.get(summary.survivedBySaveId)?.name || null
      : null,
    youWereEliminated: summary.eliminatedId === viewerId,
    revealRoles:
      revealRoles && lobby.phase !== "lobby"
        ? {
            mafiaName: lobby.mafiaId ? lobby.players.get(lobby.mafiaId)?.name || null : null,
            guardianName: lobby.guardianId
              ? lobby.players.get(lobby.guardianId)?.name || null
              : null
          }
        : null
  };
}

function alivePlayerIds(lobby) {
  return [...lobby.players.values()].filter((player) => player.isAlive).map((player) => player.id);
}

function ensureRolesAfterDeparture(lobby) {
  if (lobby.phase === "lobby") {
    return;
  }

  if (lobby.mafiaId && !lobby.players.has(lobby.mafiaId)) {
    lobby.mafiaId = null;
  }
  if (lobby.guardianId && !lobby.players.has(lobby.guardianId)) {
    lobby.guardianId = null;
  }

  const aliveIds = alivePlayerIds(lobby);
  if (!lobby.mafiaId) {
    const mafiaCandidates = aliveIds.filter((id) => id !== lobby.guardianId);
    lobby.mafiaId = mafiaCandidates.length ? mafiaCandidates[randomInt(mafiaCandidates.length)] : null;
  }
  if (!lobby.guardianId) {
    const guardianCandidates = aliveIds.filter((id) => id !== lobby.mafiaId);
    lobby.guardianId = guardianCandidates.length
      ? guardianCandidates[randomInt(guardianCandidates.length)]
      : null;
  }
  applyRoles(lobby);
}

function removeSocketFromLobby(socket) {
  const code = socketLobby.get(socket.id);
  if (!code) {
    return;
  }

  socketLobby.delete(socket.id);
  socket.leave(code);

  const lobby = lobbies.get(code);
  if (!lobby) {
    return;
  }

  const leavingPlayer = lobby.players.get(socket.id);
  if (!leavingPlayer) {
    return;
  }

  const leavingName = leavingPlayer.name;
  const wasHost = lobby.hostId === socket.id;
  const wasMafia = lobby.mafiaId === socket.id;
  const wasGuardian = lobby.guardianId === socket.id;

  lobby.players.delete(socket.id);
  if (lobby.players.size === 0) {
    lobbies.delete(code);
    return;
  }

  if (wasHost) {
    lobby.hostId = [...lobby.players.keys()][0];
  }
  if (wasMafia) {
    lobby.mafiaId = null;
  }
  if (wasGuardian) {
    lobby.guardianId = null;
  }

  ensureRolesAfterDeparture(lobby);
  if (lobby.phase !== "lobby") {
    const winner = winnerForLobby(lobby);
    if (winner) {
      lobby.phase = "ended";
      lobby.winner = winner;
      lobby.roundEndsAt = null;
    }
  }

  addSystemMessage(lobby, `${leavingName} left the lobby.`);
  emitLobbyState(lobby);
}

function startGame(lobby) {
  const playerIds = shuffle([...lobby.players.keys()]);
  lobby.mafiaId = playerIds[0] || null;
  lobby.guardianId = playerIds[1] || null;
  for (const player of lobby.players.values()) {
    player.isAlive = true;
    player.eliminatedAt = null;
  }
  applyRoles(lobby);

  lobby.phase = "in_round";
  lobby.winner = null;
  lobby.roundNumber = 1;
  lobby.roundEndsAt = Date.now() + ROUND_DURATION_MS;
  lobby.lastMafiaActionAt = 0;
  lobby.mafiaKillRound = 0;
  lobby.pendingKillId = null;
  lobby.pendingSaveId = null;
  lobby.history = [];
  lobby.dmThreads = new Map();
  lobby.mainMessages = [];

  addSystemMessage(
    lobby,
    "Game started. You can chat in public and private. Rounds are 2 minutes."
  );
}

function finishRound(lobby) {
  if (lobby.phase !== "in_round") {
    return;
  }

  const now = Date.now();
  let killedId = lobby.pendingKillId;
  let savedId = lobby.pendingSaveId;

  if (!killedId || !lobby.players.get(killedId)?.isAlive) {
    killedId = null;
  }
  if (!savedId || !lobby.players.get(savedId)?.isAlive) {
    savedId = null;
  }

  let eliminatedId = null;
  let survivedBySaveId = null;
  if (killedId && killedId === savedId) {
    survivedBySaveId = killedId;
  } else if (killedId) {
    const target = lobby.players.get(killedId);
    if (target && target.isAlive) {
      target.isAlive = false;
      target.eliminatedAt = now;
      eliminatedId = target.id;
    }
  }

  const summary = {
    id: makeId(),
    round: lobby.roundNumber,
    killedId,
    savedId,
    eliminatedId,
    survivedBySaveId,
    at: now
  };
  lobby.history.push(summary);
  lobby.pendingKillId = null;
  lobby.pendingSaveId = null;

  const killedName = killedId ? lobby.players.get(killedId)?.name || "Unknown" : "No one";
  const savedName = savedId ? lobby.players.get(savedId)?.name || "No one" : "No one";
  addSystemMessage(lobby, `Round ${summary.round} ended. Killed: ${killedName}. Saved: ${savedName}.`);

  const winner = winnerForLobby(lobby);
  if (winner) {
    lobby.phase = "ended";
    lobby.winner = winner;
    lobby.roundEndsAt = null;
    addSystemMessage(lobby, `${winner} win.`);
  } else {
    lobby.roundNumber += 1;
    lobby.roundEndsAt = now + ROUND_DURATION_MS;
  }

  emitLobbyState(lobby);
  for (const playerId of lobby.players.keys()) {
    io.to(playerId).emit("round_result", buildRoundResultForViewer(lobby, playerId, summary));
  }
}

io.on("connection", (socket) => {
  socket.on("create_lobby", (payload, ack = () => {}) => {
    removeSocketFromLobby(socket);

    const name = sanitizeName(payload?.name);
    const code = makeLobbyCode();
    if (!code) {
      ack({ ok: false, error: "Failed to create a lobby code. Try again." });
      return;
    }

    const player = createPlayer(socket, name);
    const lobby = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, player]]),
      phase: "lobby",
      winner: null,
      roundNumber: 0,
      roundEndsAt: null,
      lastMafiaActionAt: 0,
      mafiaKillRound: 0,
      mafiaId: null,
      guardianId: null,
      pendingKillId: null,
      pendingSaveId: null,
      mainMessages: [],
      dmThreads: new Map(),
      history: []
    };

    lobbies.set(code, lobby);
    socketLobby.set(socket.id, code);
    socket.join(code);

    addSystemMessage(lobby, `${name} created lobby ${code}.`);
    emitLobbyState(lobby);
    ack({ ok: true, code });
  });

  socket.on("join_lobby", (payload, ack = () => {}) => {
    removeSocketFromLobby(socket);

    const code = sanitizeCode(payload?.code);
    const name = sanitizeName(payload?.name);
    const lobby = lobbies.get(code);
    if (!lobby) {
      ack({ ok: false, error: "Lobby code not found." });
      return;
    }
    if (lobby.phase !== "lobby") {
      ack({ ok: false, error: "Game already started. Join before the host starts." });
      return;
    }

    const player = createPlayer(socket, name);
    lobby.players.set(socket.id, player);
    socketLobby.set(socket.id, code);
    socket.join(code);

    addSystemMessage(lobby, `${name} joined the lobby.`);
    emitLobbyState(lobby);
    ack({ ok: true, code });
  });

  socket.on("leave_lobby", (_payload, ack = () => {}) => {
    removeSocketFromLobby(socket);
    ack({ ok: true });
  });

  socket.on("start_game", (_payload, ack = () => {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) {
      ack({ ok: false, error: "Join a lobby first." });
      return;
    }
    if (lobby.hostId !== socket.id) {
      ack({ ok: false, error: "Only the host can start the game." });
      return;
    }
    if (lobby.phase !== "lobby") {
      ack({ ok: false, error: "Game already started." });
      return;
    }
    if (lobby.players.size < MIN_PLAYERS) {
      ack({ ok: false, error: `Need at least ${MIN_PLAYERS} players to start.` });
      return;
    }

    startGame(lobby);
    emitLobbyState(lobby);
    ack({ ok: true });
  });

  socket.on("send_main_message", (payload, ack = () => {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) {
      ack({ ok: false, error: "Join a lobby first." });
      return;
    }
    const sender = lobby.players.get(socket.id);
    if (!sender) {
      ack({ ok: false, error: "Player not found in lobby." });
      return;
    }
    if (lobby.phase !== "lobby" && !sender.isAlive) {
      ack({ ok: false, error: "Eliminated players cannot send chat messages." });
      return;
    }

    const text = sanitizeMessage(payload?.text);
    if (!text) {
      ack({ ok: false, error: "Message is empty." });
      return;
    }
    addMainMessage(lobby, sender, text);
    emitLobbyState(lobby);
    ack({ ok: true });
  });

  socket.on("send_private_message", (payload, ack = () => {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) {
      ack({ ok: false, error: "Join a lobby first." });
      return;
    }

    const sender = lobby.players.get(socket.id);
    if (!sender) {
      ack({ ok: false, error: "Player not found in lobby." });
      return;
    }
    if (lobby.phase !== "lobby" && !sender.isAlive) {
      ack({ ok: false, error: "Eliminated players cannot send chat messages." });
      return;
    }

    const toId = String(payload?.toId || "");
    const recipient = lobby.players.get(toId);
    if (!recipient || recipient.id === sender.id) {
      ack({ ok: false, error: "Select a valid player for private chat." });
      return;
    }

    const text = sanitizeMessage(payload?.text);
    if (!text) {
      ack({ ok: false, error: "Message is empty." });
      return;
    }

    addDmMessage(lobby, sender, recipient, text);
    emitLobbyState(lobby);
    ack({ ok: true });
  });

  socket.on("mafia_kill", (payload, ack = () => {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) {
      ack({ ok: false, error: "Join a lobby first." });
      return;
    }
    if (lobby.phase !== "in_round") {
      ack({ ok: false, error: "Kills can only happen during a live round." });
      return;
    }

    const mafia = lobby.players.get(socket.id);
    if (!mafia || mafia.id !== lobby.mafiaId || !mafia.isAlive) {
      ack({ ok: false, error: "Only the alive mafia can use this action." });
      return;
    }
    if (lobby.mafiaKillRound === lobby.roundNumber) {
      ack({ ok: false, error: "Mafia can only pick one kill target per round." });
      return;
    }

    const cooldownMs = Math.max(0, MAFIA_COOLDOWN_MS - (Date.now() - lobby.lastMafiaActionAt));
    if (cooldownMs > 0) {
      ack({ ok: false, error: `Skull cooldown active (${Math.ceil(cooldownMs / 1000)}s left).` });
      return;
    }

    const targetId = String(payload?.targetId || "");
    const target = lobby.players.get(targetId);
    if (!target || !target.isAlive || target.id === mafia.id) {
      ack({ ok: false, error: "Pick an alive target other than yourself." });
      return;
    }

    lobby.pendingKillId = targetId;
    lobby.lastMafiaActionAt = Date.now();
    lobby.mafiaKillRound = lobby.roundNumber;
    emitLobbyState(lobby);
    ack({ ok: true });
  });

  socket.on("guardian_save", (payload, ack = () => {}) => {
    const lobby = getLobbyForSocket(socket);
    if (!lobby) {
      ack({ ok: false, error: "Join a lobby first." });
      return;
    }
    if (lobby.phase !== "in_round") {
      ack({ ok: false, error: "Saves can only happen during a live round." });
      return;
    }

    const guardian = lobby.players.get(socket.id);
    if (!guardian || guardian.id !== lobby.guardianId || !guardian.isAlive) {
      ack({ ok: false, error: "Only the alive guardian angel can use this action." });
      return;
    }

    const targetId = String(payload?.targetId || "");
    const target = lobby.players.get(targetId);
    if (!target || !target.isAlive) {
      ack({ ok: false, error: "Pick an alive target to save." });
      return;
    }

    lobby.pendingSaveId = targetId;
    emitLobbyState(lobby);
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    removeSocketFromLobby(socket);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const lobby of lobbies.values()) {
    if (lobby.phase === "in_round" && lobby.roundEndsAt && now >= lobby.roundEndsAt) {
      finishRound(lobby);
      continue;
    }
    if (lobby.phase === "in_round") {
      emitLobbyState(lobby);
    }
  }
}, 1000);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Texting Mafia listening on http://localhost:${PORT}`);
});
