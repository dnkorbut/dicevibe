// The v3 policy: the refill arithmetic on fixtures whose answer is known by
// hand, and the same property sweep v2 gets.
//
// The hand-built boards carry most of the weight here, because v3's whole
// difference is one function — `refill` — and a function with an arithmetic
// answer can be checked exactly rather than probabilistically. The property
// tests at the foot are the ones that matter for safety rather than for
// correctness of the idea: whatever the score says, the policy must never
// propose an illegal move, must never attack an ally, and must never decline a
// shot without a price that says so.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DICE, NEUTRAL } from '../shared/constants.js';
import { attackRolls, canAttack, winChance } from '../shared/rules.js';
import { planMove as planMoveV1 } from '../server/bot-v1.js';
import { planMove as planMoveV2 } from '../server/bot-v2.js';
import { evaluate, moveValue, planMove, refill, TUNING } from '../server/bot-v3.js';
import { makeRng } from '../server/rng.js';

const ME = 'p1';
const THEM = 'p2';

/**
 * A random, legal-ish board — v2's generator, unchanged, so the two suites
 * sweep the same shapes and a divergence between the policies is a divergence
 * and not a difference of fixture.
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

/* ── the refill arithmetic ─────────────────────────────────────────────────── */

test('refill counts one die of income per province and one of need per gap', () => {
  // 0 holds 3 against a player's 6, and is therefore 3 short. 3 and 4 are mine and
  // buried behind each other, so nothing is behind anything.
  //
  // The neutral at 8 on 0's far side is the point of the fixture: it is the widest
  // thing on that border and it must contribute nothing. A neutral never attacks,
  // so it is not a shortfall — it is the *second* pass of the reinforcement rule,
  // and the first pass is the one that decides whether an empire is safe.
  const board = { owner: [ME, THEM, NEUTRAL, ME, ME], dice: [3, 6, 8, 1, 1] };
  const adjacency = [[1, 2], [0], [0], [4], [3]];

  assert.deepEqual(refill(board, adjacency, ME), {
    income: 3,
    need: 3,
    residual: 0,
    slack: 0,
  });

  // One die fewer on the border and the same income can no longer cover it.
  const short = { owner: board.owner, dice: [1, 6, 8, 1, 1] };
  assert.deepEqual(refill(short, adjacency, ME), {
    income: 3,
    need: 5,
    residual: 2,
    slack: -2,
  });
});

test('refill counts a surplus as slack rather than as safety', () => {
  // Nothing is behind anything, so the whole income is spare. This is the budget
  // an attack out of a front province spends — "how many attempts can I make and
  // still be fully refilled" is `slack`, and it is positive here.
  const board = { owner: [ME, THEM], dice: [6, 2] };
  const adjacency = [[1], [0]];

  assert.deepEqual(refill(board, adjacency, ME), {
    income: 1,
    need: 0,
    residual: 0,
    slack: 1,
  });
});

test('refill treats an ally as friendly on the border', () => {
  // The same exclusion the reinforcement rules make, and the reason a pact is
  // worth having: a border that cannot be attacked is not a shortfall.
  const board = { owner: [ME, THEM], dice: [2, 7] };
  const adjacency = [[1], [0]];

  assert.equal(refill(board, adjacency, ME).need, 5);
  assert.equal(refill(board, adjacency, ME, new Set([THEM])).need, 0);
});

test('refill is exact about the cap, because a shortfall cannot sit at 8', () => {
  // The claim in the header is that `residual` needs no simulation because every
  // die the refill places closes exactly one point of one gap, and that a province
  // behind a real player is never at the cap and so never refuses a die. Both
  // halves depend on `enemy <= MAX_DICE`, which holds because nothing in the game
  // can put more than eight dice on a province — `distributeDice` stops there and
  // so does `growNeutral`. This pins the arithmetic at the boundary.
  const board = { owner: [ME, THEM], dice: [1, MAX_DICE] };
  const adjacency = [[1], [0]];

  assert.equal(refill(board, adjacency, ME).need, MAX_DICE - 1);
});

/* ── safety first ──────────────────────────────────────────────────────────── */

test('evaluate charges for shortfall the refill cannot cover', () => {
  const adjacency = [[1], [0]];

  // Same land and the same fifteen dice, and the only difference is how they are
  // arranged. Only province 1 faces the enemy, so in the first board the six dice
  // are where the threat is and in the second they are one province back — which
  // is exactly what the reinforcement rule punishes, since it deals to the
  // shortfall and not to the province behind it.
  const wide = [[1], [0, 2], [1]];
  const safe = { owner: [ME, ME, THEM], dice: [3, 6, 6] };
  const split = { owner: [ME, ME, THEM], dice: [6, 3, 6] };

  assert.equal(refill(safe, wide, ME).residual, 0);
  assert.ok(refill(split, wide, ME).residual > 0);
  // `power` is identical on the two boards — two provinces and nine dice each —
  // so the whole of the difference below is the shortfall term.
  assert.ok(evaluate(safe, wide, ME) > evaluate(split, wide, ME));
});

test('the shortfall weight is read, not copied', () => {
  // The sweep in `tools/bot-arena.js` mutates this object and replays the same
  // games, so a weight read once into a closure at import time would make the
  // sweep a no-op that still printed numbers.
  const adjacency = [[1], [0]];
  const board = { owner: [ME, THEM], dice: [1, 6] };

  const original = TUNING.shortfall;
  try {
    TUNING.shortfall = original;
    const before = evaluate(board, adjacency, ME);
    TUNING.shortfall = original * 100;
    assert.notEqual(evaluate(board, adjacency, ME), before, 'shortfall is not being read');
  } finally {
    TUNING.shortfall = original;
  }
});

/* ── growth, and what it costs ─────────────────────────────────────────────── */

test('v3 attacks out of the province that will end up inside its own land', () => {
  // The fixture this policy exists for, and it is built so that the *wrong*
  // answer comes first in scan order — so a policy that took the first good
  // capture on the board would fail here rather than pass by accident.
  //
  // Provinces 0 and 3 are both mine, both hold 6, and both border a one-die
  // province that five thrown dice take almost every time. They are the same
  // attack by every measure v2 has: same win chance, same dice, same land.
  //
  // What differs is what is left behind. 0 also borders a player's 8, so after a
  // capture it sits at 1 in front of it — a gap of 7 the refill has to pay for.
  // 3's other neighbour is my own province, so after a capture it is walled in on
  // every side and the refill does not care about it at all. The second is nearly
  // free and the first is not, and the policy has to see that without being told:
  // nothing in `bot-v3.js` mentions a dead end or an interior province.
  const board = { owner: [ME, THEM, THEM, ME, ME, THEM], dice: [6, 8, 1, 6, 1, 1] };
  const adjacency = [[1, 2], [0], [0], [4, 5], [3], [3]];

  // The two candidates really are the same roll, so nothing but the refill can
  // separate them.
  assert.equal(winChance(attackRolls(6), 1), winChance(attackRolls(6), 1));

  const before = evaluate(board, adjacency, ME);
  const front = { owner: [...board.owner], dice: [...board.dice] };
  front.owner[2] = ME;
  front.dice[2] = 5;
  front.dice[0] = 1;
  const inside = { owner: [...board.owner], dice: [...board.dice] };
  inside.owner[5] = ME;
  inside.dice[5] = 5;
  inside.dice[3] = 1;

  assert.ok(
    evaluate(inside, adjacency, ME) > evaluate(front, adjacency, ME),
    'the capture that leaves a gap behind must score worse than the one that does not',
  );
  assert.ok(
    evaluate(inside, adjacency, ME) > before,
    'and the free one should beat not attacking at all',
  );

  assert.deepEqual(planMove(board, adjacency, ME, null), { from: 3, to: 5 });

  // The same board with the price of shortfall raised out of all proportion: the
  // front capture is now worse than standing still, and the dead end is untouched.
  // Both halves of that are the point. It shows the weight is what decides *how
  // much* safety is worth — which is a number to be measured, and it is 2 — while
  // which of the two captures is cheaper is not a number at all.
  const original = TUNING.shortfall;
  try {
    TUNING.shortfall = 8;
    assert.ok(evaluate(front, adjacency, ME) < before);
    assert.ok(evaluate(inside, adjacency, ME) > before);
  } finally {
    TUNING.shortfall = original;
  }
});

test('v3 grows when the refill can pay for it, and v2 does not grow then either', () => {
  // Not a comparison test — a recording of where the two policies agree. Both
  // take a free province, and the point of writing it down is that "v3 expands"
  // is not a claim about aggression being turned up, which is the reading the
  // numbers invite and the wrong one. v3 accepts this capture because the refill
  // covers it; on the fixture above, v2 accepts it too, for the shallower reason
  // that its exposure term is small enough not to notice.
  const board = { owner: [ME, THEM, ME, ME], dice: [6, 1, 4, 4] };
  const adjacency = [[1, 2], [0], [0, 3], [2]];

  assert.deepEqual(planMove(board, adjacency, ME, null), { from: 0, to: 1 });
  assert.deepEqual(planMoveV2(board, adjacency, ME, null), { from: 0, to: 1 });
});

/* ── it still plays the game ───────────────────────────────────────────────── */

test('v3 does not throw an army away at a one-in-a-hundred shot at winning', () => {
  // v2's jackpot fixture, kept because the trap is in the position score and v3
  // rewrote the position score. The opponent holds one province, so taking it ends
  // the game; my only attack is a 5-stack into its 8, a 0.6% chance. Scoring the
  // win as a sentinel makes it worth `p * sentinel` and turns the policy into a
  // grinder. v3 prices the win as a position — no rival left, so `leader` is zero —
  // and the honest price of a 0.6% shortcut is far below the position it risks.
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

test('v3 still closes out a game it can only win by gambling', () => {
  // The endgame the termination floor exists for. Both stacks are at the cap, so
  // reinforcement can never change this board and the attack is the only move that
  // does anything — declining it forever is a game that never ends.
  //
  // The search's own judgement is to decline: the capture leaves its source at 1
  // facing the enemy's 8, a gap the refill pays seven dice to close, and at 27%
  // that is not worth the shortcut. What makes the move is the floor's escape
  // clause, which is exactly what this pins — and why the floor cannot be deleted
  // on the grounds that the search is good enough.
  const board = { owner: [ME, ME, ME, THEM, ME], dice: [8, 3, 3, 8, 3] };
  const adjacency = [[1, 3], [0, 2], [1, 4], [0], [2]];

  const p = winChance(attackRolls(8), 8);
  assert.ok(p > 0.2 && p < 0.5, `the fixture must be a real but poor chance, got ${p}`);
  assert.deepEqual(planMoveV1(board, adjacency, ME, null), { from: 0, to: 3 }, 'v1 takes it');

  assert.deepEqual(planMove(board, adjacency, ME, null), { from: 0, to: 3 });
});

/* ── properties, over boards nobody wrote down ─────────────────────────────── */

test('v3 never returns an illegal move', () => {
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

test('v3 never attacks an ally', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed), 10);
    const allies = new Set([THEM]);

    const move = planMove(board, adjacency, ME, allies);
    if (!move) continue;

    assert.notEqual(board.owner[move.to], THEM, `seed ${seed}: attacked an ally at ${move.to}`);
  }
});

test('every attack v3 declines is one it can price as unprofitable', () => {
  // This test used to assert the opposite — that v3 moves whenever v1 does —
  // because the floor made v3 a superset of v1. It is not one any more, and it is
  // not meant to be: declining shots that v1 takes is the edge. So the property
  // changes from "at least as willing" to "never arbitrary", which is the one
  // that still has to hold. If v3 passes on a board v1 moved on, then every legal
  // attack for `me` on that board either prices at or below zero, or is the
  // cap-versus-cap escape the floor keeps on purpose.
  let declines = 0;
  let agreements = 0;

  for (let seed = 1; seed <= 200; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed));

    for (const me of [ME, THEM]) {
      const v1Move = planMoveV1(board, adjacency, me, null);
      if (!v1Move) continue;

      if (planMove(board, adjacency, me, null)) {
        agreements++;
        continue;
      }

      declines++;
      for (let from = 0; from < board.owner.length; from++) {
        if (board.owner[from] !== me) continue;
        for (const to of adjacency[from]) {
          const owner = board.owner[to];
          if (owner === null || owner === me) continue;

          const mine = board.dice[from];
          const theirs = board.dice[to];
          if (mine < 2) continue;

          const escape = mine === MAX_DICE && theirs === MAX_DICE;
          assert.ok(
            escape || moveValue(mine, theirs) <= 0,
            `seed ${seed}: ${me} declined ${from}->${to} (${mine} v ${theirs}), `
              + `which prices at ${moveValue(mine, theirs).toFixed(3)} with no escape to justify it`,
          );
        }
      }
    }
  }

  assert.ok(agreements > 0, 'the fixture never had the two policies agree, so the floor proved nothing');
  assert.ok(declines > 0, 'v3 never declined anything, so this measured the floor and not the price');
});

test('v3 is a pure function of its arguments', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const { board, adjacency } = randomBoard(makeRng(seed));
    assert.deepEqual(
      planMove(board, adjacency, ME, null),
      planMove(board, adjacency, ME, null),
      `seed ${seed} produced two different plans`,
    );
  }
});
