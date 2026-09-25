// Room and seat lifecycle. Deliberately knows nothing about Socket.IO — it
// mutates state and returns results; `index.js` owns all emitting. That keeps
// this module testable without a server running.
//
// Identity model: a player's `id` ('p1', 'p2', ...) is public and appears in
// snapshots and logs. Their `token` is secret, lives only in `sessions`, and is
// what lets a reconnecting socket reclaim its seat. Never send a token out
// except in the ack that mints it.

import { randomInt, randomUUID } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  ERR,
  MAX_PLAYERS,
  NICKNAME_MAX,
  PALETTE,
  PHASE,
  mapSize,
} from '../shared/constants.js';
import { leaderOf, territoryCount } from '../shared/rules.js';
import { dissolveFor } from './alliances.js';
import { MAPS, isKnownMap } from './map.js';
import { makeRng, randomSeed } from './rng.js';

/** code -> room */
export const rooms = new Map();
/** token -> { roomCode, playerId } */
export const sessions = new Map();

export function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, NICKNAME_MAX);
}

/**
 * Seats a bot at the table.
 *
 * No session is registered, because nothing ever reclaims a bot's seat: it has
 * no token to resume with and no socket to drop. Everything downstream —
 * elimination, turn order, the win check, reinforcement — is player-agnostic
 * and needs no bot-specific handling, and since `startGame` counts seats rather
 * than humans, "one human plus one bot" is a legal game with no rule change.
 */
export function addBot(room) {
  if (room.phase !== PHASE.LOBBY) return { error: ERR.GAME_IN_PROGRESS };
  if (room.players.length >= MAX_PLAYERS) return { error: ERR.ROOM_FULL };

  const bot = makePlayer(room, nextBotName(room), { isBot: true });
  room.players.push(bot);
  return { player: bot };
}

/** Removes a bot seat. Only ever a bot — a human leaves through `room:leave`. */
export function removeBot(room, playerId) {
  if (room.phase !== PHASE.LOBBY) return { error: ERR.GAME_IN_PROGRESS };

  const bot = room.players.find((p) => p.id === playerId);
  if (!bot || !bot.isBot) return { error: ERR.BAD_REQUEST };

  removePlayer(room, playerId);
  return { ok: true };
}

/**
 * A fresh seed for a room's dice or its board.
 *
 * `DICEVIBE_ROOM_SEED` pins it, which is what makes a bot-vs-bot game
 * reproducible in a test: same room, same board, same dice, same moves.
 */
function roomSeed() {
  const raw = Number.parseInt(process.env.DICEVIBE_ROOM_SEED ?? '', 10);
  return Number.isInteger(raw) ? raw >>> 0 : randomSeed();
}

export function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

/** Lowest palette index not already taken, so colours stay stable as people leave. */
function freeColor(room) {
  const used = new Set(room.players.map((p) => p.color));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[room.players.length % PALETTE.length];
}

function makePlayer(room, name, { isBot = false } = {}) {
  room.seq += 1;
  return {
    id: `p${room.seq}`,
    token: randomUUID(),
    name,
    color: freeColor(room),
    socketId: null,
    // A bot is connected from birth: there is no socket to lose. That is
    // load-bearing twice over — `startGame` drops every absent seat, and a
    // snapshot pauses the whole table when the player whose turn it is is
    // absent, which would wedge the game behind a "waiting for Bot 2" overlay.
    connected: isBot,
    isBot,
    eliminated: false,
    stock: 0,
    // The province this player has picked as an attack source, published so the
    // whole table can see it. Null whenever they have nothing selected, which is
    // the normal state — including for bots, which never select anything.
    selected: null,
    // Alliance state, on the seat rather than on `room.game`: the lobby has no
    // game, so `[]` is the uniform value there and nothing has to null-guard it,
    // and a seat is the durable identity — removing one takes its edges with it.
    // `allies` is symmetric and both sides are written together; the only code
    // allowed to touch it is `server/alliances.js`. `requested` is the outbound
    // half of a pending ask; the inbound half is derived from everyone else's.
    allies: [],
    requested: [],
    // Bot policy only, and never published: a bot may ask at most once per turn,
    // which is the guard against a request-refused-request loop that the
    // idempotence check cannot see. Cleared in `endTurn` beside `selected`.
    askedThisTurn: false,
    graceTimer: null,
  };
}

/** `Bot N` for the lowest free N, matching how unnamed humans are numbered. */
function nextBotName(room) {
  for (let n = 1; n <= MAX_PLAYERS; n++) {
    const candidate = `Bot ${n}`;
    if (!nameTaken(room, candidate)) return candidate;
  }
  return `Bot ${room.seq + 1}`;
}

function makeRoom({ nickname, mapId, sizeId = null }) {
  const code = generateCode();
  const seed = roomSeed();
  const room = {
    code,
    hostId: null,
    mapId,
    sizeId,
    phase: PHASE.LOBBY,
    players: [],
    seq: 0,
    rng: makeRng(seed),
    seed,
    // Minted with the room rather than at start, so a board can be regenerated
    // from a bug report: "Isles, seed 12345" is a complete description.
    // Derived rather than drawn separately so one env override pins both, while
    // still giving the board and the dice independent streams.
    mapSeed: (seed ^ 0x5bf03635) >>> 0,
    createdAt: Date.now(),
    game: null,
  };

  const player = makePlayer(room, nickname);
  room.players.push(player);
  room.hostId = player.id;
  rooms.set(code, room);

  return { room, player };
}

function seatPlayer(room, player, socketId) {
  player.socketId = socketId;
  player.connected = true;
  clearGrace(room, player);
  sessions.set(player.token, { roomCode: room.code, playerId: player.id });
}

function clearGrace(_room, player) {
  if (player.graceTimer) {
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }
}

function nameTaken(room, name) {
  const lower = name.toLowerCase();
  return room.players.some((p) => p.name.toLowerCase() === lower);
}

export function createRoom({ nickname, mapId, sizeId = null, socketId }) {
  if (!isKnownMap(mapId)) return { error: ERR.BAD_REQUEST };

  // Absent means "whatever this style asks for", which is what every room did
  // before sizes existed. A size that is *present* but unrecognised is a bad
  // request rather than a silent fallback: the host picked something, and
  // quietly dealing them a different board than the menu showed would be worse
  // than refusing.
  if (sizeId !== null && sizeId !== '' && !mapSize(sizeId)) return { error: ERR.BAD_REQUEST };

  // A room starts empty, so an unnamed creator is simply Player 1 — there is
  // nobody to collide with.
  const name = normalizeName(nickname) || 'Player 1';

  const { room, player } = makeRoom({ nickname: name, mapId, sizeId: sizeId || null });
  seatPlayer(room, player, socketId);
  return { room, player };
}

/**
 * The name a joiner ends up with.
 *
 * A blank name is no longer an error: joining is meant to be one click, so an
 * unnamed arrival becomes `Player N` for the lowest free N. There is always one
 * — at most MAX_PLAYERS seats exist and there are MAX_PLAYERS candidate names,
 * so by the pigeonhole principle any seat that can be joined has a free number.
 * NAME_INVALID survives only as the guard that keeps that argument honest.
 */
function resolveName(room, raw) {
  const name = normalizeName(raw);
  if (name) return name;

  for (let n = 1; n <= MAX_PLAYERS; n++) {
    const candidate = `Player ${n}`;
    if (!nameTaken(room, candidate)) return candidate;
  }
  return '';
}

export function joinRoom({ code, nickname, socketId }) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { error: ERR.NO_SUCH_ROOM };
  if (room.phase !== PHASE.LOBBY) return { error: ERR.GAME_IN_PROGRESS };
  if (room.players.length >= MAX_PLAYERS) return { error: ERR.ROOM_FULL };

  const name = resolveName(room, nickname);
  if (!name) return { error: ERR.NAME_INVALID };
  // Includes disconnected seats on purpose: the seat is held, so its name is too.
  if (nameTaken(room, name)) return { error: ERR.NAME_TAKEN };

  const player = makePlayer(room, name);
  room.players.push(player);
  seatPlayer(room, player, socketId);
  return { room, player };
}

/**
 * The games in the menu, oldest first.
 *
 * Lobby-phase rooms only: a game in progress cannot be joined, so listing one
 * would advertise a button that always comes back with a refusal. A full room is
 * filtered out for the same reason — its Join button could only fail.
 */
export function listOpenRooms() {
  const open = [];

  for (const room of rooms.values()) {
    if (room.phase !== PHASE.LOBBY) continue;
    if (room.players.length >= MAX_PLAYERS) continue;

    const host = room.players.find((p) => p.id === room.hostId);
    open.push({
      code: room.code,
      hostName: host?.name ?? 'someone',
      seats: room.players.length,
      max: MAX_PLAYERS,
      mapId: room.mapId,
      mapName: MAPS[room.mapId]?.name ?? room.mapId,
      // Null when the host left the size to the style, which is the common case
      // and what the row should read as "nothing was chosen" rather than a size.
      sizeId: room.sizeId ?? null,
      sizeName: mapSize(room.sizeId)?.name ?? null,
    });
  }

  // Insertion order is creation order, so the list is stable: it does not
  // reshuffle under someone's cursor as other players come and go.
  return open;
}

/**
 * Reclaims a seat from a token. Covers the refresh path, the Socket.IO
 * auto-reconnect path, and the stale-token path — the caller cannot tell them
 * apart and does not need to.
 */
export function resumeSession({ token, socketId }) {
  const session = typeof token === 'string' ? sessions.get(token) : null;
  if (!session) return { error: ERR.UNKNOWN_SESSION };

  const room = rooms.get(session.roomCode);
  const player = room?.players.find((p) => p.id === session.playerId);
  if (!room || !player) {
    sessions.delete(token); // lazily drop the dead pointer
    return { error: ERR.UNKNOWN_SESSION };
  }

  // Hand the seat to the new socket. Any older socket for this player is now
  // stale; the disconnect handler checks socketId before acting, so the old
  // socket's eventual, late disconnect cannot knock this player back offline.
  player.socketId = socketId;
  player.connected = true;
  clearGrace(room, player);

  return { room, player };
}

/** Drops a player's seat. Returns the room's fate so the caller can clean up. */
export function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { removed: false };

  const [player] = room.players.splice(idx, 1);
  clearGrace(room, player);
  sessions.delete(player.token);

  // A dropped seat takes its pacts and its open asks with it. Unreachable
  // mid-game, where seats are never removed, but the lobby case is real: a
  // leftover edge there would survive into the game as an alliance with a player
  // who no longer exists — one the rules would honour and nobody could break.
  dissolveFor(room, playerId);

  // A room with nobody human left is dead even if bots are still sitting in it:
  // bots never leave, so nothing else would ever clean it up, and it would hold
  // a seat in the open-games list forever with no way to start it.
  if (!room.players.some((p) => !p.isBot)) {
    deleteRoom(room.code);
    return { removed: true, emptied: true };
  }

  // The turn order is the players array, so removing a seat shifts the
  // rotation. Only reachable in the lobby; mid-game seats are never removed.
  if (room.hostId === playerId) reassignHost(room);
  if (room.game && room.game.turnIndex >= room.players.length) {
    room.game.turnIndex = 0;
  }
  return { removed: true, emptied: false };
}

/**
 * Frees a socket from its seat without taking the seat out of the room.
 *
 * Used when a player walks away from a decided game. `removePlayer` is wrong
 * there: the board still names them as owner of every province they took, and
 * the client colours a province by looking its owner up in `players` — so a
 * snapshot that no longer lists them leaves the provinces with no colour at all
 * (`board.js` falls back to grey) on the screens still watching. The roster is
 * the record of the game; only the socket binding has to go.
 *
 * A room nobody human is watching is dropped, because a decided game is never
 * reaped any other way: without this, every finished game would sit in memory
 * for the life of the process.
 */
export function releaseSeat(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return { released: false, emptied: false };

  player.socketId = null;
  player.connected = false;
  // Their highlight goes with them. The seat is held, so the roster still names
  // them and the board still shows their colour — but a selection is a live
  // gesture, and leaving one outlined on the table for a player who has walked
  // away reads as somebody still thinking about a move they cannot make.
  player.selected = null;
  clearGrace(room, player);

  // Bots count as connected but are not an audience.
  if (!room.players.some((p) => p.connected && !p.isBot)) {
    deleteRoom(room.code);
    return { released: true, emptied: true };
  }

  return { released: true, emptied: false };
}

/**
 * Host moves to the first connected HUMAN, then the first connected seat, then
 * any seat at all.
 *
 * The human preference is load-bearing rather than cosmetic. `room:abandon` is
 * host-only and it is the single way out of a match that has paused on an absent
 * player; a bot can never press it. If a bot inherited the role, the escape
 * hatch would be permanently out of reach for everyone still at the table.
 */
export function reassignHost(room) {
  // Deliberately never falls through to a bot. If no human seat exists at all —
  // a host who left a table of bots, mid-game — the role stays where it is,
  // pointing at the absent human. There is nobody left for the hatch to serve,
  // and a bot holding it would make the invariant impossible to state, let alone
  // test.
  const next = room.players.find((p) => p.connected && !p.isBot) ?? room.players.find((p) => !p.isBot);
  if (next) room.hostId = next.id;

  return room.hostId;
}

/**
 * Hands the host role to a player who is actually here, when the seat holding it
 * is not.
 *
 * Mid-game this is the only thing between a present player and a dead table.
 * Seats are never removed once play starts, so a role that has landed on an
 * absent human takes the way out with it: `room:abandon` is host-only and
 * `room:leave` is refused mid-game. `reassignHost` cannot avoid that on its own
 * — it runs when the last human disconnects, and at that moment there is nobody
 * connected to prefer. The claim can only be made later, by whoever comes back.
 *
 * Lobby rooms are left alone on purpose: there the grace timer will drop an
 * absent host within LOBBY_GRACE_MS, and letting a refresh hand the role away
 * mid-blur would be worse than waiting.
 */
export function reclaimAbsentHost(room, player) {
  if (room.phase !== PHASE.PLAYING || player.isBot) return room.hostId;

  // A host id naming no seat at all is claimed too: nobody holds the hatch, so
  // leaving it pointed at a ghost would be the same dead end by another route.
  const host = room.players.find((p) => p.id === room.hostId);
  if (host?.connected) return room.hostId;

  room.hostId = player.id;
  return room.hostId;
}

export function deleteRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  // index.js owns the bot timer, but a dangling one would outlive the room it
  // was scheduled for. It re-checks `rooms.has` and so would not mutate
  // anything — clearing it here just stops it from ever firing at all.
  clearTimeout(room.botTimer);
  room.botTimer = null;
  for (const p of room.players) {
    clearGrace(room, p);
    sessions.delete(p.token);
  }
  room.players.length = 0;
  rooms.delete(code);
}

/** Finds the room and player owning a socket id, for the disconnect handler. */
export function findBySocketId(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find((p) => p.socketId === socketId);
    if (player) return { room, player };
  }
  return null;
}

export function connectedCount(room) {
  return room.players.filter((p) => p.connected).length;
}

export function playerOf(room, playerId) {
  return room.players.find((p) => p.id === playerId) ?? null;
}

/**
 * The full client-facing snapshot. Derived fresh every call rather than cached
 * so it can never disagree with the board — territory counts and `waitingFor`
 * are both computed here.
 */
export function buildSnapshot(room) {
  const game = room.game;
  const current = game ? room.players[game.turnIndex] : null;

  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    connected: p.connected,
    isBot: p.isBot === true,
    isHost: p.id === room.hostId,
    eliminated: p.eliminated,
    territoryCount: game ? territoryCount(game.board, p.id) : 0,
    stock: p.stock ?? 0,
    // Published so every client can outline what the others are looking at. It
    // is a province id, never a target list: the targets are derivable from the
    // board next to it, so shipping them would be shipping it twice.
    selected: room.phase === PHASE.PLAYING ? (p.selected ?? null) : null,
    // Diplomacy is public: the snapshot is one broadcast object, so every client
    // sees who is allied with whom and who has asked whom, for free. That is the
    // decided design rather than an accident of the wire format.
    //
    // `allies` goes out at every phase — it is `[]` by construction before the
    // game starts, so there is nothing to withhold. `requested` does not: a
    // pending question stops existing when the game does, and leaving it on the
    // wire afterwards would have the rail offering to withdraw an ask that can
    // no longer be answered.
    allies: [...(p.allies ?? [])],
    requested: room.phase === PHASE.PLAYING ? [...(p.requested ?? [])] : [],
  }));

  // The game is only paused when the player whose turn it is has gone away.
  // An absent defender never blocks anything.
  const waitingFor =
    room.phase === PHASE.PLAYING && current && !current.connected
      ? { playerId: current.id, name: current.name }
      : null;

  return {
    code: room.code,
    phase: room.phase,
    mapId: room.mapId,
    sizeId: room.sizeId ?? null,
    mapVersion: game ? game.map.version : null,
    hostId: room.hostId,
    players,
    turn: room.phase === PHASE.PLAYING && current ? { playerId: current.id } : null,
    waitingFor,
    // Who is ahead, so the rail can mark the seat. Published rather than left to
    // the client to work out from the board next to it, even though it is
    // derivable, because it is not a fact but a rule: the bots ally against the
    // seat `leaderOf` names, and a client with its own copy of the ranking could
    // quietly come to name a different one. Null in the lobby, where there is no
    // board to rank.
    leaderId: game ? leaderOf(game.board) : null,
    winnerId: game?.winnerId ?? null,
    version: game ? game.version : 0,
    lastEvent: game?.lastEvent ?? null,
    board: game ? { owner: game.board.owner, dice: game.board.dice } : null,
  };
}
