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
const MAX_WINNERS_PER_ROUND = 5; // buzzer stays open until 5 players answer correctly
const MIN_TIME_LIMIT_SECONDS = 2;
const MAX_TIME_LIMIT_SECONDS = 60;
// Suggested math-check time limits shown as placeholder text on the host
// dashboard, and used automatically whenever the host hasn't set a custom value.
const SUGGESTED_SECONDS = { easy: 5, medium: 8, hard: 12 };
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

// Shared by both the host dashboard and every player's own page: each buzzer
// gets their own independently-random equation, so showing everyone's
// equation/answer doesn't help anyone game a future question.
function queueDetail(room) {
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
    queue: queueDetail(room),
  });
  io.to(hostChannel(room.sessionId)).emit('leaderboard:update', leaderboard(room));
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

function clearRound(room) {
  room.round.queue.forEach((entry) => {
    if (entry.timer) clearTimeout(entry.timer);
  });
  room.round = { armed: room.round.armed, queue: [], winner: null };
}

function currentChallenger(room) {
  return room.round.queue.find((e) => e.status === 'pending');
}

function correctCount(room) {
  return room.round.queue.filter((e) => e.status === 'correct').length;
}

function effectiveTimeoutMs(room) {
  return room.timeLimitMs || SUGGESTED_SECONDS[room.difficulty] * 1000;
}

function issueChallenge(room, entry) {
  const timeoutMs = effectiveTimeoutMs(room);
  entry.equation = makeEquation(room.difficulty);
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
  entry.timer = setTimeout(() => resolveChallenge(room, entry, null), timeoutMs + 150);
}

function advanceQueue(room) {
  if (correctCount(room) >= MAX_WINNERS_PER_ROUND) {
    // Target reached - nobody still waiting gets a turn this round.
    room.round.queue.forEach((e) => {
      if (e.status === 'waiting') e.status = 'skipped';
    });
    broadcastState(room);
    return;
  }
  const next = room.round.queue.find((e) => e.status === 'waiting');
  if (next) issueChallenge(room, next);
  broadcastState(room);
}

function resolveChallenge(room, entry, submittedAnswer) {
  if (entry.status !== 'pending') return; // already resolved
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
  } else {
    entry.status = submittedAnswer === null ? 'timeout' : 'wrong';
    stats.misses += 1;
  }
  advanceQueue(room); // give the next queued buzzer their own challenge regardless of outcome
}

function getHostRoom(socket) {
  const sessionId = hostSessions.get(socket.id);
  return sessionId ? rooms.get(sessionId) : null;
}

function closeRoom(sessionId, reason) {
  const room = rooms.get(sessionId);
  if (!room) return;
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
  const now = Date.now();
  for (const [sessionId, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      closeRoom(sessionId, 'inactive_timeout');
    }
  }
}, ROOM_SWEEP_INTERVAL_MS);

io.on('connection', (socket) => {
  socket.on('host:authenticate', ({ companyName }) => {
    const ok = String(companyName || '').trim().toLowerCase() === REQUIRED_COMPANY;
    if (ok) authorizedHosts.add(socket.id);
    socket.emit('host:authenticated', { ok });
  });

  socket.on('host:createRoom', () => {
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
      statsByName: new Map(),
      latencyByName: new Map(),
      difficulty: 'medium',
      mathEnabled: true,
      timeLimitMs: null, // null = use the suggested time for the current difficulty
      showLiveStats: false, // whether players can see the leaderboard on their own page
      round: { armed: false, queue: [], winner: null },
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    rooms.set(sessionId, room);
    joinCodeIndex.set(joinCode, sessionId);
    hostSessions.set(socket.id, sessionId);
    socket.join(roomChannel(sessionId));
    socket.join(hostChannel(sessionId));
    socket.emit('room:created', { code: joinCode });
    broadcastState(room);
  });

  socket.on('host:rerollCode', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    joinCodeIndex.delete(room.joinCode);
    room.joinCode = generateJoinCode();
    joinCodeIndex.set(room.joinCode, room.sessionId);
    touch(room);
    io.to(hostChannel(room.sessionId)).emit('room:code', { code: room.joinCode });
  });

  socket.on('player:joinRoom', ({ code, name }) => {
    const sessionId = joinCodeIndex.get(String(code || '').trim());
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    const clean = String(name || '').trim().slice(0, 24) || 'Player';
    room.players.set(socket.id, { name: clean });
    playerSessions.set(socket.id, sessionId);
    getStats(room, clean);
    socket.join(roomChannel(sessionId));
    touch(room);
    socket.emit('registered', { name: clean, code: room.joinCode });
    broadcastState(room);
  });

  socket.on('host:setDifficulty', (level) => {
    const room = getHostRoom(socket);
    if (!room || !DIFFICULTIES.includes(level)) return;
    room.difficulty = level;
    touch(room);
    broadcastState(room);
  });

  socket.on('host:setMathEnabled', (enabled) => {
    const room = getHostRoom(socket);
    if (!room) return;
    room.mathEnabled = !!enabled;
    touch(room);
    broadcastState(room);
  });

  socket.on('host:setShowLiveStats', (enabled) => {
    const room = getHostRoom(socket);
    if (!room) return;
    room.showLiveStats = !!enabled;
    touch(room);
    broadcastState(room);
  });

  socket.on('host:setTimeLimit', ({ seconds } = {}) => {
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

  socket.on('host:arm', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    room.round.armed = true;
    touch(room);
    broadcastState(room);
  });

  socket.on('host:resetRound', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    touch(room);
    broadcastState(room);
  });

  socket.on('host:resetAll', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    clearRound(room);
    room.round.armed = false;
    room.statsByName.clear();
    room.latencyByName.clear();
    touch(room);
    broadcastState(room);
  });

  socket.on('buzz', () => {
    const sessionId = playerSessions.get(socket.id);
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (!room.round.armed) return; // buzzer not live
    if (room.round.queue.some((e) => e.socketId === socket.id)) return; // one buzz per round per player
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
        room.round.queue.forEach((e) => {
          if (e.status === 'waiting') e.status = 'skipped';
        });
      }
    } else if (!currentChallenger(room)) {
      // no one is currently mid-challenge - the earliest waiting buzz goes next
      issueChallenge(room, entry);
    }
    broadcastState(room);
  });

  socket.on('math:answer', ({ equationId, answer }) => {
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
  socket.on('latency:report', (rttMs) => {
    const sessionId = playerSessions.get(socket.id);
    const room = sessionId ? rooms.get(sessionId) : null;
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) room.latencyByName.set(player.name, rttMs);
  });
  socket.on('latency:ping', (t) => socket.emit('latency:pong', t));

  socket.on('disconnect', () => {
    authorizedHosts.delete(socket.id);
    const hostedSessionId = hostSessions.get(socket.id);
    if (hostedSessionId) {
      closeRoom(hostedSessionId, 'host_disconnected');
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
