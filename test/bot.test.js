// The bot's move policy.
//
// `planMove` is pure and has no randomness in it at all, so every one of these
// is an exact assertion on a hand-built board rather than a statistical claim.
// That is the whole reason the decision lives in its own module: the driver
// needs a server, players and timers, and none of that is where the interesting
// logic is.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DICE, NEUTRAL } from '../shared/constants.js';
import { leaderOf } from '../shared/rules.js';
import { moveValue, planAlliance, planMove } from '../server/bot.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

/** `null` is a void, `'p1'`/`'p2'` are owners — matching the server's board. */
const board = (owner, dice) => ({ owner, dice });

/** A two-cell board where p1 can attack p2 across a shared border. */
const duel = (mine, theirs) => board(['p1', 'p2'], [mine, theirs]);

const EDGE = [[1], [0]];

/* ── taking and declining ──────────────────────────────────────────────────── */

test('an 8 against a 1 is taken', () => {
  const move = planMove(duel(8, 1), EDGE, 'p1');
  assert.deepEqual(move, { from: 0, to: 1 });
});

test('a 2 against an 8 is declined, and the turn ends instead', () => {
  // The check that the policy is not merely "attack something". A lone 2-die
  // stack throwing itself at an 8 loses a die for nothing; the bot must prefer
  // to do nothing at all.
  assert.equal(planMove(duel(2, 8), EDGE, 'p1'), null);
});

test('a stack of 1 has no move, however weak the neighbour', () => {
  // Not merely unprofitable — illegal. `canAttack` requires 2 dice, so proposing
  // this would come back as a refusal on every tick of the driver.
  assert.equal(planMove(duel(1, 1), EDGE, 'p1'), null);
});

test('a player with no territory has no move', () => {
  assert.equal(planMove(board([null, 'p2'], [0, 4]), EDGE, 'p1'), null);
});

test('a player with nowhere to attack has no move', () => {
  // Owns the board; the only other cell is water.
  assert.equal(planMove(board(['p1', null], [8, 0]), EDGE, 'p1'), null);
});

/* ── water ─────────────────────────────────────────────────────────────────── */

test('water is never a target, even when it is the softer-looking option', () => {
  // A void has `owner === null` and 0 dice, which makes it look like the freest
  // capture on the board to anything that only compares ownership. It must be
  // skipped entirely, not merely scored low.
  const b = board(['p1', 'p2', null], [8, 1, 0]);
  const adjacency = [[1, 2], [0], [0]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('water alone beside a stack means no move at all', () => {
  const b = board(['p1', null, null], [8, 0, 0]);
  assert.equal(planMove(b, [[1, 2], [0], [0]], 'p1'), null);
});

/* ── choosing between moves ────────────────────────────────────────────────── */

test('the higher-value move wins even when it is found later', () => {
  // p1 holds an isolated 8 at 0 and an isolated 2 at 2; both can take a 1-die
  // neighbour. The scan runs in ascending `from`, so a policy that took the
  // first acceptable move, or the last one, would get this wrong — 2 is the
  // better but higher-indexed stack.
  const b = board(['p1', 'p2', 'p1', 'p2'], [8, 1, 2, 1]);
  const adjacency = [[1], [0], [3], [2]];

  const strong = moveValue(8, 1);
  const weak = moveValue(2, 1);
  assert.ok(strong > weak + 0.5, 'sanity: the 8 must be clearly the better stack');

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('a capture is worth the same wherever it lands', () => {
  // The mirror of the rule this used to test. Reinforcement is paid per province
  // held, so extending a connected body and taking an isolated one pay exactly
  // the same, and the bot must not prefer either. Two identical attacks whose
  // only difference is that one joins p1's pair and the other sits apart: with a
  // join bonus they would separate, without one they are an exact tie and the
  // deterministic scan order decides.
  const b = board(['p1', 'p1', 'p1', 'p2', 'p2'], [5, 5, 5, 2, 2]);
  //  0           1    2         3    4
  // p1 holds a chain {0, 1, 2}; from 2 into 4 extends it, from 0 into 3 does not.
  const adjacency = [[3], [2], [1, 4], [0], [2]];

  // The two moves are the same fight — a 5 into a 2 — so they score identically
  // and the scan order decides, which means the lowest `from` wins. Under a join
  // bonus this returned `{ from: 2, to: 4 }` instead, which is what makes this a
  // test of the rule rather than of the scan.
  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 3 });
});

test('ties go to the lowest source, then the lowest target', () => {
  // Two identical attacks, so the EVs are exactly equal and only the tie-break
  // decides. Determinism is the point: a bot that picked arbitrarily would be
  // untestable, and the same board twice would give two different answers.
  const b = board(['p1', 'p2', 'p1', 'p2'], [4, 1, 4, 1]);
  const adjacency = [[1], [0], [3], [2]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('a tie goes to the province of whoever is furthest ahead', () => {
  // Two moves the bot cannot tell apart on value: a 5-die stack into a 1-die
  // neighbour either way, capturing a province that pays exactly the same
  // reinforcement. The scan reaches `from: 0` first, so without a leader
  // tie-break that is what it would always play.
  //
  // They differ only in whose province it is. p3 holds three provinces to p2's
  // one, so p3 is the player worth slowing down, and the tie goes to them.
  const b = board(['p1', 'p2', 'p1', 'p3', 'p3', 'p3'], [5, 1, 5, 1, 1, 1]);
  const adjacency = [[1], [0], [3], [2], [5], [4]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 2, to: 3 });
});

test('when the tied defenders are equally advanced, the lowest target still wins', () => {
  // The fallback has to survive the new rule, or the bot's move would depend on
  // something invisible again. p2 and p3 hold one province each with one die
  // apiece, so there is no leader to prefer and the old order stands.
  const b = board(['p1', 'p2', 'p1', 'p3'], [5, 1, 5, 1]);
  const adjacency = [[1], [0], [3], [2]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('equal provinces are separated by the dice standing on them', () => {
  // p2 and p3 both hold two provinces, so territory count says nothing; p3 has
  // six dice massed behind theirs and p2 has none. That is the second half of
  // "most advanced" — the same board size, one of them actually a threat.
  const b = board(['p1', 'p2', 'p1', 'p3', 'p3', 'p2'], [5, 1, 5, 1, 6, 1]);
  const adjacency = [[1], [0], [3], [2], [4], [5]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 2, to: 3 });
});

test('the neutral faction is never the leader worth attacking', () => {
  // On a real board NEUTRAL holds every province nobody was dealt — 20 of 30 on
  // the default one — so ranking it would make "the province of whoever is
  // furthest ahead" pick a neutral province every single time, and the
  // tie-break would never once fire for an actual opponent.
  //
  // Both moves are the same 5-into-1 attack, so only the tie-break separates
  // them: the scan reaches `from: 0` first, and with NEUTRAL out of the ranking
  // p2 is the only player left to prefer.
  const b = board(['p1', 'p2', 'p1', NEUTRAL, NEUTRAL, NEUTRAL], [5, 1, 5, 1, 1, 1]);
  const adjacency = [[1], [0], [3], [2], [5], [4]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('the leader is only a tie-break, never worth a worse move', () => {
  // The rule is easy to overshoot: "attack the leader" must not become a reason
  // to take a bad attack. Here the leader's province is the harder fight — 6
  // dice against the stack, versus 1 for the nobody — and the value of a
  // province does not depend on who holds it, so the soft target wins outright.
  const b = board(['p1', 'p2', 'p1', 'p3', 'p3', 'p3'], [5, 1, 5, 6, 1, 1]);
  const adjacency = [[1], [0], [3], [2], [5], [4]];

  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 1 });
});

test('the shape of your own land steers nothing', () => {
  // p1 holds two separate bodies — a pair {0,1} and a chain {4,5,6} — which is
  // precisely the arrangement the old reinforcement formula punished. Both
  // candidate attacks are a 5 into a 2, so they score identically and the scan
  // order decides. A policy that still preferred extending its biggest body
  // would take `from: 6`; there is no longer any reason to.
  const b = board(
    ['p1', 'p1', 'p2', 'p2', 'p1', 'p1', 'p1'],
    [5, 1, 2, 2, 1, 1, 5],
  );
  const adjacency = [[1, 2], [0], [0], [6], [5], [4, 6], [5, 3]];

  // Both candidates are the same fight: 0→2 and 6→3 are each a 5 into a 2, so
  // they tie and the lower `from` wins. Extending the chain would mean `from: 6`.
  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 2 });
});

/* ── the shape of the policy ───────────────────────────────────────────────── */

test('outnumbering the defender is worth attacking and equal stacks never are', () => {
  // This is the whole policy in one sentence, and the reason it is legible
  // rather than a pile of special cases. The attacker throws one die fewer than
  // it holds, so parity is not a fair fight — the defender rolls its whole stack
  // and wins ties. The break-even therefore sits exactly at `mine > theirs`:
  // one die more is positive, equal stacks are negative.
  //
  // The margin just above the line is genuinely thin (8 against 7 is worth about
  // +0.04 dice), so this asserts the sign and not a threshold.
  for (let n = 1; n <= 7; n++) {
    assert.ok(moveValue(n + 1, n) > 0, `${n + 1} vs ${n} should be worth attacking`);
  }

  for (let n = 2; n <= 8; n++) {
    assert.ok(moveValue(n, n) < 0, `${n} vs ${n} should be declined`);
  }

  for (let n = 2; n <= 7; n++) {
    assert.ok(moveValue(n, n + 1) < 0, `${n} vs ${n + 1} should be declined`);
  }
});

test('two maxed-out stacks still attack, because declining forever ends nothing', () => {
  // The one exception to the policy. At the cap no attack can ever become
  // profitable and no reinforcement can change the board, so a bot that only
  // ever took positive-EV moves would decline for the rest of the game and the
  // match could never finish. It takes the gamble instead.
  //
  // Built so the maxed province is the only candidate: p1's other province has
  // a single die and cannot attack at all.
  const b = board(['p1', 'p1', 'p2'], [MAX_DICE, 1, MAX_DICE]);
  const adjacency = [[2], [], [0]];

  assert.ok(moveValue(MAX_DICE, MAX_DICE) < 0, 'sanity: this really is a losing attack');
  assert.deepEqual(planMove(b, adjacency, 'p1'), { from: 0, to: 2 });
});

test('value rises with the defender and falls with what it costs to lose', () => {
  // Guards the sign of each term: a flipped one would still make the two tests
  // above pass, since they only look at the diagonal and one side of it.
  assert.ok(moveValue(6, 3) > moveValue(6, 1), 'a juicier defender is worth more');
  assert.ok(moveValue(8, 4) > moveValue(4, 4), 'the same target is worth more from a bigger stack');
});

test('every move it proposes is one the rules would accept', () => {
  // A cheap sweep over a random-ish spread of shapes, checking the policy never
  // points at its own territory, at water, at a 1-die source, or off the board.
  // The driver turns an illegal move into a forfeited turn, so a policy bug here
  // shows up as a bot that mysteriously stops playing.
  const shapes = [
    board(['p1', 'p2', null, 'p1'], [8, 1, 0, 3]),
    board(['p1', 'p1', 'p2', null], [2, 2, 2, 0]),
    board(['p2', 'p1', 'p2', 'p1'], [6, 6, 6, 6]),
  ];

  for (const b of shapes) {
    const move = planMove(b, [[1], [0, 2], [1, 3], [2]], 'p1');
    if (move === null) continue;

    assert.equal(b.owner[move.from], 'p1', 'must attack from its own territory');
    assert.ok(b.dice[move.from] >= 2, 'a 1-die stack cannot attack');
    assert.notEqual(b.owner[move.to], 'p1', 'must not attack itself');
    assert.notEqual(b.owner[move.to], null, 'must not attack water');
  }
});

/* ── who is ahead ──────────────────────────────────────────────────────────── */

test('the leader is decided by territories first, then by dice', () => {
  // Territories outrank dice because they are what reinforcement pays and what
  // winning is counted in: a player holding more ground on fewer dice is still
  // the one to worry about.
  assert.equal(leaderOf(board(['p1', 'p1', 'p2', 'p3'], [1, 1, 8, 8])), 'p1');

  const fatter = board(['p1', 'p2'], [4, 7]);
  assert.equal(leaderOf(fatter), 'p2', 'one territory each, so the dice decide');
});

test('a tie goes to the first owner in scan order', () => {
  // "The most advanced player" has to name exactly one seat or the alliance
  // rules are not well defined, and this is the tie-break that makes it do so.
  assert.equal(leaderOf(board(['p2', 'p1'], [5, 5])), 'p2');
});

test('the neutral faction is never the leader', () => {
  // It holds every province nobody was dealt, so it would win the tie-break on
  // any board with unclaimed land — and a bot would then refuse to ally with
  // anyone but the empty ground.
  assert.equal(leaderOf(board([NEUTRAL, NEUTRAL, NEUTRAL, 'p1'], [8, 8, 8, 1])), 'p1');
});

test('nobody leads an undealt board', () => {
  assert.equal(leaderOf(board([null, NEUTRAL], [0, 0])), null);
  assert.equal(leaderOf(board([], [])), null);
  assert.equal(leaderOf(board([null, 'p1'], [0, 2])), 'p1', 'water is not a player');
});

/* ── an ally is not a target ───────────────────────────────────────────────── */

test('an ally is skipped as a target', () => {
  const b = duel(8, 1);
  assert.deepEqual(planMove(b, EDGE, 'p1'), { from: 0, to: 1 });
  assert.equal(planMove(b, EDGE, 'p1', new Set(['p2'])), null, 'and with nobody else to hit, the turn ends');
});

test('an ally is skipped even where the stalemate clause would force the attack', () => {
  // The clause exists so that a bot holding 8 against 8 gambles rather than
  // declining forever. Left to the EV scan alone it would *force* that attack on
  // an ally, contradicting "a bot never attacks an ally" — which is why the
  // exclusion sits in the neighbour loop beside the self-check and not at the
  // clause itself.
  const b = duel(MAX_DICE, MAX_DICE);
  assert.deepEqual(planMove(b, EDGE, 'p1'), { from: 0, to: 1 });
  assert.equal(planMove(b, EDGE, 'p1', new Set(['p2'])), null);
});

test('a third player is still a target beside an ally', () => {
  // The exclusion filters, it does not disarm: one ally and one enemy on the
  // border still means the enemy gets attacked.
  const b = board(['p1', 'p2', 'p3'], [8, 1, 1]);
  const edges = [[1, 2], [0], [0]];
  assert.deepEqual(planMove(b, edges, 'p1'), { from: 0, to: 1 });
  assert.deepEqual(planMove(b, edges, 'p1', new Set(['p2'])), { from: 0, to: 2 });
});

test('no allies and an empty set move identically', () => {
  // `null` is what a caller with no opinion passes and `new Set()` is what a
  // seat with no pacts produces, so the two must not diverge.
  const b = duel(6, 3);
  assert.deepEqual(planMove(b, EDGE, 'p1', new Set()), planMove(b, EDGE, 'p1'));
});

/* ── the diplomatic policy ─────────────────────────────────────────────────── */

/**
 * A table built so every branch of the policy is reachable from it.
 *
 * `p1` holds two provinces, so it leads on territories whatever the dice say;
 * `p2` is the bot; `p3` is the non-leader it can reach. `p2`'s neighbours are
 * listed leader-first, which is what makes "it skipped the leader" a real
 * assertion rather than a coincidence of scan order.
 */
const TABLE = () => board(['p1', 'p1', 'p2', 'p3'], [1, 1, 8, 8]);
const TABLE_EDGES = [[1, 2], [0], [0, 3], [2]];

test('it asks a bordered non-leader', () => {
  // p2 borders both p1 (the leader) and p3, and p1 comes first, so a policy that
  // simply took the first neighbour would name the leader here.
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2'), { action: 'request', playerId: 'p3' });
});

test('it accepts an offer from anyone but the leader', () => {
  const asked = { incoming: ['p3'] };
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', asked), {
    action: 'accept',
    playerId: 'p3',
  });
});

test('it declines an offer from the leader', () => {
  // Handing the player you are losing to a border you will not attack is the one
  // pact the policy refuses outright.
  const asked = { incoming: ['p1'] };
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', asked), {
    action: 'decline',
    playerId: 'p1',
  });
});

test('a question is answered before anything else is done', () => {
  // Answering first is what makes a bot deal with what it has been asked instead
  // of going off to ask something of its own — and one action per call is what
  // keeps the tick bounded and the log readable.
  const state = { incoming: ['p3'], allies: ['p1'] };
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', state), {
    action: 'accept',
    playerId: 'p3',
  });
});

test('it answers only one asker per call', () => {
  const state = { incoming: ['p3', 'p1'] };
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', state), {
    action: 'accept',
    playerId: 'p3',
  });
});

test('an ally who asks is not answered', () => {
  // Answering a pact you already hold would be ALREADY_ALLIED on the server, so
  // the offer has to be stepped over rather than returned.
  const state = { allies: ['p3'], incoming: ['p3'] };
  assert.equal(planAlliance(TABLE(), TABLE_EDGES, 'p2', state), null);
});

test('it breaks with the leader, and only with the leader', () => {
  // An alliance with whoever is ahead is not one that was refused when it was
  // made — it is a consequence of the lead changing hands since, which is
  // exactly what the break rule is for.
  const state = { allies: ['p1'] };
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', state), {
    action: 'break',
    playerId: 'p1',
  });

  // p3 is also reachable and also an ally, but is not ahead.
  assert.equal(planAlliance(TABLE(), TABLE_EDGES, 'p2', { allies: ['p3'] }), null);
});

test('it does not ask twice, or ask again after a refusal', () => {
  // `requested` covers the ask that is still open. `askedThisTurn` covers the one
  // that was declined — a refusal clears the pending entry, so the idempotence
  // check alone would let the bot ask again on the very next tick.
  assert.equal(planAlliance(TABLE(), TABLE_EDGES, 'p2', { requested: ['p3'] }), null);
  assert.equal(planAlliance(TABLE(), TABLE_EDGES, 'p2', { askedThisTurn: true }), null);

  // Neither guard may suppress an answer, though: those are not asks.
  assert.deepEqual(
    planAlliance(TABLE(), TABLE_EDGES, 'p2', { askedThisTurn: true, incoming: ['p3'] }),
    { action: 'accept', playerId: 'p3' },
  );
  assert.deepEqual(planAlliance(TABLE(), TABLE_EDGES, 'p2', { askedThisTurn: true, allies: ['p1'] }), {
    action: 'break',
    playerId: 'p1',
  });
});

test('it does not ask an ally, or the neutral faction', () => {
  // NEUTRAL is an owner id with no seat behind it, so asking would be refused as
  // NO_SUCH_PLAYER and the tick would be wasted.
  const neutralNextDoor = board(['p1', 'p1', 'p2', NEUTRAL], [1, 1, 8, 5]);
  assert.equal(planAlliance(neutralNextDoor, [[1, 2], [0], [0, 3], [2]], 'p2'), null);
});

test('nothing to do returns null', () => {
  // Every neighbour is the leader, water or an ally: there is nobody left to ask,
  // and the bot ends its turn instead.
  const walls = board(['p1', 'p1', 'p2', null], [1, 1, 8, 0]);
  assert.equal(planAlliance(walls, [[1, 2], [0], [0], []], 'p2'), null);
});
