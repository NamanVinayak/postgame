import { describe, expect, it } from 'vitest';
import { MIN_FREE_MEMORY_PCT, memoryGuarded } from './memoryPressure';

describe('memoryGuarded', () => {
  it('checks memory on every start and only builds the engine when enough is free', () => {
    let free: number | null = 50;
    let checks = 0;
    let built = 0;
    const factory = memoryGuarded(
      () => ++built,
      () => (checks++, free),
    );
    expect(factory()).toBe(1);
    free = MIN_FREE_MEMORY_PCT - 1;
    expect(() => factory()).toThrow(`only ${MIN_FREE_MEMORY_PCT - 1}% of memory is free`);
    free = null;
    expect(() => factory()).toThrow(/could not read free memory/);
    free = MIN_FREE_MEMORY_PCT;
    expect(factory()).toBe(2);
    expect(checks).toBe(4);
    expect(built).toBe(2);
  });
});
