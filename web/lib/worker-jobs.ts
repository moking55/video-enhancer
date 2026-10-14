import 'server-only';

import {
  OUTPUT_URL_TTL_SEC,
  type CompleteRequest,
  type FailRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type OutputUrlResponse,
} from '@/lib/contracts/worker';
import { headObject, outputKey, presignPut } from '@/lib/storage';
import type { Database, Json } from '@/lib/supabase/database.types';
import type { Worker } from '@/lib/worker-auth';

/**
 * Worker job lifecycle writes (heartbeat / output-url / complete / fail).
 * Attempt fencing: every call must carry the job's current attemptId while the
 * job is RUNNING, and every write is conditional on
 * id + attempt_id + state='RUNNING', so a requeued job rejects the
 * old notebook (409 STALE_ATTEMPT).
 */

// Jobs are found by id + attempt only: the operator's worker serves every owner.
export type WorkerJobContext = { admin: Worker['admin']; jobId: string };

export type WorkerJobError = {
  ok: false;
  status: 404 | 409 | 500;
  code: string;
  message: string;
};
export type WorkerJobResult<T> = { ok: true; data: T } | WorkerJobError;

const err = (status: WorkerJobError['status'], code: string, message: string): WorkerJobError => ({
  ok: false,
  status,
  code,
  message,
});
const ok = <T>(data: T): WorkerJobResult<T> => ({ ok: true, data });
const stale = () => err(409, 'STALE_ATTEMPT', 'Attempt is no longer current for this job');
const cancelled = () => err(409, 'CANCELLED', 'Job was cancelled; the output was not published');
const internal = (message: string) => err(500, 'INTERNAL', message);

type JobHead = {
  asset_id: string;
  state: string;
  attempt_id: string | null;
  cancel_requested: boolean;
  total_frames: number | null;
};

async function loadJob({ admin, jobId }: WorkerJobContext): Promise<WorkerJobResult<JobHead>> {
  const { data, error } = await admin
    .from('jobs')
    .select('asset_id, state, attempt_id, cancel_requested, total_frames')
    .eq('id', jobId)
    .maybeSingle();
  if (error) return internal(error.message);
  if (!data) return err(404, 'NOT_FOUND', 'Job not found');
  return ok(data);
}

type JobPatch = Database['public']['Tables']['jobs']['Update'];

/** Conditional update: only the current RUNNING attempt of the job. */
function fencedUpdate(ctx: WorkerJobContext, attemptId: string, patch: JobPatch) {
  return ctx.admin
    .from('jobs')
    .update(patch)
    .eq('id', ctx.jobId)
    .eq('attempt_id', attemptId)
    .eq('state', 'RUNNING');
}

const isCurrent = (job: JobHead, attemptId: string) =>
  job.state === 'RUNNING' && job.attempt_id === attemptId;

export async function heartbeat(
  ctx: WorkerJobContext,
  body: HeartbeatRequest,
): Promise<WorkerJobResult<HeartbeatResponse>> {
  const job = await loadJob(ctx);
  if (!job.ok) return job;
  if (!isCurrent(job.data, body.attemptId)) return stale();

  const patch: JobPatch = {
    heartbeat_at: new Date().toISOString(),
    stage: body.stage,
  };
  if (body.totalFrames !== undefined) patch.total_frames = body.totalFrames;

  const { data, error } = await fencedUpdate(ctx, body.attemptId, patch)
    .select('cancel_requested')
    .maybeSingle();
  if (error) return internal(error.message);
  if (!data) return stale();

  // Progress only moves forward within an attempt: a delayed/out-of-order request must not rewind
  // it. The fence stays (attempt + RUNNING); the extra condition makes it an atomic "greatest".
  if (body.processedFrames !== undefined) {
    const n = body.processedFrames;
    const { error: progressErr } = await fencedUpdate(ctx, body.attemptId, { processed_frames: n })
      .or(`processed_frames.is.null,processed_frames.lt.${n}`)
      .select('id')
      .maybeSingle();
    if (progressErr) return internal(progressErr.message);
  }

  if (body.probe && body.stage === 'probe') {
    const { error: probeErr } = await ctx.admin
      .from('assets')
      .update({ probe: body.probe as Json })
      .eq('id', job.data.asset_id);
    if (probeErr) return internal(probeErr.message);
  }
  return ok({ cancelRequested: data.cancel_requested });
}

export async function outputUrl(
  ctx: WorkerJobContext,
  attemptId: string,
): Promise<WorkerJobResult<OutputUrlResponse>> {
  const job = await loadJob(ctx);
  if (!job.ok) return job;
  if (!isCurrent(job.data, attemptId)) return stale();

  const contentType = 'video/mp4';
  const putUrl = await presignPut(outputKey(ctx.jobId, attemptId), contentType, OUTPUT_URL_TTL_SEC);
  return ok({
    putUrl,
    // Content-Type is part of the signature, so the PUT must send exactly this.
    headers: { 'Content-Type': contentType },
    expiresAt: new Date(Date.now() + OUTPUT_URL_TTL_SEC * 1000).toISOString(),
  });
}

export async function complete(
  ctx: WorkerJobContext,
  body: CompleteRequest,
): Promise<WorkerJobResult<{ state: 'SUCCEEDED' }>> {
  const { attemptId } = body;
  const job = await loadJob(ctx);
  if (!job.ok) return job;

  // Duplicate delivery of a finished attempt: repeat the outcome it had.
  if (job.data.attempt_id === attemptId && job.data.state === 'SUCCEEDED') {
    return ok({ state: 'SUCCEEDED' });
  }
  if (job.data.attempt_id === attemptId && job.data.state === 'CANCELLED') return cancelled();
  if (!isCurrent(job.data, attemptId)) return stale();

  const key = outputKey(ctx.jobId, attemptId);
  const head = await headObject(key);
  if (!head) return err(409, 'OUTPUT_MISSING', 'Output object was not uploaded');
  if (head.size !== body.outputMeta.sizeBytes) {
    return err(
      409,
      'OUTPUT_SIZE_MISMATCH',
      `Uploaded object is ${head.size} bytes but outputMeta.sizeBytes is ${body.outputMeta.sizeBytes}`,
    );
  }

  const now = new Date().toISOString();
  // The job is done: show all frames processed (total known from the heartbeats, else the output's).
  const finalFrames = job.data.total_frames ?? body.outputMeta.frames;
  // A user cancel can land between our read and the update. The success update
  // is guarded on cancel_requested=false; if it loses, re-read once and re-decide.
  let cancelRequested = job.data.cancel_requested;
  for (let round = 0; round < 2; round++) {
    if (cancelRequested) {
      const { data, error } = await fencedUpdate(ctx, attemptId, {
        state: 'CANCELLED',
        stage: null,
        finished_at: now,
      })
        .select('state')
        .maybeSingle();
      if (error) return internal(error.message);
      return data ? cancelled() : stale();
    }
    const { data, error } = await fencedUpdate(ctx, attemptId, {
      state: 'SUCCEEDED',
      stage: null,
      processed_frames: finalFrames,
      total_frames: finalFrames,
      output_key: key,
      output_meta: body.outputMeta as unknown as Json,
      finished_at: now,
    })
      .eq('cancel_requested', false)
      .select('state')
      .maybeSingle();
    if (error) return internal(error.message);
    if (data) return ok({ state: 'SUCCEEDED' });

    const fresh = await loadJob(ctx);
    if (!fresh.ok) return fresh;
    if (!isCurrent(fresh.data, attemptId)) return stale();
    cancelRequested = fresh.data.cancel_requested;
  }
  return stale();
}

export async function failJob(
  ctx: WorkerJobContext,
  body: FailRequest,
): Promise<WorkerJobResult<{ state: string }>> {
  const { attemptId } = body;
  const job = await loadJob(ctx);
  if (!job.ok) return job;

  // Duplicate fail (or a fail after the job already finished): report current state.
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.data.state);
  if (terminal && job.data.attempt_id === attemptId) return ok({ state: job.data.state });
  if (!isCurrent(job.data, attemptId)) return stale();

  const now = new Date().toISOString();
  const patch: JobPatch =
    body.code === 'CANCELLED'
      ? { state: 'CANCELLED', finished_at: now }
      : {
          state: 'FAILED',
          error_code: body.code,
          error_message: body.message.slice(0, 2000),
          finished_at: now,
        };
  const { data, error } = await fencedUpdate(ctx, attemptId, patch).select('state').maybeSingle();
  if (error) return internal(error.message);
  if (!data) return stale();
  return ok({ state: data.state });
}
