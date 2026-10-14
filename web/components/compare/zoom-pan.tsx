"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import {
  CENTER,
  IDENTITY_VIEW,
  ZOOM_STEP,
  distance,
  dragDelta,
  midpoint,
  panBy,
  pinchFactor,
  pointerToViewport,
  wheelZoomFactor,
  zoomAt,
  type Point,
  type ZoomView,
} from "./zoom-math";

export type ZoomPanApi = {
  view: ZoomView;
  dragging: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  /** Pan by a fraction of the viewport (used by keyboard panning). */
  pan: (dx: number, dy: number) => void;
  /** Pointer handlers for the element that receives drag-to-pan. */
  pointerHandlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
};

/**
 * Zoom/pan state shared by every pane. `containerRef` is the element that
 * contains all panes; with `panes = 2` it is split into two equal halves that
 * show the same view. Wheel zoom is attached natively (non-passive) so the page
 * does not scroll while zooming. One pointer drags (pans); two pointers pinch
 * (zoom around their midpoint while following it, so touch pan + pinch work).
 */
export function useZoomPan(
  containerRef: RefObject<HTMLElement | null>,
  panes: 1 | 2,
): ZoomPanApi {
  const [view, setView] = useState<ZoomView>(IDENTITY_VIEW);
  const [dragging, setDragging] = useState(false);
  const panesRef = useRef(panes);
  /** Active pointers (mouse, touch, pen) by id, in client px. */
  const pointers = useRef(new Map<number, Point>());
  /** Last two-pointer span and midpoint while pinching. */
  const pinch = useRef<{ span: number; mid: Point } | null>(null);

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  const zoomTo = useCallback((factor: number, anchor: Point) => {
    setView((v) => zoomAt(v, v.scale * factor, anchor));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const anchor = pointerToViewport(
        e.clientX,
        e.clientY,
        el.getBoundingClientRect(),
        panesRef.current,
      );
      zoomTo(wheelZoomFactor(e.deltaY, e.deltaMode), anchor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomTo]);

  const zoomIn = useCallback(() => zoomTo(ZOOM_STEP, CENTER), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(1 / ZOOM_STEP, CENTER), [zoomTo]);
  const reset = useCallback(() => setView(IDENTITY_VIEW), []);
  const pan = useCallback(
    (dx: number, dy: number) => setView((v) => panBy(v, dx, dy)),
    [],
  );

  const startPinchIfTwo = useCallback(() => {
    const [a, b] = [...pointers.current.values()];
    pinch.current = pointers.current.size === 2 ? { span: distance(a, b), mid: midpoint(a, b) } : null;
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.currentTarget.setPointerCapture(e.pointerId);
      startPinchIfTwo();
      setDragging(true);
    },
    [startPinchIfTwo],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = { x: e.clientX, y: e.clientY };
      pointers.current.set(e.pointerId, next);

      const pinching = pinch.current;
      if (pinching && pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        const span = distance(a, b);
        const mid = midpoint(a, b);
        const factor = pinchFactor(pinching.span, span);
        const { dx, dy } = dragDelta(
          mid.x - pinching.mid.x,
          mid.y - pinching.mid.y,
          rect.width / panesRef.current,
          rect.height,
        );
        const anchor = pointerToViewport(mid.x, mid.y, rect, panesRef.current);
        setView((v) => panBy(zoomAt(v, v.scale * factor, anchor), dx, dy));
        pinch.current = { span, mid };
        return;
      }

      const { dx, dy } = dragDelta(
        next.x - prev.x,
        next.y - prev.y,
        rect.width / panesRef.current,
        rect.height,
      );
      setView((v) => panBy(v, dx, dy));
    },
    [containerRef],
  );

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!pointers.current.delete(e.pointerId)) return;
      // Going from two fingers to one resumes panning with the remaining finger.
      startPinchIfTwo();
      if (pointers.current.size === 0) setDragging(false);
    },
    [startPinchIfTwo],
  );

  return {
    view,
    dragging,
    zoomIn,
    zoomOut,
    reset,
    pan,
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}

/** Applies the shared view to its children (a <video>) with GPU transforms. */
export function ZoomPanLayer({
  view,
  imageRendering,
  children,
}: {
  view: ZoomView;
  imageRendering: CSSProperties["imageRendering"];
  children: ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 origin-top-left will-change-transform"
      style={{
        transform: `translate(${view.x * 100}%, ${view.y * 100}%) scale(${view.scale})`,
        imageRendering,
      }}
    >
      {children}
    </div>
  );
}
