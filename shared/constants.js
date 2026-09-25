// Shared between the Node server and the browser client. Must stay dependency-free
// and free of any Node/browser-specific API so both can import it.

/** Hard cap on dice stacked in one territory. */
export const MAX_DICE = 8;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

/** How long a lobby seat is held after a disconnect before it's released. */
export const LOBBY_GRACE_MS = 15_000;

/** Board dimensions in SVG user units; clients scale via viewBox. */
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 700;

/**
 * How big a board is, as a province count — orthogonal to the map *style*
 * (Ridge, Archipelago, …), which only decides how the land is carved.
 *
 * The canvas does not grow with the count. The board is drawn with
 * `preserveAspectRatio="xMidYMid meet"` inside a container it always fits, so a
 * larger canvas would render at exactly the same size on screen and buy nothing
 * — the provinces would simply be spread thinner. Size is therefore the count,
 * and a bigger board means more provinces, each one smaller.
 *
 * `null` (or an unknown id) means "whatever the style asks for", which is what
 * every board used before sizes existed.
 */
export const MAP_SIZES = [
  { id: 'small', name: 'Small', cells: 40 },
  { id: 'medium', name: 'Medium', cells: 70 },
  { id: 'large', name: 'Large', cells: 110 },
  { id: 'huge', name: 'Huge', cells: 150 },
];

/**
 * The size the picker starts on, rather than leaving the style to choose.
 *
 * Must be an id in `MAP_SIZES`: the client selects this option by value, and a
 * value that matches no `<option>` silently falls back to the empty entry —
 * which would look like the default working while doing something else.
 */
export const DEFAULT_SIZE_ID = 'medium';

/** The size entry for an id, or null when it is absent or unrecognised. */
export function mapSize(sizeId) {
  return MAP_SIZES.find((s) => s.id === sizeId) ?? null;
}

/** Join-code alphabet with 0/O and 1/I/L removed to survive being read aloud. */
export const CODE_LENGTH = 6;
export const CODE_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';

/** Player colours, indexed by join order. Chosen for mutual distinguishability
 *  as adjacent board fills; every one reads clearly under a white dice badge. */
export const PALETTE = [
  '#4e79a7', // blue
  '#f28e2b', // orange
  '#59a14f', // green
  '#e15759', // red
  '#b07aa1', // purple
  '#76b7b2', // teal
  '#edc948', // yellow
  '#9c755f', // brown
];

/** How many provinces a player is dealt at setup. The rest go neutral. */
export const MAX_TERRITORIES_PER_PLAYER = 5;

/**
 * The owner id of land nobody plays: dealt as leftovers once every player has
 * had their starting five.
 *
 * Deliberately NOT a member of `room.players`. A synthetic player row would be
 * counted by `checkWin`, which counts non-eliminated *players* — so a neutral
 * "player" holding land would keep two of them alive forever and the game could
 * never be won. It would also be paid reinforcement and be given turns.
 *
 * Because it is only ever an owner id in `board.owner`, almost nothing else has
 * to know it exists: `refreshEliminated` and `checkWin` iterate `players`, not
 * the board, so they ignore it for free.
 */
export const NEUTRAL = 'neutral';

export const NICKNAME_MAX = 16;

/** Every failure the server can report, as a stable code the client can switch on. */
export const ERR = {
  BAD_REQUEST: 'bad_request',
  NAME_INVALID: 'name_invalid',
  NAME_TAKEN: 'name_taken',
  NO_SUCH_ROOM: 'no_such_room',
  GAME_IN_PROGRESS: 'game_in_progress',
  GAME_OVER: 'game_over',
  ROOM_FULL: 'room_full',
  ALREADY_SEATED: 'already_seated',
  NOT_HOST: 'not_host',
  NOT_ENOUGH_PLAYERS: 'not_enough_players',
  MAP_TOO_SMALL: 'map_too_small',
  UNKNOWN_SESSION: 'unknown_session',
  NOT_YOUR_TURN: 'not_your_turn',
  NO_BOT_TURN: 'no_bot_turn',
  NOT_OWNER: 'not_owner',
  NOT_ADJACENT: 'not_adjacent',
  OWN_TERRITORY: 'own_territory',
  NOT_PLAYABLE: 'not_playable',
  TOO_FEW_DICE: 'too_few_dice',
  NO_SUCH_PLAYER: 'no_such_player',
  ALLIANCE_SELF: 'alliance_self',
  ALREADY_ALLIED: 'already_allied',
  NOT_ALLIED: 'not_allied',
  NO_PENDING_REQUEST: 'no_pending_request',
  SERVER_ERROR: 'server_error',
};

/** Human-readable text for each error code; the client shows these verbatim. */
export const ERR_TEXT = {
  [ERR.BAD_REQUEST]: 'That request was malformed.',
  [ERR.NAME_INVALID]: `Pick a name between 1 and ${NICKNAME_MAX} characters.`,
  [ERR.NAME_TAKEN]: 'Someone in that game already has that name.',
  // Not "no game with that code": codes are internal now, and this is what a
  // stale row comes back with.
  [ERR.NO_SUCH_ROOM]: 'That game is no longer available.',
  [ERR.GAME_IN_PROGRESS]: 'That game has already started.',
  [ERR.GAME_OVER]: 'That game is over.',
  [ERR.ROOM_FULL]: `That game is full (${MAX_PLAYERS} players).`,
  [ERR.ALREADY_SEATED]: "You're already in a game — leave it first.",
  [ERR.NOT_HOST]: 'Only the host can do that.',
  [ERR.NOT_ENOUGH_PLAYERS]: `You need at least ${MIN_PLAYERS} connected players to start.`,
  [ERR.MAP_TOO_SMALL]: 'This map has too few territories for that many players.',
  [ERR.UNKNOWN_SESSION]: 'That game is no longer available.',
  [ERR.NOT_YOUR_TURN]: "It's not your turn.",
  [ERR.NO_BOT_TURN]: 'No bot is thinking right now.',
  [ERR.NOT_OWNER]: "You don't own that territory.",
  [ERR.NOT_ADJACENT]: 'That territory is not adjacent.',
  [ERR.OWN_TERRITORY]: 'That territory is already yours.',
  [ERR.NOT_PLAYABLE]: 'That space is impassable.',
  [ERR.TOO_FEW_DICE]: 'That territory needs at least 2 dice to attack.',
  [ERR.NO_SUCH_PLAYER]: 'That player is no longer in the game.',
  [ERR.ALLIANCE_SELF]: "You can't ally with yourself.",
  [ERR.ALREADY_ALLIED]: 'You are already allied with them.',
  [ERR.NOT_ALLIED]: 'You are not allied with them.',
  // Covers both readings of "there is nothing to answer": a request that was
  // already dealt with (two clients can both click Accept on one offer, and the
  // loser has to be able to discard the answer quietly) and a cancellation of
  // something that is no longer pending.
  [ERR.NO_PENDING_REQUEST]: 'That alliance request is no longer open.',
  [ERR.SERVER_ERROR]: 'Something went wrong on the server.',
};

/** Wire protocol event names, so the two halves cannot drift. */
export const EV = {
  // client -> server
  RESUME: 'session:resume',
  CREATE: 'lobby:create',
  JOIN: 'lobby:join',
  LEAVE: 'lobby:leave',
  START: 'lobby:start',
  ADD_BOT: 'lobby:addBot',
  REMOVE_BOT: 'lobby:removeBot',
  ATTACK: 'game:attack',
  END_TURN: 'game:endTurn',
  // "I am tired of waiting for the machine" — finishes the current bot's turn
  // without the delay. Not turn-gated and not host-gated: any human at the table
  // may call it, since it only ever takes time away.
  HURRY: 'game:hurry',
  // Which province this player has picked as an attack source. There is no
  // matching server->client event: it comes back in the snapshot, like every
  // other piece of per-player state.
  SELECT: 'game:select',
  // Alliance actions, one verb each — the same shape as ADD_BOT/REMOVE_BOT
  // rather than one event carrying an action flag, so every one of the four is
  // validated separately and refuses with its own code. None of them is
  // turn-gated: a player has to be able to answer an offer while somebody else
  // is thinking, or diplomacy would only happen on your own turn.
  //
  // DECLINE covers the requester withdrawing their own ask as well as the target
  // refusing it. The server knows which side called it off and says so in the
  // event it publishes, so the log stays accurate without a fifth verb.
  ALLIANCE_REQUEST: 'game:allianceRequest',
  ALLIANCE_ACCEPT: 'game:allianceAccept',
  ALLIANCE_DECLINE: 'game:allianceDecline',
  ALLIANCE_BREAK: 'game:allianceBreak',
  ABANDON: 'room:abandon',
  // server -> client
  MAP: 'room:map',
  STATE: 'room:state',
  CLOSED: 'room:closed',
  LOBBY_LIST: 'lobby:list',
};

export const PHASE = { LOBBY: 'lobby', PLAYING: 'playing', OVER: 'over' };
