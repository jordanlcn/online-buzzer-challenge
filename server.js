const path = require('path');
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

/** @type {Map<string, {name: string}>} socket.id -> player */
const players = new Map();

/** name -> { buzzCount, wins, misses } persists across round resets */
const statsByName = new Map();

/** name -> last measured round-trip latency in ms (for host visibility only) */
const latencyByName = new Map();

let round = {
  armed: false,
  queue: [], // { socketId, name, serverTime, status, equation }
  winner: null,
  startedAt: null,
};

let equationSeq = 1;

function makeEquation() {
  const a = Math.floor(Math.random() * 100); // up to two digits, 0-99
  const b = Math.floor(Math.random() * 100); // up to two digits, 0-99
  const op = Math.random() < 0.5 ? '+' : '-';
  const answer = op === '+' ? a + b : a - b;
  return { id: String(equationSeq++), a, b, op, answer };
}

function getStats(name) {
  if (!statsByName.has(name)) {
    statsByName.set(name, { name, buzzCount: 0, wins: 0, misses: 0 });
  }
  return statsByName.get(name);
}

function leaderboard() {
  return [...statsByName.values()].sort(
    (a, b) => b.wins - a.wins || b.buzzCount - a.buzzCount
  );
}

function publicQueue() {
  const first = round.queue[0];
  const baseTime = first ? first.serverTime : null;
  return round.queue.map((entry, i) => ({
    name: entry.name,
    rank: i + 1,
    status: entry.status,
    msAfterFirst: baseTime === null ? 0 : entry.serverTime - baseTime,
  }));
}

function broadcastState() {
  io.emit('state:update', {
    armed: round.armed,
    winner: round.winner,
    queue: publicQueue(),
  });
  io.to('host-room').emit('leaderboard:update', leaderboard());
  io.to('host-room').emit('latency:update', [...latencyByName.entries()]);
}

function clearRound() {
  round.queue.forEach((entry) => {
    if (entry.timer) clearTimeout(entry.timer);
  });
  round = { armed: round.armed, queue: [], winner: null, startedAt: null };
}

function currentChallenger() {
  return round.queue.find((e) => e.status === 'pending');
}

function issueChallenge(entry) {
  entry.equation = makeEquation();
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
  entry.timer = setTimeout(() => resolveChallenge(entry, null), MATH_TIMEOUT_MS + 150);
}

function advanceQueue() {
  if (round.winner) return;
  const next = round.queue.find((e) => e.status === 'waiting');
  if (next) issueChallenge(next);
  broadcastState();
}

function resolveChallenge(entry, submittedAnswer) {
  if (entry.status !== 'pending') return; // already resolved
  if (entry.timer) clearTimeout(entry.timer);

  const stats = getStats(entry.name);
  const correct =
    submittedAnswer !== null &&
    Number(submittedAnswer) === entry.equation.answer &&
    Date.now() <= entry.deadline;

  if (correct) {
    entry.status = 'correct';
    round.winner = entry.name;
    round.armed = false;
    stats.wins += 1;
  } else {
    entry.status = submittedAnswer === null ? 'timeout' : 'wrong';
    stats.misses += 1;
    advanceQueue();
  }
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('register', ({ name }) => {
    const clean = String(name || '').trim().slice(0, 24) || 'Player';
    players.set(socket.id, { name: clean });
    getStats(clean);
    socket.emit('registered', { name: clean });
    broadcastState();
  });

  socket.on('host:join', () => {
    socket.join('host-room');
    socket.emit('state:update', {
      armed: round.armed,
      winner: round.winner,
      queue: publicQueue(),
    });
    socket.emit('leaderboard:update', leaderboard());
    socket.emit('latency:update', [...latencyByName.entries()]);
  });

  socket.on('host:arm', () => {
    clearRound();
    round.armed = true;
    broadcastState();
  });

  socket.on('host:resetRound', () => {
    clearRound();
    broadcastState();
  });

  socket.on('host:resetAll', () => {
    clearRound();
    round.armed = false;
    statsByName.clear();
    latencyByName.clear();
    broadcastState();
  });

  socket.on('buzz', () => {
    const player = players.get(socket.id);
    if (!player) return; // must register first
    if (!round.armed) return; // buzzer not live
    if (round.winner) return; // round already decided
    if (round.queue.some((e) => e.socketId === socket.id)) return; // one buzz per round per player

    const serverTime = Date.now(); // <-- the fair, authoritative timestamp
    const entry = {
      socketId: socket.id,
      name: player.name,
      serverTime,
      status: 'waiting',
    };
    round.queue.push(entry);
    getStats(player.name).buzzCount += 1;

    if (!currentChallenger()) {
      // no one is currently mid-challenge - the earliest waiting buzz goes next
      issueChallenge(entry);
    }
    broadcastState();
  });

  socket.on('math:answer', ({ equationId, answer }) => {
    const entry = round.queue.find(
      (e) => e.socketId === socket.id && e.status === 'pending' && e.equation?.id === equationId
    );
    if (!entry) return;
    resolveChallenge(entry, answer);
  });

  // Simple latency probe: client pings, server pongs immediately, client
  // reports the measured round-trip time so the host dashboard can show it.
  socket.on('latency:report', (rttMs) => {
    const player = players.get(socket.id);
    if (player) latencyByName.set(player.name, rttMs);
  });
  socket.on('latency:ping', (t) => socket.emit('latency:pong', t));

  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Online Buzzer running at http://localhost:${PORT}`);
});
