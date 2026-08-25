const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Socket.IO uses WebSockets by default (falls back to polling only if needed) -
// this keeps buzz-in latency as low as possible for players on slower connections.
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // abandoned rooms are cleaned up after 3 hours
const ROOM_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const HOST_GRACE_MS = 60 * 1000; // how long a room survives a dropped host before closing
const MAX_WINNERS_PER_ROUND = 5; // buzzer stays open until 5 players answer correctly
const MIN_TIME_LIMIT_SECONDS = 2;
const MAX_TIME_LIMIT_SECONDS = 60;
// Suggested math-check time limits shown as placeholder text on the host
// dashboard, and used automatically whenever the host hasn't set a custom value.
const SUGGESTED_SECONDS = { easy: 8, medium: 12, hard: 18 };
const REQUIRED_COMPANY = 'five9'; // lightweight gate: only this company name is accepted for now

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Fairness model:
 * Every buzz is timestamped using the SERVER's clock the instant the packet
 * arrives (socket 'buzz' handler), never the client's own clock. This means
 * a player on a faster connection gets no ordering advantage beyond actually
 * having lower network latency to the server - the server is the single
 * source of truth for "who buzzed first," so results are consistent for
 * everyone watching the host dashboard regardless of each player's link speed.
 */

/**
 * Room model:
 * Each game lives in its own Room, keyed internally by a stable sessionId
 * (never shown to users) and reachable by a human-facing 6-digit joinCode
 * that the host can reroll at will. Socket.IO channel names are derived from
 * the sessionId, so rerolling the join code never disturbs already-connected
 * sockets - only the lookup table changes.
 */

/** @type {Map<string, Room>} sessionId -> room */
const rooms = new Map();

/** @type {Map<string, string>} 6-digit joinCode -> sessionId */
const joinCodeIndex = new Map();

/** @type {Map<string, string>} socket.id -> sessionId, for the socket hosting that room */
const hostSessions = new Map();

/** @type {Map<string, string>} socket.id -> sessionId, for a player socket */
const playerSessions = new Map();

/** @type {Set<string>} socket.id of sockets that passed the company-name gate */
const authorizedHosts = new Set();

let equationSeq = 1;

const DIFFICULTIES = ['easy', 'medium', 'hard'];

function roomChannel(sessionId) {
  return `room:${sessionId}`;
}
function hostChannel(sessionId) {
  return `room:${sessionId}:host`;
}

// Defense in depth: this whole server is a single process shared by every
// live room, so an uncaught exception in one handler could otherwise take
// down every game at once. safeOn() catches synchronous errors per-handler;
// the process-level listeners below catch anything that slips past that
// (e.g. inside a setTimeout/setInterval callback) as a last resort.
function safeOn(socket, event, handler) {
  socket.on(event, (...args) => {
    try {
      handler(...args);
    } catch (err) {
      console.error(`[socket:${event}] handler error:`, err);
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server staying up):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server staying up):', err);
});

function touch(room) {
  room.lastActivity = Date.now();
}

function generateJoinCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000)); // always 6 digits
  } while (joinCodeIndex.has(code));
  return code;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randOperand(diff) {
  if (diff === 'easy') return randInt(0, 9); // always single digit
  if (diff === 'hard') return randInt(10, 99); // always two digits
  return Math.random() < 0.5 ? randInt(0, 9) : randInt(10, 99); // medium: mix of both
}

function makeEquation(diff) {
  const a = randOperand(diff);
  const b = randOperand(diff);
  const op = Math.random() < 0.5 ? '+' : '-';
  const answer = op === '+' ? a + b : a - b;
  return { id: String(equationSeq++), a, b, op, answer };
}

function getStats(room, name) {
  if (!room.statsByName.has(name)) {
    room.statsByName.set(name, { name, buzzCount: 0, wins: 0, misses: 0 });
  }
  return room.statsByName.get(name);
}

function leaderboard(room) {
  return [...room.statsByName.values()].sort(
    (a, b) => b.wins - a.wins || b.buzzCount - a.buzzCount
  );
}

// So the host can see who's actually connected and waiting, not just who's
// shown up on the leaderboard (which only gets an entry once someone buzzes).
function connectedPlayersList(room) {
  return [...room.players.values()].map((p) => p.name).sort((a, b) => a.localeCompare(b));
}

// Player-facing queue: deliberately excludes the equation/submitted answer.
// Now that every buzzer in a round shares the SAME equation (see clearRound),
// showing anyone's equation/answer to players would let anyone still solving
// just read the correct answer off the table - so that detail is host-only.
function publicQueue(room) {
  const first = room.round.queue[0];
  const baseTime = first ? first.serverTime : null;
  return room.round.queue.map((entry, i) => ({
    name: entry.name,
    rank: i + 1,
    status: entry.status,
    msAfterFirst: baseTime === null ? 0 : entry.serverTime - baseTime,
  }));
}

// Host-only: same as publicQueue plus the actual equation and what each
// buzzer answered. Never sent to players (see publicQueue above).
function hostQueueDetail(room) {
  const first = room.round.queue[0];
  const baseTime = first ? first.serverTime : null;
  return room.round.queue.map((entry, i) => ({
    name: entry.name,
    rank: i + 1,
    status: entry.status,
    msAfterFirst: baseTime === null ? 0 : entry.serverTime - baseTime,
    equation: !room.mathEnabled
      ? 'N/A (math off)'
      : entry.equation
      ? `${entry.equation.a} ${entry.equation.op} ${entry.equation.b}`
      : null,
    submittedAnswer: !room.mathEnabled
      ? 'N/A (math off)'
      : entry.status === 'waiting' || entry.status === 'skipped' || entry.status === 'pending'
      ? null
      : entry.submittedAnswer === null || entry.submittedAnswer === undefined
      ? '(no answer)'
      : String(entry.submittedAnswer),
  }));
}

function broadcastState(room) {
  io.to(roomChannel(room.sessionId)).emit('state:update', {
    armed: room.round.armed,
    winner: room.round.winner,
    queue: publicQueue(room),
  });
  io.to(hostChannel(room.sessionId)).emit('queue:detail', hostQueueDetail(room));
  io.to(hostChannel(room.sessionId)).emit('leaderboard:update', leaderboard(room));
  io.to(hostChannel(room.sessionId)).emit('players:update', connectedPlayersList(room));
  io.to(hostChannel(room.sessionId)).emit('latency:update', [...room.latencyByName.entries()]);
  io.to(hostChannel(room.sessionId)).emit('difficulty:update', room.difficulty);
  io.to(hostChannel(room.sessionId)).emit('settings:update', {
    mathEnabled: room.mathEnabled,
    timeLimitSeconds: room.timeLimitMs ? room.timeLimitMs / 1000 : null,
    suggestedSeconds: SUGGESTED_SECONDS[room.difficulty],
    showLiveStats: room.showLiveStats,
  });

  // Live Stats is host-controlled and opt-in: players only get the leaderboard
  // data while the host has it switched on, and get told to clear it the
  // moment the host switches it back off.
  io.to(roomChannel(room.sessionId)).emit('stats:visibility', room.showLiveStats);
  if (room.showLiveStats) {
    io.to(roomChannel(room.sessionId)).emit('stats:update', leaderboard(room));
  }
}

// The host can change Difficulty/Time Limit at any time, including while a
// round is in progress - those live settings just aren't blocked. But the
// round itself locks in whatever they were at the moment it started
// (arm / reset), so a mid-round change never retroactively affects equations
// already handed out - it only takes effect from the NEXT round onward.
//
// Every buzzer in the round is handed this same equation - one question per
// round, not one per buzz - generated fresh right here so a new round always
// gets a new problem.
function clearRound(room) {
  room.round.queue.forEach((entry) => {
    if (entry.timer) clearTimeout(entry.timer);
  });
  const difficulty = room.difficulty;
  room.round = {
    armed: room.round.armed,
    queue: [],
    winner: null,
    difficulty,
    timeLimitMs: room.timeLimitMs,
    equation: makeEquation(difficulty),
  };
}

function correctCount(room) {
  return room.round.queue.filter((e) => e.status === 'correct').length;
}

function effectiveTimeoutMs(room) {
  return room.round.timeLimitMs || SUGGESTED_SECONDS[room.round.difficulty] * 1000;
}

function issueChallenge(room, entry) {
  const timeoutMs = effectiveTimeoutMs(room);
  entry.equation = room.round.equation; // same problem for every buzzer this round
  entry.status = 'pending';
  entry.deadline = Date.now() + timeoutMs;
  const socket = io.sockets.sockets.get(entry.socketId);
  if (socket) {
    socket.emit('math:challenge', {
      equationId: entry.equation.id,
      a: entry.equation.a,
      b: entry.equation.b,
      op: entry.equation.op,
      timeoutMs,
    });
  }
  entry.timer = setTimeout(() => {
    try {
      resolveChallenge(room, entry, null);
    } catch (err) {
      console.error('challenge timeout handler error:', err);
    }
  }, timeoutMs + 150);
}

// Once the 5th correct answer lands, the buzzer disables outright: any other
// challenge still in flight (issued in parallel to other buzzers) is voided
// rather than left to resolve, since it can no longer count for anything.
function closeOutRound(room) {
  room.round.queue.forEach((e) => {
    if (e.status === 'pending' || e.status === 'waiting') {
      if (e.timer) clearTimeout(e.timer);
      e.status = 'skipped';
    }
  });
  room.round.armed = false;
}

function resolveChallenge(room, entry, submittedAnswer) {
  if (entry.status !== 'pending') return; // already resolved (or voided by closeOutRound)
  if (entry.timer) clearTimeout(entry.timer);

  entry.submittedAnswer = submittedAnswer === undefined ? null : submittedAnswer;

  const stats = getStats(room, entry.name);
  const correct =
    submittedAnswer !== null &&
    Number(submittedAnswer) === entry.equation.answer &&
    Date.now() <= entry.deadline;

  if (correct) {
    entry.status = 'correct';
    if (!room.round.winner) room.round.winner = entry.name; // first correct answer is the round's winner
    stats.wins += 1;
    if (correctCount(room) >= MAX_WINNERS_PER_ROUND) {
      closeOutRound(room); // 5th correct answer posted - disable the buzzer
    }
  } else {
    entry.status = submittedAnswer === null ? 'timeout' : 'wrong';
    stats.misses += 1;
  }
  broadcastState(room);
}

function getHostRoom(socket) {
  const sessionId = hostSessions.get(socket.id);
  return sessionId ? rooms.get(sessionId) : null;
}

function closeRoom(sessionId, reason) {
  const room = rooms.get(sessionId);
  if (!room) return;
  if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
  room.round.queue.forEach((entry) => {
    if (entry.timer) clearTimeout(entry.timer);
  });
  io.to(roomChannel(sessionId)).emit('room:closed', { reason });

  joinCodeIndex.delete(room.joinCode);
  rooms.delete(sessionId);
  for (const [sid, sess] of hostSessions) {
    if (sess === sessionId) hostSessions.delete(sid);
  }
  for (const [sid, sess] of playerSessions) {
    if (sess === sessionId) playerSessions.delete(sid);
  }
}

// Safety net: rooms are meant to be closed immediately when the host
// disconnects, but this sweep catches anything left behind (e.g. a host tab
// left open with zero activity) so memory doesn't grow unbounded.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [sessionId, room] of rooms) {
      if (now - room.lastActivity > ROOM_TTL_MS) {
        closeRoom(sessionId, 'inactive_timeout');
      }
    }
  } catch (err) {
    console.error('room sweep error:', err);
  }
}, ROOM_SWEEP_INTERVAL_MS);

io.on('connection', (socket) => {
  safeOn(socket, 'host:authenticate', ({ companyName } = {}) => {
    const ok = String(companyName || '').trim().toLowerCase() === REQUIRED_COMPANY;
    if (ok) authorizedHosts.add(socket.id);
    socket.emit('host:authenticated', { ok });
  });

  safeOn(socket, 'host:createRoom', () => {
    if (!authorizedHosts.has(socket.id)) {
      socket.emit('host:authenticated', { ok: false, message: 'Please enter your company name first.' });
      return;
    }
    const sessionId = crypto.randomUUID();
    const joinCode = generateJoinCode();
    const room = {
      sessionId,
      joinCode,
      players: new Map(),
      playerTokens: new Map(), // token -> name, so a dropped player can silently resume
      statsByName: new Map(),
      latencyByName: new Map(),
      difficulty: 'easy',
      mathEnabled: true,
      timeLimitMs: null, // null = use the suggested time for the current difficulty
      showLiveStats: false, // whether players can see the leaderboard on their own page
      hostConnected: true,
      hostGraceTimer: null,
      round: { armed: false, queue: [], winner: null, difficulty: 'easy', timeLimitMs: null },
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    rooms.set(sessionId, room);
    joinCodeIndex.set(joinCode, sessionId);
    hostSessions.set(socket.id, sessionId);
    socket.join(roomChannel(sessionId));
    socket.join(hostChannel(sessionId));
    socket.emit('room:created', { code: joinCode, token: sessionId });
    broadcastState(room);
  });

  // Resilience for a dropped host connection (wifi blip, accidental refresh,
  // browser reopened): the host's browser caches this room's sessionId as a
  // "resume token." If the same browser reconnects within HOST_GRACE_MS of a
  // disconnect, it can silently resume control of the SAME room - same code,
  // same players, same round in progress - instead of starting a new one.
  safeOn(socket, 'host:resume', ({ token } = {}) => {
    const room = typeof token === 'string' && token ? rooms.get(token) : null;
    if (!room) {
      socket.emit('host:resumeFailed', {});
      return;
    }
    if (room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    authorizedHosts.add(socket.id);
    hostSessions.set(socket.id, room.sessionId);
    room.hostConnected = true;
    touch(room);
    socket.join(roomChannel(room.sessionId));
    socket.join(hostChannel(room.sessionId));
    socket.emit('room:created', { code: room.joinCode, token: room.sessionId });
    io.to(roomChannel(room.sessionId)).emit('host:status', { connected: true });
    broadcastState(room);
  });

  safeOn(socket, 'host:rerollCode', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    joinCodeIndex.delete(room.joinCode);
    room.joinCode = generateJoinCode();
    joinCodeIndex.set(room.joinCode, room.sessionId);
    touch(room);
    io.to(hostChannel(room.sessionId)).emit('room:code', { code: room.joinCode });
  });

  safeOn(socket, 'player:joinRoom', ({ code, name } = {}) => {
    const sessionId = joinCodeIndex.get(String(code || '').trim());
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    const clean = String(name || '').trim().slice(0, 24) || 'Player';
    const nameTaken = [...room.players.values()].some(
      (p) => p.name.toLowerCase() === clean.toLowerCase()
    );
    if (nameTaken) {
      socket.emit('room:error', { message: `"${clean}" is already in use in this room - pick a different name.` });
      return;
    }
    const token = crypto.randomUUID();
    room.players.set(socket.id, { name: clean });
    room.playerTokens.set(token, clean);
    playerSessions.set(socket.id, sessionId);
    getStats(room, clean);
    socket.join(roomChannel(sessionId));
    touch(room);
    socket.emit('registered', { name: clean, code: room.joinCode, token });
    socket.emit('host:status', { connected: room.hostConnected });
    broadcastState(room);
  });

  // Resilience for a dropped player connection (wifi blip, locked phone,
  // accidental refresh): the player's browser caches a per-player resume
  // token. Reconnecting with it re-attaches them to the same room under the
  // same name - including re-sending an in-flight math challenge with its
  // correct remaining time - instead of making them join fresh (which would
  // also just fail now, since their name is still "taken" until they resume).
  safeOn(socket, 'player:resume', ({ code, token } = {}) => {
    const sessionId = joinCodeIndex.get(String(code || '').trim());
    const room = sessionId ? rooms.get(sessionId) : null;
    const name = room && typeof token === 'string' ? room.playerTokens.get(token) : null;
    if (!room || !name) {
      socket.emit('player:resumeFailed', {});
      return;
    }
    const nameTakenByAnother = [...room.players.entries()].some(
      ([sid, p]) => p.name === name && sid !== socket.id
    );
    if (nameTakenByAnother) {
      socket.emit('player:resumeFailed', {});
      return;
    }
    room.players.set(socket.id, { name });
    playerSessions.set(socket.id, sessionId);
    touch(room);
    socket.join(roomChannel(sessionId));

    const activeEntry = room.round.queue.find((e) => e.name === name && e.status === 'pending');
    if (activeEntry) {
      activeEntry.socketId = socket.id;
      const remaining = Math.max(0, activeEntry.deadline - Date.now());
      socket.emit('math:challenge', {
        equationId: activeEntry.equation.id,
        a: activeEntry.equation.a,
        b: activeEntry.equation.b,
        op: activeEntry.equation.op,
        timeoutMs: remaining,
      });
    }

    socket.emit('registered', { name, code: room.joinCode, token });
    socket.emit('host:status', { connected: room.hostConnected });
    broadcastState(room);
  });

  safeOn(socket, 'host:setDifficulty', (level) => {
    const room = getHostRoom(socket);
    if (!room || !DIFFICULTIES.includes(level)) return;
    room.difficulty = level;
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:setMathEnabled', (enabled) => {
    const room = getHostRoom(socket);
    if (!room) return;
    room.mathEnabled = !!enabled;
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:setShowLiveStats', (enabled) => {
    const room = getHostRoom(socket);
    if (!room) return;
    room.showLiveStats = !!enabled;
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:setTimeLimit', ({ seconds } = {}) => {
    const room = getHostRoom(socket);
    if (!room) return;
    if (seconds === null || seconds === undefined || seconds === '') {
      room.timeLimitMs = null; // revert to the suggested time for the current difficulty
    } else {
      const n = Number(seconds);
      if (!Number.isFinite(n)) return;
      room.timeLimitMs = Math.min(MAX_TIME_LIMIT_SECONDS, Math.max(MIN_TIME_LIMIT_SECONDS, n)) * 1000;
    }
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:arm', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    room.round.armed = true;
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:resetRound', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    touch(room);
    broadcastState(room);
  });

  safeOn(socket, 'host:resetAll', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    room.round.armed = false;
    room.statsByName.clear();
    room.latencyByName.clear();
    touch(room);
    broadcastState(room);
  });

  // Lets the host end the game on demand (e.g. "that's a wrap") instead of
  // only ever closing via a dropped connection or the inactivity sweep.
  safeOn(socket, 'host:closeRoom', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    closeRoom(room.sessionId, 'host_closed');
  });

  safeOn(socket, 'buzz', () => {
    const sessionId = playerSessions.get(socket.id);
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (!room.round.armed) return; // buzzer not live
    if (room.round.queue.some((e) => e.name === player.name)) return; // one buzz per round per player
    if (correctCount(room) >= MAX_WINNERS_PER_ROUND) {
      socket.emit('buzz:rejected', { reason: 'full' });
      return;
    }

    const serverTime = Date.now(); // <-- the fair, authoritative timestamp
    const entry = {
      socketId: socket.id,
      name: player.name,
      serverTime,
      status: 'waiting',
    };
    room.round.queue.push(entry);
    const stats = getStats(room, player.name);
    stats.buzzCount += 1;
    touch(room);

    if (!room.mathEnabled) {
      // No math check configured: buzzing in successfully IS the win.
      entry.status = 'correct';
      entry.submittedAnswer = null;
      if (!room.round.winner) room.round.winner = entry.name;
      stats.wins += 1;
      if (correctCount(room) >= MAX_WINNERS_PER_ROUND) {
        closeOutRound(room);
      }
    } else {
      // Give the equation to every buzzer immediately, in parallel - nobody
      // waits for a turn. Only the first 5 correct answers count; the buzzer
      // disables itself the moment the 5th correct one is posted.
      issueChallenge(room, entry);
    }
    broadcastState(room);
  });

  safeOn(socket, 'math:answer', ({ equationId, answer } = {}) => {
    const sessionId = playerSessions.get(socket.id);
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) return;
    const entry = room.round.queue.find(
      (e) => e.socketId === socket.id && e.status === 'pending' && e.equation?.id === equationId
    );
    if (!entry) return;
    touch(room);
    resolveChallenge(room, entry, answer);
  });

  // Simple latency probe: client pings, server pongs immediately, client
  // reports the measured round-trip time so the host dashboard can show it.
  safeOn(socket, 'latency:report', (rttMs) => {
    const sessionId = playerSessions.get(socket.id);
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) return;
    const player = room.players.get(socket.id);
    const n = Number(rttMs);
    if (player && Number.isFinite(n)) room.latencyByName.set(player.name, n);
  });
  safeOn(socket, 'latency:ping', (t) => {
    if (typeof t === 'number' && Number.isFinite(t)) socket.emit('latency:pong', t);
  });

  safeOn(socket, 'disconnect', () => {
    authorizedHosts.delete(socket.id);
    const hostedSessionId = hostSessions.get(socket.id);
    if (hostedSessionId) {
      hostSessions.delete(socket.id);
      const room = rooms.get(hostedSessionId);
      if (room) {
        room.hostConnected = false;
        io.to(roomChannel(hostedSessionId)).emit('host:status', { connected: false });
        if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
        room.hostGraceTimer = setTimeout(() => {
          closeRoom(hostedSessionId, 'host_disconnected');
        }, HOST_GRACE_MS);
      }
      return;
    }
    const sessionId = playerSessions.get(socket.id);
    if (sessionId) {
      const room = rooms.get(sessionId);
      playerSessions.delete(socket.id);
      if (room) {
        room.players.delete(socket.id);
        broadcastState(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Online Buzzer running at http://localhost:${PORT}`);
});
