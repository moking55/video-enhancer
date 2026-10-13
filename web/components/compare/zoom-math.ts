/**
 * Pure zoom/pan math for the compare viewer. No DOM access (unit-testable).
 *
 * The view is expressed in *normalized viewport units* so it does not depend on
 * pixel sizes and stays valid when the layout switches between one full-width
 * pane (wipe) and two half-width panes (side by side):
 *   - `scale` in [MIN_ZOOM, MAX_ZOOM]
 *   - `x`, `y` = translation as a fraction of the viewport size
 * A content point p (0..1 across the content) is displayed at `p * scale + x`.
 * The content always covers the viewport, so x, y are in [1 - scale, 0].
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Multiplier for the +/- buttons and keys. */
export const ZOOM_STEP = 1.25;

export type ZoomView = { scale: number; x: number; y: number };
export type Point = { x: number; y: number };

export const IDENTITY_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the zoomed content covering the viewport (no empty borders). */
export function clampView(view: ZoomView): ZoomView {
  const scale = clampScale(view.scale);
  const min = 1 - scale;
  return {
    scale,
    x: clamp(Number.isFinite(view.x) ? view.x : 0, min, 0),
    y: clamp(Number.isFinite(view.y) ? view.y : 0, min, 0),
  };
}

/**
 * Change the scale while keeping the content point under `anchor`
 * (normalized 0..1 viewport coordinates) where it is. The point only moves
 * when clamping at the content edge makes that unavoidable.
 */
export function zoomAt(view: ZoomView, nextScale: number, anchor: Point): ZoomView {
  const scale = clampScale(nextScale);
  const px = (anchor.x - view.x) / view.scale;
  const py = (anchor.y - view.y) / view.scale;
  return clampView({ scale, x: anchor.x - px * scale, y: anchor.y - py * scale });
}

/** Pan by a delta expressed in normalized viewport units. */
export function panBy(view: ZoomView, dx: number, dy: number): ZoomView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy });
}

/** Scale multiplier for a wheel event (negative deltaY zooms in). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  // deltaMode 1 = lines, 2 = pages; normalize roughly to pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = clamp(px, -240, 240); // tame high-resolution trackpads / mice
  return Math.exp(-clamped * 0.0015);
}

export const CENTER: Point = { x: 0.5, y: 0.5 };

/**
 * Pointer position -> normalized coordinates inside one viewport pane.
 * With 2 panes (side by side) both panes share the same view, so the position
 * is taken relative to whichever pane the pointer is over.
 */
export function pointerToViewport(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  panes: 1 | 2,
): Point {
  if (rect.width <= 0 || rect.height <= 0) return CENTER;
  const paneWidth = rect.width / panes;
  let localX = clientX - rect.left;
  if (panes === 2) {
    localX = localX >= rect.width ? paneWidth : ((localX % paneWidth) + paneWidth) % paneWidth;
  }
  return {
    x: clamp(localX / paneWidth, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}

/** Pointer movement in px -> normalized pan delta for a pane of the given size. */
export function dragDelta(
  dxPx: number,
  dyPx: number,
  paneWidth: number,
  paneHeight: number,
): { dx: number; dy: number } {
  if (paneWidth <= 0 || paneHeight <= 0) return { dx: 0, dy: 0 };
  return { dx: dxPx / paneWidth, dy: dyPx / paneHeight };
}
