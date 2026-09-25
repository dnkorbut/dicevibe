// The token bucket behind the map preview route.
//
// A bucket is small enough to test exhaustively and easy enough to get subtly
// wrong — the arithmetic that refills and the arithmetic that spends have to
// agree about what "now" is, and an off-by-one there is invisible until
// production traffic finds it — so every case here is written against an
// explicit clock rather than a real one.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBucket } from '../server/ratelimit.js';

/** The route's own settings: ten in a burst, two a second back. */
const makeBucket = () => createBucket({ capacity: 10, refillPerMs: 1 / 500 });

test('a fresh bucket hands out its whole capacity, then refuses', () => {
  const take = makeBucket();
  for (let i = 0; i < 10; i++) assert.equal(take(0), true, `token ${i + 1} of the burst`);
  assert.equal(take(0), false, 'the eleventh with no time passing must be refused');
  assert.equal(take(0), false, 'and so must every one after it');
});

test('a bucket refills at the stated rate and not faster', () => {
  const take = createBucket({ capacity: 4, refillPerMs: 1 / 1000 }); // one a second
  for (let i = 0; i < 4; i++) assert.equal(take(0), true, 'drain the burst');
  assert.equal(take(0), false);

  // 999ms is not quite a token — the off-by-one that a coarser test misses.
  assert.equal(take(999), false, 'a millisecond short of a token is still short');
  assert.equal(take(1000), true, 'exactly one token later, one is available');
  assert.equal(take(1000), false, 'and only one');
});

test('a bucket does not accumulate past its capacity however long it idles', () => {
  // The failure this guards is a bucket that banks a day of idling and then
  // releases it all at once, which is a burst limit that does not limit bursts.
  const take = createBucket({ capacity: 3, refillPerMs: 1 / 100 });
  for (let i = 0; i < 3; i++) assert.equal(take(0), true);

  const dayLater = 24 * 60 * 60 * 1000;
  for (let i = 0; i < 3; i++) assert.equal(take(dayLater), true, 'the burst is restored, in full');
  assert.equal(take(dayLater), false, 'and no more than the burst is');
});

test('a bucket refills against the last call, not the first', () => {
  // Two spends 500ms apart at 1/500ms must net to nothing, not to one token per
  // spend measured from the start — the bug where a long-lived bucket silently
  // refills faster the busier it gets.
  const take = createBucket({ capacity: 2, refillPerMs: 1 / 500 });
  assert.equal(take(0), true);
  assert.equal(take(0), true);
  assert.equal(take(0), false);

  assert.equal(take(500), true, 'one token after 500ms');
  assert.equal(take(500), false, 'and none of the 500ms is banked twice');
  assert.equal(take(1000), true, 'a token after another 500ms');
});

test('the route settings bound a sustained flood to a fraction of a core', () => {
  // The claim the numbers in server/index.js make, checked as arithmetic rather
  // than taken on trust: the bucket is only worth having if its steady state is
  // small next to the work one board costs.
  const take = makeBucket();

  let granted = 0;
  for (let ms = 0; ms < 10_000; ms += 1) {
    if (take(ms)) granted++;
  }

  // Ten in the burst, then 2/s for the rest of the ten seconds.
  assert.ok(granted <= 30, `expected at most 30 grants in 10s, got ${granted}`);
  assert.ok(granted >= 20, `expected the route to stay usable, got ${granted}`);
});
