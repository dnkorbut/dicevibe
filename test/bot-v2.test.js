// The v2 policy, on hand-built boards and on a few hundred random ones.
//
// The interesting tests here are the property ones. A policy is a function from
// boards to moves, and the failure that matters is not "it picked the wrong
// province on this fixture" — it is "on some board it picks something illegal",
// or "on some board it picks nothing at all and the game stops". Neither shows up
// on a hand-built fixture, and both are cheap to rule out over a few hundred
// generated boards.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DICE, NEUTRAL } from '../shared/constants.js';
import { canAttack, winChance, attackRolls } from '../shared/rules.js';
import { planMove as planMoveV1 } from '../server/bot-v1.js';
import { evaluate, planMove, TUNING } from '../server/bot-v2.js';
import { makeRng } from '../server/rng.js';

const ME = 'p1';
const THEM = 'p2';

/**
 * A random, legal-ish board.
 *
 * Not a real map generator and not trying to be — it only has to be a board the
 * rules accept, so that the property tests below run over shapes nobody thought
 * to write down. Adjacency is symmetric because the real one is, and a policy
 * that assumed otherwise would be a genuinely different bug.
 */
function randomBoard(rng, n = 14) {
  const owner = new Array(n);
  const dice = new Array(n);

  for (let i = 0; i < n; i++) {
    const roll = rng.next();
    owner[i] = roll < 0.12 ? null : roll < 0.3 ? NEUTRAL : rng.next() < 0.5 ? ME : THEM;
    dice[i] = 1 + rng.int(MAX_DICE);
  }

  const adjacency = Array.from({ length: n }, () => []);
  const link = (a, b) => {
    if (a === b || adjacency[a].includes(b)) return;
    adjacency[a].push(b);
    adjacency[b].push(a);
  };

  for (let i = 0; i < n; i++) link(i, (i + 1) % n);
  for (let k = 0; k < Math.floor(n / 3); k++) link(rng.int(n), rng.int(n));

  return { board: { owner, dice }, adjacency };
}

/* ── it wins games ─────────────────────────────────────────────────────────── */

test('v2 takes a province it is almost certain to take', () => {
  // Five dice thrown against one is the nearest thing this game has to a sure
  // capture, and the policy should treat it as free. Not *quite* certain, which
  // is worth recording here because the fixture first claimed it was: five dice
  // sum to at least five, so they lose only to a defender who rolls exactly six.
  const board = { owner: [ME, THEM, ME], dice: [6, 1, 1] };
  const adjacency = [[1, 2], [0], [0]];

  const p = winChance(attackRolls(6), 1);
  assert.ok(p > 0.999 && p < 1, `the fixture must be near-certain, got ${p}`);

  assert.deepEqual(planMove(board, adjacency, ME, null), { from: 0, to: 1 });
});

test('v2 does not throw an army away at a one-in-a-hundred shot at winning', () => {
  // The regression this file exists for, and the shape is worth keeping.
  //
  // The opponent holds exactly one province, so capturing it ends the game. My
  // only attack is a 5-stack into its 8 — a 0.6% chance. Scoring that win at a
  // large sentinel makes it worth `p * sentinel`, which beats every honest move
  // by orders of magnitude, and the policy then spends the rest of the game
  // rebuilding stacks and losing them at the same province. It grinds instead of
  // playing, and it grinds *because* it is winning everywhere else.
  //
  // The position is otherwise comfortable, which is the whole point: a policy
  // only takes this bet if winning has been priced as a jackpot rather than as a
  // position. Both the direct evaluation and the committed move are checked,
  // because the bug was in the first and only visible in the second.
  const board = { owner: [ME, ME, ME, THEM, ME], dice: [5, 3, 3, 8, 3] };
  const adjacency = [[1, 3], [0, 2], [1, 4], [0], [2]];

  const p = winChance(attackRolls(5), 8);
  assert.ok(p > 0 && p < 0.01, `the fixture must be a long shot, got ${p}`);

  assert.equal(
    planMove(board, adjacency, ME, null),
    null,
    'the only attack is a hopeless one, so the policy must decline it',
  );
});

test('v2 still closes out a game it can only win by gambling', () => {
  // The endgame the stalemate clause exists for, and the check that fixing the
  // jackpot did not produce a policy that refuses to win.
  //
  // My 8 against their last province at 8. Both stacks are at the cap, so
  // reinforcement can never change this board: the attack is the only move that
  // does anything, and declining it forever is a game that never ends.
  //
  // It is worth being precise about *why* the policy takes it, because the reason
  // is not the one the shape suggests. At 27% the search declines it — from a
  // position this good, a coin flip that risks the army is not worth the shortcut,
  // which is the same judgement that fixed the grind. What makes the move is the
  // floor: v1 takes the stalemate attack, so v2 does too. The floor is therefore
  // load-bearing for finishing games and not merely a courtesy, which is exactly
  // what this pins.
  const board = { owner: [ME, ME, ME, THEM, ME], dice: [8, 3, 3, 8, 3] };
  const adjacency = [[1, 3], [0, 2], [1, 4], [0], [2]];

  const p = winChance(attackRolls(8), 8);
  assert.ok(p > 0.2 && p < 0.5, `the fixture must be a real but poor chance, got ${p}`);
  assert.deepEqual(planMoveV1(board, adjacency, ME, null), { from: 0, to: 3 }, 'v1 takes it');

  assert.deepEqual(planMove(board, adjacency, ME, null), { from: 0, to: 3 });
});

/* ── properties, over boards nobody wrote down ─────────────────────────────── */

test('v2 never returns an illegal move', () => {
  // The one thing a policy must never do. `stepBot` turns a refused attack into
  // an end-of-turn rather than retrying it, so an illegal move does not crash
  // anything — it silently costs the bot its turn, which is worse.
  for (let seed = 1; seed <= 150; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed));

    for (const me of [ME, THEM]) {
      const move = planMove(board, adjacency, me, null);
      if (!move) continue;

      assert.equal(
        canAttack(board, adjacency, move.from, move.to, me),
        true,
        `seed ${seed}: ${me} proposed ${move.from}->${move.to} on ${JSON.stringify(board)}`,
      );
    }
  }
});

test('v2 never attacks an ally', () => {
  // Legal in the rules and occasionally right for a human, but a bot that breaks
  // its own pact on a whim is noise — and v1 does not do it either, so the two
  // policies must agree here or a mixed table behaves inconsistently.
  for (let seed = 1; seed <= 120; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed), 10);
    const allies = new Set([THEM]);

    const move = planMove(board, adjacency, ME, allies);
    if (!move) continue;

    assert.notEqual(
      board.owner[move.to],
      THEM,
      `seed ${seed}: attacked an ally at ${move.to}`,
    );
  }
});

test('v2 makes a move whenever v1 would', () => {
  // The termination floor, stated as the property it actually is. v2 is allowed
  // to decline a move v1 would have taken — that is the point of a policy that
  // plans — but it is not allowed to be *quieter* than v1 on a board where v1
  // found something, because that is how a table of bots stops ending.
  let checked = 0;

  for (let seed = 1; seed <= 150; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed));

    for (const me of [ME, THEM]) {
      const v1Move = planMoveV1(board, adjacency, me, null);
      if (!v1Move) continue;

      checked++;
      assert.ok(
        planMove(board, adjacency, me, null),
        `seed ${seed}: v1 had ${v1Move.from}->${v1Move.to} but v2 declined`,
      );
    }
  }

  assert.ok(checked > 0, 'the fixture never gave v1 a move, so this proved nothing');
});

test('v2 is a pure function of its arguments', () => {
  // No clock, no random source, no module state that moves between calls. The
  // driver re-plans after every real attack, so an unstable policy would make the
  // same board produce different games depending on nothing at all.
  for (let seed = 1; seed <= 40; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed));
    const a = planMove(board, adjacency, ME, null);
    const b = planMove(board, adjacency, ME, null);
    assert.deepEqual(a, b, `seed ${seed} produced two different plans`);
  }
});

/* ── the position score ────────────────────────────────────────────────────── */

test('evaluate prefers more land, more dice, and safety', () => {
  const adjacency = [[1], [0, 2], [1]];

  // More land: two provinces against one, same dice.
  const wide = { owner: [ME, ME, THEM], dice: [3, 3, 4] };
  const narrow = { owner: [ME, THEM, THEM], dice: [3, 3, 4] };
  assert.ok(evaluate(wide, adjacency, ME) > evaluate(narrow, adjacency, ME));

  // More dice, same land.
  const strong = { owner: [ME, ME, THEM], dice: [6, 3, 4] };
  assert.ok(evaluate(strong, adjacency, ME) > evaluate(wide, adjacency, ME));

  // A shortfall on the border costs something. Here the enemy stack grows, which
  // makes the province it faces worse defended, and nothing else changes.
  const exposed = { owner: [ME, ME, THEM], dice: [3, 3, 8] };
  assert.ok(evaluate(exposed, adjacency, ME) < evaluate(wide, adjacency, ME));
});

test('evaluate scores a won board above any board that is not won', () => {
  // What replaced the sentinel, and the reason it still reaches for the win: the
  // terminal position is the largest score reachable, so the search still prefers
  // it. It is simply no longer priced as something worth an army.
  const adjacency = [[1], [0, 2], [1]];
  const won = { owner: [ME, ME, ME], dice: [1, 4, 1] };
  const nearly = { owner: [ME, ME, THEM], dice: [1, 8, 1] };

  assert.ok(evaluate(won, adjacency, ME) > evaluate(nearly, adjacency, ME));
  assert.ok(Number.isFinite(evaluate(won, adjacency, ME)), 'the win score must be finite');
});

test('evaluate counts an ally as friendly on the border', () => {
  // A pact is what stops a border from being a threat, and the same exclusion the
  // reinforcement rules make — see `borderStacks`.
  const adjacency = [[1], [0]];
  const board = { owner: [ME, THEM], dice: [2, 7] };

  const alone = evaluate(board, adjacency, ME, null);
  const allied = evaluate(board, adjacency, ME, new Set([THEM]));

  assert.ok(allied > alone, 'an ally at 7 dice should not read as a threat');
});

test('the tuning weights are the ones the policy reads', () => {
  // Cheap, and it pins the wiring rather than the numbers: the sweep in
  // `tools/bot-arena.js` mutates this object and re-runs games, so a weight that
  // is read once into a closure at import time would make the sweep a no-op that
  // still printed numbers.
  // Two provinces against one, so the weight does not cancel. It does cancel on an
  // even split — both sides gain the same `territories * province` and it falls
  // out of the difference — which is what the first version of this fixture did,
  // and it made the test pass for the wrong reason.
  const adjacency = [[1], [0, 2], [1]];
  const board = { owner: [ME, ME, THEM], dice: [2, 2, 7] };

  const original = TUNING.province;
  try {
    TUNING.province = original;
    const before = evaluate(board, adjacency, ME);
    TUNING.province = original * 100;
    assert.notEqual(evaluate(board, adjacency, ME), before, 'province is not being read');
  } finally {
    TUNING.province = original;
  }
});
