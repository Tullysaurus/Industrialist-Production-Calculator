/** Milliseconds from a monotonic clock (works in the browser, workers and Node). */
export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
