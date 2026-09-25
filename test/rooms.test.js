// Room and seat lifecycle, driven directly rather than over sockets.
//
// `rooms.js` deliberately knows nothing about Socket.IO, so these run with no
// server at all — which matters for the cases that are hard to reach through the
// wire: a room where every human has gone, or a host handover that happens when
// nobody is left to observe it. Those are exactly the states that rot silently,
// because in production nothing is watching them either.

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { MAX_PLAYERS, PHASE } from '../shared/constants.js';
import { leaderOf } from '../shared/rules.js';
import { startGame } from '../server/game.js';
import {
  addBot,
  buildSnapshot,
  createRoom,
  joinRoom,
  listOpenRooms,
  reassignHost,
  reclaimAbsentHost,
  releaseSeat,
  removeBot,
  removePlayer,
  rooms,
  sessions,
} from '../server/rooms.js';
import { planMove as planMoveV2 } from '../server/bot-v2.js';
import { BOT_VERSIONS, policyFor } from '../server/bots.js';
import { makeRng } from '../server/rng.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

/** The module-level maps are shared, so every test starts from a clean slate. */
beforeEach(() => {
  rooms.clear();
  sessions.clear();
});

const makeRoom = (nickname = 'ana', mapId = 'ridge') => {
  const result = createRoom({ nickname, mapId, socketId: 'sock-1' });
  assert.ok(result.room, `createRoom failed: ${result.error}`);
  return result.room;
};

const seatOf = (room, id) => room.players.find((p) => p.id === id);

/* ── bot seats ─────────────────────────────────────────────────────────────── */

test('bots are named per policy version and never reuse a taken name', () => {
  const room = makeRoom();

  // Seated explicitly rather than left to the draw, because the numbering rule is
  // what is under test and a random version would make the expected names move.
  assert.equal(addBot(room, 1).player.name, 'v1 1');
  assert.equal(addBot(room, 1).player.name, 'v1 2');
  assert.equal(addBot(room, 2).player.name, 'v2 1');

  // The counters are per version, and a human who has claimed a bot's next name
  // pushes the allocation past it — the same rule anonymous humans get.
  joinRoom({ code: room.code, nickname: 'v1 3', socketId: 'sock-9' });
  assert.equal(addBot(room, 1).player.name, 'v1 4');
  assert.equal(addBot(room, 2).player.name, 'v2 2');
});

test('an unversioned bot takes its version from the room, and carries it', () => {
  // Stubbed rather than sampled. Which version a real draw produces is a coin
  // toss, so asserting on it would be asserting on the seed — what matters is
  // that the draw is *consulted* and that the seat records the answer, because
  // the driver reads `botVersion` back off the player on every beat. A seat that
  // kept the default would play v1 whatever was drawn for it.
  const room = makeRoom();
  let stubbed = 2;
  room.botRng.pick = (arr) => (arr.includes(stubbed) ? stubbed : arr[0]);

  const first = addBot(room).player;
  assert.equal(first.botVersion, 2);
  assert.equal(first.name, 'v2 1');

  stubbed = 1;
  const second = addBot(room).player;
  assert.equal(second.botVersion, 1);
  assert.equal(second.name, 'v1 1', 'and the counter is per version, not per table');
});

test('every version "Add bot" can deal has a policy behind it', () => {
  // The list is what the draw samples and the map is what plays the seat, and
  // nothing else connects them — a version added to one and not the other would
  // seat a bot that silently plays the fallback.
  for (const version of BOT_VERSIONS) {
    assert.equal(typeof policyFor(version).planMove, 'function', `v${version} has no planMove`);
    assert.equal(typeof policyFor(version).planAlliance, 'function', `v${version} has no planAlliance`);
  }
});

test('adding a bot does not disturb the dice stream', () => {
  // The reason `botRng` is a separate stream at all. A draw taken from `room.rng`
  // would shift every roll after it, and "Isles, seed 12345" is supposed to
  // describe the game rather than the order the seats were filled in — so the
  // seed would stop being a complete description of a reproducible board the
  // moment somebody clicked Add bot.
  const quiet = makeRoom();
  const busy = makeRoom('bob', 'ridge');
  quiet.rng = makeRng(20260925);
  busy.rng = makeRng(20260925);

  for (let i = 0; i < 3; i++) addBot(busy);

  const roll = (room) => [room.rng.next(), room.rng.next(), room.rng.next()];
  assert.deepEqual(roll(busy), roll(quiet), 'the dice stream moved when a bot was seated');
});

test('a bot is named after the version it was seated with, not the one drawn', () => {
  // Guards the wiring between the two: `nextBotName` takes the version as an
  // argument, so passing the drawn one to the seat and the default one to the
  // name would be invisible until a table had both.
  const room = makeRoom();
  const bot = addBot(room, 2).player;

  assert.equal(bot.botVersion, 2);
  assert.match(bot.name, /^v2 /);
  assert.equal(policyFor(2).planMove, planMoveV2, 'and v2 is the policy it will play');
});

test('a bot seat is connected from birth and holds no session', () => {
  // Both properties are load-bearing. `startGame` silently drops absent seats,
  // and a snapshot pauses the whole table when the current player is absent — so
  // a bot with the default `connected: false` would be dealt no land and would
  // also wedge the game behind a "Waiting for Bot 1" overlay forever.
  const room = makeRoom();
  const bot = addBot(room).player;

  assert.equal(bot.connected, true);
  assert.equal(bot.isBot, true);
  assert.equal(sessions.has(bot.token), false, 'a bot has no seat to resume into');
  assert.equal(listOpenRooms().length, 1, 'a lobby with a bot is still joinable');
});

test('a full room refuses another bot', () => {
  const room = makeRoom();
  for (let i = 1; i < MAX_PLAYERS; i++) assert.ok(addBot(room).player, `bot ${i}`);

  assert.equal(room.players.length, MAX_PLAYERS);
  assert.equal(addBot(room).error, 'room_full');
});

test('a bot cannot be added once the game has started', () => {
  const room = makeRoom();
  room.phase = PHASE.PLAYING;
  assert.equal(addBot(room).error, 'game_in_progress');
});

test('only bots can be removed with the bot control', () => {
  const room = makeRoom();
  const bot = addBot(room).player;

  assert.equal(removeBot(room, room.hostId).error, 'bad_request', 'the human host is not a bot');
  assert.equal(removeBot(room, 'p999').error, 'bad_request', 'nor is a seat that does not exist');

  assert.equal(removeBot(room, bot.id).ok, true);
  assert.equal(room.players.length, 1);
  assert.equal(room.players.some((p) => p.isBot), false);
});

test('a room with no humans left is deleted, bots and all', () => {
  // Bots never leave, so nothing else would ever clean this up: the room would
  // hold a row in the open-games list forever, with nobody able to start it.
  const room = makeRoom();
  const code = room.code;
  addBot(room);
  addBot(room);

  const result = removePlayer(room, room.hostId);

  assert.equal(result.emptied, true, 'the room is dead even though seats remain');
  assert.equal(rooms.has(code), false);
  assert.equal(listOpenRooms().length, 0);
});

test('a decided game releases the seat but keeps the player', () => {
  // The board names every owner and the client looks each one up in the players
  // list for a colour, so dropping the player would grey out their provinces on
  // the screens still watching. The roster is the record of the game.
  const room = makeRoom();
  const guest = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;
  room.phase = PHASE.OVER;

  const result = releaseSeat(room, guest.id);

  assert.equal(result.released, true);
  assert.equal(result.emptied, false, 'the host is still watching');
  assert.ok(room.players.some((p) => p.id === guest.id), 'the roster still names them');
  assert.equal(seatOf(room, guest.id).socketId, null, 'but the socket is free for another seat');
  assert.equal(seatOf(room, guest.id).connected, false);
});

test('a decided game nobody is watching is dropped', () => {
  // A bot is always "connected" and is not an audience, so it must not keep a
  // finished room alive for the life of the process.
  const room = makeRoom();
  addBot(room);
  room.phase = PHASE.OVER;

  const result = releaseSeat(room, room.hostId);

  assert.equal(result.emptied, true);
  assert.equal(rooms.has(room.code), false);
});

/* ── host handover ─────────────────────────────────────────────────────────── */

test('a bot never inherits the host role', () => {
  // `room:abandon` is host-only and a bot can never press it, so a bot holding
  // the role would make the one escape from a paused match unreachable. This is
  // the case that would otherwise reach for a bot: the only connected seat left.
  const room = makeRoom();
  const host = seatOf(room, room.hostId);
  const bot = addBot(room).player;

  host.connected = false;

  assert.equal(reassignHost(room), host.id, 'the role stays with the absent human');
  assert.notEqual(room.hostId, bot.id);
});

test('host handover prefers a connected human, then any human', () => {
  const room = makeRoom();
  addBot(room);
  const bot = room.players.find((p) => p.isBot);
  const offline = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;
  const online = joinRoom({ code: room.code, nickname: 'cat', socketId: 'sock-3' }).player;

  offline.connected = false;

  // The realistic path: the host leaves, so `removePlayer` splices them out and
  // asks who is next. The role goes to the human who is actually there, even
  // though `bob` is earlier in the roster — and the bot, which does satisfy
  // "is connected", is never a candidate at all.
  removePlayer(room, room.hostId);
  assert.equal(room.hostId, online.id);

  // Now the connected human leaves too. With nobody connected, an absent human
  // still beats a present bot: the hatch serves humans, and a bot cannot use it.
  removePlayer(room, online.id);
  assert.equal(room.hostId, offline.id, 'with nobody connected, any human will do');
  assert.notEqual(room.hostId, bot.id);
});

test('a returning player reclaims the role from an absent host', () => {
  // The deadlock this closes: reassignHost runs when the last human disconnects,
  // and at that moment there is nobody connected to prefer — so the role can
  // land on an absent seat. Seats are never removed mid-game, so it stays there.
  // The present player, not the reachable one, has to end up holding the hatch.
  const room = makeRoom();
  const host = seatOf(room, room.hostId);
  const guest = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;
  room.phase = PHASE.PLAYING;

  host.connected = false;
  guest.connected = false;
  reassignHost(room);
  assert.ok([host.id, guest.id].includes(room.hostId), 'the role is on an absent human, as it must be');

  guest.connected = true;
  assert.equal(reclaimAbsentHost(room, guest), guest.id, 'whoever is back takes over');
  assert.equal(room.hostId, guest.id);
});

test('an absent host keeps the role while a present one holds it', () => {
  const room = makeRoom();
  const host = seatOf(room, room.hostId);
  const guest = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;
  room.phase = PHASE.PLAYING;

  guest.connected = true;
  assert.equal(reclaimAbsentHost(room, guest), host.id, 'the host is right there');
});

test('nobody reclaims the role in the lobby', () => {
  // Pre-game the grace timer drops an absent host within LOBBY_GRACE_MS, so
  // waiting costs nothing — and taking the role off someone who is merely
  // mid-refresh would be a worse trade than waiting a few seconds.
  const room = makeRoom();
  const host = seatOf(room, room.hostId);
  const guest = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;

  host.connected = false;
  assert.equal(reclaimAbsentHost(room, guest), host.id, 'the lobby waits for the grace timer');
});

test('a bot never reclaims the host role', () => {
  const room = makeRoom();
  const host = seatOf(room, room.hostId);
  const bot = addBot(room).player;
  room.phase = PHASE.PLAYING;

  host.connected = false;
  assert.equal(reclaimAbsentHost(room, bot), host.id);
  assert.notEqual(room.hostId, bot.id);
});

test('a dangling host id is reclaimable', () => {
  const room = makeRoom();
  const guest = joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' }).player;
  room.phase = PHASE.PLAYING;

  room.hostId = 'p999';
  assert.equal(reclaimAbsentHost(room, guest), guest.id, 'a seat that is not in the room holds nothing');
});

/* ── the open-games list ───────────────────────────────────────────────────── */

test('only joinable games are listed', () => {
  const open = makeRoom('ana');
  const playing = makeRoom('bob');
  const full = makeRoom('cat');

  playing.phase = PHASE.PLAYING;
  for (let i = 1; i < MAX_PLAYERS; i++) addBot(full);

  const listed = listOpenRooms().map((r) => r.code);
  assert.deepEqual(listed, [open.code], 'a started game and a full one are both unjoinable');
});

test('a listed room describes itself without leaking internals', () => {
  const room = makeRoom('ana', 'archipelago');

  assert.deepEqual(listOpenRooms()[0], {
    code: room.code,
    hostName: 'ana',
    seats: 1,
    max: MAX_PLAYERS,
    mapId: 'archipelago',
    mapName: 'Archipelago',
    // Null, not absent: the row has one shape whether or not a size was picked,
    // so the client can render it without asking which kind of row it has.
    sizeId: null,
    sizeName: null,
  });
});

/* ── map size ──────────────────────────────────────────────────────────────── */

test('a room remembers the size it was created with', () => {
  const plain = makeRoom('ana');
  const sized = createRoom({ nickname: 'bob', mapId: 'frontier', sizeId: 'huge', socketId: 'sock-2' }).room;

  assert.equal(plain.sizeId, null, 'no size means the style decides, as it always did');
  assert.equal(sized.sizeId, 'huge');

  // And it reaches the menu, which is where a joiner sees what they are getting.
  assert.deepEqual(
    listOpenRooms().map((r) => [r.sizeId, r.sizeName]),
    [
      [null, null],
      ['huge', 'Huge'],
    ],
  );
});

test('a size the server does not know is refused, not ignored', () => {
  // The host picked it from a menu, so silently dealing them a different board
  // would be worse than saying no.
  const result = createRoom({ nickname: 'ana', mapId: 'ridge', sizeId: 'gigantic', socketId: 's' });
  assert.equal(result.error, 'bad_request');
  assert.equal(result.room, undefined);
});

test('a blank size is the same as no size', () => {
  // The menu's "Style default" option submits an empty string rather than
  // omitting the field, and that must not read as an unknown size.
  const room = createRoom({ nickname: 'ana', mapId: 'ridge', sizeId: '', socketId: 's' }).room;
  assert.equal(room.sizeId, null);
});

test('the list keeps creation order', () => {
  // Stability is the point: a list that reordered as people came and went would
  // reshuffle under someone's cursor between the click and the mouse-up.
  const first = makeRoom('ana');
  const second = makeRoom('bob');

  assert.deepEqual(listOpenRooms().map((r) => r.code), [first.code, second.code]);

  joinRoom({ code: first.code, nickname: 'zoe', socketId: 'sock-5' });
  assert.deepEqual(listOpenRooms().map((r) => r.code), [first.code, second.code], 'joining must not reorder');
});

/* ── names ─────────────────────────────────────────────────────────────────── */

test('an unnamed joiner takes the lowest free Player number', () => {
  const room = makeRoom('ana');

  assert.equal(joinRoom({ code: room.code, nickname: '', socketId: 's2' }).player.name, 'Player 1');
  assert.equal(joinRoom({ code: room.code, nickname: '   ', socketId: 's3' }).player.name, 'Player 2');

  // A human who took the name explicitly is respected, and the allocator steps
  // over them rather than colliding.
  assert.equal(joinRoom({ code: room.code, nickname: 'Player 4', socketId: 's4' }).player.name, 'Player 4');
  assert.equal(joinRoom({ code: room.code, nickname: '', socketId: 's5' }).player.name, 'Player 3');
});

test('an unnamed creator becomes Player 1', () => {
  const room = makeRoom('');
  assert.equal(room.players[0].name, 'Player 1');
  assert.equal(room.hostId, room.players[0].id);
});

test('an explicit name still collides', () => {
  const room = makeRoom('ana');
  assert.equal(joinRoom({ code: room.code, nickname: 'ANA', socketId: 's2' }).error, 'name_taken');
});

test('creating with an unknown map is refused', () => {
  assert.equal(createRoom({ nickname: 'ana', mapId: 'atlantis', socketId: 's' }).error, 'bad_request');
});

test('a fresh seat has nothing selected', () => {
  const room = makeRoom('ana');
  addBot(room);

  for (const p of room.players) {
    assert.equal(p.selected, null, `${p.name} starts with no selection`);
  }
});

test('the snapshot only reports selections while a game is running', () => {
  // A selection is a mid-game gesture, and the client is told to draw it only in
  // the playing phase. Publishing one from the lobby would mean either an
  // outline on a board that does not exist yet, or the client trusting a rule
  // it does not enforce.
  const room = makeRoom('ana');
  room.players[0].selected = 3;

  assert.equal(buildSnapshot(room).players[0].selected, null, 'nothing to select in the lobby');

  room.phase = PHASE.PLAYING;
  assert.equal(buildSnapshot(room).players[0].selected, 3, 'and it comes back with the game');
});

/* ── who is ahead ──────────────────────────────────────────────────────────── */

test('the snapshot names the leader only once there is a board', () => {
  const room = makeRoom('ana');
  joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' });

  assert.equal(buildSnapshot(room).leaderId, null, 'nothing is ranked in the lobby');

  assert.equal(startGame(room).ok, true, 'the fixture game must start');
  const snap = buildSnapshot(room);

  // The rail draws this field and the bots act on `leaderOf`. Asserted against
  // the rule rather than against a hand-computed ranking, because the thing that
  // matters is that the two agree — a client that ranked the board for itself
  // could mark one seat while the bots allied against another, and nothing on
  // screen would look wrong.
  assert.equal(snap.leaderId, leaderOf(snap.board));
  assert.ok(
    snap.players.some((p) => p.id === snap.leaderId),
    'and the leader is a seat at the table',
  );
});

test('the leader follows the board rather than the seat that was dealt well', () => {
  // Derived fresh in `buildSnapshot` like everything else there, so a capture
  // that changes who is ahead moves the chip on the next broadcast. A ranking
  // cached once at the deal would leave the rail marking whoever started best
  // for the rest of the match.
  const room = makeRoom('ana');
  joinRoom({ code: room.code, nickname: 'bob', socketId: 'sock-2' });
  startGame(room);

  const [first, second] = room.players;
  const { owner } = room.game.board;

  // Give the whole board to the second seat, then all of it to the first.
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== null) owner[i] = second.id;
  }
  assert.equal(buildSnapshot(room).leaderId, second.id);

  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === second.id) owner[i] = first.id;
  }
  assert.equal(buildSnapshot(room).leaderId, first.id);
});
