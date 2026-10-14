import { describe, expect, it } from 'vitest';

import { distance, midpoint, pinchFactor } from './zoom-math';

describe('pinch helpers', () => {
  it('measures span and midpoint', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 10 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 15 });
  });

  it('zooms in when the fingers spread and out when they pinch', () => {
    expect(pinchFactor(100, 200)).toBe(2);
    expect(pinchFactor(200, 100)).toBe(0.5);
  });

  it('ignores an unusable start span', () => {
    expect(pinchFactor(0, 50)).toBe(1);
    expect(pinchFactor(Number.NaN, 50)).toBe(1);
  });
});
