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
- **Host disconnect resilience**: if the host's connection drops (wifi blip,
  accidental refresh, tab briefly closed/reopened), the room does **not** close
  immediately. It stays fully alive for a 60-second grace period (`HOST_GRACE_MS`
  in `server.js`) — buzzing, math checks, and everything else keep working
  normally for players the whole time, since none of that depends on the host
  being connected. The host's browser caches a resume token in `sessionStorage`;
  if it reconnects within that window (including via a page refresh), it
  silently resumes control of the *same* room — same code, same players, same
  round in progress — instead of starting a new one. Players see a small
  "The Host has lost connection - attempting to reconnect" banner while this is happening,
  which clears automatically once the host is back. If the host genuinely
  doesn't return within 60 seconds, the room closes for good and every player
  gets the "host closed the room" alert, same as before.
- **Abandoned rooms** (no activity — no buzzes, resets, joins, etc. — for 3 hours)
  are automatically cleaned up by a background sweep, even if a host tab is still
  technically connected. This is a safety net; the normal cleanup path is the
  immediate close on host disconnect above.
- **Registration**: players enter a room code and name on the landing page before they can buzz.
- **"Join a New Room" link** (player page): lets a player leave their current
  room and join a different one, without needing to type their name again —
  it's pre-filled on the join screen. Leaving is just a page navigation, which
  the server treats as a normal disconnect (the old room immediately shows
  them gone from Connected Players); nothing special needs to happen for them
  to show up as a fresh join in the new room.
- **Fair ordering regardless of internet speed**: every buzz is timestamped the
  instant it *arrives* at the server (`Date.now()` inside the server's socket
  handler) — never using the client's own clock. This is the important bit:
  if ordering were based on client-reported timestamps, a player with a
  faster connection or a skewed clock could appear to buzz first even if they
  physically pressed the button later. Using server-arrival time as the only
  source of truth keeps it fair.
- **Low latency transport**: uses Socket.IO (WebSockets), so buzzes are pushed
  instantly instead of relying on polling.
- **Math confirmation, given to everyone in parallel, capped at 5 correct**: every
  buzzer gets their own equation the instant they buzz — there's no waiting in
  line for a turn (`MAX_WINNERS_PER_ROUND` in `server.js` sets the cap, currently
  5). Wrong answers and timeouts don't count against that target. The *first*
  person to answer correctly is recorded as the round's winner (shown in the
  banner and credited a win on the leaderboard). The moment the 5th correct
  answer is posted, the buzzer disables itself immediately: anyone still
  mid-challenge at that instant has their equation voided (marked "skipped,"
  their timer cancelled, their answer no longer accepted even if they submit
  one), and any brand-new buzz attempt after that point is rejected outright.
- **Difficulty control** (host dashboard): pick *Easy* (both numbers single-digit,
  0-9), *Medium* (each number independently single- or two-digit, so equations
  mix), or *Hardest* (both numbers two-digit, 10-99). Takes effect on the next
  equation issued; persists across round resets until changed again.
- **Live ping display**: each player page shows its own round-trip ping to
  the server. This is informational only (visible on the host dashboard too)
  and does not affect who is judged first — see fairness note above.
- **Audio alert on the player page**: a short generated tone (Web Audio API,
  no sound file needed) plays once whenever the buzzer transitions from not
  armed to armed, so players get an audible heads-up instead of having to
  watch the screen. It won't double-fire for a redundant re-arm while already
  armed, and only fires again after a genuine reset-and-rearm. Every browser
  keeps audio muted (and its clock frozen) until the page has seen a real
  click/tap/keypress — if the buzzer goes live before that's happened, the
  alert is deferred and fires the instant the player's first interaction
  unlocks it, using a fresh clock rather than replaying something scheduled
  while frozen (that mismatch is what caused garbled/delayed playback in
  Firefox and silence in Edge in earlier testing).
- **Tracking**: both the host dashboard and every player's own page show the same
  "Live Buzz Order" table for the current round — name, milliseconds behind the
  first buzz, the exact equation each buzzer was given, what they actually typed
  in, and the resulting status (correct/wrong/timeout/skipped). This is safe to
  share with players because each buzzer gets their own independently-random
  equation (never reused), so seeing someone else's doesn't help you guess a
  future one. The host dashboard additionally has a persistent leaderboard
  (total buzzes, wins, misses) across rounds.
- **Winner row highlighted for everyone**: the round's winner - first to buzz
  AND answer correctly - gets a gold highlight with a 🏆 in their row of the
  Live Buzz Order table, on both the host dashboard and every player's own
  page. Since up to 5 people can answer correctly per round, other correct
  rows stay in normal styling; only the actual winner (matched against
  `state:update`'s `winner` field) gets the highlight.
- **No spoilers on the player side**: a player only sees who won (the banner
  text and the gold row highlight) once *their own* buzz attempt this round
  has reached a final outcome - they buzzed and got marked correct, wrong,
  timed out, or skipped, or they never got a chance to buzz and the buzzer's
  no longer open to them. While they're still mid-challenge, the banner just
  shows generic progress ("Buzzer is live," or the correct-count) instead of
  revealing who already answered correctly. The host dashboard has no such
  suppression - it always shows the real-time winner immediately.
- **"Show Live Stats to Players" toggle** (host dashboard): off by default. When
  the host switches it on, that same leaderboard (name, wins, total buzzes,
  misses) also appears in a "Live Stats" panel on every player's own page,
  updating in real time. Switching it back off immediately hides the panel and
  clears it client-side for every player still connected.
- **Reset controls** (host dashboard):
  - *Start / Next Round* — arms the buzzer for a new question, clears the
    current round's queue, keeps the leaderboard.
  - *Reset Round* — clears the current round's queue without re-arming.
  - *Reset Everything* — wipes the leaderboard and all round data (asks for
    confirmation first).
  - *Close Room* — ends the game on demand: every connected player is
    disconnected immediately with a "host closed the room" alert, and the
    host's dashboard spins up a brand-new room/code right away. Clicking it
    opens a confirmation dialog that spells out every consequence (players
    disconnected, the current code deactivated, the in-progress round and its
    buzz order discarded, this room's leaderboard permanently erased, a fresh
    room created immediately after) before anything actually happens.
- **Duplicate names are rejected within a room** (case-insensitive) — if
  "Alice" is already connected, a second person can't also join as "alice."
  Without this, two players sharing a name would silently merge into one
  leaderboard entry (wins/misses keyed by name).
- **Player reconnection resilience**: mirrors the host resilience above, but
  for players — if a player's phone locks, wifi drops, or they refresh the
  page, their browser holds a per-player resume token. Reconnecting with it
  silently re-attaches them to the same room under the same name, and if they
  had a math challenge in flight when they dropped, it's re-sent to them with
  its correct *remaining* time (not restarted from full) so they can still
  answer it. This also closes a fairness gap: without it, a reconnected player
  got a new connection ID and could buzz a second time under the same name;
  the one-buzz-per-round check is now keyed to name, not connection ID.
- **A player's own connection status is shown to them**: if *their* link to
  the server drops (separate from the host-status banner above, which is
  about the host's connection), they see a "Connection lost - reconnecting..."
  banner and their buzz button disables until they're back — Socket.IO
  retries automatically, this just gives visible feedback instead of a
  silently-unresponsive page.
- **Connected Players panel** (host dashboard): shows a live count and name
  list of everyone currently connected to the room, separate from the
  leaderboard (which only gets an entry once someone buzzes at least once, and
  keeps showing people who've since disconnected). Useful for "is everyone in
  before I start?" with a large group.
- **Crash isolation**: this server is one process shared by every live room,
  so an unhandled error anywhere could otherwise take down every game at once.
  Every socket event handler is wrapped so a thrown error is logged and
  contained to that one action instead of crashing the process; the two
  background timers (challenge timeouts, the inactivity sweep) are wrapped the
  same way; and process-level `uncaughtException`/`unhandledRejection`
  listeners log anything that still somehow gets through, as a last resort.
  Handlers also default missing/malformed payloads to a safe empty value
  (e.g. a client emitting an event with no data at all) rather than throwing
  on destructuring, so most bad input never even reaches the try/catch.

## Notes / things to adjust if you extend this

- The company-name gate (`REQUIRED_COMPANY` in `server.js`) is intentionally
  simple — a single hardcoded accepted value, no accounts or passwords. Treat it
  as "keep casual outsiders out for now," not real access control.
- Suggested per-difficulty time limits live in `SUGGESTED_SECONDS` in `server.js`;
  the host can always override with a custom value between `MIN_TIME_LIMIT_SECONDS`
  and `MAX_TIME_LIMIT_SECONDS` (2-60s by default).
- All state is in-memory; restarting the server clears players and scores.
