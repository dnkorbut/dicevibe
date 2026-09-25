// Alliances: the single writer of a symmetric edge.
//
// A pact is stored on both seats — `player.allies` lists the other's id — rather
// than as a list of pairs somewhere central, because every reader already holds a
// player and asks "is this one a friend": reinforcement wonders whether a border
// is a threat, the bot wonders whether a province is a legal target, the rail
// wonders which control to draw. The cost of that choice is that the two halves
// can drift, and a one-sided edge is invisible until a bot refuses to attack
// somebody who does not consider itself allied. So `form` and `sever` below are
// the only code in the project that touches `allies`, and each of them always
// writes both sides.
//
// Deliberately does not import `rooms.js` or `game.js`. `rooms.js` needs the
// scrub when a seat is dropped and already imports `map.js`; `game.js` imports
// this file. Keeping this one free of both is what stops the three from forming
// a cycle.
//
// A request is stored the same way, and there is no "incoming requests" field:
// your inbound asks are exactly the other seats whose `requested` contains your
// id. Deriving it is the same principle as `selected` on the wire — the fact is
// already in the room, and shipping it twice is how the two copies drift.

import { ERR, PHASE } from '../shared/constants.js';

/** The seat with this id, or null. Local because rooms.js imports this file. */
function seat(room, playerId) {
  return room.players.find((p) => p.id === playerId) ?? null;
}

/** Everything an alliance action has in common: the game has to be running. */
function gate(room) {
  if (room.phase !== PHASE.PLAYING || !room.game) return { ok: false, error: ERR.GAME_OVER };
  return null;
}

/**
 * The player an action names, or a refusal.
 *
 * Eliminated seats are refused rather than ignored, exactly like an id that names
 * nobody: their land is gone, so there is nothing left to be allied about, and
 * the rail would otherwise offer a Break button that always answers NOT_ALLIED.
 * `dissolveFor` runs on elimination so this should never be reachable — it is the
 * guard that keeps "should never" from being the only defence.
 */
function target(room, playerId) {
  const player = seat(room, playerId);
  if (!player || player.eliminated) return { ok: false, error: ERR.NO_SUCH_PLAYER };
  return { ok: true, player };
}

/** Both halves of the edge, in one place. */
function form(a, b) {
  if (!a.allies.includes(b.id)) a.allies.push(b.id);
  if (!b.allies.includes(a.id)) b.allies.push(a.id);
}

function sever(a, b) {
  a.allies = a.allies.filter((id) => id !== b.id);
  b.allies = b.allies.filter((id) => id !== a.id);
}

/** Drops any pending ask between the two, in whichever direction it points. */
function settle(a, b) {
  a.requested = a.requested.filter((id) => id !== b.id);
  b.requested = b.requested.filter((id) => id !== a.id);
}

/** Every id `player` is allied with, as a Set. Empty, never null. */
export function allySetOf(player) {
  return new Set(player.allies ?? []);
}

export function isAllied(room, aId, bId) {
  const player = seat(room, aId);
  return Boolean(player && (player.allies ?? []).includes(bId));
}

/** The ids who have asked `playerId` for an alliance and are still waiting. */
export function inboundRequests(room, playerId) {
  return room.players
    .filter((p) => p.id !== playerId && !p.eliminated && (p.requested ?? []).includes(playerId))
    .map((p) => p.id);
}

/** Records an action on the game so every client's log can report it. */
function record(room, action, actorId, otherId) {
  room.game.version++;
  const event = { version: room.game.version, type: 'alliance', action, actorId, otherId };
  room.game.lastEvent = event;
  return event;
}

/**
 * Asks `toId` for an alliance.
 *
 * Two clicks in opposite directions are the same thing as an agreement, so a
 * request that answers an open one forms the pact instead of leaving two asks
 * pointing at each other — mutual consent, arrived at without a second round
 * trip, and it removes a state that would otherwise have to be explained.
 *
 * Re-asking when an ask is already open is an idempotent no-op returning
 * `changed: false`, exactly like re-selecting the province already selected. A
 * double click is routine, and it must not put a refusal on screen or cost the
 * room a broadcast.
 */
export function requestAlliance(room, fromId, toId) {
  const stopped = gate(room);
  if (stopped) return stopped;

  const from = seat(room, fromId);
  if (!from) return { ok: false, error: ERR.BAD_REQUEST };
  if (toId === fromId) return { ok: false, error: ERR.ALLIANCE_SELF };

  const found = target(room, toId);
  if (!found.ok) return found;
  const to = found.player;

  if (from.allies.includes(toId)) return { ok: false, error: ERR.ALREADY_ALLIED };

  // They asked first: this is the agreement.
  if (to.requested.includes(fromId)) {
    settle(from, to);
    form(from, to);
    return { ok: true, changed: true, event: record(room, 'accept', fromId, toId) };
  }

  if (from.requested.includes(toId)) return { ok: true, changed: false };

  from.requested.push(toId);
  // The bot driver's guard against requesting in a loop the idempotence check
  // cannot see: a request that is declined clears the pending entry, so without
  // this a bot whose offer was refused could ask again on the very next tick.
  from.askedThisTurn = true;
  return { ok: true, changed: true, event: record(room, 'request', fromId, toId) };
}

/**
 * Answers an open ask — accepting it, refusing it, or withdrawing it.
 *
 * `accept` forms the pact, and is only legal for the player who was asked:
 * letting the asker accept their own question would be consent from one side.
 *
 * A decline drops the pending entry whichever way it points. From the asked side
 * that is a refusal; from the asker's side it is a withdrawal of their own offer,
 * and the event says which, so the two do not read alike in the log even though
 * they are the same state change. That is what keeps this four verbs rather than
 * five.
 */
export function respondAlliance(room, playerId, otherId, accept) {
  const stopped = gate(room);
  if (stopped) return stopped;

  const me = seat(room, playerId);
  if (!me) return { ok: false, error: ERR.BAD_REQUEST };
  if (otherId === playerId) return { ok: false, error: ERR.ALLIANCE_SELF };

  const found = target(room, otherId);
  if (!found.ok) return found;
  const other = found.player;

  // `requested` is the outbound list, so "they asked me" is their list naming me.
  const inbound = other.requested.includes(playerId);
  const outbound = me.requested.includes(otherId);
  if (!inbound && !outbound) return { ok: false, error: ERR.NO_PENDING_REQUEST };

  if (accept) {
    if (!inbound) return { ok: false, error: ERR.NO_PENDING_REQUEST };
    if (me.allies.includes(otherId)) return { ok: false, error: ERR.ALREADY_ALLIED };

    settle(me, other);
    form(me, other);
    return { ok: true, changed: true, event: record(room, 'accept', playerId, otherId) };
  }

  settle(me, other);
  // The asker calling it off is a withdrawal; the asked turning it down is a
  // refusal. Same state change, and the log is the only thing that cares.
  return {
    ok: true,
    changed: true,
    event: record(room, inbound ? 'decline' : 'withdraw', playerId, otherId),
  };
}

/** Ends the pact between two players, whoever asks for it. */
export function breakAlliance(room, playerId, otherId) {
  const stopped = gate(room);
  if (stopped) return stopped;

  const me = seat(room, playerId);
  if (!me) return { ok: false, error: ERR.BAD_REQUEST };
  if (otherId === playerId) return { ok: false, error: ERR.ALLIANCE_SELF };

  const found = target(room, otherId);
  if (!found.ok) return found;
  const other = found.player;

  if (!me.allies.includes(otherId)) return { ok: false, error: ERR.NOT_ALLIED };

  sever(me, other);
  return { ok: true, changed: true, event: record(room, 'break', playerId, otherId) };
}

/**
 * Strips every trace of a seat from the rest of the room: both directions of
 * every pact, and any pending ask that names it.
 *
 * One function because it cannot be allowed to be half-applied, and because the
 * callers are on paths that are easy to forget — a lobby seat leaving, and an
 * elimination that happens inside `attack` rather than anywhere near the seat
 * lifecycle. A missed path leaves a phantom ally: the rules would still treat
 * them as friendly, but nothing could ever break the pact.
 *
 * Works whether or not the seat is still in the room, so `removePlayer` can call
 * it after the splice and `attack` can call it with the seat still present.
 */
export function dissolveFor(room, playerId) {
  for (const player of room.players) {
    // The seat's own lists are cleared too, when the seat is still here. That is
    // the elimination case rather than the removal one: an eliminated player
    // keeps its row in the roster, so clearing only the survivors would leave the
    // edge intact from the dead side and make it one-sided — the exact bug this
    // module exists to prevent, and one that would survive into the snapshot.
    if (player.id === playerId) {
      player.allies = [];
      player.requested = [];
      continue;
    }

    if ((player.allies ?? []).includes(playerId)) {
      player.allies = player.allies.filter((id) => id !== playerId);
    }
    if ((player.requested ?? []).includes(playerId)) {
      player.requested = player.requested.filter((id) => id !== playerId);
    }
  }
}

/**
 * Applies the one action a policy asked for, and reports whatever the transition
 * said.
 *
 * The translation from a policy's verb to a transition, and it lives here rather
 * than beside the driver because two callers need it — the server's bot tick and
 * `tools/bot-arena.js`, which plays policies against each other with no sockets
 * involved. One copy means the arena exercises the same dispatch the server does,
 * which is the only reason its results describe the shipped game.
 *
 * The default arm is the request, so a policy that invents a verb gets a refusal
 * from `requestAlliance` — the target check is there — rather than a silent
 * nothing.
 */
export function applyAlliance(room, playerId, action) {
  switch (action.action) {
    case 'accept':
      return respondAlliance(room, playerId, action.playerId, true);
    case 'decline':
      return respondAlliance(room, playerId, action.playerId, false);
    case 'break':
      return breakAlliance(room, playerId, action.playerId);
    default:
      return requestAlliance(room, playerId, action.playerId);
  }
}
