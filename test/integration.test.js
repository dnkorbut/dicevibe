// End-to-end tests against a real server process and real Socket.IO clients.
//
// Everything else here tests a pure function. This file tests the things that
// only exist once the two halves are talking: the wire protocol, the lobby
// rules, and above all the reconnect path — which is the highest-risk behaviour
// in the project, because a mistake there does not crash, it silently freezes a
// match forever.
//
// The server is spawned as a child process on a free port rather than imported,
// so the real entry point (server/index.js) is what gets exercised, including
// its startup and shutdown.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { io } from 'socket.io-client';

import { EV, MAX_DICE, MAX_PLAYERS, PHASE } from '../shared/constants.js';
import { BOT_VERSIONS } from '../server/bots.js';

const ROOT = path.join(import.meta.dirname, '..');

// The env override pins every room to this many cells regardless of preset, so
// one number governs the whole suite. It has to be big enough that even the
// wateriest preset still leaves land to spare: at 26% water, ten cells leave
// seven, comfortably over the six a two-player game needs.
const TERRITORIES = 10;

let child = null;
let url = null;
const clients = [];

/* ── server lifecycle ──────────────────────────────────────────────────────── */

/** Asks the OS for a free port. Small race window, but far better than a fixed
 *  port that collides with a dev server someone already has running. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Takes the process to watch rather than reading the module-level `child`, so a
 *  test that needs its own server can wait on that one instead. */
async function waitForHealth(port, proc = child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early with code ${proc.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not become healthy in time');
}

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DICEVIBE_TERRITORIES: String(TERRITORIES),
      DICEVIBE_MAP_SEED: '4242',
      // Bots act instantly, so a whole game against one finishes inside a test.
      // The delay is presentation only — it paces the dice overlay for a human
      // watching — so removing it changes nothing about the game itself.
      DICEVIBE_BOT_DELAY_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.resume();
  child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

  await waitForHealth(port);
});

after(async () => {
  for (const c of clients) c.sock.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
  }
});

/* ── client helper ─────────────────────────────────────────────────────────── */

/**
 * A test client that keeps the latest snapshot as state rather than making the
 * test await the next event.
 *
 * Polling `latest` instead of listening for the next `room:state` removes a
 * whole class of flakes: a snapshot can arrive between an action and the moment
 * the test subscribes, and an event-based helper would then wait forever for an
 * update that already happened.
 *
 * `target` is the shared server unless a test brought its own up; the default is
 * read at call time, so it follows whatever `before` assigned.
 */
function connect(target = url) {
  const sock = io(target, { transports: ['websocket'], forceNew: true });
  const c = {
    sock,
    latest: null,
    map: null,
    lobby: [],
    closed: false,
    playerId: null,
    token: null,
    code: null,
    frames: 0,
  };

  sock.on(EV.STATE, (s) => {
    c.latest = s;
    c.frames++;
  });
  sock.on(EV.MAP, ({ map }) => {
    c.map = map;
  });
  sock.on(EV.LOBBY_LIST, ({ rooms }) => {
    c.lobby = rooms ?? [];
  });
  sock.on(EV.CLOSED, () => {
    c.closed = true;
  });

  c.emit = (event, payload = {}) => new Promise((resolve) => sock.emit(event, payload, resolve));

  c.ready = new Promise((resolve, reject) => {
    if (sock.connected) return resolve();
    sock.once('connect', resolve);
    sock.once('connect_error', reject);
  });

  /** Polls the latest snapshot until `pred` holds, so ordering never matters. */
  c.waitFor = (pred, label = 'condition', timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (c.latest && pred(c.latest)) return resolve(c.latest);
        if (Date.now() > deadline) {
          return reject(
            new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(c.latest)?.slice(0, 400)}`),
          );
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  };

  /**
   * Polls the latest open-games list until `pred` holds.
   *
   * Mirrors `waitFor`, and for the same reason: the list is broadcast, so a test
   * that subscribed after the fact would wait forever for an update that had
   * already been delivered.
   */
  c.waitForList = (pred, label = 'lobby list', timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (pred(c.lobby)) return resolve(c.lobby);
        if (Date.now() > deadline) {
          return reject(new Error(`timed out waiting for ${label}; list: ${JSON.stringify(c.lobby)}`));
        }
        setTimeout(tick, 10);
      };
      tick();
    });
  };

  /** Creates a room and adopts the returned identity. */
  c.create = async (nickname, mapId = 'ridge', sizeId = null) => {
    await c.ready;
    const res = await c.emit(EV.CREATE, { nickname, mapId, sizeId });
    if (res.ok) Object.assign(c, { token: res.token, code: res.roomCode, playerId: res.playerId });
    return res;
  };

  c.join = async (nickname, code) => {
    await c.ready;
    const res = await c.emit(EV.JOIN, { nickname, code });
    if (res.ok) Object.assign(c, { token: res.token, code: res.roomCode, playerId: res.playerId });
    return res;
  };

  clients.push(c);
  return c;
}

/** A fresh client that resumes an existing seat by token. */
async function reconnect(token) {
  const c = connect();
  await c.ready;
  const res = await c.emit(EV.RESUME, { token });
  if (res.ok) Object.assign(c, { token: res.token, code: res.roomCode, playerId: res.playerId });
  return { c, res };
}

/** Two joined clients in one room, ready to start. */
async function lobby(mapId = 'ridge') {
  const host = connect();
  const created = await host.create('ana', mapId);
  assert.equal(created.ok, true, 'create should succeed');

  const guest = connect();
  const joined = await guest.join('bob', host.code);
  assert.equal(joined.ok, true, 'join should succeed');

  return { host, guest };
}

/** Starts the game and waits until both clients see it running. */
async function startPlaying(host, guest) {
  const res = await host.emit(EV.START);
  assert.equal(res.ok, true, `start should succeed: ${res.error}`);

  const [a, b] = await Promise.all([
    host.waitFor((s) => s.phase === PHASE.PLAYING, 'host sees playing'),
    guest.waitFor((s) => s.phase === PHASE.PLAYING, 'guest sees playing'),
  ]);
  return { a, b };
}

/**
 * Every legal attack for the player whose turn it is.
 *
 * Water is excluded by the same test that excludes your own territory, because
 * a void is owned by nobody: `owner[to] !== playerId` is true for a lake, so a
 * naive version of this would offer the sea as an attack and a driver built on
 * it would stall on refusals.
 */
function legalMoves(state, map, playerId) {
  const moves = [];
  for (let from = 0; from < state.board.owner.length; from++) {
    if (state.board.owner[from] !== playerId || state.board.dice[from] < 2) continue;
    for (const to of map.territories[from].neighbors) {
      const owner = state.board.owner[to];
      if (owner !== null && owner !== playerId) moves.push({ from, to });
    }
  }
  return moves;
}

/**
 * Swing from the biggest stack at the softest neighbour.
 *
 * Not a good player — a predictable one. A test that played well would be hard
 * to tell apart from a test that played arbitrarily, and the point of these
 * games is only that every path through the rules gets walked.
 */
function pickMove(state, moves) {
  const swing = (m) => state.board.dice[m.from] - state.board.dice[m.to];
  return [...moves].sort((m, n) => swing(n) - swing(m))[0];
}

/** Territory ids that are land — everything the game can ever put a die on. */
const landOf = (map) => map.territories.filter((t) => t.playable).map((t) => t.id);

/** Territory ids that are impassable water. */
const waterOf = (map) => map.territories.filter((t) => !t.playable).map((t) => t.id);

/**
 * Waits for the geometry event, which arrives as its own message rather than
 * riding along in the snapshot.
 */
async function waitForMap(client, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!client.map && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(client.map, 'the client never received the board geometry');
  return client.map;
}

/**
 * Plays both seats greedily until the game ends: swing from the biggest stack at
 * the softest neighbour, and end the turn only when nothing is legal.
 *
 * `lastAction` is returned rather than assumed because the win path has a real
 * failure mode — the rules say a winning capture ends the game with nobody
 * pressing End Turn, so an `endTurn` in that slot would mean it had regressed.
 */
async function driveGame(host, guest, budget = 1200) {
  const byId = new Map([
    [host.playerId, host],
    [guest.playerId, guest],
  ]);

  let lastAction = null;

  for (let action = 0; action < budget; action++) {
    const state = host.latest;
    if (state.phase === PHASE.OVER) break;

    const actor = byId.get(state.turn.playerId);
    const version = state.version;
    const moves = legalMoves(state, host.map, actor.playerId);

    if (moves.length === 0) {
      lastAction = 'endTurn';
      const res = await actor.emit(EV.END_TURN);
      assert.equal(res.ok, true, `end turn rejected: ${res.error}`);
    } else {
      lastAction = 'attack';
      const res = await actor.emit(EV.ATTACK, pickMove(state, moves));
      assert.equal(res.ok, true, `attack rejected: ${res.error}`);
    }

    // Wait on the version, NOT on the turn changing: a player keeps the turn
    // after attacking (unlimited attacks per turn), so only an End Turn moves
    // it on — and waiting for that after an attack would always time out.
    await host.waitFor((s) => s.version > version || s.phase === PHASE.OVER, 'state advanced', 10000);
  }

  const final = await host.waitFor((s) => s.phase === PHASE.OVER, 'game over', 10000);
  return { final, lastAction };
}

/* ── lobby ─────────────────────────────────────────────────────────────────── */

test('create and join put both players in one lobby', async () => {
  const { host, guest } = await lobby();

  const snap = await guest.waitFor((s) => s.players.length === 2, 'two players');

  assert.equal(snap.phase, PHASE.LOBBY);
  assert.equal(snap.code, host.code);
  assert.deepEqual(snap.players.map((p) => p.name).sort(), ['ana', 'bob']);
  assert.equal(snap.hostId, host.playerId, 'the creator is the host');
  assert.equal(snap.players.find((p) => p.id === guest.playerId).color !== undefined, true);
});

test('joining rejects a bad code and a duplicate name', async () => {
  const host = connect();
  await host.create('ana');

  const badCode = await connect().join('zoe', 'ZZZZZZ');
  assert.equal(badCode.ok, false);
  assert.equal(badCode.error, 'no_such_room');

  const dupe = await connect().join('ANA', host.code);
  assert.equal(dupe.ok, false, 'names must be compared case-insensitively');
  assert.equal(dupe.error, 'name_taken');
});

test('an unnamed joiner is given a free name rather than refused', async () => {
  // Joining is meant to be one click, so the name field is optional: a blank
  // one gets you `Player N`. Naming a player but leaving it blank are the two
  // halves of the same rule, so both are checked against the same room.
  const host = connect();
  const created = await host.create('');
  assert.equal(created.ok, true, 'creating unnamed must be allowed');
  assert.equal(host.latest, null, 'the snapshot arrives by broadcast, not in the ack');

  const named = await connect().join('zoe', host.code);
  assert.equal(named.ok, true);

  const anon = await connect().join('   ', host.code);
  assert.equal(anon.ok, true, 'a blank name must not be refused');

  const snap = await host.waitFor((s) => s.players.length === 3, 'three seats');
  assert.deepEqual(
    snap.players.map((p) => p.name).sort(),
    ['Player 1', 'zoe', 'Player 2'].sort(),
    'the unnamed seats take the lowest free numbers, skipping the taken one',
  );
});

/* ── open games ────────────────────────────────────────────────────────────── */

test('the open-games list appears, updates itself, and drops a room that starts', async () => {
  // The list is the whole lobby now — there is no code to fall back on, so a row
  // that lingers or goes missing is the difference between finding a game and
  // not. This drives the real broadcast path rather than a helper.
  //
  // Every assertion is scoped to this room's code. Other tests in the file leave
  // lobby rooms behind, so any claim about the list's total length would be a
  // claim about test ordering.
  const watcher = connect();
  await watcher.ready;

  const host = connect();
  const created = await host.create('ana', 'highlands');
  assert.equal(created.ok, true);

  const row = () => watcher.lobby.find((r) => r.code === host.code);

  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code), 'the room to appear');
  assert.equal(row().hostName, 'ana');
  assert.equal(row().seats, 1);
  assert.equal(row().max, MAX_PLAYERS);
  assert.equal(row().mapName, 'Highlands', 'the row names the preset, not its id');

  const guest = connect();
  await guest.join('bob', host.code);
  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code && r.seats === 2), 'the seat count to move');

  // Starting removes it: a game in progress cannot be joined, so leaving the row
  // up would offer a button that could only come back with a refusal.
  await host.emit(EV.START);
  await watcher.waitForList((rooms) => !rooms.some((r) => r.code === host.code), 'the started room to drop off');
});

test('a chosen map size reaches the menu, and the env override still outranks it', async () => {
  // Two things at once, because they are the same decision seen from each end.
  //
  // The size is the host's choice and a joiner reads it off the row before
  // committing, so it has to survive the trip to the list. But this suite pins
  // every board to `DICEVIBE_TERRITORIES`, and that override exists to make
  // testing fast — so it must keep winning even against a size picked on
  // purpose, or this file's carefully-counted boards would come out 150 cells
  // wide the moment someone chose "Huge".
  const watcher = connect();
  await watcher.ready;

  const host = connect();
  const created = await host.create('ana', 'frontier', 'huge');
  assert.equal(created.ok, true, 'a known size must be accepted');

  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code), 'the room to appear');
  const row = watcher.lobby.find((r) => r.code === host.code);
  assert.equal(row.sizeId, 'huge');
  assert.equal(row.sizeName, 'Huge', 'the row names the size, not its id');

  const guest = connect();
  await guest.join('bob', host.code);
  await host.emit(EV.START);

  await host.waitFor((s) => s.phase === PHASE.PLAYING, 'the game to start');
  assert.equal(
    host.map.territories.length,
    TERRITORIES,
    'the env override must beat an explicitly chosen size',
  );
});

test('a full room is not offered to anyone', async () => {
  const host = connect();
  await host.create('ana');

  const watcher = connect();
  await watcher.ready;
  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code), 'the room to appear');

  for (let i = 2; i <= MAX_PLAYERS; i++) {
    const res = await connect().join(`p${i}`, host.code);
    assert.equal(res.ok, true, `seat ${i} should be joinable: ${res.error}`);
  }

  // Full: there is no seat for a Join button to claim, so the row must go.
  await watcher.waitForList(
    (rooms) => !rooms.some((r) => r.code === host.code),
    'the full room to be hidden',
  );

  const rejected = await connect().join('late', host.code);
  assert.equal(rejected.ok, false, 'and joining it must fail, not silently succeed');
  assert.equal(rejected.error, 'room_full');
});

test('a finished game can be left, and another one started', async () => {
  // The game-over screen's "Back to menu" hands the seat back. Without that the
  // socket stays bound to the finished room for good, and the menu refuses the
  // next Create as a second seat — so every game ends in a dead end with no way
  // out but a page reload, and `room:leave` is refused for a non-lobby room.
  const host = connect();
  await host.create('ana');
  await host.emit(EV.ADD_BOT);
  assert.equal((await host.emit(EV.START)).ok, true);

  const finishedCode = host.code;

  // Play the bot's game out, ending turns whenever it is the human's.
  for (let i = 0; i < 600; i++) {
    const state = host.latest;
    if (state?.phase === PHASE.OVER) break;
    if (state?.turn?.playerId === host.playerId) await host.emit(EV.END_TURN);
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(host.latest?.phase, PHASE.OVER, 'the game should have reached a winner');

  const left = await host.emit(EV.LEAVE);
  assert.equal(left.ok, true, `leaving a decided game must be allowed: ${left.error}`);

  // `create` adopts the new identity, so the old code has to be read first.
  const again = await host.create('ana');
  assert.equal(again.ok, true, `and the seat must be free for another: ${again.error}`);
  assert.notEqual(again.roomCode, finishedCode, 'a genuinely new room, not the finished one');
});

test('the winner leaving a decided game leaves the board intact', async () => {
  // Releasing a seat must not remove the player. The board names every province
  // owner and the client looks each one up in the players list for a colour, so
  // a snapshot that no longer lists them greys out their whole territory — and
  // on a decided board every province belongs to the winner, so the player who
  // left is the one whose provinces everyone else is still looking at.
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  for (let i = 0; i < 600; i++) {
    const state = host.latest;
    if (state?.phase === PHASE.OVER) break;

    const actor = state?.turn?.playerId === host.playerId ? host : guest;
    const moves = legalMoves(state, actor.map, actor.playerId);
    const res = moves.length === 0 ? await actor.emit(EV.END_TURN) : await actor.emit(EV.ATTACK, pickMove(state, moves));
    assert.equal(res.ok, true, `action rejected: ${res.error}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(host.latest?.phase, PHASE.OVER, 'the game should have reached a winner');

  const winnerId = host.latest.winnerId;
  const winner = winnerId === host.playerId ? host : guest;
  const watcher = winner === host ? guest : host;

  const owned = () => watcher.latest.board.owner.filter((o) => o === winnerId).length;
  const before = owned();
  assert.ok(before > 0, 'a decided board belongs to the winner');

  assert.equal((await winner.emit(EV.LEAVE)).ok, true, 'walking away from a decided game is allowed');
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(
    watcher.latest.players.some((p) => p.id === winnerId),
    'the roster must still name them, or their provinces have no colour left',
  );
  assert.equal(owned(), before, 'and the board is untouched');
});

test('the last player leaving takes the room out of every menu', async () => {
  // The emptied-room path is the one deletion site `publish` cannot cover: by
  // the time it matters the room is gone, so there is no room to send state to
  // — but the row is still on every other menu, and its Join button can only
  // ever come back with "No game with that code."
  const watcher = connect();
  await watcher.ready;

  const host = connect();
  await host.create('ana');
  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code), 'the room to appear');

  const left = await host.emit(EV.LEAVE);
  assert.equal(left.ok, true);

  await watcher.waitForList((rooms) => !rooms.some((r) => r.code === host.code), 'the row to go');

  // And it is genuinely gone, not merely hidden from this watcher.
  const rejoin = await connect().join('zoe', host.code);
  assert.equal(rejoin.ok, false);
  assert.equal(rejoin.error, 'no_such_room');
});

test('a human leaving a table of bots still empties the room', async () => {
  // Bots never leave, so the room would otherwise hold a row forever with
  // nobody able to start it — the robots cannot press Start.
  const watcher = connect();
  await watcher.ready;

  const host = connect();
  await host.create('ana');
  await host.emit(EV.ADD_BOT);
  await watcher.waitForList((rooms) => rooms.some((r) => r.code === host.code && r.seats === 2), 'the room with a bot');

  await host.emit(EV.LEAVE);
  await watcher.waitForList((rooms) => !rooms.some((r) => r.code === host.code), 'the row to go');
});

test('one socket cannot hold two seats', async () => {
  // A double-click on Create used to mint two rooms that shared one socket id.
  // The disconnect handler finds a player by socket id and stops at the first
  // match, so only one seat could ever be marked offline — the other reported
  // `connected: true` forever, was never grace-expired, and left its room in
  // every menu as an unstartable ghost.
  const watcher = connect();
  await watcher.ready;

  const a = connect();
  await a.ready;

  const [first, second] = await Promise.all([
    a.emit(EV.CREATE, { nickname: 'doubleclick', mapId: 'ridge' }),
    a.emit(EV.CREATE, { nickname: 'doubleclick', mapId: 'ridge' }),
  ]);

  assert.equal(first.ok, true, 'the first create wins');
  assert.equal(second.ok, false, 'the second must be refused, not honoured');
  assert.equal(second.error, 'already_seated');

  await watcher.waitForList((rooms) => rooms.some((r) => r.code === first.roomCode), 'the room to appear');
  assert.equal(
    watcher.lobby.filter((r) => r.hostName === 'doubleclick').length,
    1,
    'exactly one room was minted',
  );
});

test('double-clicking join does not seat one socket twice', async () => {
  // The other half of the same hazard, on the path a one-click join takes.
  const host = connect();
  await host.create('ana');

  const a = connect();
  await a.ready;

  const [first, second] = await Promise.all([
    a.emit(EV.JOIN, { nickname: 'bob', code: host.code }),
    a.emit(EV.JOIN, { nickname: 'bob', code: host.code }),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'already_seated');

  // Both replies have landed, so the server has processed both requests; the
  // snapshot just needs a moment to arrive.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(host.latest.players.filter((p) => p.name === 'bob').length, 1);
  assert.equal(host.latest.players.length, 2, 'one host, one guest — no phantom third seat');
});

test('resume will not seat one socket at a second table', async () => {
  // The third way into a seat, and the one that was left open: a token is just
  // as good a way in as creating or joining. Without the guard one connection
  // can hold seats in two rooms at once, and then `findBySocketId` marks only
  // one of them offline — so the room it is not really in keeps a seat
  // reporting `connected: true` forever, is never grace-expired and never
  // reaped, and sits in the menu behind a host who does not exist.
  const first = connect();
  const second = connect();
  const a = await first.create('ana');
  const b = await second.create('bob');
  assert.equal(a.ok, true, 'the first table');
  assert.equal(b.ok, true, 'the second table');

  // `second` holds a perfectly good token of its own, and asks to spend it on
  // the other table.
  const res = await second.emit(EV.RESUME, { token: a.token });
  assert.equal(res.ok, false, 'the resume must be refused');
  assert.equal(res.error, 'already_seated');

  // And the refusal has to leave both tables exactly as they were. A guard that
  // ran after `resumeSession` would have already handed the target seat to this
  // socket, which is the ghost it exists to prevent — so the assertion that
  // matters is that the target's occupant is untouched.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(first.latest.players.length, 1, 'the target table is untouched');
  assert.equal(first.latest.players[0].connected, true, 'and its occupant still connected');
  assert.equal(second.latest.players.length, 1, 'the resumer keeps its own table');
  assert.equal(second.latest.code, b.roomCode, 'and has not been moved');
});

test('resume into the seat the socket already holds is still allowed', async () => {
  // The boundary the guard must not cross, and it is the whole reason the guard
  // compares rooms rather than just calling `alreadySeated`: resuming on every
  // reconnect is the design — the refresh path and the auto-reconnect path are
  // deliberately the same code — so refusing a resume because the socket is
  // "already seated" would break every reconnect in the game.
  const host = connect();
  const created = await host.create('ana');
  assert.equal(created.ok, true, 'create should succeed');

  const again = await host.emit(EV.RESUME, { token: created.token });
  assert.equal(again.ok, true, `a same-room resume must be honoured: ${again.error}`);
  assert.equal(again.roomCode, created.roomCode);
  assert.equal(again.playerId, created.playerId);

  // A token that resolves to nothing is still `unknown_session`, not
  // `already_seated` — the guard needs both halves of its comparison to be
  // known before it can say the two disagree.
  const bogus = await host.emit(EV.RESUME, { token: 'not-a-real-token' });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error, 'unknown_session');
});

test('a resumed player takes the host role from an absent host', async () => {
  // Mid-game seats are held indefinitely, so a host role that lands on someone
  // who has gone takes the only way out with it: `room:abandon` is host-only and
  // `room:leave` is refused once play has started. Whoever comes back has to be
  // able to use it.
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  const hostToken = host.token;

  // The host leaves while the guest is still there, so the role moves to the
  // guest; then the guest leaves too, and the role is left on an absent seat.
  host.sock.close();
  await guest.waitFor((s) => s.hostId === guest.playerId, 'the guest to inherit the role');
  guest.sock.close();
  await new Promise((r) => setTimeout(r, 150));

  // Whichever absent seat the role landed on, the player who is actually here
  // must be able to abandon.
  const { c: back } = await reconnect(hostToken);
  await back.waitFor((s) => s.hostId != null, 'the resumer to see the room');
  assert.equal(back.latest.hostId, back.playerId, 'the player who is here holds the hatch');

  const res = await back.emit(EV.ABANDON);
  assert.equal(res.ok, true, `abandon should be reachable: ${res.error}`);
});

test('a start that fails still republishes the roster it changed', async () => {
  // `startGame` drops absent seats before it can fail, so a refused start can
  // still shrink the room. The seat count on every menu has to follow, or the
  // room goes on advertising a player who will never be dealt in.
  const host = connect();
  await host.create('ana');

  const absent = connect();
  await absent.join('bob', host.code);
  await host.waitFor((s) => s.players.length === 2, 'two seats');

  // Gone but still seated: the lobby grace timer has not run yet.
  absent.sock.close();
  await host.waitFor((s) => s.players.some((p) => p.name === 'bob' && !p.connected), 'bob to be offline');

  const res = await host.emit(EV.START);
  assert.equal(res.ok, false, 'one connected player cannot start');
  assert.equal(res.error, 'not_enough_players');

  const after = await host.waitFor((s) => s.players.length === 1, 'the roster to shrink');
  assert.equal(after.players.some((p) => p.name === 'bob'), false, 'the absent seat is gone');
});

test('only the host can start, and only with two connected players', async () => {
  const solo = connect();
  await solo.create('solo');

  const tooFew = await solo.emit(EV.START);
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.error, 'not_enough_players');

  const { host, guest } = await lobby();

  const notHost = await guest.emit(EV.START);
  assert.equal(notHost.ok, false);
  assert.equal(notHost.error, 'not_host');

  const ok = await host.emit(EV.START);
  assert.equal(ok.ok, true);
});

/* ── game setup ────────────────────────────────────────────────────────────── */

test('both clients receive the same board and the same snapshot', async () => {
  const { host, guest } = await lobby();
  const { a, b } = await startPlaying(host, guest);

  // The map arrives as its own event, so wait for it rather than assuming.
  await Promise.all([waitForMap(host), waitForMap(guest)]);

  assert.equal(host.map.territories.length, TERRITORIES);
  assert.equal(host.map.version, guest.map.version, 'both clients must render the same board');
  assert.deepEqual(host.map.territories, guest.map.territories);

  assert.equal(a.version, b.version, 'both clients must agree on the snapshot version');
  assert.deepEqual(a.board, b.board);
});

test('setup hands out 3 dice per territory, scattered round-robin', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const total = a.board.dice.reduce((sum, d) => sum + d, 0);
  assert.equal(total, 3 * TERRITORIES, 'every territory starts at 1 die plus 2 placed');

  assert.ok(a.board.dice.every((d) => d >= 1 && d <= MAX_DICE));

  const counts = a.players.map((p) => a.board.owner.filter((o) => o === p.id).length);
  assert.equal(counts.reduce((x, y) => x + y, 0), TERRITORIES);
  // Round-robin over a shuffled list cannot be perfectly even for every split,
  // but with an even territory count and two players it must be exactly half
  // each — and which player is which is decided by the roster shuffle.
  assert.deepEqual([...counts].sort((x, y) => x - y), [TERRITORIES / 2, TERRITORIES / 2]);

  // Ownership must be interleaved, not contiguous: two players on a Voronoi
  // board should never end up with a clean split down the middle.
  const blob = a.players.map((p) => {
    const mine = new Set(a.board.owner.map((o, i) => (o === p.id ? i : -1)).filter((i) => i !== -1));
    return [...mine].filter((t) => host.map.territories[t].neighbors.some((n) => mine.has(n))).length;
  });
  assert.ok(blob.every((n) => n > 0), 'each player should own at least one adjacent pair');
});

/* ── turn order and attacks ────────────────────────────────────────────────── */

test('only the player whose turn it is may act', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const currentId = a.turn.playerId;
  const other = currentId === host.playerId ? guest : host;

  const res = await other.emit(EV.ATTACK, { from: 0, to: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_your_turn');

  const ended = await other.emit(EV.END_TURN);
  assert.equal(ended.ok, false);
  assert.equal(ended.error, 'not_your_turn');
});

test('an attack resolves against the server and updates both clients', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const other = current === host ? guest : host;

  const moves = legalMoves(a, host.map, current.playerId);
  assert.ok(moves.length > 0, 'a freshly dealt board must offer at least one attack');

  const before = a.version;
  const stackBefore = a.board.dice[moves[0].from];
  const res = await current.emit(EV.ATTACK, moves[0]);
  assert.equal(res.ok, true, `attack rejected: ${res.error}`);

  const after = await other.waitFor((s) => s.version > before, 'version bump');
  assert.equal(after.lastEvent.type, 'attack');
  assert.equal(after.lastEvent.attackerId, current.playerId);

  // The event must carry both complete rolls — the client renders these, and a
  // truncated roll list is exactly how "the attacker throws fewer dice than it
  // has" would silently regress on the wire.
  //
  // Anchored to the stack rather than to `attackerDice`: the server derives the
  // roll count from the same expression it reports, so comparing the two would
  // be true by construction and would pass even if the count were wrong.
  assert.equal(after.lastEvent.attackerDice, stackBefore - 1, 'one die fewer than the stack');
  assert.equal(after.lastEvent.attackerRolls.length, after.lastEvent.attackerDice);
  assert.equal(after.lastEvent.defenderRolls.length, after.lastEvent.defenderDice);
  assert.ok(after.lastEvent.attackerRolls.every((r) => r >= 1 && r <= 6));
  assert.ok(after.lastEvent.defenderRolls.every((r) => r >= 1 && r <= 6));

  const atkSum = after.lastEvent.attackerRolls.reduce((x, y) => x + y, 0);
  assert.equal(atkSum, after.lastEvent.attackerSum, 'the reported sum must match the dice');
  assert.equal(after.lastEvent.captured, after.lastEvent.attackerSum > after.lastEvent.defenderSum);
});

test('illegal attacks are refused with the specific reason', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const me = current.playerId;

  const mine = a.board.owner.map((o, i) => (o === me ? i : -1)).filter((i) => i !== -1);
  const theirs = a.board.owner.map((o, i) => (o !== me ? i : -1)).filter((i) => i !== -1);

  const ownTarget = await current.emit(EV.ATTACK, { from: mine[0], to: mine[1] });
  assert.equal(ownTarget.error, 'own_territory');

  // A territory that is not a neighbour of anything we own.
  const far = theirs.find((t) => !mine.some((m) => host.map.territories[m].neighbors.includes(t)));
  if (far !== undefined) {
    const notAdjacent = await current.emit(EV.ATTACK, { from: mine[0], to: far });
    assert.equal(notAdjacent.error, 'not_adjacent');
  }

  const outOfRange = await current.emit(EV.ATTACK, { from: 0, to: 999 });
  assert.equal(outOfRange.error, 'bad_request');
});

/* ── end of turn and reinforcement ─────────────────────────────────────────── */

test('ending a turn pays one die per province held, and passes play on', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const me = current.playerId;
  const before = a.version;

  const res = await current.emit(EV.END_TURN);
  assert.equal(res.ok, true, `end turn rejected: ${res.error}`);

  const after = await current.waitFor((s) => s.version > before, 'turn advanced');
  const ev = after.lastEvent;

  assert.equal(ev.type, 'reinforce');
  assert.equal(ev.playerId, me);
  assert.ok(ev.gain >= 1, 'a player with land always gains at least one die');
  assert.notEqual(after.turn.playerId, me, 'play must pass to someone else');

  // The gain must equal the number of provinces held, counted here from the board
  // the client was shown rather than taken from the server's own arithmetic.
  //
  // This used to recompute the largest CONNECTED group, which is the classic Dice
  // Wars formula and the rule most often implemented as a plain count by mistake.
  // The mistake is now the rule, so the check inverts: the count is what is
  // wanted, and the connected-group read is what would be wrong.
  const mine = a.board.owner.filter((o) => o === me).length;
  assert.ok(mine > 0, 'the acting player must hold land to be paid for it');

  assert.equal(ev.gain, mine, 'reinforcement must be one die per province held');
  assert.equal(ev.placed + ev.stockLeft, ev.gain, 'every earned die is either placed or held');
});

test('a player with no legal attack can still end their turn', async () => {
  // The soft-lock this guards against: all your territories at 1 die means no
  // legal attack, and refusing End Turn would wedge the game with nobody
  // disconnected. Ending a turn is always allowed.
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const before = a.version;

  const res = await current.emit(EV.END_TURN);
  assert.equal(res.ok, true, `end turn rejected for a player with no legal attack: ${res.error}`);

  // Read the turn from the fresh snapshot, not the one captured at start.
  const after = await current.waitFor((s) => s.version > before, 'turn advanced');
  assert.notEqual(after.turn.playerId, current.playerId);
});

/* ── reconnection ──────────────────────────────────────────────────────────── */

test('a dropped seat pauses the game instead of skipping it', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const other = current === host ? guest : host;
  const expectedTurn = a.turn.playerId;

  current.sock.disconnect();

  const waiting = await other.waitFor((s) => s.waitingFor !== null, 'waitingFor to appear');
  assert.equal(waiting.waitingFor.playerId, expectedTurn);
  assert.equal(waiting.waitingFor.name, current === host ? 'ana' : 'bob');
  assert.equal(waiting.turn.playerId, expectedTurn, 'the turn must NOT advance past an absent player');
  assert.equal(waiting.phase, PHASE.PLAYING);
});

test('a returning player reclaims their exact seat and unpauses the game', async () => {
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const other = current === host ? guest : host;

  const boardBefore = a.board;
  const seatBefore = a.players.find((p) => p.id === current.playerId);

  current.sock.disconnect();
  await other.waitFor((s) => s.waitingFor !== null, 'paused');

  const { c: revived, res } = await reconnect(current.token);
  assert.equal(res.ok, true, `resume failed: ${res.error}`);
  assert.equal(revived.playerId, current.playerId, 'the same seat, not a new one');

  const resumed = await other.waitFor((s) => s.waitingFor === null, 'unpaused');
  assert.deepEqual(resumed.board, boardBefore, 'the board must be untouched by the disconnect');
  assert.equal(resumed.turn.playerId, seatBefore.id, 'play resumes with the returning player');
  assert.equal(resumed.players.length, 2, 'no duplicate seat was created');
  assert.equal(resumed.players.find((p) => p.id === current.playerId).connected, true);
});

test('a stale disconnect from a superseded socket does not evict a live player', async () => {
  // The race this guards: Socket.IO fires `disconnect` only after the ping
  // timeout, by which point the client has usually already reconnected on a new
  // socket. If the late disconnect marked the seat offline, then under a
  // wait-forever policy the match would freeze permanently — and it would look
  // like a game-logic bug rather than a transport one.
  const { host, guest } = await lobby();
  const { a } = await startPlaying(host, guest);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const other = current === host ? guest : host;

  const oldSocket = current.sock;
  const { c: revived, res } = await reconnect(current.token);
  assert.equal(res.ok, true);

  // Now the original, superseded socket goes away — late.
  oldSocket.disconnect();

  // The seat must still be connected and the game must not pause.
  const settled = await other.waitFor((s) => s.players.every((p) => p.connected), 'nobody marked offline');
  assert.equal(settled.waitingFor, null);
  assert.equal(revived.sock.connected, true);

  // And the game is still playable by the reconnected seat.
  const moves = legalMoves(settled, host.map, current.playerId);
  if (moves.length > 0) {
    const played = await revived.emit(EV.ATTACK, moves[0]);
    assert.equal(played.ok, true, `reconnected seat could not act: ${played.error}`);
  }
});

test('leaving the lobby frees the seat, and the last one out closes the room', async () => {
  const host = connect();
  await host.create('ana');
  const guest = connect();
  await guest.join('bob', host.code);

  const left = await guest.emit(EV.LEAVE);
  assert.equal(left.ok, true);

  const afterLeave = await host.waitFor((s) => s.players.length === 1, 'seat released');
  assert.equal(afterLeave.players[0].name, 'ana');

  const code = host.code;
  const hostLeft = await host.emit(EV.LEAVE);
  assert.equal(hostLeft.ok, true);

  await new Promise((r) => setTimeout(r, 150));
  const health = await (await fetch(`${url}/healthz`)).json();
  const rejoin = await connect().join('zoe', code);
  assert.equal(rejoin.ok, false, 'the room should be gone once everyone left');
  assert.equal(rejoin.error, 'no_such_room');
  assert.ok(health.rooms >= 0); // health is still answering after the churn
});

test('the host role moves on when the host leaves mid-game', async () => {
  // `room:abandon` is host-only and is the single escape from a permanently
  // paused match. Mid-game nothing removes a seat, so without a handover the
  // hatch would belong to the player who just walked away — and the survivors
  // would have no recovery at all.
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  host.sock.disconnect();

  const handover = await guest.waitFor((s) => s.hostId === guest.playerId, 'host handover');
  assert.equal(
    handover.players.find((p) => p.id === host.playerId).isHost,
    false,
    'the absent player must not still be flagged host',
  );

  const res = await guest.emit(EV.ABANDON);
  assert.equal(res.ok, true, `the remaining player must be able to abandon: ${res.error}`);
  await guest.waitFor(() => guest.closed, 'guest notified');
});

test('a lobby host who briefly drops keeps the host role', async () => {
  // The deliberate other half of the rule: in the lobby a disconnect is usually
  // just a page refresh, and the grace timer already handles a real departure.
  // Handing the role over on every blip would demote a host for reloading.
  const { host, guest } = await lobby();

  host.sock.disconnect();
  await guest.waitFor(
    (s) => s.players.find((p) => p.id === host.playerId).connected === false,
    'host marked offline',
  );

  const { c: revived, res } = await reconnect(host.token);
  assert.equal(res.ok, true, `resume failed: ${res.error}`);

  const back = await revived.waitFor((s) => s.players.every((p) => p.connected), 'host back online');
  assert.equal(back.hostId, host.playerId, 'a refresh must not cost the host their role');
});

test('leaving mid-game is refused — the host must abandon instead', async () => {
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  const res = await guest.emit(EV.LEAVE);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'game_in_progress');
});

test('only the host can abandon, and it closes the room for everyone', async () => {
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  const refused = await guest.emit(EV.ABANDON);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not_host');

  const code = host.code;
  const done = await host.emit(EV.ABANDON);
  assert.equal(done.ok, true);

  await Promise.all([
    host.waitFor(() => host.closed, 'host notified'),
    guest.waitFor(() => guest.closed, 'guest notified'),
  ]);

  const rejoin = await connect().join('zoe', code);
  assert.equal(rejoin.ok, false);
  assert.equal(rejoin.error, 'no_such_room', 'the abandoned room must be deleted');
});

/* ── a whole game ──────────────────────────────────────────────────────────── */

test('a game can be played to a winner, and the winning attack ends it', async () => {
  // Exercises the full loop: setup, attacks, reinforcement, elimination and the
  // win condition, through the real wire protocol. Ridge has no water, so every
  // cell is land and the winner must end up owning all of them.
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  const { final, lastAction } = await driveGame(host, guest);
  const winnerId = final.winnerId;
  assert.ok(winnerId, 'a finished game must name a winner');

  // Every territory, not "every other player's" — and that is only true here
  // because this board has no neutral land. The 10-territory fixture with two
  // players is exactly `MAX_TERRITORIES_PER_PLAYER * players`, so the deal
  // covers all of it. Do not generalise this assertion to a bigger board: there
  // the winner can legitimately leave neutral provinces standing, since the win
  // condition is "last player alive", not "whole map held".
  const owned = final.board.owner.filter((o) => o === winnerId).length;
  assert.equal(owned, TERRITORIES, 'the winner must own every territory');
  assert.equal(final.players.filter((p) => !p.eliminated).length, 1);

  // And the game was not left waiting on an End Turn press.
  assert.equal(final.turn, null, 'no turn should remain once the game is over');
  assert.equal(lastAction, 'attack', 'the game should end on a capture, not an End Turn');

  // The losing client sees the same outcome.
  const otherSide = winnerId === host.playerId ? guest : host;
  const otherFinal = await otherSide.waitFor((s) => s.phase === PHASE.OVER, 'loser sees game over');
  assert.equal(otherFinal.winnerId, winnerId);
});

/* ── water ─────────────────────────────────────────────────────────────────── */

test('a board with water deals out land only, and the water stays empty', async () => {
  const { host, guest } = await lobby('continent');
  const { a } = await startPlaying(host, guest);
  const map = await waitForMap(host);

  const water = waterOf(map);
  const land = landOf(map);
  assert.ok(water.length > 0, 'the continent preset is supposed to carve some water');
  assert.ok(land.length > 0, 'and to leave land to play on');

  for (const t of water) {
    assert.equal(a.board.owner[t], null, `void ${t} must never be owned`);
    assert.equal(a.board.dice[t], 0, `void ${t} must never hold a die`);
  }
  assert.ok(
    land.every((t) => a.board.owner[t] !== null),
    'every land territory must be dealt to somebody',
  );

  // Setup dice are 3 per LAND territory. Paying for the water too would leave
  // fewer dice on the board than the rule calls for, and would do it invisibly.
  const total = a.board.dice.reduce((sum, d) => sum + d, 0);
  assert.equal(total, 3 * land.length, 'water must not be paid for at setup');

  const counts = a.players.map((p) => a.board.owner.filter((o) => o === p.id).length).sort((x, y) => x - y);
  assert.deepEqual(counts, [Math.floor(land.length / 2), Math.ceil(land.length / 2)]);
});

test('water can never be attacked, and the refusal names water as the reason', async () => {
  // The failure this guards is silent rather than loud: an unowned cell passes
  // every ownership test, so before the void guard existed a lake was a free
  // capture — no error, no crash, just territory conjured out of the sea.
  const { host, guest } = await lobby('continent');
  const { a } = await startPlaying(host, guest);
  const map = await waitForMap(host);

  const current = a.turn.playerId === host.playerId ? host : guest;
  const me = current.playerId;

  const water = waterOf(map);
  assert.ok(water.length > 0, 'this board needs water to test against');

  const from = a.board.owner.findIndex((o, i) => o === me && a.board.dice[i] >= 2);
  assert.notEqual(from, -1, 'the mover should have a stack worth attacking from');

  // Every void, not just a neighbouring one. The guard is checked ahead of
  // adjacency precisely so the answer is "that space is impassable" whatever
  // the geography — if the order ever flipped, this would report `not_adjacent`
  // and, worse, a void that happened to touch would be taken.
  for (const to of water) {
    const res = await current.emit(EV.ATTACK, { from, to });
    assert.equal(res.ok, false, `void ${to} was attacked successfully`);
    assert.equal(res.error, 'not_playable', `void ${to} was refused with the wrong reason`);
  }
});

/* ── selections ────────────────────────────────────────────────────────────── */

/** The mover and the watcher, for tests about what one player can see of another. */
async function twoPlayerGame(mapId = 'ridge') {
  const { host, guest } = await lobby(mapId);
  const { a } = await startPlaying(host, guest);
  const current = a.turn.playerId === host.playerId ? host : guest;
  return { host, guest, a, current, other: current === host ? guest : host };
}

/** A province `playerId` owns and could attack from. */
const stackOf = (state, playerId) =>
  state.board.owner.findIndex((o, i) => o === playerId && state.board.dice[i] >= 2);

test('a selection is published to the whole table, not just the player making it', async () => {
  const { current, other } = await twoPlayerGame();

  const from = stackOf(current.latest, current.playerId);
  assert.notEqual(from, -1, 'the mover needs a stack to select');

  const res = await current.emit(EV.SELECT, { from });
  assert.equal(res.ok, true, `select refused: ${res.error}`);

  const seen = await other.waitFor(
    (s) => s.players.find((p) => p.id === current.playerId)?.selected === from,
    "the other player's selection",
  );
  assert.equal(
    seen.players.find((p) => p.id === other.playerId).selected,
    null,
    'and the watcher is not shown as having selected anything themselves',
  );
});

test('re-selecting the same province is not broadcast again', async () => {
  // Clicking a province that is already selected is routine — it happens on
  // every second click of a nervous player. Each broadcast is a whole snapshot,
  // so this is the difference between a quiet board and one that re-sends the
  // position to everyone whenever anybody's hand slips.
  const { current, other } = await twoPlayerGame();
  const from = stackOf(current.latest, current.playerId);

  await current.emit(EV.SELECT, { from });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === from, 'first');
  const settled = other.frames;

  await current.emit(EV.SELECT, { from });
  await current.emit(EV.SELECT, { from });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(other.frames, settled, 'a repeated selection must not cost anyone a snapshot');
});

test('clearing a selection is published too, and only when there was one', async () => {
  const { current, other } = await twoPlayerGame();
  const from = stackOf(current.latest, current.playerId);

  await current.emit(EV.SELECT, { from });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === from, 'selected');

  await current.emit(EV.SELECT, { from: null });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === null, 'cleared');

  const settled = other.frames;
  await current.emit(EV.SELECT, { from: null });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(other.frames, settled, 'clearing nothing is not news either');
});

test('a player cannot point at a province they do not own', async () => {
  // The highlight is drawn on everyone's board from this id alone, so an
  // unchecked one is a way to put a province of somebody else's under a marker
  // that says a different player is looking at it.
  const { current, other, a } = await twoPlayerGame();

  const theirs = a.board.owner.findIndex((o) => o === other.playerId);
  assert.notEqual(theirs, -1, 'the opponent must own something to point at');

  const res = await current.emit(EV.SELECT, { from: theirs });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad_request');

  const res2 = await current.emit(EV.SELECT, { from: -1 });
  assert.equal(res2.error, 'bad_request', 'and neither can an id that is not a province');

  const res3 = await current.emit(EV.SELECT, { from: 0.5 });
  assert.equal(res3.error, 'bad_request', 'nor a fractional one');
});

test('only the player whose turn it is has anything to point at', async () => {
  const { current, other, a } = await twoPlayerGame();
  const mine = stackOf(a, other.playerId);
  assert.notEqual(mine, -1, 'the waiting player needs a stack of their own to try');

  const res = await other.emit(EV.SELECT, { from: mine });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_your_turn');

  // But they can still clear, which is what the client sends as its turn ends.
  const cleared = await other.emit(EV.SELECT, { from: null });
  assert.equal(cleared.ok, true, 'clearing must never be blocked');
});

test('the attack the selection was made for clears it, for everyone', async () => {
  // Otherwise the province stays outlined on every other screen as if the player
  // were still deciding, when the move has already resolved.
  const { current, other, a } = await twoPlayerGame();

  // A real move, not merely a stack: `stackOf` returns the first province with
  // two dice, which on this board is occasionally walled in by its owner's own
  // land and has nothing to attack. That is roughly a 1-in-20 board, so picking
  // the province first and hunting for a target afterwards is flaky — the move
  // has to be chosen as a move.
  const moves = legalMoves(a, await waitForMap(current), current.playerId);
  assert.ok(moves.length > 0, 'the mover needs a legal attack to make');
  const move = pickMove(a, moves);

  await current.emit(EV.SELECT, { from: move.from });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === move.from, 'selected');

  // The whole `{ from, to }` pair, not just the target — which is what the event
  // carries.
  const res = await current.emit(EV.ATTACK, move);
  assert.equal(res.ok, true, `attack refused: ${res.error}`);

  await other.waitFor(
    (s) => s.players.find((p) => p.id === current.playerId)?.selected === null,
    'the selection cleared by the attack',
  );
});

test('ending the turn clears the selection that came with it', async () => {
  const { current, other, a } = await twoPlayerGame();
  const from = stackOf(a, current.playerId);

  await current.emit(EV.SELECT, { from });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === from, 'selected');

  await current.emit(EV.END_TURN);

  await other.waitFor(
    (s) => s.players.find((p) => p.id === current.playerId)?.selected === null,
    'the selection cleared by the turn ending',
  );
});

test('a player who goes away takes their selection with them', async () => {
  // Their seat is held, so the roster and the board still name them. A live
  // highlight, though, would claim they are still thinking about a move they
  // cannot make — the board would read as if nothing had happened.
  const { current, other } = await twoPlayerGame();
  const from = stackOf(current.latest, current.playerId);

  await current.emit(EV.SELECT, { from });
  await other.waitFor((s) => s.players.find((p) => p.id === current.playerId)?.selected === from, 'selected');

  current.sock.disconnect();

  const after = await other.waitFor(
    (s) => s.players.find((p) => p.id === current.playerId)?.connected === false,
    'the other player dropping',
  );
  const gone = after.players.find((p) => p.id === current.playerId);
  assert.equal(gone.selected, null, 'the highlight goes with them');
});

/* ── bots ──────────────────────────────────────────────────────────────────── */

test('the host can add a bot, and a bot counts as a second player', async () => {
  // The whole point of bots: one person, one tab, a real game. No rule change is
  // needed for this because `startGame` counts seats, not humans.
  const host = connect();
  await host.create('ana');

  const refused = await host.emit(EV.START);
  assert.equal(refused.ok, false, 'one human alone is still not enough');
  assert.equal(refused.error, 'not_enough_players');

  const added = await host.emit(EV.ADD_BOT);
  assert.equal(added.ok, true, `adding a bot failed: ${added.error}`);

  const seated = await host.waitFor((s) => s.players.length === 2, 'the bot seat');
  const bot = seated.players.find((p) => p.isBot);
  assert.ok(bot, 'the seat must be flagged as a bot');
  // `v1 1`, `v2 1` or `v3 1`: the version is drawn, so the first number is any of
  // them, but the seat is the first of its version at the table and the name must
  // say so. The character class is derived rather than typed, because a version
  // added to `BOT_VERSIONS` and not here would make this test fail only on the
  // games where the draw happened to pick it — a one-in-three flake.
  const versions = BOT_VERSIONS.join('');
  assert.match(bot.name, new RegExp(`^v[${versions}] 1$`), `unexpected bot name: ${bot.name}`);
  assert.equal(bot.connected, true, 'a bot is connected from birth — it has no socket to lose');
  assert.equal(bot.isHost, false, 'the bot must not be the host');
  assert.equal(seated.hostId, host.playerId);

  const started = await host.emit(EV.START);
  assert.equal(started.ok, true, `host versus one bot should be startable: ${started.error}`);
});

test('only the host may add or remove a bot', async () => {
  const { host, guest } = await lobby();

  const refused = await guest.emit(EV.ADD_BOT);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'not_host');

  const added = await host.emit(EV.ADD_BOT);
  assert.equal(added.ok, true);

  const snap = await host.waitFor((s) => s.players.some((p) => p.isBot), 'the bot');
  const botId = snap.players.find((p) => p.isBot).id;

  const refusedRemove = await guest.emit(EV.REMOVE_BOT, { playerId: botId });
  assert.equal(refusedRemove.ok, false);
  assert.equal(refusedRemove.error, 'not_host');

  // A human seat cannot be removed this way; it leaves under its own steam.
  await host.emit(EV.REMOVE_BOT, { playerId: guest.playerId });
  const stillThere = await host.waitFor((s) => s.players.some((p) => p.id === guest.playerId), 'the human seat');
  assert.equal(stillThere.players.filter((p) => p.isBot).length, 1, 'and the human removal did nothing');

  const gone = await host.emit(EV.REMOVE_BOT, { playerId: botId });
  assert.equal(gone.ok, true);
  await host.waitFor((s) => !s.players.some((p) => p.isBot), 'the bot to go');
});

test('the host can ask for a specific bot version, and gets that one', async () => {
  // What the four buttons send. Each version is asked for in turn so the test
  // covers the whole row rather than whichever one it happened to name.
  //
  // The name is what is checked, and it is the only thing that *can* be checked
  // from here: `botVersion` is not in the snapshot. It is deliberately not wired
  // into the wire format — the version is already in the seat's name, so
  // republishing it would be the same fact twice, the mistake `selected`'s comment
  // warns about. What this test therefore proves is that asking for v3 seats a bot
  // called `v3 1` and not one called `v1 3` or `v2 1`; that `botVersion` on the
  // player object matches the name is `rooms.test.js`'s job, one layer down.
  const host = connect();
  await host.create('ana');

  for (const version of BOT_VERSIONS) {
    const added = await host.emit(EV.ADD_BOT, { version });
    assert.equal(added.ok, true, `adding v${version} failed: ${added.error}`);

    const snap = await host.waitFor(
      (s) => s.players.some((p) => p.isBot && p.name.startsWith(`v${version} `)),
      `the v${version} seat`,
    );
    assert.ok(
      snap.players.some((p) => p.isBot && p.name === `v${version} 1`),
      `expected a seat named v${version} 1, got ${snap.players.map((p) => p.name).join(', ')}`,
    );
  }

  assert.equal(host.latest.players.length, 1 + BOT_VERSIONS.length, 'one seat per version');
});

test('an unknown bot version is refused rather than seated as something else', async () => {
  // The alternative was to seat whatever `policyFor` falls back to, which is v1 —
  // so the host would have got a bot tagged `v9 1` playing v1's policy. That is a
  // lie in the one place it is hardest to notice, since the name is the only thing
  // the table ever sees.
  const host = connect();
  await host.create('ana');

  const refused = await host.emit(EV.ADD_BOT, { version: 9 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'bad_bot_version');
  assert.equal(host.latest.players.length, 1, 'and no seat was taken');

  // Still refused after the game starts, where the older guard would have said
  // `game_in_progress` — the version check runs first on purpose, so a client
  // sending nonsense gets told what is actually wrong with it.
  await host.emit(EV.ADD_BOT, { version: 1 });
  await host.emit(EV.START);
  const again = await host.emit(EV.ADD_BOT, { version: 9 });
  assert.equal(again.error, 'bad_bot_version');
});

test('a bot plays its own turns, and a whole game can be played against one', async () => {
  // The end-to-end proof that the driver works: nobody touches the bot's turn.
  // The human seat here plays greedily, the bot plays itself, and the game must
  // reach a winner.
  const host = connect();
  await host.create('ana');
  await host.emit(EV.ADD_BOT);

  const seated = await host.waitFor((s) => s.players.some((p) => p.isBot), 'the bot seat');
  const botId = seated.players.find((p) => p.isBot).id;

  // Counted at the socket, not by polling `latest`. The bot acts on a zero-delay
  // timer, so its entire turn can begin and end inside one 10ms poll interval —
  // a poller would then miss every move and report a perfectly healthy bot as
  // never having stirred. A listener sees every frame that arrives.
  let botTurns = 0;
  let botAttacks = 0;
  let lastTurnSeen = null;
  host.sock.on(EV.STATE, (s) => {
    const who = s.turn?.playerId ?? null;
    if (who === botId && who !== lastTurnSeen) botTurns++;
    if (s.lastEvent?.type === 'attack' && s.lastEvent.attackerId === botId) botAttacks++;
    lastTurnSeen = who;
  });

  const started = await host.emit(EV.START);
  assert.equal(started.ok, true, `start failed: ${started.error}`);
  await host.waitFor((s) => s.phase === PHASE.PLAYING, 'playing');

  let humanActions = 0;

  for (let step = 0; step < 2000; step++) {
    const state = host.latest;
    if (state.phase === PHASE.OVER) break;

    if (state.turn?.playerId === botId) {
      // Deliberately do nothing. The server must move for the bot, and the turn
      // must leave it again — either because the bot attacked (keeping the turn)
      // or because it ended it.
      await host.waitFor(
        (s) => s.phase === PHASE.OVER || s.turn?.playerId !== botId,
        'the bot to take its turn',
        15000,
      );
      continue;
    }

    const version = state.version;
    const moves = legalMoves(state, host.map, host.playerId);
    humanActions++;

    const res =
      moves.length === 0
        ? await host.emit(EV.END_TURN)
        : await host.emit(EV.ATTACK, pickMove(state, moves));
    assert.equal(res.ok, true, `human action rejected: ${res.error}`);

    await host.waitFor((s) => s.version > version || s.phase === PHASE.OVER, 'state advanced', 15000);
  }

  const final = await host.waitFor((s) => s.phase === PHASE.OVER, 'game over', 15000);
  assert.ok(final.winnerId, 'a finished game must name a winner');
  assert.ok(botTurns > 0, 'the bot must have actually taken at least one turn');
  assert.ok(botAttacks > 0, 'and it must have done something with them, not just passed');
  assert.ok(humanActions > 0, 'and the human must have played too');
  assert.equal(final.players.filter((p) => !p.eliminated).length, 1);
  assert.equal(final.turn, null, 'no turn should remain once the game is over');
});

test('a hurry is refused when there is no bot to hurry', async () => {
  // The button spends its life disabled, so every one of these is a race: a click
  // that landed a beat after the wait it meant to skip had already ended.
  // Refusing rather than ignoring is what lets the click say so.
  const { host, guest } = await lobby();
  await startPlaying(host, guest);

  const state = host.latest;
  const actor = state.turn.playerId === host.playerId ? host : guest;
  const onAHuman = await actor.emit(EV.HURRY);
  assert.equal(onAHuman.ok, false, 'two humans waiting on each other is not a wait to skip');
  assert.equal(onAHuman.error, 'no_bot_turn');

  // A lobby has no turn at all, and a socket with no seat has no room.
  const third = connect();
  await third.create('cara');
  assert.equal((await third.emit(EV.HURRY)).error, 'no_bot_turn', 'the lobby is not mid-turn');

  const loose = connect();
  await loose.ready;
  assert.equal((await loose.emit(EV.HURRY)).error, 'no_such_room');
});

test('a hurry ends the bot turn now rather than on the next beat', async () => {
  // The only test here that spawns a server of its own, and it has to: the shared
  // one runs with DICEVIBE_BOT_DELAY_MS=0, and a bot that is already instantaneous
  // cannot be measured getting faster. Without this, the whole feature is covered
  // by nothing — the sample above only ever exercises the refusal.
  const BEAT = 1500;

  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // Larger than the shared server's, because three seats need nine provinces
      // of land and a ten-cell map at this seed has fewer.
      DICEVIBE_TERRITORIES: '40',
      DICEVIBE_MAP_SEED: '4242',
      DICEVIBE_BOT_DELAY_MS: String(BEAT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.on('data', (buf) => process.stderr.write(`[hurried] ${buf}`));

  try {
    await waitForHealth(port, proc);
    const target = `http://127.0.0.1:${port}`;

    const host = connect(target);
    await host.create('ana');
    const guest = connect(target);
    assert.equal((await guest.join('bob', host.code)).ok, true, 'the second human');

    await host.emit(EV.ADD_BOT);
    const seated = await host.waitFor((s) => s.players.some((p) => p.isBot), 'the bot seat');
    const botId = seated.players.find((p) => p.isBot).id;
    assert.equal((await host.emit(EV.START)).ok, true);
    await host.waitFor((s) => s.phase === PHASE.PLAYING, 'playing');

    // Walk the rotation round to the bot. At most two human turns can sit ahead of
    // it and each is given away; the bot's own turn is never touched. Waiting on
    // the version between steps, because the ack is written before the snapshot is
    // broadcast — reading `latest` straight after an End Turn would read the turn
    // we just gave away and press End Turn on the wrong seat.
    for (let step = 0; step < 8; step++) {
      const s = host.latest;
      if (s.turn?.playerId === botId) break;

      const version = s.version;
      const actor = s.turn?.playerId === host.playerId ? host : guest;
      assert.equal((await actor.emit(EV.END_TURN)).ok, true, 'giving away a human turn');
      await host.waitFor((s2) => s2.version > version, 'the turn to move on');
    }
    await host.waitFor((s) => s.turn?.playerId === botId, 'the bot turn');

    // Pressed by the guest, not the host: "any human at the table" is the rule, and
    // the seat least likely to hold the host role is the one that proves it.
    const pressed = Date.now();
    const res = await guest.emit(EV.HURRY);
    assert.equal(res.ok, true, `a human who is not the host must be able to hurry: ${res.error}`);

    // Measured, not merely observed. That the turn left the bot is not the claim —
    // the claim is that it left *now*. Left alone it would have taken a whole beat
    // per action, and a bot turn is several actions; half of one beat is a ceiling
    // a working button clears by two orders of magnitude and a broken one cannot
    // clear at all.
    const deadline = pressed + BEAT * 3;
    let elapsed = null;
    while (Date.now() < deadline) {
      const s = host.latest;
      if (s.phase === PHASE.OVER || s.turn?.playerId !== botId) {
        elapsed = Date.now() - pressed;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    assert.ok(elapsed !== null, `the bot was still thinking ${BEAT * 3}ms after the hurry`);
    assert.ok(elapsed < BEAT / 2, `the bot turn took ${elapsed}ms to end; a bare beat is ${BEAT}ms`);
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
  }
});

test('a leaving host hands the role to a human, never to a bot', async () => {
  // `room:abandon` is the only escape from a match paused on an absent player,
  // and it is host-only. A bot can never press it, so a bot inheriting the role
  // would put that hatch permanently out of reach for anyone still playing.
  // The bot here is deliberately the only connected seat that would otherwise
  // qualify, so a naive "first connected player" rule hands it the role.
  const { host, guest } = await lobby();
  const added = await host.emit(EV.ADD_BOT);
  assert.equal(added.ok, true, `adding a bot failed: ${added.error}`);
  await startPlaying(host, guest);

  host.sock.disconnect();

  const handover = await guest.waitFor((s) => s.hostId === guest.playerId, 'host handover to the human');
  assert.equal(handover.players.find((p) => p.id === host.playerId).isHost, false);

  // And the hatch actually works from there, which is the whole point.
  const res = await guest.emit(EV.ABANDON);
  assert.equal(res.ok, true, `the remaining human must be able to abandon: ${res.error}`);
  await guest.waitFor(() => guest.closed, 'guest notified');
});

test('a board with water can still be played to a winner', async () => {
  // The end-to-end proof that voids do not make a board unwinnable. A connected
  // landmass is guaranteed by construction, but "guaranteed by construction" is
  // exactly the claim worth checking against the real server on a real board.
  const { host, guest } = await lobby('continent');
  await startPlaying(host, guest);
  const map = await waitForMap(host);

  const { final, lastAction } = await driveGame(host, guest);
  const winnerId = final.winnerId;

  assert.ok(winnerId, 'a finished game must name a winner');
  assert.equal(lastAction, 'attack', 'the game should end on a capture, not an End Turn');

  const land = landOf(map);
  const water = waterOf(map);
  assert.ok(water.length > 0, 'this board is supposed to have water');

  // The winner takes every scrap of land — and only land.
  const owned = final.board.owner.filter((o) => o === winnerId).length;
  assert.equal(owned, land.length, 'the winner must own every land territory');

  for (const t of water) {
    assert.equal(final.board.owner[t], null, `void ${t} was conquered`);
    assert.equal(final.board.dice[t], 0, `void ${t} collected dice`);
  }

  assert.equal(final.players.filter((p) => !p.eliminated).length, 1);
  assert.equal(final.turn, null, 'no turn should remain once the game is over');
});

/* ── alliances ─────────────────────────────────────────────────────────────── */

/** Three joined clients in one started game — a table with a bystander at it. */
async function threePlayerGame(mapId = 'ridge') {
  const host = connect();
  assert.equal((await host.create('ana', mapId)).ok, true, 'create should succeed');

  const guest = connect();
  assert.equal((await guest.join('bob', host.code)).ok, true, 'join should succeed');

  const third = connect();
  assert.equal((await third.join('cid', host.code)).ok, true, 'third join should succeed');

  const started = await host.emit(EV.START);
  assert.equal(started.ok, true, `start should succeed: ${started.error}`);

  await Promise.all(
    [host, guest, third].map((c) => c.waitFor((s) => s.phase === PHASE.PLAYING, 'playing')),
  );

  return { host, guest, third };
}

const seatOf = (state, id) => state.players.find((p) => p.id === id);

test('an alliance request is public to the whole table', async () => {
  // Not a private question between two players: the third seat is told who asked
  // whom, which is what makes "the whole table can see you are talking" true. It
  // costs nothing — the snapshot is one broadcast object.
  const { host, guest, third } = await threePlayerGame();

  const asked = await host.emit(EV.ALLIANCE_REQUEST, { playerId: guest.playerId });
  assert.equal(asked.ok, true, `request refused: ${asked.error}`);

  const seen = await third.waitFor(
    (s) => seatOf(s, host.playerId)?.requested.includes(guest.playerId),
    "the request on the bystander's screen",
  );
  assert.deepEqual(seatOf(seen, host.playerId).allies, [], 'and asking is not agreeing');
});

test('re-asking something already open costs nobody a snapshot', async () => {
  // A double click is routine, so it is an idempotent no-op rather than a refusal
  // — and the `changed: false` that says so is what keeps it from re-broadcasting
  // the whole table.
  const { host, guest, third } = await threePlayerGame();

  await host.emit(EV.ALLIANCE_REQUEST, { playerId: guest.playerId });
  await third.waitFor((s) => seatOf(s, host.playerId)?.requested.includes(guest.playerId), 'the ask');
  const settled = third.frames;

  const again = await host.emit(EV.ALLIANCE_REQUEST, { playerId: guest.playerId });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(again.ok, true, 'a repeated ask is not an error');
  assert.equal(third.frames, settled, 'and it must not cost anyone a snapshot');
});

test('accepting and breaking are visible on every client', async () => {
  const { host, guest, third } = await threePlayerGame();

  await host.emit(EV.ALLIANCE_REQUEST, { playerId: guest.playerId });
  const yes = await guest.emit(EV.ALLIANCE_ACCEPT, { playerId: host.playerId });
  assert.equal(yes.ok, true, `accept refused: ${yes.error}`);

  const allied = await third.waitFor(
    (s) => seatOf(s, host.playerId)?.allies.includes(guest.playerId),
    'the pact on the bystander screen',
  );
  assert.deepEqual(seatOf(allied, host.playerId).requested, [], 'the question is closed');
  assert.deepEqual(seatOf(allied, guest.playerId).requested, []);

  const broken = await host.emit(EV.ALLIANCE_BREAK, { playerId: guest.playerId });
  assert.equal(broken.ok, true, `break refused: ${broken.error}`);

  const after = await third.waitFor(
    (s) => seatOf(s, host.playerId)?.allies.length === 0,
    'the broken pact',
  );
  assert.deepEqual(seatOf(after, guest.playerId).allies, [], 'and both halves go together');
});

test('a stale second accept is answered with a reason it can discard', async () => {
  // Two clicks on one offer — a double click, or two tabs on one seat. The loser
  // has to get an answer it can drop quietly, not a second alliance event.
  const { host, guest } = await twoPlayerGame();

  await host.emit(EV.ALLIANCE_REQUEST, { playerId: guest.playerId });
  assert.equal((await guest.emit(EV.ALLIANCE_ACCEPT, { playerId: host.playerId })).ok, true);

  const late = await guest.emit(EV.ALLIANCE_ACCEPT, { playerId: host.playerId });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'no_pending_request');

  const allied = await guest.waitFor(
    (s) => seatOf(s, host.playerId)?.allies.includes(guest.playerId),
    'the first accept still standing',
  );
  assert.equal(allied.phase, PHASE.PLAYING, 'and the game is untouched');
});

test('alliance actions are not turn-gated', async () => {
  // Deliberate, and pinned here so nobody later "fixes" it into NOT_YOUR_TURN: a
  // player has to be able to answer an offer without waiting for their own turn.
  // The seat really is out of turn — the actions that move the game refuse it.
  const { current, other } = await twoPlayerGame();

  const ended = await other.emit(EV.END_TURN);
  assert.equal(ended.error, 'not_your_turn', 'the seat really is out of turn');

  const asked = await other.emit(EV.ALLIANCE_REQUEST, { playerId: current.playerId });
  assert.equal(asked.ok, true, `diplomacy must work out of turn: ${asked.error}`);
});

test('attacking an ally breaks the pact, and the event says so', async () => {
  const { current, other } = await twoPlayerGame();
  await waitForMap(current);

  await current.emit(EV.ALLIANCE_REQUEST, { playerId: other.playerId });
  assert.equal(
    (await other.emit(EV.ALLIANCE_ACCEPT, { playerId: current.playerId })).ok,
    true,
    'accept should succeed',
  );
  await current.waitFor((s) => seatOf(s, current.playerId)?.allies.includes(other.playerId), 'the pact');

  // An ally stays a legal target — that is the explicit rule, and the reason the
  // client keeps offering allied provinces as targets.
  const strike = legalMoves(current.latest, current.map, current.playerId).find(
    (m) => current.latest.board.owner[m.to] === other.playerId,
  );
  assert.ok(strike, 'the fixture must put the two empires in contact, or there is no pact to break');

  const res = await current.emit(EV.ATTACK, strike);
  assert.equal(res.ok, true, `attacking an ally must be legal: ${res.error}`);

  const after = await current.waitFor((s) => s.lastEvent?.brokeAlliance === true, 'the broken-pact event');
  assert.deepEqual(seatOf(after, current.playerId).allies, []);
  assert.deepEqual(seatOf(after, other.playerId).allies, [], 'and both halves go together');
});

test('a request survives the requester reconnecting', async () => {
  // The pact belongs to the seat, not to the connection. A dropped socket must not
  // read as a withdrawal, or closing a tab would become a way out of an alliance
  // without the break rule applying.
  const { current, other } = await twoPlayerGame();

  await current.emit(EV.ALLIANCE_REQUEST, { playerId: other.playerId });
  await other.waitFor((s) => seatOf(s, current.playerId)?.requested.includes(other.playerId), 'the ask');

  const { c: back, res } = await reconnect(current.token);
  assert.equal(res.ok, true, `resume refused: ${res.error}`);

  const seen = await back.waitFor(
    (s) => seatOf(s, current.playerId)?.requested.includes(other.playerId),
    'the ask, on the resumed connection',
  );
  assert.equal(seen.turn.playerId, current.latest.turn.playerId, 'and the game resumed where it was');
});

/* ── HTTP routes ───────────────────────────────────────────────────────────── */

test('/dev/map refuses an unbounded board instead of generating one', async () => {
  // `/dev/map?t=` is the one route that takes an unbounded number from anyone
  // who can reach the port, and generation is quadratic in it — so this is a
  // denial-of-service test, not a validation one. The timings are the point:
  // the refusal has to come before any work, because a bound checked afterwards
  // would still let the whole event loop be blocked, just before apologising.
  for (const t of ['401', '300000', '999999999']) {
    const started = Date.now();
    const res = await fetch(`${url}/dev/map?t=${t}`);
    const body = await res.text();
    const ms = Date.now() - started;

    assert.equal(res.status, 400, `t=${t} must be refused`);
    assert.match(body, /territoryCount must be <= 400/, `t=${t} refusal body`);
    assert.ok(ms < 2000, `t=${t} took ${ms}ms — the bound is being checked too late`);
  }

  // The board the game itself can ask for is unaffected, so the bound is
  // invisible in play.
  const ok = await fetch(`${url}/dev/map?t=150`);
  assert.equal(ok.status, 200, 'a real board size must still render');
});

test('/dev/map answers its errors as text, never as executable markup', async () => {
  // `preset` is the raw query string and used to be interpolated into an HTML
  // body. This page shares an origin with the game, which keeps its session
  // token in sessionStorage — so script running here could read that token and
  // take the seat it belongs to. The header check is what makes the body type
  // binding rather than advisory.
  const payload = '<script>alert(1)</script>';
  const res = await fetch(`${url}/dev/map?preset=${encodeURIComponent(payload)}`);
  const body = await res.text();

  assert.equal(res.status, 400);
  assert.match(
    res.headers.get('content-type') ?? '',
    /^text\/plain/,
    'an echoed parameter must never be served as html',
  );
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(body.includes(payload), 'the parameter is still reported back, just inertly');

  // The same for the generation-failure path. It only ever echoes a number —
  // `territoryCount must be <= 2000, got 2001` — but it is the same `res.send`
  // and the same reasoning, so it takes the same type.
  const other = await fetch(`${url}/dev/map?t=401`);
  assert.equal(other.status, 400);
  assert.match(other.headers.get('content-type') ?? '', /^text\/plain/);

  // A `t` that is not an integer at all is ignored rather than refused, which
  // is the documented contract: it falls back to the preset's own size instead
  // of failing the page.
  const ignored = await fetch(`${url}/dev/map?t=${encodeURIComponent(payload)}`);
  assert.equal(ignored.status, 200, 'a non-numeric t is ignored, not treated as a bad request');
});

test('the game page is served with the framing and sniffing headers', async () => {
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('the map preview route refuses a flood instead of generating every board', async () => {
  // Its own server: the bucket is process-wide and this test drains it, so
  // sharing the suite's server would spend the budget the other /dev/map tests
  // need and their failures would look nothing like this one.
  //
  // The bucket is the second half of the denial-of-service fix, and it answers a
  // different question from the size bound. Bounding how big a board can be does
  // not bound how many can be asked for, and generation is synchronous — so the
  // only thing between one connection and a stalled event loop is the rate.
  const port = await freePort();
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DICEVIBE_MAP_SEED: '4242' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.resume();
  proc.stderr.on('data', (buf) => process.stderr.write(`[preview] ${buf}`));

  try {
    await waitForHealth(port, proc);
    const target = `http://127.0.0.1:${port}`;

    // Concurrent, which is the shape that matters: a burst is what a hand on a
    // scroll wheel produces and also what an attacker sends.
    const burst = await Promise.all(
      Array.from({ length: 30 }, () => fetch(`${target}/dev/map?t=40`)),
    );
    const codes = burst.map((r) => r.status);
    await Promise.all(burst.map((r) => r.text())); // Drain, so no socket is left hanging.

    assert.ok(codes.includes(200), 'the bucket must let a real burst through first');
    assert.ok(
      codes.filter((c) => c === 429).length >= 15,
      `most of a 30-request flood must be refused; got ${JSON.stringify(codes)}`,
    );

    // A refusal has to be a plain answer — not a hang, and not a queue. Queueing
    // is the tempting alternative and the wrong one: it would move the stall
    // from the caller who asked onto everyone waiting behind them.
    const refused = burst[codes.indexOf(429)];
    assert.match(refused.headers.get('content-type') ?? '', /^text\/plain/);
    assert.ok(refused.headers.get('retry-after'), 'a refusal should say when to come back');

    // And the process is free again the moment the flood is refused.
    const started = Date.now();
    assert.equal((await fetch(`${target}/healthz`)).ok, true);
    assert.ok(Date.now() - started < 1000, 'the event loop must not be left blocked');
  } finally {
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
  }
});
