#!/usr/bin/env node
// A bot arena: play the policies against each other on real boards and count who
// wins.
//
// Why this exists. "v2 is stronger than v1" is a claim, and a claim about a game
// policy is worth exactly as much as the games behind it. Reading the code and
// deciding that v2's arithmetic looks better is how you ship a bot that is
// cleverer and worse — and that failure is invisible, because a bot that plays
// badly still plays, and nothing in the test suite says "this one should have
// won". So the policies are seated at a real table, on real generated boards,
// with the real rules, and the score is kept.
//
// The claim it tests is narrow on purpose: **v2 beats v1 more often than not,
// heads-up, over many boards.** It is not a claim about strength against a
// human, which nothing in this repository can measure.
//
// Fidelity is the point, so this drives the same modules the server does —
// `startGame`, `attack`, `endTurn`, and the alliance dispatch from
// `server/alliances.js`, which is exactly what the server's bot tick calls.
// Nothing here reimplements a rule. What it *does* replace is the clock: the
// server plays one beat per `BOT_DELAY_MS` and this plays a whole game as fast as
// it can, which is the only difference between an arena game and a real one.
//
// What it deliberately does NOT do is give either side a better view. Both
// policies are handed a board and a set of allies, the same arguments the server
// passes, so a policy that wanted to cheat would have to cheat inside its own
// file where the tests can see it.
//
// Usage:
//   node tools/bot-arena.js                     # 200 heads-up games, v1 against v2
//   node tools/bot-arena.js --games 2000
//   node tools/bot-arena.js --seats 2           # v2 against itself, as a control
//   node tools/bot-arena.js --seats 1,1,2       # a three-seat mixed table
//   node tools/bot-arena.js --sweep province    # does that weight actually matter?

import { PHASE } from '../shared/constants.js';
import {
  allySetOf,
  applyAlliance,
  inboundRequests,
} from '../server/alliances.js';
import { TUNING } from '../server/bot-v2.js';
import { policyFor } from '../server/bots.js';
import { attack, endTurn, startGame } from '../server/game.js';
import { MAP_CHOICES } from '../server/map.js';
import { addBot, createRoom, deleteRoom } from '../server/rooms.js';

/**
 * A beat ceiling, so a policy that cannot finish a game reports that instead of
 * hanging the benchmark.
 *
 * Generous — a real heads-up game runs to about 70 attacks — because the point is
 * to catch a genuine livelock and not to put a ceiling on a long game. A seat
 * that loops forever is a real failure mode of a search-based policy and one this
 * file has already caught once, so it is counted and reported rather than ignored.
 */
const MAX_BEATS = 20000;

/**
 * The seed the `i`th game is played on, and the reason this file pins one at all.
 *
 * Rooms seed themselves randomly by default, which is right for the game and
 * wrong for a benchmark: two runs of the same configuration then play two
 * *different* sets of games, and the difference between their win rates is mostly
 * the difference between their boards. Measured, that swamped the signal — the
 * shipped weights scored 54.0% in one 200-game run and 44.0% in the next, which no
 * amount of arithmetic can tell apart from noise.
 *
 * Pinning the seeds makes the comparison **paired**: every setting in a sweep
 * plays the identical 200 boards, with the identical starting deals, so what
 * changes between two lines of a sweep is the policy and nothing else. It does
 * not make the dice identical from then on — a different policy attacks different
 * provinces and so draws from the stream in a different order — but the board each
 * game is played on is the same one.
 *
 * A stride is used rather than `base + i` so that consecutive games do not have
 * consecutive seeds; the generator is small and neighbouring seeds are a real way
 * to get neighbouring boards.
 */
const SEED_BASE = 20260101;
const SEED_STRIDE = 7919;

/** One game, played to a winner. Returns the winning seat index, or null. */
function playGame(seats, mapId, seed) {
  // Read by `roomSeed()`, which is the documented way to pin a room's dice and
  // board — `DICEVIBE_ROOM_SEED=12345 npm start` plays the same game twice, and
  // this is that same knob, set per game.
  process.env.DICEVIBE_ROOM_SEED = String((SEED_BASE + seed * SEED_STRIDE) >>> 0);

  // The room's creator is promoted to the first bot rather than removed, because
  // `removePlayer` deletes any room with no human left in it — and an all-bot
  // table is precisely what an arena wants. A harness reaching into the seat is
  // acceptable here in a way it would not be in the server; nothing about the
  // game's rules depends on it.
  const { room } = createRoom({ nickname: 'arena', mapId, socketId: 'arena-0' });
  room.players[0].isBot = true;
  room.players[0].botVersion = seats[0];
  for (const version of seats.slice(1)) addBot(room, version);

  const started = startGame(room);
  if (!started.ok) throw new Error(`arena game would not start: ${started.error}`);

  let beats = 0;
  while (room.phase === PHASE.PLAYING && beats < MAX_BEATS) {
    const player = room.players[room.game.turnIndex];
    const policy = policyFor(player.botVersion);
    beats++;

    // Diplomacy first, one action per beat, exactly as `stepBot` does it — the
    // ordering is part of the policy's behaviour and a benchmark that skipped it
    // would be measuring a different bot.
    const action = policy.planAlliance(room.game.board, room.game.adjacency, player.id, {
      allies: player.allies,
      requested: player.requested,
      askedThisTurn: player.askedThisTurn,
      incoming: inboundRequests(room, player.id),
    });

    if (action) {
      const done = applyAlliance(room, player.id, action);
      if (done.ok && done.changed) continue;
    }

    const move = policy.planMove(
      room.game.board,
      room.game.adjacency,
      player.id,
      allySetOf(player),
    );
    const result = move
      ? attack(room, player.id, move.from, move.to)
      : endTurn(room, player.id);

    // A refused attack is turned into an end-of-turn rather than retried, which
    // is the server's own rule and the reason a policy bug cannot spin here.
    if (!result.ok) endTurn(room, player.id);
  }

  const winnerId = room.game?.winnerId ?? null;
  const winner = room.players.findIndex((p) => p.id === winnerId);
  deleteRoom(room.code);

  return { winner, beats, stalled: room.phase === PHASE.PLAYING };
}

/** A 95% interval on a proportion, normal approximation. */
function interval(wins, n) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const half = 1.96 * Math.sqrt((p * (1 - p)) / n);
  return [Math.max(0, p - half), Math.min(1, p + half)];
}

/**
 * Plays `games` games with the given seat list, alternating the rotation.
 *
 * Alternating matters and is easy to forget: the seat that moves first in a
 * conquest game has a real advantage, so a policy always seated first would win
 * on the coin toss. The rotation walks each policy through every seat, so over a
 * run of games neither side has the first move more often than the other.
 */
function tournament(seatVersions, games, mapIds, onGame) {
  const tally = new Map(seatVersions.map((v) => [v, 0]));
  const bySeat = new Array(seatVersions.length).fill(0);
  // Wins and appearances per (version, seat). The pooled win rate answers "who
  // wins", and this answers "who wins, given they moved first" — which is the
  // sharper question, because moving first is worth so much here that it buries
  // the thing being measured if the two are ever mixed.
  const seatWins = new Map(seatVersions.map((v) => [v, new Array(seatVersions.length).fill(0)]));
  const seatSeen = new Map(seatVersions.map((v) => [v, new Array(seatVersions.length).fill(0)]));
  let decided = 0;
  let stalled = 0;
  let totalBeats = 0;

  for (let i = 0; i < games; i++) {
    const shift = i % seatVersions.length;
    const seats = [...seatVersions.slice(shift), ...seatVersions.slice(0, shift)];
    const mapId = mapIds[i % mapIds.length];

    const { winner, beats, stalled: hung } = playGame(seats, mapId, i);
    totalBeats += beats;
    if (hung) stalled++;

    for (let s = 0; s < seats.length; s++) seatSeen.get(seats[s])[s]++;

    if (winner >= 0) {
      decided++;
      tally.set(seats[winner], (tally.get(seats[winner]) ?? 0) + 1);
      bySeat[winner]++;
      seatWins.get(seats[winner])[winner]++;
    }
    onGame?.(i + 1);
  }

  return {
    tally, bySeat, seatWins, seatSeen, decided, stalled, games,
    avgBeats: totalBeats / games,
  };
}

function report(label, result) {
  const entries = [...result.tally.entries()].sort((a, b) => b[1] - a[1]);
  const lines = entries.map(([version, wins]) => {
    const p = result.decided ? wins / result.decided : 0;
    const [lo, hi] = interval(wins, result.decided);
    return `  v${version}  ${String(wins).padStart(5)} wins  ${(p * 100).toFixed(1).padStart(5)}%` +
      `   (95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%)`;
  });

  console.log(`${label} — ${result.games} games, ${result.avgBeats.toFixed(0)} beats each`);
  // One bucket means every seat plays the same version, so the version tally can
  // only ever read 100% and says nothing. The seat split below is the whole
  // result of a control run, so the misleading line is dropped rather than
  // printed and explained.
  if (entries.length > 1) console.log(lines.join('\n'));
  console.log(
    `  ${result.decided} decided, ${result.games - result.decided - result.stalled} drawn, ` +
      `${result.stalled} unfinished`,
  );

  if (result.decided === 0 || result.bySeat.length < 2) return;

  // The first-move advantage, and the reason this is printed on every run.
  //
  // It is large — measured, seat 0 takes about 72% of heads-up games with the
  // *same* policy at both seats — and it is the single biggest number in the
  // output. Without it in view, a pooled win rate is unreadable: half of every
  // policy's games are played from behind, so an edge has to be twice as big to
  // move the pooled figure at all.
  //
  // The rotation in `tournament` is what makes the pooled figure fair anyway —
  // each version walks through every seat, so each gets the advantage in half its
  // games. This line is how that is checked rather than assumed. **A control run
  // of one policy against itself is exactly this line and nothing else**, which is
  // why a same-version run now prints no version tally: its two seats share one
  // bucket and could only ever read 100%.
  const split = result.bySeat
    .map((w, i) => `seat ${i}: ${(100 * w / result.decided).toFixed(1)}%`)
    .join(', ');
  console.log(`  first move wins — ${split}`);

  if (entries.length > 1) {
    for (const [version] of entries) {
      const wins = result.seatWins.get(version);
      const seen = result.seatSeen.get(version);
      const cells = wins.map((w, s) => (seen[s] ? `${(100 * w / seen[s]).toFixed(1)}%` : '—'));
      console.log(
        `  v${version} by seat — ${cells.map((c, s) => `seat ${s}: ${c} (n=${seen[s]})`).join(', ')}`,
      );
    }
  }
}

function parseArgs(argv) {
  const args = { games: 200, seats: null, sweep: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') args.games = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--seats') args.seats = argv[++i].split(',').map(Number);
    else if (argv[i] === '--sweep') args.sweep = argv[++i];
  }
  return args;
}

function progress(done, total) {
  if (process.stdout.isTTY && done % 25 === 0) {
    process.stdout.write(`\r  … ${done}/${total} games`);
  }
}

const args = parseArgs(process.argv.slice(2));
const maps = MAP_CHOICES;

if (args.sweep) {
  // One weight at a time, against the fixed default opponent. The question a
  // sweep answers is not "what is the best number" — it is "does this number
  // change anything at all", and a weight that moves the win rate by less than
  // its own confidence interval is a weight that could be deleted.
  const key = args.sweep;
  if (!(key in TUNING)) {
    console.error(`unknown tuning key: ${key}. Known: ${Object.keys(TUNING).join(', ')}`);
    process.exit(1);
  }

  const original = TUNING[key];
  const candidates = original === 0
    ? [0, 1, 2, 4]
    : [0, original * 0.5, original, original * 2, original * 3].map((v) =>
        Number.isInteger(original) ? Math.round(v) : Number(v.toFixed(3)),
      );

  console.log(`sweeping ${key} (default ${original}) over ${args.games} games each\n`);
  for (const value of [...new Set(candidates)]) {
    TUNING[key] = value;
    const result = tournament([1, 2], args.games, maps, (d) => progress(d, args.games));
    const wins = result.tally.get(2) ?? 0;
    const p = result.decided ? wins / result.decided : 0;
    const [lo, hi] = interval(wins, result.decided);
    console.log(
      `  ${key} = ${String(value).padEnd(6)} v2 wins ${(p * 100).toFixed(1).padStart(5)}%` +
        `  (95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%, ${result.stalled} unfinished)`,
    );
  }
  TUNING[key] = original;
  if (process.stdout.isTTY) process.stdout.write('\r');
} else {
  const seats = args.seats ?? [1, 2];
  // `--seats` is the whole table, not a policy choice, so a single-seat list is a
  // typo — `--seats 1,1` is v1 against itself. Caught here because the failure
  // otherwise surfaces as `not_enough_players` from inside `startGame`, which
  // reads like a game bug rather than a mistyped flag.
  if (seats.length < 2) {
    console.error(`--seats needs at least two seats, e.g. --seats 1,2 (got: ${args.seats.join(',')})`);
    process.exit(1);
  }

  // A control is one *policy* at every seat, which is not the same as two seats:
  // `--seats 1,1,2,2` is a genuinely mixed four-player table and was being labelled
  // a control, which would have made a real measurement look like a self-test.
  const distinct = new Set(seats);
  const label = distinct.size > 1
    ? `v${[...distinct].sort().join(' vs v')} — seats ${seats.join(',')}`
    : `v${seats[0]}, v${seats[0]} (control — the same policy at every seat)`;

  const result = tournament(seats, args.games, maps, (d) => progress(d, args.games));
  if (process.stdout.isTTY) process.stdout.write('\r');
  report(label, result);
}
