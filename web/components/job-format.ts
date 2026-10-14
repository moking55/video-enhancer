import type { JobDto, JobState } from "@/lib/contracts/jobs";

/** Plain-text state names: state is never conveyed by color alone. */
export const JOB_STATE_TEXT: Record<JobState, string> = {
  QUEUED: "อยู่ในคิว",
  RUNNING: "กำลังประมวลผล",
  SUCCEEDED: "สำเร็จ",
  FAILED: "ล้มเหลว",
  CANCELLED: "ยกเลิกแล้ว",
};

const STAGE_TEXT: Record<string, string> = {
  download: "กำลังดาวน์โหลดวิดีโอต้นฉบับ",
  probe: "กำลังตรวจสอบวิดีโอ",
  enhance: "กำลังปรับปรุงเฟรม",
  encode: "กำลังเข้ารหัสวิดีโอ",
  upload: "กำลังอัปโหลดผลลัพธ์",
};

export function isActiveState(state: JobState): boolean {
  return state === "QUEUED" || state === "RUNNING";
}

/** State label for a job, including the pending-cancel case. */
export function jobStateText(job: Pick<JobDto, "state" | "cancelRequested" | "stale">): string {
  if (isActiveState(job.state) && job.cancelRequested) return "กำลังยกเลิก…";
  if (job.state === "RUNNING" && job.stale) return "กำลังประมวลผล (ไม่มีสัญญาณ)";
  return JOB_STATE_TEXT[job.state];
}

export function stageText(stage: string | null): string | null {
  if (!stage) return null;
  return STAGE_TEXT[stage] ?? stage;
}

/** Percentage 0-100 when both counts are known and total > 0, else null. */
export function progressPercent(processed: number | null, total: number | null): number | null {
  if (processed === null || total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((processed / total) * 100)));
}

export function formatFrames(processed: number | null, total: number | null): string | null {
  if (processed === null && total === null) return null;
  const pct = progressPercent(processed, total);
  if (total !== null && total > 0) {
    return `${processed ?? 0} / ${total} เฟรม${pct === null ? "" : ` (${pct}%)`}`;
  }
  return `${processed ?? 0} เฟรม`;
}

const DATE_TIME = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : DATE_TIME.format(d);
}

/** Short badge classes; the text label carries the meaning, color only reinforces it. */
export function stateBadgeClass(state: JobState): string {
  switch (state) {
    case "SUCCEEDED":
      return "border-green-700 text-green-800 dark:border-green-500 dark:text-green-300";
    case "FAILED":
      return "border-red-700 text-red-800 dark:border-red-500 dark:text-red-300";
    case "RUNNING":
      return "border-blue-700 text-blue-800 dark:border-blue-400 dark:text-blue-300";
    default:
      return "border-zinc-500 text-zinc-700 dark:border-zinc-400 dark:text-zinc-300";
  }
}
