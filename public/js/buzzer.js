const name = sessionStorage.getItem('buzzer_name');
const roomCode = sessionStorage.getItem('buzzer_code');
if (!name || !roomCode) {
  window.location.href = 'index.html';
}

const socket = io();

const playerNameEl = document.getElementById('playerName');
const roomCodePill = document.getElementById('roomCodePill');
const pingPill = document.getElementById('pingPill');
const selfStatusBanner = document.getElementById('selfStatusBanner');
const hostStatusBanner = document.getElementById('hostStatusBanner');
const statusBanner = document.getElementById('statusBanner');
const buzzBtn = document.getElementById('buzzBtn');
const queueBody = document.getElementById('queueBody');
const statsPanel = document.getElementById('statsPanel');
const statsBody = document.getElementById('statsBody');
const mathOverlay = document.getElementById('mathOverlay');
const equationText = document.getElementById('equationText');
const answerForm = document.getElementById('answerForm');
const answerInput = document.getElementById('answerInput');
const mathTimer = document.getElementById('mathTimer');
const joinNewRoomBtn = document.getElementById('joinNewRoomBtn');

joinNewRoomBtn.addEventListener('click', () => {
  // Leaves the current room: navigating away tears down this socket, which
  // the server treats as a normal player disconnect. Keeps the player's name
  // cached so it's pre-filled on the join screen, but clears the room code
  // and resume token since those belonged to the room being left.
  sessionStorage.removeItem('buzzer_code');
  sessionStorage.removeItem('buzzer_player_token');
  window.location.href = 'index.html';
});

let hasBuzzedThisRound = false;
let currentEquationId = null;
let timerBarEl = null;
let wasArmed = false;

// --- audio alert when the buzzer goes live ---
// Generated with the Web Audio API (no sound file to load/host). Browsers
// block audio until the page has seen a user interaction, so the context is
// created eagerly but only actually resumed once the player has tapped or
// pressed something - by the time a round is armed there's usually been
// plenty of opportunity for that (e.g. typing their name on the join page).
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}
['pointerdown', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, () => {
    const ctx = getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }, { once: true });
});

function playBuzzerAlert() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
}

// --- resilience for a dropped player connection ---
// If a cached resume token exists (from a previous successful join in this
// tab), try it first: the server re-attaches this socket to the same room
// under the same name, including re-sending any in-flight math challenge with
// its correct remaining time. Falls back to a fresh join if resuming fails
// (e.g. room no longer exists).
socket.on('connect', () => {
  selfStatusBanner.classList.add('hidden');
  const cachedToken = sessionStorage.getItem('buzzer_player_token');
  if (cachedToken) {
    socket.emit('player:resume', { code: roomCode, token: cachedToken });
  } else {
    socket.emit('player:joinRoom', { code: roomCode, name });
  }
});

socket.on('player:resumeFailed', () => {
  sessionStorage.removeItem('buzzer_player_token');
  socket.emit('player:joinRoom', { code: roomCode, name });
});

socket.on('disconnect', () => {
  selfStatusBanner.classList.remove('hidden');
  buzzBtn.disabled = true;
});

socket.on('registered', ({ name: confirmedName, code, token }) => {
  playerNameEl.textContent = confirmedName;
  roomCodePill.textContent = `room: ${code}`;
  if (token) sessionStorage.setItem('buzzer_player_token', token);
});

socket.on('room:error', ({ message }) => {
  alert(message);
  sessionStorage.removeItem('buzzer_code');
  sessionStorage.removeItem('buzzer_player_token');
  window.location.href = 'index.html';
});

socket.on('room:closed', () => {
  alert('The host has closed the room.');
  sessionStorage.removeItem('buzzer_name');
  sessionStorage.removeItem('buzzer_code');
  sessionStorage.removeItem('buzzer_player_token');
  window.location.href = 'index.html';
});

// If the host's connection drops (wifi blip, accidental refresh), the room
// stays open for a short grace period rather than closing immediately -
// buzzing/answering keeps working normally the whole time. This just lets
// players know why the host dashboard might be momentarily unresponsive.
socket.on('host:status', ({ connected }) => {
  hostStatusBanner.classList.toggle('hidden', connected);
});

// --- latency probe: purely informational, does NOT affect buzz ordering ---
setInterval(() => {
  const sentAt = Date.now();
  socket.emit('latency:ping', sentAt);
}, 3000);

socket.on('latency:pong', (sentAt) => {
  const rtt = Date.now() - sentAt;
  pingPill.textContent = `ping: ${rtt} ms`;
  socket.emit('latency:report', rtt);
});

const MAX_WINNERS_PER_ROUND = 5; // matches server.js MAX_WINNERS_PER_ROUND

buzzBtn.addEventListener('click', () => {
  if (buzzBtn.disabled) return;
  hasBuzzedThisRound = true;
  buzzBtn.disabled = true;
  socket.emit('buzz');
});

socket.on('buzz:rejected', () => {
  buzzBtn.disabled = true;
});

socket.on('state:update', ({ armed, winner, queue }) => {
  if (armed && !wasArmed) {
    playBuzzerAlert(); // the buzzer just went live - give an audible heads-up
  }
  wasArmed = armed;

  if (armed && queue.length === 0) {
    hasBuzzedThisRound = false; // fresh round started by host
  }

  const correctCount = queue.filter((e) => e.status === 'correct').length;
  const full = correctCount >= MAX_WINNERS_PER_ROUND;

  if (winner) {
    const suffix = armed && !full ? ` — buzzer still open (${correctCount}/${MAX_WINNERS_PER_ROUND} correct so far)` : '';
    statusBanner.textContent = `🏆 ${winner} answered first!${suffix}`;
    statusBanner.className = 'status-banner status-winner';
  } else if (armed) {
    statusBanner.textContent = full
      ? `${MAX_WINNERS_PER_ROUND}/${MAX_WINNERS_PER_ROUND} correct — buzzer closed for this round`
      : 'Buzzer is live - go!';
    statusBanner.className = 'status-banner status-armed';
  } else {
    statusBanner.textContent = 'Waiting for host to start the round...';
    statusBanner.className = 'status-banner status-waiting';
  }

  buzzBtn.disabled = !armed || hasBuzzedThisRound || full;

  // If we no longer have a pending entry in the queue, close any open math overlay.
  const mine = queue.find((e) => e.name === name);
  if (!mine || mine.status !== 'pending') {
    closeMathOverlay();
  }

  renderQueue(queue);
});

function renderQueue(queue) {
  queueBody.innerHTML = '';
  queue.forEach((entry) => {
    const statusLabel =
      entry.status === 'correct' ? '✅ correct' :
      entry.status === 'wrong' ? '✗ wrong answer' :
      entry.status === 'timeout' ? '⏱ too slow' :
      entry.status === 'pending' ? 'solving...' :
      entry.status === 'skipped' ? 'buzzer filled up' : 'waiting';
    const equation = entry.equation ?? '-';
    const answer = entry.submittedAnswer ?? '-';
    const tr = document.createElement('tr');
    tr.className = `q-${entry.status}`;
    tr.innerHTML = `<td>${entry.rank}</td><td>${escapeHtml(entry.name)}</td><td>+${entry.msAfterFirst}ms</td><td>${escapeHtml(equation)}</td><td>${escapeHtml(answer)}</td><td>${statusLabel}</td>`;
    queueBody.appendChild(tr);
  });
}

socket.on('stats:visibility', (visible) => {
  statsPanel.classList.toggle('hidden', !visible);
  if (!visible) statsBody.innerHTML = '';
});

socket.on('stats:update', (rows) => {
  statsBody.innerHTML = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td>${row.wins}</td><td>${row.buzzCount}</td><td>${row.misses}</td>`;
    statsBody.appendChild(tr);
  });
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

socket.on('math:challenge', ({ equationId, a, b, op, timeoutMs }) => {
  currentEquationId = equationId;
  equationText.textContent = `${a} ${op} ${b} = ?`;
  answerInput.value = '';
  mathOverlay.classList.remove('hidden');
  answerInput.focus();
  startTimerBar(timeoutMs);
});

answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (currentEquationId === null) return;
  socket.emit('math:answer', { equationId: currentEquationId, answer: answerInput.value });
  closeMathOverlay();
});

function startTimerBar(timeoutMs) {
  mathTimer.innerHTML = '';
  const bar = document.createElement('div');
  bar.style.height = '100%';
  bar.style.background = '#eab308';
  bar.style.width = '100%';
  bar.style.transition = `width ${timeoutMs}ms linear`;
  mathTimer.appendChild(bar);
  requestAnimationFrame(() => { bar.style.width = '0%'; });
  timerBarEl = bar;
}

function closeMathOverlay() {
  mathOverlay.classList.add('hidden');
  currentEquationId = null;
}
