/** Pure job state-transition guards (SPEC "Data model" state rules). No I/O. */
import { isStale, type JobRow } from '@/lib/contracts/jobs';

/** QUEUED/RUNNING can be cancelled; terminal states cannot. */
export function canCancel(state: string): boolean {
  return state === 'QUEUED' || state === 'RUNNING';
}

export type CancelEffect =
  | { type: 'CANCEL_NOW'; update: { state: 'CANCELLED'; finished_at: string } }
  | { type: 'REQUEST_CANCEL'; update: { cancel_requested: true } };

/**
 * QUEUED -> CANCELLED immediately; RUNNING -> flag for the worker to ack
 * (heartbeat returns cancelRequested); anything else -> null (not allowed).
 */
export function cancelEffect(state: string, now: Date = new Date()): CancelEffect | null {
  if (state === 'QUEUED') {
    return { type: 'CANCEL_NOW', update: { state: 'CANCELLED', finished_at: now.toISOString() } };
  }
  if (state === 'RUNNING') {
    return { type: 'REQUEST_CANCEL', update: { cancel_requested: true } };
  }
  return null;
}

/** FAILED, or RUNNING whose heartbeat went silent. CANCELLED/SUCCEEDED/QUEUED: no. */
export function canRequeue(
  job: Pick<JobRow, 'state' | 'heartbeat_at' | 'started_at'>,
  now: Date = new Date(),
): boolean {
  if (job.state === 'FAILED') return true;
  return isStale(job, now);
}

/** Update that sends a job back to the queue; a new attempt_id is minted at claim. */
export function requeueUpdate() {
  return {
    state: 'QUEUED',
    attempt_id: null,
    stage: null,
    processed_frames: null,
    total_frames: null,
    heartbeat_at: null,
    error_code: null,
    error_message: null,
    cancel_requested: false,
    finished_at: null,
  } satisfies Partial<JobRow>;
}
