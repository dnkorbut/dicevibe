// Game state transitions. Each exported function validates, mutates the room in
// place, and returns either `{ ok: true, event }` or `{ ok: false, error }`.
// Emitting is the caller's job.
//
// The board is `{ owner: playerId[], dice: number[] }`, indexed by territory id,
// which matches `map.territories` exactly.

import {
  ERR,
  MAX_DICE,
  MAX_TERRITORIES_PER_PLAYER,
  NEUTRAL,
  PALETTE,
  PHASE,
} from '../shared/constants.js';
import {
  applyAttack,
  attackRolls,
  bankDice,
  canAttack,
  checkWin,
  distributeDice,
  nextTurnIndex,
  refreshEliminated,
  resolveAttack,
  territoryCount,
} from '../shared/rules.js';
import { allySetOf, breakAlliance, dissolveFor, isAllied } from './alliances.js';
import { adjacencyOf, generateMap, playableIds } from './map.js';

/** Minimum territories per player at setup, so nobody is born eliminated. */
const MIN_TERRITORIES_PER_PLAYER = 3;

/** Extra dice placed at setup, per territory, on top of the starting 1. */
const SETUP_DICE_PER_TERRITORY = 2;

/**
 * Builds the initial board and flips the room into play.
 *
 * Steps, in order: drop anyone who isn't currently connected (a player dealt a
 * hand they can't play would wedge the match on their first turn — this is the
 * only point where removing a seat is safe), shuffle the roster to fix the turn
 * order, deal the colours afresh, scatter ownership round-robin over a shuffled
 * territory list, then distribute the setup dice.
 */
export function startGame(room) {
  if (room.phase !== PHASE.LOBBY) return { ok: false, error: ERR.GAME_IN_PROGRESS };

  // Seats held by absent players cannot be carried into a game, because the
  // disconnect policy pauses rather than skips and there is no way back.
  for (const player of room.players.filter((p) => !p.connected)) {
    room.players.splice(room.players.indexOf(player), 1);
  }
  if (room.players.length === 0) return { ok: false, error: ERR.NOT_ENOUGH_PLAYERS };
  if (room.players.length < 2) return { ok: false, error: ERR.NOT_ENOUGH_PLAYERS };

  const players = room.players;
  const rng = room.rng;

  // The board is minted here, not at room creation: this is the first moment the
  // player count is known, and it is the player count that decides how much land
  // the board has to have.
  const minLand = MIN_TERRITORIES_PER_PLAYER * players.length;
  let map;
  try {
    map = generateMap({
      preset: room.mapId,
      size: room.sizeId ?? null,
      seed: room.mapSeed,
      minPlayable: minLand,
    });
  } catch {
    // Generation only throws once every attempt has come up short of land.
    return { ok: false, error: ERR.MAP_TOO_SMALL };
  }

  // Voids stay in the arrays as `null` owners so ids remain dense and every
  // `owner[i] === playerId` test keeps working. Only land is dealt out.
  const count = map.territories.length;
  const land = playableIds(map);

  if (land.length < minLand) return { ok: false, error: ERR.MAP_TOO_SMALL };

  const adjacency = adjacencyOf(map);
  const board = {
    owner: new Array(count).fill(null),
    dice: new Array(count).fill(0),
  };

  // Shuffling the roster here is what defines turn order — the players array
  // order IS the rotation, which keeps nextTurnIndex trivial. Everything else
  // refers to players by id, so reordering is safe.
  rng.shuffle(players);

  // Colours are dealt again here, for the same reason and from the same source.
  // In the lobby they are handed out in join order by `freeColor`, where all a
  // colour has to do is be distinct and hold still while people come and go; a
  // seat that keeps that colour into the game, though, is the same positional
  // tell the roster shuffle exists to remove — the host would be blue at every
  // table they ever sat at, and everyone who has played a few games would read
  // the colour before the name.
  //
  // Shuffled as a whole palette and dealt by seat rather than drawn one at a
  // time, so the draw is the same whatever the table size. Wrapped by the
  // palette length for the same reason `freeColor` wraps: a table larger than
  // the palette still has to be handed something to draw, and `undefined` would
  // reach the client as an unpaintable colour.
  const palette = rng.shuffle([...PALETTE]);
  players.forEach((p, i) => {
    p.color = palette[i % palette.length];
  });

  // Ownership round-robin over a shuffled list of LAND. Shuffling first matters:
  // assigning modulo over the raw Voronoi order would hand each player a
  // diagonal stripe of the grid instead of a scattered, interleaved set.
  //
  // Only the first `MAX_TERRITORIES_PER_PLAYER` each are dealt. On a board with
  // more land than that the remainder is not unowned — it belongs to NEUTRAL,
  // which is why this is a starting deal rather than a board-wide split: a big
  // map is more provinces per player to conquer, not more provinces to start
  // with. Those neutrals accumulate dice and must be fought through.
  const playerLand = Math.min(land.length, MAX_TERRITORIES_PER_PLAYER * players.length);
  const territoryOrder = rng.shuffle(land);
  for (let k = 0; k < land.length; k++) {
    board.owner[territoryOrder[k]] =
      k < playerLand ? players[k % players.length].id : NEUTRAL;
  }

  for (const t of land) board.dice[t] = 1;

  // Keyed by owners actually present rather than by the roster: on any board
  // with neutral land, `land` contains territories no player owns, and
  // `ownedBy.get(NEUTRAL)` is undefined. The throw that would cause is swallowed
  // by the socket handler's wrapper, so it would present as a Start Game button
  // that silently does nothing.
  const ownedBy = new Map();
  for (const t of land) {
    const owner = board.owner[t];
    const list = ownedBy.get(owner);
    if (list) list.push(t);
    else ownedBy.set(owner, [t]);
  }

  // SETUP_DICE_PER_TERRITORY extra dice per PLAYER territory, dealt round-robin
  // across players so nobody is systematically favoured, each landing on a
  // random owned territory with room left.
  //
  // Counting `land.length` instead would over-deal on exactly the boards this
  // feature exists for: 30 provinces with 2 players is 10 player territories and
  // 20 neutral, so the pool would be three times the intended size and would fill
  // every player province to MAX_DICE instead of the intended 3.
  let remaining = SETUP_DICE_PER_TERRITORY * playerLand;
  let cursor = 0;
  let idle = 0;
  while (remaining > 0 && idle < players.length) {
    const player = players[cursor % players.length];
    cursor++;

    const eligible = ownedBy.get(player.id).filter((t) => board.dice[t] < MAX_DICE);
    if (eligible.length === 0) {
      idle++;
      continue;
    }

    board.dice[eligible[rng.int(eligible.length)]]++;
    remaining--;
    idle = 0;
  }

  room.game = {
    map,
    adjacency,
    board,
    turnIndex: 0,
    round: 0,
    version: 0,
    lastEvent: null,
    winnerId: null,
  };
  room.phase = PHASE.PLAYING;

  // Alliances are per-game, not per-seat: the lobby has no diplomacy, so the
  // only thing this can be clearing is a pact made in a previous match in this
  // room — where the boards were different and the edge would mean nothing.
  for (const p of players) {
    p.eliminated = false;
    p.stock = 0;
    p.allies = [];
    p.requested = [];
    p.askedThisTurn = false;
  }
  refreshEliminated(board, players);

  return { ok: true, event: { type: 'start', turnPlayerId: players[0].id } };
}

/**
 * Adds one die to every neutral province that has room, and returns the ids it
 * grew.
 *
 * Neutrals never attack and are never reinforced by a turn of their own, so this
 * is the only thing that ever moves their dice. It is called from `endTurn`, on
 * every SECOND full round — never on an odd one. They are a wall rather than an
 * aggressor: the pressure they exert is that a border left alone gets more
 * expensive to take, and the point of halving the rate is to keep that pressure
 * from hardening every neutral border to the cap before anyone has expanded into
 * it.
 */
function growNeutral(board) {
  const grown = [];
  for (let t = 0; t < board.owner.length; t++) {
    if (board.owner[t] !== NEUTRAL || board.dice[t] >= MAX_DICE) continue;
    board.dice[t]++;
    grown.push(t);
  }
  return grown;
}

/** The player whose turn it is, or null if the game isn't running. */
function currentPlayer(room) {
  if (room.phase !== PHASE.PLAYING || !room.game) return null;
  return room.players[room.game.turnIndex] ?? null;
}

/**
 * Records which province a player has picked as an attack source, or clears it
 * with `from: null`.
 *
 * This is presentation state, not game state: it changes no rule and blocks no
 * move. It exists so the rest of the table can see who is looking at what, which
 * means it has to be validated — an unvalidated id would let any client outline
 * a province that isn't theirs, and a bogus id would outline nothing at all on
 * every other screen while looking fine on their own.
 *
 * `changed` tells the caller whether this was news. Re-selecting the province
 * already selected is common (clicks land twice), and republishing the whole
 * snapshot for it would be pure noise.
 */
export function selectTerritory(room, playerId, from) {
  const game = room.game;
  if (room.phase !== PHASE.PLAYING || !game) return { ok: false, error: ERR.GAME_OVER };

  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { ok: false, error: ERR.BAD_REQUEST };

  // Clearing is always allowed — a stale highlight must always be removable,
  // including by a player whose turn has just passed, which is exactly when the
  // client sends its final clear.
  if (from !== null) {
    const valid = Number.isInteger(from) && from >= 0 && from < game.board.owner.length;
    if (!valid || game.board.owner[from] !== playerId) {
      return { ok: false, error: ERR.BAD_REQUEST };
    }

    // Only the player choosing a move right now has something to point at. The
    // board is inert for everyone else, so this is not a rule the UI can break
    // by accident — it is what guarantees that a selection never outlives the
    // turn it belongs to, since `endTurn` clears the one player who had it.
    const current = room.players[game.turnIndex];
    if (!current || current.id !== playerId) return { ok: false, error: ERR.NOT_YOUR_TURN };
  }

  const changed = player.selected !== from;
  player.selected = from;

  return { ok: true, changed };
}

/**
 * Resolves one attack.
 *
 * Note what is NOT here: any requirement that the attacker has made no previous
 * attack this turn, or that it attacked from the same territory. Dice Wars
 * allows unlimited attacks from any owned territory in any order. Only the
 * End Turn button ends a turn.
 */
export function attack(room, playerId, from, to) {
  const game = room.game;
  if (room.phase !== PHASE.PLAYING || !game) return { ok: false, error: ERR.GAME_OVER };

  const current = currentPlayer(room);
  if (!current || current.id !== playerId) return { ok: false, error: ERR.NOT_YOUR_TURN };

  const legal = canAttack(game.board, game.adjacency, from, to, playerId);
  if (legal !== true) return { ok: false, error: legal.error };

  // Snapshot the inputs before mutating — the log and the client overlay both
  // want the dice as they were at the moment of the attack.
  //
  // `attackerDice` is what the attacker THROWS, not the stack it attacks with;
  // the difference is the die that stays home on a win (`attackRolls`). The event
  // carries the thrown count so `attackerRolls.length === attackerDice` stays a
  // true invariant on the wire, matching `defenderDice`, which has always meant
  // the defender's whole stack.
  const attackerDice = attackRolls(game.board.dice[from]);
  const defenderDice = game.board.dice[to];
  const defenderId = game.board.owner[to];

  const result = resolveAttack(room.rng, attackerDice, defenderDice);
  applyAttack(game.board, from, to, result.captured);

  // Attacking an ally is legal — that is the explicit rule, and the reason
  // `canAttack` knows nothing about alliances. The pact is what breaks, and it
  // breaks whichever way the roll went: the dice are already thrown by the time
  // anyone could object, so a repel is not an apology.
  //
  // Before the elimination check below, so that a single blow which both takes
  // the last territory and ends a pact produces one event carrying both facts
  // rather than two logs describing one click.
  const brokeAlliance = defenderId !== NEUTRAL && isAllied(room, playerId, defenderId);
  if (brokeAlliance) breakAlliance(room, playerId, defenderId);

  // `defenderId` may be NEUTRAL, which is not a player and has no `counts` entry
  // — `counts.get` would return undefined and `undefined === 0` is false, so this
  // happens to behave correctly without the check. It is written out anyway: the
  // guard is what is actually meant, and "it works by luck" is not a reason to
  // leave a landmine for whoever next changes what `counts` contains.
  const counts = refreshEliminated(game.board, room.players);
  const eliminatedPlayerId =
    defenderId !== NEUTRAL && counts.get(defenderId) === 0 ? defenderId : null;

  // Dead land is invisible to `borderStacks` and to the bot's target scan, so no
  // rule needs this. The rail does: without it a player who is out keeps a Break
  // button that can only answer NOT_ALLIED, and keeps holding pacts that make
  // the survivors' reinforcement ignore a border that is no longer defended.
  // Fires exactly once, because zero territories is absorbing.
  if (eliminatedPlayerId) dissolveFor(room, eliminatedPlayerId);

  // A capture that takes the last territory ends the game immediately — the
  // winner does not have to press End Turn.
  const winnerId = checkWin(room.players);
  if (winnerId) {
    room.phase = PHASE.OVER;
    game.winnerId = winnerId;
  }

  game.version++;
  const event = {
    version: game.version,
    type: 'attack',
    from,
    to,
    attackerId: playerId,
    defenderId,
    attackerDice,
    defenderDice,
    attackerRolls: result.attackerRolls,
    defenderRolls: result.defenderRolls,
    attackerSum: result.attackerSum,
    defenderSum: result.defenderSum,
    captured: result.captured,
    eliminatedPlayerId,
    winnerId,
    brokeAlliance,
  };
  game.lastEvent = event;

  // The attack consumed the selection: whatever they were looking at has just
  // resolved, and leaving it outlined would say they are still considering it.
  current.selected = null;

  return { ok: true, event };
}

/**
 * Ends the current player's turn: pays reinforcement, then passes play on.
 *
 * Deliberately does NOT require that a legal attack existed, or that any attack
 * was made. A player whose territories are all down to 1 die has no move
 * available; refusing their End Turn would deadlock the game with nobody
 * disconnected.
 */
export function endTurn(room, playerId) {
  const game = room.game;
  if (room.phase !== PHASE.PLAYING || !game) return { ok: false, error: ERR.GAME_OVER };

  const current = currentPlayer(room);
  if (!current || current.id !== playerId) return { ok: false, error: ERR.NOT_YOUR_TURN };

  const player = room.players[game.turnIndex];

  // Reinforcement is one die per province held, wherever they are: ten provinces
  // pay ten, scattered or not.
  //
  // This is NOT the classic Dice Wars formula, which pays the largest connected
  // group. That made scattered land worth strictly less than contiguous land; this
  // pays for land as such. The consequence to know about is that the payout now
  // scales with the whole empire with no ceiling, so a runaway leader compounds
  // faster than it used to — the board has to be pruned by attack, not by
  // geography.
  const gain = territoryCount(game.board, playerId);
  bankDice(player, gain);
  const dealt = distributeDice(
    game.board,
    game.adjacency,
    playerId,
    player.stock,
    allySetOf(player),
  );
  player.stock = dealt.left;

  // The turn is over, so the highlight goes with it. The client clears its own
  // copy at the same moment, but the server cannot rely on that: another tab
  // may have been the last to click, and a player who closes the tab mid-turn
  // would otherwise leave a province outlined for the rest of the game.
  player.selected = null;
  // And the next turn is a fresh one for diplomacy: a bot gets one ask per turn,
  // which is what bounds the request → refusal → request cycle. It is per-turn
  // rather than per-game because a pact refused early should be askable again
  // once the board has moved.
  player.askedThisTurn = false;

  const endingIndex = game.turnIndex;
  game.turnIndex = nextTurnIndex(room.players, endingIndex);
  const nextPlayerId = room.players[game.turnIndex].id;

  // A wrap means every seat has had a turn: `nextTurnIndex` returns the first
  // non-eliminated seat strictly after the current one, so landing at or before
  // where we started is only possible by going all the way round.
  //
  // `game.round` is kept alongside the comparison rather than inferred from it
  // because the comparison silently assumes `room.players` is fixed for the whole
  // game — `removePlayer` renumbers `turnIndex` to 0, which would fake a wrap. The
  // counter is the fact; the comparison only decides when to bump it.
  const wrapped = game.turnIndex <= endingIndex;
  if (wrapped) game.round++;

  // On a wrap, on an even round, and only while there is still a contest.
  //
  // The wrap is what makes this once per ROUND rather than once per turn: on a
  // two-player board the neutrals must gain a die after every second turn, not
  // after every turn, or they double in speed. `game.round` is the count of
  // completed rounds, so requiring it to be even halves the rate again — the
  // wall advances on rounds 2, 4, 6, and never on an odd one.
  //
  // The last condition matters because once one player is left the phase is
  // OVER and nobody can act again, so growing the neutral wall would only change
  // a board the winner has already claimed.
  const neutralGrowth =
    wrapped && game.round % 2 === 0 && room.players.filter((p) => !p.eliminated).length > 1
      ? growNeutral(game.board)
      : [];

  game.version++;
  const event = {
    version: game.version,
    type: 'reinforce',
    playerId,
    gain,
    placed: dealt.placed,
    stockLeft: dealt.left,
    territories: dealt.territories,
    // Kept separate from `territories`: that list is flashed as the reinforcing
    // player's own provinces and is what makes `placed + stockLeft === gain` add
    // up. Neutral ids in it would flash someone else's land and break the log's
    // arithmetic.
    neutralGrowth,
    turnPlayerId: nextPlayerId,
  };
  game.lastEvent = event;

  return { ok: true, event };
}
