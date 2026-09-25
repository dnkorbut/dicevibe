// Tests for server/alliances.js.
//
// The transitions take a plain room and never touch a socket, so a whole
// diplomatic sequence — ask, accept, break, eliminate — is drivable in-process.
//
// The property most of these are circling is the one the module exists to
// protect: an edge is symmetric, or it is not an edge. A one-sided alliance is
// invisible in the rules (reinforcement honours it) and impossible to break
// (the rail offers Break, and it answers NOT_ALLIED), so it has to be asserted
// after every operation rather than only at the end of a sequence.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ERR, NEUTRAL, PHASE } from '../shared/constants.js';
import {
  allySetOf,
  breakAlliance,
  dissolveFor,
  inboundRequests,
  isAllied,
  requestAlliance,
  respondAlliance,
} from '../server/alliances.js';
import { startGame } from '../server/game.js';
import { buildSnapshot, createRoom, deleteRoom, joinRoom, removePlayer } from '../server/rooms.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

/** A started three-player game, plus the ids in turn order. */
function startedGame() {
  const { room } = createRoom({ nickname: 'ana', mapId: 'ridge', socketId: 's-ana' });
  joinRoom({ code: room.code, nickname: 'bob', socketId: 's-bob' });
  joinRoom({ code: room.code, nickname: 'cid', socketId: 's-cid' });

  const started = startGame(room);
  assert.equal(started.ok, true, 'the fixture game must start');

  const ids = room.players.map((p) => p.id);
  return { room, ids, a: ids[0], b: ids[1], c: ids[2] };
}

const playerOf = (room, id) => room.players.find((p) => p.id === id);

/**
 * Asserts the whole room agrees about who is allied with whom.
 *
 * Called after every operation in the sequence below. Checking only at the end
 * would pass a run that went one-sided in the middle and was repaired by a later
 * `sever`, which is exactly the bug this is here to catch.
 */
function assertSymmetric(room) {
  for (const player of room.players) {
    for (const ally of player.allies) {
      const other = playerOf(room, ally);
      assert.ok(other, `${player.id} is allied with ${ally}, who is not in the room`);
      assert.ok(
        other.allies.includes(player.id),
        `${player.id} lists ${ally} as an ally, but not the other way round`,
      );
    }
  }
}

/** No two seats may have pending asks pointing at each other at the same time. */
function assertNoDoublePending(room) {
  for (const a of room.players) {
    for (const b of room.players) {
      if (a.id >= b.id) continue;
      const bothWays = a.requested.includes(b.id) && b.requested.includes(a.id);
      assert.ok(!bothWays, `${a.id} and ${b.id} have asks open in both directions`);
    }
  }
}

/* ── the happy path ────────────────────────────────────────────────────────── */

test('an accepted request allies both sides', () => {
  const { room, a, b } = startedGame();

  const asked = requestAlliance(room, a, b);
  assert.equal(asked.ok, true);
  assert.equal(asked.changed, true);
  assert.equal(asked.event.action, 'request');
  assert.deepEqual(playerOf(room, a).requested, [b]);
  assert.equal(isAllied(room, a, b), false, 'asking is not agreeing');
  assertSymmetric(room);

  const yes = respondAlliance(room, b, a, true);
  assert.equal(yes.ok, true);
  assert.equal(yes.event.action, 'accept');
  assert.equal(isAllied(room, a, b), true);
  assert.equal(isAllied(room, b, a), true);
  assert.deepEqual(playerOf(room, a).requested, [], 'the question is closed');
  assert.deepEqual(playerOf(room, b).requested, []);
  assertSymmetric(room);
});

test('asking somebody who has already asked you is the agreement', () => {
  // Mutual consent without a second round trip, and it leaves no state where two
  // asks point at each other waiting for somebody to notice.
  const { room, a, b } = startedGame();

  requestAlliance(room, a, b);
  const back = requestAlliance(room, b, a);

  assert.equal(back.ok, true);
  assert.equal(back.changed, true);
  assert.equal(back.event.action, 'accept');
  assert.equal(isAllied(room, a, b), true);
  assert.deepEqual(playerOf(room, a).requested, []);
  assert.deepEqual(playerOf(room, b).requested, []);
  assertNoDoublePending(room);
});

test('re-asking something already open is a no-op, not an error', () => {
  // A double click is routine. It must not put a refusal on screen, and it must
  // not cost the room a broadcast either — `changed` is what says so.
  const { room, a, b } = startedGame();

  requestAlliance(room, a, b);
  const version = room.game.version;
  const again = requestAlliance(room, a, b);

  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(room.game.version, version, 'a no-op must not bump the version');
  assert.deepEqual(playerOf(room, a).requested, [b], 'and must not duplicate the ask');
});

test('a request marks the asker, and only the asker', () => {
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);

  // Set on the ask, not on the seat: it is what stops a bot whose offer was
  // refused from asking again on the very next tick, which the idempotence check
  // cannot see because the refusal removed the pending entry.
  assert.equal(playerOf(room, a).askedThisTurn, true);
  assert.equal(playerOf(room, b).askedThisTurn, false, 'only the asker is marked');
});

/* ── refusals ──────────────────────────────────────────────────────────────── */

test('every refusal names itself', () => {
  const { room, a, b } = startedGame();

  assert.equal(requestAlliance(room, a, a).error, ERR.ALLIANCE_SELF);
  assert.equal(requestAlliance(room, a, 'nobody').error, ERR.NO_SUCH_PLAYER);
  assert.equal(breakAlliance(room, a, b).error, ERR.NOT_ALLIED);
  assert.equal(respondAlliance(room, a, b, true).error, ERR.NO_PENDING_REQUEST);
  assert.equal(respondAlliance(room, a, b, false).error, ERR.NO_PENDING_REQUEST);
  assert.equal(breakAlliance(room, a, a).error, ERR.ALLIANCE_SELF);

  requestAlliance(room, a, b);
  respondAlliance(room, b, a, true);
  assert.equal(requestAlliance(room, a, b).error, ERR.ALREADY_ALLIED);
  assert.equal(respondAlliance(room, b, a, true).error, ERR.NO_PENDING_REQUEST);

  // Nothing above should have left a mark.
  assertSymmetric(room);
});

test('a second accept of the same offer answers NO_PENDING_REQUEST', () => {
  // Two clients can both click Accept on one offer, and the loser has to get an
  // answer it can discard quietly rather than a second alliance event.
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);

  assert.equal(respondAlliance(room, b, a, true).ok, true);
  const late = respondAlliance(room, b, a, true);
  assert.equal(late.ok, false);
  assert.equal(late.error, ERR.NO_PENDING_REQUEST);
  assert.equal(isAllied(room, a, b), true, 'and the first one stands');
});

test('the asker cannot accept their own question', () => {
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);

  const self = respondAlliance(room, a, b, true);
  assert.equal(self.ok, false);
  assert.equal(self.error, ERR.NO_PENDING_REQUEST);
  assert.equal(isAllied(room, a, b), false);
});

test('an eliminated seat can be neither asked nor allied', () => {
  const { room, a, b } = startedGame();
  playerOf(room, b).eliminated = true;

  assert.equal(requestAlliance(room, a, b).error, ERR.NO_SUCH_PLAYER);
  assert.equal(breakAlliance(room, a, b).error, ERR.NO_SUCH_PLAYER);
  assert.equal(respondAlliance(room, a, b, true).error, ERR.NO_SUCH_PLAYER);
});

test('nothing is accepted once the game is over', () => {
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);

  room.phase = PHASE.OVER;
  assert.equal(requestAlliance(room, a, b).error, ERR.GAME_OVER);
  assert.equal(respondAlliance(room, b, a, true).error, ERR.GAME_OVER);
  assert.equal(breakAlliance(room, a, b).error, ERR.GAME_OVER);
});

/* ── declining and withdrawing ─────────────────────────────────────────────── */

test('a decline and a withdrawal are the same state change, named apart', () => {
  // The asked player turning an offer down and the asker calling it off are one
  // change to the room and two different things to read in the log, which is why
  // the event carries the actor and the transition decides the label.
  const { room, a, b, c } = startedGame();

  requestAlliance(room, a, b);
  const declined = respondAlliance(room, b, a, false);
  assert.equal(declined.event.action, 'decline');
  assert.equal(declined.event.actorId, b);
  assert.equal(declined.event.otherId, a);
  assert.deepEqual(playerOf(room, a).requested, []);

  requestAlliance(room, a, c);
  const withdrawn = respondAlliance(room, a, c, false);
  assert.equal(withdrawn.event.action, 'withdraw');
  assert.equal(withdrawn.event.actorId, a);
  assert.equal(withdrawn.event.otherId, c);
  assert.deepEqual(playerOf(room, a).requested, []);
  assert.equal(isAllied(room, a, c), false);
  assertSymmetric(room);
});

/* ── breaking ──────────────────────────────────────────────────────────────── */

test('breaking is symmetric and idempotent in its refusal', () => {
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);
  respondAlliance(room, b, a, true);

  const broken = breakAlliance(room, b, a);
  assert.equal(broken.ok, true);
  assert.equal(broken.event.action, 'break');
  assert.equal(isAllied(room, a, b), false);
  assert.deepEqual(playerOf(room, a).allies, []);
  assert.deepEqual(playerOf(room, b).allies, []);
  assert.equal(breakAlliance(room, b, a).error, ERR.NOT_ALLIED);
  assertSymmetric(room);
});

/* ── a scripted sequence ───────────────────────────────────────────────────── */

test('the invariants hold after every step of a scripted sequence', () => {
  const { room, ids, a, b, c } = startedGame();

  const steps = [
    () => requestAlliance(room, a, b),
    () => requestAlliance(room, c, b),
    () => respondAlliance(room, b, a, true),
    () => respondAlliance(room, b, c, false),
    () => requestAlliance(room, c, a),
    () => respondAlliance(room, a, c, true),
    () => requestAlliance(room, b, a),
    () => breakAlliance(room, a, b),
    () => requestAlliance(room, a, b),
    () => respondAlliance(room, b, a, true),
    () => breakAlliance(room, b, a),
    () => dissolveFor(room, a),
  ];

  for (const [i, step] of steps.entries()) {
    step();
    assertSymmetric(room);
    assertNoDoublePending(room);

    for (const id of ids) {
      const player = playerOf(room, id);
      assert.ok(!player.allies.includes(id), `step ${i}: ${id} is allied with itself`);
      assert.ok(!player.requested.includes(id), `step ${i}: ${id} has asked itself`);
    }
  }
});

/* ── dissolving ────────────────────────────────────────────────────────────── */

test('dissolveFor strips both directions and any pending ask naming the seat', () => {
  const { room, a, b, c } = startedGame();

  // a–b allied, c has asked a, a has asked c: one edge and one ask in each
  // direction, so a scrub that handled only one of them would still look tidy.
  requestAlliance(room, a, b);
  respondAlliance(room, b, a, true);
  requestAlliance(room, c, a);

  dissolveFor(room, a);

  assert.deepEqual(playerOf(room, b).allies, [], 'the pact is gone from the other side');
  assert.deepEqual(playerOf(room, c).requested, [], "c's open ask to a is gone");
  assertSymmetric(room);
  assert.equal(allySetOf(playerOf(room, b)).size, 0);
});

test('dissolveFor works after the seat has already been spliced out', () => {
  // `removePlayer` calls it post-splice, so it may not depend on the seat being
  // present — and a rule that only held while the player was still there would
  // look correct in every test that forgot to remove them first.
  const { room, a, b } = startedGame();
  requestAlliance(room, a, b);
  respondAlliance(room, b, a, true);

  room.players.splice(
    room.players.findIndex((p) => p.id === a),
    1,
  );
  dissolveFor(room, a);

  assert.deepEqual(playerOf(room, b).allies, []);
});

test('removing a seat scrubs it from everyone else', () => {
  // Unreachable mid-game, where seats are never removed — but the lobby path is
  // real, and a leftover edge there would survive into the game as an alliance
  // with a player who no longer exists.
  const { room } = createRoom({ nickname: 'ana', mapId: 'ridge', socketId: 's-ana' });
  joinRoom({ code: room.code, nickname: 'bob', socketId: 's-bob' });
  const [a, b] = room.players.map((p) => p.id);

  // Written directly: alliances cannot be made in the lobby, so the only way to
  // reach the state the scrub exists for is to build it.
  assert.equal(room.phase, PHASE.LOBBY);
  playerOf(room, a).allies = [b];
  playerOf(room, b).allies = [a];
  playerOf(room, b).requested = [a];

  removePlayer(room, a);

  assert.deepEqual(playerOf(room, b).allies, [], 'the survivor keeps no phantom ally');
  assert.deepEqual(playerOf(room, b).requested, [], 'nor a phantom ask');
  deleteRoom(room.code);
});

/* ── the wire ──────────────────────────────────────────────────────────────── */

test('the snapshot publishes both lists, in both phases', async () => {
  const { room, a, b } = startedGame();

  requestAlliance(room, a, b);
  const playing = buildSnapshot(room);
  const seat = (snap, id) => snap.players.find((p) => p.id === id);

  assert.deepEqual(seat(playing, a).requested, [b], 'the ask is public');
  assert.deepEqual(seat(playing, b).allies, []);

  respondAlliance(room, b, a, true);
  const allied = seat(buildSnapshot(room), a);
  assert.deepEqual(allied.allies, [b]);
  assert.deepEqual(allied.requested, []);

  // Over: a pending question stops existing when the game does, so the rail
  // never offers to withdraw something that can no longer be answered.
  requestAlliance(room, a, b);
  room.phase = PHASE.OVER;
  const over = buildSnapshot(room);
  assert.deepEqual(seat(over, a).requested, []);
  assert.deepEqual(seat(over, a).allies, [b], 'but the pact is still the record of the game');
});

test('inboundRequests names exactly the seats waiting on an answer', () => {
  const { room, a, b, c } = startedGame();

  requestAlliance(room, b, a);
  requestAlliance(room, c, a);
  assert.deepEqual(inboundRequests(room, a).sort(), [b, c].sort());
  assert.deepEqual(inboundRequests(room, b), [], 'a has not asked anybody');
  assert.deepEqual(inboundRequests(room, NEUTRAL), []);
});
