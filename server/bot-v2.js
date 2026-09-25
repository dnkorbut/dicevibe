// Bot v2: the same job as `bot-v1.js`, planned a whole turn ahead instead of one
// roll at a time.
//
// Pure, exactly like v1 — it reads a board and returns a plan, and it is the only
// thing in this file that decides what a machine does. No socket, no timer, no
// randomness. The difference is what it is trying to maximise.
//
// ## What v1 gets wrong
//
// v1 scores a *roll*: `p * (theirs + 1) - (1 - p) * (mine - 1)`, and takes every
// roll worth more than nothing. Five things are wrong with that, and the first is
// not missing a term so much as counting one twice.
//
//   1. **v1 pays itself the defender's dice, and nobody ever receives them.** Its
//      own header states the payoff as "the M dice removed from the defender plus
//      the territory itself", and those M dice are *destroyed* — the rules are
//      explicit that a capture takes the land and not the stack, and the capture
//      leaves the attacker's total unchanged because its dice moved rather than
//      multiplied. So `theirs + 1` credits a win with `theirs` dice that cease to
//      exist. This is not a rounding error, it is what funds v1's whole appetite:
//      the honest payoff of a win is the territory alone, and at a territory worth
//      1 the rule flips from "attack when `N > M`" to "attack when `p > (N-1)/N`"
//      — which declines 8-against-6, 8-against-7, 7-against-5 and 6-against-4,
//      every one of which v1 takes. The knife-edge case its header calls "worth
//      only about +0.04 dice" is not thin at all: it is *entirely* made of dice
//      that do not exist, and the same roll is honestly worth −3.2.
//
//      Worth recording why this is easy to miss: the sentence in v1's header is
//      the same mistake the README made about captures until it was corrected, so
//      the code and the docs were wrong in exactly the same way. v2 cannot make
//      it — it never writes a payoff formula, it applies the real `applyAttack` to
//      a real board and scores what comes out, so destroyed dice are simply absent
//      from the successor position. That is the general argument for searching
//      over a real transition rather than over arithmetic about one.
//
//   2. **A province is worth more than 1.** v1 values a capture at `theirs + 1`,
//      so the land contributes exactly one die, once. But every province pays one
//      reinforcement *every turn* for the rest of the game, and winning is counted
//      in provinces. Land is the compounding asset in this game and v1 prices it
//      as a one-off.
//
//      This pushes against the error above rather than with it, and that is worth
//      being clear about because the two are easy to conflate into "v1 is too
//      aggressive" or "v1 is too passive" — neither is right. Gap 1 makes v1
//      attack rolls it should decline; this one makes it decline rolls it should
//      take. Two errors in opposite directions is a policy that cannot be improved
//      much by fixing either one alone, and the arena agrees with that reading
//      rather than the flattering one: pricing land at 1 in *this* policy — so
//      that it has the corrected dice arithmetic and v1's land valuation, which is
//      to say v1's appetite without v1's excuse — measures 50.3%, no better than
//      v1. Correcting the arithmetic buys nothing back on its own; the aggression
//      has to be re-earned with a land value that is actually true.
//
//   3. **Being behind on a border is a cost, and v1 never looks.** v1 only asks
//      what it can take. A province of yours sitting at 1 die beside an enemy 6 is
//      about to change hands, and no term in v1's arithmetic notices.
//
//   4. **There is a race, and v1 barely knows who is winning it.** "Take the best
//      roll on the board" is otherwise blind to whether that roll hurts the leader
//      or the player in last — v1's only leader-awareness is a tie-break between
//      rolls whose expected values are *exactly* equal (`leads`, in `bot-v1.js`),
//      which on real boards is close to never. Taking a province off whoever is
//      ahead is worth more than taking the same province off a straggler, because
//      the win condition is *relative* — you win by being the last one standing,
//      not by being large.
//
//   5. **A turn is a sequence, and v1 decides one move of it.** Every attack
//      collapses its source to 1 die: a stack is a one-shot weapon whose dice
//      either relocate onto the captured province (a win) or are destroyed (a
//      loss). Which stack to spend first, and on what, is therefore a real
//      question — and v1 answers it one greedy roll at a time.
//
// ## What v2 does instead
//
// It searches. `bestLine` is an expectimax over the attacks available *this
// turn*: each attack branches into a capture and a repel, weighted by the real
// win chance, and each resulting board is searched again. The value of a leaf is
// `evaluate` — a score of the position itself, covering all four gaps above.
//
// Chance nodes are the honest shape here, and the reason is worth spelling out.
// The policy cannot roll the dice: the roll happens later, in `attack()`, off
// `room.rng`, and a policy that peeked at it would be cheating. So v2 plans
// *under* uncertainty, weighing both outcomes by their true probability, and is
// then re-asked after the real outcome lands — which is exactly what the driver
// does anyway, since a capture keeps the turn. Planning against the distribution
// rather than against a known result is the whole of the difference.
//
// **It cannot cheat, and that is structural rather than a promise.** The function
// takes a board — `owner`, `dice`, `adjacency` — and nothing else. It never sees
// `room.rng`, the other seats, their reserves, or the opponent's plan. Every
// number it reasons with (`winChance`, `attackRolls`, the board's own contents)
// is public: it is the same information a human at the table has, and a human
// could in principle do all of this arithmetic with a pencil. `tools/bot-arena.js`
// holds it to that by playing policies against each other on real boards.
//
// ## Risk, and why it is not a separate rule
//
// The interesting part of v1's arithmetic is that `EV > 0` holds exactly when
// `mine > theirs`, and by its own numbers the margin just above is nearly
// worthless: 8 against 7 is +0.04 dice at a 47% win chance, while 8 against 6 is
// +2.59 at 68%. So v1's rule is a knife-edge — it will happily throw a seven-die
// stack at a coin flip, because the expectation is a hair above zero. Losing that
// flip destroys six dice and leaves the source at 1, which is not a hair of
// anything.
//
// (Both figures are v1's own. Correctly computed they are −3.25 and −1.52, and
// the difference is exactly `p * theirs` in each case — 3.28 and 4.11 — because
// that is precisely the term gap 1 adds. So the famous +0.04 is a phantom credit
// of +3.28 cancelling an honest loss of −3.25, and the knife edge is not a margin
// v1 misjudges but a margin that is not there at all. That is why this is the
// sharpest case to test the policy on; see the jackpot regression in
// `test/bot-v2.test.js`.)
//
// v2 does not need a risk parameter to see this, because `evaluate` already
// counts the dice. A position that lost six dice scores six worse, and the
// expectimax averages that loss against the gain at the probability it actually
// happens. Risk aversion falls out of weighting the outcomes by their real
// chances instead of collapsing them into one expected number and then treating
// that number as certain.
//
// ## The termination floor
//
// A policy that can decline every attack can also decline forever. `planMove`
// therefore falls back to v1's rule when the search finds nothing that improves
// the position — including v1's MAX_DICE exception, which exists precisely for
// the board where no attack can ever improve anything. That gives v2 a guarantee
// v1 already had: if v1 would have found a move worth making, v2 makes one too,
// so a table of v2 bots cannot stall where a table of v1 bots would not. The
// fallback is a floor and not a tie-break; when v2 has an opinion, it wins.

import { NEUTRAL } from '../shared/constants.js';
import { applyAttack, attackRolls, standings, winChance } from '../shared/rules.js';
import { planAlliance as planAllianceV1, planMove as planMoveV1 } from './bot-v1.js';

/**
 * The weights, in one place, and mutable on purpose.
 *
 * These are the only hand-picked numbers in the policy. None is derived from
 * anything, so the honest way to choose them is to play games and count —
 * `node tools/bot-arena.js --sweep <key>` changes one and re-runs the same fixed
 * set of games. Leaving them a live object rather than constants is what makes
 * that possible.
 *
 * ## What the sweeps actually say, because it is not what I expected
 *
 * **Most of these numbers do not matter much.** Swept at 300 to 1000 games a
 * point, `exposure` moves the win rate between 46% and 51% with no trend,
 * `lead` between 48% and 52% with no trend, and `province` is flat at 50.3% for
 * 0, 2 and 8 while 4 and 12 sit at 52%. Reading those as a ranking would be
 * reading noise: at these sample sizes the confidence intervals overlap almost
 * completely, and the response is not monotone in any of them.
 *
 * Two things do stand out, and they are the reason the defaults are what they
 * are. Sweeping `province` to 0 drops the win rate to 50.3%, and sweeping
 * `depth` to 0 drops it to **50.0%** — and `depth: 0` is not a tuning choice at
 * all, it is the control: with no search, `planMove` falls straight through to
 * the v1 floor and v2 *is* v1. A dead-even result is exactly what that control
 * must produce, and it is the evidence that the harness is not quietly biased
 * toward either policy.
 *
 * So the edge is not in the weights, it is in the combination: a search with no
 * positional score to optimise measures 50.0%, a positional score with no search
 * to spend it measures 50.3%, and the two together measure in the low fifties.
 * That is coherent rather than surprising — a correct score is worth nothing to a
 * policy that only ever looks one roll ahead, and a search is worth nothing if
 * the thing it is maximising is wrong — and it is why the defaults are left where
 * they are rather than tuned toward a maximum that the data does not support.
 *
 * ## And the result is close, in both modes
 *
 * The headline is 51.2% over 3000 heads-up games (95% CI 49.4–53.0) and 48.4%
 * over 800 four-player games (95% CI 44.9–51.8). **Neither interval excludes
 * 50**, so no weight in this object is worth tuning further and no claim of
 * superiority should be built on any of them. The four-player figure is the one
 * that argues most strongly for leaving the policy alone rather than fiddling:
 * the mode where `lead` and the race term should matter most is the mode where
 * this policy is, if anything, behind.
 *
 * ## Scales, so the numbers can be read
 *
 * A province is worth several dice because it pays one a turn for the rest of
 * the game and the horizon is a dozen-odd turns. A die is the unit. `exposure` is
 * priced below a real die because a shortfall is a *risk* of losing the province,
 * not the loss itself — the loss is already in the territory term once it
 * happens.
 */
export const TUNING = {
  /** A province, over and above the dice standing on it. */
  province: 4,
  /** One die, anywhere. */
  die: 1,
  /** A die of shortfall on a border we cannot hold. */
  exposure: 0.6,
  /**
   * Extra penalty for standing above the field, on top of the race term.
   *
   * This is the "take the lead and everyone comes for you" effect, and it is off
   * because nothing measured it as helping — the sweep against v1 across 0, 1, 2
   * and 4 gives 50.7%, 52.3%, 48.3% and 50.7%, which is noise in every direction.
   * It is kept rather than deleted because the mechanism it models is real in a
   * three-way game, and this sweep is not evidence about that case. It is a
   * heads-up measurement, where the dogpile cannot happen at all: there is one
   * other player, they are already attacking you, and `myPower - leader` already
   * says everything there is to say about how far ahead you are. v1's own
   * leader-awareness is a tie-break between exactly equal rolls (`leads` in
   * `bot-v1.js`), which is to say it is almost never consulted, so a term that
   * only matters in a crowd has nothing to measure itself against here. Turning
   * `lead` on would want a four-player run.
   */
  lead: 0,
  /** How many attacks ahead to search. */
  depth: 3,
  /** How many attacks to widen to at each node after the cheap pass. */
  width: 5,
  /** How many candidates survive the cheap expected-value pre-filter. */
  prefilter: 16,
  /** A hard ceiling on nodes visited, so a bad board cannot cost seconds. */
  budget: 600,
};

/* ── the position score ────────────────────────────────────────────────────── */

/**
 * What a board is worth to `me`, in dice-equivalent units.
 *
 * The shape is `my power - the strongest rival's power`, and that *relative* form
 * is the important decision in this file. An absolute score would be happy to
 * watch a rival grow as long as it grew too, which is wrong: the win condition is
 * that everyone else is eliminated, so the only thing that matters is the gap.
 * Scoring the gap also gets "attack whoever is ahead" for free — hitting the
 * leader lowers the term by more than hitting anyone else, with no special case
 * anywhere to say so.
 *
 * The rival is the maximum and not the sum, deliberately. A sum is dominated by
 * the table as a whole and stops distinguishing "one player is about to win" from
 * "three players are each doing fine", which is exactly the distinction that
 * decides games.
 *
 * Exposure is subtracted per province: how many dice short of its strongest
 * non-allied neighbour it stands. Neutrals are excluded because they never
 * attack — the same exclusion `borderStacks` makes, and for the same reason.
 * Allies are excluded too, which is the other half of what a pact buys.
 *
 * `lead` is the optional fourth term and it is **off**, on measurement: pricing
 * the leader's exposure to a dogpile costs v2 more games than it wins against
 * v1, because v1 does not actually dogpile — it has no notion of a leader at
 * all. Against a table of v2 bots the effect is real and the term is how it would
 * be switched on, but shipping a weight that loses to the current opponent to
 * flatter a future one is not a trade worth making.
 */
export function evaluate(board, adjacency, me, allies = null) {
  const rank = standings(board);
  const mine = rank.get(me);
  // Unreachable from the search — `me` is the attacker in every branch, and an
  // attacker never loses a province — so this is a guard rather than a case.
  if (!mine || mine.territories === 0) return -1e9;

  const power = (r) => r.territories * TUNING.province + r.dice * TUNING.die;

  // Winning is a **position, not a jackpot**, and that distinction is the whole
  // reason this loop starts at zero instead of returning a huge sentinel when no
  // rival is left.
  //
  // A sentinel is the obvious thing to write and it is a trap. Note that neutral
  // provinces are not players, so the win condition is "no rival holds land" and
  // not "I own every province" — which means a single lucky capture can end the
  // game from a board where the opponent still holds one province. With the win
  // scored at, say, 1e9, such a capture is worth `p * 1e9` and a *one-in-157*
  // chance of it outscores any honest move by six orders of magnitude. The policy
  // then throws its whole army at that last province turn after turn, rebuilding
  // and losing it again, because the arithmetic says a 0.6% shortcut to victory
  // beats a certain win the slow way. That is exactly the grind this file was
  // written to avoid, and it is what a terminal sentinel buys.
  //
  // Scoring the win as the position it is — the largest `myPower` reachable, with
  // nothing left standing against it — keeps the terminal on the same scale as
  // everything else. Winning still scores higher than any position that is not a
  // win, so it is still what the search reaches for; it just no longer pays a
  // ruinous price for a long shot at it. `leader` stays zero when no rival holds
  // land, which is that "nothing against us" and nothing more.
  let leader = 0;
  for (const [id, r] of rank) {
    if (id === me) continue;
    const p = power(r);
    if (p > leader) leader = p;
  }

  const myPower = power(mine);
  let score = myPower - leader;
  if (TUNING.lead > 0) score -= TUNING.lead * Math.max(0, myPower - leader);

  for (let t = 0; t < board.owner.length; t++) {
    if (board.owner[t] !== me) continue;
    const shortfall = threatAt(board, adjacency, t, me, allies) - board.dice[t];
    if (shortfall > 0) score -= TUNING.exposure * shortfall;
  }

  return score;
}

/** The biggest stack facing `t` that could actually attack it. */
function threatAt(board, adjacency, t, me, allies = null) {
  let worst = 0;

  for (const n of adjacency[t]) {
    const owner = board.owner[n];
    if (owner === null || owner === me || owner === NEUTRAL) continue;
    if (allies?.has(owner)) continue;
    if (board.dice[n] > worst) worst = board.dice[n];
  }

  return worst;
}

/* ── the search ────────────────────────────────────────────────────────────── */

/**
 * Every attack `me` could legally make from this board.
 *
 * Allies are excluded here rather than left to `evaluate`, because attacking one
 * is not a move the policy may consider at all — it is legal in the rules and
 * occasionally right for a human, but a bot breaking its own pact on a whim is
 * noise, and v1 does not do it either.
 */
function attacksFrom(board, adjacency, me, allies) {
  const out = [];

  for (let from = 0; from < board.owner.length; from++) {
    if (board.owner[from] !== me) continue;

    const dice = board.dice[from];
    if (dice < 2) continue;

    const thrown = attackRolls(dice);
    for (const to of adjacency[from]) {
      const owner = board.owner[to];
      if (owner === null || owner === me || allies?.has(owner)) continue;

      const theirs = board.dice[to];
      const p = winChance(thrown, theirs);
      // v1's arithmetic, kept for the pre-filter alone — see `prefilter` below.
      out.push({ from, to, p, ev: p * (theirs + 1) - (1 - p) * (dice - 1) });
    }
  }

  return out;
}

/** The board after `from` attacks `to`, with the given outcome. */
function afterAttack(board, from, to, captured) {
  const next = { owner: [...board.owner], dice: [...board.dice] };
  applyAttack(next, from, to, captured);
  return next;
}

/**
 * The best line from this board, and the first move of it.
 *
 * Expectimax with a beam. Two stages per node, and the split is what keeps this
 * affordable:
 *
 *   - a **cheap pass** over every candidate, ranked by v1's expected value, to
 *     throw away the hopeless ones before anything expensive happens to them;
 *   - a **scoring pass** over the survivors, which is where the two chance
 *     outcomes are actually evaluated and the position score is paid for;
 *   - a **recursion** into the best `width` of those, one attack deeper.
 *
 * `value` starts at `evaluate(board)` — the position as it stands, which is what
 * declining every attack would leave. So a move is only recorded when it beats
 * doing nothing, and `move` comes back null when nothing does. That null is the
 * whole of "this position is not worth attacking any further", and the caller
 * turns it into the termination floor.
 *
 * Ties keep the earliest candidate, so the same board always produces the same
 * plan — the scan order is the tie-break, exactly as in v1, and nothing here
 * consults a clock or a random source.
 */
function bestLine(board, adjacency, me, allies, depth, budget) {
  const stop = evaluate(board, adjacency, me, allies);
  let value = stop;
  let move = null;

  if (depth <= 0 || budget.nodes >= TUNING.budget) return { value, move };

  const options = attacksFrom(board, adjacency, me, allies);
  if (options.length === 0) return { value, move };

  // The cheap pass. Sorting a copy so the caller's scan order is untouched.
  const ranked = options.slice().sort((a, b) => b.ev - a.ev).slice(0, TUNING.prefilter);

  const scored = ranked.map((a, i) => {
    const win = evaluate(afterAttack(board, a.from, a.to, true), adjacency, me, allies);
    const lose = evaluate(afterAttack(board, a.from, a.to, false), adjacency, me, allies);
    return { a, i, win, lose, expected: a.p * win + (1 - a.p) * lose };
  });
  scored.sort((x, y) => y.expected - x.expected || x.i - y.i);

  for (let k = 0; k < Math.min(TUNING.width, scored.length); k++) {
    const { a, win, lose } = scored[k];
    budget.nodes++;

    // Winning moves the stack onto the captured province and the turn carries on
    // from there, so a capture is searched one attack deeper; a repel only
    // collapses the source, which is a dead end for that stack but leaves every
    // other one on the board to try, so it is searched too rather than scored
    // flat. Both get the same depth: the outcome that ends a stack is not the
    // same as the outcome that ends the turn.
    const nextDepth = depth - 1;
    const deepWin = TUNING.depth > 1
      ? bestLine(afterAttack(board, a.from, a.to, true), adjacency, me, allies, nextDepth, budget).value
      : win;
    const deepLose = TUNING.depth > 1
      ? bestLine(afterAttack(board, a.from, a.to, false), adjacency, me, allies, nextDepth, budget).value
      : lose;

    const v = a.p * deepWin + (1 - a.p) * deepLose;
    if (v > value) {
      value = v;
      move = a;
    }
  }

  return { value, move };
}

/**
 * The move to make, or null to end the turn.
 *
 * Same signature and same contract as v1's, so the driver treats them
 * interchangeably and `tools/bot-arena.js` can seat either policy at the table.
 */
export function planMove(board, adjacency, playerId, allies = null) {
  const line = bestLine(board, adjacency, playerId, allies, TUNING.depth, { nodes: 0 });
  if (line.move) return { from: line.move.from, to: line.move.to };

  // The termination floor, and the only place v2 defers to v1. Reaching here
  // means no attack improved the position — which is a real answer, but not one
  // that may be allowed to stand when v1 would have made progress, or a table of
  // v2 bots could sit still forever. See the header.
  return planMoveV1(board, adjacency, playerId, allies);
}

/**
 * Diplomacy is v1's, unchanged.
 *
 * Not an oversight and not laziness: the diplomatic policy is a short list of
 * stated rules — answer a waiting offer, drop a pact with the leader, ask a
 * bordered non-leader — and the interesting question is whether those rules are
 * *right*, not whether they can be computed more cleverly. v2's edge is in the
 * military game. Re-exported rather than copied so there is one of it.
 */
export const planAlliance = planAllianceV1;
