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
const saveSessionDataToggle = document.getElementById('saveSessionDataToggle');
const armBtn = document.getElementById('armBtn');
const resetRoundBtn = document.getElementById('resetRoundBtn');
const resetAllBtn = document.getElementById('resetAllBtn');
const closeRoomBtn = document.getElementById('closeRoomBtn');
const closeRoomOverlay = document.getElementById('closeRoomOverlay');
const closeRoomCode = document.getElementById('closeRoomCode');
const closeRoomCancelBtn = document.getElementById('closeRoomCancelBtn');
const closeRoomConfirmBtn = document.getElementById('closeRoomConfirmBtn');
const endGameBtn = document.getElementById('endGameBtn');
const endGameOverlay = document.getElementById('endGameOverlay');
const endGameRoomCode = document.getElementById('endGameRoomCode');
const endGameCancelBtn = document.getElementById('endGameCancelBtn');
const endGameConfirmBtn = document.getElementById('endGameConfirmBtn');
const csvReadyOverlay = document.getElementById('csvReadyOverlay');
const csvDismissBtn = document.getElementById('csvDismissBtn');
const csvDownloadBtn = document.getElementById('csvDownloadBtn');
const roundStatus = document.getElementById('roundStatus');
const hostQueueBody = document.getElementById('hostQueueBody');
const leaderboardBody = document.getElementById('leaderboardBody');
const playersCount = document.getElementById('playersCount');
const playersList = document.getElementById('playersList');

let latestLatency = new Map();
let latestWinner = null;

// --- company-name gate ---
// Lightweight access control: only hosts who type the right company name can
// create a room. Cached in sessionStorage so a reconnect (not a full page
// reload) doesn't force retyping it.
//
// --- resilience for a dropped host connection ---
// The current room's sessionId is cached as a "resume token." On (re)connect,
// try that first: if it's still valid (room is within its grace period, or
// never lost its host at all), the server silently reattaches this socket as
// the room's host - same code, same players, same round in progress. Only
// falls back to the normal auth-and-create flow if there's no token, or the
// server says it's no longer valid (room already closed for good).
socket.on('connect', () => {
  const cachedToken = sessionStorage.getItem('buzzer_host_token');
  if (cachedToken) {
    socket.emit('host:resume', { token: cachedToken });
    return;
  }
  const cachedCompany = sessionStorage.getItem('buzzer_company');
  if (cachedCompany) socket.emit('host:authenticate', { companyName: cachedCompany });
});

socket.on('host:resumeFailed', () => {
  sessionStorage.removeItem('buzzer_host_token');
  const cachedCompany = sessionStorage.getItem('buzzer_company');
  if (cachedCompany) socket.emit('host:authenticate', { companyName: cachedCompany });
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

socket.on('room:created', ({ code, token }) => {
  roomCodeDisplay.textContent = code;
  authGate.classList.add('hidden');
  dashboardContent.classList.remove('hidden');
  if (token) sessionStorage.setItem('buzzer_host_token', token);
});

socket.on('room:code', ({ code }) => {
  roomCodeDisplay.textContent = code;
});

socket.on('room:closed', ({ reason }) => {
  sessionStorage.removeItem('buzzer_host_token');
  if (reason === 'inactive_timeout') {
    alert('This room was closed for being idle too long. Starting a new one.');
    socket.emit('host:createRoom');
  } else if (reason === 'host_closed') {
    socket.emit('host:createRoom'); // deliberate close - spin up a fresh room right away
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

saveSessionDataToggle.addEventListener('change', () => socket.emit('host:setSaveSessionData', saveSessionDataToggle.checked));

armBtn.addEventListener('click', () => socket.emit('host:arm'));
resetRoundBtn.addEventListener('click', () => socket.emit('host:resetRound'));
resetAllBtn.addEventListener('click', () => {
  if (confirm('Reset ALL players and stats? This cannot be undone.')) {
    socket.emit('host:resetAll');
  }
});
closeRoomBtn.addEventListener('click', () => {
  closeRoomCode.textContent = roomCodeDisplay.textContent;
  closeRoomOverlay.classList.remove('hidden');
});
closeRoomCancelBtn.addEventListener('click', () => {
  closeRoomOverlay.classList.add('hidden');
});
closeRoomConfirmBtn.addEventListener('click', () => {
  closeRoomOverlay.classList.add('hidden');
  socket.emit('host:closeRoom');
});

endGameBtn.addEventListener('click', () => {
  endGameRoomCode.textContent = roomCodeDisplay.textContent;
  endGameOverlay.classList.remove('hidden');
});
endGameCancelBtn.addEventListener('click', () => {
  endGameOverlay.classList.add('hidden');
});
endGameConfirmBtn.addEventListener('click', () => {
  endGameOverlay.classList.add('hidden');
  socket.emit('host:endGame');
});

// Sent only if "Save Session Data" was on and at least one buzz happened -
// builds the CSV server-side from the whole session's log, we just offer it
// as a file download here.
let pendingCsv = null;
socket.on('session:csv', ({ csv, filename }) => {
  pendingCsv = { csv, filename };
  csvReadyOverlay.classList.remove('hidden');
});
csvDismissBtn.addEventListener('click', () => {
  csvReadyOverlay.classList.add('hidden');
  pendingCsv = null;
});
csvDownloadBtn.addEventListener('click', () => {
  if (!pendingCsv) return;
  const blob = new Blob([pendingCsv.csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = pendingCsv.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  csvReadyOverlay.classList.add('hidden');
  pendingCsv = null;
});

const MAX_WINNERS_PER_ROUND = 5; // matches server.js MAX_WINNERS_PER_ROUND

socket.on('state:update', ({ armed, winner, queue }) => {
  latestWinner = winner;
  const correctCount = queue.filter((e) => e.status === 'correct').length;
  const progress = `${correctCount}/${MAX_WINNERS_PER_ROUND} correct`;
  if (winner) {
    roundStatus.textContent = `🏆 Winner: ${winner} (${progress})`;
  } else if (armed) {
    roundStatus.textContent = queue.length === 0 ? 'Armed - waiting for first buzz...' : `Round in progress... (${progress})`;
  } else {
    roundStatus.textContent = 'Round not armed. Click "Start / Next Round" when ready.';
  }
});

// Host-only: includes the equation and what each buzzer actually answered.
// Never sent to players, since everyone in a round shares the same equation.
socket.on('queue:detail', (queue) => {
  hostQueueBody.innerHTML = '';
  queue.forEach((entry) => {
    // The round's winner is whoever buzzed in first AND answered correctly -
    // there's only ever one, since a player can only buzz once per round.
    const isWinner = latestWinner && entry.name === latestWinner && entry.status === 'correct';
    const tr = document.createElement('tr');
    tr.className = isWinner ? 'winner-row' : '';
    const equation = entry.equation ?? '-';
    const answer = entry.submittedAnswer ?? '-';
    const statusLabel = isWinner ? `🏆 ${entry.status}` : entry.status;
    tr.innerHTML = `<td>${entry.rank}</td><td>${escapeHtml(entry.name)}</td><td>+${entry.msAfterFirst}ms</td><td>${escapeHtml(equation)}</td><td>${escapeHtml(answer)}</td><td>${statusLabel}</td>`;
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

socket.on('players:update', (names) => {
  playersCount.textContent = names.length;
  playersList.textContent = names.length ? names.join(', ') : '(no one has joined yet)';
});

socket.on('difficulty:update', (level) => {
  difficultySelect.value = level;
});

socket.on('settings:update', ({ mathEnabled, timeLimitSeconds, suggestedSeconds, showLiveStats, saveSessionData }) => {
  mathEnabledToggle.checked = mathEnabled;
  timeLimitInput.disabled = !mathEnabled;
  timeLimitInput.placeholder = `${suggestedSeconds}s suggested`;
  showLiveStatsToggle.checked = showLiveStats;
  saveSessionDataToggle.checked = saveSessionData;
  // Only overwrite what's typed if it doesn't already match (avoids cursor jumps while typing).
  const shown = timeLimitSeconds === null ? '' : String(timeLimitSeconds);
  if (document.activeElement !== timeLimitInput) {
    timeLimitInput.value = shown;
  }
});

// --- hover tooltips for host controls ---
// Custom (not the native title attribute) so we get an exact 2s delay and
// consistent styling. Any element with a data-tip attribute qualifies.
const tooltipBubble = document.getElementById('tooltipBubble');
let tooltipTimer = null;

function showTooltipFor(el) {
  const text = el.getAttribute('data-tip');
  if (!text) return;
  tooltipBubble.textContent = text;
  tooltipBubble.classList.remove('hidden');
  const rect = el.getBoundingClientRect();
  const bubbleRect = tooltipBubble.getBoundingClientRect();
  let top = rect.top - bubbleRect.height - 8;
  if (top < 8) top = rect.bottom + 8; // not enough room above - flip below
  let left = rect.left;
  if (left + bubbleRect.width > window.innerWidth - 8) {
    left = window.innerWidth - bubbleRect.width - 8;
  }
  if (left < 8) left = 8;
  tooltipBubble.style.top = `${top}px`;
  tooltipBubble.style.left = `${left}px`;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipBubble.classList.add('hidden');
}

document.querySelectorAll('[data-tip]').forEach((el) => {
  el.addEventListener('mouseenter', () => {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltipFor(el), 2000);
  });
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', () => {
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltipFor(el), 2000);
  });
  el.addEventListener('blur', hideTooltip);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
