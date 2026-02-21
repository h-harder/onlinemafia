import { DurableObject } from "cloudflare:workers";

const MIN_PLAYERS = 4;
const ROUND_DURATION_MS = 2 * 60 * 1000;
const MAFIA_COOLDOWN_MS = 60 * 1000;
const MAX_NAME_LEN = 24;
const MAX_CHAT_LEN = 280;
const MAX_MAIN_MESSAGES = 200;
const MAX_DM_MESSAGES = 120;

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function jsonResponse(payload, status = 200, addCors = false) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (addCors) {
    Object.assign(headers, CORS_HEADERS);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function emptyResponse(status = 204, addCors = false) {
  const headers = addCors ? CORS_HEADERS : {};
  return new Response(null, { status, headers });
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function makeId() {
  return crypto.randomUUID();
}

function makeSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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
  return String(rawMessage || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHAT_LEN);
}

function sortedPairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function randomCode() {
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  }
  return code;
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function wsDataToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer);
  }
  return "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return emptyResponse(204, true);
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ ok: true }, 200, true);
    }

    if (request.method === "POST" && url.pathname === "/api/create-lobby") {
      const body = await parseJson(request);
      const name = sanitizeName(body?.name);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        const code = randomCode();
        const id = env.TEXTING_MAFIA_LOBBY.idFromName(code);
        const stub = env.TEXTING_MAFIA_LOBBY.get(id);

        const initRes = await stub.fetch(
          "https://lobby.internal/internal/init",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code })
          }
        );

        if (initRes.status === 409) {
          continue;
        }
        if (!initRes.ok) {
          return jsonResponse({ ok: false, error: "Failed to initialize lobby." }, 500, true);
        }

        const joinRes = await stub.fetch(
          "https://lobby.internal/internal/join",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name })
          }
        );
        const joinBody = await parseJson(joinRes);
        return jsonResponse(joinBody || { ok: false, error: "Join failed." }, joinRes.status, true);
      }

      return jsonResponse(
        { ok: false, error: "Could not create a unique lobby code. Try again." },
        500,
        true
      );
    }

    if (request.method === "POST" && url.pathname === "/api/join-lobby") {
      const body = await parseJson(request);
      const code = sanitizeCode(body?.code);
      const name = sanitizeName(body?.name);
      if (code.length !== 5) {
        return jsonResponse({ ok: false, error: "Lobby code must be 5 characters." }, 400, true);
      }

      const id = env.TEXTING_MAFIA_LOBBY.idFromName(code);
      const stub = env.TEXTING_MAFIA_LOBBY.get(id);
      const joinRes = await stub.fetch(
        "https://lobby.internal/internal/join",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name })
        }
      );
      const joinBody = await parseJson(joinRes);
      return jsonResponse(joinBody || { ok: false, error: "Join failed." }, joinRes.status, true);
    }

    if (url.pathname.startsWith("/ws/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const code = sanitizeCode(url.pathname.slice("/ws/".length));
      if (code.length !== 5) {
        return new Response("Invalid lobby code", { status: 400 });
      }

      const id = env.TEXTING_MAFIA_LOBBY.idFromName(code);
      const stub = env.TEXTING_MAFIA_LOBBY.get(id);
      const doUrl = new URL(request.url);
      doUrl.hostname = "lobby.internal";
      doUrl.pathname = "/internal/ws";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return jsonResponse({ ok: false, error: "Not found." }, 404, true);
  }
};

export class LobbyRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.stateData = null;
    this.initPromise = this.ctx.blockConcurrencyWhile(async () => {
      this.stateData = (await this.ctx.storage.get("state")) || null;
    });
  }

  async ensureLoaded() {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  async saveState() {
    if (this.stateData === null) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put("state", this.stateData);
  }

  playersObject() {
    return this.stateData?.players || {};
  }

  playerEntries() {
    return Object.values(this.playersObject());
  }

  playerIds() {
    return Object.keys(this.playersObject());
  }

  playerById(playerId) {
    return this.playersObject()[playerId] || null;
  }

  hasLobby() {
    return !!this.stateData;
  }

  addSystemMessage(text) {
    const message = {
      id: makeId(),
      type: "system",
      fromId: null,
      fromName: "System",
      text,
      at: Date.now()
    };
    this.stateData.mainMessages.push(message);
    if (this.stateData.mainMessages.length > MAX_MAIN_MESSAGES) {
      this.stateData.mainMessages.shift();
    }
  }

  addMainMessage(fromPlayer, text) {
    const message = {
      id: makeId(),
      type: "chat",
      fromId: fromPlayer.id,
      fromName: fromPlayer.name,
      text,
      at: Date.now()
    };
    this.stateData.mainMessages.push(message);
    if (this.stateData.mainMessages.length > MAX_MAIN_MESSAGES) {
      this.stateData.mainMessages.shift();
    }
  }

  addDmMessage(fromPlayer, toPlayer, text) {
    const key = sortedPairKey(fromPlayer.id, toPlayer.id);
    const current = this.stateData.dmThreads[key] || [];
    current.push({
      id: makeId(),
      fromId: fromPlayer.id,
      fromName: fromPlayer.name,
      toId: toPlayer.id,
      text,
      at: Date.now()
    });
    if (current.length > MAX_DM_MESSAGES) {
      current.shift();
    }
    this.stateData.dmThreads[key] = current;
  }

  applyRoles() {
    const players = this.playersObject();
    for (const player of Object.values(players)) {
      player.role = "villager";
    }
    if (this.stateData.mafiaId && players[this.stateData.mafiaId]) {
      players[this.stateData.mafiaId].role = "mafia";
    }
    if (this.stateData.guardianId && players[this.stateData.guardianId]) {
      players[this.stateData.guardianId].role = "guardian";
    }
  }

  alivePlayerIds() {
    return this.playerEntries()
      .filter((player) => player.isAlive)
      .map((player) => player.id);
  }

  winnerForLobby() {
    const mafia = this.playerById(this.stateData.mafiaId);
    if (!mafia || !mafia.isAlive) {
      return "Villagers";
    }
    const aliveNonMafia = this.playerEntries().filter(
      (player) => player.isAlive && player.id !== this.stateData.mafiaId
    ).length;
    if (aliveNonMafia <= 1) {
      return "Mafia";
    }
    return null;
  }

  ensureRolesAfterDeparture() {
    if (this.stateData.phase === "lobby") {
      return;
    }

    const players = this.playersObject();
    if (this.stateData.mafiaId && !players[this.stateData.mafiaId]) {
      this.stateData.mafiaId = null;
    }
    if (this.stateData.guardianId && !players[this.stateData.guardianId]) {
      this.stateData.guardianId = null;
    }

    const aliveIds = this.alivePlayerIds();
    if (!this.stateData.mafiaId) {
      const candidates = aliveIds.filter((id) => id !== this.stateData.guardianId);
      this.stateData.mafiaId = candidates.length ? candidates[randomInt(candidates.length)] : null;
    }
    if (!this.stateData.guardianId) {
      const candidates = aliveIds.filter((id) => id !== this.stateData.mafiaId);
      this.stateData.guardianId = candidates.length ? candidates[randomInt(candidates.length)] : null;
    }

    this.applyRoles();
  }

  mapHistoryEntry(entry) {
    return {
      id: entry.id,
      round: entry.round,
      killedName: entry.killedId ? this.playerById(entry.killedId)?.name || "Unknown" : null,
      savedName: entry.savedId ? this.playerById(entry.savedId)?.name || "Unknown" : null,
      eliminatedName: entry.eliminatedId
        ? this.playerById(entry.eliminatedId)?.name || "Unknown"
        : null,
      survivedBySaveName: entry.survivedBySaveId
        ? this.playerById(entry.survivedBySaveId)?.name || "Unknown"
        : null,
      at: entry.at
    };
  }

  dmThreadsForViewer(viewerId) {
    const threads = [];
    for (const [key, messages] of Object.entries(this.stateData.dmThreads)) {
      const [a, b] = key.split(":");
      if (a !== viewerId && b !== viewerId) {
        continue;
      }
      const peerId = a === viewerId ? b : a;
      const peer = this.playerById(peerId);
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
      const xAt = x.messages.length ? x.messages[x.messages.length - 1].at : 0;
      const yAt = y.messages.length ? y.messages[y.messages.length - 1].at : 0;
      return yAt - xAt;
    });
    return threads;
  }

  shouldRevealRoles(viewer) {
    return !viewer.isAlive || this.stateData.phase === "ended";
  }

  buildStateForViewer(viewerId) {
    const viewer = this.playerById(viewerId);
    if (!viewer) {
      return null;
    }

    const now = Date.now();
    const revealRoles = this.shouldRevealRoles(viewer);
    const mafiaCooldownEndsAt =
      viewerId === this.stateData.mafiaId && this.stateData.phase === "in_round"
        ? this.stateData.lastMafiaActionAt + MAFIA_COOLDOWN_MS
        : 0;
    const mafiaCooldownMs = Math.max(0, mafiaCooldownEndsAt - now);
    const mafiaKillUsedThisRound =
      viewerId === this.stateData.mafiaId &&
      this.stateData.phase === "in_round" &&
      this.stateData.mafiaKillRound === this.stateData.roundNumber;

    const players = this.playerEntries()
      .map((player) => {
        let roleVisible = null;
        if (this.stateData.phase !== "lobby") {
          if (player.id === viewerId) {
            roleVisible = player.role;
          } else if (revealRoles && player.id === this.stateData.mafiaId) {
            roleVisible = "mafia";
          } else if (revealRoles && player.id === this.stateData.guardianId) {
            roleVisible = "guardian";
          }
        }
        return {
          id: player.id,
          name: player.name,
          isSelf: player.id === viewerId,
          isHost: player.id === this.stateData.hostId,
          isAlive: player.isAlive,
          roleVisible
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      lobbyCode: this.stateData.code,
      phase: this.stateData.phase,
      started: this.stateData.phase !== "lobby",
      minPlayers: MIN_PLAYERS,
      hostId: this.stateData.hostId,
      winner: this.stateData.winner,
      youId: viewer.id,
      youName: viewer.name,
      youRole: this.stateData.phase === "lobby" ? null : viewer.role,
      youAreAlive: viewer.isAlive,
      canChat: this.stateData.phase === "lobby" || viewer.isAlive,
      roundNumber: this.stateData.roundNumber,
      roundDurationMs: ROUND_DURATION_MS,
      roundEndsAt: this.stateData.roundEndsAt,
      timeLeftMs:
        this.stateData.phase === "in_round" && this.stateData.roundEndsAt
          ? Math.max(0, this.stateData.roundEndsAt - now)
          : 0,
      mafiaCooldownMs,
      mafiaCooldownEndsAt,
      mafiaKillUsedThisRound,
      pendingKillId: viewer.id === this.stateData.mafiaId ? this.stateData.pendingKillId : null,
      pendingSaveId: viewer.id === this.stateData.guardianId ? this.stateData.pendingSaveId : null,
      players,
      mainMessages: this.stateData.mainMessages,
      dmThreads: this.dmThreadsForViewer(viewerId),
      history: this.stateData.history.map((entry) => this.mapHistoryEntry(entry)),
      revealRoles:
        revealRoles && this.stateData.phase !== "lobby"
          ? {
              mafiaName: this.playerById(this.stateData.mafiaId)?.name || null,
              guardianName: this.playerById(this.stateData.guardianId)?.name || null
            }
          : null
    };
  }

  buildRoundResultForViewer(viewerId, summary) {
    const viewer = this.playerById(viewerId);
    const revealRoles = viewer ? !viewer.isAlive : false;
    return {
      round: summary.round,
      killedName: summary.killedId ? this.playerById(summary.killedId)?.name || null : null,
      savedName: summary.savedId ? this.playerById(summary.savedId)?.name || null : null,
      eliminatedName: summary.eliminatedId
        ? this.playerById(summary.eliminatedId)?.name || null
        : null,
      survivedBySaveName: summary.survivedBySaveId
        ? this.playerById(summary.survivedBySaveId)?.name || null
        : null,
      youWereEliminated: summary.eliminatedId === viewerId,
      revealRoles:
        revealRoles && this.stateData.phase !== "lobby"
          ? {
              mafiaName: this.playerById(this.stateData.mafiaId)?.name || null,
              guardianName: this.playerById(this.stateData.guardianId)?.name || null
            }
          : null
    };
  }

  socketsForPlayer(playerId) {
    return this.ctx.getWebSockets(`player:${playerId}`);
  }

  anyOpenSocketForPlayer(playerId) {
    return this.socketsForPlayer(playerId).some((socket) => socket.readyState === 1);
  }

  sendToSocket(socket, payload) {
    if (socket.readyState !== 1) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // Ignore transient socket write errors.
    }
  }

  sendToPlayer(playerId, payload) {
    for (const socket of this.socketsForPlayer(playerId)) {
      this.sendToSocket(socket, payload);
    }
  }

  broadcastState() {
    for (const playerId of this.playerIds()) {
      const state = this.buildStateForViewer(playerId);
      if (state) {
        this.sendToPlayer(playerId, { type: "state", state });
      }
    }
  }

  sendRoundResult(summary) {
    for (const playerId of this.playerIds()) {
      this.sendToPlayer(playerId, {
        type: "round_result",
        result: this.buildRoundResultForViewer(playerId, summary)
      });
    }
  }

  async removePlayer(playerId, reasonText) {
    const players = this.playersObject();
    const leaving = players[playerId];
    if (!leaving) {
      return;
    }

    delete players[playerId];
    if (Object.keys(players).length === 0) {
      this.stateData = null;
      await this.saveState();
      return;
    }

    if (this.stateData.hostId === playerId) {
      this.stateData.hostId = Object.keys(players)[0];
    }
    if (this.stateData.mafiaId === playerId) {
      this.stateData.mafiaId = null;
    }
    if (this.stateData.guardianId === playerId) {
      this.stateData.guardianId = null;
    }
    if (this.stateData.pendingKillId === playerId) {
      this.stateData.pendingKillId = null;
    }
    if (this.stateData.pendingSaveId === playerId) {
      this.stateData.pendingSaveId = null;
    }

    this.ensureRolesAfterDeparture();
    if (this.stateData.phase !== "lobby") {
      const winner = this.winnerForLobby();
      if (winner) {
        this.stateData.phase = "ended";
        this.stateData.winner = winner;
        this.stateData.roundEndsAt = null;
        await this.ctx.storage.deleteAlarm();
      }
    }

    this.addSystemMessage(`${leaving.name} ${reasonText}.`);
    await this.saveState();
    this.broadcastState();
  }

  startGame() {
    const ids = this.playerIds();
    for (let i = ids.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    this.stateData.mafiaId = ids[0] || null;
    this.stateData.guardianId = ids[1] || null;
    for (const player of this.playerEntries()) {
      player.isAlive = true;
      player.eliminatedAt = null;
      player.role = "villager";
    }
    this.applyRoles();

    const now = Date.now();
    this.stateData.phase = "in_round";
    this.stateData.winner = null;
    this.stateData.roundNumber = 1;
    this.stateData.roundEndsAt = now + ROUND_DURATION_MS;
    this.stateData.lastMafiaActionAt = 0;
    this.stateData.mafiaKillRound = 0;
    this.stateData.pendingKillId = null;
    this.stateData.pendingSaveId = null;
    this.stateData.mainMessages = [];
    this.stateData.dmThreads = {};
    this.stateData.history = [];

    this.addSystemMessage(
      "Game started. You can chat in public and private. Rounds are 2 minutes."
    );
  }

  async finishRound() {
    if (this.stateData.phase !== "in_round") {
      return;
    }

    const now = Date.now();
    let killedId = this.stateData.pendingKillId;
    let savedId = this.stateData.pendingSaveId;

    if (!killedId || !this.playerById(killedId)?.isAlive) {
      killedId = null;
    }
    if (!savedId || !this.playerById(savedId)?.isAlive) {
      savedId = null;
    }

    let eliminatedId = null;
    let survivedBySaveId = null;
    if (killedId && savedId && killedId === savedId) {
      survivedBySaveId = killedId;
    } else if (killedId) {
      const target = this.playerById(killedId);
      if (target && target.isAlive) {
        target.isAlive = false;
        target.eliminatedAt = now;
        eliminatedId = target.id;
      }
    }

    const summary = {
      id: makeId(),
      round: this.stateData.roundNumber,
      killedId,
      savedId,
      eliminatedId,
      survivedBySaveId,
      at: now
    };
    this.stateData.history.push(summary);
    this.stateData.pendingKillId = null;
    this.stateData.pendingSaveId = null;
    this.stateData.mafiaKillRound = 0;

    const killedName = killedId ? this.playerById(killedId)?.name || "Unknown" : "No one";
    const savedName = savedId ? this.playerById(savedId)?.name || "Unknown" : "No one";
    this.addSystemMessage(
      `Round ${summary.round} ended. Killed: ${killedName}. Saved: ${savedName}.`
    );

    const winner = this.winnerForLobby();
    if (winner) {
      this.stateData.phase = "ended";
      this.stateData.winner = winner;
      this.stateData.roundEndsAt = null;
      this.addSystemMessage(`${winner} win.`);
      await this.ctx.storage.deleteAlarm();
    } else {
      this.stateData.roundNumber += 1;
      this.stateData.roundEndsAt = now + ROUND_DURATION_MS;
      await this.ctx.storage.setAlarm(this.stateData.roundEndsAt);
    }

    await this.saveState();
    this.broadcastState();
    this.sendRoundResult(summary);
  }

  ack(socket, reqId, payload) {
    if (!reqId) {
      return;
    }
    this.sendToSocket(socket, { type: "ack", reqId, ...payload });
  }

  async handleAction(socket, playerId, message) {
    const reqId = typeof message.reqId === "string" ? message.reqId : null;
    const player = this.playerById(playerId);
    if (!player) {
      this.sendToSocket(socket, { type: "session_invalid", error: "Session no longer exists." });
      try {
        socket.close(1008, "Invalid session");
      } catch {
        // Ignore close errors.
      }
      return;
    }

    const action = String(message.type || "");
    if (!action || action === "ack") {
      this.ack(socket, reqId, { ok: false, error: "Invalid action." });
      return;
    }

    if (action === "leave_lobby") {
      await this.removePlayer(playerId, "left the lobby");
      this.ack(socket, reqId, { ok: true });
      socket.serializeAttachment({ playerId, ignoreClose: true });
      try {
        socket.close(1000, "Left lobby");
      } catch {
        // Ignore close errors.
      }
      return;
    }

    if (action === "start_game") {
      if (this.stateData.hostId !== playerId) {
        this.ack(socket, reqId, { ok: false, error: "Only the host can start the game." });
        return;
      }
      if (this.stateData.phase !== "lobby") {
        this.ack(socket, reqId, { ok: false, error: "Game already started." });
        return;
      }
      if (this.playerIds().length < MIN_PLAYERS) {
        this.ack(socket, reqId, {
          ok: false,
          error: `Need at least ${MIN_PLAYERS} players to start.`
        });
        return;
      }
      this.startGame();
      await this.ctx.storage.setAlarm(this.stateData.roundEndsAt);
      await this.saveState();
      this.broadcastState();
      this.ack(socket, reqId, { ok: true });
      return;
    }

    if (action === "send_main_message") {
      if (this.stateData.phase !== "lobby" && !player.isAlive) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Eliminated players cannot send chat messages."
        });
        return;
      }
      const text = sanitizeMessage(message.text);
      if (!text) {
        this.ack(socket, reqId, { ok: false, error: "Message is empty." });
        return;
      }
      this.addMainMessage(player, text);
      await this.saveState();
      this.broadcastState();
      this.ack(socket, reqId, { ok: true });
      return;
    }

    if (action === "send_private_message") {
      if (this.stateData.phase !== "lobby" && !player.isAlive) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Eliminated players cannot send chat messages."
        });
        return;
      }
      const toId = String(message.toId || "");
      const recipient = this.playerById(toId);
      if (!recipient || recipient.id === player.id) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Select a valid player for private chat."
        });
        return;
      }
      const text = sanitizeMessage(message.text);
      if (!text) {
        this.ack(socket, reqId, { ok: false, error: "Message is empty." });
        return;
      }

      this.addDmMessage(player, recipient, text);
      await this.saveState();
      this.broadcastState();
      this.ack(socket, reqId, { ok: true });
      return;
    }

    if (action === "mafia_kill") {
      if (this.stateData.phase !== "in_round") {
        this.ack(socket, reqId, {
          ok: false,
          error: "Kills can only happen during a live round."
        });
        return;
      }
      if (player.id !== this.stateData.mafiaId || !player.isAlive) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Only the alive mafia can use this action."
        });
        return;
      }
      if (this.stateData.mafiaKillRound === this.stateData.roundNumber) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Mafia can only pick one kill target per round."
        });
        return;
      }
      const cooldownMs = Math.max(
        0,
        MAFIA_COOLDOWN_MS - (Date.now() - this.stateData.lastMafiaActionAt)
      );
      if (cooldownMs > 0) {
        this.ack(socket, reqId, {
          ok: false,
          error: `Skull cooldown active (${Math.ceil(cooldownMs / 1000)}s left).`
        });
        return;
      }

      const targetId = String(message.targetId || "");
      const target = this.playerById(targetId);
      if (!target || !target.isAlive || target.id === player.id) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Pick an alive target other than yourself."
        });
        return;
      }

      this.stateData.pendingKillId = targetId;
      this.stateData.lastMafiaActionAt = Date.now();
      this.stateData.mafiaKillRound = this.stateData.roundNumber;
      await this.saveState();
      this.broadcastState();
      this.ack(socket, reqId, { ok: true });
      return;
    }

    if (action === "guardian_save") {
      if (this.stateData.phase !== "in_round") {
        this.ack(socket, reqId, {
          ok: false,
          error: "Saves can only happen during a live round."
        });
        return;
      }
      if (player.id !== this.stateData.guardianId || !player.isAlive) {
        this.ack(socket, reqId, {
          ok: false,
          error: "Only the alive guardian angel can use this action."
        });
        return;
      }

      const targetId = String(message.targetId || "");
      const target = this.playerById(targetId);
      if (!target || !target.isAlive) {
        this.ack(socket, reqId, { ok: false, error: "Pick an alive target to save." });
        return;
      }

      this.stateData.pendingSaveId = targetId;
      await this.saveState();
      this.broadcastState();
      this.ack(socket, reqId, { ok: true });
      return;
    }

    this.ack(socket, reqId, { ok: false, error: "Unknown action." });
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/init") {
      if (this.hasLobby()) {
        return jsonResponse({ ok: false, error: "Lobby already exists." }, 409);
      }
      const body = await parseJson(request);
      const code = sanitizeCode(body?.code);
      if (code.length !== 5) {
        return jsonResponse({ ok: false, error: "Invalid lobby code." }, 400);
      }

      this.stateData = {
        code,
        hostId: null,
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
        dmThreads: {},
        history: [],
        players: {}
      };
      await this.saveState();
      return jsonResponse({ ok: true, code }, 201);
    }

    if (request.method === "POST" && url.pathname === "/internal/join") {
      if (!this.hasLobby()) {
        return jsonResponse({ ok: false, error: "Lobby code not found." }, 404);
      }
      if (this.stateData.phase !== "lobby") {
        return jsonResponse(
          { ok: false, error: "Game already started. Join before the host starts." },
          409
        );
      }

      const body = await parseJson(request);
      const name = sanitizeName(body?.name);
      const playerId = makeId();
      const sessionSecret = makeSecret();

      this.stateData.players[playerId] = {
        id: playerId,
        sessionSecret,
        name,
        role: "villager",
        isAlive: true,
        joinedAt: Date.now(),
        eliminatedAt: null
      };

      if (!this.stateData.hostId) {
        this.stateData.hostId = playerId;
      }

      this.addSystemMessage(`${name} joined the lobby.`);
      await this.saveState();
      this.broadcastState();

      return jsonResponse({
        ok: true,
        code: this.stateData.code,
        playerId,
        sessionSecret
      });
    }

    if (url.pathname === "/internal/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      if (!this.hasLobby()) {
        return new Response("Lobby not found", { status: 404 });
      }

      const playerId = String(url.searchParams.get("pid") || "");
      const secret = String(url.searchParams.get("sec") || "");
      const player = this.playerById(playerId);
      if (!player || player.sessionSecret !== secret) {
        return new Response("Invalid session", { status: 403 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server, [`player:${playerId}`]);
      server.serializeAttachment({ playerId, ignoreClose: false });
      this.sendToSocket(server, { type: "state", state: this.buildStateForViewer(playerId) });

      return new Response(null, { status: 101, webSocket: client });
    }

    return jsonResponse({ ok: false, error: "Not found." }, 404);
  }

  async webSocketMessage(socket, data) {
    await this.ensureLoaded();
    if (!this.hasLobby()) {
      this.sendToSocket(socket, { type: "session_invalid", error: "Lobby no longer exists." });
      try {
        socket.close(1008, "Lobby closed");
      } catch {
        // Ignore close errors.
      }
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    const playerId = attachment.playerId;
    if (!playerId) {
      this.sendToSocket(socket, { type: "session_invalid", error: "Missing session." });
      try {
        socket.close(1008, "Invalid session");
      } catch {
        // Ignore close errors.
      }
      return;
    }

    const raw = wsDataToText(data);
    let message = null;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendToSocket(socket, { type: "error", error: "Invalid JSON payload." });
      return;
    }

    await this.handleAction(socket, playerId, message || {});
  }

  async webSocketClose(socket) {
    await this.ensureLoaded();
    if (!this.hasLobby()) {
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    if (attachment.ignoreClose) {
      return;
    }

    const playerId = attachment.playerId;
    if (!playerId) {
      return;
    }

    if (this.anyOpenSocketForPlayer(playerId)) {
      return;
    }

    await this.removePlayer(playerId, "disconnected");
  }

  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }

  async alarm() {
    await this.ensureLoaded();
    if (!this.hasLobby()) {
      return;
    }
    if (this.stateData.phase !== "in_round" || !this.stateData.roundEndsAt) {
      return;
    }

    if (Date.now() >= this.stateData.roundEndsAt) {
      await this.finishRound();
      return;
    }

    await this.ctx.storage.setAlarm(this.stateData.roundEndsAt);
  }
}
