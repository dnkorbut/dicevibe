// Map generation tests.
//
// The board is fabricated per game and then never changes, so a defect here is
// permanent for that match: land the players cannot all reach, a province with
// no neighbours, or an island of one produces a game that cannot be won. That is
// why these checks are exhaustive over player counts and presets rather than
// sampling a couple of shapes.
//
// Voids are ordinary Voronoi cells that nobody owns, so most of the geometric
// invariants still hold over the whole cell list — the board still tiles the
// rectangle exactly, ids are still dense. The game-level invariants are about
// the LAND, and those are asserted separately.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SIZE_ID, MAP_HEIGHT, MAP_SIZES, MAP_WIDTH } from '../shared/constants.js';
import {
  DEFAULT_MAP_ID,
  MAPS,
  MAP_CHOICES,
  adjacencyOf,
  defaultTerritoryCount,
  generateMap,
  isKnownMap,
  mapCatalogue,
  playableCount,
  playableIds,
  repairVoids,
} from '../server/map.js';

/* ── helpers ───────────────────────────────────────────────────────────────── */

const PRESET_IDS = Object.keys(MAPS);

/** The fewest territories a game needs, mirroring game.js's setup rule. */
const minTerritories = (players) => 3 * players;

/** A board from a preset at a fixed seed, so assertions are reproducible. */
const sampleMap = (preset, seed = 20260923) => generateMap({ preset, seed });

/** Reachability across the land only — voids are barriers, not gaps. */
function assertLandConnected(map, label) {
  const isLand = map.territories.map((t) => t.playable);
  const land = playableIds(map);
  assert.ok(land.length > 0, `${label}: the board has no land at all`);

  const seen = new Set([land[0]]);
  const stack = [land[0]];

  while (stack.length > 0) {
    const t = stack.pop();
    for (const nb of map.territories[t].neighbors) {
      if (isLand[nb] && !seen.has(nb)) {
        seen.add(nb);
        stack.push(nb);
      }
    }
  }

  assert.equal(
    seen.size,
    land.length,
    `${label}: land is split — reached ${seen.size} of ${land.length} territories`,
  );
}

/** Signed area of a ring, via the shoelace formula. */
function ringArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/**
 * Total length of the edges two territories genuinely share.
 *
 * This is what distinguishes real adjacency from a corner touch. The generator
 * deliberately builds adjacency from shared edges rather than
 * `delaunay.neighbors()`, because after clipping to the board rectangle that
 * triangle graph reports cells that merely meet at a point — and a player would
 * then be offered an attack across a corner, which does not read as a border.
 */
function sharedEdgeLength(a, b) {
  const edges = (points) => {
    const m = new Map();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      const key =
        p[0] < q[0] || (p[0] === q[0] && p[1] < q[1])
          ? `${p[0]},${p[1]}|${q[0]},${q[1]}`
          : `${q[0]},${q[1]}|${p[0]},${p[1]}`;
      m.set(key, Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return m;
  };

  const ea = edges(a.points);
  const eb = edges(b.points);
  let total = 0;
  for (const [key, len] of ea) {
    if (eb.has(key)) total += Math.min(len, eb.get(key));
  }
  return total;
}

/* ── shape and integrity ───────────────────────────────────────────────────── */

test('every territory is a real polygon inside the board', () => {
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);

    assert.equal(map.width, MAP_WIDTH);
    assert.equal(map.height, MAP_HEIGHT);
    assert.ok(map.territories.length >= 3);

    for (const t of map.territories) {
      assert.ok(Array.isArray(t.points), `${preset}: territory ${t.id} has no points`);
      assert.ok(t.points.length >= 3, `${preset}: territory ${t.id} has only ${t.points.length} vertices`);
      assert.ok(ringArea(t.points) > 0, `${preset}: territory ${t.id} has zero area`);

      for (const [x, y] of t.points) {
        assert.ok(
          Number.isFinite(x) && Number.isFinite(y),
          `${preset}: territory ${t.id} has a non-finite vertex`,
        );
        // Coordinates are clamped to the board rectangle during relaxation, so
        // nothing should escape it. A small tolerance covers the 1dp rounding.
        assert.ok(x >= -0.5 && x <= MAP_WIDTH + 0.5, `${preset}: territory ${t.id} x out of bounds: ${x}`);
        assert.ok(y >= -0.5 && y <= MAP_HEIGHT + 0.5, `${preset}: territory ${t.id} y out of bounds: ${y}`);
      }
    }
  }
});

test('territory ids are dense and in range', () => {
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    map.territories.forEach((t, i) => assert.equal(t.id, i, `${preset}: ids must match their index`));

    for (const t of map.territories) {
      for (const nb of t.neighbors) {
        assert.ok(
          Number.isInteger(nb) && nb >= 0 && nb < map.territories.length,
          `${preset}: bad neighbour id ${nb}`,
        );
        assert.notEqual(nb, t.id, `${preset}: territory ${t.id} lists itself as a neighbour`);
      }
    }
  }
});

test('every cell carries a boolean playable flag', () => {
  // The flag is what the whole water feature hangs off: `game.js` deals only
  // playable ids, the client draws no badge on the rest, and a missing flag
  // would read as falsy and silently drown the whole board.
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    for (const t of map.territories) {
      assert.equal(typeof t.playable, 'boolean', `${preset}: territory ${t.id} has playable=${t.playable}`);
    }
    assert.equal(playableCount(map.territories), playableIds(map).length);
  }
});

test('territories tile the board without gaps or overlap', () => {
  // Voronoi cells clipped to the rectangle are exactly a partition of it, so the
  // areas must sum to the board area. Voids are still cells — they are drawn,
  // they are just not land — so this holds for every preset and is what proves
  // the clipping is intact.
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    const total = map.territories.reduce((sum, t) => sum + ringArea(t.points), 0);
    const boardArea = MAP_WIDTH * MAP_HEIGHT;

    assert.ok(
      Math.abs(total - boardArea) / boardArea < 0.01,
      `${preset}: coverage ${(total / boardArea).toFixed(4)} of the board`,
    );
  }
});

test('land area matches the share of playable cells', () => {
  // A void is a normal-sized cell, so the fraction of the board that is land
  // should track the fraction of cells that are land. A big gap here would mean
  // the carve is picking cells by size rather than by position.
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    const boardArea = MAP_WIDTH * MAP_HEIGHT;
    const landArea = map.territories.reduce((sum, t) => sum + (t.playable ? ringArea(t.points) : 0), 0);
    const landShare = landArea / boardArea;
    const cellShare = playableCount(map.territories) / map.territories.length;

    assert.ok(
      Math.abs(landShare - cellShare) < 0.12,
      `${preset}: ${(landShare * 100).toFixed(1)}% of the area but ${(cellShare * 100).toFixed(1)}% of the cells`,
    );
  }
});

test('adjacency is symmetric, and only ever a genuine shared edge', () => {
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);

    for (const t of map.territories) {
      for (const nb of t.neighbors) {
        assert.ok(
          map.territories[nb].neighbors.includes(t.id),
          `${preset}: ${t.id} lists ${nb} but not the reverse`,
        );
      }
    }

    // Every reported neighbour must share a border of real length. If adjacency
    // ever regressed to `delaunay.neighbors()`, corner-touching pairs would show
    // up here with a shared length of zero.
    let pairsChecked = 0;
    for (const t of map.territories) {
      for (const nb of t.neighbors) {
        if (nb < t.id) continue;
        pairsChecked++;
        assert.ok(
          sharedEdgeLength(t, map.territories[nb]) > 0.001,
          `${preset}: ${t.id} and ${nb} are adjacent but share no edge`,
        );
      }
    }

    assert.ok(pairsChecked > 0, `${preset}: the board should have adjacent pairs`);
  }
});

test('no cell is isolated, and the land is one connected body', () => {
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);

    // Over EVERY cell: the tessellation itself has no holes.
    for (const t of map.territories) {
      assert.ok(t.neighbors.length >= 1, `${preset}: cell ${t.id} has no neighbours`);
    }

    // And over the land, which is the property the game actually needs: land
    // nobody can reach is a player who can never be eliminated.
    assertLandConnected(map, preset);
  }
});

test('every playable territory has somewhere to attack from', () => {
  // A playable cell with only water around it is unattackable in both
  // directions — the repair pass exists to make this impossible, and it is the
  // one invariant that, if it slipped, would produce an unwinnable game.
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    const isLand = map.territories.map((t) => t.playable);

    for (const t of map.territories) {
      if (!t.playable) continue;
      assert.ok(
        t.neighbors.some((nb) => isLand[nb]),
        `${preset}: territory ${t.id} is land with no land neighbour`,
      );
    }
  }
});

test('the board is not a set of slivers', () => {
  // Lloyd relaxation exists to even the cells out. Without it the jittered grid
  // produces needle-thin provinces that are unreadable and hard to click, so
  // assert the smallest cell is a sane fraction of the median.
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    const areas = map.territories.map((t) => ringArea(t.points)).sort((a, b) => a - b);
    const median = areas[Math.floor(areas.length / 2)];

    assert.ok(
      areas[0] / median > 0.4,
      `${preset}: smallest cell is ${(areas[0] / median).toFixed(2)}x the median — slivers`,
    );
  }
});

test('cell centres sit inside their own cell', () => {
  // The centre is what the client draws the dice badge on. If it ever landed
  // outside its own polygon the badge would float over a neighbouring
  // territory and the board would read completely wrong.
  const inside = (pt, points) => {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    return hit;
  };

  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    for (const t of map.territories) {
      assert.ok(
        inside([t.cx, t.cy], t.points),
        `${preset}: territory ${t.id} centre (${t.cx},${t.cy}) is outside it`,
      );
    }
  }
});

/* ── water ─────────────────────────────────────────────────────────────────── */

test('the carve hits its preset water fraction on every seed', () => {
  // Thresholding the noise by quantile is what makes this exact rather than
  // approximate: the water share is a promise the preset makes, and a board that
  // came out drier than asked would quietly stop being the style it advertises.
  //
  // Measured AFTER the repair pass, with a floor rather than an equality:
  // bridging un-drowns cells to join islands up, so the final figure can only
  // come out at or below the quota — never above it.
  for (const preset of PRESET_IDS) {
    const def = MAPS[preset];
    if (def.voidFraction === 0) continue;

    for (const seed of [1, 2, 777, 20260923, 424242]) {
      const map = sampleMap(preset, seed);
      const wet = 1 - playableCount(map.territories) / map.territories.length;

      assert.ok(
        wet <= def.voidFraction + 0.02,
        `${preset} seed=${seed}: ${(wet * 100).toFixed(1)}% water exceeds the ${def.voidFraction * 100}% quota`,
      );
      assert.ok(
        wet >= def.voidFraction * 0.5,
        `${preset} seed=${seed}: only ${(wet * 100).toFixed(1)}% water, expected near ${def.voidFraction * 100}%`,
      );
    }
  }
});

test('a preset with no water generates none', () => {
  const map = sampleMap('ridge');
  for (const t of map.territories) {
    assert.equal(t.playable, true, `ridge should have no voids, but ${t.id} is one`);
  }
});

test('playable counts land in the advertised range', () => {
  // The new presets exist to make games bigger than the original 30-cell board.
  // Ridge is the deliberate exception: it stays small as the tight, fast
  // baseline the rest of the suite is built on.
  for (const preset of PRESET_IDS) {
    if (preset === 'ridge') continue;
    for (const seed of [1, 2, 777]) {
      const land = playableCount(sampleMap(preset, seed).territories);
      assert.ok(land >= 45 && land <= 70, `${preset} seed=${seed}: ${land} land territories`);
    }
  }
});

/* ── sizes ─────────────────────────────────────────────────────────────────── */

test('every size generates a valid board for every style', () => {
  // Size is a second axis across the presets, so it multiplies the number of
  // boards a player can be handed. The dense end is the one that has never been
  // exercised: 150 cells in a canvas that has not grown means the jittered grid
  // is packed ~3.7x tighter than the original 40-cell board, and every geometric
  // invariant has to survive that.
  for (const preset of PRESET_IDS) {
    for (const size of MAP_SIZES) {
      const label = `${preset}/${size.id}`;

      for (const seed of [1, 2, 777, 20260923]) {
        const map = generateMap({ preset, size: size.id, seed, minPlayable: minTerritories(8) });
        assert.equal(map.territories.length, size.cells, `${label} seed=${seed}: wrong cell count`);

        assertLandConnected(map, label);

        for (const t of map.territories) {
          if (!t.playable) continue;
          assert.ok(
            t.neighbors.some((nb) => map.territories[nb].playable),
            `${label} seed=${seed}: territory ${t.id} is land with no land neighbour`,
          );
        }

        assert.ok(
          playableCount(map.territories) >= minTerritories(8),
          `${label} seed=${seed}: too little land for a full lobby`,
        );
      }
    }
  }
});

test('cells stay a sane size at every density', () => {
  // The same sliver check as the presets get, swept across sizes. Packing more
  // cells into a fixed canvas is exactly the change that could produce needles,
  // and at the dense end the smallest cell is the one that would become
  // unclickable first.
  for (const preset of PRESET_IDS) {
    for (const size of MAP_SIZES) {
      const map = generateMap({ preset, size: size.id, seed: 20260923 });
      const areas = map.territories.map((t) => ringArea(t.points)).sort((a, b) => a - b);
      const median = areas[Math.floor(areas.length / 2)];

      assert.ok(
        areas[0] / median > 0.4,
        `${preset}/${size.id}: smallest cell is ${(areas[0] / median).toFixed(2)}x the median — slivers`,
      );
    }
  }
});

test('a size beats the style default, and the env override beats both', () => {
  // Three levels of precedence, and the order matters: `DICEVIBE_TERRITORIES`
  // exists so the integration suite can pin every board to one count, and it has
  // to keep winning even when a host has explicitly picked a size.
  const env = process.env.DICEVIBE_TERRITORIES;
  delete process.env.DICEVIBE_TERRITORIES;

  try {
    assert.equal(defaultTerritoryCount('ridge'), 30, 'no size falls back to the style');
    assert.equal(defaultTerritoryCount('frontier'), 80, 'unchanged for a big style');
    assert.equal(defaultTerritoryCount('ridge', 'huge'), 150, 'a size overrides the style');
    assert.equal(defaultTerritoryCount('frontier', 'small'), 40, 'and can shrink it too');
    assert.equal(defaultTerritoryCount('ridge', 'nonsense'), 30, 'an unknown size is ignored, not fatal');

    process.env.DICEVIBE_TERRITORIES = '6';
    assert.equal(defaultTerritoryCount('ridge', 'huge'), 6, 'the env override outranks a chosen size');
    assert.equal(defaultTerritoryCount('frontier'), 6, 'and the style');
  } finally {
    if (env === undefined) delete process.env.DICEVIBE_TERRITORIES;
    else process.env.DICEVIBE_TERRITORIES = env;
  }

  // And a generated board honours it end to end.
  assert.equal(generateMap({ preset: 'frontier', size: 'huge', seed: 1 }).territories.length, 150);
});

/* ── repair ────────────────────────────────────────────────────────────────── */

test('repairVoids joins islands it can bridge and drowns the ones it cannot', () => {
  // At the shipped presets this pass fires on roughly one board in forty, which
  // is exactly the kind of rarely-taken branch that rots unnoticed. Driving it
  // directly is the only way to know it still works.
  const show = (v) => [...v].join('');

  // Two cells of land, two cells of deep water, two more of land. Nothing
  // single-celled spans the channel, so the smaller body is drowned.
  {
    const v = Uint8Array.from([0, 0, 1, 1, 0, 0]);
    repairVoids(v, [[1], [0, 2], [1, 3], [2, 4], [3, 5], [4]]);
    assert.equal(show(v), '001111', 'a two-cell channel cannot be bridged');
  }

  // The same shape with a ONE-cell channel: the island is joined up instead.
  {
    const v = Uint8Array.from([0, 0, 1, 0]);
    repairVoids(v, [[1], [0, 2], [1, 3], [2]]);
    assert.equal(show(v), '0000', 'a one-cell gap should be bridged, not drowned');
  }

  // A lone cell of land with no land neighbour anywhere is drowned rather than
  // kept as an unattackable province.
  {
    const v = Uint8Array.from([1, 0, 1, 1, 1]);
    repairVoids(v, [[1], [0, 2], [1, 3], [2, 4], [3]]);
    assert.equal(show(v), '11111', 'an island of one must go');
  }

  // A completely flooded board keeps nothing, which then fails the caller's
  // land check and forces a retry with less water.
  {
    const v = Uint8Array.from([1, 1]);
    repairVoids(v, [[1], [0]]);
    assert.equal(show(v), '11');
  }

  // Three bodies, one bridgeable gap: the two that join up beat the one that
  // does not.
  {
    const v = Uint8Array.from([0, 0, 1, 0, 0, 0, 0]);
    repairVoids(v, [[1], [0, 2], [1, 3], [2, 4], [3], [6], [5]]);
    assert.equal(show(v), '0000011', 'the bridged body wins');
  }
});

test('repairVoids leaves an already-valid board untouched', () => {
  const chain = [[1], [0, 2], [1, 3], [2, 4], [3]];
  const ring = [[1, 4], [0, 2], [1, 3], [2, 4], [3, 0]];

  {
    const v = Uint8Array.from([0, 0, 0]);
    repairVoids(v, [[1], [0, 2], [1]]);
    assert.equal([...v].join(''), '000', 'a board with no water must not be disturbed');
  }

  {
    // Water at the edge of the chain: the remaining land is a connected path,
    // so there is nothing to bridge and nobody to drown.
    const v = Uint8Array.from([1, 0, 0, 0, 0]);
    repairVoids(v, chain);
    assert.equal([...v].join(''), '10000', 'coastal water must survive');
  }

  {
    // An inland lake on a ring. Land wraps all the way around it, so it strands
    // nobody — and it is exactly the shape the smoothing pass is meant to be
    // able to produce, so repair must not undo it.
    const v = Uint8Array.from([1, 0, 0, 0, 0]);
    repairVoids(v, ring);
    assert.equal([...v].join(''), '10000', 'a lake that strands nothing must survive');
  }

  {
    // And the case that looks like the two above but is not: three land cells
    // each sealed off by water. Every one of them has zero land neighbours, so
    // every one is drowned — this is the fixpoint doing its job, not a bug.
    const v = Uint8Array.from([0, 1, 0, 1, 0]);
    repairVoids(v, [[1, 3], [0, 2], [1, 3], [2, 4], [3]]);
    assert.equal([...v].join(''), '00000', 'land with no land neighbour must go');
  }
});

/* ── generation across the full player range ───────────────────────────────── */

test('generates a valid board for every supported player count', () => {
  // 2..8 players is the lobby's range, and each needs at least 3 territories
  // per player at setup or somebody would be dealt no land. Sweep the whole
  // range across several seeds — this is the check that would catch a
  // generation failure that only shows up at an awkward territory count.
  const counts = new Set();
  for (let players = 2; players <= 8; players++) {
    // The exact minimum is the case that matters most: it is the tightest
    // board a full lobby can be dealt.
    counts.add(minTerritories(players));
    counts.add(minTerritories(players) + 1);
    counts.add(minTerritories(players) + 7);
  }

  const built = [];
  for (const count of [...counts].sort((a, b) => a - b)) {
    for (const seed of [11, 20260923]) {
      const map = generateMap({ territoryCount: count, seed });

      assert.equal(map.territories.length, count, `asked for ${count}, got ${map.territories.length}`);

      for (const t of map.territories) {
        assert.ok(t.neighbors.length >= 1, `count=${count} seed=${seed}: territory ${t.id} is isolated`);
        assert.ok(t.points.length >= 3, `count=${count} seed=${seed}: territory ${t.id} is degenerate`);
      }

      assertLandConnected(map, `count=${count} seed=${seed}`);
      built.push(count);
    }
  }

  // Every supported player count must have had its tightest legal board built,
  // so no lobby size is left untested.
  for (let players = 2; players <= 8; players++) {
    assert.ok(
      built.includes(minTerritories(players)),
      `no board was generated at the minimum territory count for ${players} players`,
    );
  }

  // Every requested (count, seed) pair was built, so nothing was silently
  // skipped — a magic board-count threshold here would just be noise.
  assert.equal(built.length, counts.size * 2, 'every territory count should be built under both seeds');
});

test('every preset seats a full lobby, retrying until it has the land', () => {
  // This is the check that makes random carving safe to ship: whatever the
  // water does, `generateMap` must be able to hand `startGame` enough land for
  // the players it has, or it must throw rather than return a board that would
  // deal somebody nothing.
  for (const preset of PRESET_IDS) {
    for (let players = 2; players <= 8; players++) {
      for (const seed of [5, 9182]) {
        const map = generateMap({ preset, seed, minPlayable: minTerritories(players) });
        const land = playableCount(map.territories);

        assert.ok(
          land >= minTerritories(players),
          `${preset} seed=${seed} players=${players}: only ${land} land territories`,
        );
        assertLandConnected(map, `${preset}/${players}/${seed}`);
      }
    }
  }
});

test('adjacencyOf matches the territories it came from', () => {
  for (const preset of PRESET_IDS) {
    const map = sampleMap(preset);
    const adj = adjacencyOf(map);

    assert.equal(adj.length, map.territories.length);
    adj.forEach((nbs, i) => assert.deepEqual(nbs, map.territories[i].neighbors));
  }
});

/* ── determinism ───────────────────────────────────────────────────────────── */

test('the same preset and seed always produce the identical board', () => {
  // Replayability depends on this: a bug report quoting a seed is worthless if
  // generation is not reproducible. It is doubly true now that the layout is
  // random per game — the seed is the ONLY handle on which board a player saw.
  for (const preset of PRESET_IDS) {
    const a = sampleMap(preset, 1234);
    const b = sampleMap(preset, 1234);

    assert.equal(a.version, b.version);
    assert.deepEqual(a.territories, b.territories);
  }
});

test('different seeds produce different boards', () => {
  for (const preset of PRESET_IDS) {
    const a = sampleMap(preset, 1);
    const b = sampleMap(preset, 2);

    assert.notEqual(a.version, b.version, `${preset}: two seeds produced the same board hash`);
    // The hash covers `playable` as well as the geometry, so this also proves
    // the carve moved — not just the provinces.
    assert.notDeepEqual(a.territories, b.territories);
  }
});

/* ── catalogue ─────────────────────────────────────────────────────────────── */

test('the preset catalogue is internally consistent', () => {
  const seen = new Set();

  for (const [key, def] of Object.entries(MAPS)) {
    assert.equal(def.id, key, 'the map key and its id must agree');
    assert.ok(!seen.has(def.id), `duplicate preset id ${def.id}`);
    seen.add(def.id);

    assert.ok(def.name.length > 0, `${key} has no name`);
    assert.ok(def.description.length > 0, `${key} has no description`);
    assert.ok(def.cells >= 3, `${key} asks for ${def.cells} cells`);
    assert.ok(
      def.voidFraction >= 0 && def.voidFraction < 0.6,
      `${key} wants ${def.voidFraction} water`,
    );
    assert.ok(def.smoothPasses >= 0, `${key} has a negative smooth pass count`);

    if (def.voidFraction > 0) {
      assert.ok(def.noise.octaves >= 1, `${key} carves water with no noise`);
      assert.ok(def.noise.gw >= 1 && def.noise.gh >= 1, `${key} has a degenerate noise lattice`);
    }
  }

  assert.ok(seen.size >= 4, 'the point of this feature is more than a couple of maps');
});

test('the map menu offers continent and ridge, on continent', () => {
  // The requirement, stated directly: two styles on the menu, in this order.
  assert.deepEqual(MAP_CHOICES, ['continent', 'ridge']);
  assert.equal(DEFAULT_MAP_ID, 'continent');

  const list = mapCatalogue();
  assert.deepEqual(
    list.map((m) => m.id),
    MAP_CHOICES,
    'the catalogue is the menu, in menu order',
  );

  // The order is load-bearing, not cosmetic: the picker is a plain <select> and
  // shows its first option, so index 0 is what a host is dealt unless they
  // choose. Defining DEFAULT_MAP_ID separately is what lets it be named in
  // prose, and this is the assertion that keeps the naming honest.
  assert.equal(MAP_CHOICES[0], DEFAULT_MAP_ID, 'the picker opens on the default style');

  // ...and the default has to be a style that exists, or `/dev/map` and a room
  // with no id would both fall through to the fallback in generateMap instead.
  assert.equal(isKnownMap(DEFAULT_MAP_ID), true);
  assert.ok(MAPS[DEFAULT_MAP_ID], 'the default names a real preset');
});

test('every offered style is a real preset, and the unoffered ones still generate', () => {
  // The menu is a curation, not the whole of MAPS: the styles left off it stay
  // generatable and stay reachable by id, so this is not "these are the only
  // maps" — it is "these are the only ones on the menu".
  for (const id of MAP_CHOICES) assert.equal(isKnownMap(id), true, `${id} is on the menu but unknown`);

  const offMenu = Object.keys(MAPS).filter((id) => !MAP_CHOICES.includes(id));
  for (const id of offMenu) {
    assert.equal(isKnownMap(id), true, `${id} is off the menu but must still be creatable`);
    assert.ok(sampleMap(id).territories.length > 0, `${id} no longer generates`);
  }
  assert.ok(offMenu.length > 0, 'this test is pointless if nothing is off the menu');
});

test('the default size is a real size', () => {
  // The client selects the option by value. A constant naming an id that is not
  // in MAP_SIZES would match no <option> and leave the picker on "Style default"
  // — the default quietly not applying, which no other test would catch.
  assert.ok(
    MAP_SIZES.some((s) => s.id === DEFAULT_SIZE_ID),
    `DEFAULT_SIZE_ID ${DEFAULT_SIZE_ID} is not one of ${MAP_SIZES.map((s) => s.id).join(', ')}`,
  );
});

test('mapCatalogue is safe to hand to the client', () => {
  for (const entry of mapCatalogue()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['cells', 'description', 'id', 'name', 'voidFraction'],
      'the client sees only what it needs',
    );
    assert.equal(isKnownMap(entry.id), true);
  }
});

/* ── guards ────────────────────────────────────────────────────────────────── */

test('generateMap rejects a board too small to divide', () => {
  assert.throws(() => generateMap({ territoryCount: 2 }), /territoryCount must be >= 3/);
  assert.throws(() => generateMap({ territoryCount: 0 }), /territoryCount must be >= 3/);
});

test('generateMap rejects a board too large to be asked for', () => {
  // The upper bound is a security bound, not a gameplay one. `/dev/map` takes
  // its cell count straight off the query string and generation is quadratic in
  // it, so an unbounded count is an unauthenticated way to block the event loop
  // for every socket in the process. This asserts the refusal, and that it
  // costs nothing: a bound checked after the expensive work would still be a
  // denial of service, only a politer one.
  //
  // The time assertion is a couple of orders of magnitude of headroom on a
  // check that is two comparisons, so it cannot flake on a loaded machine — it
  // fails only if the bound stops being checked before the work.
  //
  // The route is also rate-limited (see test/ratelimit.test.js), and the two
  // halves answer different questions: this bounds what one request costs, that
  // bounds how often one can be made. Neither is sufficient alone.
  const started = process.hrtime.bigint();
  assert.throws(() => generateMap({ territoryCount: 401 }), /territoryCount must be <= 400/);
  assert.throws(() => generateMap({ territoryCount: 300000 }), /territoryCount must be <= 400/);
  assert.throws(() => generateMap({ territoryCount: Number.MAX_SAFE_INTEGER }), /must be <= 400/);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `the bound must be checked before any work, took ${ms.toFixed(0)}ms`);

  // And the bound sits above every board the game itself can ask for, so it is
  // invisible in play: 150 is `huge`, the largest size on the menu.
  assert.doesNotThrow(() => generateMap({ preset: 'ridge', territoryCount: 400, seed: 1 }));
});

test('generateMap refuses to hand back a board with too little land', () => {
  // 3 cells can never supply 3 territories per player for 8 players. The call
  // must fail loudly rather than return a board that would deal somebody no
  // land — `startGame` turns the throw into MAP_TOO_SMALL.
  assert.throws(
    () => generateMap({ preset: 'ridge', territoryCount: 6, seed: 3, minPlayable: 24 }),
    /map generation failed/,
  );
});

test('isKnownMap accepts every shipped preset and rejects anything else', () => {
  for (const preset of PRESET_IDS) assert.equal(isKnownMap(preset), true, `${preset} must be known`);

  assert.equal(isKnownMap('nope'), false);
  // Must not be fooled by inherited Object properties.
  assert.equal(isKnownMap('toString'), false);
  assert.equal(isKnownMap('constructor'), false);
});
