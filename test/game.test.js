// Turn-lifecycle tests for server/game.js.
//
// `startGame` and `endTurn` take a plain room object and never touch a socket,
// so a whole turn — and a whole sequence of turns — is drivable in-process.
// That matters most for reinforcement, whose arithmetic is fiddly to reach
// through a socket and trivial to reach directly.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DICE, MAX_PLAYERS, NEUTRAL, PALETTE, PHASE } from '../shared/constants.js';
import { isAllied, requestAlliance, respondAlliance } from '../server/alliances.js';
import { attack, endTurn, startGame } from '../server/game.js';
import { planMove } from '../server/bot-v1.js';
import { createRoom, deleteRoom, joinRoom } from '../server/rooms.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

/**
 * A started two-player game, plus the ids in turn order.
 *
 * The generated board is left in place; callers that care about the layout
 * replace it with `rig` below.
 */
function startedGame() {
  const { room } = createRoom({ nickname: 'ana', mapId: 'ridge', socketId: 's-ana' });
  joinRoom({ code: room.code, nickname: 'bob', socketId: 's-bob' });

  const started = startGame(room);
  assert.equal(started.ok, true, 'the fixture game must start');

  const first = started.event.turnPlayerId;
  const second = room.players.find((p) => p.id !== first).id;
  return { room, first, second };
}

/**
 * Replaces the board and adjacency wholesale.
 *
 * Everything `endTurn` reads is `board`, `adjacency`, `players` and the rng — it
 * never consults the map — so a hand-built three-cell fixture is both faster and
 * far more legible than reasoning about where the real generator happened to put
 * a province. `adjacency` must be the same length as `owner`.
 */
function rig(room, owner, dice, adjacency) {
  room.game.board = { owner: [...owner], dice: [...dice] };
  room.game.adjacency = adjacency.map((nbs) => [...nbs]);
  return room.game.board;
}

const playerOf = (room, id) => room.players.find((p) => p.id === id);

/* ── reinforcement carry-over ──────────────────────────────────────────────── */

test('reinforcement pays for every province held, scattered or not', () => {
  // The one case where the old formula and the new one disagree, which is why it
  // is the case worth pinning. Reinforcement used to be the largest CONNECTED
  // group, so three provinces in a row paid three and the same three scattered
  // paid one. It is now simply the count.
  //
  // p1 holds 0, 2 and 4; none of them touches another, and every neighbour any of
  // them has belongs to p2. So the largest group is 1 and the territory count is
  // 3 — the assertion is that the payout follows the count.
  const { room, first, second } = startedGame();
  const board = rig(
    room,
    [first, second, first, second, first],
    [1, 1, 1, 1, 1],
    [[1], [0], [3], [2], []],
  );

  const res = endTurn(room, first);

  assert.equal(res.ok, true);
  assert.equal(res.event.gain, 3, 'three provinces, and not one of them connected');
  assert.equal(board.owner.filter((o) => o === first).length, 3, 'sanity: p1 really holds three');

  deleteRoom(room.code);
});

test('endTurn never destroys reinforcement, even on a completely full board', () => {
  const { room, first, second } = startedGame();
  // Two cells owned by the player whose turn it is, both already at the cap, so
  // there is nowhere for the gain to land.
  const board = rig(
    room,
    [first, first, second],
    [MAX_DICE, MAX_DICE, MAX_DICE],
    [[1], [0, 2], [1]],
  );

  const player = playerOf(room, first);
  player.stock = 63;
  const stockBefore = player.stock;

  const res = endTurn(room, first);
  assert.equal(res.ok, true);

  // The property that matters, stated so it holds at any magnitude: every die
  // that existed before is somewhere after. The old STOCK_MAX clamp broke this
  // by discarding the top of the reserve.
  assert.equal(
    res.event.gain + stockBefore,
    res.event.placed + res.event.stockLeft,
    'gain + carried-in must equal placed + still-held',
  );

  assert.equal(res.event.placed, 0, 'the board is full, so nothing can land');
  assert.equal(res.event.stockLeft, 65, '63 held + 2 earned, with no cap to clip it');
  assert.equal(player.stock, 65);
  assert.deepEqual(board.dice, [MAX_DICE, MAX_DICE, MAX_DICE]);

  deleteRoom(room.code);
});

test('endTurn reissues a hoarded reserve once a territory has room', () => {
  const { room, first, second } = startedGame();
  const board = rig(
    room,
    [first, first, second],
    [MAX_DICE, MAX_DICE, MAX_DICE],
    [[1], [0, 2], [1]],
  );

  const player = playerOf(room, first);
  player.stock = 63;

  // Turn one: nowhere to place, so the whole gain is banked.
  endTurn(room, first);
  assert.equal(player.stock, 65);

  // A repelled attack collapses that stack to a single die, opening room.
  board.dice[0] = 1;

  // Pass the turn back around.
  assert.equal(endTurn(room, second).ok, true);
  const res = endTurn(room, first);

  assert.equal(res.ok, true);
  assert.equal(res.event.gain, 2, 'still two provinces');
  assert.equal(res.event.placed, 7, 'one territory absorbs at most MAX_DICE - 1');
  assert.equal(res.event.stockLeft, 60, '65 + 2 - 7');
  assert.equal(board.dice[0], MAX_DICE, 'the field is back to full');
  assert.equal(player.stock, 60);

  deleteRoom(room.code);
});

test("endTurn pays out the worked example: 1 for the field plus 6 of overflow", () => {
  // The scenario as reported: one territory sitting alone at 8 dice, a reserve of
  // 10, an attack repelled so the territory is down to 1. Ending the turn gives
  // 1 die for the territory and 6 more out of the reserve — back to 8, with 4
  // left over.
  const { room, first, second } = startedGame();
  const board = rig(room, [first, second, second], [1, MAX_DICE, MAX_DICE], [[], [2], [1]]);

  const player = playerOf(room, first);
  player.stock = 10;

  const res = endTurn(room, first);
  assert.equal(res.ok, true);

  assert.equal(res.event.gain, 1, 'one province, so one die');
  assert.equal(res.event.placed, 7, 'six from the reserve plus the one just earned');
  assert.equal(board.dice[0], MAX_DICE, 'the field is back to 8');
  assert.equal(res.event.stockLeft, 4, '10 + 1 - 7');
  assert.equal(player.stock, 4);

  deleteRoom(room.code);
});

/* ── the standoff the weaker attacker creates ──────────────────────────────── */

test('a bot still wins against a passive opponent rather than declining forever', () => {
  // This is the test for the deadlock that "attackers roll one die fewer than
  // their stack" introduced, and it is the reason the policy carries an
  // exception at all.
  //
  // Once both sides' provinces reach MAX_DICE no attack can be profitable and no
  // reinforcement can change anything, so a bot that only ever took positive-EV
  // moves would decline for the rest of the match. `stepBot` has no counter
  // behind it — the plan is recomputed and the turn ended, forever — so the
  // symptom is a game that simply never finishes rather than one that crashes.
  // Driven here in-process: the integration suite would just hang.
  //
  // The opponent always ends its turn without attacking, so every capture the bot
  // makes is permanent; reaching a winner is therefore purely a question of
  // whether the bot keeps playing.
  const { room, first, second } = startedGame();

  const LIMIT = 5000;
  let steps = 0;
  while (room.phase === PHASE.PLAYING && steps < LIMIT) {
    const current = room.players[room.game.turnIndex];
    if (current.id === first) {
      const move = planMove(room.game.board, room.game.adjacency, first);
      const result = move
        ? attack(room, first, move.from, move.to)
        : endTurn(room, first);
      assert.equal(result.ok, true, `step ${steps}: the bot proposed an illegal action`);
    } else {
      endTurn(room, second);
    }
    steps++;
  }

  assert.notEqual(room.phase, PHASE.PLAYING, `stalled with no winner after ${LIMIT} steps`);
  assert.equal(room.game.winnerId, first, 'the only player attacking must be the one who wins');

  deleteRoom(room.code);
});

/* ── neutral land ──────────────────────────────────────────────────────────── */

/** Dice owned by `id` across the whole board. */
const diceOf = (board, id) =>
  board.owner.reduce((sum, owner, t) => (owner === id ? sum + board.dice[t] : sum), 0);

/** How many territories `id` owns. */
const landOf = (board, id) => board.owner.filter((o) => o === id).length;

test('startGame caps each player at five provinces and leaves the rest neutral', () => {
  // The generated board here is 30 provinces; two players at five each leaves 20
  // for nobody. Those are not unowned — an unowned land territory would be
  // capturable for free by `canAttack`, which only refuses `owner === null` — so
  // they belong to the neutral faction.
  const { room, first, second } = startedGame();
  const { board } = room.game;

  assert.equal(board.owner.length, 30, 'the fixture board is 30 provinces');
  assert.equal(landOf(board, first), 5, 'the first player is capped at five');
  assert.equal(landOf(board, second), 5, 'so is the second');
  assert.equal(landOf(board, NEUTRAL), 20, 'and everything else is neutral');

  assert.ok(
    board.owner.every((o) => o === first || o === second || o === NEUTRAL),
    'every province is owned by a player or by the neutrals',
  );

  deleteRoom(room.code);
});

test('startGame does not over-fill the players because of the neutral land', () => {
  // The setup pool is per PLAYER territory. Counting the whole board instead
  // would deal 2 dice for each of the 30 provinces rather than each of the 10
  // the players hold — three times the intended reinforcement, enough to fill
  // every player province straight to the cap.
  const { room, first, second } = startedGame();
  const { board } = room.game;

  assert.equal(diceOf(board, first), 15, 'five provinces at 1, plus ten dealt dice');
  assert.equal(diceOf(board, second), 15, 'and the same for the other player');
  assert.ok(
    board.owner.every((o, t) => o === NEUTRAL || board.dice[t] < MAX_DICE),
    'nobody starts at the cap',
  );

  deleteRoom(room.code);
});

test('neutral provinces start with a single die', () => {
  const { room } = startedGame();
  const { board } = room.game;

  const neutralDice = board.dice.filter((_, t) => board.owner[t] === NEUTRAL);
  assert.equal(neutralDice.length, 20);
  assert.ok(neutralDice.every((d) => d === 1), 'every neutral province starts at 1');
  assert.equal(diceOf(board, NEUTRAL), 20);

  deleteRoom(room.code);
});

test('neutrals gain a die once every second round, not once per turn or per round', () => {
  // Two halvings, and this test needs both. Growing on every TURN would advance
  // the wall at twice the players' rate on a two-player board; growing on every
  // ROUND would still outpace the ask, which is one die per two rounds.
  const { room, first, second } = startedGame();
  const board = rig(room, [first, second, NEUTRAL], [1, 1, 1], [[1, 2], [0, 2], [0, 1]]);

  // Round 1, first turn — the rotation has not come back around.
  const r1 = endTurn(room, first);
  assert.deepEqual(r1.event.neutralGrowth, [], 'nothing grows mid-round');
  assert.equal(room.game.round, 0);

  // Round 1 completes. It is odd, so the wall holds.
  const r2 = endTurn(room, second);
  assert.deepEqual(r2.event.neutralGrowth, [], 'an odd round grows nothing');
  assert.equal(room.game.round, 1);
  assert.equal(board.dice[2], 1, 'still untouched after one whole round');

  // Round 2, first turn — mid-round again, so still nothing.
  endTurn(room, first);
  assert.equal(board.dice[2], 1, 'and still untouched mid-round');

  // Round 2 completes. Even — the wall advances.
  const r4 = endTurn(room, second);
  assert.deepEqual(r4.event.neutralGrowth, [2], 'the even round grows it');
  assert.equal(board.dice[2], 2);
  assert.equal(room.game.round, 2);

  deleteRoom(room.code);
});

test('neutral growth stops at the cap', () => {
  const { room, first, second } = startedGame();
  const board = rig(
    room,
    [first, second, NEUTRAL, NEUTRAL],
    [1, 1, MAX_DICE, MAX_DICE - 1],
    [[1, 2], [0, 3], [0], [1]],
  );

  // Two full rounds: the wall only moves on the even one.
  endTurn(room, first);
  assert.deepEqual(endTurn(room, second).event.neutralGrowth, [], 'round 1 is odd');
  endTurn(room, first);
  const r4 = endTurn(room, second);

  assert.deepEqual(r4.event.neutralGrowth, [3], 'only the one with room grows');
  assert.equal(board.dice[2], MAX_DICE, 'a province at the cap stays there');
  assert.equal(board.dice[3], MAX_DICE, 'and one below it stops on reaching it');

  deleteRoom(room.code);
});

/* ── alliances ─────────────────────────────────────────────────────────────── */

/**
 * A started three-player game, plus the ids in turn order.
 *
 * A third seat because elimination is what the interesting case needs: killing
 * one of two players ends the game, so it never reaches the dissolve.
 */
function startedThree() {
  const { room } = createRoom({ nickname: 'ana', mapId: 'ridge', socketId: 's-ana' });
  joinRoom({ code: room.code, nickname: 'bob', socketId: 's-bob' });
  joinRoom({ code: room.code, nickname: 'cid', socketId: 's-cid' });

  assert.equal(startGame(room).ok, true, 'the fixture game must start');
  return { room, ids: room.players.map((p) => p.id) };
}

/**
 * Makes a real pact through the real transitions.
 *
 * Poking `allies` directly would be shorter and would skip the thing every test
 * below depends on: that both halves of the edge were written.
 */
function pact(room, a, b) {
  assert.equal(requestAlliance(room, a, b).ok, true);
  assert.equal(respondAlliance(room, b, a, true).ok, true);
  assert.equal(isAllied(room, a, b), true, 'the fixture pact must exist');
}

test('attacking an ally breaks the pact', () => {
  // Attacking an ally is legal — that is the explicit rule, and the reason
  // `canAttack` knows nothing about alliances. The pact is what breaks.
  const { room, first, second } = startedGame();
  pact(room, first, second);

  rig(room, [first, second], [2, 2], [[1], [0]]);
  const result = attack(room, first, 0, 1);

  assert.equal(result.ok, true);
  assert.equal(result.event.brokeAlliance, true, 'the click that broke a pact says so on the event');
  assert.equal(isAllied(room, first, second), false);
  assert.deepEqual(playerOf(room, first).allies, []);
  assert.deepEqual(playerOf(room, second).allies, [], 'and both halves go together');

  deleteRoom(room.code);
});

test('an attack that breaks nothing says so plainly', () => {
  // One game per assertion, not two attacks on one. Two dice against two capture
  // often, and a capture here empties the second seat — which in a two-player
  // game is the win condition, so the next attack would answer `game_over` and
  // have no event at all. It read as a green test about nine runs in ten.
  const plain = startedGame();
  rig(plain.room, [plain.first, plain.second], [2, 2], [[1], [0]]);
  assert.equal(attack(plain.room, plain.first, 0, 1).event.brokeAlliance, false);
  deleteRoom(plain.room.code);

  // The neutral faction is an owner id with no seat behind it, so the lookup has
  // nothing to find — which is exactly why the guard is written out rather than
  // left to the accident that `NEUTRAL` appears in no `allies` list.
  const neutral = startedGame();
  rig(neutral.room, [neutral.first, NEUTRAL], [2, 2], [[1], [0]]);
  assert.equal(attack(neutral.room, neutral.first, 0, 1).event.brokeAlliance, false);
  deleteRoom(neutral.room.code);
});

test('a blow that eliminates a player dissolves every pact that named them', () => {
  // Rigs the dice rather than the board, because the capture has to be certain:
  // every die comes up 6, so the bigger stack always wins the roll. `d6` is the
  // only method `attack` reaches.
  const { room, ids } = startedThree();
  const [first, second, third] = ids;
  room.rng = { d6: () => 6 };

  // `second` holds one province between the other two, so taking it is fatal —
  // and with a third seat left alive that is an elimination, not a win.
  rig(room, [first, second, third], [3, 1, 1], [[1], [0, 2], [1]]);

  pact(room, first, second);
  pact(room, second, third);
  requestAlliance(room, third, second); // and one ask in flight, naming them too

  const result = attack(room, first, 0, 1);

  assert.equal(result.ok, true);
  assert.equal(result.event.eliminatedPlayerId, second);
  assert.deepEqual(playerOf(room, second).allies, [], "the dead seat's own edge is gone");
  assert.deepEqual(playerOf(room, second).requested, []);
  assert.deepEqual(playerOf(room, third).allies, [], 'so is the pact with the survivor that was not attacked');
  assert.deepEqual(playerOf(room, third).requested, [], 'and the ask that can no longer be answered');

  deleteRoom(room.code);
});

test('endTurn reinforces against what the pact lets it ignore', () => {
  // The one thing no rule-level test can see: that `endTurn` actually hands the
  // ally set to `distributeDice`. Without it a bot would spend its reinforcement
  // massing against a border it has promised not to attack, and every
  // `distributeDice` test would still pass.
  //
  // `first` holds 0 and 2 and so is paid exactly two dice. Without the pact both
  // go to province 0, which is beside `second`'s stack of eight; with it, 0 is
  // behind nothing at all and the dice build against the neutral 5 instead.
  const plain = startedGame();
  rig(plain.room, [plain.first, plain.second, plain.first, NEUTRAL], [1, 8, 1, 5], [[1], [0], [3], [2]]);
  assert.equal(endTurn(plain.room, plain.first).ok, true);
  assert.deepEqual(plain.room.game.board.dice, [3, 8, 1, 5], 'matches the stack that can hit it');
  deleteRoom(plain.room.code);

  const allied = startedGame();
  pact(allied.room, allied.first, allied.second);
  rig(allied.room, [allied.first, allied.second, allied.first, NEUTRAL], [1, 8, 1, 5], [[1], [0], [3], [2]]);
  assert.equal(endTurn(allied.room, allied.first).ok, true);
  assert.deepEqual(allied.room.game.board.dice, [1, 8, 3, 5], 'and ignores the ally to face the neutral');
  deleteRoom(allied.room.code);
});

test('ending the turn is a fresh turn for diplomacy', () => {
  // The guard that bounds the request → refusal → request cycle: a refusal clears
  // the pending entry, so the bot's idempotence check alone would let it ask
  // again on the very next tick.
  const { room, first, second } = startedGame();
  requestAlliance(room, first, second);
  assert.equal(playerOf(room, first).askedThisTurn, true);

  endTurn(room, first);

  assert.equal(playerOf(room, first).askedThisTurn, false);
  assert.equal(playerOf(room, second).askedThisTurn, false, 'and only the asker was ever marked');

  deleteRoom(room.code);
});

/* ── the deal ──────────────────────────────────────────────────────────────── */

/** A full eight-seat table, which is the only size that can expose a collision. */
function fullTable() {
  const { room } = createRoom({ nickname: 'p1', mapId: 'ridge', socketId: 's-1' });
  for (let n = 2; n <= MAX_PLAYERS; n++) {
    joinRoom({ code: room.code, nickname: `p${n}`, socketId: `s-${n}` });
  }
  return room;
}

test('a started game deals every seat a colour of its own', () => {
  // Distinctness is the whole contract: two seats sharing a fill is not a
  // cosmetic slip, it makes the board unreadable — you cannot tell whose province
  // is whose, and neither can the player. A full table is the case that catches a
  // palette dealt without regard for what is already out.
  const room = fullTable();
  assert.equal(room.players.length, MAX_PLAYERS, 'the fixture must seat a full table');

  assert.equal(startGame(room).ok, true);

  const colors = room.players.map((p) => p.color);
  assert.equal(new Set(colors).size, colors.length, `two seats share a colour: ${colors.join(', ')}`);
  for (const color of colors) {
    assert.ok(PALETTE.includes(color), `${color} is not in the palette`);
  }

  deleteRoom(room.code);
});

test('the colour deal comes from the room rng, not from the join order', () => {
  // Colours are assigned in the lobby by `freeColor`, which walks the palette in
  // order — so seat one is always `PALETTE[0]` however the game is dealt. Stubbed
  // to reverse rather than left to the real shuffle because "the deal is random"
  // is not assertable: a genuine shuffle comes out in join order often enough to
  // pass whether the code re-deals or forgets to.
  const room = fullTable();
  const lobbyOrder = room.players.map((p) => p.color);
  assert.deepEqual(lobbyOrder, PALETTE, 'the fixture assumes the lobby hands them out in order');

  room.rng.shuffle = (arr) => arr.reverse(); // in place, like the real one
  assert.equal(startGame(room).ok, true);

  assert.deepEqual(
    room.players.map((p) => p.color),
    [...PALETTE].reverse(),
    'the palette is shuffled and dealt out by seat',
  );

  deleteRoom(room.code);
});
