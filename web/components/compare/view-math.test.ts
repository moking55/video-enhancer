import { describe, expect, it } from 'vitest';

import {
  CENTER,
  IDENTITY_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  clampScale,
  clampView,
  dragDelta,
  panBy,
  pointerToViewport,
  wheelZoomFactor,
  zoomAt,
  type Point,
  type ZoomView,
} from './zoom-math';
import {
  clampWipe,
  formatTime,
  nudgeWipe,
  totalFrames,
  wipeClipPath,
  wipeFromPointer,
} from './wipe-math';

/** Where content point p ends up in the viewport. */
const screenOf = (v: ZoomView, p: Point): Point => ({
  x: p.x * v.scale + v.x,
  y: p.y * v.scale + v.y,
});
/** Content point displayed under viewport coordinate c. */
const contentAt = (v: ZoomView, c: Point): Point => ({
  x: (c.x - v.x) / v.scale,
  y: (c.y - v.y) / v.scale,
});

describe('zoom clamping', () => {
  it('clamps scale to 1..8 and tolerates NaN', () => {
    expect(clampScale(0.2)).toBe(MIN_ZOOM);
    expect(clampScale(99)).toBe(MAX_ZOOM);
    expect(clampScale(3)).toBe(3);
    expect(clampScale(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('keeps content covering the viewport', () => {
    expect(clampView({ scale: 2, x: 0.5, y: 0.3 })).toEqual({ scale: 2, x: 0, y: 0 });
    expect(clampView({ scale: 2, x: -5, y: -5 })).toEqual({ scale: 2, x: -1, y: -1 });
    expect(clampView({ scale: 1, x: -0.4, y: 0.4 })).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const anchor = { x: 0.3, y: 0.6 };
    const before = contentAt(IDENTITY_VIEW, anchor);
    const next = zoomAt(IDENTITY_VIEW, 4, anchor);
    expect(next.scale).toBe(4);
    const after = contentAt(next, anchor);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(screenOf(next, before).x).toBeCloseTo(anchor.x, 10);
  });

  it('keeps it fixed across successive zooms', () => {
    const anchor = { x: 0.55, y: 0.45 };
    let v = zoomAt(IDENTITY_VIEW, 2, anchor);
    v = zoomAt(v, 5, anchor);
    const p = contentAt(v, anchor);
    v = zoomAt(v, 3, anchor);
    expect(contentAt(v, anchor).x).toBeCloseTo(p.x, 10);
    expect(contentAt(v, anchor).y).toBeCloseTo(p.y, 10);
  });

  it('zooming at a corner stays pinned to that corner', () => {
    expect(zoomAt(IDENTITY_VIEW, 4, { x: 0, y: 0 })).toEqual({ scale: 4, x: 0, y: 0 });
    const br = zoomAt(IDENTITY_VIEW, 4, { x: 1, y: 1 });
    expect(br.x).toBeCloseTo(-3, 10);
    expect(br.y).toBeCloseTo(-3, 10);
  });

  it('zooming out to 1 resets translation; scale is clamped to the range', () => {
    const zoomed = zoomAt(IDENTITY_VIEW, 4, { x: 0.8, y: 0.2 });
    expect(zoomAt(zoomed, 1, { x: 0.8, y: 0.2 })).toEqual(IDENTITY_VIEW);
    expect(zoomAt(IDENTITY_VIEW, 100, CENTER).scale).toBe(MAX_ZOOM);
    expect(zoomAt(zoomed, 0.01, CENTER).scale).toBe(MIN_ZOOM);
  });

  it('near an edge the clamp wins instead of exposing empty space', () => {
    const v = zoomAt({ scale: 2, x: -1, y: -1 }, 2.5, { x: 1, y: 1 });
    expect(v.x).toBeGreaterThanOrEqual(1 - v.scale);
    expect(v.x).toBeLessThanOrEqual(0);
  });
});

describe('panBy', () => {
  it('pans and clamps at the edges', () => {
    const z: ZoomView = { scale: 2, x: -0.5, y: -0.5 };
    const moved = panBy(z, 0.2, -0.1);
    expect(moved.x).toBeCloseTo(-0.3, 10);
    expect(moved.y).toBeCloseTo(-0.6, 10);
    expect(panBy(z, 5, 5)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panBy(z, -5, -5)).toEqual({ scale: 2, x: -1, y: -1 });
  });

  it('cannot pan at 1x', () => {
    expect(panBy(IDENTITY_VIEW, 0.3, 0.3)).toEqual(IDENTITY_VIEW);
  });
});

describe('pointer mapping', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };

  it('single pane: relative position, clamped', () => {
    expect(pointerToViewport(300, 150, rect, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToViewport(0, 0, rect, 1)).toEqual({ x: 0, y: 0 });
    expect(pointerToViewport(999, 999, rect, 1)).toEqual({ x: 1, y: 1 });
  });

  it('two panes: position inside whichever pane the pointer is over', () => {
    // left pane covers 100..300, right pane 300..500
    expect(pointerToViewport(200, 150, rect, 2).x).toBeCloseTo(0.5, 10);
    expect(pointerToViewport(400, 150, rect, 2).x).toBeCloseTo(0.5, 10);
    expect(pointerToViewport(500, 150, rect, 2).x).toBe(1);
  });

  it('degenerate rect falls back to center', () => {
    expect(pointerToViewport(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 1)).toEqual(CENTER);
  });

  it('dragDelta normalizes by pane size', () => {
    expect(dragDelta(50, -20, 500, 200)).toEqual({ dx: 0.1, dy: -0.1 });
    expect(dragDelta(5, 5, 0, 0)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in on negative deltaY and out on positive, symmetrically', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 0) * wheelZoomFactor(100, 0)).toBeCloseTo(1, 10);
    expect(wheelZoomFactor(-3, 1)).toBeGreaterThan(1);
  });

  it('caps huge deltas', () => {
    expect(wheelZoomFactor(-1e6, 0)).toBe(wheelZoomFactor(-240, 0));
  });
});

describe('wipe math', () => {
  it('clamps and maps pointer positions', () => {
    expect(clampWipe(-1)).toBe(0);
    expect(clampWipe(2)).toBe(1);
    expect(clampWipe(Number.NaN)).toBe(0.5);
    expect(wipeFromPointer(250, 100, 300)).toBe(0.5);
    expect(wipeFromPointer(0, 100, 300)).toBe(0);
    expect(wipeFromPointer(900, 100, 300)).toBe(1);
    expect(wipeFromPointer(5, 0, 0)).toBe(0.5);
  });

  it('nudges by 2% (10% large) without float noise and stays in range', () => {
    expect(nudgeWipe(0.5, 1)).toBe(0.52);
    expect(nudgeWipe(0.5, -1, true)).toBe(0.4);
    expect(nudgeWipe(0.99, 1)).toBe(1);
    expect(nudgeWipe(0.01, -1)).toBe(0);
  });

  it('clip-path keeps the part left of the divider', () => {
    expect(wipeClipPath(0.25)).toBe('inset(0 75.000% 0 0)');
    expect(wipeClipPath(1)).toBe('inset(0 0.000% 0 0)');
    expect(wipeClipPath(0)).toBe('inset(0 100.000% 0 0)');
  });
});

describe('time display', () => {
  it('formats m:ss.cc', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(3.014)).toBe('0:03.01');
    expect(formatTime(125.5)).toBe('2:05.50');
    expect(formatTime(Number.NaN)).toBe('0:00.00');
    expect(formatTime(-4)).toBe('0:00.00');
  });

  it('counts frames', () => {
    expect(totalFrames(3, 30)).toBe(90);
    expect(totalFrames(3.003, 29.97)).toBe(90);
    expect(totalFrames(0, 30)).toBe(0);
    expect(totalFrames(3, 0)).toBe(0);
  });
});
