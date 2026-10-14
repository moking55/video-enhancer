"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { sanitizeFps } from "./sync-math";
import { useSyncedVideos } from "./use-synced-videos";
import {
  clampWipe,
  formatTime,
  nudgeWipe,
  totalFrames,
  wipeClipPath,
  wipeFromPointer,
} from "./wipe-math";
import { ZoomPanLayer, useZoomPan } from "./zoom-pan";

export type CompareViewerProps = {
  /** Original video (muted follower). */
  inputUrl: string;
  /** Enhanced video (master: clock and sound). */
  outputUrl: string;
  fps: number;
  outputWidth: number;
  outputHeight: number;
  /** Called when either video fails to load (e.g. the signed URL expired). */
  onMediaError?: () => void;
};

type Mode = "wipe" | "side";

/** Seek distance for ←/→ while playing. */
const PLAYING_SEEK_S = 5;
/** Keyboard pan distance as a fraction of the viewport. */
const KEY_PAN = 0.1;

const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800 dark:focus-visible:outline-blue-400";
const BUTTON_ON =
  "border-blue-600 bg-blue-600 text-white hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500";
const LABEL =
  "pointer-events-none absolute top-2 rounded bg-black/70 px-2 py-0.5 text-xs font-medium text-white";

export function CompareViewer({
  inputUrl,
  outputUrl,
  fps,
  outputWidth,
  outputHeight,
  onMediaError,
}: CompareViewerProps) {
  const safeFps = sanitizeFps(fps);
  const masterRef = useRef<HTMLVideoElement>(null);
  const followerRef = useRef<HTMLVideoElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>("wipe");
  const [wipe, setWipe] = useState(0.5);
  const [pixelated, setPixelated] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  // Keyed by the URLs so a refreshed link clears the message without an effect.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const urlKey = `${inputUrl}|${outputUrl}`;
  const error =
    failedKey === urlKey ? "โหลดวิดีโอไม่สำเร็จ ลิงก์อาจหมดอายุ กำลังโหลดใหม่" : null;

  const sync = useSyncedVideos(masterRef, followerRef, { fps: safeFps });
  const zoom = useZoomPan(viewportRef, mode === "side" ? 2 : 1);

  useEffect(() => {
    // Sound is opt-in: the output starts muted and only our button changes it.
    if (masterRef.current) masterRef.current.muted = !soundOn;
  }, [soundOn]);

  const handleVideoError = () => {
    setFailedKey(urlKey);
    onMediaError?.();
  };

  const wipeMode = mode === "wipe";
  const ratio = (outputWidth > 0 && outputHeight > 0 ? outputWidth / outputHeight : 16 / 9) * (wipeMode ? 1 : 2);
  const imageRendering = pixelated ? "pixelated" : "auto";
  const frames = totalFrames(sync.duration, safeFps);
  const shownFrame = frames > 0 ? Math.min(sync.frame, frames - 1) + 1 : sync.frame + 1;
  const zoomLabel = `${Math.round(zoom.view.scale * 100) / 100}×`;

  const moveWipe = (direction: 1 | -1, large: boolean) =>
    setWipe((w) => nudgeWipe(w, direction, large));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented || e.metaKey) return;
    const target = e.target as HTMLElement;
    const onButton = target.closest("button") !== null;
    const run = (action: () => void) => {
      e.preventDefault();
      action();
    };

    switch (e.key) {
      case " ":
        // On a focused button Space must still press that button.
        if (!onButton) run(sync.togglePlay);
        return;
      case ",":
        return run(() => sync.stepFrame(-1));
      case ".":
        return run(() => sync.stepFrame(1));
      case "[":
      case "{":
        return run(() => moveWipe(-1, e.key === "{"));
      case "]":
      case "}":
        return run(() => moveWipe(1, e.key === "}"));
      case "+":
      case "=":
        if (e.ctrlKey || e.altKey) return;
        return run(zoom.zoomIn);
      case "-":
      case "_":
        if (e.ctrlKey || e.altKey) return;
        return run(zoom.zoomOut);
      case "0":
        if (e.ctrlKey || e.altKey) return;
        return run(zoom.reset);
      case "ArrowLeft":
      case "ArrowRight": {
        if (target.tagName === "INPUT") return; // the seek bar handles its own arrows
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.altKey) return;
        if (e.ctrlKey) return run(() => moveWipe(dir, e.shiftKey));
        if (e.shiftKey) {
          if (zoom.view.scale > 1) run(() => zoom.pan(-dir * KEY_PAN, 0));
          return;
        }
        return run(() =>
          sync.playing
            ? sync.seek(sync.currentTime + dir * PLAYING_SEEK_S)
            : sync.stepFrame(dir),
        );
      }
      case "ArrowUp":
      case "ArrowDown":
        if (e.shiftKey && zoom.view.scale > 1) {
          const dir = e.key === "ArrowDown" ? 1 : -1;
          run(() => zoom.pan(0, -dir * KEY_PAN));
        }
        return;
    }
  }

  // Wipe divider: pointer drag (captured) plus slider keyboard semantics.
  function onDividerPointer(e: ReactPointerEvent<HTMLDivElement>) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWipe(wipeFromPointer(e.clientX, rect.left, rect.width));
  }
  function onDividerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.stopPropagation(); // keep the viewport's drag-to-pan out of this
    e.currentTarget.setPointerCapture(e.pointerId);
    onDividerPointer(e);
  }
  function onDividerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onDividerPointer(e);
  }
  function onDividerKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      moveWipe(e.key === "ArrowRight" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setWipe(e.key === "Home" ? 0 : 1);
    }
  }

  const zoomed = zoom.view.scale > 1;
  const pane = "absolute top-0 bottom-0 overflow-hidden";

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label="เปรียบเทียบวิดีโอต้นฉบับกับวิดีโอที่ปรับปรุงแล้ว ดูแป้นพิมพ์ลัดได้ใต้ปุ่มควบคุม"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-blue-400"
    >
      <div
        ref={viewportRef}
        {...zoom.pointerHandlers}
        className={`relative mx-auto select-none overflow-hidden bg-black ${
          zoomed ? "touch-none" : "touch-pan-y"
        } ${zoomed ? (zoom.dragging ? "cursor-grabbing" : "cursor-grab") : ""}`}
        style={{
          aspectRatio: String(ratio),
          width: `min(100%, calc(70vh * ${ratio}))`,
        }}
      >
        {/* Enhanced (master). Bottom layer in wipe mode, right pane in side-by-side. */}
        <div
          className={pane}
          style={{ left: wipeMode ? "0%" : "50%", width: wipeMode ? "100%" : "50%" }}
        >
          <ZoomPanLayer view={zoom.view} imageRendering={imageRendering}>
            <video
              ref={masterRef}
              src={outputUrl}
              preload="auto"
              playsInline
              aria-label="วิดีโอที่ปรับปรุงแล้ว"
              className="h-full w-full object-contain"
              onError={handleVideoError}
            />
          </ZoomPanLayer>
          <span className={`${LABEL} ${wipeMode ? "right-2" : "left-2"}`}>
            ปรับปรุงแล้ว {outputWidth}×{outputHeight}
          </span>
        </div>

        {/* Original (follower, always muted). Top layer clipped by the divider. */}
        <div
          className={pane}
          style={{
            left: "0%",
            width: wipeMode ? "100%" : "50%",
            clipPath: wipeMode ? wipeClipPath(wipe) : undefined,
          }}
        >
          <ZoomPanLayer view={zoom.view} imageRendering={imageRendering}>
            <video
              ref={followerRef}
              src={inputUrl}
              preload="auto"
              playsInline
              muted
              aria-label="วิดีโอต้นฉบับ"
              className="h-full w-full object-contain"
              onError={handleVideoError}
            />
          </ZoomPanLayer>
          <span className={`${LABEL} left-2`}>ต้นฉบับ</span>
        </div>

        {wipeMode ? (
          <div
            role="slider"
            tabIndex={0}
            aria-label="เส้นแบ่งเปรียบเทียบ"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampWipe(wipe) * 100)}
            aria-valuetext={`ต้นฉบับ ${Math.round(clampWipe(wipe) * 100)}%, ปรับปรุงแล้ว ${
              100 - Math.round(clampWipe(wipe) * 100)
            }%`}
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onKeyDown={onDividerKey}
            className="group absolute top-0 bottom-0 z-10 w-8 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
            style={{ left: `${clampWipe(wipe) * 100}%` }}
          >
            <span className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" />
            <span
              aria-hidden="true"
              className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-xs font-bold text-black shadow-[0_0_0_1px_rgba(0,0,0,0.5)] group-focus-visible:ring-2 group-focus-visible:ring-blue-500 group-focus-visible:ring-offset-2"
            >
              ⇆
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={sync.togglePlay} className={BUTTON} aria-keyshortcuts="Space">
          {sync.playing ? "หยุดชั่วคราว" : "เล่น"}
        </button>
        <button
          type="button"
          onClick={() => sync.stepFrame(-1)}
          className={BUTTON}
          aria-keyshortcuts=","
          title="เฟรมก่อนหน้า (, หรือ ←)"
        >
          เฟรมก่อนหน้า
        </button>
        <button
          type="button"
          onClick={() => sync.stepFrame(1)}
          className={BUTTON}
          aria-keyshortcuts="."
          title="เฟรมถัดไป (. หรือ →)"
        >
          เฟรมถัดไป
        </button>
        <span className="ml-auto text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
          {formatTime(sync.currentTime)} / {formatTime(sync.duration)} · เฟรมที่ {shownFrame}
          {frames > 0 ? ` / ${frames}` : ""}
        </span>
      </div>

      <input
        type="range"
        aria-label="ตำแหน่งเวลา"
        aria-valuetext={`${formatTime(sync.currentTime)}, เฟรมที่ ${shownFrame}`}
        min={0}
        max={sync.duration > 0 ? sync.duration : 0}
        step="any"
        value={Math.min(sync.currentTime, sync.duration > 0 ? sync.duration : 0)}
        disabled={sync.duration <= 0}
        onChange={(e) => sync.seek(Number(e.target.value))}
        className="w-full accent-blue-600"
      />

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="โหมดการแสดงผล" className="flex gap-1">
          <button
            type="button"
            aria-pressed={wipeMode}
            onClick={() => setMode("wipe")}
            className={`${BUTTON} ${wipeMode ? BUTTON_ON : ""}`}
          >
            เส้นแบ่ง
          </button>
          <button
            type="button"
            aria-pressed={!wipeMode}
            onClick={() => setMode("side")}
            className={`${BUTTON} ${!wipeMode ? BUTTON_ON : ""}`}
          >
            เทียบข้างกัน
          </button>
        </div>

        <div role="group" aria-label="ซูม" className="flex items-center gap-1">
          <button
            type="button"
            onClick={zoom.zoomOut}
            disabled={!zoomed}
            className={BUTTON}
            aria-label="ซูมออก"
            title="ซูมออก (-)"
          >
            −
          </button>
          <span className="min-w-12 text-center text-sm tabular-nums" aria-live="polite">
            {zoomLabel}
          </span>
          <button
            type="button"
            onClick={zoom.zoomIn}
            disabled={zoom.view.scale >= 8}
            className={BUTTON}
            aria-label="ซูมเข้า"
            title="ซูมเข้า (+)"
          >
            +
          </button>
          <button
            type="button"
            onClick={zoom.reset}
            disabled={!zoomed}
            className={BUTTON}
            title="รีเซ็ตซูม (0)"
          >
            รีเซ็ตซูม
          </button>
        </div>

        <button
          type="button"
          aria-pressed={pixelated}
          onClick={() => setPixelated((p) => !p)}
          className={`${BUTTON} ${pixelated ? BUTTON_ON : ""}`}
          title="โหมดพิกเซลแสดงพิกเซลจริงเมื่อซูม โหมดเรียบเนียนจะทำให้ภาพนุ่มนวลขึ้น"
        >
          {pixelated ? "ภาพแบบพิกเซล" : "ภาพแบบเรียบเนียน"}
        </button>

        <button
          type="button"
          aria-pressed={soundOn}
          onClick={() => setSoundOn((s) => !s)}
          className={`${BUTTON} ${soundOn ? BUTTON_ON : ""}`}
          title="เสียงมาจากวิดีโอที่ปรับปรุงแล้ว ส่วนวิดีโอต้นฉบับจะปิดเสียงเสมอ"
        >
          {soundOn ? "เสียง: เปิด" : "เสียง: ปิด"}
        </button>
      </div>

      <details className="text-sm text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer">แป้นพิมพ์ลัด</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>คลิกที่ตัวเล่นวิดีโอหรือกด Tab เพื่อเปิดใช้งานแป้นพิมพ์ลัด</li>
          <li>Space: เล่นหรือหยุดชั่วคราว</li>
          <li>, และ . (หรือ ← และ → ขณะหยุด): เฟรมก่อนหน้าและเฟรมถัดไป</li>
          <li>← และ → ขณะเล่น: ข้ามครั้งละ 5 วินาที</li>
          <li>[ และ ] (กด Shift เพื่อขยับทีละมากขึ้น) หรือ Ctrl + ← และ →: ขยับเส้นแบ่ง</li>
          <li>โฟกัสที่เส้นแบ่งได้ แล้วใช้ ←, →, Home และ End เพื่อขยับ</li>
          <li>+ และ −: ซูม 1× ถึง 8×, 0: รีเซ็ตซูม</li>
          <li>Shift + ปุ่มลูกศร: เลื่อนภาพขณะซูมเข้า</li>
          <li>เมาส์: หมุนล้อเมาส์เพื่อซูมตรงตำแหน่งเคอร์เซอร์ ลากเพื่อเลื่อนภาพ และลากเส้นแบ่งเพื่อเปรียบเทียบ</li>
        </ul>
      </details>
    </div>
  );
}
