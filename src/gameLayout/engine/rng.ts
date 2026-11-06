/** Small seeded PRNG (mulberry32) so layouts are reproducible for a given seed. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed | 0) ^ 0x9e3779b9;
  }

  random(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.random() * n);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Two distinct indices in [0, n). */
  pair(n: number): [number, number] {
    const i = this.int(n);
    let j = this.int(n - 1);
    if (j >= i) j++;
    return [i, j];
  }
}
