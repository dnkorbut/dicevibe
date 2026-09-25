// HUD, overlays, roll log and toasts.
//
// Everything that renders user-supplied text (player names) goes through
// textContent, never innerHTML — names come from other players on a shared
// origin.

import { PHASE } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

export const boardEl = $('board');

const connBanner = $('conn-banner');
const turnLine = $('turn-line');
const hintLine = $('hint-line');
const gamePlayers = $('game-players');
const rollLog = $('roll-log');
const toasts = $('toasts');
const waitingOverlay = $('overlay-waiting');
const waitingTitle = $('waiting-title');
const waitingBody = $('waiting-body');
const gameOverOverlay = $('overlay-gameover');
const winnerTitle = $('winner-title');
const winnerSwatch = $('winner-swatch');
const boardWrap = document.querySelector('.board-wrap');

export const endTurnBtn = $('btn-end-turn');
export const hurryBtn = $('btn-hurry');
export const abandonBtn = $('btn-abandon');

// The rules popup's two ways in, its way out, and the panel itself — which the
// wiring needs so a click on the backdrop around the card can close it.
export const rulesBtn = $('btn-rules');
export const rulesMenuBtn = $('btn-rules-menu');
export const rulesOverlay = $('overlay-rules');
export const closeRulesBtn = $('btn-rules-close');

const MAX_LOG = 12;

/**
 * The last MAX_LOG events, newest first.
 *
 * The log is redrawn from this on every push rather than having a line prepended
 * to it, because the newest line is not drawn like the others: it shows its dice
 * as dice. When a newer event arrives the previous one has to lose that and go
 * back to plain numbers, which means the whole list is rebuilt.
 */
let logEvents = [];

/* ── small DOM helpers ─────────────────────────────────────────────────────── */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const nameOf = (players, id) => players.find((p) => p.id === id)?.name ?? '—';
const colorOf = (players, id) => players.find((p) => p.id === id)?.color ?? '#666';

/* ── screens and chrome ────────────────────────────────────────────────────── */

export function setScreen(name) {
  document.body.dataset.screen = name;
}

export function setConnected(connected) {
  connBanner.hidden = connected;
}

export function toast(message, kind = 'info') {
  const node = el('div', `toast ${kind}`, message);
  toasts.appendChild(node);
  setTimeout(() => node.remove(), 3200);
  while (toasts.children.length > 3) toasts.firstChild.remove();
}

/* ── turn line, hint, rail ─────────────────────────────────────────────────── */

export function renderTurnLine(state, myId) {
  turnLine.replaceChildren();

  if (state.phase === PHASE.OVER) {
    turnLine.append(el('span', null, 'Game over'));
    return;
  }

  // Nothing is said while it is your own turn. The End Turn button directly
  // under this line is enabled exactly then and disabled otherwise, so the words
  // would only be repeating the button, on a rail that is already narrow.
  const currentId = state.turn?.playerId;
  if (currentId === myId) return;

  const name = nameOf(state.players, currentId);

  // A bot holds the turn for the whole of its delay, and it is the only player
  // who takes a turn without anything on screen saying so otherwise — an idle
  // human at least grows a "reconnecting…" tag, and a bot never does. Saying
  // "thinking" is what turns that pause into a beat rather than a hang.
  const current = state.players.find((p) => p.id === currentId);
  if (state.phase === PHASE.PLAYING && current?.isBot) {
    turnLine.append(el('span', 'thinking', `${name} is thinking…`));
    turnLine.append(el('span', 'tag', 'bot'));
    return;
  }

  turnLine.append(document.createTextNode(`${name}'s turn`));
}

/**
 * Contextual one-liner. Also the place that tells a player with no legal move
 * that ending the turn is the correct and only action — the End Turn button is
 * never disabled for them.
 */
export function renderHint(state, myId, selection, map) {
  if (state.phase === PHASE.OVER) {
    hintLine.textContent = '';
    return;
  }

  if (state.turn?.playerId !== myId) {
    hintLine.textContent = '';
    return;
  }

  if (selection.from !== null) {
    const dice = state.board.dice[selection.from];
    hintLine.textContent =
      selection.targets.size > 0
        ? `Attacking from ${selection.from} (${dice} dice) — pick a highlighted neighbour.`
        : `Territory ${selection.from} has no adjacent enemies.`;
    return;
  }

  const mine = state.board.owner
    .map((ownerId, i) => (ownerId === myId ? i : -1))
    .filter((i) => i !== -1);

  // An ally counts as friendly here, so a player boxed in by pacts gets the same
  // honest "end your turn" a bot does instead of being nudged to attack the one
  // player who is not a threat to them.
  const me = state.players.find((p) => p.id === myId);
  const allies = new Set(me?.allies ?? []);

  // A stack is only worth naming if it has somewhere to go. On a watery board a
  // landlocked 8 can exist, and pointing at it would send the player to a click
  // that does nothing.
  const hasEnemyNeighbour = (i) => {
    const neighbors = map?.territories[i]?.neighbors;
    if (!neighbors) return true; // no map yet (just after a resume) — stay optimistic
    return neighbors.some((n) => {
      const owner = state.board.owner[n];
      return owner !== null && owner !== myId && !allies.has(owner);
    });
  };

  const canAttackFrom = mine.filter((i) => state.board.dice[i] >= 2 && hasEnemyNeighbour(i));

  if (canAttackFrom.length === 0) {
    const anyWithDice = mine.some((i) => state.board.dice[i] >= 2);
    hintLine.textContent = anyWithDice
      ? 'No territory of yours borders an enemy. End your turn.'
      : 'Every territory is down to 1 die — no attacks available. End your turn.';
    return;
  }

  // Nothing to say. Which provinces can move is already on the board — the legal
  // targets light up as soon as one is selected — and naming a suggestion was a
  // line of hand-holding the rail does not have room for.
  hintLine.textContent = '';
}

/**
 * The alliance control for one other player, or null when there is none to draw.
 *
 * One control per state rather than a menu, and a glyph rather than a word: the
 * rail is a fixed 320px column and a row already carries a swatch, a name, a bot
 * tag, `12 terr · 4 stock` and a connection dot, so the four alliance states have
 * to fit in whatever is left. `+`/`−` read as "add them to my side" and "take
 * them off it"; `✓`/`✕` are the pair of answers to one offer; `↩` is a retraction.
 *
 * Which makes `title` load-bearing rather than a nicety — it is now the only
 * place the action is spelled out, and it doubles as the accessible name so the
 * button is not nameless to a screen reader.
 *
 * The pending states are read from the two `requested` lists — mine against
 * theirs — because an inbound request is derived rather than published: if they
 * have asked me and I have not answered, their list names me.
 */
function allianceControl(me, other) {
  const btn = (glyph, act, title) => {
    const node = el('button', 'ghost ally', glyph);
    node.dataset.act = act;
    node.dataset.player = other.id;
    node.title = title;
    node.setAttribute('aria-label', title);
    return node;
  };

  if ((me.allies ?? []).includes(other.id)) {
    return btn('−', 'break', `Break the alliance with ${other.name}`);
  }

  if ((other.requested ?? []).includes(me.id)) {
    // Both answers, side by side — an offer with only one visible response is
    // not a question.
    const group = el('span', 'ally-actions');
    group.append(btn('✓', 'accept', `Accept ${other.name}'s alliance`));
    group.append(btn('✕', 'decline', `Decline ${other.name}'s alliance`));
    return group;
  }

  // Already asked. `decline` is the right verb from this side too: the server
  // sees who called it off and logs a withdrawal rather than a refusal.
  if ((me.requested ?? []).includes(other.id)) {
    return btn('↩', 'decline', `Withdraw your alliance request to ${other.name}`);
  }

  return btn('+', 'request', `Propose an alliance to ${other.name}`);
}

export function renderRail(state, myId) {
  gamePlayers.replaceChildren();
  const currentId = state.turn?.playerId;
  const me = state.players.find((p) => p.id === myId);

  for (const p of state.players) {
    // A player who is out leaves the list rather than sitting in it greyed. The
    // rail is a picture of who is still in the game, and a struck-through row
    // spends a permanent line of a narrow sidebar saying only that somebody lost.
    //
    // Only once play has begun: `eliminated` is meaningful in a game, but the
    // lobby shares this renderer and a player who has not been dealt a province
    // yet is not out of anything.
    if (state.phase !== PHASE.LOBBY && p.eliminated) continue;

    const li = el('li');
    // Which player this row is about, for the hover below. On the row rather
    // than only on the alliance button because pointing anywhere in the row —
    // the name, the tag, the counts — should show that player's empire.
    li.dataset.player = p.id;
    li.classList.toggle('is-turn', p.id === currentId && state.phase === PHASE.PLAYING);

    li.append(el('span', 'swatch'));
    li.lastChild.style.background = p.color;

    li.append(el('span', 'name', p.id === myId ? `${p.name} (you)` : p.name));

    // Who is ahead, so the table can see the seat the bots are treating as the
    // one to beat. Drawn from the snapshot rather than worked out here, because
    // it is a rule and not a fact — see `leaderId` in `buildSnapshot`. Null
    // everywhere but a dealt board, so the lobby shows nothing.
    //
    // A bare crown rather than a word: this rail is a fixed 320px and the row
    // already carries a swatch, a name, a bot pill, `12 terr · 4 stock` and a
    // connection dot, so a fifth word would push the numbers off the end. The
    // glyph carries the meaning and the `title` carries the words, the same
    // bargain the alliance buttons make.
    if (p.id === state.leaderId) {
      const crown = el('span', 'crown', '♚');
      crown.title = 'Ahead on the board';
      crown.setAttribute('aria-label', 'Ahead on the board');
      li.append(crown);
    }

    // Bots are marked so a bot seat is never mistaken for a person who has gone
    // quiet — in particular it can never be showing as reconnecting.
    if (p.isBot) li.append(el('span', 'tag', 'bot'));

    const meta =
      state.phase === PHASE.LOBBY
        ? p.id === state.hostId
          ? 'host'
          : ''
        : `${p.territoryCount} terr${p.stock > 0 ? ` · ${p.stock} stock` : ''}`;
    li.append(el('span', 'meta', meta));

    if (state.phase === PHASE.PLAYING) {
      li.append(el('span', `dot${p.connected ? '' : ' off'}`));
      // Nothing for our own row, and nothing once the game is over — there is no
      // diplomacy left to do, and `requested` is already withheld by then.
      if (me && p.id !== myId) li.append(allianceControl(me, p));
    }

    gamePlayers.append(li);
  }
}

export function setInteractive(interactive) {
  boardWrap.classList.toggle('inert', !interactive);
}

/**
 * Paints the board's surround red: it is your move and the pointer has not been
 * over the map since.
 *
 * The surround rather than a line drawn on the map, because the map's edge is
 * not where the eye stops seeing it: `#board` is letterboxed inside the column
 * whenever the window is wider than the map's aspect, and the wrapper adds
 * fourteen more pixels of padding on top of that. A line at the map edge would
 * trace it and leave every one of those pixels still looking like empty
 * background — which is exactly the "is this thing waiting for me?" gap the
 * colour is meant to close. Painting the wrapper's own background fills the
 * whole gap at whatever thickness the window gives it, and the map covers the
 * middle of it for free.
 */
export function setBoardAlert(on) {
  boardWrap.classList.toggle('alert', on === true);
}

export function setAbandonVisible(visible) {
  abandonBtn.hidden = !visible;
}

/**
 * Binds the rail's alliance controls and its row hover, once.
 *
 * Delegated, because `renderRail` rebuilds the rows from scratch on every
 * snapshot: a listener per row would leak one for every player who has ever been
 * in the game. It is the same shape, for the same reason, as the lobby's bot
 * buttons.
 *
 * The verb travels in `data-act` exactly as the server names it, so there is no
 * mapping table here to fall out of step with the four events.
 *
 * `onPlayerFocus` reports the player whose row the pointer is in, or null when
 * it leaves the list — which is what makes hovering a name the way to look at
 * somebody's empire.
 */
export function initRail({ onAlliance, onPlayerFocus }) {
  gamePlayers.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    onAlliance(btn.dataset.act, btn.dataset.player);
  });

  // Bound to the list rather than to the rows, so a rebuild under a stationary
  // pointer — every snapshot does one — re-reports the same player instead of
  // dropping the focus, and so a listener count stays at one however many
  // players come and go.
  //
  // Deliberately silent when the pointer is over the list but not over a row:
  // the rows are 6px apart, and clearing on the way across a gap would flash the
  // board between two empires. Leaving the list is what clears it.
  gamePlayers.addEventListener('pointerover', (e) => {
    const row = e.target.closest?.('li[data-player]');
    if (row) onPlayerFocus(row.dataset.player);
  });
  gamePlayers.addEventListener('pointerleave', () => onPlayerFocus(null));
}

/* ── waiting / game over ───────────────────────────────────────────────────── */

export function updateWaiting(state, myId) {
  const waiting = state.waitingFor;

  if (!waiting) {
    waitingOverlay.hidden = true;
    return;
  }

  // Seats are held indefinitely by design, so the game genuinely stops here.
  // Say so plainly rather than looking broken.
  if (waiting.playerId === myId) {
    waitingTitle.textContent = 'Reconnecting…';
    waitingBody.textContent = 'Your seat is being held.';
  } else {
    waitingTitle.textContent = `Waiting for ${waiting.name}`;
    waitingBody.textContent =
      `${waiting.name} disconnected. The game will not skip their turn — ` +
      `it waits for them to come back.`;
  }

  waitingOverlay.hidden = false;
}

/**
 * Hides every modal overlay.
 *
 * `updateWaiting`/`updateGameOver` are only ever called from `renderGame`, so
 * leaving a game leaves whichever overlay was last shown still covering the
 * screen — the game-over panel would sit on top of the menu, swallowing every
 * click. Anything that tears a game down has to call this.
 *
 * The rules panel is the one overlay with no snapshot behind it, so nothing
 * would ever put it away on its own: opened mid-game and then abandoned, it
 * would cover the menu with the board already gone. It comes down here for the
 * same reason as the other two, not because it is in the same state.
 */
export function clearOverlays() {
  waitingOverlay.hidden = true;
  gameOverOverlay.hidden = true;
  rulesOverlay.hidden = true;
}

export function setRulesOpen(open) {
  rulesOverlay.hidden = !open;
}

export function updateGameOver(state, myId) {
  if (state.phase !== PHASE.OVER || !state.winnerId) {
    gameOverOverlay.hidden = true;
    return;
  }

  winnerTitle.textContent =
    state.winnerId === myId
      ? 'You win!'
      : `${nameOf(state.players, state.winnerId)} wins`;
  winnerSwatch.style.background = colorOf(state.players, state.winnerId);
  gameOverOverlay.hidden = false;
}

/* ── roll log ──────────────────────────────────────────────────────────────── */

/**
 * One side's dice, as faces when this is the newest line and as numbers when it
 * is not.
 *
 * The dice are the only thing in the log worth looking at rather than reading,
 * and they are also the widest — eight of them wrap onto three lines of a 320px
 * column. So only the line that just happened draws them; every older line keeps
 * the bracketed numbers, which is the whole history in a fraction of the height.
 * The sum is printed either way: it is what the outcome is decided on, and it
 * costs four characters.
 */
function rollsRow(rolls, sum, asDice) {
  const row = el('span', asDice ? 'dice-rolls' : 'rolls');
  if (asDice) {
    for (const r of rolls) row.append(el('span', 'die', String(r)));
  } else {
    row.textContent = `[${rolls.join(',')}]`;
  }

  const wrap = el('span', null);
  wrap.append(row);
  wrap.append(el('span', 'sum', `=${sum}`));
  return wrap;
}

/**
 * Turns a server event into a log line.
 *
 * The log prints every die and both sums, which makes the combat rule — and the
 * reinforcement formula — directly checkable by reading, rather than needing to
 * force a particular dice outcome.
 *
 * `asDice` is true for the newest line only; see `rollsRow`.
 */
export function describeEvent(event, players, asDice = false) {
  if (!event) return null;

  if (event.type === 'attack') {
    const node = el('div');
    node.append(el('span', 'who', nameOf(players, event.attackerId)));
    node.append(document.createTextNode(' '));
    node.append(rollsRow(event.attackerRolls, event.attackerSum, asDice));
    node.append(document.createTextNode(' → '));
    node.append(rollsRow(event.defenderRolls, event.defenderSum, asDice));
    node.append(document.createTextNode(' '));
    node.append(el('span', event.captured ? 'win' : 'lose', event.captured ? 'CAPTURED' : 'REPELLED'));

    if (event.eliminatedPlayerId) {
      node.append(document.createTextNode(' '));
      node.append(el('span', 'lose', `— ${nameOf(players, event.eliminatedPlayerId)} eliminated`));
    }
    if (event.brokeAlliance) {
      node.append(document.createTextNode(' '));
      node.append(el('span', 'lose', `— alliance with ${nameOf(players, event.defenderId)} broken`));
    }
    return node;
  }

  // Five actions, because `decline` covers two situations the server can tell
  // apart and the log should not blur: the asked player turning an offer down,
  // and the asker withdrawing their own. `actorId` is always whoever the click
  // belonged to, so every line below reads from their side.
  //
  // Note what this branch protects: `describeEvent` returns null for a type it
  // does not know and `pushLog` no-ops on null, so forgetting a case here fails
  // silently with a green test suite. Nothing automated covers it.
  if (event.type === 'alliance') {
    const actor = nameOf(players, event.actorId);
    const other = nameOf(players, event.otherId);
    const node = el('div');
    node.append(el('span', 'who', actor));

    const lines = {
      request: ` proposed an alliance to ${other}`,
      accept: ` and ${other} are now allied`,
      decline: ` declined ${other}'s alliance`,
      withdraw: ` withdrew the alliance request to ${other}`,
      break: ` broke the alliance with ${other}`,
    };

    node.append(document.createTextNode(lines[event.action] ?? ` — alliance ${event.action}`));
    return node;
  }

  if (event.type === 'reinforce') {
    const node = el('div');
    node.append(el('span', 'who', nameOf(players, event.playerId)));
    node.append(document.createTextNode(' reinforced '));
    node.append(el('span', 'rein', `+${event.gain}`));
    // `gain + carried-in === placed + stockLeft`, so the line reads back as a
    // complete account of where every die went — including the dice that had to
    // wait because the board was full.
    if (event.placed > 0) node.append(document.createTextNode(` · ${event.placed} placed`));
    if (event.stockLeft > 0) {
      node.append(document.createTextNode(`, ${event.stockLeft} held in reserve`));
    }
    return node;
  }

  return null;
}

/**
 * Records an event on the log and redraws it, newest first.
 *
 * An event `describeEvent` does not know produces no line — and, because it is
 * still stored, no line for it appears later either. That is the same silent
 * failure as before, and it is why the `alliance` branch has to exist even
 * though nothing automated can see it.
 */
export function pushLog(event, players) {
  if (!event) return;

  logEvents.unshift(event);
  if (logEvents.length > MAX_LOG) logEvents.length = MAX_LOG;

  rollLog.replaceChildren();
  logEvents.forEach((e, i) => {
    const node = describeEvent(e, players, i === 0);
    if (!node) return;
    const li = el('li');
    li.append(node);
    rollLog.append(li);
  });
}

export function clearLog() {
  logEvents = [];
  rollLog.replaceChildren();
}
