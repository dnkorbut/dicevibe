// Bot v1: the move policy the project shipped with, kept as it was.
//
// Deliberately pure: it reads a board and returns a move, and it is the only
// thing in this file that decides what a machine does. Keeping the decision out
// of the driver means the interesting part — whether the bot plays well — is
// unit-testable against hand-built boards with no server, no timers and no
// randomness involved.
//
// The policy is "ruthless": maximise raw expected value with no risk aversion,
// and attack whenever that value is positive. That is a deliberate choice, not
// a default — the reasoning is in the EV derivation below.
//
// **It is now one of two, and not measurably the weaker one.** `server/bot-v2.js`
// plans a whole turn and values the position rather than the single roll, and it
// is the better-argued policy — but over 3000 heads-up games it wins 51.2% and
// over 800 four-player games it wins 48.4%, neither interval excluding 50. So the
// honest status of this file is not "the old one that lost", it is "the simple one
// that turned out to be about as hard to beat", and `tools/bot-arena.js` is the
// thing that says so rather than the thing that was hoped to say otherwise.
//
// Keeping v1 unmodified is what makes that measurement mean anything: the moment
// it is tuned to flatter v2, or to lose to it less, the comparison stops being
// between two policies and starts being between a policy and a straw man.

import { MAX_DICE, NEUTRAL } from '../shared/constants.js';
import { attackRolls, leaderOf, leads, standings, winChance } from '../shared/rules.js';

/**
 * The best move for `playerId`, or null to end the turn.
 *
 * ## Why the arithmetic is this simple
 *
 * A repelled attack collapses the attacker to 1 die, so it costs N − 1. A
 * capture does not: N dice at `from` become 1 at `from` plus N − 1 at `to`, so
 * the attacker's dice total is *unchanged* and the prize is the M dice removed
 * from the defender plus the territory itself. Hence, with p = P(win):
 *
 *     V  = M + 1
 *     EV = p * V − (1 − p) * (N − 1)
 *
 * **The M in that first line is wrong, and this paragraph is left standing
 * because deleting it would hide why the policy plays the way it does.** Those M
 * dice are *destroyed* — a capture takes the land and not the stack, the same
 * thing the rules say out loud — so nothing ever receives them, and crediting a
 * win with them is crediting dice that cease to exist. The honest payoff of a win
 * is the territory alone. The consequence is not small: at a territory worth 1,
 * `EV > 0` stops meaning `N > M` and starts meaning `p > (N − 1) / N`, which
 * declines 8-against-6, 7-against-5 and 6-against-4 — all of which this policy
 * takes. See gap 1 in `server/bot-v2.js` for the arithmetic.
 *
 * Nothing below is changed by knowing this, and that is deliberate: this file is
 * the fixed opponent the arena measures against, and a bug found and then quietly
 * patched here would destroy the only baseline the project has. Correcting it is
 * what v2 is.
 *
 * The territory is worth 1 on top of the M dice because every province pays one
 * reinforcement a turn, so taking one is worth a die a turn for the rest of the
 * game — and that is the whole of it. There is no separate bonus for extending a
 * connected group: reinforcement is paid per province held, so a scattered
 * capture earns exactly what a contiguous one does, and a bot that still chased
 * the largest blob would be spending dice on a benefit the rules no longer give.
 *
 * The attacker throws one die fewer than it holds, so `p` is measured on N − 1
 * dice against the defender's M — the die left at home does not fight. What that
 * does to the shape of the policy is worth stating plainly: **`EV > 0` holds
 * exactly when `N > M`.** Equal stacks are a losing bet, and the margin just
 * above is thin — 8 against 7 is worth only about +0.04 dice. So the bot attacks
 * when it outnumbers the defender and declines otherwise. That is a legible rule
 * rather than a pile of special cases, which is also what makes it testable.
 *
 * ## The one exception
 *
 * When both stacks are already at MAX_DICE, no attack can ever become profitable
 * and no reinforcement can improve the board, so a bot that took only positive-EV
 * moves would decline for the rest of the game and the match could never end. At
 * that point the gamble is taken whatever it is worth: it is the only move that
 * changes anything.
 *
 * ## Ties
 *
 * Between two moves of *exactly* equal EV — the same stack, the same defender,
 * differing only in whose province it is — the more advanced player is the one
 * worth attacking, so the run-away leader gets punished rather than whoever
 * happens to sit at the lowest territory id. This is a tie-break and nothing
 * more: a move with better EV is always taken even if it hits a nobody, because
 * the value of a province does not depend on who holds it.
 *
 * "Exactly equal" is the right test rather than a tolerance: equal EV arises
 * from an identical `(mine, theirs, grows)` triple, and identical arithmetic
 * produces bit-identical doubles. Everything else falls back to the scan order —
 * lowest `from`, then lowest `to` — so there is still no randomness anywhere and
 * the same board always produces the same move.
 */
export function planMove(board, adjacency, playerId, allies = null) {
  const rank = standings(board);
  let best = null;

  for (let from = 0; from < board.owner.length; from++) {
    if (board.owner[from] !== playerId) continue;

    const mine = board.dice[from];
    if (mine < 2) continue;

    for (const to of adjacency[from]) {
      const defender = board.owner[to];
      // Null is a void, which is never a legal target.
      //
      // Allies are filtered here, beside the self-check, rather than left to the
      // stalemate clause below. One exclusion covers both the EV scan and that
      // exception, and the exception is the one that matters: it fires on two
      // provinces both at MAX_DICE and would otherwise *force* an attack on an
      // ally, directly contradicting "a bot never attacks an ally".
      if (defender === null || defender === playerId || allies?.has(defender)) continue;

      const theirs = board.dice[to];
      const p = winChance(attackRolls(mine), theirs);
      const value = theirs + 1;
      const ev = p * value - (1 - p) * (mine - 1);

      // Nothing can improve from here — see "The one exception" above.
      const stalemate = mine === MAX_DICE && theirs === MAX_DICE;
      if (ev <= 0 && !stalemate) continue;
      const better = best === null || ev > best.ev || (ev === best.ev && leads(rank, defender, best.defender));

      if (better) best = { from, to, ev, defender };
    }
  }

  return best ? { from: best.from, to: best.to } : null;
}

/**
 * The expected value of a single move, exposed for tests and tuning.
 *
 * `planMove` needs a whole board; this needs two numbers, which is what makes
 * the EV table in the plan reproducible from the shipped code.
 */
export function moveValue(mine, theirs) {
  const p = winChance(attackRolls(mine), theirs);
  return p * (theirs + 1) - (1 - p) * (mine - 1);
}

/**
 * The bot's diplomatic policy: at most ONE action, or null.
 *
 * `state` is the bot's own view of the table, as the seat holds it:
 * `{ allies, requested, askedThisTurn, incoming }`. Only `incoming` is derived —
 * the others are fields on the player, passed rather than read so the policy
 * stays a pure function of its arguments.
 *
 * The rules, in the order they are applied:
 *
 *   1. answer whatever is waiting — accept unless the asker is the leader
 *   2. break with the leader, if allied to them
 *   3. ask a bordered non-leader, once per turn
 *
 * Answering first is what makes a bot deal with a question before going off to
 * ask one of its own; breaking before asking is what stops it forming a pact it
 * is about to dissolve.
 *
 * One action per call, not a sequence, and that is deliberate. `game.lastEvent`
 * is a single slot and the client logs only the newest event, so an alliance
 * formed and an attack made in the same tick would make the alliance invisible
 * in the log. Giving alliances a second slot would fix that too, at the cost of
 * a second client cursor and a second copy of the replay logic in `consumeEvent`.
 * One action per tick reuses all of it and costs one bot beat.
 *
 * ## Why these rules cannot churn
 *
 * Read literally, a bot never asks the leader and never accepts it, so a
 * bot-to-leader pact can only arise when the lead *changes hands* — which is
 * exactly what the break rule is for. So the break is rare, not dead. It also
 * means that in an all-bot game whoever is leading always has a non-ally to
 * attack, and the match cannot stall on a table of friends.
 *
 * Choices inside a rule fall back to the scan order — lowest province id, then
 * the order `adjacency` lists its neighbours — so the same board always produces
 * the same action, exactly as `planMove` does. Any bordered non-leader will do;
 * the rule names no preference between them, and inventing one would be a policy
 * the tests would then have to pin.
 */
export function planAlliance(board, adjacency, playerId, state = {}) {
  const allies = new Set(state.allies ?? []);
  const requested = new Set(state.requested ?? []);
  const leader = leaderOf(board);

  // 1. A question is waiting. Accept it unless it came from the leader — the bot
  //    will not help the player it is losing to.
  for (const from of state.incoming ?? []) {
    if (allies.has(from)) continue;
    return { action: from === leader ? 'decline' : 'accept', playerId: from };
  }

  // 2. Allied to whoever is ahead. That pact was not refused when it was made —
  //    it is a consequence of the lead changing hands since.
  for (const ally of allies) {
    if (ally === leader) return { action: 'break', playerId: ally };
  }

  // 3. Ask somebody on the border. One ask per turn, which together with the
  //    idempotent no-op in `requestAlliance` is what bounds this loop: a refusal
  //    clears the pending entry, so the idempotence check alone would let the bot
  //    ask again on the very next tick.
  if (state.askedThisTurn) return null;

  for (let t = 0; t < board.owner.length; t++) {
    if (board.owner[t] !== playerId) continue;

    for (const n of adjacency[t]) {
      const owner = board.owner[n];
      if (owner === null || owner === playerId || owner === NEUTRAL) continue;
      if (owner === leader || allies.has(owner) || requested.has(owner)) continue;
      return { action: 'request', playerId: owner };
    }
  }

  return null;
}
