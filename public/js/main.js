// App shell: socket wiring, client state, and the single render path.
//
// The client is a pure projection of the server's snapshots. It never mutates
// game state locally — clicks become intents, and what you see is always what
// the server last said.

import { io } from '/socket.io/socket.io.esm.min.js';
import { ERR_TEXT, EV, PHASE } from '/shared/constants.js';
import { createBoard } from './board.js';
import * as lobby from './lobby.js';
import * as session from './session.js';
import * as ui from './ui.js';

const app = {
  socket: null,
  connected: false,
  ready: false, // true once we know whether this tab is in a game
  token: null,
  roomCode: null,
  playerId: null,
  state: null,
  openRooms: [],
  map: null,
  mapVersion: null,
  selection: { from: null, targets: new Set() },
  // The player whose empire the board leaves at full strength while it fades
  // everyone else. Set by a click on one of their provinces, and by pointing at
  // their row in the rail — which is transient, so it lives in ui.js and is
  // resolved against this one on every hover. Never sent anywhere: it is a way
  // of looking at the board, not a move.
  focusOwner: null,
  // Whose turn the last snapshot had, so a turn that has just come back to us
  // can be told from a turn we were already sitting on. Null until a game is
  // seen, which is what keeps the first snapshot of a session — a fresh deal, a
  // reload, a resume — from raising the frame over a move that did not just
  // arrive.
  lastTurnPlayerId: null,
  // The turn is ours and the pointer has not been over the map since. The only
  // thing that drives the red frame, and the only piece of the client's state
  // that a pointer move can change.
  awaitingMove: false,
  lastAnimatedVersion: 0,
  primed: false, // set once a snapshot has been seen, so reloads don't replay
};

const board = createBoard(ui.boardEl, { onTerritoryClick, onBackgroundClick });

const errText = (res) => ERR_TEXT[res?.error] ?? ERR_TEXT.server_error;

/* ── session adoption ──────────────────────────────────────────────────────── */

function adopt({ token, roomCode, playerId }) {
  app.token = token ?? app.token;
  app.roomCode = roomCode;
  app.playerId = playerId;
  app.primed = false; // the next snapshot establishes the animation baseline
  session.save({ token: app.token, roomCode, playerId });
}

function leaveToMenu() {
  session.clear();
  app.token = null;
  app.roomCode = null;
  app.playerId = null;
  app.state = null;
  app.map = null;
  app.mapVersion = null;
  app.selection = { from: null, targets: new Set() };
  app.focusOwner = null;
  app.lastTurnPlayerId = null;
  app.awaitingMove = false;
  app.lastAnimatedVersion = 0;
  app.primed = false;
  board.reset();
  ui.clearLog();
  ui.clearOverlays();
  ui.setAbandonVisible(false);
  render();
}

/* ── rendering ─────────────────────────────────────────────────────────────── */

function render() {
  if (!app.ready) {
    ui.setScreen('connecting');
    return;
  }

  if (!app.playerId || !app.state) {
    ui.setScreen('menu');
    lobby.renderOpenGames(app.openRooms);
    return;
  }

  if (app.state.phase === PHASE.LOBBY) {
    ui.setScreen('lobby');
    lobby.renderLobby(app);
    return;
  }

  ui.setScreen('game');
  renderGame();
}

function renderGame() {
  const state = app.state;

  // Remount only when the board itself changed, never on a routine update.
  if (app.map && state.mapVersion !== app.mapVersion) {
    board.mount(app.map);
    app.mapVersion = state.mapVersion;
  }

  // A snapshot can arrive just before its map after a resume; the HUD is still
  // worth drawing, so only the board waits.
  const interactive = app.connected && canInteract();

  if (app.map) {
    board.update({
      state,
      selection: app.selection,
      others: otherSelections(state),
      myId: app.playerId,
      interactive,
    });
  }

  // A machine is playing, so there is a wait to skip. Disabled the rest of the
  // time, which includes a human's turn: that one is already theirs to end, and
  // a button that is offered and then refuses is worse than one that is visibly
  // not available.
  const current = state.players.find((p) => p.id === state.turn?.playerId);
  ui.hurryBtn.disabled = !(state.phase === PHASE.PLAYING && current?.isBot === true);

  // The turn has come round to us, and the map says so: a red frame round the
  // whole board until the pointer comes over it. The rail's turn line
  // deliberately says nothing on your own turn — the End turn button says it
  // instead — so this was the one handover at the table with nothing marking it.
  //
  // Lifted only on a *change* of turn. The id starts null and is never
  // ourselves, so the first snapshot of a session — a fresh deal, a reload, a
  // resume — does not raise the frame over a move that was already ours. Put
  // away either when the pointer arrives (see the listener below) or when the
  // turn leaves again, so ending a turn without touching the map does not leave
  // it up over a bot's.
  const turnNow = state.turn?.playerId ?? null;
  const oursNow = turnNow !== null && turnNow === app.playerId;

  if (oursNow && app.lastTurnPlayerId !== null && app.lastTurnPlayerId !== app.playerId) {
    app.awaitingMove = true;
  }
  if (!oursNow) app.awaitingMove = false;

  ui.setBoardAlert(app.awaitingMove);
  app.lastTurnPlayerId = turnNow;

  ui.setScreen('game');
  ui.renderTurnLine(state, app.playerId);
  ui.renderRail(state, app.playerId);
  ui.setInteractive(interactive);
  ui.endTurnBtn.disabled = !interactive;
  ui.renderHint(state, app.playerId, app.selection, app.map);
  ui.updateWaiting(state, app.playerId);
  ui.updateGameOver(state, app.playerId);
  ui.setAbandonVisible(state.hostId === app.playerId && state.phase !== PHASE.OVER);

  consumeEvent(state.lastEvent);
}

/**
 * Animates whatever just happened, exactly once.
 *
 * Because the marker lives in the snapshot, this is idempotent: a tab that
 * reloads mid-game receives a snapshot whose `lastEvent` may be seconds old and
 * correctly does not replay it.
 */
function consumeEvent(event) {
  if (!event || event.version <= app.lastAnimatedVersion) return;
  app.lastAnimatedVersion = event.version;

  ui.pushLog(event, app.state.players);

  if (event.type === 'attack') {
    board.markAttack(event);
  } else if (event.type === 'reinforce') {
    board.flash(event.territories);
    // Neutral growth rides in its own field rather than in `territories`, since
    // that list is the reinforcing player's own provinces — and flashing someone
    // else's land as if they had just reinforced it would be a lie. It is
    // flashed separately because it is still news about the board.
    board.flash(event.neutralGrowth ?? []);
  }
}

/* ── interaction ───────────────────────────────────────────────────────────── */

function canInteract() {
  const state = app.state;
  return (
    !!state &&
    state.phase === PHASE.PLAYING &&
    state.turn?.playerId === app.playerId &&
    !state.waitingFor
  );
}

/**
 * The provinces `playerId` could attack from `from`.
 *
 * Used for two different players: the local one, to know what to highlight and
 * which click is an attack; and everyone else, so their selection can be drawn
 * with its targets. The rule is the same for both, so it lives in one place —
 * the only asymmetry is that a wrong answer for somebody else is cosmetic, while
 * for the local player it is the difference between a click attacking and a
 * click doing nothing.
 *
 * `owner[n] !== playerId` alone would offer every VOID as a target, since water
 * is owned by nobody. Voids have to be filtered out, or the board lights up with
 * attackable lakes and every click on one comes back as an error.
 */
function attackTargets(state, map, from, playerId) {
  const neighbors = map?.territories?.[from]?.neighbors;
  if (!neighbors) return new Set();

  const targets = new Set(
    neighbors.filter((n) => {
      const owner = state.board.owner[n];
      return owner !== null && owner !== playerId;
    }),
  );

  // A 1-die territory can still be selected — but it can't attack, so it has no
  // targets at all, however many enemies it borders.
  return state.board.dice[from] >= 2 ? targets : new Set();
}

/** What the rest of the table has selected, in a shape the board can draw. */
function otherSelections(state) {
  const others = [];

  for (const p of state.players) {
    if (p.id === app.playerId || p.selected === null || p.selected === undefined) continue;
    others.push({
      playerId: p.id,
      color: p.color,
      from: p.selected,
      targets: attackTargets(state, app.map, p.selected, p.id),
    });
  }

  return others;
}

function clearSelection() {
  // Only worth telling the server about if there was something to clear: this
  // runs on paths that never had a selection (leaving a game, a rejected
  // click), and each one would otherwise cost the room a broadcast.
  const had = app.selection.from !== null;
  app.selection = { from: null, targets: new Set() };
  if (had) publishSelection(null);
}

/**
 * Tells the room which province is selected, so the board reads as shared
 * rather than private.
 *
 * Silently does nothing before the game starts and after it ends: the server
 * only accepts a selection while a game is running, and after leaving a room it
 * would answer `no_such_room`.
 */
function publishSelection(from, onRejected) {
  if (!app.socket || app.state?.phase !== PHASE.PLAYING) return;

  app.socket.emit(EV.SELECT, { from }, (res) => {
    // The server rejects a selection that isn't ours, or that arrives on
    // somebody else's turn — which happens when this tab's snapshot is a moment
    // stale. Dropping the local highlight keeps the two from disagreeing, with
    // this screen showing a selection the rest of the table was never told about.
    if (!res?.ok) onRejected?.();
  });
}

function selectSource(id) {
  const state = app.state;
  const dice = state.board.dice[id];
  const targets = attackTargets(state, app.map, id, app.playerId);

  app.selection = { from: id, targets };
  publishSelection(id, () => {
    clearSelection();
    render();
  });

  if (dice < 2) {
    ui.toast('That territory has only 1 die — it can defend but not attack.');
  } else if (targets.size === 0) {
    // Legitimately common on a watery map: a coastal province whose only
    // neighbours are sea really does have nowhere to attack.
    ui.toast('That territory has no adjacent enemies.');
  }

  render();
}

/**
 * Fades everyone but the player who owns `id`, or fades nobody when that player
 * is already the one being looked at.
 *
 * Sticky, unlike the rail's hover, because a click is a deliberate act and the
 * empire you asked to see should stay put while you read it. Clicking the same
 * province again is the way out, the same click-to-undo gesture the selection
 * uses.
 */
function focusOn(id) {
  const owner = app.state.board.owner[id];
  app.focusOwner = app.focusOwner === owner ? null : owner;
  board.setFocus(app.focusOwner);
}

/** Drops the focused empire, if there is one. */
function clearFocus() {
  if (app.focusOwner === null) return;
  app.focusOwner = null;
  board.setFocus(null);
}

function onTerritoryClick(id) {
  const state = app.state;
  if (!state?.board) return;

  // Out of turn there is no move to make, so a click can only ever be a request
  // to look at something. It is handled here rather than behind the `canInteract`
  // guard below because the moment you most want to study somebody's empire is
  // while a bot is playing its turn, which is exactly when you cannot act.
  if (!canInteract()) {
    if (state.board.owner[id] === null) onBackgroundClick();
    else if (state.board.owner[id] !== app.playerId) focusOn(id);
    return;
  }

  // Clicking water behaves exactly like clicking the background. Without this it
  // would fall through to the "not adjacent" toast whenever a source happened to
  // be selected, which describes a problem the player does not have.
  if (state.board.owner[id] === null) {
    onBackgroundClick();
    return;
  }

  if (app.selection.from !== null && app.selection.targets.has(id)) {
    attack(app.selection.from, id);
    return;
  }

  if (state.board.owner[id] === app.playerId) {
    // Clicking the province already selected puts it back down. A selection dims
    // the rest of the map and takes over the hint line, and until now the only
    // way to clear it was to click the background — never where the eye is after
    // choosing a province. Clicking the same province twice is the obvious
    // gesture, so it has to be the one that undoes it.
    //
    // This cannot collide with the attack branch above: `attackTargets` filters
    // out provinces you own, so your own selection is never one of its own
    // targets.
    //
    // Either way the focus goes: a selection is about to dim the board against
    // its own targets, and an empire still faded out from earlier would leave the
    // attack you are planning half dark.
    clearFocus();
    if (app.selection.from === id) {
      clearSelection();
      render();
      return;
    }
    selectSource(id);
    return;
  }

  // Somebody else's province, and not a legal target for the selection in hand:
  // the click is a request to look at that player's empire.
  focusOn(id);
  if (app.selection.from !== null) ui.toast('Not adjacent to your selected territory.');
  clearSelection();
  render();
}

function onBackgroundClick() {
  const had = app.selection.from !== null || app.focusOwner !== null;
  if (!had) return;
  app.focusOwner = null;
  board.setFocus(null);
  clearSelection();
  render();
}

function attack(from, to) {
  app.socket.emit(EV.ATTACK, { from, to }, (res) => {
    if (!res?.ok) ui.toast(errText(res), 'error');
    clearSelection();
    render();
  });
}

/* ── socket ────────────────────────────────────────────────────────────────── */

const socket = io();
app.socket = socket;

socket.on('connect', () => {
  app.connected = true;
  ui.setConnected(true);

  // Resume on every connect, not just the first. That makes a page refresh and
  // a dropped-socket auto-reconnect the same code path.
  const saved = session.load();
  if (!saved?.token) {
    app.ready = true;
    render();
    return;
  }

  socket.emit(EV.RESUME, { token: saved.token }, (res) => {
    if (res?.ok) {
      adopt(res);
    } else {
      session.clear();
      app.token = null;
      app.playerId = null;
      app.roomCode = null;
      app.state = null;
      ui.toast(errText(res), 'error');
    }
    app.ready = true;
    render();
  });
});

socket.on('disconnect', () => {
  app.connected = false;
  ui.setConnected(false);
  // An ack in flight when the socket died will never arrive, so the entry guard
  // has to be cleared here or the menu would stop responding to Create.
  entryPending = false;
  render();
});

socket.on(EV.MAP, ({ mapVersion, map }) => {
  app.map = map;
  app.mapVersion = null; // force a remount against the incoming geometry
  void mapVersion;
  render();
});

socket.on(EV.STATE, (state) => {
  app.state = state;
  if (!app.primed) {
    app.lastAnimatedVersion = state.version;
    app.primed = true;
  }
  render();
});

socket.on(EV.LOBBY_LIST, ({ rooms }) => {
  app.openRooms = rooms ?? [];
  // Cheap and only drawn on the menu, but routing it through the one render path
  // means the list cannot be stale when you get back there — including after
  // leaving a game, which does not itself trigger a list update.
  render();
});

socket.on(EV.CLOSED, () => {
  leaveToMenu();
  ui.toast('The host ended the game.', 'info');
});

/* ── wiring ────────────────────────────────────────────────────────────────── */

lobby.init({
  onCreate: ({ nickname, mapId, sizeId }) => {
    enter(EV.CREATE, { nickname, mapId, sizeId });
  },
  onJoin: ({ nickname, code }) => {
    enter(EV.JOIN, { nickname, code });
  },
  onStart: () => {
    socket.emit(EV.START, {}, (res) => {
      if (!res?.ok) ui.toast(errText(res), 'error');
    });
  },
  onAddBot: () => {
    socket.emit(EV.ADD_BOT, {}, (res) => {
      if (!res?.ok) ui.toast(errText(res), 'error');
    });
  },
  onRemoveBot: (playerId) => {
    socket.emit(EV.REMOVE_BOT, { playerId }, (res) => {
      if (!res?.ok) ui.toast(errText(res), 'error');
    });
  },
  onLeave: () => {
    socket.emit(EV.LEAVE, {}, (res) => {
      if (!res?.ok) {
        ui.toast(errText(res), 'error');
        return;
      }
      leaveToMenu();
    });
  },
});

// The four alliance verbs, as the rail names them in `data-act`. `decline` is
// also what the rail sends for withdrawing your own unanswered request — the
// server knows which side called it off and logs the difference.
const ALLIANCE_EVENTS = {
  request: EV.ALLIANCE_REQUEST,
  accept: EV.ALLIANCE_ACCEPT,
  decline: EV.ALLIANCE_DECLINE,
  break: EV.ALLIANCE_BREAK,
};

ui.initRail({
  onAlliance: (act, playerId) => {
    const event = ALLIANCE_EVENTS[act];
    if (!event) return;

    socket.emit(event, { playerId }, (res) => {
      if (!res?.ok) ui.toast(errText(res), 'error');
    });
  },

  // The row under the pointer wins while the pointer is in the list; letting go
  // of the list falls back to whatever was clicked rather than to nothing, so a
  // click focus is not wiped by brushing past the sidebar.
  onPlayerFocus: (playerId) => board.setFocus(playerId ?? app.focusOwner),
});

/**
 * Puts the frame away: the pointer is on the map.
 *
 * That is the whole of what the frame asks for — it is there to send the eye to
 * the board, and looking at the board is what answers it. Nothing else clears
 * it, so it stays up through a whole turn for a player who never looks away
 * from the rail, which is exactly who needs it.
 */
function seenTheBoard() {
  if (!app.awaitingMove) return;
  app.awaitingMove = false;
  ui.setBoardAlert(false);
}

ui.boardEl.addEventListener('pointermove', seenTheBoard);
// A tap is a pointer that never moved, and it is how a touchscreen looks at the
// board. Cheap to cover, and a frame left up after a deliberate tap reads as a
// bug rather than as a reminder.
ui.boardEl.addEventListener('pointerdown', seenTheBoard);

ui.endTurnBtn.addEventListener('click', () => {
  socket.emit(EV.END_TURN, {}, (res) => {
    if (!res?.ok) ui.toast(errText(res), 'error');
    clearSelection();
  });
});

// A success needs no handling: the hurried turn arrives as ordinary snapshots,
// which is the whole point of hurrying it. A refusal is always a race — the wait
// it meant to skip had already ended when the click landed — and it is reported
// rather than swallowed, because the two refusals mean different things and one
// of them ("that game is no longer available") is worth knowing about.
ui.hurryBtn.addEventListener('click', () => {
  socket.emit(EV.HURRY, {}, (res) => {
    if (!res?.ok) ui.toast(errText(res), 'error');
  });
});

ui.abandonBtn.addEventListener('click', () => {
  socket.emit(EV.ABANDON, {}, (res) => {
    if (!res?.ok) ui.toast(errText(res), 'error');
  });
});

document.getElementById('btn-again').addEventListener('click', () => {
  // Hand the seat back before walking away: the socket stays bound to the
  // finished room otherwise, and the menu would refuse the next Create or Join
  // as a second seat — every game would end in a dead end escapable only by
  // reloading the page.
  //
  // Fire and forget. The menu has to appear whether or not the server answers,
  // and an unanswered LEAVE costs nothing: the socket dropping releases it.
  socket.emit(EV.LEAVE, {}, () => {});
  leaveToMenu();
});

/**
 * Creates or joins, ignoring repeat clicks until the first one answers.
 *
 * The server refuses a second seat on one socket either way — this is only so a
 * double-click doesn't put "You're already in a game" on screen for a click the
 * player never meant to make. The ack is guaranteed to arrive, because the
 * server wraps every handler, so the flag cannot stick.
 */
let entryPending = false;

function enter(event, payload) {
  if (entryPending) return;
  entryPending = true;

  socket.emit(event, payload, (res) => {
    entryPending = false;
    handleEntry(res);
  });
}

function handleEntry(res) {
  if (!res?.ok) {
    lobby.showError(res?.error);
    return;
  }
  lobby.clearError();
  adopt(res);
  render();
}

lobby.loadMaps();
render();

// Debug handle. The server is authoritative, so exposing this can't desync a
// game — it just makes the client inspectable from the console, which is how you
// work out what a tab thinks is going on when you're testing several at once.
window.dicevibe = app;
