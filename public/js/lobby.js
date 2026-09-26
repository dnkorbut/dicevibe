// Menu and lobby screens.

import { DEFAULT_SIZE_ID, ERR_TEXT, MAP_SIZES, MAX_PLAYERS, MIN_PLAYERS } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);

const nicknameInput = $('nickname');
const mapSelect = $('map-select');
const sizeSelect = $('size-select');
const createBtn = $('btn-create');
const menuError = $('menu-error');
const openGames = $('open-games');
const openGamesEmpty = $('open-games-empty');
const lobbyMap = $('lobby-map');
const lobbyPlayers = $('lobby-players');
const lobbyHint = $('lobby-hint');
const startBtn = $('btn-start');
const addBotRow = $('add-bot');
const leaveBtn = $('btn-leave');

const NAME_KEY = 'dicevibe.nickname';

let maps = [];
let handlers = {};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Remembers the name per-tab, so a refresh doesn't lose what you typed. */
function rememberName(name) {
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function init(nextHandlers) {
  handlers = nextHandlers;

  try {
    nicknameInput.value = sessionStorage.getItem(NAME_KEY) ?? '';
  } catch {
    /* ignore */
  }

  createBtn.addEventListener('click', () => {
    const nickname = readName();
    rememberName(nickname);
    handlers.onCreate({ nickname, mapId: mapSelect.value, sizeId: sizeSelect.value });
  });

  // Delegated, because the rows are rebuilt on every list update. Binding per
  // row would leak a listener for every room that has ever been on screen.
  openGames.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-code]');
    if (!btn) return;
    const nickname = readName();
    rememberName(nickname);
    handlers.onJoin({ nickname, code: btn.dataset.code });
  });

  // Enter in the name field picks the first open game, which is the only thing
  // there is to do with a name.
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = openGames.querySelector('button[data-code]');
    if (first) first.click();
    else createBtn.click();
  });

  startBtn.addEventListener('click', () => handlers.onStart());
  leaveBtn.addEventListener('click', () => handlers.onLeave());

  // Delegated, for the same reason as the two lists below: four buttons that
  // differ only in a data attribute are one listener, not four. The attribute is
  // read as the version to seat, and the empty string is passed through rather
  // than swallowed — it is the server's "deal me one", not a missing value.
  addBotRow.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bot-version]');
    if (!btn) return;
    handlers.onAddBot(btn.dataset.botVersion);
  });

  // Delegated for the same reason as the open-games list: the rows are rebuilt
  // on every snapshot.
  lobbyPlayers.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bot]');
    if (btn) handlers.onRemoveBot(btn.dataset.bot);
  });
}

/**
 * The name to join under, or '' to let the server pick one.
 *
 * Blank is deliberately not an error: the game names you `Player N`, so joining
 * is a single click and the field is only for players who care what they are
 * called. Whatever comes back is remembered for next time.
 */
function readName() {
  const name = nicknameInput.value.replace(/\s+/g, ' ').trim();
  clearError();
  return name;
}

export function showError(code) {
  menuError.textContent = ERR_TEXT[code] ?? ERR_TEXT.bad_request;
  menuError.hidden = false;
}

export function clearError() {
  menuError.hidden = true;
}

export async function loadMaps() {
  try {
    const res = await fetch('/api/maps');
    maps = await res.json();
  } catch {
    maps = [];
  }

  // No value is set below on purpose: the catalogue arrives in menu order and a
  // `<select>` with nothing selected shows its first option, so the server's
  // first style is the preselection.
  mapSelect.replaceChildren();
  for (const m of maps) {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = m.name;
    option.title = m.description ?? '';
    mapSelect.append(option);
  }

  // Sizes come from the shared table rather than the maps response: they are the
  // same list whatever the style, and the client already imports that module.
  // The empty first option means "whatever this style asks for", which keeps
  // every style's own size reachable.
  sizeSelect.replaceChildren();
  const styleDefault = document.createElement('option');
  styleDefault.value = '';
  styleDefault.textContent = 'Style default';
  sizeSelect.append(styleDefault);

  for (const s of MAP_SIZES) {
    const option = document.createElement('option');
    option.value = s.id;
    option.textContent = s.name;
    option.title = `${s.cells} provinces`;
    sizeSelect.append(option);
  }

  // Unlike the style, the size is named outright: the first entry here is
  // "Style default", which is deliberately not what the menu opens on.
  sizeSelect.value = DEFAULT_SIZE_ID;
}

/**
 * "Archipelago · Large", or just the style when no size was chosen.
 *
 * A room row and the lobby use this so the two cannot describe the same game
 * differently, and the size is left off rather than spelled out as "default" —
 * a style that was never given a size has nothing extra to say.
 */
function mapLabel({ mapName, sizeName = null }) {
  return sizeName ? `${mapName} · ${sizeName}` : mapName;
}

/**
 * The menu's list of games waiting for players.
 *
 * Every row is a one-click join; there is no code to read, type or share. The
 * host name is other players' text, so it goes in via textContent — `el` never
 * touches innerHTML.
 */
export function renderOpenGames(rooms) {
  openGames.replaceChildren();
  openGamesEmpty.hidden = rooms.length > 0;

  for (const room of rooms) {
    const li = el('li', 'room');

    const info = el('div', 'room-info');
    info.append(el('span', 'room-host', `${room.hostName}'s game`));
    info.append(el('span', 'room-meta', `${mapLabel(room)} · ${room.seats}/${room.max}`));
    li.append(info);

    const join = el('button', 'ghost', 'Join');
    join.dataset.code = room.code;
    li.append(join);

    openGames.append(li);
  }
}

export function renderLobby(app) {
  const state = app.state;

  const mapDef = maps.find((m) => m.id === state.mapId);
  lobbyMap.textContent = `Map: ${mapLabel({
    mapName: mapDef?.name ?? state.mapId,
    // Read from the shared table, not the maps response, since it is not part of
    // the catalogue's shape.
    sizeName: MAP_SIZES.find((s) => s.id === state.sizeId)?.name ?? null,
  })}`;

  const connected = state.players.filter((p) => p.connected).length;
  const isHost = state.hostId === app.playerId;
  const reconnecting = state.players.filter((p) => !p.connected).length;
  const full = state.players.length >= MAX_PLAYERS;

  lobbyPlayers.replaceChildren();
  for (const p of state.players) {
    const li = el('li');

    const swatch = el('span', 'swatch');
    swatch.style.background = p.color;
    li.append(swatch);

    li.append(el('span', 'name', p.id === app.playerId ? `${p.name} (you)` : p.name));

    if (p.id === state.hostId) li.append(el('span', 'tag', 'host'));
    if (p.isBot) li.append(el('span', 'tag', 'bot'));
    if (!p.isBot && !p.connected) li.append(el('span', 'tag', 'reconnecting…'));

    // Only the host may act, and only on a bot — a human seat leaves by itself.
    if (isHost && p.isBot) {
      const drop = el('button', 'ghost drop', '×');
      drop.dataset.bot = p.id;
      drop.title = `Remove ${p.name}`;
      li.append(drop);
    }

    lobbyPlayers.append(li);
  }

  startBtn.hidden = !isHost;
  startBtn.disabled = connected < MIN_PLAYERS;
  // A bot counts toward the minimum, so a host with no one else around can still
  // start a game — which is the entire point of having them. The whole row hides
  // together: a version button for a table that is already full invites a click
  // that can only fail.
  addBotRow.hidden = !isHost || full;

  if (!isHost) {
    lobbyHint.textContent = 'Waiting for the host to start the game.';
  } else if (connected < MIN_PLAYERS) {
    lobbyHint.textContent = `Waiting for ${MIN_PLAYERS - connected} more player${MIN_PLAYERS - connected === 1 ? '' : 's'} — anyone with the page open can see this game and join, or add a bot to play right now.`;
  } else {
    lobbyHint.textContent = 'Ready when you are. You can start now, or wait for more players.';
  }

  if (reconnecting > 0) {
    lobbyHint.textContent +=
      ' Starting now will leave reconnecting players behind — they join no game and keep no seat.';
  }

  leaveBtn.hidden = false;
}
