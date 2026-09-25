// Which bot policy a seat plays, and where that choice comes from.
//
// A seat carries a version number and this is the only map from that number to
// an implementation, so adding a third policy is one entry here and one file
// beside the other two. Nothing else in the server asks a bot what it is except
// through `policyFor`.

import * as v1 from './bot-v1.js';
import * as v2 from './bot-v2.js';

/**
 * Every version "Add bot" can deal.
 *
 * Ordered, and the order is the menu: the draw is uniform over this array, so
 * listing a version twice is how it would be made more common.
 */
export const BOT_VERSIONS = [1, 2];

const POLICIES = new Map([
  [1, v1],
  [2, v2],
]);

/**
 * The policy for a version, defaulting to v1.
 *
 * The default is for seats that predate the version field — a room created
 * before this existed, or a bot built by hand in a test. Falling back to v1
 * rather than throwing keeps an unknown version a dull old bot instead of a
 * crashed server, and v1 is the safe direction: it is the policy that was
 * already playing every seat.
 */
export function policyFor(version) {
  return POLICIES.get(version) ?? v1;
}

/** The tag in a bot's name: `v2 3` is the third v2 bot at the table. */
export function versionTag(version) {
  return `v${version}`;
}
