// Rules engine tests. These drive `shared/rules.js` headlessly with a stubbed
// RNG, so every assertion about a dice outcome is exact rather than statistical.
//
// The one exception is the Monte Carlo block at the bottom, which deliberately
// uses the real PRNG — see the comment there for why it is the most important
// test in the file.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ERR, MAX_DICE, NEUTRAL } from '../shared/constants.js';
import {
  applyAttack,
  bankDice,
  canAttack,
  checkWin,
  diceSumDistribution,
  distributeDice,
  largestGroup,
  nextTurnIndex,
  refreshEliminated,
  resolveAttack,
  territoryCount,
  winChance,
} from '../shared/rules.js';
import { makeRng } from '../server/rng.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

const board = (owner, dice) => ({ owner, dice });

/**
 * An RNG that replays a fixed list of dice and throws when exhausted.
 *
 * Throwing on exhaustion is the point: it turns "the attacker rolls its whole
 * stack" from something we hope is true into something a wrong dice count
 * fails on. A stub that quietly returned undefined would produce NaN sums and
 * pass by accident.
 */
function rngFrom(values) {
  const queue = [...values];
  return {
    d6() {
      if (queue.length === 0) throw new Error('rng.d6() called more times than the test provided');
      return queue.shift();
    },
    remaining: () => queue.length,
  };
}

/** A trivial 3x3 grid graph: 0-1-2 / 3-4-5 / 6-7-8. */
const GRID = [
  [1, 3],
  [0, 2, 4],
  [1, 5],
  [0, 4, 6],
  [1, 3, 5, 7],
  [2, 4, 8],
  [3, 7],
  [4, 6, 8],
  [5, 7],
];

/* ── territoryCount ────────────────────────────────────────────────────────── */

test('territoryCount counts only the given player', () => {
  const b = board(['p1', 'p2', 'p1', 'p1', 'p3'], [1, 1, 1, 1, 1]);
  assert.equal(territoryCount(b, 'p1'), 3);
  assert.equal(territoryCount(b, 'p2'), 1);
  assert.equal(territoryCount(b, 'nobody'), 0);
});

/* ── canAttack ─────────────────────────────────────────────────────────────── */

test('canAttack accepts a legal attack', () => {
  const b = board(['p1', 'p2'], [3, 1]);
  assert.equal(canAttack(b, [[1], [0]], 0, 1, 'p1'), true);
});

test('canAttack rejects malformed indices', () => {
  const b = board(['p1', 'p2'], [3, 1]);
  const adj = [[1], [0]];
  assert.equal(canAttack(b, adj, 0.5, 1, 'p1').error, ERR.BAD_REQUEST);
  assert.equal(canAttack(b, adj, '0', 1, 'p1').error, ERR.BAD_REQUEST);
  assert.equal(canAttack(b, adj, -1, 1, 'p1').error, ERR.BAD_REQUEST);
  assert.equal(canAttack(b, adj, 0, 2, 'p1').error, ERR.BAD_REQUEST);
  assert.equal(canAttack(b, adj, 0, 0, 'p1').error, ERR.BAD_REQUEST);
});

test('canAttack rejects each illegal attack with its own code', () => {
  const b = board(['p1', 'p2', 'p1'], [3, 1, 5]);
  const adj = [[1], [0, 2], [1]];

  assert.equal(canAttack(b, adj, 0, 1, 'p2').error, ERR.NOT_OWNER);
  // 2 is p1's own territory, so it is rejected for that reason before adjacency
  // or dice count are ever considered.
  assert.equal(canAttack(b, adj, 0, 2, 'p1').error, ERR.OWN_TERRITORY);
});

test('canAttack treats a non-neighbour as NOT_ADJACENT', () => {
  // 0 and 2 are both p1's; 1 sits between them owned by p2. Give 0 enough dice
  // and check the adjacency test fires rather than something else.
  const b = board(['p1', 'p2', 'p2'], [3, 1, 1]);
  const adj = [[1], [0, 2], [1]];
  assert.equal(canAttack(b, adj, 0, 2, 'p1').error, ERR.NOT_ADJACENT);

  // Same shape but as a raw index check: 0 vs 1 IS adjacent, so this is legal.
  assert.equal(canAttack(b, adj, 0, 1, 'p1'), true);
});

test('canAttack rejects a 1-die attacker', () => {
  const b = board(['p1', 'p2'], [1, 1]);
  assert.equal(canAttack(b, [[1], [0]], 0, 1, 'p1').error, ERR.TOO_FEW_DICE);
});

test('canAttack reports the most specific error, in the documented order', () => {
  // A 1-die territory that is ALSO not adjacent: the adjacency problem is the
  // one worth telling the player about, so NOT_ADJACENT must win over
  // TOO_FEW_DICE. This pins the check order, not just the individual checks.
  const b = board(['p1', 'p2', 'p2'], [1, 1, 1]);
  const adj = [[1], [0, 2], [1]];
  assert.equal(canAttack(b, adj, 0, 2, 'p1').error, ERR.NOT_ADJACENT);

  // Not-owned also outranks both.
  assert.equal(canAttack(b, adj, 0, 2, 'p2').error, ERR.NOT_OWNER);
});

test('canAttack refuses a void, which is otherwise a free capture', () => {
  // The bug this exists for: `null !== 'p1'` is true for every ownership test,
  // so before the NOT_PLAYABLE guard an unowned territory sailed through every
  // remaining check. `resolveAttack` would then roll zero dice for the defender,
  // whose sum is 0 — and any attacker sum beats that. Clicking water won the
  // game, one guaranteed capture at a time.
  const b = board(['p1', null], [8, 0]);
  assert.equal(canAttack(b, [[1], [0]], 0, 1, 'p1').error, ERR.NOT_PLAYABLE);
});

test('canAttack reports a void ahead of adjacency and dice count', () => {
  // A void that is ALSO not adjacent, attacked from a 1-die stack: every other
  // check would also fire. "That space is impassable" is the one that explains
  // what the player is looking at, so it wins.
  const b = board(['p1', 'p2', null], [1, 1, 0]);
  const adj = [[1], [0, 2], [1]];
  assert.equal(canAttack(b, adj, 0, 2, 'p1').error, ERR.NOT_PLAYABLE);

  // And it still loses to NOT_OWNER, which is about a different territory.
  assert.equal(canAttack(b, adj, 1, 2, 'p1').error, ERR.NOT_OWNER);
});

test('canAttack never lets a void be the attacker either', () => {
  const b = board([null, 'p2'], [0, 1]);
  assert.equal(canAttack(b, [[1], [0]], 0, 1, 'p1').error, ERR.NOT_OWNER);
  assert.equal(canAttack(b, [[1], [0]], 0, 1, 'p2').error, ERR.NOT_OWNER);
});

/* ── voids as barriers ─────────────────────────────────────────────────────── */

test('largestGroup treats a void as a wall, not as a gap to step over', () => {
  // p1 owns both ends of a line with water between them. They are two separate
  // blobs of one, so reinforcement pays 1 — the strategic point of a void.
  const b = board(['p1', null, 'p1'], [3, 0, 3]);
  const adj = [[1], [0, 2], [1]];
  assert.equal(largestGroup(b, adj, 'p1'), 1);
});

test('largestGroup routes around a void when a land path exists', () => {
  // A 2x2 block with the top-right cell flooded: the other three still connect
  // the long way round.
  const b = board(['p1', 'p1', 'p1', null], [3, 3, 3, 0]);
  const adj = [[1, 2], [0, 3], [0, 3], [1, 2]];
  assert.equal(largestGroup(b, adj, 'p1'), 3);
});

/* ── resolveAttack ─────────────────────────────────────────────────────────── */

test('resolveAttack rolls every die on both sides, attacker first', () => {
  const rng = rngFrom([6, 2, 5, 1, 3, 4]);
  const r = resolveAttack(rng, 3, 3);

  assert.deepEqual(r.attackerRolls, [6, 2, 5]);
  assert.deepEqual(r.defenderRolls, [1, 3, 4]);
  assert.equal(r.attackerSum, 13);
  assert.equal(r.defenderSum, 8);
  assert.equal(r.captured, true);
  assert.equal(rng.remaining(), 0); // exactly N + M dice, no more
});

test('resolveAttack captures on a strictly greater sum', () => {
  const r = resolveAttack(rngFrom([4, 4, 1]), 2, 1);
  assert.equal(r.attackerSum, 8);
  assert.equal(r.defenderSum, 1);
  assert.equal(r.captured, true);
});

test('resolveAttack repels a tie — ties go to the defender', () => {
  const r = resolveAttack(rngFrom([3, 3, 6]), 2, 1);
  assert.equal(r.attackerSum, 6);
  assert.equal(r.defenderSum, 6);
  assert.equal(r.captured, false);
});

test('resolveAttack repels when the defender is ahead', () => {
  const r = resolveAttack(rngFrom([1, 1, 6, 6]), 2, 2);
  assert.equal(r.attackerSum, 2);
  assert.equal(r.defenderSum, 12);
  assert.equal(r.captured, false);
});

test('resolveAttack never rolls more dice than the stack size', () => {
  // The stub throws if over-consumed, so a 1v1 that tried to roll 2v1 would
  // fail here rather than silently produce a different distribution.
  assert.doesNotThrow(() => resolveAttack(rngFrom([1, 1]), 1, 1));
  assert.throws(() => resolveAttack(rngFrom([1]), 1, 1), /more times than/);
});

/* ── applyAttack ───────────────────────────────────────────────────────────── */

test('applyAttack on capture moves N-1 forward and leaves 1 behind', () => {
  const b = board(['p1', 'p2'], [5, 3]);
  applyAttack(b, 0, 1, true);

  assert.equal(b.owner[1], 'p1', 'ownership flips');
  assert.equal(b.dice[0], 1, 'origin keeps exactly one die');
  assert.equal(b.dice[1], 4, 'the rest move in');
  assert.deepEqual(b.dice, [1, 4]);
});

test('applyAttack on capture destroys the defender stack — dice are NOT conserved', () => {
  const b = board(['p1', 'p2'], [5, 3]);
  const before = b.dice[0] + b.dice[1];
  applyAttack(b, 0, 1, true);
  const after = b.dice[0] + b.dice[1];

  // 5 + 3 = 8 becomes 1 + 4 = 5. The defender's 3 dice are gone for good.
  assert.equal(before, 8);
  assert.equal(after, 5);
  assert.ok(after < before);
});

test('applyAttack on repel collapses the attacker and spares the defender', () => {
  const b = board(['p1', 'p2'], [7, 2]);
  applyAttack(b, 0, 1, false);

  assert.equal(b.dice[0], 1, 'the attacking stack collapses to 1');
  assert.equal(b.dice[1], 2, 'the defender is untouched');
  assert.equal(b.owner[1], 'p2', 'ownership does not change');
});

test('applyAttack never leaves a territory empty or over the cap', () => {
  // A 2-die territory attacking is the edge case worth pinning: N-1 is 1, which
  // is the minimum, and it must not reach 0.
  const tiny = board(['p1', 'p2'], [2, 1]);
  applyAttack(tiny, 0, 1, true);
  assert.deepEqual(tiny.dice, [1, 1]);

  // At the cap the moved stack is 7, still legal.
  const big = board(['p1', 'p2'], [MAX_DICE, 1]);
  applyAttack(big, 0, 1, true);
  assert.deepEqual(big.dice, [1, MAX_DICE - 1]);
});

test('dice bounds hold across thousands of real attacks', () => {
  // Soak: drive the real rules with the real PRNG over a gridded board and
  // assert the invariants that must hold after every single attack. This is
  // where an off-by-one in applyAttack would actually surface.
  //
  // The board is rebuilt every epoch, and that is load-bearing. Left alone, a
  // run converges: captures cascade until one player owns every cell, at which
  // point no attack is legal ever again and the remaining rounds assert
  // nothing. (Measured: 72 attacks, then 19,928 consecutive `own_territory`
  // rejections.) Resetting keeps real attacks and real captures flowing.
  const rng = makeRng(12345);
  const owners = ['p1', 'p2', 'p3'];

  const freshBoard = () =>
    board(
      GRID.map(() => owners[rng.int(owners.length)]),
      GRID.map(() => 2 + rng.int(MAX_DICE - 1)),
    );

  let attacks = 0;
  let captures = 0;

  for (let epoch = 0; epoch < 120; epoch++) {
    const b = freshBoard();

    for (let round = 0; round < 200; round++) {
      const from = rng.int(GRID.length);
      const to = GRID[from][rng.int(GRID[from].length)];
      const me = b.owner[from];

      const legal = canAttack(b, GRID, from, to, me);
      if (legal !== true) continue;

      const r = resolveAttack(rng, b.dice[from], b.dice[to]);
      applyAttack(b, from, to, r.captured);
      attacks++;
      if (r.captured) captures++;

      // Assert against the state the attack actually produced, before topping up.
      for (const v of b.dice) assert.ok(v >= 1 && v <= MAX_DICE, `dice out of bounds: ${v}`);
      for (const o of b.owner) assert.ok(owners.includes(o), `bad owner: ${o}`);

      // A repelled attack collapses the attacker to 1 die, so without a top-up
      // the board drains and later rounds find nothing legal to do.
      b.dice[from] = 2 + rng.int(MAX_DICE - 1);
      b.dice[to] = 2 + rng.int(MAX_DICE - 1);
    }
  }

  assert.ok(attacks > 5000, `soak should have produced many attacks, got ${attacks}`);
  assert.ok(captures > 1000, `soak should have produced many captures, got ${captures}`);
});

/* ── largestGroup ──────────────────────────────────────────────────────────── */

test('largestGroup measures the biggest connected blob, not the territory total', () => {
  const adj = [[1], [0, 2], [1, 3], [2]]; // a line 0-1-2-3

  assert.equal(largestGroup(board(['p1', 'p1', 'p1', 'p1'], [1, 1, 1, 1]), adj, 'p1'), 4);
  // 0 and 3 are p1's but disconnected from each other → two blobs of 1.
  assert.equal(largestGroup(board(['p1', 'p2', 'p2', 'p1'], [1, 1, 1, 1]), adj, 'p1'), 1);
  // The middle pair is the larger blob.
  assert.equal(largestGroup(board(['p2', 'p1', 'p1', 'p2'], [1, 1, 1, 1]), adj, 'p1'), 2);
});

test('largestGroup returns 0 when the player owns nothing', () => {
  const adj = [[1], [0, 2], [1]];
  assert.equal(largestGroup(board(['p2', 'p2', 'p2'], [1, 1, 1]), adj, 'p1'), 0);
});

test('largestGroup handles a ring without double-counting', () => {
  const ring = [[1, 2], [0, 2], [0, 1]]; // triangle — every cell closes a cycle
  assert.equal(largestGroup(board(['p1', 'p1', 'p1'], [1, 1, 1]), ring, 'p1'), 3);
});

test('largestGroup copes with a large blob without recursing', () => {
  // A 200-cell path would blow the stack under naive recursion; the flood fill
  // is iterative on purpose, so this should just be slow-ish and correct.
  const n = 200;
  const adj = Array.from({ length: n }, (_, i) => {
    const nb = [];
    if (i > 0) nb.push(i - 1);
    if (i < n - 1) nb.push(i + 1);
    return nb;
  });
  const b = board(new Array(n).fill('p1'), new Array(n).fill(1));
  assert.equal(largestGroup(b, adj, 'p1'), n);
});

test('largestGroup spans a grid in both directions', () => {
  const b = board(new Array(9).fill('p1'), new Array(9).fill(1));
  assert.equal(largestGroup(b, GRID, 'p1'), 9);

  // Carve out the centre and the blob must route around it.
  b.owner[4] = 'p2';
  assert.equal(largestGroup(b, GRID, 'p1'), 8);
});

/* ── distributeDice ────────────────────────────────────────────────────────── */

test('distributeDice places the whole stock when there is room', () => {
  const b = board(['p1', 'p1'], [1, 1]);
  const out = distributeDice(b, [[1], [0]], 'p1', 4);

  assert.equal(out.placed, 4);
  assert.equal(out.left, 0);
  assert.equal(b.dice[0] + b.dice[1], 6);
});

test('distributeDice never exceeds MAX_DICE and returns the remainder', () => {
  const b = board(['p1'], [MAX_DICE - 1]);
  const out = distributeDice(b, [[]], 'p1', 5);

  assert.equal(b.dice[0], MAX_DICE);
  assert.equal(out.placed, 1, 'only one die fits');
  assert.equal(out.left, 4, 'the rest is carried over');
});

test('distributeDice terminates with the full stock left when everything is full', () => {
  const b = board(['p1', 'p1'], [MAX_DICE, MAX_DICE]);
  const out = distributeDice(b, [[1], [0]], 'p1', 9);

  assert.equal(out.placed, 0);
  assert.equal(out.left, 9, 'nothing could be placed, so nothing is consumed');
  assert.deepEqual(b.dice, [MAX_DICE, MAX_DICE]);
});

test('distributeDice only touches the given player and records where it went', () => {
  const b = board(['p1', 'p2', 'p1'], [1, 1, 1]);
  const out = distributeDice(b, [[1], [0, 2], [1]], 'p1', 5);

  assert.equal(b.dice[1], 1, "the opponent's territory is untouched");
  assert.ok(out.territories.every((t) => t !== 1), 'and never reported as a target');
  assert.equal(out.territories.length, 5, 'one entry per die actually placed');
});

test('distributeDice stops offering a territory once it fills', () => {
  // Two territories whose combined headroom is exactly the stock: 7 has room
  // for 1, 1 has room for 7, and the stock is 8. Both must end at the cap —
  // which is only true if filling a territory moves the rest of the dice along
  // rather than stopping there.
  const b = board(['p1', 'p1'], [MAX_DICE - 1, 1]);
  const out = distributeDice(b, [[1], [0]], 'p1', 8);

  assert.deepEqual(b.dice, [MAX_DICE, MAX_DICE]);
  assert.equal(out.placed, 8);
  assert.equal(out.left, 0);
});

test('distributeDice never drops a die onto a void', () => {
  // Voids are `owner: null` in the same array as real territories, so a filter
  // that only tested "has room" would happily stack dice on water.
  const b = board(['p1', null, 'p1'], [MAX_DICE, 0, MAX_DICE]);
  const out = distributeDice(b, [[1], [0, 2], [1]], 'p1', 4);

  assert.equal(out.placed, 0, 'both owned territories are full, and the void is not eligible');
  assert.equal(out.left, 4);
  assert.deepEqual(b.dice, [MAX_DICE, 0, MAX_DICE], 'the void is untouched');
});

test('distributeDice tops two provinces up to parity rather than piling onto one', () => {
  // The worked example this rule was written from. A holds 5 against neighbours
  // of 6 and 5, so it is one short. B holds 4 against 3 and 5, also one short.
  //
  // Both are equally far behind, so the tie goes to whichever faces the bigger
  // stack — A, against the 6. That takes A to 6 and a gap of 0, and the second
  // die then goes to B. One each, which a rule that summed the neighbours could
  // never produce: it would score A at 11 against B's 8 and spend both dice on A.
  const b = board(['p1', 'p2', 'p2', 'p1', 'p2', 'p2'], [5, 6, 5, 4, 3, 5]);
  const adjacency = [
    [1, 2],
    [0],
    [0],
    [4, 5],
    [3],
    [3],
  ];
  const out = distributeDice(b, adjacency, 'p1', 2);

  assert.deepEqual([b.dice[0], b.dice[3]], [6, 5], 'each province reaches parity with its strongest neighbour');
  assert.deepEqual(out.territories, [0, 3], 'the bigger stack is faced first, then the other');
  assert.equal(out.left, 0);
});

test('distributeDice skips a province already at parity for one that is behind', () => {
  // The parity rule is what stops the pile-up, so it has to be checked on its
  // own rather than inferred from a case that also differs by stack size.
  // Territory 0 faces 6 and holds 6 — safe. Territory 2 faces 5 and holds 1 — in
  // trouble. Territory 1 is interior. Both dice belong to 2.
  const b = board(['p1', 'p1', 'p1', 'p2', 'p2'], [6, 1, 1, 6, 5]);
  const adjacency = [
    [1, 3],
    [0, 2],
    [1, 4],
    [0],
    [2],
  ];
  const out = distributeDice(b, adjacency, 'p1', 2);

  assert.equal(b.dice[0], 6, 'the province already level with its neighbour gets nothing');
  assert.equal(b.dice[2], 3, 'both dice go to the one that is behind');
  assert.deepEqual(out.territories, [2, 2]);
});

test('distributeDice rolls the remainder on rather than swallowing a reserve', () => {
  // A reserve larger than the frontier can hold must still land somewhere. The
  // most-threatened province takes a share and the rest goes to the next one
  // down, instead of being silently dropped on a board that has room.
  const b = board(['p1', 'p1', 'p2', 'p2'], [1, 1, 1, 4]);
  const adjacency = [
    [1, 2],
    [0, 3],
    [0],
    [1],
  ];
  // Territory 1 faces 4 dice, territory 0 faces 1. Stock 10: 3 take territory 1
  // to parity, and the 7 spare dice alternate between the two — territory 1
  // absorbing four more up to the cap while 0 takes three.
  const out = distributeDice(b, adjacency, 'p1', 10);

  assert.equal(b.dice[1], MAX_DICE, 'the most-threatened province fills to the cap');
  assert.equal(b.dice[0], 4, 'and the rest rolls down to the next one');
  assert.equal(out.placed, 10);
  assert.equal(out.left, 0);
});

test('distributeDice gives a surplus to the lowest id when the gaps tie', () => {
  // Both provinces face the same 2-die stack and hold 1, so both are one short
  // and nothing separates them but their id. The first two dice go one each —
  // that is the parity rule doing its job — and only the third, which is pure
  // surplus, is decided by id.
  //
  // A rule that filled its top-ranked province to the cap before moving on would
  // answer [0, 0, 0] here, which is exactly the pile-up this replaced.
  const b = board(['p1', 'p1', 'p2', 'p2'], [1, 1, 2, 2]);
  const adjacency = [
    [1, 2],
    [0, 3],
    [0],
    [1],
  ];
  const out = distributeDice(b, adjacency, 'p1', 3);

  assert.deepEqual(out.territories, [0, 1, 0], 'both reach parity before either gets a surplus');
  assert.deepEqual([b.dice[0], b.dice[1]], [3, 2]);
});

test('distributeDice spreads the surplus one each, starting at the frontier', () => {
  // Once every province is level with its strongest neighbour nothing is left to
  // defend, so the remaining dice are shared out rather than stacked. The order
  // is by how strong the enemy next door is: the province facing six takes the
  // first spare, and then the dice move on instead of filling it to the cap.
  const b = board(['p1', 'p1', 'p1', 'p2', 'p2'], [1, 1, 1, 1, 6]);
  const adjacency = [
    [1, 3],
    [0, 2],
    [1, 4],
    [0],
    [2],
  ];
  // Five dice take territory 2 to parity with the 6 beside it. The last two are
  // spare, so they go to 2 (facing 6) and then to 0 (facing 1).
  const out = distributeDice(b, adjacency, 'p1', 7);

  assert.deepEqual(out.territories, [2, 2, 2, 2, 2, 2, 0], 'five to reach parity, then one each');
  assert.equal(b.dice[2], 7, 'the province facing six takes the first spare');
  assert.equal(b.dice[0], 2, 'the next die goes beside it rather than stacking on it');
  assert.equal(b.dice[1], 1, 'and the interior, which faces nobody, waits its turn');
  assert.equal(out.left, 0);
});

test('distributeDice spends nine dice the way the worked example asks', () => {
  // The example this rule was written from, in full. Five provinces, each with a
  // different shortfall, and nine dice to place:
  //
  //   a) 4 against (5, 6) — two short, because 6 is the strongest neighbour
  //   b) 4 against (2, 7) — three short
  //   c) 1 with no enemy neighbours — level, it can never be short
  //   d) 2 against (1, 2) — already level
  //   e) 1 against (1, 1) — already level
  //
  // Shortfalls first, largest first: b b a b a, which leaves a and b both level.
  // The remaining four are then spare, and go one each by how strong the enemy
  // next door is — b (7), a (6), d (2), e (1) — with c waiting behind them all
  // since it faces nobody. b reaches the cap on the first spare and drops out.
  const b = board(
    ['p1', 'p1', 'p1', 'p1', 'p1', 'p2', 'p2', 'p2', 'p2', 'p2', 'p2', 'p2', 'p2'],
    [4, 4, 1, 2, 1, 5, 6, 2, 7, 1, 2, 1, 1],
  );
  const adjacency = [
    [1, 2, 3, 5, 6], // a: the 5 and the 6 are its enemies, so it is two short
    [0, 2, 3, 4, 7, 8], // b: the 2 and the 7 — three short
    [0, 1, 3, 4], // c: every neighbour is ours, so it faces nobody
    [0, 1, 2, 4, 9, 10], // d: the 1 and the 2 — already level
    [1, 2, 3, 11, 12], // e: the 1 and the 1 — already level
    [0], // the 5
    [0], // the 6
    [1], // the 2
    [1], // the 7
    [3], // the 1
    [3], // the 2
    [4], // the 1
    [4], // the 1
  ];
  const out = distributeDice(b, adjacency, 'p1', 9);

  assert.deepEqual(
    out.territories,
    [1, 1, 0, 1, 0, 1, 0, 3, 4],
    'shortfalls first, then one spare each by threat: b b a b a, b a d e',
  );
  assert.deepEqual(
    [b.dice[0], b.dice[1], b.dice[2], b.dice[3], b.dice[4]],
    [7, 8, 1, 3, 2],
    'a and b reach parity and one spare; d and e take their first spare; c waits',
  );
  assert.equal(out.left, 0);
});

test('distributeDice still spreads when there is no threat to rank', () => {
  // Two provinces in a row with no enemy contact at all: every strongest
  // neighbour is 0, so nothing is behind and the whole stock counts as surplus.
  // The spread still happens — lowest id first, one each — rather than the dice
  // being stranded for want of a ranking, or piled onto the first province.
  const b = board(['p1', 'p1'], [1, 1]);
  const out = distributeDice(b, [[1], [0]], 'p1', 3);

  assert.deepEqual(out.territories, [0, 1, 0], 'one each before either gets a second');
  assert.deepEqual([b.dice[0], b.dice[1]], [3, 2]);
});

test('distributeDice defends against a player before it builds against a neutral', () => {
  // Territory 0 sits beside a neutral 8 and territory 1 beside a player's 3.
  // Only one of those two numbers can ever roll against us, so while territory 1
  // is short the one die goes there. Counting the neutral as a threat in this
  // phase would make territory 0 the deeper hole (gap 6 against gap 1) and drain
  // the die into a wall that never moves.
  //
  // The neutral does become the measure once nothing real is open — the next test
  // is that half — but never while a player's stack is short.
  const b = board(['p1', 'p1', 'p2', NEUTRAL], [2, 2, 3, 8]);
  const adjacency = [
    [1, 3], // 0: the neutral 8, which is not a front
    [0, 2], // 1: the 3, which is
    [1],
    [0],
  ];
  const out = distributeDice(b, adjacency, 'p1', 1);

  assert.deepEqual(out.territories, [1], 'the shortfall against a real player takes the die');
  assert.deepEqual([b.dice[0], b.dice[1]], [2, 3], 'the neutral border is left where it was');
});

test('distributeDice sends the surplus to a neutral border first', () => {
  // The other half of the rule: a neutral is not a threat while there is
  // defending to do, but once the dice are being shared out it becomes the
  // reason to build a province up — that border is where the next conquest is.
  //
  // Territory 0 faces only territory 1, which is ours; territory 1 faces the
  // neutral 6 as well. Neither is behind, so this is the surplus phase, and the
  // spare goes to the neutral border. Territory 0 has the LOWER id, so nothing
  // but the neutral is steering this: by the plain id tie-break it would win.
  const b = board(['p1', 'p1', NEUTRAL], [1, 1, 6]);
  const out = distributeDice(b, [[1], [0, 2], [1]], 'p1', 1);

  assert.deepEqual(out.territories, [1], 'the neutral border takes the spare, not the lower id');
  assert.deepEqual([b.dice[0], b.dice[1]], [1, 2], 'the province facing the neutral 6 is built up');
});

test('distributeDice treats a neutral as a threat once it starts spreading', () => {
  // The rule this test exists for, stated as a board that separates it from the
  // old behaviour on every axis at once. Two neutral borders of different heights
  // (8 beside province 3, 5 beside province 0) and two interior provinces (1 and
  // 2) that face nothing but our own land.
  //
  // Once the spread starts the neutrals ARE the threat, so the dice are spent
  // reaching parity with them exactly as they would be against a player: province
  // 3 takes four dice toward its 8, province 0 takes one toward its 5, and the
  // two interior provinces get nothing at all. Nobody is shared with until every
  // neutral border is level.
  //
  // This is what the previous rule could not express. It ranked a neutral border
  // only as a tie-break inside a round-robin, so the same board came out
  // `[3, 0, 1, 2, 3, 0]` for dice of `[3, 2, 2, 3]` — the province beside the
  // neutral 8 ending up merely equal to one beside no neutral at all.
  const b = board(
    ['p1', 'p1', 'p1', 'p1', NEUTRAL, NEUTRAL],
    [1, 1, 1, 1, 8, 5],
  );
  const adjacency = [
    [1, 5], // 0: our own 1, and a neutral 5
    [2], //    1: interior
    [3], //    2: interior
    [2, 4], // 3: our own 3, and a neutral 8 — the tallest border on the board
    [3],
    [0],
  ];
  const out = distributeDice(b, adjacency, 'p1', 6);

  assert.deepEqual(out.territories, [3, 3, 3, 3, 0, 3], 'the taller neutral border is filled first');
  assert.deepEqual(
    [b.dice[0], b.dice[1], b.dice[2], b.dice[3]],
    [2, 1, 1, 6],
    'both neutral borders take dice, the interior gets none',
  );
  assert.equal(out.left, 0);
});

test('distributeDice closes every shortfall before it starts spreading', () => {
  // The boundary between the two phases, in one board. Territory 0 is three dice
  // short of the player's 4 on its border; territory 1 faces a neutral 8 and so
  // is not short of anything, but it is the widest border on the board.
  //
  // While any shortfall is open the neutral buys territory 1 nothing: the first
  // three dice all close the gap against the real attacker. Only the fourth,
  // with nothing left to defend, goes next door to the neutral border.
  const adjacency = [[2], [3], [0], [1]];
  const build = () => board(['p1', 'p1', 'p2', NEUTRAL], [1, 2, 4, 8]);

  const short = build();
  const outShort = distributeDice(short, adjacency, 'p1', 2);
  assert.deepEqual(outShort.territories, [0, 0], 'the open shortfall takes both dice');
  assert.deepEqual([short.dice[0], short.dice[1]], [3, 2], 'the neutral border is passed over');

  const full = build();
  const outFull = distributeDice(full, adjacency, 'p1', 4);
  assert.deepEqual(
    outFull.territories,
    [0, 0, 0, 1],
    'three dice reach parity, and only the fourth is spare',
  );
  assert.deepEqual([full.dice[0], full.dice[1]], [4, 3], 'then the neutral border gets its first');
});

/* ── allies ────────────────────────────────────────────────────────────────── */

test('distributeDice does not count an ally as a threat', () => {
  // Territory 1 is three dice short of the p2 4 next door: without a pact that is
  // a tier 0 shortfall and every die goes there, which is what `alone` pins. With
  // the pact it is not a shortfall at all — an ally is not something that will
  // roll against us — so nothing is behind and the dice fall through to the
  // surplus pass instead.
  //
  // The surplus still places them, one each from the lowest id. That is the half
  // of this rule that is easy to get wrong: excluding an ally removes the
  // *attraction*, not the eligibility. A province facing only allies is still
  // somewhere a die can go, because the die has to go somewhere.
  const b = board(['p1', 'p1', 'p2'], [1, 1, 4]);
  const adjacency = [[1], [0, 2], [1]];

  const alone = distributeDice(board(['p1', 'p1', 'p2'], [1, 1, 4]), adjacency, 'p1', 3);
  assert.deepEqual(alone.territories, [1, 1, 1], 'no pact: all three dice pile onto the short border');

  const allied = distributeDice(b, adjacency, 'p1', 3, new Set(['p2']));
  assert.deepEqual(allied.territories, [0, 1, 0], 'with the pact they spread as surplus instead');
  assert.deepEqual([b.dice[0], b.dice[1]], [3, 2], 'and the ally border is not the one being matched');
  assert.equal(allied.left, 0);
});

test('distributeDice does not build up against an ally either', () => {
  // `widest` is skipped for allies as well as `enemy`, and this board separates
  // that from the defence rule above by making the ally's stack *shorter* than
  // ours, so it can only ever reach the ranking through `widest`.
  //
  // Both provinces are level with everything they face, so both are tier 2 and
  // the tie falls through to `widest` before it reaches the id. Province 1, which
  // has the higher id, is the one beside the ally 3 — so with the ally counting it
  // takes the die, and without it the plain id tie-break hands the die to
  // province 0. The two halves of the assertion differ only by the ally set.
  const adjacency = [[1], [0, 2], [1]];

  const alone = distributeDice(board(['p1', 'p1', 'p2'], [5, 5, 3]), adjacency, 'p1', 1);
  assert.deepEqual(alone.territories, [1], 'a real neighbour is still something to match');
  assert.deepEqual(alone.territories, [1], 'and it wins on its height, over the lower id');

  const allied = distributeDice(board(['p1', 'p1', 'p2'], [5, 5, 3]), adjacency, 'p1', 1, new Set(['p2']));
  assert.deepEqual(allied.territories, [0], 'the ally is not, so the id tie-break decides');
});

test('distributeDice places identically for null allies and an empty set', () => {
  // The default is what lets every call site that predates alliances keep
  // working, so it has to mean exactly "no allies" rather than merely something
  // falsy that happens to survive the optional chain today.
  const adjacency = [[1, 3], [0, 2], [1], [0]];
  const run = (allies) => {
    const b = board(['p1', 'p1', 'p2', NEUTRAL], [2, 2, 3, 8]);
    const out = distributeDice(b, adjacency, 'p1', 4, allies);
    return { dice: [...b.dice], territories: out.territories, left: out.left };
  };

  assert.deepEqual(run(null), run(new Set()));
});

test('distributeDice is unchanged for a border that faces no ally', () => {
  // The guard on the other side: passing an ally set must not disturb a province
  // whose neighbours are not in it. p3 is allied and adjacent to nothing here, so
  // every number must come out exactly as it does without the set.
  const adjacency = [
    [1, 3], // 0: the neutral 8, which is not a front
    [0, 2], // 1: the 3, which is
    [1],
    [0],
  ];
  const run = (allies) => {
    const b = board(['p1', 'p1', 'p2', NEUTRAL], [2, 2, 3, 8]);
    const out = distributeDice(b, adjacency, 'p1', 3, allies);
    return { dice: [...b.dice], territories: out.territories, left: out.left };
  };

  assert.deepEqual(run(new Set(['p3'])), run(null));
});

/* ── bankDice ──────────────────────────────────────────────────────────────── */

test('bankDice adds to the reserve', () => {
  const p = { stock: 0 };
  bankDice(p, 5);
  assert.equal(p.stock, 5);

  bankDice(p, 3);
  assert.equal(p.stock, 8);
});

test('bankDice does not cap the reserve', () => {
  // The reserve used to be clamped at STOCK_MAX = 64 and everything above the
  // line was silently thrown away — reinforcement you had earned, destroyed
  // because you happened to be holding a lot of it. There is no cap now.
  const p = { stock: 62 };
  bankDice(p, 10);
  assert.equal(p.stock, 72, 'the whole gain is kept past the old limit');

  bankDice(p, 1000);
  assert.equal(p.stock, 1072);
});

test('bankDice treats a missing stock as zero', () => {
  const p = {};
  bankDice(p, 3);
  assert.equal(p.stock, 3);
});

/* ── nextTurnIndex ─────────────────────────────────────────────────────────── */

const players = (...ids) => ids.map((id) => ({ id, eliminated: false }));
const eliminated = (...ids) => ids.map((id) => ({ id, eliminated: true }));

test('nextTurnIndex advances by one', () => {
  assert.equal(nextTurnIndex(players('a', 'b', 'c'), 0), 1);
  assert.equal(nextTurnIndex(players('a', 'b', 'c'), 1), 2);
});

test('nextTurnIndex wraps around the end of the roster', () => {
  assert.equal(nextTurnIndex(players('a', 'b', 'c'), 2), 0);
});

test('nextTurnIndex skips eliminated seats', () => {
  const roster = [...players('a'), ...eliminated('b'), ...players('c')];
  assert.equal(nextTurnIndex(roster, 0), 2, 'a skips the dead b');
  assert.equal(nextTurnIndex(roster, 2), 0, 'c wraps past the dead b');
});

test('nextTurnIndex skips a run of eliminated seats', () => {
  const roster = [...players('a'), ...eliminated('b', 'c', 'd'), ...players('e')];
  assert.equal(nextTurnIndex(roster, 0), 4);
});

test('nextTurnIndex returns the origin when nobody is alive', () => {
  const roster = eliminated('a', 'b', 'c');
  assert.equal(nextTurnIndex(roster, 1), 1);
});

test('nextTurnIndex on a solo survivor returns that survivor', () => {
  const roster = [...players('a'), ...eliminated('b')];
  assert.equal(nextTurnIndex(roster, 1), 0);
});

/* ── checkWin / refreshEliminated ──────────────────────────────────────────── */

test('checkWin reports the last player standing', () => {
  assert.equal(checkWin(players('a')), 'a');
  assert.equal(checkWin(players('a', 'b')), null);
  assert.equal(checkWin([...players('a'), ...eliminated('b')]), 'a');
});

test('checkWin returns null when nobody is alive', () => {
  assert.equal(checkWin(eliminated('a', 'b')), null);
  assert.equal(checkWin([]), null);
});

test('refreshEliminated derives the flags from the board', () => {
  const b = board(['p1', 'p1', 'p3'], [1, 1, 1]);
  const roster = players('p1', 'p2', 'p3');
  const counts = refreshEliminated(b, roster);

  assert.equal(roster[0].eliminated, false);
  assert.equal(roster[1].eliminated, true, 'p2 owns nothing');
  assert.equal(roster[2].eliminated, false);
  assert.equal(counts.get('p2'), 0);
});

test('refreshEliminated ignores owners who are no longer playing', () => {
  // A territory left behind by a departed seat must not resurrect that player
  // or crash the count.
  const b = board(['p1', 'ghost'], [1, 1]);
  const roster = players('p1');
  const counts = refreshEliminated(b, roster);

  assert.equal(counts.has('ghost'), false);
  assert.equal(roster[0].eliminated, false);
});

test('refreshEliminated ignores voids', () => {
  // `null` must not enter the counts map and must not be mistaken for a player
  // who owns nothing. A player holding only a void is genuinely eliminated.
  const b = board(['p1', null, null], [1, 0, 0]);
  const roster = players('p1', 'p2');
  const counts = refreshEliminated(b, roster);

  assert.equal(counts.has(null), false);
  assert.equal(counts.get('p1'), 1);
  assert.deepEqual(
    roster.map((p) => p.eliminated),
    [false, true],
    'p2 owns nothing but water and is out',
  );
});

/* ── winChance: the closed form behind resolveAttack ───────────────────────── */

test('diceSumDistribution is a probability distribution of the right width', () => {
  assert.equal(diceSumDistribution(1).length, 7, '6 sides need 7 slots, 0..6');
  assert.equal(diceSumDistribution(3).length, 19);

  for (const n of [1, 2, 3, 8]) {
    const d = diceSumDistribution(n);
    let total = 0;
    for (const p of d) total += p;
    assert.ok(Math.abs(total - 1) < 1e-12, `${n} dice: probabilities sum to ${total}`);

    // Every face is 1..6, so no total below n or above 6n is reachable.
    for (let k = 0; k < n; k++) assert.equal(d[k], 0, `${n} dice cannot total ${k}`);

    // All sixes is the only way to 6n. Compared with a tolerance because the
    // convolution divides by 6 n times while Math.pow does it in one step, and
    // the two disagree in the last bit.
    assert.ok(
      Math.abs(d[6 * n] - Math.pow(1 / 6, n)) < 1e-15,
      `${n} dice: P(all sixes) is ${d[6 * n]}, expected ${Math.pow(1 / 6, n)}`,
    );
  }
});

test('winChance matches the textbook values', () => {
  assert.equal(Math.round(winChance(1, 1) * 36), 15, '1v1 is 15/36');
  assert.equal(Math.round(winChance(2, 1) * 216), 181, '2v1 is 181/216');
  assert.ok(Math.abs(winChance(3, 3) - 0.4536) < 0.0005, '3v3 is about 0.4536');
});

test('winChance obeys the equal-stack symmetry identity', () => {
  // With equal stacks the attacker and defender are interchangeable, so the
  // outcomes partition into win, lose and tie with win === lose. Checking that
  // against independently computed loss and tie probabilities validates the
  // convolution itself, rather than trusting one hardcoded figure.
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const d = diceSumDistribution(n);
    const win = winChance(n, n);

    let loss = 0;
    let tie = 0;
    for (let i = 0; i < d.length; i++) {
      for (let j = 0; j < d.length; j++) {
        if (j < i) continue; // already counted as a win
        if (j === i) tie += d[i] * d[j];
        else loss += d[i] * d[j];
      }
    }

    assert.ok(Math.abs(win - loss) < 1e-12, `${n}v${n}: win ${win} vs loss ${loss}`);
    assert.ok(Math.abs(win + loss + tie - 1) < 1e-12, `${n}v${n}: probabilities do not sum to 1`);
  }
});

test('winChance rises with the attacker and falls with the defender', () => {
  for (let n = 1; n < 8; n++) {
    assert.ok(winChance(n + 1, 3) > winChance(n, 3), `one more die must help at ${n}v3`);
    assert.ok(winChance(3, n + 1) < winChance(3, n), `one more defender die must hurt at 3v${n}`);
  }
  // A lone defender die loses to any real stack. `n` starts at 2 because that is
  // the smallest legal attack — and 1v1 is a losing proposition at 15/36, since
  // a tie is a successful defence.
  for (let n = 2; n <= 8; n++) assert.ok(winChance(n, 1) > 0.83, `${n}v1 should be near-certain`);

  // One die each is the only even fight the attacker loses outright: a tie is a
  // successful defence, so the split is 15 wins to 21 losses.
  assert.ok(winChance(1, 1) < 0.5, 'a tie goes to the defender, so 1v1 favours the defender');
});

test('winChance is bounded to [0, 1] over every reachable stack size', () => {
  for (let n = 1; n <= MAX_DICE; n++) {
    for (let m = 1; m <= MAX_DICE; m++) {
      const p = winChance(n, m);
      assert.ok(p >= 0 && p <= 1, `winChance(${n}, ${m}) = ${p} is outside [0, 1]`);
      // win + loss + tie === 1, computed through the same distribution.
      const tie = diceSumDistribution(n).reduce(
        (acc, pa, i) => acc + pa * (diceSumDistribution(m)[i] ?? 0),
        0,
      );
      assert.ok(
        Math.abs(p + winChance(m, n) + tie - 1) < 1e-12,
        `${n}v${m}: win + loss + tie does not sum to 1`,
      );
    }
  }
});

/* ── Monte Carlo: the test a stub cannot replace ───────────────────────────── */

test('resolveAttack matches the exact distribution over 100k seeded attacks', () => {
  // This is the single most valuable test here. It pins all three of the rules
  // that an off-by-one silently corrupts:
  //   - the attacker rolls its ENTIRE stack, including the die that stays home
  //   - the comparison is STRICTLY greater
  //   - a tie goes to the DEFENDER
  // Get any one wrong and the measured rate moves well outside the tolerance.
  const cases = [
    [1, 1],
    [2, 1],
    [3, 3],
    [5, 8],
    [8, 2],
  ];

  for (const [n, m] of cases) {
    const rng = makeRng(0xd1ce + n * 1000 + m);
    const trials = 100000;
    let wins = 0;

    for (let i = 0; i < trials; i++) {
      if (resolveAttack(rng, n, m).captured) wins++;
    }

    const observed = wins / trials;
    // The expected rate comes from the SHIPPED winChance, not a test-local
    // copy — so this test now pins the production convolution against the real
    // dice roller, which is the pair that actually has to agree.
    const expected = winChance(n, m);

    assert.ok(
      Math.abs(observed - expected) < 0.005,
      `${n}v${m}: observed ${observed.toFixed(4)}, expected ${expected.toFixed(4)}`,
    );
  }
});
