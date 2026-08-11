const name = sessionStorage.getItem('buzzer_name');
if (!name) {
  window.location.href = 'index.html';
}

const socket = io();

const playerNameEl = document.getElementById('playerName');
const pingPill = document.getElementById('pingPill');
const statusBanner = document.getElementById('statusBanner');
const buzzBtn = document.getElementById('buzzBtn');
const queueList = document.getElementById('queueList');
const mathOverlay = document.getElementById('mathOverlay');
const equationText = document.getElementById('equationText');
const answerForm = document.getElementById('answerForm');
const answerInput = document.getElementById('answerInput');
const mathTimer = document.getElementById('mathTimer');

let hasBuzzedThisRound = false;
let currentEquationId = null;
let timerBarEl = null;

socket.on('connect', () => {
  socket.emit('register', { name });
});

socket.on('registered', ({ name: confirmedName }) => {
  playerNameEl.textContent = confirmedName;
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

buzzBtn.addEventListener('click', () => {
  if (buzzBtn.disabled) return;
  hasBuzzedThisRound = true;
  buzzBtn.disabled = true;
  socket.emit('buzz');
});

socket.on('state:update', ({ armed, winner, queue }) => {
  if (armed && queue.length === 0) {
    hasBuzzedThisRound = false; // fresh round started by host
  }

  if (winner) {
    statusBanner.textContent = `🏆 ${winner} buzzed in first!`;
    statusBanner.className = 'status-banner status-winner';
  } else if (armed) {
    statusBanner.textContent = 'Buzzer is live - go!';
    statusBanner.className = 'status-banner status-armed';
  } else {
    statusBanner.textContent = 'Waiting for host to start the round...';
    statusBanner.className = 'status-banner status-waiting';
  }

  buzzBtn.disabled = !armed || !!winner || hasBuzzedThisRound;

  // If we no longer have a pending entry in the queue, close any open math overlay.
  const mine = queue.find((e) => e.name === name);
  if (!mine || mine.status !== 'pending') {
    closeMathOverlay();
  }

  renderQueue(queue);
});

function renderQueue(queue) {
  queueList.innerHTML = '';
  queue.forEach((entry) => {
    const li = document.createElement('li');
    li.className = `q-${entry.status}`;
    const suffix =
      entry.status === 'correct' ? ' ✅' :
      entry.status === 'wrong' ? ' ✗ wrong answer' :
      entry.status === 'timeout' ? ' ⏱ too slow' :
      entry.status === 'pending' ? ' (solving...)' : ' (waiting)';
    li.textContent = `${entry.name} - +${entry.msAfterFirst}ms${suffix}`;
    queueList.appendChild(li);
  });
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
