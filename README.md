# Online Buzzer

Real-time buzzer for trivia/game-show style play, with a math-check
confirmation step and a host control panel.

## Run it

```bash
npm install
npm start
```

Then open:
- `http://localhost:3000/host.html` — host dashboard, generates a room code
- `http://localhost:3000/` — players enter the room code and their name here

For a LAN game (multiple devices), share `http://<your-computer-ip>:3000/` with players
instead of localhost.

## How it works

- **Rooms**: opening the host dashboard always creates a fresh room with a random
  6-digit code (host can click *New Code* to reroll it at any time before or during
  a game — already-joined players aren't affected by a reroll, it only changes what
  code new joiners need to type). Players must enter that code plus their name to
  join. Multiple independent games can run at once, each isolated in its own room.
- **If the host disconnects (closes the tab, refreshes, loses connection), the room
  closes immediately** and every player in it gets an alert saying the host closed
  the room, then gets sent back to the join screen. This means refreshing the host
  dashboard starts a brand-new room/code — it isn't a "resume" button.
- **Abandoned rooms** (no activity — no buzzes, resets, joins, etc. — for 3 hours)
  are automatically cleaned up by a background sweep, even if a host tab is still
  technically connected. This is a safety net; the normal cleanup path is the
  immediate close on host disconnect above.
- **Registration**: players enter a room code and name on the landing page before they can buzz.
- **Fair ordering regardless of internet speed**: every buzz is timestamped the
  instant it *arrives* at the server (`Date.now()` inside the server's socket
  handler) — never using the client's own clock. This is the important bit:
  if ordering were based on client-reported timestamps, a player with a
  faster connection or a skewed clock could appear to buzz first even if they
  physically pressed the button later. Using server-arrival time as the only
  source of truth keeps it fair.
- **Low latency transport**: uses Socket.IO (WebSockets), so buzzes are pushed
  instantly instead of relying on polling.
- **Math confirmation, open until 5 correct answers**: the buzzer stays open —
  any number of players can buzz in — until 5 players have answered their math
  challenge *correctly* (`MAX_WINNERS_PER_ROUND` in `server.js`). Buzzers are
  challenged one at a time in server-timestamp order; wrong answers and timeouts
  don't count against that target, so the queue keeps cascading through as many
  buzzers as it takes to find 5 correct answers. The *first* person to answer
  correctly is recorded as the round's winner (shown in the banner and credited a
  win on the leaderboard). Once the 5th correct answer lands, any players who had
  already buzzed but hadn't gotten their turn yet are marked "skipped," and any
  brand-new buzz attempt after that point is rejected outright.
- **Difficulty control** (host dashboard): pick *Easy* (both numbers single-digit,
  0-9), *Medium* (each number independently single- or two-digit, so equations
  mix), or *Hardest* (both numbers two-digit, 10-99). Takes effect on the next
  equation issued; persists across round resets until changed again.
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
