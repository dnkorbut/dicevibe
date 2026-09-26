// Bot v3: v2's search, scoring the position by what the end-of-turn refill
// actually does with it.
//
// Pure, like v1 and v2 — a board in, a plan out, no socket, no clock, no
// randomness. The search is v2's, unchanged: an expectimax over the attacks
// available this turn, weighted by the real win chance, with the same cheap pass,
// beam and node budget. What is different is `evaluate`, and the difference is
// the whole point of this file.
//
// ## What v2 gets wrong
//
// v2 scores a position as `my power - the strongest rival's power`, less a fixed
// penalty per die of shortfall on a border. Both terms are static: they count what
// is on the board and never ask what happens at the end of the turn, which is when
// the board is paid for.
//
// That misses the actual economics of an attack, because **an attack is not paid
// for in dice**. A capture leaves the attacker's total untouched — the stack
// relocates, leaving one die behind, and the defender's dice are destroyed rather
// than taken. So the dice are not the price. The price is what the move does to
// the *shape* of the empire, and the bill arrives at End Turn, when one die per
// province is dealt out to whoever is behind.
//
// Two moves that look identical to v2 can therefore be completely different:
//
//   - attacking out of a province with an enemy on its other flank drops that
//     province to 1 die in front of a stack that can take it, so the refill has to
//     come back and make good the loss before it can do anything else;
//   - attacking out of a province buried inside your own land drops it to 1 die
//     facing nothing at all, so the refill does not care.
//
// The second is close to free and the first can cost more than the land is worth.
// v2 cannot see the difference. v3 can, and it is not a special case anywhere in
// this file — it falls out of pricing the position the refill will produce.
//
// ## The rule being predicted
//
// End Turn banks one die per province held, then deals the reserve out one die at
// a time, each die to the province with the deepest shortfall against the
// strongest **player** stack on its border. Neutrals are not a threat, so they do
// not count in that first pass; the dice only reach them once every real shortfall
// is closed. Provinces stop at 8 dice and anything left over stays banked.
//
// So define, for an empire:
//
//   income  = provinces held            — what End Turn will pay, this turn
//   need    = Σ max(0, enemy(t) - dice(t)) over every province t held
//   residual = max(0, need - income)    — shortfall still open after the refill
//
// and `refill` below computes all three. **`residual` is exact, not an
// approximation**, and that is worth showing rather than asserting: every die the
// refill places goes to a province that is behind a real player, because tier 0
// outranks tier 1 and tier 2 outright; each such die closes one point of one gap,
// so each die removes exactly one from `need`; and a province that is behind a
// real player is below its enemy's stack, which is at most 8, so it is never at
// the cap and never refuses the die. `min(income, need)` dice therefore close
// `min(income, need)` of the shortfall, and what is left is `need - income` when
// that is positive. No simulation needed, and none used.
//
// `slack = income - need` is the same fact the other way up: how many dice the
// turn has left over once it has made itself safe. It is the budget for attacking
// out of a province that will have to be made good again — which is what "how many
// capture attempts can I afford and still be fully refilled" means, and it is why
// this file never has to count attempts.
//
// ## Safety first, growth second
//
// The score is
//
//   `power(mine) - power(strongest rival) - shortfall * residual`
//
// and the ordering the brief asks for — everything safe first, growth after — is
// the size of `shortfall` relative to `province`. While any shortfall is open the
// penalty is the dominant term, so the search will not trade safety for land; once
// none is open the penalty is zero and the score is exactly v2's race, so the
// policy grows. That is "safe, and then grow until it is not safe" written as
// arithmetic rather than as a rule with a branch in it, and it means there is no
// state where the policy has to decide which of the two it is doing.
//
// It also makes v3 more willing to expand than v2, and not because aggression was
// dialled up. Land is simply cheaper than v2 thought: a capture costs no dice, and
// where the source ends up interior it costs no reinforcement either, so the honest
// price of a province is often zero. v2 charged for the shortfall a move left behind
// but never credited the income the new province brings, so it under-bought land on
// exactly the boards where land was free.
//
// The size of that is worth stating rather than implying, because "more willing to
// expand" invites a much bigger claim than the one that is true. Asking both
// policies about 4739 positions sampled from real games — one frozen board, two
// answers — v2 attacks on 81.0% of them and v3 on 83.6%, and **they agree on which
// of attack-or-end-turn to do 97.1% of the time.** What separates them is the
// direction, and that is unambiguous: of the 137 disagreements, v3 attacks where v2
// declines 130 times and v2 attacks where v3 declines 7. So the re-pricing moves the
// policy the way the argument says it should and almost never the other way, and it
// does so on three decisions in a hundred.
//
// Which of the two — this score, or the escape clause below — is doing the winning
// is a fair question and there is a measured answer. Against v1, the search is worth
// about eight points (`depth: 0`, which drops the search and leaves the re-priced
// greedy rule, scores 60.6% where the full policy scores 68.3%) and the escape about
// seventeen (v1's own escape rule scores 51.3%). Against v2 it is six and fourteen.
// So the re-pricing pays for itself and the escape pays for rather more — and that
// split is the correction to a claim this file used to make. The 97.1% figure above
// was read, for a while, as meaning that so small a behavioural change could not
// move a win rate far. It can, and the reason it did not appear to is not in either
// policy: the harness was labelling about half of all games with the wrong winner.
// See "What the arena was measuring" in `tools/bot-arena.js`. Nothing about a
// policy is safe to conclude from a broken scale, however careful the argument that
// produced it.
//
// ## It cannot cheat, and that is structural
//
// The same argument as v2's, and it holds for the same reason: `planMove` takes a
// board — `owner`, `dice`, `adjacency` — and a reserve, and nothing else. It never
// sees the RNG, the other seats' reserves or their plans. Every quantity above is a
// function of the public board. A human with the rules and a pencil could compute
// `need` and `income` at the table, and this bot is doing nothing more than that.
//
// The reserve is the one number it takes that is not on the board, and it is worth
// being exact about why that is not a hole in the argument. It is *this seat's own*
// reserve, it is published to the whole table on the rail (a human reads the same
// number off their own row), and no other seat's reserve is readable from it or
// from anything else here. Having it can only sharpen a decision about a position
// the seat already knows — see "The reserve" below — and a policy that plays
// against the number on its own dashboard is not playing with information anybody
// else lacks.
//
// ## What it assumes, and why that is safe
//
// `refill` still projects as though the bank were empty, and that is a deliberate
// limit on how far the reserve reaches. A reserve really would cover a shortfall —
// `endTurn` spends it before it spends the income — so the projection over-states
// the danger of an empire that is holding one, and `residual` is larger than the
// truth. It is pessimistic in the safe direction, and leaving it there is the
// smaller change: `residual` is the term the position score is built on and every
// number in this file was measured with it reading the board alone, so folding the
// reserve into it would be a second behaviour change wearing the first one's
// clothes. Banking, not defending, is what was wrong. See "The reserve" below.
//
// ## The reserve, and when banking stops paying
//
// The one rule here that reads a number the board does not carry, and it exists
// because of what `distributeDice` does on a board that has run out of room.
//
// Reinforcement is exhaustive: it places a die on every pass and the only way out
// of the loop is running out of dice or running out of room, so an empire's reserve
// after a turn is exactly `stock + income - room`. A reserve only survives while the
// empire is nearly full — and once it survives it *grows*, because `stock > room`
// implies `stock + income - room > income`. The ratchet is the whole problem: an
// empire whose front is a wall of eights banks its entire income every turn for the
// rest of the game, and the number on its rail climbs into the hundreds while none
// of it can ever reach a province. Measured on the arena's largest board, v3 held
// **1497** dice in reserve before this rule existed and never spent one of them.
//
// What makes that a mistake rather than merely untidy is that a banked die is a
// **failure that has already been paid for**. A repel costs `stack - 1` dice, and
// dice the refill was going to hand back anyway are not a cost at all — so an
// over-stocked empire is declining shots on a price it is not actually paying. The
// rule is the user's, and it is arithmetic: hold a reserve up to what the empire is
// worth, one banked die per province held, and past that stop banking and take the
// shot. `overstock` is that test, and it is exactly `stock > room`.
//
// Two consequences worth stating, because both are load-bearing. The floor's field
// of admissible losing shots **widens** while over-stocked — from cap-versus-cap to
// every shot that does not pay for itself — since "take a shot" cannot mean "take a
// shot, if it happens to be the one standoff this file already knew about": a wall
// of eights facing a wall of sevens is just as frozen as two eights facing each
// other, and there is no cap-versus-cap pair in it to fire on. And the rule is
// **inert below the cap**: a reserve inside it changes nothing at all, which is what
// keeps every number in this file's measurements describing the policy that is
// actually running. Both of those are pinned in `test/bot-v3.test.js`.
//
// The board size is the reason this went unnoticed for so long, and the arena has a
// `--size` flag now because of it. On the default board a game ends before an empire
// runs out of room, so the reserve never gets past a few dice; on `huge` it reaches
// four figures. Every published number for this policy was measured on the default.
//
// ## What a failed attack really costs
//
// The other half of the re-pricing, and the one that turns out to be worth more.
//
// A capture is dice-neutral: the stack moves, one die stays behind, the defender's
// dice are destroyed. Nothing is paid. A **repel** sets the attacking province back
// to one die, so a failed attack costs `stack - 1` — seven dice off an eight-stack.
// The two outcomes are therefore wildly asymmetric, and v1 charges for neither: its
// expected value is `p * (theirs + 1) - (1 - p) * (mine - 1)`, which prices the
// downside honestly and the upside at a single die. `cheapEv` prices the upside at
// `land` plus the dice destroyed, and the downside at `risk` times what is burned.
//
// At `risk: 1` that is v1's arithmetic and the policy plays like v1. At `risk: 2` it
// declines the attack neither of them should ever make — eight dice into eight dice,
// a **27.4%** chance for a seven-die stake — and that single refusal is the largest
// number this file owns. See the escape table below; the weight is measured by
// `--sweep risk`, and the sweep is not subtle: `risk: 1` scores 61.8% against v1
// where `risk: 2` scores 69.2%, and it is the only weight here that costs double
// digits when it is wrong.
//
// ## The termination floor
//
// A policy that can decline every attack can decline forever, and this one can:
// priced at what a stack is really worth, an eight-versus-eight shot is the worst
// attack on the board and there is no reason to take it. Two seats that both decline
// it sit at the cap and stare at each other, and that is not a hypothetical — before
// the reserve rule existed, `escape: 0` against itself finished **0 of 400** games
// inside the arena's 20000-beat ceiling.
//
// So the floor is a floor in both directions: a rule that is not allowed to decline,
// with a price on that rule. Measured against v1 and v2 at 800 games and against
// itself at 400, and re-measured after the reserve rule landed — which is why it
// reads differently from the version of it in this file's history:
//
// | `escape` | who takes the shot | vs v1 | vs v2 | against itself |
// |---|---|---|---|---|
// | `0` | nobody — the ceiling | 69.8% | 60.0% | 400 of 400 |
// | `1` | everybody, as v1 does | 50.5% | 44.1% | 400 of 400 |
// | `2` | whoever is behind on the board | 60.5% | 49.6% | 400 of 400 |
// | `3` | whoever it is, if nobody has a good move left | 68.3% | 59.3% | 400 of 400 |
// | `4` | as `3`, priced at v1's cheaper rate | 69.9% | 60.1% | 400 of 400 |
//
// **The last column has stopped meaning anything, and that is the reserve rule's
// doing.** An empire at the cap is over-stocked by construction, so `over` fires on
// precisely the boards this clause was written for — two walls of eights with nothing
// profitable between them — and rolls the shot the `escape` setting was refusing.
// Every row now terminates, `0` included. So the clause is no longer what keeps a
// game ending; it is what keeps one ending on a frozen board that has *not* run out
// of room, which is the case the reserve rule cannot see and the reason `0` is not
// the default even though 69.8% is the best vs-v1 figure in the table.
//
// Read the two middle columns instead, and read them knowing that `0`, `3` and `4`
// are inside each other's intervals on both opponents — 69.8 / 68.3 / 69.9 against
// v1, 60.0 / 59.3 / 60.1 against v2. There is no measured difference between the
// three, so `3` is kept for the reason this file keeps any unmeasured tie: it is a
// strict superset of `0` in willingness, and it does not lean on the mixed price `4`
// does. Moving the default onto a 1.6-point gap would be exactly the mistake the
// `TUNING` comment above warns about.
//
// What the clause is still worth is the largest single number in this file: from row
// `1` to row `4` is nineteen points against v1 and sixteen against v2, off one rule
// about who is willing to roll a losing attack. `1` is v1's own answer — take the
// shot whenever you have one and nothing better — and 50.5% against v1 is what a
// policy with no opinion about risk gets. It is also the one thing here that is
// adversarial rather than positional: v1 rolls a cap shot about fourteen times a
// game, and a policy that simply refuses to join in collects most of those nineteen
// points without doing anything clever.
//
// `3` asks the question the rule actually wants answered — "if I decline, will
// anybody else move?" — by pricing every other living player on the same scale this
// file prices itself on, and taking the shot only when none of them has an attack
// that pays. **That the scale is the same one is not a detail, and the evidence for
// it is gone.** Pricing the rivals at v1's cheaper rate instead (`escape: 4`) used to
// finish only 394 of 400 games against itself, because this seat could be told it was
// not stuck while still declining: the rival had a profit by the loose price, so the
// escape did not fire, and the rival declined it by its own strict price. The reserve
// rule bails that out now, so `4` finishes 400 of 400 and the hazard is **masked
// rather than fixed** — two seats can still disagree about whether the table is
// frozen, and only the reserve rule's independent trigger stops that becoming a draw.
// Anyone tempted to price the rivals cheaply on the grounds that the table no longer
// complains should know that is what they are doing.
//
// `1` is v1's rule, kept as the number to beat. `2` is the obvious first guess — the
// seat that is behind should be the one to gamble — and it is wrong for a reason
// worth stating: being behind is *when you are behind*, so the rule taxes the seat
// that is losing and shields the seat that is winning, which in a heads-up game is
// the same as handing the game to whoever is ahead.

import { MAX_DICE, NEUTRAL } from '../shared/constants.js';
import { applyAttack, attackRolls, leaderOf, leads, standings, winChance } from '../shared/rules.js';
import { planAlliance as planAllianceV1 } from './bot-v1.js';

/**
 * The weights, in one place, and mutable on purpose — same contract as v2's.
 *
 * Every one of these has been swept against both opponents, and the honest summary
 * is that the weights are a plateau. `land` moves the result by 1.4 points across
 * its whole range, `province` by 2.5, `die` by 3 — all inside the confidence
 * interval of the run that measured them. The two that are not plateau are `risk`
 * and `shortfall` at the bottom of their ranges: pricing the downside at nothing
 * and pricing the refill's shortfall at nothing are both real mistakes, and both
 * cost six to eight points, so those two defaults are load-bearing and the rest are
 * where a chosen number happened to land.
 *
 * Which is the right thing to say about a set of weights that has now been swept on
 * a harness that keeps score properly, and the wrong thing to have said about the
 * same weights a session earlier — see "What the arena was measuring" in
 * `tools/bot-arena.js`. Every sweep before that one reported a flat 46–51% for
 * everything, which is what a broken scale looks like: not noisy, but *stuck*.
 */
export const TUNING = {
  /** A province, over and above the dice standing on it. */
  province: 4,
  /** One die, anywhere. */
  die: 1,
  /**
   * What a captured province is worth to the gate, beyond its stack.
   *
   * One would be v1's number. Two measured better, and the pair with `risk` is
   * what the arena runs were tuning — see `cheapEv`.
   */
  land: 2,
  /**
   * What a failed attack costs, in multiples of the dice it burns.
   *
   * The number v1 does not have, and the only weight here that costs double digits
   * when it is wrong. At 1 this is v1's arithmetic and the policy plays like v1; at
   * 2 it declines the eight-versus-eight gamble nobody should take. Measured against
   * v1: **61.8%** at 1, 69.2% at 2, 69.2% at 3, 65.8% at 4. There is nothing to
   * choose between 2 and 3 and 2 is the smaller claim, so 2 is the default.
   */
  risk: 2,
  /**
   * One die of shortfall still open after the refill.
   *
   * The weight that decides whether the policy defends or grows, because it is what
   * makes safety outrank land while a shortfall is open and gets out of the way once
   * it is closed.
   *
   * It is also the weight with the worst history in this file, and the history is
   * worth keeping because the mistake was not the number. The brief asks for safety
   * first and growth second, and the obvious way to write that is to make this
   * weight bigger than `province`; a version of this file had it at 8 and reported
   * that it measured worse than the greedy rule it falls back to, in both seats, and
   * worse the deeper the search ran. All of those were 46–49% readings from
   * `tools/bot-arena.js`, taken before its scoring was fixed, and every number it
   * produced in that period was a blend of the result and its own inverse — so the
   * readings were neither evidence for 8 nor against it. Re-measured on a harness
   * that keeps score correctly, against v1: **62.8%** at 0, 69.2% at 2, 71.0% at 4,
   * 68.4% at 8. The curve is a plateau with a soft edge, the same shape as every
   * other weight here, and 2 sits on it.
   *
   * What that leaves is the honest version of the reasoning, which is unchanged: 2
   * is half a province, so defence wins a tie and loses to a good enough chance —
   * "prefer defence to grow, but it has to grow especially if there is a good chance
   * to", which is the ordering the brief asks for and not the vocabulary a weight is
   * chosen in.
   */
  shortfall: 2,
  /**
   * Who blinks on a frozen board — v1's `stalemate` clause, and the setting with
   * the widest spread in this file.
   *
   * A cap-versus-cap shot wins 27.4% of the time for a seven-die stake, which makes
   * it close to the worst attack this file can price, and everything else here
   * refuses it until this overrides them. The override is still needed: a policy
   * that declines a board nobody can profit from can be drawn against forever, and
   * `escape: 0` against itself finishes 0 of 400 games.
   *
   * `0` nobody, `1` everybody as v1 does, `2` whoever is behind, `3` whoever it is
   * if nobody has a good move left, `4` as `3` but with the rivals priced at v1's
   * cheaper rate. All five are one line of `blinks`, and the table with the numbers
   * — nineteen points from top to bottom against v1 — is "The termination floor" in
   * the header, which is worth reading before this is changed.
   *
   * This is not the only thing that makes the floor fire, and the other one has
   * since overtaken it on the boards this table was built from. An over-stocked
   * empire blinks whatever this says — see "The reserve" in the header — and an
   * empire at the cap is over-stocked by construction, so every row of that table
   * now terminates and its last column reports nothing. It is the two win-rate
   * columns that rank the rows now, and on them `0`, `3` and `4` are tied: `3` stays
   * because it is the safest of the three, not because it scored best.
   */
  escape: 3,
  /** How many attacks ahead to search. */
  depth: 3,
  /** How many attacks to widen to at each node after the cheap pass. */
  width: 5,
  /** How many candidates survive the cheap expected-value pre-filter. */
  prefilter: 16,
  /** A hard ceiling on nodes visited, so a bad board cannot cost seconds. */
  budget: 600,
};

/* ── what the refill will do ───────────────────────────────────────────────── */

/**
 * The strongest stack facing `t` that could actually attack it.
 *
 * Neutrals are excluded, and that exclusion is not a simplification — it is the
 * first pass of the reinforcement rule, which is the pass that decides whether the
 * empire is safe. A neutral never attacks, so a province beside one is not behind
 * anything, and counting it here would report a shortfall the refill does not
 * agree exists. Allies are excluded for the same reason a pact is worth having.
 */
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

/**
 * What the end-of-turn refill will make of this board: what it pays, what it
 * costs to be safe, and whether the two are enough.
 *
 * `income` is one die per province, `need` is the total shortfall against real
 * players, `residual` is what survives the refill and `slack` is what is left
 * over when nothing does. See the header for why `residual` is exact.
 *
 * Exported because it is the whole of v3's difference and the only part of it
 * worth asserting on directly — `test/bot-v3.test.js` builds boards where the
 * answer is known by hand and checks all four numbers.
 */
export function refill(board, adjacency, me, allies = null) {
  let income = 0;
  let need = 0;

  for (let t = 0; t < board.owner.length; t++) {
    if (board.owner[t] !== me) continue;
    income++;
    const gap = threatAt(board, adjacency, t, me, allies) - board.dice[t];
    if (gap > 0) need += gap;
  }

  return { income, need, residual: Math.max(0, need - income), slack: income - need };
}

/**
 * The reserve the refill is about to hand back, and whether it is more than the
 * empire it belongs to.
 *
 * `distributeDice` is exhaustive — it places a die on every pass and the only way
 * out of the loop is running out of dice or running out of room — so what it hands
 * back is exactly `stock + income - room`, where `room` is the empty space left
 * across the empire. Every other die reaches the board. A reserve therefore only
 * persists while the empire is close to full, and once it starts persisting it
 * grows by `income - room` every turn, which is the ratchet: `stock > room` implies
 * `stock + income - room > income`, so an over-stocked empire stays over-stocked
 * and the number on the rail climbs for the rest of the game.
 *
 * The rule is the user's, and it is a rule about the *rail* before it is a rule
 * about the board: a reserve is worth holding up to what the empire is worth, one
 * banked die per province held, and past that it is a number that never reaches
 * the board. `income` cancels out of both sides — the test is equivalent to
 * `stock > room` — and the form below is the one that says what the rule is.
 *
 * Why it matters is not tidiness. A die in the reserve is not lost when an attack
 * fails, because the next refill puts it straight back; so an over-stocked empire
 * is playing with a failure that costs nothing, and banking is strictly worse than
 * the shot it is declining. That is the whole of "stocks aren't good investment".
 */
export function overstock(board, adjacency, me, allies = null, stock = 0) {
  const { income } = refill(board, adjacency, me, allies);

  let room = 0;
  for (let t = 0; t < board.owner.length; t++) {
    if (board.owner[t] === me) room += MAX_DICE - board.dice[t];
  }

  return Math.max(0, stock + income - room) > income;
}

/* ── the position score ────────────────────────────────────────────────────── */

/**
 * What a board is worth to `me`, in dice-equivalent units.
 *
 * The relative form of the first two terms is v2's argument, unchanged and still
 * right: the win condition is that everyone else is gone, so only the gap to the
 * strongest rival counts, and scoring the gap gets "attack whoever is ahead" for
 * free. The rival is the maximum rather than the sum for the same reason.
 *
 * The third term is the new one. `residual` is what the refill will still owe
 * after it has done everything it can, so a move that leaves the empire unable to
 * make itself safe is charged for it *now*, at the moment the search is choosing —
 * which is the only moment the policy can do anything about it.
 *
 * Note what that does to the shape of the search rather than just the numbers. An
 * attack out of an interior province leaves that province at 1 die facing nothing,
 * so it adds nothing to `need`; the province it takes adds one to `income`; and
 * `residual` therefore *falls*. Attacking from a dead end is not a bonus term
 * here, it is a negative cost, and it is preferred for exactly the reason the
 * brief gives — after a successful capture the ground you attacked from is inside
 * your territory and nobody has to go back for it.
 */
export function evaluate(board, adjacency, me, allies = null) {
  const rank = standings(board);
  const mine = rank.get(me);
  // Unreachable from the search — `me` is the attacker in every branch, and an
  // attacker never loses a province — so this is a guard rather than a case.
  if (!mine || mine.territories === 0) return -1e9;

  const power = (r) => r.territories * TUNING.province + r.dice * TUNING.die;

  // Winning is a position, not a jackpot — v2's comment, and the trap it
  // describes is still the one to avoid. Neutral land is not a player, so the win
  // condition is "no rival holds ground" and a single capture can end the game
  // from a board where the opponent still holds a province. Scoring that at 1e9
  // would make a one-in-a-hundred shot worth more than a certain win the slow way
  // and turn the policy into a grinder. `leader` stays zero when no rival holds
  // land, which is "nothing left against us" and nothing more.
  let leader = 0;
  for (const [id, r] of rank) {
    if (id === me) continue;
    const p = power(r);
    if (p > leader) leader = p;
  }

  const { residual } = refill(board, adjacency, me, allies);

  return power(mine) - leader - TUNING.shortfall * residual;
}

/* ── the search ────────────────────────────────────────────────────────────── */

/**
 * Every attack `me` could legally make from this board.
 *
 * Allies are excluded here rather than left to `evaluate`, because attacking one
 * is not a move the policy may consider at all — legal in the rules, occasionally
 * right for a human, but a bot breaking its own pact on a whim is noise, and v1
 * does not do it either.
 *
 * The cheap pass prices the two outcomes by what the **score** will say about
 * them, which is a *relative* question and not an absolute one — the score is
 * `mine - the strongest rival's`, so a die taken off the opponent is worth exactly
 * as much as a die gained, and the enemy's stack vanishing into a capture is a
 * real gain even though nothing of it changes hands.
 *
 *   - a capture is worth the land **twice**, plus the defending stack, which is
 *     destroyed;
 *   - a repel costs every die the stack attacked with, which is `dice - 1`.
 *
 * The doubling is the part that is easy to get wrong and was wrong here first. The
 * score is `power(mine) - power(leader)`, so a capture moves it twice: the province
 * arrives on my side of the subtraction *and* leaves the leader's. Deriving it from
 * `evaluate` rather than from intuition gives `+province` for mine, `-province` and
 * `-theirs` for theirs, and `-dice + 1` for a repel — so the capture term is
 * `2 * province + theirs`, and this pass used to price it at `province + theirs`.
 * That under-rated exactly the attacks most worth making, since the missing term is
 * `p * province` and it is largest where `p` is.
 *
 * This is v1's formula with the numbers changed — v1 prices the land at 1 and does
 * not count the defender's loss at all — and the defender's-dice term is worth
 * stopping on, because v2's header calls it a phantom credit. In absolute terms it
 * is: those dice are destroyed and the attacker's own total does not move. But the
 * score is a difference, and in a difference the term is real. Where the two
 * readings genuinely part company is a three-way table, where the loser of the dice
 * may not be the rival the score is measuring against — see `evaluate`'s note on
 * the leader. For a heads-up game they agree, and this pass is only a filter.
 *
 * What it deliberately does **not** price is reinforcement, and that is not an
 * oversight: the reinforcement cost of an attack is a property of the whole board,
 * and charging a local estimate of it here as well as the true cost in `evaluate`
 * would count it twice. All this pass has to do is not throw the winner away.
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
      // The gate, and the whole of v3's edge: an attack is only a *candidate* if
      // the win pays for the loss at `risk` to one. See "What a failed attack
      // really costs" in the header — the short version is that v1, v2 and v3's
      // own search all take a 50/50 shot at eight-versus-eight, and that shot
      // costs seven dice nearly half the time.
      if (affordable(p, theirs, dice)) out.push({ from, to, p, ev: cheapEv(p, theirs, dice) });
    }
  }

  return out;
}

/**
 * The expected value of one attack, with the downside priced at `risk` to one.
 *
 * v1's formula is this with `land` and `risk` both 1, and that is the whole of
 * the difference: `value = theirs + 1` prices a captured province at one die and
 * a failed attack at exactly the dice it burns. Both numbers are wrong, and the
 * second one is wrong by more.
 *
 * `land` is what a province is worth beyond the stack standing on it — it pays a
 * die every turn for the rest of the game, so it is worth more than one, though
 * the measurement insists not much more.
 *
 * `risk` is the multiplier on the loss, and it is not a fudge factor. A die lost
 * now is worth more than a die gained now, because dice compound: fewer dice
 * means fewer captures next turn, which means a smaller income the turn after.
 * A linear position score cannot express this — for an eight-versus-eight shot it
 * returns `land + 0.5` dice of profit for *any* land weight, so v1, v2 and v3 all
 * take it. This is the smallest change that can say no.
 *
 * Measured against v1 over 1200–1500 games, `land: 2, risk: 2` scores 62.0% and
 * `land: 1, risk: 3` scores 63.7%, where v1's own numbers (land 1, risk 1) score
 * 50.5% — the control, and the reason those figures are believable.
 */
function cheapEv(p, theirs, dice) {
  return p * (TUNING.land + theirs) - TUNING.risk * (1 - p) * (dice - 1);
}

/** Is this attack worth making at all, at the measured price? */
function affordable(p, theirs, dice) {
  return cheapEv(p, theirs, dice) > 0;
}

/**
 * The price of one attack, from the two stack sizes — `cheapEv` with the win
 * chance computed for you.
 *
 * Exported for the same reason v1 exports `moveValue`: it makes the policy's
 * opinion checkable from outside without building a board, so a test can assert
 * that a declination was *priced* rather than merely that it happened.
 */
export function moveValue(mine, theirs) {
  return cheapEv(winChance(attackRolls(mine), theirs), theirs, mine);
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
 * v2's expectimax with a beam, unchanged in shape: a cheap pass to discard the
 * hopeless candidates, a scoring pass over the survivors that pays for
 * `evaluate` on both chance outcomes, and a recursion into the best `width` of
 * those, one attack deeper. `value` starts at `evaluate(board)` — the position as
 * it stands, which is what declining every attack would leave — so a move is only
 * recorded when it beats doing nothing, and `move` comes back null when none
 * does.
 *
 * Ties keep the earliest candidate, so the same board always produces the same
 * plan. Nothing here consults a clock or a random source.
 */
function bestLine(board, adjacency, me, allies, depth, budget) {
  const stop = evaluate(board, adjacency, me, allies);
  let value = stop;
  let move = null;

  if (depth <= 0 || budget.nodes >= TUNING.budget) return { value, move };

  const options = attacksFrom(board, adjacency, me, allies);
  if (options.length === 0) return { value, move };

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

    // A capture keeps the turn, so it is searched one attack deeper exactly as
    // the driver will re-ask after the real roll; a repel collapses that stack but
    // leaves every other one standing, so it is searched too rather than scored
    // flat. Both get the same depth: the outcome that ends a stack is not the
    // outcome that ends the turn.
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
 * Does `owner` have any attack on this board that pays for itself?
 *
 * The same price this file charges itself, asked about somebody else. Early
 * return on the first one found, because the only answer wanted is whether one
 * exists and the first province scanned usually has it.
 */
function hasProfit(board, adjacency, owner, loose = false) {
  for (let from = 0; from < board.owner.length; from++) {
    if (board.owner[from] !== owner) continue;

    const mine = board.dice[from];
    if (mine < 2) continue;

    const thrown = attackRolls(mine);
    for (const to of adjacency[from]) {
      const defender = board.owner[to];
      if (defender === null || defender === owner) continue;

      const theirs = board.dice[to];
      const p = winChance(thrown, theirs);
      // `loose` is v1's price — a province worth `theirs + 1` and a failure worth
      // the dice it burns and nothing more. It is the cheapest estimate of an
      // attack anywhere in `server/`, since v2's pre-filter is the same formula,
      // so a board where even this finds nothing is a board nobody in this
      // codebase would move on.
      const ev = loose
        ? p * (1 + theirs) - (1 - p) * (mine - 1)
        : cheapEv(p, theirs, mine);
      if (ev > 0) return true;
    }
  }
  return false;
}

/**
 * Is the whole table out of good moves?
 *
 * The question the escape actually wants answered is "if I decline, will
 * somebody else move?", and this is the closest a stateless policy can get to it
 * from the board alone: every other living player is priced on the same scale
 * this file prices itself on, and if none of them has an attack that pays, the
 * position is frozen and the shot has to be taken by somebody.
 *
 * What it cannot see is the opponent's *rule*. A seat that will roll a cap shot
 * out of its own stubbornness is a seat this test calls stuck, which is the
 * caution in the right direction for the games this file can actually play: it
 * gambles a beat earlier than strictly needed rather than a beat too late, and a
 * policy that never gambles spends the rest of the game not finishing.
 *
 * Neutrals are excluded because they never take a turn — land nobody will ever
 * move from is not the table being alive, it is the table being stuck with more
 * provinces in it.
 */
function stuck(board, adjacency, playerId, loose) {
  const owners = new Set();
  for (const owner of board.owner) {
    if (owner !== null && owner !== NEUTRAL && owner !== playerId) owners.add(owner);
  }
  for (const owner of owners) {
    if (hasProfit(board, adjacency, owner, loose)) return false;
  }
  return true;
}

/**
 * Whether this policy will take a shot it has already priced as a loss.
 *
 * Also the termination floor. A policy that always declines a frozen board is a
 * policy that can be drawn against, and the arena reports those as unfinished
 * rather than won — so this is a setting with a floor under it as well as a
 * ceiling over it, and both ends are measured. See "The termination floor" in
 * the header for the numbers.
 *
 * `over` is the second reason to blink and it is not the same question. `stuck`
 * asks about the *table* — has everyone else run out of good moves, so the shot
 * has to be taken by somebody? — and an over-stocked empire blinks for a reason
 * entirely its own: it is the one who can afford the shot, so the question of who
 * else can is moot. It is checked first because it is not a tie-break among the
 * `escape` settings but a separate trigger, and it fires whatever `escape` says.
 *
 * **That turned out to matter more than a second trigger usually would**, and the
 * measurement is worth keeping because it is the sort of thing that is invisible
 * until somebody runs it. Every `escape` setting now finishes 400 of 400 games
 * against itself, including `0`, which used to finish none: the boards this clause
 * was written for — two empires at the cap, staring at each other — are exactly the
 * boards where an empire has run out of room, so the reserve rule reaches them on
 * its own and rolls the shot the `escape` setting was refusing. The self-play
 * column of the table in the header therefore no longer separates the rows, and the
 * ordering between them now rests on the two win-rate columns alone.
 */
function blinks(board, adjacency, playerId, over) {
  if (over) return true;
  if (TUNING.escape === 0) return false;
  if (TUNING.escape === 1) return true;
  if (TUNING.escape === 2) return leaderOf(board) !== playerId;
  if (TUNING.escape === 4) return stuck(board, adjacency, playerId, true);
  return stuck(board, adjacency, playerId, false);
}

/**
 * The termination floor: v1's scan, priced with v3's numbers.
 *
 * v1's shape down to the tie-break, and deliberately so — this is the rule that
 * is guaranteed to be willing to move, and any cleverness added here is
 * cleverness that can decline. Two things differ. The EV is `cheapEv`, so a shot
 * that risks more than it can pay for is not a candidate here either; and the
 * stalemate escape is kept verbatim, which is what makes termination an argument
 * rather than a hope. Two provinces facing each other at `MAX_DICE` cannot
 * improve, cannot be reinforced, and would leave two policies that both decline
 * them frozen for the rest of the game; the exception fires, one of them rolls,
 * and the board moves.
 *
 * The leader-first tie-break is v1's too, and it is kept because it is *not* a
 * tie-break in the neutral sense: among shots the rule likes equally, it spends
 * them on whoever is ahead. That is the only place this file cares about the
 * standings rather than the board.
 */
function greedyMove(board, adjacency, playerId, allies, stock) {
  const rank = standings(board);
  const over = overstock(board, adjacency, playerId, allies, stock);
  let best = null;
  // Shots every other rule in this file refuses: they pay less than they cost,
  // and they are only on the table at all because something has to give. Two
  // reasons qualify one, and they admit different fields.
  //
  // A cap-versus-cap standoff is the one this file has always had: two `MAX_DICE`
  // provinces facing each other cannot improve and cannot be reinforced, so if
  // both sides decline them the game is a draw. That is a statement about the
  // *board* — the shot is admissible because no better shot exists anywhere,
  // which is why the field is narrow.
  //
  // An over-stocked empire qualifies a shot on a different ground: it can pay for
  // one, and declining pays it nothing. Its reserve is past the point where the
  // refill can spend it, so a failed attack is refunded in full next turn and the
  // dice banked instead would never have reached the board. The field is therefore
  // every shot that does not pay for itself, not only the capped ones — and the
  // cap-versus-cap case is a subset of it, since an empire whose provinces are all
  // at `MAX_DICE` is over-stocked by construction whenever it holds anything back.
  // Widening to the whole losing field matters because the standoff is not the only
  // way to be out of good moves: a wall of eights facing a wall of sevens has no
  // cap-versus-cap pair in it and is just as frozen.
  let gamble = null;

  for (let from = 0; from < board.owner.length; from++) {
    if (board.owner[from] !== playerId) continue;

    const mine = board.dice[from];
    if (mine < 2) continue;

    const thrown = attackRolls(mine);
    for (const to of adjacency[from]) {
      const defender = board.owner[to];
      if (defender === null || defender === playerId || allies?.has(defender)) continue;

      const theirs = board.dice[to];
      const p = winChance(thrown, theirs);
      const ev = cheapEv(p, theirs, mine);

      if (ev <= 0) {
        const capped = mine === MAX_DICE && theirs === MAX_DICE;
        if ((capped || over) && (gamble === null || ev > gamble.ev
          || (ev === gamble.ev && leads(rank, defender, gamble.defender)))) {
          gamble = { from, to, ev, defender };
        }
        continue;
      }

      const better = best === null || ev > best.ev
        || (ev === best.ev && leads(rank, defender, best.defender));
      if (better) best = { from, to, ev, defender };
    }
  }

  // `best` first, and over-stocked or not: the reserve buys a *shot*, not a bad
  // one, so a profitable attack still outranks a losing one and the widening above
  // only decides what happens when there is nothing profitable left to do.
  if (best) return { from: best.from, to: best.to };
  if (!gamble || !blinks(board, adjacency, playerId, over)) return null;
  return { from: gamble.from, to: gamble.to };
}

/**
 * The move to make, or null to end the turn.
 *
 * Same signature and same contract as v1's and v2's, so the driver treats all
 * three interchangeably and `tools/bot-arena.js` can seat any of them. The two
 * trailing arguments are v3's own and are both optional: v1 and v2 ignore them,
 * every caller that predates them keeps its behaviour exactly, and a caller that
 * omits `stock` gets an empire with an empty reserve, which is never over-stocked
 * — so the rule below is inert until somebody passes the number that turns it on.
 *
 * `stock` is the one piece of state the policy cannot read off the board. It is
 * not a concession to impurity: the board is what it always was, and the reserve
 * is a number the server already publishes on the rail. `overstock` is a statement
 * about both, and there is no board-only formulation of it — the reserve is
 * exactly the part of a player's position that the board does not show.
 */
export function planMove(board, adjacency, playerId, allies = null, stock = 0) {
  const line = bestLine(board, adjacency, playerId, allies, TUNING.depth, { nodes: 0 });
  if (line.move) return { from: line.move.from, to: line.move.to };

  // The termination floor, and the second place the risk price is charged. See
  // the header.
  return greedyMove(board, adjacency, playerId, allies, stock);
}

/**
 * Diplomacy is v1's, unchanged — and re-exported rather than copied, so there is
 * one of it. v2's reasoning applies verbatim: the diplomatic policy is a short
 * list of stated rules, and the interesting question is whether the rules are
 * right, not whether they can be computed more cleverly. v3's edge is in the
 * military game.
 */
export const planAlliance = planAllianceV1;

/* ── the measurement ───────────────────────────────────────────────────────── */

// The numbers this shipped on live in the README's bots section, next to v1's and
// v2's, so that all three are read off one page and none of them can be quietly
// restated. The harness is `node tools/bot-arena.js`, and the controls that make its
// output worth believing are `--sweep` on any weight (does the number do anything
// at all?) and `--seats 1,1` (does an all-v1 table still split about evenly across
// seats?). **Read the heading on that file before trusting a number out of it** —
// it had a scoring bug for most of this policy's life, and the shape of what that
// looked like is worth recognising again.
//
// Two things worth recording for whoever tunes this next. The beam is not where
// v3's gain is: `depth`, `width`, `prefilter` and `budget` are v2's numbers,
// deliberately, because the claim here is about the position score and a search
// retuned at the same time would make it impossible to say which of the two moved
// the result — measured afterwards, the search is worth about eight points against
// v1 and the position score and escape rule the rest. And every weight in `TUNING`
// above sits on a plateau; if a future change is justified by a sweep of two or
// three points, it has been justified by noise.
