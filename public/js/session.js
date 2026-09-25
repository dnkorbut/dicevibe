// Session persistence for the player's seat token.
//
// This uses sessionStorage, NOT localStorage, and that choice is load-bearing.
// localStorage is shared by every tab of a browser, so all your tabs would
// present the same identity and you could never test two players at once.
// sessionStorage is per-tab, so N tabs are N distinct players — and it still
// survives a refresh, which is what makes the reconnect path work.
//
// Fresh tokens are minted server-side on every create/join, so even Chrome's
// Duplicate Tab (which copies sessionStorage) can't leave two tabs fighting over
// one seat.

const KEY = 'dicevibe.session';

export function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save({ token, roomCode, playerId }) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ token, roomCode, playerId }));
  } catch {
    /* private mode or storage disabled — the game still works, just no resume */
  }
}

export function clear() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
