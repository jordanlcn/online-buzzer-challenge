const socket = io();

const difficultySelect = document.getElementById('difficultySelect');
const armBtn = document.getElementById('armBtn');
const resetRoundBtn = document.getElementById('resetRoundBtn');
const resetAllBtn = document.getElementById('resetAllBtn');
const roundStatus = document.getElementById('roundStatus');
const hostQueueBody = document.getElementById('hostQueueBody');
const leaderboardBody = document.getElementById('leaderboardBody');

let latestLatency = new Map();

socket.on('connect', () => socket.emit('host:join'));

difficultySelect.addEventListener('change', () => socket.emit('host:setDifficulty', difficultySelect.value));

armBtn.addEventListener('click', () => socket.emit('host:arm'));
resetRoundBtn.addEventListener('click', () => socket.emit('host:resetRound'));
resetAllBtn.addEventListener('click', () => {
  if (confirm('Reset ALL players and stats? This cannot be undone.')) {
    socket.emit('host:resetAll');
  }
});

socket.on('state:update', ({ armed, winner, queue }) => {
  if (winner) {
    roundStatus.textContent = `🏆 Winner: ${winner}`;
  } else if (armed) {
    roundStatus.textContent = queue.length === 0 ? 'Armed - waiting for first buzz...' : 'Round in progress...';
  } else {
    roundStatus.textContent = 'Round not armed. Click "Start / Next Round" when ready.';
  }

  hostQueueBody.innerHTML = '';
  queue.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${entry.rank}</td><td>${escapeHtml(entry.name)}</td><td>+${entry.msAfterFirst}ms</td><td>${entry.status}</td>`;
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
