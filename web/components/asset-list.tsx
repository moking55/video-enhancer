'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatDateTime } from '@/components/job-format';
import { deriveAssetStatus, hasActiveJob, type StatusTone } from '@/components/asset-status';
import { PresetPicker } from '@/components/preset-picker';
import { usePolling } from '@/components/use-polling';
import { ASSETS_CHANGED_EVENT } from '@/lib/client-meta';
import { MIB } from '@/lib/contracts/presets';
import { apiErrorText } from '@/lib/error-messages';
import type { AssetDto } from '@/lib/contracts/uploads';

/** User-facing strings of this component (status texts live in asset-status.ts). */
const TEXT = {
  heading: 'วิดีโอของคุณ',
  refresh: 'รีเฟรช',
  loading: 'กำลังโหลด...',
  empty: 'ยังไม่มีวิดีโอ อัปโหลดได้ที่ด้านบน',
  statusLabel: 'สถานะ',
  size: 'ขนาด',
  resolution: 'ความละเอียด / ความยาว',
  uploaded: 'อัปโหลดเมื่อ',
  preset: 'Preset',
  unknown: 'ไม่ทราบ',
  viewProgress: 'ดูความคืบหน้า',
  compare: 'เปรียบเทียบและดาวน์โหลด',
  viewDetails: 'ดูรายละเอียด',
  enhance: 'ปรับปรุงคุณภาพ',
  enhanceAgain: 'ปรับปรุงคุณภาพอีกครั้ง',
  cancel: 'ยกเลิก',
  cancelling: 'กำลังยกเลิก…',
  delete: 'ลบ',
  deleting: 'กำลังลบ...',
  confirmCancel: 'ต้องการยกเลิกงานนี้หรือไม่? งานที่กำลังทำอยู่จะหยุดเมื่อถึงจุดตรวจสอบความคืบหน้าถัดไป',
  cancelRequested: 'ส่งคำขอยกเลิกแล้ว',
  cancelFailed: (status: number) => `ยกเลิกไม่สำเร็จ (${status})`,
  networkCancel: 'เชื่อมต่อไม่ได้ งานยังไม่ถูกยกเลิก',
  loadFailed: (status: number) => `โหลดรายการไฟล์ไม่สำเร็จ (${status})`,
  networkLoad: 'เชื่อมต่อไม่ได้ขณะโหลดรายการไฟล์',
  confirmDelete: (name: string) =>
    `ต้องการลบ "${name}" หรือไม่? ไฟล์ต้นฉบับ ผลลัพธ์ที่ปรับปรุงแล้ว และงานที่เกี่ยวข้องทั้งหมดจะถูกลบ และไม่สามารถกู้คืนได้`,
  deleted: (name: string) => `ลบ "${name}" แล้ว`,
  deleteFailed: (status: number) => `ลบไม่สำเร็จ (${status})`,
  networkDelete: 'เชื่อมต่อไม่ได้ ยังไม่มีการลบไฟล์',
} as const;

/** Re-fetch interval while any row has a queued or running job. */
const ASSET_POLL_MS = 5000;

/** Badge colors only reinforce the text label; they never carry the meaning alone. */
const BADGE_CLASS: Record<StatusTone, string> = {
  neutral: 'border-zinc-500 text-zinc-700 dark:border-zinc-400 dark:text-zinc-300',
  info: 'border-blue-700 text-blue-800 dark:border-blue-400 dark:text-blue-300',
  warning: 'border-amber-700 text-amber-900 dark:border-amber-400 dark:text-amber-200',
  success: 'border-green-700 text-green-800 dark:border-green-500 dark:text-green-300',
  danger: 'border-red-700 text-red-800 dark:border-red-500 dark:text-red-300',
};

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600';
const BTN = `rounded-md border border-zinc-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-zinc-700 ${FOCUS}`;
const BTN_PRIMARY = `rounded-md bg-zinc-900 px-3 py-1 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900 ${FOCUS}`;

function formatSize(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

function formatDetails(asset: AssetDto): string {
  const { width, height, durationSec } = asset.clientMeta;
  const parts: string[] = [];
  if (width && height) parts.push(`${width}×${height}`);
  if (durationSec) parts.push(`${durationSec.toFixed(1)} วินาที`);
  return parts.length > 0 ? parts.join(', ') : TEXT.unknown;
}

export function AssetList() {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enhanceId, setEnhanceId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/assets', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setLoadError(apiErrorText(body, TEXT.loadFailed(res.status)));
        return;
      }
      setAssets(body.assets as AssetDto[]);
      setLoadError(null);
    } catch {
      setLoadError(TEXT.networkLoad);
    }
  }, []);

  useEffect(() => {
    // Deferred so the first fetch's setState is not synchronous in the effect.
    const initial = setTimeout(() => void load(), 0);
    const onChanged = () => void load();
    window.addEventListener(ASSETS_CHANGED_EVENT, onChanged);
    return () => {
      clearTimeout(initial);
      window.removeEventListener(ASSETS_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  // Poll while any row has a queued/running job (the hook pauses on hidden tabs).
  const anyActive = assets?.some(hasActiveJob) ?? false;
  usePolling(load, anyActive, ASSET_POLL_MS);

  async function cancelJob(jobId: string) {
    if (cancellingId || !window.confirm(TEXT.confirmCancel)) return;
    setCancellingId(jobId);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/jobs/${jobId}/cancel`, { method: 'POST' });
      if (res.ok) {
        setNotice(TEXT.cancelRequested);
      } else {
        const body = await res.json().catch(() => null);
        setNotice(apiErrorText(body, TEXT.cancelFailed(res.status)));
      }
      // Either way show the truth (the job may have moved on).
      await load();
    } catch {
      setNotice(TEXT.networkCancel);
    } finally {
      setCancellingId(null);
    }
  }

  async function remove(asset: AssetDto) {
    if (!window.confirm(TEXT.confirmDelete(asset.filename))) return;
    setDeletingId(asset.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/v1/assets/${asset.id}`, { method: 'DELETE' });
      if (res.status === 204 || res.status === 404) {
        if (enhanceId === asset.id) setEnhanceId(null);
        setNotice(TEXT.deleted(asset.filename));
        await load();
        headingRef.current?.focus();
        return;
      }
      const body = await res.json().catch(() => null);
      setNotice(apiErrorText(body, TEXT.deleteFailed(res.status)));
    } catch {
      setNotice(TEXT.networkDelete);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section aria-labelledby="assets-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="assets-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold outline-offset-2"
        >
          {TEXT.heading}
        </h2>
        <button type="button" onClick={() => void load()} className={BTN}>
          {TEXT.refresh}
        </button>
      </div>

      <p role="status" className="text-sm">
        {notice}
      </p>
      {loadError ? <p role="alert">{loadError}</p> : null}
      {assets === null && !loadError ? <p role="status">{TEXT.loading}</p> : null}
      {assets?.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">{TEXT.empty}</p>
      ) : null}

      {assets && assets.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {assets.map((asset) => {
            const status = deriveAssetStatus(asset);
            const { actions } = status;
            const job = asset.latestJob ?? null;
            const open = enhanceId === asset.id && actions.enhance !== null;
            const panelId = `enhance-${asset.id}`;
            const hintId = `delete-hint-${asset.id}`;
            const deleting = deletingId === asset.id;
            const jobLinkText =
              actions.jobLink === 'progress'
                ? TEXT.viewProgress
                : actions.jobLink === 'compare'
                  ? TEXT.compare
                  : TEXT.viewDetails;
            const cancelling = actions.cancelDisabled || (job !== null && cancellingId === job.id);
            return (
              <li
                key={asset.id}
                className="flex flex-col gap-2 rounded-md border border-zinc-300 p-4 dark:border-zinc-700"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="break-all font-medium">{asset.filename}</h3>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="sr-only">{TEXT.statusLabel}:</span>
                    <span
                      className={`inline-flex items-center rounded-full border px-3 py-0.5 font-medium ${BADGE_CLASS[status.tone]}`}
                    >
                      {status.label}
                    </span>
                    {status.detail ? (
                      <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
                        {status.detail}
                      </span>
                    ) : null}
                  </span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm text-zinc-600 dark:text-zinc-400">
                  <dt>{TEXT.size}</dt>
                  <dd>{formatSize(asset.sizeBytes)}</dd>
                  <dt>{TEXT.resolution}</dt>
                  <dd>{formatDetails(asset)}</dd>
                  <dt>{TEXT.uploaded}</dt>
                  <dd>
                    <time dateTime={asset.createdAt}>
                      {formatDateTime(asset.createdAt)}
                    </time>
                  </dd>
                  {job ? (
                    <>
                      <dt>{TEXT.preset}</dt>
                      <dd>{job.presetId}</dd>
                    </>
                  ) : null}
                </dl>

                <div className="flex flex-wrap items-center gap-2">
                  {actions.jobLink && job ? (
                    <Link
                      href={`/jobs/${job.id}`}
                      className={actions.jobLink === 'progress' ? BTN_PRIMARY : BTN}
                    >
                      {jobLinkText}
                      <span className="sr-only"> {asset.filename}</span>
                    </Link>
                  ) : null}
                  {actions.enhance ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setEnhanceId(open ? null : asset.id)}
                      className={actions.enhance === 'enhance' ? BTN_PRIMARY : BTN}
                    >
                      {actions.enhance === 'enhance' ? TEXT.enhance : TEXT.enhanceAgain}
                      <span className="sr-only"> {asset.filename}</span>
                    </button>
                  ) : null}
                  {actions.cancel && job ? (
                    <button
                      type="button"
                      onClick={() => void cancelJob(job.id)}
                      disabled={cancelling}
                      className={BTN}
                    >
                      {cancelling ? TEXT.cancelling : TEXT.cancel}
                      <span className="sr-only"> {asset.filename}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void remove(asset)}
                    disabled={deleting || !actions.deleteEnabled}
                    title={actions.deleteDisabledReason ?? undefined}
                    aria-describedby={actions.deleteDisabledReason ? hintId : undefined}
                    className={BTN}
                  >
                    {deleting ? TEXT.deleting : TEXT.delete}
                    <span className="sr-only"> {asset.filename}</span>
                  </button>
                </div>
                {actions.deleteDisabledReason ? (
                  <p id={hintId} className="text-xs text-zinc-600 dark:text-zinc-400">
                    {actions.deleteDisabledReason}
                  </p>
                ) : null}

                {open ? (
                  <div id={panelId}>
                    <PresetPicker asset={asset} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
