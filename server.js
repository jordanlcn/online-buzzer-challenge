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
const MATH_TIMEOUT_MS = 6000; // time a challenger has to answer the math check
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // abandoned rooms are cleaned up after 3 hours
const ROOM_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_BUZZERS_PER_ROUND = 5; // top 5 buzz-ins each get their own math challenge

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

function broadcastState(room) {
  io.to(roomChannel(room.sessionId)).emit('state:update', {
    armed: room.round.armed,
    winner: room.round.winner,
    queue: publicQueue(room),
  });
  io.to(hostChannel(room.sessionId)).emit('leaderboard:update', leaderboard(room));
  io.to(hostChannel(room.sessionId)).emit('latency:update', [...room.latencyByName.entries()]);
  io.to(hostChannel(room.sessionId)).emit('difficulty:update', room.difficulty);
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

function issueChallenge(room, entry) {
  entry.equation = makeEquation(room.difficulty);
  entry.status = 'pending';
  entry.deadline = Date.now() + MATH_TIMEOUT_MS;
  const socket = io.sockets.sockets.get(entry.socketId);
  if (socket) {
    socket.emit('math:challenge', {
      equationId: entry.equation.id,
      a: entry.equation.a,
      b: entry.equation.b,
      op: entry.equation.op,
      timeoutMs: MATH_TIMEOUT_MS,
    });
  }
  entry.timer = setTimeout(() => resolveChallenge(room, entry, null), MATH_TIMEOUT_MS + 150);
}

function advanceQueue(room) {
  // Always keep going - the top MAX_BUZZERS_PER_ROUND buzzers each get their
  // own turn at the math check, even after someone has already answered
  // correctly.
  const next = room.round.queue.find((e) => e.status === 'waiting');
  if (next) issueChallenge(room, next);
  broadcastState(room);
}

function resolveChallenge(room, entry, submittedAnswer) {
  if (entry.status !== 'pending') return; // already resolved
  if (entry.timer) clearTimeout(entry.timer);

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
  socket.on('host:createRoom', () => {
    const sessionId = crypto.randomUUID();
    const joinCode = generateJoinCode();
    const room = {
      sessionId,
      joinCode,
      players: new Map(),
      statsByName: new Map(),
      latencyByName: new Map(),
      difficulty: 'medium',
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
    if (room.round.queue.length >= MAX_BUZZERS_PER_ROUND) {
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
    getStats(room, player.name).buzzCount += 1;
    touch(room);

    if (!currentChallenger(room)) {
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
