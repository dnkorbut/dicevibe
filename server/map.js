// Procedural board generation. Server-only: clients receive the finished
// polygons over the wire and never run any of this.
//
// Geometry: scatter seed sites on a jittered grid, run a few rounds of Lloyd
// relaxation to even the cell shapes out, then take the Voronoi diagram clipped
// to the board rectangle. Clipping is what gives us a clean rectangular outline
// for free — cells on the edge are trimmed to the border rather than running off
// into ragged points.
//
// Water: a preset may then drown some of those cells. Voids are ordinary Voronoi
// cells that nobody owns, that can never be attacked, and that no group of
// territories can be traced through — so a lake between you and an enemy really
// does protect you. They are kept in `territories` (with `playable: false`)
// rather than dropped, which keeps ids dense and lets the board still tile the
// rectangle exactly.
//
// Everything here is a pure function of (preset, seed, count). Gameplay
// randomness — dice, ownership — is a separate per-room seed.

import { Delaunay } from 'd3-delaunay';
import { MAP_HEIGHT, MAP_WIDTH, mapSize } from '../shared/constants.js';
import { makeRng } from './rng.js';

/**
 * Generation presets. The host picks an id; the layout is minted fresh for every
 * game from the room's own seed, so two games on `continent` are different
 * boards in the same style.
 *
 * `cells` is the number of polygons, and `voidFraction` the share of them that
 * water is aimed at — so the playable count lands somewhat below
 * `cells * (1 - voidFraction)`, and the repair pass can only push it back up.
 * `DICEVIBE_TERRITORIES` overrides `cells` for every preset.
 */
export const MAPS = {
  ridge: {
    id: 'ridge',
    name: 'Ridge',
    description: 'One dry continent, carved into provinces.',
    cells: 30,
    voidFraction: 0,
    voidStyle: 'none',
    noise: { gw: 0, gh: 0, octaves: 0 },
    smoothPasses: 0,
  },
  continent: {
    id: 'continent',
    name: 'Continent',
    description: 'A broad landmass speckled with inland seas.',
    cells: 52,
    voidFraction: 0.1,
    voidStyle: 'blobs',
    noise: { gw: 6, gh: 4, octaves: 2 },
    smoothPasses: 1,
  },
  highlands: {
    id: 'highlands',
    name: 'Highlands',
    description: 'Impassable ridges cut the land into valleys.',
    cells: 56,
    voidFraction: 0.18,
    voidStyle: 'ridges',
    noise: { gw: 6, gh: 5, octaves: 1 },
    smoothPasses: 1,
  },
  archipelago: {
    id: 'archipelago',
    name: 'Archipelago',
    description: 'A drowned coast of deep bays and long inlets.',
    cells: 64,
    voidFraction: 0.26,
    voidStyle: 'islands',
    noise: { gw: 5, gh: 4, octaves: 2 },
    smoothPasses: 2,
  },
  frontier: {
    id: 'frontier',
    name: 'Frontier',
    description: 'The big one — a wide continent to fight over.',
    cells: 80,
    voidFraction: 0.12,
    voidStyle: 'blobs',
    noise: { gw: 8, gh: 6, octaves: 2 },
    smoothPasses: 1,
  },
};

/**
 * The styles a host is offered, in the order the picker lists them.
 *
 * A curated menu, not the full set the generator can make: `highlands`,
 * `archipelago` and `frontier` are still generated, still validated by the map
 * tests and still reachable at `/dev/map?preset=…` or by creating a room with
 * that id directly. They are simply not on the menu.
 *
 * ORDER IS LOAD-BEARING. `/api/maps` serves this order and the picker is a plain
 * `<select>`, which shows its first option when nothing has told it otherwise —
 * so index 0 IS the preselection. `DEFAULT_MAP_ID` names the same style
 * explicitly rather than as `MAP_CHOICES[0]` so that reordering the menu cannot
 * quietly change the default; a test pins the two together.
 */
export const MAP_CHOICES = ['continent', 'ridge'];

/**
 * The style a room gets when nobody asked for one. Must be the first entry of
 * `MAP_CHOICES` — see above.
 */
export const DEFAULT_MAP_ID = 'continent';

/** Lloyd passes. Enough to kill slivers, few enough to keep organic variation.
 *  Push this much higher and the board converges to a regular honeycomb, which
 *  looks wrong for this game. */
const LLOYD_PASSES = 3;

/** Keeps relaxed sites off the exact border so no cell degenerates. */
const MARGIN = 2;

/** How many times to re-jitter if a generated board fails validation. Higher
 *  than it once was because carving adds a second way for an attempt to come up
 *  short, and later attempts ask for progressively less water. */
const MAX_ATTEMPTS = 8;

/** No preset may ask for more water than this, however the retry decay lands. */
const MAX_VOID_FRACTION = 0.6;

/**
 * The ceiling on a board, and it is a security bound rather than a gameplay one.
 *
 * `/dev/map` reads its cell count straight off the query string and generation
 * costs roughly O(count²) — a couple of hundred thousand cells is a minute of
 * solid CPU — and there is no auth on that route, so an unbounded count is a
 * one-line way to block the event loop for every socket in the process. The
 * cost is paid synchronously, so nothing else runs while it is paid.
 *
 * The largest board the game itself can ask for is 150 (`huge`), and the only
 * other way in is the `DICEVIBE_TERRITORIES` debugging knob, so this sits far
 * past anything legitimate: it is a bound on what a bug or an attacker can ask
 * for, not a limit anyone will meet on purpose.
 */
const MAX_TERRITORIES = 2000;

/** Fixed geometry seed. Override to explore alternative continents. */
function mapSeed() {
  const raw = Number.parseInt(process.env.DICEVIBE_MAP_SEED ?? '', 10);
  return Number.isInteger(raw) ? raw >>> 0 : 20260923;
}

/**
 * The province count for a preset and an optional size.
 *
 * The environment override wins over everything, including a size the host
 * picked explicitly: it exists to make a game short enough to finish in one
 * sitting while testing (`DICEVIBE_TERRITORIES=6 npm run dev`), and the test
 * suite leans on it to pin every board to one count. Below that, an explicitly
 * chosen size beats the style's own — and no size at all leaves the style's
 * count exactly as it always was.
 */
export function defaultTerritoryCount(preset = DEFAULT_MAP_ID, sizeId = null) {
  const raw = Number.parseInt(process.env.DICEVIBE_TERRITORIES ?? '', 10);
  if (Number.isInteger(raw) && raw >= 3) return raw;

  const size = mapSize(sizeId);
  if (size) return size.cells;

  return (MAPS[preset] ?? MAPS[DEFAULT_MAP_ID]).cells;
}

const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * How many sites go in each grid row, so the count comes out exactly T.
 * Rows are balanced rather than leaving a short final row, which would stretch
 * the last few cells into ugly slabs.
 */
function rowLayout(count, width, height) {
  const rows = Math.max(1, Math.round(Math.sqrt((count * height) / width)));
  const base = Math.floor(count / rows);
  const extra = count % rows;
  const layout = [];
  for (let r = 0; r < rows; r++) layout.push(base + (r < extra ? 1 : 0));
  return layout;
}

function jitteredSites(count, rng) {
  const layout = rowLayout(count, MAP_WIDTH, MAP_HEIGHT);
  const rows = layout.length;
  const rowHeight = MAP_HEIGHT / rows;
  const sites = [];

  for (let r = 0; r < rows; r++) {
    const cols = layout[r];
    if (cols === 0) continue;
    const colWidth = MAP_WIDTH / cols;
    for (let c = 0; c < cols; c++) {
      // Jitter inside the middle of the cell: enough to break the grid up,
      // not enough to let sites cross into a neighbour's slot.
      const jx = (rng.next() - 0.5) * 0.7 * colWidth;
      const jy = (rng.next() - 0.5) * 0.7 * rowHeight;
      sites.push([(c + 0.5) * colWidth + jx, (r + 0.5) * rowHeight + jy]);
    }
  }

  return sites;
}

/**
 * Area-weighted centroid of a polygon (shoelace formula).
 *
 * Deliberately NOT the mean of the vertices — for anything that isn't a
 * triangle those differ, and Lloyd relaxation only converges to an even cell
 * distribution when it moves sites to the true centroid.
 *
 * Accepts open or closed rings; the closing edge contributes nothing.
 */
function polygonCentroid(poly) {
  const n = poly.length;
  let area = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  area *= 0.5;
  if (Math.abs(area) < 1e-9) return [poly[0][0], poly[0][1]]; // degenerate; keep the site put

  return [cx / (6 * area), cy / (6 * area)];
}

/** Extracts a cell as an open ring of rounded, de-duplicated coordinates. */
function ringOf(voronoi, i) {
  const raw = voronoi.cellPolygon(i);
  if (!raw || raw.length < 4) return null; // fewer than 3 distinct vertices

  const ring = [];
  const count = raw.length - 1; // d3 repeats the first vertex to close the ring
  for (let k = 0; k < count; k++) {
    const x = round1(raw[k][0]);
    const y = round1(raw[k][1]);
    const prev = ring[ring.length - 1];
    if (prev && prev[0] === x && prev[1] === y) continue; // collapsed by rounding
    ring.push([x, y]);
  }

  // The rounding step can also collapse the last vertex into the first.
  while (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) ring.pop();
    else break;
  }

  return ring.length >= 3 ? ring : null;
}

/**
 * Adjacency from shared polygon edges.
 *
 * Deliberately NOT `delaunay.neighbors()`: that returns triangle-graph
 * neighbours, which after clipping to the rectangle can include cells that only
 * touch at a single corner and share no border at all. Players would then see an
 * attack offered across a corner, which is not how the board reads.
 *
 * An edge shared by exactly two cells is a real border. Edges along the board
 * outline appear once and so are ignored, as are the collinear boundary
 * segments of two neighbours sitting on the same outer edge.
 *
 * Note this is the adjacency of the TESSELLATION, voids included. That is what
 * the smoothing and repair passes need. Because adjacency is only ever a shared
 * border, land cells separated by water are simply not neighbours — the land
 * graph is already the induced subgraph, with no extra work.
 */
function buildAdjacency(rings) {
  const edges = new Map();

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    for (let e = 0; e < ring.length; e++) {
      const a = ring[e];
      const b = ring[(e + 1) % ring.length];
      const key =
        a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
          ? `${a[0]},${a[1]}|${b[0]},${b[1]}`
          : `${b[0]},${b[1]}|${a[0]},${a[1]}`;

      let rec = edges.get(key);
      if (!rec) {
        rec = { cells: new Set(), count: 0 };
        edges.set(key, rec);
      }
      rec.cells.add(i);
      rec.count++;
    }
  }

  const adjacency = Array.from({ length: rings.length }, () => new Set());
  for (const rec of edges.values()) {
    if (rec.count !== 2 || rec.cells.size !== 2) continue;
    const [a, b] = [...rec.cells];
    adjacency[a].add(b);
    adjacency[b].add(a);
  }

  return adjacency.map((s) => [...s].sort((x, y) => x - y));
}

/** Breadth-first reachability across the whole board. */
function isConnected(adjacency) {
  const seen = new Uint8Array(adjacency.length);
  const stack = [0];
  seen[0] = 1;
  let reached = 1;

  while (stack.length > 0) {
    const t = stack.pop();
    for (const nb of adjacency[t]) {
      if (!seen[nb]) {
        seen[nb] = 1;
        reached++;
        stack.push(nb);
      }
    }
  }

  return reached === adjacency.length;
}

/** True when any two sites have collapsed onto each other. */
function hasCoincidentSites(sites) {
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const dx = sites[i][0] - sites[j][0];
      const dy = sites[i][1] - sites[j][1];
      if (dx * dx + dy * dy < 1e-6) return true;
    }
  }
  return false;
}

/* ── value noise ───────────────────────────────────────────────────────────── */

/**
 * Bilinear value noise over a coarse lattice, sampled in unit coordinates.
 *
 * A few dozen lines rather than a dependency: the field only has to be smooth
 * and lumpy, and every draw comes from the seeded rng in a fixed order so the
 * carve is reproducible.
 */
function makeNoise(rng, gw, gh) {
  const width = gw + 1;
  const lattice = new Float64Array(width * (gh + 1));
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();

  const at = (i, j) => lattice[j * width + i];
  // Smoothstep, so the lattice values join without a visible crease.
  const smooth = (t) => t * t * (3 - 2 * t);

  return (u, v) => {
    const x = u * gw;
    const y = v * gh;
    const i = Math.min(gw - 1, Math.floor(x));
    const j = Math.min(gh - 1, Math.floor(y));
    const fx = smooth(x - i);
    const fy = smooth(y - j);

    const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
    const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

/** Sums octaves of value noise, each at double the frequency and half the
 *  amplitude, and normalises to [0, 1]. */
function makeField(rng, { gw, gh, octaves }) {
  const layers = [];
  let norm = 0;

  for (let o = 0; o < octaves; o++) {
    const amp = 1 / 2 ** o;
    layers.push({ amp, sample: makeNoise(rng, gw * 2 ** o, gh * 2 ** o) });
    norm += amp;
  }

  return (u, v) => {
    let sum = 0;
    for (const layer of layers) sum += layer.amp * layer.sample(u, v);
    return sum / norm;
  };
}

/** 1 hard against the board edge, fading to 0 a quarter of the way in. Used to
 *  push a preset's water out to the coastline. */
function edgeFalloff(u, v) {
  const distance = Math.min(u, 1 - u, v, 1 - v);
  return Math.max(0, 1 - distance / 0.25);
}

/* ── carving ───────────────────────────────────────────────────────────────── */

/**
 * Decides which cells are water. Returns a Uint8Array flag per cell.
 *
 * Scoring then thresholding by QUANTILE, never by a fixed cutoff: sorting the
 * field and drowning the lowest `fraction` of cells hits the requested share
 * exactly, whatever shape the noise happens to have. A magic number would drift
 * with the field's distribution and give a different board size from one seed to
 * the next, which is exactly the instability a preset is meant to remove.
 */
function carveVoids(centroids, adjacency, def, rng, fraction) {
  const n = centroids.length;
  let isVoid = new Uint8Array(n);

  const target = Math.round(clamp(fraction, 0, MAX_VOID_FRACTION) * n);
  if (target <= 0) return isVoid;

  const field = makeField(rng, def.noise);
  const scored = [];

  for (let i = 0; i < n; i++) {
    const u = centroids[i][0] / MAP_WIDTH;
    const v = centroids[i][1] / MAP_HEIGHT;
    let score = field(u, v);

    // Ridges: the field's own midline becomes the wall, so the water comes out
    // as long bands rather than blobs.
    if (def.voidStyle === 'ridges') score = Math.abs(2 * score - 1);
    if (def.voidStyle === 'islands') score -= edgeFalloff(u, v);

    scored.push({ id: i, score });
  }

  // Ties break on id so the same seed always drowns the same cells.
  scored.sort((a, b) => a.score - b.score || a.id - b.id);
  for (let k = 0; k < target; k++) isVoid[scored[k].id] = 1;

  for (let pass = 0; pass < def.smoothPasses; pass++) {
    const next = Uint8Array.from(isVoid);
    for (let i = 0; i < n; i++) {
      const degree = adjacency[i].length;
      if (degree === 0) continue;

      let wet = 0;
      for (const nb of adjacency[i]) if (isVoid[nb]) wet++;
      const share = wet / degree;

      // SHARES, not neighbour counts: degree varies from 3 upward across the
      // board, so an absolute threshold would carve the corners differently
      // from the middle and produce a visible grain.
      if (isVoid[i] && share < 0.34) next[i] = 0; // a lone speck of water
      else if (!isVoid[i] && share >= 0.67) next[i] = 1; // a lone speck of land
    }
    isVoid = next;
  }

  // Smoothing changes HOW MUCH water there is as well as where — and at low
  // fractions it deletes all of it, because every lake starts out as an
  // isolated cell the rule above reads as a speck. The automaton is here to
  // shape the water, not to decide the quota, so the count is restored from the
  // score order afterwards: top up from the lowest-scoring dry cells, or drain
  // the highest-scoring wet ones.
  restoreCount(isVoid, scored, target);

  return isVoid;
}

/** Puts the void count back to `target`, choosing cells by score so the shape
 *  the smoothing produced survives. */
function restoreCount(isVoid, scored, target) {
  let wet = 0;
  for (const v of isVoid) wet += v;

  if (wet < target) {
    for (const cell of scored) {
      if (wet === target) break;
      if (isVoid[cell.id]) continue;
      isVoid[cell.id] = 1;
      wet++;
    }
  } else if (wet > target) {
    for (let k = scored.length - 1; k >= 0 && wet > target; k--) {
      const id = scored[k].id;
      if (!isVoid[id]) continue;
      isVoid[id] = 0;
      wet--;
    }
  }
}

/** Connected components of the land. `components[i]` holds member ids with the
 *  lowest id first, because the outer scan ascends and seeds each flood fill. */
function landComponents(isVoid, adjacency) {
  const componentOf = new Int32Array(isVoid.length).fill(-1);
  const components = [];

  for (let start = 0; start < isVoid.length; start++) {
    if (isVoid[start] || componentOf[start] !== -1) continue;

    const index = components.length;
    const members = [];
    const stack = [start];
    componentOf[start] = index;

    while (stack.length > 0) {
      const t = stack.pop();
      members.push(t);
      for (const nb of adjacency[t]) {
        if (!isVoid[nb] && componentOf[nb] === -1) {
          componentOf[nb] = index;
          stack.push(nb);
        }
      }
    }

    components.push(members);
  }

  return { components, componentOf };
}

/**
 * Un-drowns single cells that separate two or more land bodies, turning islands
 * into peninsulas.
 *
 * This runs BEFORE the largest-component rule below, and the order is the whole
 * point: demoting every island to water would quietly turn `archipelago` into a
 * ragged continent. Bridging recovers most of the intended shape while still
 * leaving one body of land at the end.
 *
 * Bounded by the cell count: every pass either merges two components, or finds
 * no bridging cell and returns.
 */
function bridge(isVoid, adjacency) {
  for (let guard = 0; guard <= isVoid.length; guard++) {
    const { components, componentOf } = landComponents(isVoid, adjacency);
    if (components.length <= 1) return;

    let best = -1;
    let bestMerges = 1; // must touch at least two components to be worth doing

    for (let v = 0; v < isVoid.length; v++) {
      if (!isVoid[v]) continue;
      const touched = new Set();
      for (const nb of adjacency[v]) if (!isVoid[nb]) touched.add(componentOf[nb]);
      // Strictly greater, so equal scores keep the lowest id.
      if (touched.size > bestMerges) {
        bestMerges = touched.size;
        best = v;
      }
    }

    if (best === -1) return; // genuine deep water; no single cell joins them
    isVoid[best] = 0;
  }
}

/**
 * Forces the survivors into one connected body of land, and guarantees no
 * playable cell is an island of one.
 *
 * Both properties are load-bearing for the game, not aesthetics. Land the other
 * players cannot reach means a player who can never be eliminated and a game
 * that can never end — which is precisely why the original generator rejected
 * disconnected boards outright. Repairing rather than retrying is what makes a
 * randomly carved board safe to ship.
 *
 * Exported so the adversarial cases can be tested directly: at the shipped
 * presets this fires on roughly one board in forty, which is exactly the kind
 * of rarely-taken branch that rots unnoticed.
 */
export function repairVoids(isVoid, adjacency) {
  bridge(isVoid, adjacency);

  const { components } = landComponents(isVoid, adjacency);
  if (components.length === 0) return isVoid;

  // Keep the largest, breaking ties on the lowest member id.
  let keep = components[0];
  for (const c of components) {
    if (c.length > keep.length || (c.length === keep.length && c[0] < keep[0])) keep = c;
  }

  for (const c of components) {
    if (c === keep) continue;
    for (const t of c) isVoid[t] = 1;
  }

  // An isolated cell has no legal attack in either direction, so it must go.
  // After the demotion above this only bites when the board flooded almost
  // completely and the largest body is a single cell — which then fails the
  // caller's land check and retries with less water.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < isVoid.length; i++) {
      if (isVoid[i]) continue;
      let hasLand = false;
      for (const nb of adjacency[i]) {
        if (!isVoid[nb]) {
          hasLand = true;
          break;
        }
      }
      if (!hasLand) {
        isVoid[i] = 1;
        changed = true;
      }
    }
  }

  return isVoid;
}

/* ── generation ────────────────────────────────────────────────────────────── */

/** One generation attempt. Returns null if the geometry fails validation. */
function attempt({ count, def, geoRng, carveRng, fraction }) {
  let sites = jitteredSites(count, geoRng);

  for (let pass = 0; pass < LLOYD_PASSES; pass++) {
    const delaunay = Delaunay.from(sites);
    const voronoi = delaunay.voronoi([0, 0, MAP_WIDTH, MAP_HEIGHT]);

    sites = sites.map((site, i) => {
      const raw = voronoi.cellPolygon(i);
      if (!raw) return site;
      const [cx, cy] = polygonCentroid(raw);
      return [clamp(cx, MARGIN, MAP_WIDTH - MARGIN), clamp(cy, MARGIN, MAP_HEIGHT - MARGIN)];
    });
  }

  if (hasCoincidentSites(sites)) return null;

  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi([0, 0, MAP_WIDTH, MAP_HEIGHT]);

  const rings = [];
  const centroids = [];
  for (let i = 0; i < sites.length; i++) {
    const ring = ringOf(voronoi, i);
    if (!ring) return null;
    rings.push(ring);
    centroids.push(polygonCentroid(ring));
  }

  const adjacency = buildAdjacency(rings);

  // A cell with no neighbours, or a board split into disconnected pieces, means
  // the tessellation itself is broken — bad enough that no amount of carving or
  // repair can be trusted. Reject the attempt. (This is about the GEOMETRY; the
  // land graph is checked separately by the repair pass below.)
  for (const nbs of adjacency) {
    if (nbs.length === 0) return null;
  }
  if (!isConnected(adjacency)) return null;

  const isVoid = carveVoids(centroids, adjacency, def, carveRng, fraction);
  repairVoids(isVoid, adjacency);

  return rings.map((ring, i) => ({
    id: i,
    points: ring,
    cx: round1(centroids[i][0]),
    cy: round1(centroids[i][1]),
    neighbors: adjacency[i],
    playable: !isVoid[i],
  }));
}

/** Cheap stable hash, used as the client's "have I got this board?" marker. */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h;
}

/** How many territories are actually land. */
export function playableCount(territories) {
  let n = 0;
  for (const t of territories) if (t.playable) n++;
  return n;
}

/** The dense list of land territory ids, in order. */
export function playableIds(map) {
  const ids = [];
  map.territories.forEach((t, i) => {
    if (t.playable) ids.push(i);
  });
  return ids;
}

/**
 * Generates a board of exactly `count` cells (land plus water).
 *
 * `minPlayable` is how much land the caller needs — `3 * players`, at game
 * start — and an attempt that cannot supply it is retried with a derived seed
 * and less water, so a preset that keeps flooding itself converges toward solid
 * ground rather than throwing. Only when every attempt has failed does it throw,
 * which should mean the geometry constants need revisiting, not a retry.
 */
export function generateMap({
  preset = DEFAULT_MAP_ID,
  size = null,
  seed = mapSeed(),
  territoryCount,
  minPlayable = 0,
} = {}) {
  const def = MAPS[preset] ?? MAPS[DEFAULT_MAP_ID];
  const count = territoryCount ?? defaultTerritoryCount(preset, size);
  // Both bounds are checked before any work happens, which is the point: the
  // expensive part of this function is everything below, so a refusal has to
  // come first to be worth anything.
  if (count < 3) throw new Error(`territoryCount must be >= 3, got ${count}`);
  if (count > MAX_TERRITORIES) {
    throw new Error(`territoryCount must be <= ${MAX_TERRITORIES}, got ${count}`);
  }

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const base = (seed + i * 7919) >>> 0;
    const territories = attempt({
      count,
      def,
      geoRng: makeRng(base),
      // A separate stream for the carve, so tuning the water does not shift
      // where the provinces themselves land.
      carveRng: makeRng((base ^ 0x9e3779b9) >>> 0),
      fraction: def.voidFraction * 0.7 ** i,
    });

    if (!territories) continue;
    if (playableCount(territories) < minPlayable) continue;

    return {
      id: def.id,
      name: def.name,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      // Covers `playable` too, so the client remounts when the carve changes.
      version: hashString(JSON.stringify(territories)),
      territories,
    };
  }

  throw new Error(
    `map generation failed after ${MAX_ATTEMPTS} attempts ` +
      `(preset=${def.id} count=${count} minPlayable=${minPlayable})`,
  );
}

/** Adjacency list in the shape the rules engine expects. */
export function adjacencyOf(map) {
  return map.territories.map((t) => t.neighbors);
}

export function isKnownMap(mapId) {
  return Object.prototype.hasOwnProperty.call(MAPS, mapId);
}

/**
 * The catalogue in the shape the client's map picker wants: the offered styles
 * only, in menu order, so the picker needs no ordering or filtering of its own.
 */
export function mapCatalogue() {
  return MAP_CHOICES.map((id) => {
    const { name, description, cells, voidFraction } = MAPS[id];
    return { id, name, description, cells, voidFraction };
  });
}
