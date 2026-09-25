// Pure game rules for Dice Wars. No imports beyond constants, no I/O, no state.
//
// Every function here takes the state it needs as arguments and (with the
// explicit exception of the `apply*` functions) returns a value rather than
// mutating. That is what lets `test/rules.test.js` drive the whole rule set
// headlessly with a stubbed RNG.
//
// A `board` is `{ owner: playerId[], dice: number[] }`, both indexed by
// territory id. `adjacency` is `number[][]`, indexed by territory id.
//
// Combat here is NOT Risk-style pairwise dice sorting. Each side rolls a number
// of dice, the pips are summed, and the higher total wins — ties go to the
// defender. The defender rolls its whole stack; the attacker rolls one die fewer
// than its stack, because the die that stays home on a win does not fight. See
// `attackRolls` and `resolveAttack`.

import { ERR, MAX_DICE, NEUTRAL } from './constants.js';

/** How many territories a player owns. */
export function territoryCount(board, playerId) {
  let n = 0;
  for (let i = 0; i < board.owner.length; i++) {
    if (board.owner[i] === playerId) n++;
  }
  return n;
}

/**
 * The size of the player's largest connected group of territories.
 *
 * **This is no longer what reinforcement pays.** The payout is `territoryCount` —
 * one die per province held, scattered or not — so nothing in the running game
 * calls this any more.
 *
 * It is kept because it is the rule this game was first built on and the two
 * formulas are a one-line swap away from each other, and because the tests that
 * pin its behaviour are the ones that would catch a flood fill going wrong. If
 * the payout is ever switched back, this is what it goes back to. Nothing should
 * start depending on it without a reason.
 *
 * Returns 0 when the player owns nothing.
 */
export function largestGroup(board, adjacency, playerId) {
  const n = board.owner.length;
  const seen = new Uint8Array(n);
  let best = 0;

  for (let start = 0; start < n; start++) {
    if (seen[start] || board.owner[start] !== playerId) continue;

    // Iterative flood fill — no recursion, so a large blob can't blow the stack.
    let size = 0;
    const stack = [start];
    seen[start] = 1;

    while (stack.length > 0) {
      const t = stack.pop();
      size++;
      for (const nb of adjacency[t]) {
        if (!seen[nb] && board.owner[nb] === playerId) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }

    if (size > best) best = size;
  }

  return best;
}

/* ── who is ahead ──────────────────────────────────────────────────────────── */

/**
 * How far ahead each player is, for ranking them: territories first, then the
 * dice standing on them.
 *
 * Territories are the better measure of "advanced" because they are both what
 * reinforcement pays and what winning is counted in; dice break the case where two
 * players hold the same number of provinces and one has spent more holding them.
 *
 * Exported because two callers need the whole ranking rather than only the
 * winner of it: `leaderOf` below, and the bot policy's tie-break between two
 * moves of equal value.
 */
export function standings(board) {
  const rank = new Map();

  for (let i = 0; i < board.owner.length; i++) {
    const owner = board.owner[i];
    // Null is water. NEUTRAL is deliberately skipped rather than ranked: it holds
    // every province no player was dealt, so on a default 30-province board it
    // owns 20 of them and would win the tie-break against a real opponent every
    // single time — the opposite of what the tie-break is for.
    if (owner === null || owner === NEUTRAL) continue;

    const entry = rank.get(owner) ?? { territories: 0, dice: 0 };
    entry.territories++;
    entry.dice += board.dice[i];
    rank.set(owner, entry);
  }

  return rank;
}

/** Is `a` further ahead than `b`? Unknown owners rank last. */
export function leads(rank, a, b) {
  const ra = rank.get(a) ?? { territories: 0, dice: 0 };
  const rb = rank.get(b) ?? { territories: 0, dice: 0 };
  return ra.territories !== rb.territories ? ra.territories > rb.territories : ra.dice > rb.dice;
}

/**
 * The most advanced player on the board: territories first, then dice.
 *
 * This is the "most advanced player" of the alliance rules, and it is a property
 * of the board alone — no exclusion parameter, deliberately. A bot that *is* the
 * leader has nobody to exclude, so it asks and accepts as freely as anyone; the
 * reading "the most advanced *other* player" would have a leader-bot refuse to
 * ally the runner-up, which is not the rule.
 *
 * Ties go to the first owner in scan order, so "the most advanced player" names
 * exactly one seat and the rules are well defined. Null when nobody owns
 * anything, which is only reachable on a board that has not been dealt.
 *
 * Lives here rather than in the bot policy that first needed it, because it is a
 * rule and not a policy: the snapshot publishes it so the rail can mark the seat
 * the bots are treating as the one to beat, and those two must not be able to
 * drift apart.
 */
export function leaderOf(board) {
  const rank = standings(board);
  let best = null;

  for (const id of rank.keys()) {
    if (best === null || leads(rank, id, best)) best = id;
  }

  return best;
}

/**
 * Validates a proposed attack. Returns `true` when legal, otherwise
 * `{ error }` with the most specific useful error code.
 *
 * Check order matters: index validity before ownership, ownership before
 * adjacency, adjacency before dice count — so the message a player sees is the
 * one that actually explains their mistake.
 *
 * `NOT_PLAYABLE` sits with `OWN_TERRITORY`, ahead of the adjacency test. A void
 * is rejected on its own merits whether or not it happens to touch the attacker:
 * "that space is impassable" is a better answer than "not adjacent" for a lake
 * the player can see perfectly well, and the reason is the same either way.
 * This check is load-bearing — an unowned territory is not owned by anyone, so
 * without it every void passes every remaining check and is captured for free.
 */
export function canAttack(board, adjacency, from, to, playerId) {
  const n = board.owner.length;

  if (!Number.isInteger(from) || !Number.isInteger(to)) return { error: ERR.BAD_REQUEST };
  if (from < 0 || from >= n || to < 0 || to >= n) return { error: ERR.BAD_REQUEST };
  if (from === to) return { error: ERR.BAD_REQUEST };

  if (board.owner[from] !== playerId) return { error: ERR.NOT_OWNER };
  if (board.owner[to] === playerId) return { error: ERR.OWN_TERRITORY };
  if (board.owner[to] == null) return { error: ERR.NOT_PLAYABLE };
  if (!adjacency[from].includes(to)) return { error: ERR.NOT_ADJACENT };
  if (board.dice[from] < 2) return { error: ERR.TOO_FEW_DICE };

  return true;
}

/**
 * P(the sum of `n` six-sided dice equals k), as a Float64Array indexed by k and
 * therefore of length 6n + 1.
 *
 * Built by convolving the single-die distribution n times. Memoised because the
 * bot scores every legal move and would otherwise rebuild the same table on each
 * one.
 */
const SUM_DISTRIBUTIONS = new Map();

export function diceSumDistribution(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`diceSumDistribution needs a non-negative integer, got ${n}`);
  }

  const cached = SUM_DISTRIBUTIONS.get(n);
  if (cached) return cached;

  let dist = new Float64Array(1);
  dist[0] = 1; // the empty sum is 0 with probability 1

  for (let die = 0; die < n; die++) {
    const next = new Float64Array(dist.length + 6);
    for (let s = 0; s < dist.length; s++) {
      const p = dist[s];
      if (p === 0) continue;
      for (let face = 1; face <= 6; face++) next[s + face] += p / 6;
    }
    dist = next;
  }

  SUM_DISTRIBUTIONS.set(n, dist);
  return dist;
}

/**
 * Exact P(attacker wins), i.e. P(sum of n dice is STRICTLY greater than sum of
 * m dice). Ties go to the defender, which is exactly why the inner loop is
 * `j < i` rather than `j <= i`.
 *
 * This is the closed form behind `resolveAttack`, so a test can compare the two
 * against each other instead of against a hardcoded figure someone typed.
 */
const WIN_CHANCES = new Map();

export function winChance(n, m) {
  const key = `${n},${m}`; // a string key cannot collide at any stack size
  const cached = WIN_CHANCES.get(key);
  if (cached !== undefined) return cached;

  const a = diceSumDistribution(n);
  const b = diceSumDistribution(m);
  let p = 0;

  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    if (pa === 0) continue;
    // `b` is shorter than `a` whenever n > m, so every j past its end is a
    // defender total that simply cannot be reached — probability zero.
    for (let j = 0; j < i; j++) p += pa * (b[j] ?? 0);
  }

  WIN_CHANCES.set(key, p);
  return p;
}

/**
 * How many dice an attacking stack actually throws.
 *
 * One fewer than the stack: the die that stays home on a win does not fight. A
 * 7-stack attacks with 6. `canAttack` still demands 2 dice, so the weakest legal
 * attack throws 1.
 *
 * This lives here rather than as a `- 1` at each call site because the server and
 * the bot's win-chance model must agree on it; two independent decrements are two
 * chances to drift apart.
 */
export function attackRolls(stack) {
  return stack - 1;
}

/**
 * Rolls an attack and decides the outcome. Does not touch the board.
 *
 * `attackerDice` and `defenderDice` are the numbers of dice each side THROWS, not
 * the sizes of their stacks — for the attacker that is `attackRolls(stack)`, for
 * the defender its whole stack. The attacker takes the territory only on a
 * strictly greater sum; a tie is a successful defence.
 *
 * RNG is consumed attacker-first, then defender, so a seeded run replays
 * exactly.
 */
export function resolveAttack(rng, attackerDice, defenderDice) {
  const attackerRolls = [];
  for (let i = 0; i < attackerDice; i++) attackerRolls.push(rng.d6());

  const defenderRolls = [];
  for (let i = 0; i < defenderDice; i++) defenderRolls.push(rng.d6());

  let attackerSum = 0;
  for (const r of attackerRolls) attackerSum += r;
  let defenderSum = 0;
  for (const r of defenderRolls) defenderSum += r;

  return {
    attackerRolls,
    defenderRolls,
    attackerSum,
    defenderSum,
    captured: attackerSum > defenderSum,
  };
}

/**
 * Applies a resolved attack to the board, in place.
 *
 * Capture: the defender's stack is destroyed outright, ownership flips, and the
 * attacker moves all but one of its dice forward, leaving exactly 1 behind. The
 * two territories go from N + M dice to (N - 1) + 1 = N, so the defender's M
 * dice are removed from the board. Dice are NOT conserved — wiping out the
 * defending stack is the point of winning the roll.
 *
 * Repelled: the attacking stack collapses to exactly 1. The attacker's extra
 * dice are destroyed rather than withdrawn — that is the real cost of a failed
 * attack, and it is why attacking from a large stack is a genuine gamble.
 */
export function applyAttack(board, from, to, captured) {
  if (captured) {
    const moved = board.dice[from] - 1;
    board.owner[to] = board.owner[from];
    board.dice[to] = moved;
    board.dice[from] = 1;
  } else {
    board.dice[from] = 1;
  }
}

/**
 * The strongest stack on one territory's border, under the two different
 * questions the placement rules ask of a border. Both are maxima, not sums, and
 * that distinction is half the rule: a province walled in by two 5s is not in
 * more danger than one facing a single 6, because it is the strongest single
 * neighbour that will roll against it.
 *
 * `enemy` counts only players who can actually attack you. Water is not one — a
 * void has `owner: null`, and its `dice` is 0 anyway, so both are excluded here
 * because this number decides where every die goes and being wrong is silent.
 *
 * **Neutrals are not one either.** A neutral province never attacks; it only
 * ever sits and grows. A border facing one is not a front, so it is not something
 * to hold, and counting neutral dice here would drain reinforcement into a wall
 * that will never move — on exactly the boards that have the most neutrals. This
 * is the number the defence rule uses, so it is the one that decides what "behind"
 * means.
 *
 * `widest` counts everything that is not you and not water, neutrals included. It
 * answers a different question: not *what must I match*, but *what is worth
 * matching*. A province facing a tall neutral is the best place to build up,
 * because that is where the next conquest is — so once every shortfall against a
 * real player is closed, the neutrals that counted for nothing become the
 * shortfalls the leftover dice are measured against, and this is the number that
 * measures them.
 *
 * With no neutral land on the board the two are equal.
 *
 * **An ally counts for neither.** `allies` is the set of player ids this player
 * is allied with, or null for nobody. A pact is a promise that neither side will
 * attack the other, so an ally's stack cannot be something that "will roll
 * against you" — and for the same reason it is not somewhere growth is worth
 * having, so it is skipped on the `widest` side too. Counting an ally in either
 * number would drain reinforcement onto a front that never moves, which is
 * exactly the failure the neutral comment above warns about.
 *
 * The exclusion is the same one water and your own land already get, and that is
 * the cleanest way to say it: an ally's provinces are treated as if they were
 * yours. Note what that does *not* buy — it removes the attraction, not the
 * eligibility. A province facing only allies still has somewhere to put a die,
 * so in the final surplus pass it is a candidate like any other. The die has to
 * land somewhere.
 */
function borderStacks(board, adjacency, territory, playerId, allies = null) {
  let enemy = 0;
  let widest = 0;

  for (const n of adjacency[territory]) {
    const owner = board.owner[n];
    if (owner === null || owner === playerId || allies?.has(owner)) continue;

    const d = board.dice[n];
    if (d > widest) widest = d;
    if (owner !== NEUTRAL && d > enemy) enemy = d;
  }

  return { enemy, widest };
}

/**
 * Is `a` the better home for the next die than `b`?
 *
 * The tier is most of the ordering, and there are three of them:
 *
 *   0. behind a *player* who can attack us — the shortfall is real, and closing
 *      it is what reinforcement is for;
 *   1. behind a *neutral* — not a threat while there is any defending to do, but
 *      the frontier the next conquest starts from, so this is where the leftover
 *      goes once nothing real is open;
 *   2. behind nothing — level with everything that borders it, so the die is
 *      genuinely surplus and gets shared out rather than stacked.
 *
 * Tier 2 is reached only when no province sits in a lower one, which is what
 * makes neutral land a threat *only* during the spread: while any player's stack
 * is short, tiers 0 and 1 cannot be reached at all.
 *
 * Within tiers 0 and 1 the deeper shortfall wins, so the dice dig in where they
 * are needed most. Tier 2 inverts that deliberately — it counts the spare dice
 * each province has already taken and prefers the one that has had fewest, so a
 * surplus is spread one each before anyone gets a second.
 *
 * Ties fall through to the lowest territory id, which is what keeps the whole
 * function deterministic: the same board and stock always place identically.
 */
function outranks(a, b) {
  if (a.tier !== b.tier) return a.tier < b.tier;

  if (a.tier === 0) {
    return a.gap > b.gap
      || (a.gap === b.gap && a.enemy > b.enemy)
      || (a.gap === b.gap && a.enemy === b.enemy && a.id < b.id);
  }

  if (a.tier === 1) {
    return a.ngap > b.ngap
      || (a.ngap === b.ngap && a.widest > b.widest)
      || (a.ngap === b.ngap && a.widest === b.widest && a.id < b.id);
  }

  return a.taken < b.taken
    || (a.taken === b.taken && a.widest > b.widest)
    || (a.taken === b.taken && a.widest === b.widest && a.id < b.id);
}

/**
 * Deals a player's reserve out onto the territories that are behind, mutating
 * the board and returning what happened.
 *
 * "Behind" means a stack smaller than the biggest stack it could be attacked
 * from, and the shortfall is by how much. Each die goes to the deepest one, one
 * at a time, so the ranking is re-evaluated as the dice land: a province topped up
 * to parity stops being a candidate and the next die moves on. That is what keeps
 * reinforcement from piling a whole reserve onto one province.
 *
 * Worked example: A holds 5 against neighbours of 6 and 5 (gap 1), B holds 4
 * against 3 and 5 (gap 1). With 2 dice, A takes the first — the gaps tie and A
 * faces the bigger stack — reaching 6 and a gap of 0, so the second die goes to
 * B.
 *
 * **Who counts as a threat changes between the phases, and that is the point.**
 * While any province is short of a real player, only real players count: a neutral
 * never attacks, so a province beside a neutral 8 is not behind at all and gets
 * nothing. The moment that is settled — every player's border at parity — the
 * neutrals become the measure instead, and the leftover dice are spent closing the
 * gap against *them*. Only when those are level too is there anything left over,
 * and that is spread evenly.
 *
 * So there are three passes over the same border, answering "what must I match"
 * with ever-widening answers: the player who can hit me, then the neutral I want to
 * take, then nothing at all. A province facing a tall neutral is idle through the
 * first and the *first in line* through the second.
 *
 * Returns the untouched stock as `left` when every territory is already at the
 * cap; the caller keeps that in the reserve for a future turn.
 *
 * `allies` is this player's set of allied player ids, or null/omitted for
 * nobody — see `borderStacks`, which is where it changes the answer. It takes a
 * bare `Set` rather than a player object on purpose: this module is pure and
 * never learns what a player is, and `null` and an empty set place identically,
 * which is what lets every caller that predates alliances keep working
 * untouched.
 */
export function distributeDice(board, adjacency, playerId, stock, allies = null) {
  const territories = [];
  // Spare dice each province has already taken on this call, so the surplus can
  // go one each rather than piling onto whichever province ranks first.
  const spare = new Map();
  let left = stock;

  // One die per pass, re-ranking each time, so this runs once per die placed and
  // stops the moment every province is at the cap. That ceiling is what keeps the
  // naive form affordable: a reserve is at most a turn's reinforcement — the
  // player's territory count — plus whatever earlier turns could not fit, and an
  // incremental ranking structure would be buying speed this loop does not need
  // in exchange for state that could drift out of sync with the board.
  while (left > 0) {
    let pick = -1;
    let pickRank = null;

    for (let t = 0; t < board.owner.length; t++) {
      if (board.owner[t] !== playerId || board.dice[t] >= MAX_DICE) continue;

      const { enemy, widest } = borderStacks(board, adjacency, t, playerId, allies);
      const gap = enemy - board.dice[t];
      const ngap = widest - board.dice[t];

      const rank = {
        id: t,
        tier: gap > 0 ? 0 : ngap > 0 ? 1 : 2,
        gap,
        enemy,
        ngap,
        widest,
        taken: spare.get(t) ?? 0,
      };

      if (pick === -1 || outranks(rank, pickRank)) {
        pick = t;
        pickRank = rank;
      }
    }

    // Every territory is at the cap; the reserve waits for a future turn.
    if (pick === -1) break;

    board.dice[pick]++;
    left--;
    territories.push(pick);

    // Only a die that was surplus counts. One that closed a shortfall — against a
    // player or against a neutral — is not surplus, and counting it would make a
    // province that had just reached parity look like it had already had its
    // share of the extras.
    if (pickRank.tier === 2) spare.set(pick, pickRank.taken + 1);
  }

  return { placed: territories.length, left, territories };
}

/**
 * Adds `gain` dice to a player's reserve, in place. The reserve is uncapped.
 *
 * There is deliberately no ceiling. Dice you have earned are yours to keep, and
 * they are held rather than lost when every territory you own is already at
 * MAX_DICE — which is the only way the reserve ever grows past one turn's
 * reinforcement. What stops a large hoard from being an instant win is the
 * payout rate, not an arbitrary cap: a single territory absorbs at most
 * MAX_DICE - 1 dice per End Turn, so a hundred held dice still take a dozen
 * turns to land.
 */
export function bankDice(player, gain) {
  player.stock = (player.stock ?? 0) + gain;
}

/**
 * The next seat in the rotation, skipping eliminated players and wrapping.
 * Returns `fromIndex` only if nobody at all is alive, which the win check
 * pre-empts in practice.
 */
export function nextTurnIndex(players, fromIndex) {
  for (let step = 1; step <= players.length; step++) {
    const i = (fromIndex + step) % players.length;
    if (!players[i].eliminated) return i;
  }
  return fromIndex;
}

/** The winning player's id once exactly one player remains, else null. */
export function checkWin(players) {
  let alive = null;
  let aliveCount = 0;
  for (const p of players) {
    if (!p.eliminated) {
      alive = p;
      aliveCount++;
      if (aliveCount > 1) return null;
    }
  }
  return aliveCount === 1 ? alive.id : null;
}

/** Recomputes every player's eliminated flag from the board. */
export function refreshEliminated(board, players) {
  const counts = new Map(players.map((p) => [p.id, 0]));
  for (const ownerId of board.owner) {
    if (counts.has(ownerId)) counts.set(ownerId, counts.get(ownerId) + 1);
  }
  for (const p of players) {
    p.eliminated = counts.get(p.id) === 0;
  }
  return counts;
}
