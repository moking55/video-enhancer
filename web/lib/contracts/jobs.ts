import { z } from 'zod';

import type { Database } from '@/lib/supabase/database.types';

export type JobRow = Database['public']['Tables']['jobs']['Row'];

export const JOB_STATES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** RUNNING with no heartbeat for longer than this is shown as "Colab หลุด?". */
export const STALE_AFTER_MS = 3 * 60 * 1000;
/** Max QUEUED + RUNNING jobs at once. */
export const MAX_ACTIVE_JOBS = 2;

export const CreateJobRequest = z.object({
  assetId: z.uuid(),
  presetId: z.string().min(1).max(100),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const ListJobsQuery = z.object({
  assetId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuery>;

export const JobDto = z.object({
  id: z.uuid(),
  assetId: z.uuid(),
  presetId: z.string(),
  params: z.unknown(),
  state: z.enum(JOB_STATES),
  attemptCount: z.number().int(),
  cancelRequested: z.boolean(),
  stage: z.string().nullable(),
  processedFrames: z.number().int().nullable(),
  totalFrames: z.number().int().nullable(),
  heartbeatAt: z.string().nullable(),
  outputMeta: z.unknown(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stale: z.boolean(),
});
export type JobDto = z.infer<typeof JobDto>;

/** RUNNING and no heartbeat (falling back to started_at) within STALE_AFTER_MS. */
export function isStale(
  row: Pick<JobRow, 'state' | 'heartbeat_at' | 'started_at'>,
  now: Date,
): boolean {
  if (row.state !== 'RUNNING') return false;
  const last = row.heartbeat_at ?? row.started_at;
  if (!last) return true;
  return now.getTime() - new Date(last).getTime() > STALE_AFTER_MS;
}

/** DB row -> camelCase DTO. `attempt_id`, `output_key`, `worker_info` stay server-side. */
export function toJobDto(row: JobRow, now: Date = new Date()): JobDto {
  return {
    id: row.id,
    assetId: row.asset_id,
    presetId: row.preset_id,
    params: row.params,
    state: row.state as JobState,
    attemptCount: row.attempt_count,
    cancelRequested: row.cancel_requested,
    stage: row.stage,
    processedFrames: row.processed_frames,
    totalFrames: row.total_frames,
    heartbeatAt: row.heartbeat_at,
    outputMeta: row.output_meta,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stale: isStale(row, now),
  };
}
