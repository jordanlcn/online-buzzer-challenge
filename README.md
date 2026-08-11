# Online Buzzer

Real-time buzzer for trivia/game-show style play, with a math-check
confirmation step and a host control panel.

## Run it

```bash
npm install
npm start
```

Then open:
- `http://localhost:3000/` — players register their name here
- `http://localhost:3000/host.html` — host dashboard (don't share this link with players)

For a LAN game (multiple devices), share `http://<your-computer-ip>:3000/` with players
instead of localhost.

## How it works

- **Registration**: players enter a name on the landing page before they can buzz.
- **Fair ordering regardless of internet speed**: every buzz is timestamped the
  instant it *arrives* at the server (`Date.now()` inside the server's socket
  handler) — never using the client's own clock. This is the important bit:
  if ordering were based on client-reported timestamps, a player with a
  faster connection or a skewed clock could appear to buzz first even if they
  physically pressed the button later. Using server-arrival time as the only
  source of truth keeps it fair.
- **Low latency transport**: uses Socket.IO (WebSockets), so buzzes are pushed
  instantly instead of relying on polling.
- **Math confirmation**: the moment a buzz is registered, that player gets a
  single-digit `+`/`-` equation (e.g. `7 - 6 = ?`) and has 6 seconds to answer.
  If they get it wrong or time out, they're marked eliminated for that round
  and the *next* person in the server-timestamp queue is immediately given
  their own equation — this repeats until someone answers correctly (they win
  the round) or the queue runs out.
- **Live ping display**: each player page shows its own round-trip ping to
  the server. This is informational only (visible on the host dashboard too)
  and does not affect who is judged first — see fairness note above.
- **Tracking**: the host dashboard shows the live buzz-in order for the
  current round (name, milliseconds behind the first buzz, math result) and
  a persistent leaderboard (total buzzes, wins, misses) across rounds.
- **Reset controls** (host dashboard):
  - *Start / Next Round* — arms the buzzer for a new question, clears the
    current round's queue, keeps the leaderboard.
  - *Reset Round* — clears the current round's queue without re-arming.
  - *Reset Everything* — wipes the leaderboard and all round data (asks for
    confirmation first).

## Notes / things to adjust if you extend this

- The math-answer time limit is `MATH_TIMEOUT_MS` in `server.js` (currently 6000ms).
- There's no authentication on `/host.html` — anyone with the link can control
  the game. Fine for a trusted LAN/Zoom setting; add a passphrase check if
  you need to lock it down.
- All state is in-memory; restarting the server clears players and scores.
