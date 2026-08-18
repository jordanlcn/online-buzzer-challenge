const socket = io();

const authGate = document.getElementById('authGate');
const dashboardContent = document.getElementById('dashboardContent');
const authForm = document.getElementById('authForm');
const companyInput = document.getElementById('companyInput');
const authError = document.getElementById('authError');

const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const rerollBtn = document.getElementById('rerollBtn');
const difficultySelect = document.getElementById('difficultySelect');
const mathEnabledToggle = document.getElementById('mathEnabledToggle');
const timeLimitInput = document.getElementById('timeLimitInput');
const showLiveStatsToggle = document.getElementById('showLiveStatsToggle');
const armBtn = document.getElementById('armBtn');
const resetRoundBtn = document.getElementById('resetRoundBtn');
const resetAllBtn = document.getElementById('resetAllBtn');
const roundStatus = document.getElementById('roundStatus');
const hostQueueBody = document.getElementById('hostQueueBody');
const leaderboardBody = document.getElementById('leaderboardBody');

let latestLatency = new Map();

// --- company-name gate ---
// Lightweight access control: only hosts who type the right company name can
// create a room. Cached in sessionStorage so a reconnect (not a full page
// reload) doesn't force retyping it.
socket.on('connect', () => {
  const cached = sessionStorage.getItem('buzzer_company');
  if (cached) socket.emit('host:authenticate', { companyName: cached });
});

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('host:authenticate', { companyName: companyInput.value.trim() });
});

socket.on('host:authenticated', ({ ok, message }) => {
  if (ok) {
    sessionStorage.setItem('buzzer_company', companyInput.value.trim() || sessionStorage.getItem('buzzer_company') || '');
    authGate.classList.add('hidden');
    dashboardContent.classList.remove('hidden');
    authError.textContent = '';
    socket.emit('host:createRoom');
  } else {
    authError.textContent = message || 'That company name was not recognized.';
  }
});

socket.on('room:created', ({ code }) => {
  roomCodeDisplay.textContent = code;
});

socket.on('room:code', ({ code }) => {
  roomCodeDisplay.textContent = code;
});

socket.on('room:closed', ({ reason }) => {
  if (reason === 'inactive_timeout') {
    alert('This room was closed for being idle too long. Starting a new one.');
    socket.emit('host:createRoom');
  }
});

rerollBtn.addEventListener('click', () => socket.emit('host:rerollCode'));

difficultySelect.addEventListener('change', () => socket.emit('host:setDifficulty', difficultySelect.value));

mathEnabledToggle.addEventListener('change', () => socket.emit('host:setMathEnabled', mathEnabledToggle.checked));

timeLimitInput.addEventListener('change', () => {
  const value = timeLimitInput.value.trim();
  socket.emit('host:setTimeLimit', { seconds: value === '' ? null : Number(value) });
});

showLiveStatsToggle.addEventListener('change', () => socket.emit('host:setShowLiveStats', showLiveStatsToggle.checked));

armBtn.addEventListener('click', () => socket.emit('host:arm'));
resetRoundBtn.addEventListener('click', () => socket.emit('host:resetRound'));
resetAllBtn.addEventListener('click', () => {
  if (confirm('Reset ALL players and stats? This cannot be undone.')) {
    socket.emit('host:resetAll');
  }
});

const MAX_WINNERS_PER_ROUND = 5; // matches server.js MAX_WINNERS_PER_ROUND

socket.on('state:update', ({ armed, winner, queue }) => {
  const correctCount = queue.filter((e) => e.status === 'correct').length;
  const progress = `${correctCount}/${MAX_WINNERS_PER_ROUND} correct`;
  if (winner) {
    roundStatus.textContent = `🏆 Winner: ${winner} (${progress})`;
  } else if (armed) {
    roundStatus.textContent = queue.length === 0 ? 'Armed - waiting for first buzz...' : `Round in progress... (${progress})`;
  } else {
    roundStatus.textContent = 'Round not armed. Click "Start / Next Round" when ready.';
  }

  hostQueueBody.innerHTML = '';
  queue.forEach((entry) => {
    const tr = document.createElement('tr');
    const equation = entry.equation ?? '-';
    const answer = entry.submittedAnswer ?? '-';
    tr.innerHTML = `<td>${entry.rank}</td><td>${escapeHtml(entry.name)}</td><td>+${entry.msAfterFirst}ms</td><td>${escapeHtml(equation)}</td><td>${escapeHtml(answer)}</td><td>${entry.status}</td>`;
    hostQueueBody.appendChild(tr);
  });
});

socket.on('leaderboard:update', (rows) => {
  leaderboardBody.innerHTML = '';
  rows.forEach((row) => {
    const ping = latestLatency.get(row.name);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(row.name)}</td><td>${row.wins}</td><td>${row.buzzCount}</td><td>${row.misses}</td><td>${ping !== undefined ? ping + ' ms' : '--'}</td>`;
    leaderboardBody.appendChild(tr);
  });
});

socket.on('latency:update', (entries) => {
  latestLatency = new Map(entries);
});

socket.on('difficulty:update', (level) => {
  difficultySelect.value = level;
});

socket.on('settings:update', ({ mathEnabled, timeLimitSeconds, suggestedSeconds, showLiveStats }) => {
  mathEnabledToggle.checked = mathEnabled;
  timeLimitInput.disabled = !mathEnabled;
  timeLimitInput.placeholder = `${suggestedSeconds}s suggested`;
  showLiveStatsToggle.checked = showLiveStats;
  // Only overwrite what's typed if it doesn't already match (avoids cursor jumps while typing).
  const shown = timeLimitSeconds === null ? '' : String(timeLimitSeconds);
  if (document.activeElement !== timeLimitInput) {
    timeLimitInput.value = shown;
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
