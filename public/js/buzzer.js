const name = sessionStorage.getItem('buzzer_name');
const roomCode = sessionStorage.getItem('buzzer_code');
if (!name || !roomCode) {
  window.location.href = 'index.html';
}

const socket = io();

const playerNameEl = document.getElementById('playerName');
const roomCodePill = document.getElementById('roomCodePill');
const pingPill = document.getElementById('pingPill');
const statusBanner = document.getElementById('statusBanner');
const buzzBtn = document.getElementById('buzzBtn');
const queueBody = document.getElementById('queueBody');
const mathOverlay = document.getElementById('mathOverlay');
const equationText = document.getElementById('equationText');
const answerForm = document.getElementById('answerForm');
const answerInput = document.getElementById('answerInput');
const mathTimer = document.getElementById('mathTimer');

let hasBuzzedThisRound = false;
let currentEquationId = null;
let timerBarEl = null;

socket.on('connect', () => {
  socket.emit('player:joinRoom', { code: roomCode, name });
});

socket.on('registered', ({ name: confirmedName, code }) => {
  playerNameEl.textContent = confirmedName;
  roomCodePill.textContent = `room: ${code}`;
});

socket.on('room:error', ({ message }) => {
  alert(message);
  sessionStorage.removeItem('buzzer_code');
  window.location.href = 'index.html';
});

socket.on('room:closed', () => {
  alert('The host has closed the room.');
  sessionStorage.removeItem('buzzer_name');
  sessionStorage.removeItem('buzzer_code');
  window.location.href = 'index.html';
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
    const tr = document.createElement('tr');
    tr.className = `q-${entry.status}`;
    tr.innerHTML = `<td>${entry.rank}</td><td>${escapeHtml(entry.name)}</td><td>+${entry.msAfterFirst}ms</td><td>${statusLabel}</td>`;
    queueBody.appendChild(tr);
  });
}

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
