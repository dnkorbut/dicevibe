import { randomInt } from 'node:crypto';

/**
 * mulberry32 — a small, fast, seedable 32-bit PRNG.
 *
 * The whole point of this file is that `Math.random()` is not seedable. Map
 * geometry, dice rolls and reinforcement placement all have to be reproducible
 * from a seed, or a bug report ("the game froze after the 4th attack") is not
 * replayable and the Monte Carlo rule test cannot be deterministic.
 *
 * All randomness in the server goes through one of these. Never call
 * Math.random() in game logic.
 */
export function makeRng(seed) {
  let a = seed >>> 0;

  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
    /** Uniform choice from a non-empty array. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Fisher-Yates, in place. Returns the same array for convenience. */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    /** A fair six-sided die: 1..6. */
    d6: () => 1 + Math.floor(next() * 6),
  };
}

/** A fresh unpredictable seed, for gameplay randomness (not map geometry). */
export function randomSeed() {
  return randomInt(0, 2 ** 32);
}
