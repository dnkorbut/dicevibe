/**
 * A token bucket, for the one route that does real work for a caller who has
 * not identified themselves.
 *
 * It exists because a bound on how *big* a board can be is not a bound on how
 * *many* can be asked for. Map generation is CPU-bound and synchronous, so
 * every request it lets through blocks the event loop — and with it every
 * socket in every game — for as long as that request takes. Capping the size
 * took the cost of one request from about a minute to tens of milliseconds,
 * which is the difference between a lock-out and a stutter; but tens of
 * milliseconds spent a hundred times a second is the lock-out back again, and
 * that is the half this bounds.
 *
 * The bucket is a bucket rather than a fixed window because a burst is the
 * case that matters: ten requests arriving together are exactly what a slide
 * of the scroll wheel on a preview page looks like, and also exactly what an
 * attacker sends.
 *
 * `now` is a parameter rather than a call to `Date.now()` so a test can spend a
 * bucket and watch it refill without waiting out a real window.
 */
export function createBucket({ capacity, refillPerMs }) {
  let tokens = capacity;
  let last = null;

  /**
   * Takes one token if there is one. `true` means the caller may proceed;
   * `false` means it should be refused outright — refused, never queued,
   * because a queue holding expensive synchronous work would only move the
   * stall from the caller who asked to everyone waiting behind them.
   */
  return function take(now = Date.now()) {
    // First call has nothing to refill against, so it starts from full — which
    // is what "capacity" means and keeps the arithmetic below honest.
    if (last === null) last = now;

    tokens = Math.min(capacity, tokens + (now - last) * refillPerMs);
    last = now;

    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
