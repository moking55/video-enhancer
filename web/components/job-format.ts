import type { JobDto, JobState } from "@/lib/contracts/jobs";

/** Plain-text state names: state is never conveyed by color alone. */
export const JOB_STATE_TEXT: Record<JobState, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STAGE_TEXT: Record<string, string> = {
  download: "Downloading input",
  probe: "Checking input",
  enhance: "Enhancing frames",
  encode: "Encoding video",
  upload: "Uploading result",
};

export function isActiveState(state: JobState): boolean {
  return state === "QUEUED" || state === "RUNNING";
}

/** State label for a job, including the pending-cancel case. */
export function jobStateText(job: Pick<JobDto, "state" | "cancelRequested" | "stale">): string {
  if (isActiveState(job.state) && job.cancelRequested) return "กำลังยกเลิก…";
  if (job.state === "RUNNING" && job.stale) return "Running (no signal)";
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
    return `${processed ?? 0} / ${total} frames${pct === null ? "" : ` (${pct}%)`}`;
  }
  return `${processed ?? 0} frames`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
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
