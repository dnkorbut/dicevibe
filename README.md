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

Then open **http://localhost:3000**.

`npm run dev` runs the same server under `node --watch`, so it restarts when you
edit a file.

Prefer a container? There's a `Dockerfile` and the same server runs in it
unchanged — see [Running in Docker](#running-in-docker) below. Everything else on
this page applies to both.

## Playing with other people

- **Same machine** — open a second browser tab (or a private window) at the same
  address. Each tab is its own seat.
- **Same network** — the server listens on every interface, so anyone on your
  Wi-Fi can join at `http://<your-machine's-ip>:3000`. Use `PORT=8080 npm start`
  if 3000 is taken.
- **Over the internet** — put it behind a tunnel or a port forward. There are no
  accounts and no TLS: plain HTTP, and a game is gone when the process stops.

## Running in Docker

The repo carries a `Dockerfile`, and the game runs in a container with nothing
extra to configure. It works the same under Podman and any other OCI-compatible
runtime — the commands below are the only difference.

```bash
docker build -t dicevibe .
docker run --rm -p 8888:8888 dicevibe
```

Then open **http://localhost:8888**, exactly as if you had run `npm start`.

- **The port.** The container listens on **8888**, because the image sets `PORT`
  for itself. That is the one thing that differs from running it on the host,
  where the server's own default of 3000 still applies — the image overrides the
  setting rather than changing the default, so `npm start` is unaffected.
  `-p 8080:8888` puts the game on 8080 of your machine. To move the port inside
  the container as well: `docker run --rm -e PORT=8080 -p 8080:8080 dicevibe`.
- **`EXPOSE` publishes nothing.** It is a note to whoever reads the image, and a
  container listening on 8888 can be published on any port you like — `-p` on
  `docker run` is the only thing that decides that.
- **Every other setting is an environment variable**, the same ones as on the
  host: `docker run --rm -e DICEVIBE_BOT_DELAY_MS=0 -p 8888:8888 dicevibe`.
- **Playing with others.** `-p 8888:8888` publishes on every interface, so
  anyone on your network joins at `http://<your-ip>:8888` — the container changes
  nothing about that.
- **Stopping it.** `docker stop` ends the game at once. Rooms live in memory,
  nothing is written to disk, and the server handles SIGTERM rather than making
  you wait out the grace period.
- **What's in the image.** Production dependencies only, no `test/` and no
  `docs/`, running as the unprivileged `node` user that `node:24-alpine` already
  ships. There is no build step, no database, and no state to persist.

The tests need the checkout on the host (`npm test`): the image deliberately has
neither the test files nor `socket.io-client` in it.

---

## How to play

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
8. **Alliances** live in the players list on the right: click another player to
   propose a pact, or use the small buttons on their row to accept, decline or
   break one.
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
- **If the attacker wins**, the defending stack is wiped out, the province changes
  hands, and all but one of the attacking dice move in. The attacker's total is
  unchanged — the prize is the defender's dice and the province.
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

Bots play by a fixed policy, with no randomness in their choices:

- **They attack when they outnumber the defender.** A repelled attack costs the
  attacker its extra dice, a capture keeps them, and once you work it out the
  whole expected value boils down to `N > M` — attack with more dice than the
  province next door holds, and not otherwise.
- **They gamble when nothing else is left.** If both stacks are already at 8 dice,
  no attack can become profitable and no reinforcement can improve anything, so a
  bot takes the roll anyway. It is the only move that changes the board, and
  without it two bots could sit there forever.
- **They never attack an ally.**
- **They negotiate.** A bot answers a waiting offer before it moves anything else —
  accepting from a player who isn't in the lead, declining from the player who is —
  then breaks a pact whose ally has taken the lead, then proposes to a non-leader
  it shares a border with. It does one of those at a time and asks at most once a
  turn.
- **They will not spend dice on a lost cause:** a province facing only allies gets
  no reinforcement, the same as one facing nobody.

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
| `PORT` | `3000` | Port to listen on. The container image sets `8888` for itself; everything else is unchanged. |
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

271 tests, run by `node --test` with no test framework:

- **Rules** — attack resolution, reinforcement placement, elimination and the win
  check, including Monte Carlo checks on the dice maths.
- **Bots** — hand-built boards with exact expected moves, and a bot-vs-passive
  game that has to terminate.
- **Maps** — every preset generates a connected, playable board at every size.
- **Rooms** — seats, the grace period after a disconnect, and what a snapshot is
  allowed to contain.
- **The client** — a static check that every class the client applies exists in
  the stylesheet, every id it queries exists in the HTML, and every error code has
  text to show.
- **Integration** — real Socket.IO clients playing real games on a real server,
  including a bot game played to a winner, disconnects and resuming, and the
  alliance flows.

## Layout

```
server/     the authoritative game
  index.js      HTTP + socket wiring, one handler per event
  game.js       start, attack, end turn, elimination
  rooms.js      seats, sessions, snapshots, the lobby list
  alliances.js  the five diplomacy transitions
  bot.js        the move policy and the diplomatic policy
  map.js        the Voronoi map generator and its presets
  rng.js        the seeded generator everything random goes through
shared/     rules.js and constants.js — imported by both halves, verbatim
public/     index.html, styles.css and the client under js/
test/       the suite
Dockerfile  the container build: production dependencies, unprivileged user
```
