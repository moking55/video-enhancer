import { z } from 'zod';

import { withUser } from '@/lib/auth';
import { STALE_AFTER_MS, toJobDto, type JobRow } from '@/lib/contracts/jobs';
import { apiError, json } from '@/lib/http';
import { canRequeue, cancelEffect, requeueUpdate } from '@/lib/jobs';

type Ctx = RouteContext<'/api/v1/jobs/[id]/[action]'>;
type UpdateResult = { row: JobRow | null; error?: string } | 'forbidden';

export const POST = withUser<Ctx>(async ({ supabase, userId }, _request, ctx) => {
  const { id, action } = await ctx.params;
  if (action !== 'cancel' && action !== 'requeue') {
    return apiError(404, 'NOT_FOUND', 'Unknown action');
  }
  if (!z.uuid().safeParse(id).success) return apiError(404, 'NOT_FOUND', 'Job not found');

  const cancel = async (job: JobRow, now: Date): Promise<UpdateResult> => {
    const effect = cancelEffect(job.state, now);
    if (!effect) return 'forbidden';
    const { data, error } = await supabase
      .from('jobs')
      .update(effect.update)
      .eq('id', id)
      .eq('owner_id', userId)
      .eq('state', job.state)
      .select('*')
      .maybeSingle();
    return { row: data, error: error?.message };
  };

  const requeue = async (job: JobRow, now: Date): Promise<UpdateResult> => {
    if (!canRequeue(job, now)) return 'forbidden';
    let query = supabase
      .from('jobs')
      .update(requeueUpdate())
      .eq('id', id)
      .eq('owner_id', userId)
      .eq('state', job.state);
    // A heartbeat landing meanwhile must win over the stale decision.
    if (job.state === 'RUNNING') {
      query = query.lt('heartbeat_at', new Date(now.getTime() - STALE_AFTER_MS).toISOString());
    }
    const { data, error } = await query.select('*').maybeSingle();
    return { row: data, error: error?.message };
  };

  // A job can change state between our read and the conditional update (claim,
  // worker finishing). The update is guarded on the state we read, so a lost
  // race updates 0 rows; re-read once and re-decide before answering 409.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: job, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) return apiError(500, 'INTERNAL', error.message);
    if (!job) return apiError(404, 'NOT_FOUND', 'Job not found');

    const now = new Date();
    const result = action === 'cancel' ? await cancel(job, now) : await requeue(job, now);
    if (result === 'forbidden') break;
    if (result.error) return apiError(500, 'INTERNAL', result.error);
    if (result.row) return json(toJobDto(result.row, now));
    // 0 rows updated: lost a race, retry once with fresh state.
  }

  return action === 'cancel'
    ? apiError(409, 'NOT_CANCELLABLE', 'Job is already finished')
    : apiError(
        409,
        'NOT_REQUEUEABLE',
        'Only FAILED jobs, or RUNNING jobs with no heartbeat for 3 minutes, can be requeued',
      );
});
