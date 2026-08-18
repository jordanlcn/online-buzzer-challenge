# Online Buzzer

Real-time buzzer for trivia/game-show style play, with a math-check
confirmation step and a host control panel.

## Run it

```bash
npm install
npm start
```

Then open:
- `http://localhost:3000/host.html` — enter your company name to get in, then it
  generates a room code
- `http://localhost:3000/` — players enter the room code and their name here

For a LAN game (multiple devices), share `http://<your-computer-ip>:3000/` with players
instead of localhost.

## How it works

- **Company-name gate on the host dashboard**: before a host can create a room,
  they must type a company name; only `Five9` (case-insensitive) is accepted right
  now (`REQUIRED_COMPANY` in `server.js`). This is a lightweight gate, not real
  auth — it's enforced server-side (rejecting `host:createRoom` from an
  unauthenticated socket) so it can't be bypassed by editing the page, but there's
  no password/account system behind it. Players never see this gate; only whoever
  is running the host dashboard needs to pass it, since a room can't exist without
  one. The cache in `sessionStorage` just avoids retyping it on a reconnect.
- **Math Challenge on/off** (host dashboard): a checkbox that toggles whether
  buzzing in requires solving an equation at all. When off, buzzing in
  successfully *is* the win — no challenge is issued, the buzzer immediately
  marks that player "correct," and the same top-5-correct cap still applies
  (so it becomes "first 5 people to buzz win"). The host table shows
  "N/A (math off)" in the Equation/Answer columns while it's off.
- **Configurable time limit** (host dashboard, only relevant while Math Challenge
  is on): a number input (2-60 seconds) for how long a buzzer has to answer their
  equation. Leave it blank and the field's placeholder shows the suggested time
  for the current difficulty (`SUGGESTED_SECONDS` in `server.js`: Easy 5s, Medium
  8s, Hardest 12s) — that suggested value is what's actually used until the host
  types a custom number. Changing difficulty while the field is blank updates the
  placeholder/suggestion automatically.
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
- **Tracking**: both the host dashboard and every player's own page show the same
  "Live Buzz Order" table for the current round — name, milliseconds behind the
  first buzz, the exact equation each buzzer was given, what they actually typed
  in, and the resulting status (correct/wrong/timeout/skipped). This is safe to
  share with players because each buzzer gets their own independently-random
  equation (never reused), so seeing someone else's doesn't help you guess a
  future one. The host dashboard additionally has a persistent leaderboard
  (total buzzes, wins, misses) across rounds, which stays host-only.
- **Reset controls** (host dashboard):
  - *Start / Next Round* — arms the buzzer for a new question, clears the
    current round's queue, keeps the leaderboard.
  - *Reset Round* — clears the current round's queue without re-arming.
  - *Reset Everything* — wipes the leaderboard and all round data (asks for
    confirmation first).

## Notes / things to adjust if you extend this

- The company-name gate (`REQUIRED_COMPANY` in `server.js`) is intentionally
  simple — a single hardcoded accepted value, no accounts or passwords. Treat it
  as "keep casual outsiders out for now," not real access control.
- Suggested per-difficulty time limits live in `SUGGESTED_SECONDS` in `server.js`;
  the host can always override with a custom value between `MIN_TIME_LIMIT_SECONDS`
  and `MAX_TIME_LIMIT_SECONDS` (2-60s by default).
- All state is in-memory; restarting the server clears players and scores.
