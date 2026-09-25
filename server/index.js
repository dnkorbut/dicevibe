import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';

import {
  ERR,
  EV,
  LOBBY_GRACE_MS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAP_SIZES,
  MIN_PLAYERS,
  PHASE,
  mapSize,
} from '../shared/constants.js';
import {
  allySetOf,
  breakAlliance,
  inboundRequests,
  requestAlliance,
  respondAlliance,
} from './alliances.js';
import { planAlliance, planMove } from './bot.js';
import { attack, endTurn, selectTerritory, startGame } from './game.js';
import {
  DEFAULT_MAP_ID,
  MAPS,
  MAP_CHOICES,
  generateMap,
  isKnownMap,
  mapCatalogue,
  playableCount,
} from './map.js';
import {
  addBot,
  buildSnapshot,
  createRoom,
  deleteRoom,
  findBySocketId,
  joinRoom,
  listOpenRooms,
  reassignHost,
  reclaimAbsentHost,
  releaseSeat,
  removeBot,
  removePlayer,
  rooms,
  resumeSession,
  sessions,
} from './rooms.js';

const PORT = Number(process.env.PORT) || 3000;

/**
 * How long a bot pauses before each action.
 *
 * Non-zero by default so a human can watch the dice overlay resolve and read the
 * roll log; the turn is still instantaneous to the game, it is only the
 * *presentation* that is paced. Tests set it to 0.
 *
 * It has to outlast the client's dice overlay (800ms, `showDiceRoll`) and the
 * board's attack marks (900ms), or the bot's next move replaces the animation
 * that is still playing — which is exactly what the old 700ms did against an
 * 1800ms overlay, cutting off every roll of a multi-attack turn.
 *
 * That is a two-sided constraint, and the reason all three numbers are worth
 * reading together: halving this to 1000 needed the overlay and the marks
 * shortened to match, not just a smaller number here.
 */
const BOT_DELAY_MS = (() => {
  const raw = Number.parseInt(process.env.DICEVIBE_BOT_DELAY_MS ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 1000;
})();

const app = express();
const server = createServer(app);
const io = new Server(server);

// Two headers, both belt-and-braces rather than fixes for anything known.
//
// `nosniff` means a response is taken at the type it declares, so a stray body
// that happens to look like markup can never be sniffed into executing. It is
// the backstop under the `text/plain` on the two error paths below, and it
// costs nothing anywhere else.
//
// `DENY` because nothing has any business framing this page. The session token
// lives in sessionStorage, which a frame can reach, so an invisible iframe over
// the lobby is worth ruling out even though it would need a place to put one.
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
});

app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
app.use('/shared', express.static(path.join(import.meta.dirname, '..', 'shared')));

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/maps', (_req, res) => res.json(mapCatalogue()));

/* -------------------------------------------------------------------------- */
/* Dev board preview                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Renders a board as standalone SVG, for eyeballing map generation without
 * going through the lobby. Hovering a province outlines its neighbours, which
 * is the fastest way to confirm the adjacency graph is sane.
 *
 *   /dev/map                              a fresh Ridge board
 *   /dev/map?preset=archipelago           a different style
 *   /dev/map?preset=frontier&seed=99      the same style, a different layout
 *   /dev/map?preset=archipelago&t=6       six cells, whatever the preset says
 */
app.get('/dev/map', (req, res) => {
  // Number.parseInt gives NaN for a missing param, which is not undefined — so
  // normalise first or the header renders "t=NaN".
  const rawCount = Number.parseInt(req.query.t, 10);
  const rawSeed = Number.parseInt(req.query.seed, 10);
  const count = Number.isInteger(rawCount) ? rawCount : undefined;
  const seed = Number.isInteger(rawSeed) ? rawSeed : undefined;
  // `map` is accepted as an alias: it is the name the plan used, and a query
  // parameter that is silently ignored reads as "the preset made no difference"
  // rather than as a typo.
  const asked = [req.query.preset, req.query.map].find((v) => typeof v === 'string');
  const preset = asked ?? DEFAULT_MAP_ID;

  if (!isKnownMap(preset)) {
    // text/plain, not html, and it is load-bearing. `preset` is the raw query
    // string, so serving it as HTML is reflected XSS on a page that shares an
    // origin with the game — and the game keeps its session token in
    // sessionStorage, which any script running here can read and use to take
    // the seat. A plain-text body cannot execute, so the echo stops being a
    // sink no matter what was typed into the address bar.
    res.status(400).type('text/plain').send(`unknown preset: ${preset}\n`);
    return;
  }

  // A size is a convenience here, not a contract: the preview exists to eyeball
  // geometry, so an unrecognised one falls back to the style rather than
  // refusing the page. `?size=huge` is the quickest way to look at a dense board.
  const size = typeof req.query.size === 'string' && mapSize(req.query.size) ? req.query.size : null;

  let map;
  try {
    map = generateMap({ preset, size, territoryCount: count, seed });
  } catch (err) {
    // Same reasoning as the unknown-preset branch above. This path is not
    // actually reachable with caller *text* — `t` has to survive
    // `Number.parseInt` to get here, so the message only ever interpolates a
    // number — but it is the same `send` on the same origin as the game, so it
    // takes the same type rather than resting on that staying true.
    res.status(400).type('text/plain').send(`${err.message}\n`);
    return;
  }

  res.type('html').send(renderPreview(map, { count, seed, preset, size }));
});

function renderPreview(map, params) {
  const hue = (i) => (i * 47) % 360;
  const landCount = playableCount(map.territories);
  const isLand = map.territories.map((t) => t.playable);

  const cells = map.territories
    .map((t) => {
      const points = t.points.map(([x, y]) => `${x},${y}`).join(' ');
      const fill = t.playable ? `hsl(${hue(t.id)} 55% 62%)` : '#10131c';
      // Only LAND neighbours: a void is not somewhere you can attack, so showing
      // it as adjacent in the preview would misrepresent the actual graph.
      const nb = t.neighbors.filter((n) => isLand[n]);
      const polygon = [
        `<polygon data-id="${t.id}" points="${points}"`,
        ` data-nb="${nb.join(',')}"`,
        ` fill="${fill}" stroke="#1a1a2e" stroke-width="2" />`,
      ].join('');
      // No id label on water: voids are not territories, and numbering them
      // makes the preview read as though they were.
      if (!t.playable) return polygon;
      return `${polygon}<text x="${t.cx}" y="${t.cy}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="26" font-weight="700" fill="#111" pointer-events="none">${t.id}</text>`;
    })
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>dicevibe — board preview</title>
<style>
  body { margin:0; background:#12141c; color:#c8ccd8; font:14px/1.4 system-ui,sans-serif; }
  header { padding:10px 16px; }
  svg { display:block; width:100%; max-width:${MAP_WIDTH}px; margin:0 auto; background:#0b0d13; }
  polygon { transition: opacity .12s; cursor:crosshair; }
  polygon.dim { opacity:.25; }
  polygon.hot { stroke:#fff; stroke-width:5; }
  code { color:#8fd }
</style></head>
<body>
<header>
  <strong>${map.name}</strong> — ${landCount} land / ${map.territories.length} cells
  (${((1 - landCount / map.territories.length) * 100).toFixed(1)}% water),
  version ${map.version}${params.count !== undefined ? `, t=${params.count}` : ''}${
    params.size ? `, size=${params.size}` : ''
  }${params.seed !== undefined ? `, seed=${params.seed}` : ''}.
  <code>${JSON.stringify(map.territories.filter((t) => t.playable).map((t) => t.neighbors.length))}</code>
</header>
<svg viewBox="0 0 ${map.width} ${map.height}" xmlns="http://www.w3.org/2000/svg">
${cells}
</svg>
<script>
  const polys = [...document.querySelectorAll('polygon')];
  for (const p of polys) {
    p.addEventListener('mouseenter', () => {
      const nb = new Set(p.dataset.nb.split(','));
      for (const q of polys) {
        q.classList.toggle('hot', nb.has(q.dataset.id));
        q.classList.toggle('dim', q !== p && !nb.has(q.dataset.id));
      }
    });
    p.addEventListener('mouseleave', () => {
      for (const q of polys) q.classList.remove('dim', 'hot');
    });
  }
</script>
</body></html>`;
}

/* -------------------------------------------------------------------------- */
/* Socket wiring                                                              */
/* -------------------------------------------------------------------------- */

function broadcastState(room) {
  io.to(room.code).emit(EV.STATE, buildSnapshot(room));
}

/** Last list actually sent, serialised, so an unchanged list is not re-sent. */
let lastLobbyList = null;

/**
 * Tells every connected socket which games are waiting.
 *
 * Attacking and ending a turn cannot change that list — those rooms are already
 * playing and so already excluded — but they are by far the most frequent
 * events in the system. Comparing against the last broadcast keeps `publish`
 * cheap enough to call from everywhere, which is the point: a stale row in
 * someone's menu is the one failure this feature can produce, and the cure is
 * for no call site to be able to forget the broadcast.
 */
function broadcastLobbyList() {
  const open = listOpenRooms();
  const json = JSON.stringify(open);
  if (json === lastLobbyList) return;

  lastLobbyList = json;
  io.emit(EV.LOBBY_LIST, { rooms: open });
}

/** Everything a room's membership or phase can change. */
function publish(room) {
  broadcastState(room);
  broadcastLobbyList();
}

/**
 * Publishes after a seat is dropped, which is not quite `publish`.
 *
 * When the last human leaves, `removePlayer` has already deleted the room — so
 * there is no room to send state to, and `publish` would broadcast to nobody.
 * The list still has a row to drop, though, and skipping it is invisible until
 * something unrelated happens to broadcast: every menu keeps offering a game
 * whose Join button can only fail.
 */
function publishAfterRemoval(room, emptied) {
  if (emptied) broadcastLobbyList();
  else publish(room);
}

/**
 * Whether this socket already holds a seat.
 *
 * Without this guard, a double-click on Create (or on a Join row) mints a second
 * room whose seat shares this socket id — and the disconnect handler, which
 * finds a player by socket id and stops at the first match, can then only mark
 * one of them offline. The other seat reports `connected: true` forever, so its
 * room is never grace-expired and never reaped, and it stays in the menu
 * forever behind a host who does not exist.
 *
 * A stale code is not a seat: if the room it names is gone, this is not in the
 * way of a fresh create or join.
 */
function alreadySeated(socket) {
  const room = roomOf(socket);
  return Boolean(room && room.players.some((p) => p.socketId === socket.id));
}

/* -------------------------------------------------------------------------- */
/* Bot driver                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Schedules the bot's next action, if it is a bot's turn.
 *
 * Called after every action rather than only after a turn ends, because a bot
 * that captures keeps its turn: the same call handles both "the bot acts again"
 * and "the bot handed over to another bot", and neither needs a special case.
 */
function scheduleBot(room) {
  clearTimeout(room.botTimer);
  room.botTimer = null;

  if (room.phase !== PHASE.PLAYING || !room.game) return;
  const current = room.players[room.game.turnIndex];
  if (!current?.isBot) return;

  room.botTimer = setTimeout(() => stepBot(room), BOT_DELAY_MS);
}

/**
 * One bot action: attack if there is a move worth making, otherwise end the turn.
 *
 * The loop this drives is guaranteed to terminate without a counter. Every
 * accepted attack either flips a territory — which can only happen so many times
 * before the bot owns the board — or collapses its source to 1 die, which
 * retires that stack for the rest of the turn. An attack the rules refuse is
 * turned into an end-of-turn instead of being retried, so a policy bug cannot
 * spin here either.
 *
 * The one case where the policy would otherwise stall is two provinces both at
 * MAX_DICE: no attack can ever be profitable and no reinforcement can change the
 * board, so `planMove` takes the attack anyway rather than declining forever.
 * That is what keeps the "terminates" claim above honest — see the exception in
 * `server/bot.js`. It is still not an infinite loop if that clause is removed:
 * the bot ends its turn and the game simply never finishes, which is far harder
 * to notice, and is why `test/game.test.js` drives a whole bot-vs-passive game
 * rather than checking a single move.
 */
function stepBot(room) {
  room.botTimer = null;

  // A timer that outlived its room, or fired after the game ended, must be a
  // no-op. Mutating a dead room would corrupt nothing visible, which is exactly
  // why it would go unnoticed.
  if (!rooms.has(room.code) || room.phase !== PHASE.PLAYING) return;

  const player = room.players[room.game.turnIndex];
  if (!player?.isBot) return;

  // Diplomacy first, and at most one action per tick — see `planAlliance` for
  // why the alliance and the move are never made in the same beat.
  const action = planAlliance(room.game.board, room.game.adjacency, player.id, {
    allies: player.allies,
    requested: player.requested,
    askedThisTurn: player.askedThisTurn,
    incoming: inboundRequests(room, player.id),
  });

  if (action) {
    const done = applyAlliance(room, player.id, action);
    if (!done.ok) {
      // Reported and then ignored, rather than retried: the move below still
      // advances the game, so a policy bug cannot spin here.
      console.error(`[bot] ${player.name} produced an illegal alliance action (${done.error})`);
    } else if (done.changed) {
      publish(room);
      scheduleBot(room);
      return;
    }
  }

  const move = planMove(room.game.board, room.game.adjacency, player.id, allySetOf(player));
  const result = move ? attack(room, player.id, move.from, move.to) : endTurn(room, player.id);

  if (!result.ok) {
    // Recomputing the same plan would fail the same way forever. Report it and
    // pass the turn on, which is the only way forward that cannot loop.
    console.error(`[bot] ${player.name} produced an illegal move (${result.error})`);
    endTurn(room, player.id);
  }

  publish(room);
  scheduleBot(room);
}

/**
 * How many beats one `hurry` may run before it gives up and lets the timer take
 * over again.
 *
 * This is a backstop and not the loop's real bound. A bot's turn is bounded by
 * the game — every attack either flips a province or retires a stack to 1 die, so
 * a turn always ends — but the timer version and this one fail differently: a
 * beat that somehow never terminated would only keep ticking on the timer, where
 * a synchronous loop would hang the whole process. So the loop gets a ceiling the
 * timer never needed.
 */
const MAX_HURRY_BEATS = 200;

/**
 * Finishes the waiting bot's turn now, beat by beat.
 *
 * `stepBot` is one action per beat and re-arms itself on a timer, so hurrying is
 * "call it again immediately" rather than "call it with a shorter delay" — which
 * keeps this a caller of the one thing that decides what a bot does, instead of a
 * second driver with its own copy of the policy. Each beat still publishes, so a
 * hurried turn arrives as the same sequence of snapshots the slow one does and
 * reads in the log as the moves it was, not as one jump.
 *
 * Pinned to the bot whose turn it is rather than looping on "is a bot thinking":
 * one press finishes *this* move, and if the turn then passes to another bot that
 * one keeps its normal pause. Otherwise a table of bots would play itself out to
 * the end on a single click.
 */
function hurryBot(room) {
  if (room.phase !== PHASE.PLAYING || !room.game) return;

  const botId = room.players[room.game.turnIndex]?.id;
  if (!botId) return;

  for (let beat = 0; beat < MAX_HURRY_BEATS; beat++) {
    if (!rooms.has(room.code) || room.phase !== PHASE.PLAYING) return;
    if (room.players[room.game.turnIndex]?.id !== botId) return;

    // The beat stepBot is about to run re-arms a timer on its way out, and the
    // one already pending was planned against the board as it is now — left to
    // fire it would act on a board it never looked at.
    clearTimeout(room.botTimer);
    room.botTimer = null;
    stepBot(room);
  }

  console.error(`[bot] ${botId} did not finish its turn within ${MAX_HURRY_BEATS} beats`);
}

/** Turns one `planAlliance` action into the transition that carries it out. */
function applyAlliance(room, playerId, action) {
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

/**
 * The shared half of the four alliance verbs, which differ only in which
 * transition they call.
 *
 * Re-asking something already open, or clearing a question that is already gone,
 * is routine rather than news, so only a change is broadcast — the same contract
 * as re-selecting the province already selected.
 */
function allianceOp(socket, reply, run) {
  const room = roomOf(socket);
  if (!room) {
    reply({ ok: false, error: ERR.NO_SUCH_ROOM });
    return;
  }

  const result = run(room);
  if (!result.ok) {
    reply({ ok: false, error: result.error });
    return;
  }

  reply({ ok: true });
  if (!result.changed) return;

  publish(room);
  // An offer that lands on a bot whose turn it already is gets answered on the
  // same beat rather than the next one. When it is not that bot's turn this is a
  // no-op, and the bot answers at the start of its own turn.
  scheduleBot(room);
}

function emitMap(target, room) {
  if (!room.game) return;
  target.emit(EV.MAP, { mapVersion: room.game.map.version, map: room.game.map });
}

/**
 * Wraps a handler so it always answers the client, even when it throws.
 *
 * Without this an exception inside a handler leaves the caller's button
 * spinning forever with no error — the most confusing possible failure mode for
 * something you debug by clicking.
 */
function on(socket, event, fn) {
  socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      fn(payload ?? {}, reply);
    } catch (err) {
      console.error(`[${event}] unhandled:`, err);
      reply({ ok: false, error: ERR.SERVER_ERROR });
    }
  });
}

function seat(socket, room, player) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
}

function roomOf(socket) {
  return socket.data?.roomCode ? rooms.get(socket.data.roomCode) : undefined;
}

/**
 * Holds a lobby seat briefly after a disconnect so a page refresh reclaims it.
 * Only used pre-game: once playing, seats are held indefinitely by design.
 */
function scheduleLobbyGrace(room, player) {
  clearTimeout(player.graceTimer);
  player.graceTimer = setTimeout(() => {
    player.graceTimer = null;
    if (player.connected || !rooms.has(room.code)) return;
    const { emptied } = removePlayer(room, player.id);
    publishAfterRemoval(room, emptied);
  }, LOBBY_GRACE_MS);
}

io.on('connection', (socket) => {
  // Send the list straight to the new socket. The broadcast is suppressed when
  // nothing changed, so without this a fresh tab would sit on an empty menu
  // until some other player happened to create a game.
  socket.emit(EV.LOBBY_LIST, { rooms: listOpenRooms() });

  // Attempt a resume on every connection, so the refresh path and the
  // auto-reconnect path are the same code and cannot drift apart.
  socket.on(EV.RESUME, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const { token } = payload ?? {};
      // Refuse only a socket that is already seated somewhere *else*, so the
      // ordinary path — resume on every reconnect, back into its own seat — is
      // untouched. Without this one connection can hold seats in two rooms at
      // once, and then `findBySocketId` marks only one of them offline: the
      // room it is not really in keeps a seat reporting `connected: true`
      // forever, is never grace-expired and never reaped, and sits in the menu
      // behind a host who does not exist. That is the same failure
      // `alreadySeated` guards in CREATE and JOIN — a token is just the other
      // way in, and it was the one left open.
      //
      // Both halves of the comparison have to be known before this can refuse:
      // an unresolvable token is `unknown_session` and must stay that way, so a
      // bogus token from a seated socket is not answered as if it were a seat
      // conflict.
      const sitting = roomOf(socket);
      const target = typeof token === 'string' ? sessions.get(token)?.roomCode : null;
      if (sitting && target && sitting.code !== target) {
        reply({ ok: false, error: ERR.ALREADY_SEATED });
        return;
      }

      const result = resumeSession({ token, socketId: socket.id });
      if (result.error) {
        reply({ ok: false, error: result.error });
        return;
      }

      const { room, player } = result;
      seat(socket, room, player);
      // Whoever is back may be the only human left who can abandon a table that
      // has paused on an absent host. See `reclaimAbsentHost`.
      reclaimAbsentHost(room, player);
      reply({
        ok: true,
        token: player.token,
        roomCode: room.code,
        playerId: player.id,
        phase: room.phase,
      });

      emitMap(socket, room);
      publish(room);
    } catch (err) {
      console.error(`[${EV.RESUME}] unhandled:`, err);
      reply({ ok: false, error: ERR.SERVER_ERROR });
    }
  });

  on(socket, EV.CREATE, ({ nickname, mapId, sizeId }, reply) => {
    if (alreadySeated(socket)) {
      reply({ ok: false, error: ERR.ALREADY_SEATED });
      return;
    }

    const result = createRoom({ nickname, mapId, sizeId, socketId: socket.id });
    if (result.error) {
      reply({ ok: false, error: result.error });
      return;
    }

    const { room, player } = result;
    seat(socket, room, player);
    // A fresh token is minted on every create/join rather than inherited, so
    // Chrome's Duplicate Tab (which copies sessionStorage) can't leave two tabs
    // fighting over one seat.
    reply({ ok: true, token: player.token, roomCode: room.code, playerId: player.id });
    publish(room);
  });

  on(socket, EV.JOIN, ({ code, nickname }, reply) => {
    if (alreadySeated(socket)) {
      reply({ ok: false, error: ERR.ALREADY_SEATED });
      return;
    }

    const result = joinRoom({ code, nickname, socketId: socket.id });
    if (result.error) {
      reply({ ok: false, error: result.error });
      return;
    }

    const { room, player } = result;
    seat(socket, room, player);
    reply({ ok: true, token: player.token, roomCode: room.code, playerId: player.id });
    publish(room);
  });

  on(socket, EV.LEAVE, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: true });
      return;
    }

    // Leaving mid-game has no defined meaning here. A quitter's provinces could
    // now be handed to the neutral faction rather than left ownerless — but the
    // seat policy is to hold it and pause, so the game is still there if they
    // come back, and turning a player's land over to the neutrals mid-match
    // would hand the board to whoever happens to be next to them. The host's
    // abandon button is the supported way out, and it ends the match for
    // everyone rather than silently rewriting it.
    if (room.phase === PHASE.PLAYING) {
      reply({ ok: false, error: ERR.GAME_IN_PROGRESS });
      return;
    }

    const playerId = socket.data.playerId;
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;

    // A decided game releases the seat and keeps the roster, so the board still
    // has a colour for every province; a lobby room just drops the seat, because
    // there the roster is only a waiting list. Either way the socket is freed —
    // which the one-seat guard depends on, or a game-over screen would be a dead
    // end for the next Create.
    const { emptied } =
      room.phase === PHASE.OVER ? releaseSeat(room, playerId) : removePlayer(room, playerId);
    reply({ ok: true });
    publishAfterRemoval(room, emptied);
  });

  on(socket, EV.START, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      reply({ ok: false, error: ERR.NOT_HOST });
      return;
    }

    const result = startGame(room);
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      // `startGame` drops absent seats before it can fail, so the roster may
      // have shrunk even though the game did not start. Without a republish the
      // menu keeps advertising a seat that no longer exists — and if that was
      // the last seat, the room is now an unjoinable ghost.
      if (room.players.length === 0) {
        deleteRoom(room.code);
        broadcastLobbyList();
      } else {
        publish(room);
      }
      return;
    }

    reply({ ok: true });
    // Map before state, always: the client needs geometry to render the board
    // the snapshot refers to.
    emitMap(io.to(room.code), room);
    publish(room);
    // The first player may be a bot, in which case the game starts without a
    // human touching it.
    scheduleBot(room);
  });

  on(socket, EV.ADD_BOT, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      reply({ ok: false, error: ERR.NOT_HOST });
      return;
    }

    const result = addBot(room);
    if (result.error) {
      reply({ ok: false, error: result.error });
      return;
    }

    reply({ ok: true });
    publish(room);
  });

  on(socket, EV.REMOVE_BOT, ({ playerId }, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      reply({ ok: false, error: ERR.NOT_HOST });
      return;
    }

    const result = removeBot(room, playerId);
    if (result.error) {
      reply({ ok: false, error: result.error });
      return;
    }

    reply({ ok: true });
    publish(room);
  });

  on(socket, EV.ATTACK, ({ from, to }, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }

    const result = attack(room, socket.data.playerId, from, to);
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }

    reply({ ok: true });
    publish(room);
    // A bot that is mid-turn keeps it, so the driver has to be re-armed here and
    // not only when a turn ends.
    scheduleBot(room);
  });

  // Publishing a province someone is merely looking at is the one thing on this
  // socket that is not a game action, so it is deliberately cheap: no event, no
  // version bump, and nothing at all sent when the answer is unchanged.
  on(socket, EV.SELECT, ({ from }, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }

    const result = selectTerritory(room, socket.data.playerId, from ?? null);
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }

    reply({ ok: true });
    // Clicking the province that is already selected is routine, and so is the
    // clear that follows a click on the background. Neither is news.
    if (result.changed) publish(room);
  });

  // The four alliance verbs. None of them is turn-gated, unlike ATTACK and
  // SELECT: a player has to be able to answer an offer without waiting for their
  // own turn, or diplomacy in a four-player game would be unusable.
  on(socket, EV.ALLIANCE_REQUEST, ({ playerId }, reply) => {
    allianceOp(socket, reply, (room) => requestAlliance(room, socket.data.playerId, playerId));
  });

  on(socket, EV.ALLIANCE_ACCEPT, ({ playerId }, reply) => {
    allianceOp(socket, reply, (room) => respondAlliance(room, socket.data.playerId, playerId, true));
  });

  on(socket, EV.ALLIANCE_DECLINE, ({ playerId }, reply) => {
    allianceOp(socket, reply, (room) => respondAlliance(room, socket.data.playerId, playerId, false));
  });

  on(socket, EV.ALLIANCE_BREAK, ({ playerId }, reply) => {
    allianceOp(socket, reply, (room) => breakAlliance(room, socket.data.playerId, playerId));
  });

  on(socket, EV.END_TURN, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }

    const result = endTurn(room, socket.data.playerId);
    if (!result.ok) {
      reply({ ok: false, error: result.error });
      return;
    }

    reply({ ok: true });
    publish(room);
    // The turn may have just passed to a bot.
    scheduleBot(room);
  });

  // Runs the waiting bot's turn now instead of one beat at a time.
  //
  // Deliberately not turn-gated and not host-gated: any human who is at the
  // table may press it, because it can only ever take time away — it cannot
  // change what the bot decides, only when. The bot's own policy is untouched,
  // so nothing about the game is different for having been hurried.
  on(socket, EV.HURRY, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }

    const current = room.phase === PHASE.PLAYING ? room.players[room.game.turnIndex] : null;
    if (!current?.isBot) {
      reply({ ok: false, error: ERR.NO_BOT_TURN });
      return;
    }

    reply({ ok: true });
    hurryBot(room);
  });

  // Host-only escape hatch. The disconnect policy holds a seat indefinitely, so
  // without this a single closed tab freezes a match forever with no recovery
  // short of restarting the server (which would destroy every room).
  on(socket, EV.ABANDON, (_payload, reply) => {
    const room = roomOf(socket);
    if (!room) {
      reply({ ok: false, error: ERR.NO_SUCH_ROOM });
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      reply({ ok: false, error: ERR.NOT_HOST });
      return;
    }

    const { code } = room;
    reply({ ok: true });
    // Drop the pointer, as leaving does. `socket.data` outlives the room, and a
    // stale roomCode would both defeat the one-seat-per-socket guard and, if the
    // code were ever minted again, resolve to a stranger's room.
    socket.data.roomCode = null;
    socket.data.playerId = null;
    io.to(code).emit(EV.CLOSED, { reason: 'abandoned' });
    io.in(code).socketsLeave(code);
    deleteRoom(code);
    // The room has no occupants to broadcast to any more, so this one cannot go
    // through `publish` — but the list still has a row to drop.
    broadcastLobbyList();
  });

  socket.on('disconnect', () => {
    const found = findBySocketId(socket.id);
    if (!found) return;

    const { room, player } = found;

    // The seat may already have been handed to a newer socket: Socket.IO only
    // fires `disconnect` after the ping timeout, by which point a reconnecting
    // client is usually already back on a new socket id. Acting on this stale
    // socket would mark a live player offline, and since the policy is to wait
    // rather than skip, that would freeze the match permanently.
    if (player.socketId !== socket.id) return;

    player.socketId = null;
    player.connected = false;
    // Drop their highlight with them, the same as `releaseSeat` does: the seat
    // is held through the grace period, so without this an absent player would
    // keep a province outlined as if they were still choosing a move.
    player.selected = null;

    // Mid-game, seats are never removed, so nothing else would ever move the
    // host role off an absent player. That matters because `room:abandon` is
    // host-only: the one way out of a permanently paused match would belong to
    // the player who just walked away, leaving everyone else with no recovery.
    // In the lobby this is left to the grace timer, so a refresh does not cost
    // the host their role.
    if (room.hostId === player.id && room.phase !== PHASE.LOBBY) reassignHost(room);

    if (room.phase === PHASE.LOBBY) scheduleLobbyGrace(room, player);
    publish(room);
  });
});

server.listen(PORT, () => {
  console.log(`dicevibe listening on http://localhost:${PORT}`);
  // No board to report: the layout is minted per game, and a size is no longer a
  // property of the process. List the styles instead — the menu, which is what a
  // host can actually pick, not every preset the generator knows.
  const styles = MAP_CHOICES.map((id) => `${id} (${MAPS[id].cells})`).join(', ');
  console.log(`  styles: ${styles}`);
  console.log(`  sizes:  ${MAP_SIZES.map((s) => `${s.id} (${s.cells})`).join(', ')}`);
  console.log(`  preview any of them at /dev/map?preset=<id>&size=<id>`);
  console.log(`  need ${MIN_PLAYERS}+ players to start`);
});

// Surface the shape of the process for debugging; helpful when a room wedges.
//
// SIGTERM as well as SIGINT, because in a container this process is PID 1 and
// the kernel does not apply a signal's default action to PID 1 — without a
// handler here `docker stop` would ignore SIGTERM and wait out its full grace
// period before resorting to SIGKILL.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\nshutting down — ${rooms.size} room(s), ${sessions.size} session(s)`);
    process.exit(0);
  });
}
