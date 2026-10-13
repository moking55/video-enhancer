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
  dragDelta,
  panBy,
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
 * does not scroll while zooming.
 */
export function useZoomPan(
  containerRef: RefObject<HTMLElement | null>,
  panes: 1 | 2,
): ZoomPanApi {
  const [view, setView] = useState<ZoomView>(IDENTITY_VIEW);
  const [dragging, setDragging] = useState(false);
  const panesRef = useRef(panes);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

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

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { dx, dy } = dragDelta(
        e.clientX - d.x,
        e.clientY - d.y,
        rect.width / panesRef.current,
        rect.height,
      );
      d.x = e.clientX;
      d.y = e.clientY;
      setView((v) => panBy(v, dx, dy));
    },
    [containerRef],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  }, []);

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
