// SVG board renderer.
//
// One <polygon> per territory plus a dice cipher, all built once per map and then
// mutated in place. Because the polygons are real DOM nodes, hit-testing and
// hover are the browser's problem — there is no coordinate math anywhere in the
// client, and the server's geometry is used verbatim.

import { NEUTRAL } from '/shared/constants.js';

const NS = 'http://www.w3.org/2000/svg';

/**
 * The fill for land nobody plays.
 *
 * A named constant rather than a colour-map fallback, because the fallback is
 * also what an unknown owner id gets: if neutral land and a client bug both
 * render as the same grey, neither is diagnosable. This grey is deliberately
 * outside PALETTE — desaturated, so a neutral province never reads as a player's.
 */
const NEUTRAL_COLOR = '#3a3f4d';

/**
 * The dice-cipher font size for a board, in map units.
 *
 * A fixed size only works for the 30–80 province boards it was chosen on. A
 * larger size packs more cells into the same canvas, so a fixed font would
 * overflow its province and neighbouring digits would touch on a Huge board —
 * the number is the only thing worth reading on a province, so it has to stay
 * inside its own cell. The size therefore tracks a characteristic cell size,
 * `sqrt(area / count)`, which is what the jittered grid aims for.
 *
 * The clamp keeps the boards that already exist looking as they did: 80
 * provinces lands on exactly the old 30, and small boards are held at 32 rather
 * than ballooning to fill a big cell they never needed to.
 *
 * This used to size a badge circle as well, at `0.3 * characteristic` clamped
 * to 16..30 with the font at 1.07x that. The circle is gone, so the two steps
 * are folded into the single factor below; 0.321 is 0.3 * 1.07 and the bounds
 * are the old radius bounds scaled the same way.
 */
function cipherFontSize(width, height, count) {
  const characteristic = Math.sqrt((width * height) / Math.max(1, count));
  return Math.max(17, Math.min(32, Math.round(0.321 * characteristic)));
}

export function createBoard(svgEl, { onTerritoryClick, onBackgroundClick }) {
  let map = null;
  let cells = [];

  // Everything about the highlight, all of it presentational. It never reaches
  // the server and never changes what a click does, so it lives here rather than
  // in main.js, which has no state to keep.
  //
  // `hoverCell` is the province actually under the cursor, and it answers one
  // small question: which single field to outline.
  //
  // `focusOwner` is the player whose empire is spared the fade. It is set from
  // outside — by the rail's rows and by a click on somebody's province, both
  // resolved in main.js — and deliberately NOT by the pointer crossing the map.
  // Following the pointer meant the whole board darkened and lightened again on
  // every province the mouse passed over, which is a lot of motion for a fact
  // nobody asked for; the two triggers that remain are both deliberate.
  let hoverCell = null;
  let focusOwner = null;
  // The last board `update()` painted, so a hover can be resolved without
  // reaching back into app state.
  let owners = null;
  // Likewise the last selection and who we are, for the two questions above.
  let lastSelection = null;
  let lastMyId = null;

  // Registered once; mount() must not add listeners or they'd stack on remount.
  svgEl.addEventListener('click', () => onBackgroundClick());

  /**
   * Paints the outline on the field under the cursor and the fade over every
   * player but the focused one.
   *
   * The outline used to be drawn round the whole empire under the cursor. That
   * was too much: a white outline round twenty provinces is a second set of
   * borders on top of the real ones, and it made the board hardest to read
   * exactly when you were looking at it. The fade does that job on its own, and
   * the outline is left to answer the smaller question of which single field
   * you are about to click. It is drawn for your own land always (which of yours
   * is under the cursor is the thing `.mine`'s hairline cannot say), and for an
   * enemy's only while a source is selected, which is when you are picking a
   * target and want to be sure which field you are about to hit.
   */
  function paintHover() {
    // A selection is mid-attack, and the source and its legal targets are the
    // one thing on the board that must stay at full strength. `update` already
    // dims everything that is not one of them; fading them as well would undo
    // the only thing the selection is drawn to show.
    const attacking = lastSelection !== null && lastSelection.from !== null;
    const chosen = attacking
      ? (id) => id === lastSelection.from || lastSelection.targets.has(id)
      : null;

    // A player who has been eliminated owns nothing, so there is no empire left
    // to spare and the whole board would go dark with nothing standing out. The
    // rail drops their row and `dissolveFor` drops their pacts, so this is the
    // board's own defence: a focus that no longer names an owner is no focus.
    if (focusOwner !== null && !owners?.includes(focusOwner)) focusOwner = null;

    for (const cell of cells) {
      // Water is exempt from both halves: it is background rather than
      // anybody's field, and it is already the darkest thing on the board. The
      // handler below is what keeps a hover from ever being set on one, so this
      // is the backstop rather than the rule.
      const live = cell.playable && hoverCell !== null;
      const ownerId = owners?.[cell.id];

      cell.poly.classList.toggle(
        'hovered',
        live && cell.id === hoverCell && (ownerId === lastMyId || attacking),
      );
      // Everything but the focused player's land recedes, so theirs is the only
      // empire at full strength. Neutral land fades with the rest: "everyone
      // else" is everything that is not them.
      cell.poly.classList.toggle(
        'owner-fade',
        cell.playable && focusOwner !== null && ownerId !== focusOwner && !chosen?.(cell.id),
      );
    }
  }

  // Delegated, and `pointerover` rather than `pointermove`: the latter fires
  // continuously while the cursor sits still over one province, and this only
  // needs to run when the province under the cursor actually changes.
  //
  // The badge is a sibling of the polygon rather than a child, so `e.target` is
  // always the polygon and `closest` is belt-and-braces. It matches nothing on
  // the way out of the board, which is what clears the hover.
  //
  // Water resolves to no hover at all. A void is hit-testable like any other
  // cell, and an outline is drawn for the field under the cursor whether or not
  // it is land — so without this a lake would grow a white border and read as
  // something you could act on. Nothing else writes `hoverCell`, so refusing it
  // here is the whole fix rather than a first line of defence.
  svgEl.addEventListener('pointerover', (e) => {
    const poly = e.target.closest?.('.territory');
    const id = poly ? Number(poly.dataset.id) : null;
    const next = id !== null && cells[id]?.playable ? id : null;
    if (next === hoverCell) return;
    hoverCell = next;
    paintHover();
  });

  // Moving onto the background fires no `pointerover` for a polygon, so leaving
  // the board at all needs its own handler — otherwise the outline would stay
  // stuck on whichever province was last under the cursor.
  svgEl.addEventListener('pointerleave', () => {
    if (hoverCell === null) return;
    hoverCell = null;
    paintHover();
  });

  /**
   * Spares this player's empire from the fade, or clears the fade with null.
   *
   * Called by main.js, which is where both triggers are resolved: a pointer on a
   * row of the rail list, and a click on a province that is not yours. The board
   * does not decide either one, so it does not need to know which is in force.
   */
  function setFocus(ownerId) {
    const next = ownerId ?? null;
    if (next === focusOwner) return;
    focusOwner = next;
    paintHover();
  }

  function mount(newMap) {
    map = newMap;
    svgEl.setAttribute('viewBox', `0 0 ${map.width} ${map.height}`);
    svgEl.replaceChildren();
    cells = [];
    // Ids from the last board mean nothing against this one.
    owners = null;
    hoverCell = null;
    // A focus is a player id, and the ids of the last match mean nothing here
    // either — a fresh board starts with nothing highlighted.
    focusOwner = null;
    lastSelection = null;
    lastMyId = null;

    // Sized once per board, from the density this board actually has.
    const cipherFont = cipherFontSize(map.width, map.height, map.territories.length);

    for (const t of map.territories) {
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', t.points.map(([x, y]) => `${x},${y}`).join(' '));
      poly.setAttribute('class', 'territory');
      poly.dataset.id = String(t.id);
      poly.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also fire the background (deselect) handler
        onTerritoryClick(t.id);
      });
      svgEl.appendChild(poly);

      // A void is drawn, and is still hit-testable, but carries no cipher: a
      // "0" floating over open water would read as a territory you could take.
      //
      // The cipher is a bare <text> with nothing behind it, so it sits directly
      // on the province fill. The <g> stays because `.badge` is what carries
      // `pointer-events: none` — without it the digit would eat the hover that
      // outlines the empire and the click that selects the province.
      let badge = null;
      let text = null;

      if (t.playable) {
        badge = document.createElementNS(NS, 'g');
        badge.setAttribute('class', 'badge');
        // Via a custom property, not a `font-size` attribute: a presentation
        // attribute loses to any CSS rule, including the one on `.badge text`.
        badge.style.setProperty('--cipher-size', `${cipherFont}px`);
        text = document.createElementNS(NS, 'text');
        text.setAttribute('x', t.cx);
        text.setAttribute('y', t.cy);
        badge.append(text);
        svgEl.appendChild(badge);
      }

      // Pushed for voids too — `cells` is indexed by territory id, and the
      // reinforcement flash looks cells up by id.
      cells.push({ id: t.id, poly, text, playable: t.playable });
    }
  }

  function update({ state, selection, others, myId, interactive }) {
    if (!map || !state?.board) return;

    // Neutral land is not in `state.players`, so it has to be painted from here.
    const colors = new Map(state.players.map((p) => [p.id, p.color]));
    colors.set(NEUTRAL, NEUTRAL_COLOR);
    const { owner, dice } = state.board;
    // Kept so a hover can resolve an owner to a set of provinces between renders.
    owners = owner;
    // Ditto for the selection and our own id: a hover repaints without a render.
    lastSelection = selection;
    lastMyId = myId;

    // What the other players have selected, flattened to two lookups: province
    // id -> the colour to outline it in. Sources are kept apart from targets so
    // a province can be one player's source and another's target at once, and
    // still read as the source.
    const theirSource = new Map();
    const theirTarget = new Map();
    for (const other of others ?? []) {
      if (other.from !== null && other.from !== undefined) theirSource.set(other.from, other.color);
      // First mapping wins, so the outline doesn't flicker between two players
      // who are both eyeing the same province.
      for (const t of other.targets) if (!theirTarget.has(t)) theirTarget.set(t, other.color);
    }

    // Who we have pacts with. Read from the snapshot rather than remembered
    // here, so a pact that breaks on the server stops being drawn on the next
    // render with nothing to invalidate.
    const allies = new Set(state.players.find((p) => p.id === myId)?.allies ?? []);

    const theirMark = (id) => {
      const source = theirSource.get(id);
      if (source) return { cls: 'their-select', color: source };
      const target = theirTarget.get(id);
      return target ? { cls: 'their-target', color: target } : null;
    };

    for (const cell of cells) {
      const ownerId = owner[cell.id];
      const cl = cell.poly.classList;

      if (!cell.playable) {
        // Water is never owned, never a target and never dimmed — it is
        // background, and `.void` in the stylesheet is what it looks like.
        cl.add('void');
        cl.remove('mine', 'ally', 'selected', 'attackable', 'dim', 'their-select', 'their-target');
        continue;
      }
      cl.remove('void');

      // Players and NEUTRAL are both in `colors`. Anything else is an owner id
      // the client has never been told about, so it is painted loudly rather than
      // quietly grey: mid-game seats are never removed, so this cannot be a
      // legitimate owner, and a colour nobody chose is easier to spot in a
      // screenshot than one that matches the neutral land.
      cell.poly.setAttribute('fill', colors.get(ownerId) ?? '#ff00ff');
      cell.text.textContent = String(dice[cell.id]);

      const mineSelected = selection.from === cell.id;
      const myTarget = interactive && selection.targets.has(cell.id);

      // Someone else's selection is drawn only where ours does not reach, so the
      // two can never fight over a province — and so nothing depends on the
      // order the stylesheet happens to list the two rules in.
      const theirs = mineSelected || myTarget ? null : theirMark(cell.id);

      cl.toggle('mine', ownerId === myId);
      // An ally's land is drawn apart from everyone else's, because "an ally is
      // not a threat" is otherwise invisible on the map — the only place the
      // difference shows is which provinces stop being worth reinforcing
      // against, and that is not something a border colour can imply on its own.
      // It stays a legal target: attacking one is how a pact gets broken.
      cl.toggle('ally', allies.has(ownerId));
      cl.toggle('selected', mineSelected);
      cl.toggle('attackable', myTarget);
      cl.toggle('their-select', theirs?.cls === 'their-select');
      cl.toggle('their-target', theirs?.cls === 'their-target');

      // The colour travels as a custom property, not as a `stroke` attribute:
      // a presentation attribute loses to any CSS rule, so the class that draws
      // the outline would silently wipe it out.
      if (theirs) cell.poly.style.setProperty('--their-color', theirs.color);

      // Everything that isn't a legal target fades out while a source is
      // selected, so "who can I hit" is readable at a glance.
      cl.toggle(
        'dim',
        interactive && selection.from !== null && cell.id !== selection.from && !selection.targets.has(cell.id),
      );
    }

    // Last, because a capture flips ownership and the outline has to follow the
    // board rather than the board it was drawn against — hovering a province that
    // just changed hands would otherwise keep outlining its old owner's land.
    paintHover();
  }

  /**
   * Restarts a one-shot animation class on a cell.
   *
   * The reflow is load-bearing: adding a class that is already present does
   * nothing, so without it a second attack on the same province in the same turn
   * would sit there already-animated and appear to do nothing at all.
   */
  function pulse(cell, cls, ms) {
    cell.poly.classList.remove(cls);
    cell.poly.getBoundingClientRect(); // force reflow so the animation restarts
    cell.poly.classList.add(cls);
    setTimeout(() => cell.poly.classList.remove(cls), ms);
  }

  /** Brief highlight, used to show where reinforcement landed. */
  function flash(ids) {
    for (const id of ids) {
      const cell = cells[id];
      if (cell) pulse(cell, 'target-hit', 520);
    }
  }

  /**
   * Marks the two ends of an attack: where it came from, and what changed hands.
   *
   * The board only ever showed the dice overlay and the log, which left the map
   * itself looking untouched — a province silently changed colour under the
   * overlay. Naming both ends is what makes a bot's turn followable, especially
   * when it attacks several times in a row without a pause between turns.
   *
   * `update()` has already run by the time this is called and does not manage
   * either class, so nothing here races the render.
   */
  function markAttack({ from, to, captured }) {
    const source = cells[from];
    if (source) pulse(source, 'attacking', 900);
    // A repel leaves the defender's owner unchanged, so pulsing it as "captured"
    // would claim something that did not happen.
    if (!captured) return;
    const taken = cells[to];
    if (taken) pulse(taken, 'captured', 900);
  }

  function reset() {
    map = null;
    cells = [];
    owners = null;
    hoverCell = null;
    focusOwner = null;
    lastSelection = null;
    lastMyId = null;
    svgEl.replaceChildren();
  }

  return { mount, update, flash, markAttack, setFocus, reset };
}
