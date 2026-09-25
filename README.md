# dicevibe

**Roll dice, take provinces, take everything.**

A multiplayer dice-war game for 2–8 players in the browser. Every board is
generated fresh, you start with five provinces and a handful of dice, and the
last player holding land wins.

![dicevibe](docs/screenshot.png)

---

## Vibecoded, start to finish

dicevibe is fully vibecoded. One prompt wrote the whole thing — the server, the
map generator, the bots, the interface and its test suite — and a few short
follow-up prompts lifted it up afterwards. No part of it was written by hand.

The lift-ups, roughly in the order they came:

- **Alliances.** Pacts you can propose, accept and break, with bots that
  negotiate back and never attack a friend.
- **A board you can read.** Hovering a province fades everyone else's land out,
  and the dice ciphers dropped their badges and went plain black.
- **The turn you are on.** The board's whole surround turns red when the turn
  comes round to you, and stays red until you move the pointer over the map.
- **Skipping the wait.** A ⏩ button that ends a bot's turn immediately instead
  of one beat at a time.
- **Room to breathe.** The End turn row and the players list stopped fighting
  over the same margin.
- **A second bot.** The original policy became v1, a searching one became v2, and
  Add bot now deals one at random — with an arena built to check whether the new
  one is actually any harder to beat, which it mostly is not. That is written up
  in [The bots](#the-bots) rather than smoothed over, because the measurement is
  the point.

---

## Quick start

You need **Node 20.11 or newer** (it uses `import.meta.dirname`) and nothing
else. There is no build step and no database — a game lives in the server's
memory for as long as the process does.

```bash
git clone https://github.com/dnkorbut/dicevibe.git
cd dicevibe
npm install
npm start
```

Then open **http://localhost:8880**.

`npm run dev` runs the same server under `node --watch`, so it restarts when you
edit a file.

Prefer a container? There's a `Dockerfile` and the same server runs in it
unchanged — see [Running in Docker](#running-in-docker) below. Everything else on
this page applies to both.

## Playing with other people

- **Same machine** — open a second browser tab (or a private window) at the same
  address. Each tab is its own seat.
- **Same network** — the server listens on every interface, so anyone on your
  Wi-Fi can join at `http://<your-machine's-ip>:8880`. Use `PORT=8080 npm start`
  if 8880 is taken.
- **Over the internet** — put it behind a tunnel or a port forward. There are no
  accounts and no TLS: plain HTTP, and a game is gone when the process stops.

## Running in Docker

The repo carries a `Dockerfile`, and the game runs in a container with nothing
extra to configure. It works the same under Podman and any other OCI-compatible
runtime — the commands below are the only difference.

```bash
docker build -t dicevibe .
docker run --rm -p 8880:8880 dicevibe
```

Then open **http://localhost:8880**, exactly as if you had run `npm start`.

- **The port.** The container listens on **8880**, the same port `npm start`
  uses, so nothing about the address changes when you containerise it.
  `-p 8080:8880` puts the game on 8080 of your machine. To move the port inside
  the container as well: `docker run --rm -e PORT=8080 -p 8080:8080 dicevibe`.
- **`EXPOSE` publishes nothing.** It is a note to whoever reads the image, and a
  container listening on 8880 can be published on any port you like — `-p` on
  `docker run` is the only thing that decides that.
- **Every other setting is an environment variable**, the same ones as on the
  host: `docker run --rm -e DICEVIBE_BOT_DELAY_MS=0 -p 8880:8880 dicevibe`.
- **Playing with others.** `-p 8880:8880` publishes on every interface, so
  anyone on your network joins at `http://<your-ip>:8880` — the container changes
  nothing about that.
- **Stopping it.** `docker stop` ends the game at once. Rooms live in memory,
  nothing is written to disk, and the server handles SIGTERM rather than making
  you wait out the grace period.
- **What's in the image.** Production dependencies only, no `test/`, no `docs/`
  and no `tools/` — the suite and the arena both run on the host — and running as
  the unprivileged `node` user that `node:24-alpine` already ships. There is no
  build step, no database, and no state to persist.

The tests need the checkout on the host (`npm test`): the image deliberately has
neither the test files nor `socket.io-client` in it.

---

## How to play

A short version of all of this is in the game itself: **How to play** on the
menu, and the **?** in the corner of the board once a game has started.

1. **Name yourself** (optional) and press **Create game**. Pick a map style and a
   size — or leave the size on *Style default*.
2. **Everyone else joins** from the same page: your game appears under *Open
   games*, and one click takes a seat. Up to 8.
3. **The host fills the empty seats with bots** if there aren't enough humans,
   then presses **Start game**. Two players minimum.
4. **On your turn**, click one of your provinces to pick it up. Every province it
   can legally attack lights up — click one of those to attack it. Click the same
   province again to put it down.
5. **Press End turn** when you're done. You can attack as many times as you like
   in a turn, in any order.
6. **The red frame** around the board means the turn is yours and you haven't
   looked at the map yet. Move the pointer over it and the frame goes.
7. **⏩** ends the current bot's turn right now, if a bot is the one thinking.
8. **Alliances** live in the players list on the right, on the small controls each
   row carries: propose a pact, accept or decline an offer, withdraw your own
   before it is answered, or break one you already have. The row itself is not a
   button — clicking a player does nothing.
9. **Clicking any province that isn't yours** highlights everything that player
   owns — handy while you're waiting for your turn.

## Rules

### Setting up

- Every player is dealt **5 provinces**, interleaved across the map, and every
  province on the board starts with **1 die**.
- Another **2 dice per province you were dealt** are then handed out at random,
  so stacks average about 3 and some start higher.
- Everything left over belongs to **neutral land**: unowned, never attacks, and
  grows. Once every second full round, every neutral province that isn't already
  at the cap gains a die. On a large map that is a wall you have to fight
  through, and it gets harder the longer you take.

### Attacking

- A province needs **at least 2 dice** to attack.
- The attacker rolls **one die fewer than it holds** — the die that stays home
  doesn't fight. A 7-stack attacks with 6.
- The defender rolls **its whole stack**.
- **Highest total wins, ties go to the defender.** So attacking equal stacks is a
  losing bet.
- **If the attacker wins**, the province changes hands and all but one of the
  attacking dice move in. The defending dice are **destroyed, not captured** — no
  one ever gains them — so the attacker's total is unchanged, it has only moved
  onto the new province. The prize is the land, not the stack.
- **If the defender holds**, the attacking stack collapses to **1 die**. The extra
  dice are destroyed, not pulled back. Attacking from a big stack is a real
  gamble.
- **No province ever holds more than 8 dice.**

### End of turn — reinforcement

- Pressing **End turn** pays you **1 die for every province you own**, into a
  reserve.
- The reserve is placed for you, on the provinces that need it most, and **it
  ranks them one die at a time** so a single province can't swallow the lot. It
  works through three questions in order:
  1. Is anything of mine **smaller than the strongest neighbouring player** who
     could attack it? Top up the deepest gap first.
  2. Once no player can outgun me anywhere, is anything smaller than the strongest
     **neutral** next door — the next province worth taking?
  3. Anything still left is **spread evenly** across provinces with room.
- An **ally's** provinces never count as a threat at any step, so reinforcement
  is never drained into a border that will never move.
- Dice that don't fit anywhere (every province at 8) **stay in your reserve** for
  later turns. The reserve has no cap.

### Winning and losing

- A player who owns **no provinces** is eliminated, and their turn is skipped from
  then on.
- Any pact naming an eliminated player dissolves.
- **The last player with land wins.** If you leave a decided game you can start
  another one; the finished board stays intact for everyone else to look at.

### Alliances

- Pacts are **public** — the whole table sees who proposed to whom, who accepted
  and who walked away.
- An ally **is not a threat** for reinforcement purposes (see above), and both
  sides of the edge are always written together.
- **Attacking an ally is perfectly legal**, and it breaks the pact. Attack one and
  the roll log says so.
- Pacts are **not** turn-gated: you can answer an offer while somebody else is
  thinking.
- A dropped connection **does not** void a pact — otherwise a rage-quit would be a
  way out of an alliance.

### The bots

Two policies ship, and **Add bot** deals one of them at random, so a table of bots
is usually a mixed table. The name says which you got: `v1 2` is the second v1 at
the table, `v2 1` the first v2.

Both are pure functions of the board. Neither rolls anything, reads the clock, or
sees a single fact a human at the table could not: they are handed the provinces,
the dice, and their own alliances, and nothing else. Nobody's reserves, nobody's
plan, and above all not the next roll — the dice are thrown after the move is
chosen, by the server, from a stream the policy has no way to reach.

**v1** plays the roll in front of it, and plays it well:

- **It attacks when it outnumbers the defender.** A repelled attack costs the
  attacker its extra dice, a capture keeps them, and once you work it out the
  whole expected value boils down to `N > M` — attack with more dice than the
  province next door holds, and not otherwise. (That is what v1's own arithmetic
  says. The first bullet under v2 is about the term in it that is not true.)
- **It gambles when nothing else is left.** If both stacks are already at 8 dice,
  no attack can become profitable and no reinforcement can improve anything, so a
  bot takes the roll anyway. It is the only move that changes the board, and
  without it two bots could sit there forever.

**v2** plans the whole turn instead of a single roll, and searches ahead. Four
things it does differently, in rough order of how much they matter:

- **It does not pay itself the defender's dice.** v1's arithmetic credits a win
  with the defender's stack, and those dice are *destroyed* — the same thing the
  rules section above says plainly. v1's header states the payoff as "the M dice
  removed from the defender plus the territory itself", so its appetite for
  attacking is funded by dice nobody ever receives. The size of it: 8 against 7,
  the roll v1's own comment calls "worth only about +0.04 dice", is honestly worth
  **−3.2**, and the difference between the two is exactly `p × M`. v2 cannot make
  this mistake, because it never writes a payoff formula — it applies the real
  capture rule to a real board and scores what comes out, so the destroyed dice
  are simply absent from the position it looks at.
- **It knows what land is for.** A province pays a die *every turn* for the rest of
  the game, so v2 prices land at several dice rather than one. (This pulls the
  opposite way to the point above — one error made v1 too keen to attack, this one
  made it too slow to — which is a large part of why fixing either one alone
  changes nothing measurable. See `TUNING` in `server/bot-v2.js`.)
- **It plays the race, and looks after its borders.** A position is scored against
  whoever is ahead, so taking a province off the leader beats taking it off the
  straggler with no special rule to say so; and a province of its own sitting short
  of the stack next door is counted as the loss it is about to be.
- **It weighs the outcomes instead of averaging them away.** v1 compares one
  expected number against zero and then treats it as certain. v2 prices the capture
  and the repel at the probability each actually happens, so the knife-edge gambles
  fall out on their own rather than needing a risk parameter to suppress.

**Both** never attack an ally, and both negotiate: answer a waiting offer before
moving anything else — accepting from a player who isn't in the lead, declining
from the player who is — then break a pact whose ally has taken the lead, then
propose to a non-leader they share a border with. One action at a time, one ask a
turn. Neither will spend dice on a lost cause either: a province facing only allies
gets no reinforcement, the same as one facing nobody.

**Is v2 actually harder to beat? It gets measured rather than asserted, and the
answer is genuinely not flattering.** `npm run bench` seats the policies at a real
table, on real boards, with the real rules:

```
$ npm run bench -- --games 3000
v1 vs v2 — 3000 games, 136 beats each
  v2   1536 wins   51.2%   (95% CI 49.4–53.0%)
  v1   1464 wins   48.8%   (95% CI 47.0–50.6%)
  3000 decided, 0 drawn, 0 unfinished
  first move wins — seat 0: 69.1%, seat 1: 30.9%
  v2 by seat — seat 0: 70.3% (n=1500), seat 1: 32.1% (n=1500)
  v1 by seat — seat 0: 67.9% (n=1500), seat 1: 29.7% (n=1500)

$ npm run bench -- --seats 1,1,2,2 --games 800
v1 vs v2 — seats 1,1,2,2 — 800 games, 579 beats each
  v1    413 wins   51.6%   (95% CI 48.2–55.1%)
  v2    387 wins   48.4%   (95% CI 44.9–51.8%)
  800 decided, 0 drawn, 0 unfinished
```

**Neither interval excludes 50, so the honest reading is that v2 is not
demonstrably the stronger bot.** Heads-up it is 1.2 points ahead; at a four-player
table it is 3.2 points behind; both sit inside the noise. The thing that *is*
established is that the two are very close — which is worth saying out loud,
because the natural impulse is to report the heads-up run and quietly not run the
other one.

**Why the elaborate policy does not convert into wins** is the interesting part,
and the sweeps say something fairly specific. `--sweep` changes one weight and
replays the identical set of games, and almost nothing moves: `exposure` wanders
between 46% and 51% with no trend, `lead` between 48% and 52%, `province` is flat
at 50.3% for 0, 2 and 8. Two things do stand out — setting `province` to 0 drops
it to 50.3%, and setting `depth` to 0 drops it to 50.0% — but `depth: 0` is not a
tuning choice, it is the control: with no search, `planMove` falls through to the
v1 floor and v2 *is* v1, so a dead-even result there is the proof that the harness
is not quietly leaning toward either side.

The reading that fits all of it: v1's two main errors push in **opposite**
directions. It pays itself the defender's dice, which makes it attack rolls it
should decline; and it prices land as a one-off, which makes it slow to expand. So
correcting either one alone buys nothing measurable — which is exactly what
`province: 0` and `depth: 0` each reported — and the aggressive play it buys back
with one hand gets spent on bad rolls with the other. Two mistakes that cancel are
a much harder thing to beat than one mistake, and that, rather than any cleverness
in the search, is why a policy with a better argument behind it lands within a
point or two of the simple rule.

None of which makes v2 pointless. It does not make a specific error that v1 does,
it reasons about a position instead of a roll, and it is structurally incapable of
cheating — but on the evidence here, **"unbeatable" is not a thing this game
offers**, and a bot that is a little better argued and about as hard to beat is the
honest result.

The arena drives the same functions the server does — there is no second copy of
any rule in it — so what it measures is the shipped game. Two things about how it
is run are worth knowing before trusting a number from it:

- **The games are seeded, so a run is repeatable.** Every run plays the same fixed
  boards, which is what makes `--sweep` a paired comparison instead of two
  unrelated samples. Before that, the same configuration scored 54.0% once and
  44.0% the next time, and neither figure meant anything.
- **There is a control, and it should come out at 50%.** See `depth = 0` above.
  If that line ever stops being 50%, the harness is leaning toward one policy and
  every other number it prints is suspect.

## Maps

The picker offers two styles, each with four sizes:

| Style | What it looks like |
|---|---|
| **Continent** | A broad landmass speckled with inland seas. |
| **Ridge** | One dry continent, carved into provinces. |

| Size | Provinces |
|---|---|
| Small | 40 |
| Medium | 70 |
| Large | 110 |
| Huge | 150 |

Boards are minted per game from the room's own seed, so two games on the same
style are different maps. Three more presets are generated and tested but kept
off the menu — *Highlands*, *Archipelago* and *Frontier* — and you can look at any
of them at `/dev/map?preset=frontier`.

That preview generates a board synchronously, so it is deliberately not
unbounded: no boards over 400 provinces, and ten at a time with two a second
after that, past which it answers `429`. It is a page for eyeballing geometry,
not an API — the limits are there so a request nobody meant to make cannot stall
every game in the process.

## Configuration

Every knob is an environment variable, and the defaults are what you get from a
plain `npm start`:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8880` | Port to listen on, on the host and in the container alike. |
| `DICEVIBE_BOT_DELAY_MS` | `1000` | How long a bot "thinks" between beats. `0` makes it instant. |
| `DICEVIBE_ROOM_SEED` | random | Pins every room's dice and board, so a game replays exactly. |
| `DICEVIBE_MAP_SEED` | `20260923` | Fixed geometry seed for the dev map preview. |
| `DICEVIBE_TERRITORIES` | *(unset)* | Forces every board to this many provinces — `DICEVIBE_TERRITORIES=6 npm run dev` is a game you can finish in a minute. |

## How it works

- **The server owns the game.** The client never decides anything: it sends
  intents (`attack`, `endTurn`, `allianceRequest`…) and renders the whole
  idempotent snapshot that comes back. Re-rendering the same snapshot twice is
  free, and a client that misses one is correct again on the next.
- **Every random number is seeded.** Dice, the board layout, the starting deal —
  all of it comes from one small `mulberry32` generator per room, so a game is
  reproducible from its seed. `Math.random()` is banned from game logic, which is
  what makes the rule tests deterministic.
- **Maps are Voronoi cells.** Land is scattered on a jittered grid, relaxed a few
  times, clipped to a canvas and turned into polygons with `d3-delaunay`;
  adjacency comes from the same tessellation, so the board and the rules can never
  disagree about what touches what.
- **No framework, no bundler, no build.** A plain ESM client using
  `<script type="module">` and a raw `<svg>`, and the rules module is shared
  verbatim between the browser and the server.

## Tests

```bash
npm test
```

286 tests, run by `node --test` with no test framework:

- **Rules** — attack resolution, reinforcement placement, elimination and the win
  check, including Monte Carlo checks on the dice maths.
- **Bots** — hand-built boards with exact expected moves, a bot-vs-passive game
  that has to terminate, and — for v2 — a few hundred generated boards asserting
  the properties a policy can fail on without any fixture noticing: that it never
  proposes an illegal attack, never attacks an ally, and never goes quiet on a
  board where v1 would have moved. That last one is the termination floor, and it
  is a property rather than a case because the failure it guards against is a game
  that stops ending.
- **Maps** — every preset generates a connected, playable board at every size.
- **Rooms** — seats, the grace period after a disconnect, and what a snapshot is
  allowed to contain.
- **The client** — a static check that every class the client applies exists in
  the stylesheet, every id it queries exists in the HTML, and every error code has
  text to show.
- **Integration** — real Socket.IO clients playing real games on a real server,
  including a bot game played to a winner, disconnects and resuming, and the
  alliance flows.

Not everything is a test. **Whether v2 is actually the stronger bot** is not
something a pass/fail assertion can say, so it is not in the suite — it is
`npm run bench`, which plays the two policies against each other and reports the
score. The suite checks that a policy is *correct*; the arena is what checks that
it is *better*, and it is the only reason the weights in `bot-v2.js` are what they
are rather than what looked reasonable.

## Layout

```
server/     the authoritative game
  index.js      HTTP + socket wiring, one handler per event
  game.js       start, attack, end turn, elimination
  rooms.js      seats, sessions, snapshots, the lobby list
  alliances.js  the five diplomacy transitions
  bots.js       the registry: which policy a seat's version means
  bot-v1.js     the original move policy and the diplomatic policy
  bot-v2.js     the searching move policy
  map.js        the Voronoi map generator and its presets
  rng.js        the seeded generator everything random goes through
shared/     rules.js and constants.js — imported by both halves, verbatim
public/     index.html, styles.css and the client under js/
test/       the suite
tools/      bot-arena.js — the policies playing each other, for the score
Dockerfile  the container build: production dependencies, unprivileged user
```
