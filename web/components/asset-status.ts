import { formatFrames, stageText } from '@/components/job-format';
import type { AssetDto } from '@/lib/contracts/uploads';

/** User-facing strings of the asset status column (kept together for translation). */
export const ASSET_STATUS_TEXT = {
  uploading: 'Uploading',
  ready: 'Ready',
  queued: 'Queued (waiting for Colab)',
  processing: 'Processing',
  stale: 'Colab disconnected?',
  cancelling: 'Cancelling…',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
  deleteBlockedActive:
    'Cannot delete while a job is queued or running. Cancel the job first.',
} as const;

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export type AssetActions = {
  /** Link to the job page, labelled per state; null when there is no job to open. */
  jobLink: 'progress' | 'compare' | 'details' | null;
  /** Opens the preset picker. */
  enhance: 'enhance' | 'enhance-again' | null;
  cancel: boolean;
  /** Cancel is shown but disabled (cancel already requested). */
  cancelDisabled: boolean;
  deleteEnabled: boolean;
  /** Why Delete is disabled (used as its title); null when enabled. */
  deleteDisabledReason: string | null;
};

export type AssetStatus = {
  label: string;
  /** Extra line (stage, frames) shown next to the label; null when none. */
  detail: string | null;
  tone: StatusTone;
  /** True while the asset's newest job is QUEUED or RUNNING (drives polling). */
  active: boolean;
  actions: AssetActions;
};

const NO_ACTIONS: AssetActions = {
  jobLink: null,
  enhance: null,
  cancel: false,
  cancelDisabled: false,
  deleteEnabled: true,
  deleteDisabledReason: null,
};

export function hasActiveJob(asset: Pick<AssetDto, 'latestJob'>): boolean {
  const state = asset.latestJob?.state;
  return state === 'QUEUED' || state === 'RUNNING';
}

/** Status label, tone and allowed actions of one row, from the asset and its newest job. */
export function deriveAssetStatus(asset: AssetDto): AssetStatus {
  const T = ASSET_STATUS_TEXT;
  const job = asset.latestJob ?? null;

  if (asset.state === 'DELETED') {
    return {
      label: T.deleted,
      detail: null,
      tone: 'neutral',
      active: false,
      actions: { ...NO_ACTIONS, deleteEnabled: false, deleteDisabledReason: null },
    };
  }
  if (asset.state === 'UPLOADING') {
    return {
      label: T.uploading,
      detail: null,
      tone: 'info',
      active: false,
      actions: NO_ACTIONS,
    };
  }

  if (!job) {
    return {
      label: T.ready,
      detail: null,
      tone: 'neutral',
      active: false,
      actions: { ...NO_ACTIONS, enhance: 'enhance' },
    };
  }

  switch (job.state) {
    case 'QUEUED':
    case 'RUNNING': {
      const running = job.state === 'RUNNING';
      let label: string = running ? T.processing : T.queued;
      let tone: StatusTone = running ? 'info' : 'neutral';
      let detail: string | null = null;
      if (job.cancelRequested) {
        label = T.cancelling;
        tone = 'warning';
      } else if (running && job.stale) {
        label = T.stale;
        tone = 'warning';
      } else if (running) {
        const parts = [stageText(job.stage ?? null), formatFrames(job.processedFrames ?? null, job.totalFrames ?? null)];
        detail = parts.filter((p): p is string => !!p).join(' · ') || null;
      }
      return {
        label,
        detail,
        tone,
        active: true,
        actions: {
          jobLink: 'progress',
          enhance: null,
          cancel: true,
          cancelDisabled: job.cancelRequested,
          deleteEnabled: false,
          deleteDisabledReason: T.deleteBlockedActive,
        },
      };
    }
    case 'SUCCEEDED':
      return {
        label: T.done,
        detail: null,
        tone: 'success',
        active: false,
        actions: { ...NO_ACTIONS, jobLink: 'compare', enhance: 'enhance-again' },
      };
    case 'FAILED':
      return {
        label: job.errorCode ? `${T.failed}: ${job.errorCode}` : T.failed,
        detail: null,
        tone: 'danger',
        active: false,
        actions: { ...NO_ACTIONS, jobLink: 'details', enhance: 'enhance-again' },
      };
    case 'CANCELLED':
      return {
        label: T.cancelled,
        detail: null,
        tone: 'neutral',
        active: false,
        actions: { ...NO_ACTIONS, jobLink: 'details', enhance: 'enhance-again' },
      };
    default:
      // Unknown future job state: show it verbatim, allow the safe actions.
      return {
        label: job.state,
        detail: null,
        tone: 'neutral',
        active: false,
        actions: { ...NO_ACTIONS, jobLink: 'details', enhance: 'enhance-again' },
      };
  }
}
