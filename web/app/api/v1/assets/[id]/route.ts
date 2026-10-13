import { z } from 'zod';

import { withUser } from '@/lib/auth';
import { apiError } from '@/lib/http';
import { deleteObjects, outputKey } from '@/lib/storage';

/**
 * Deletes an asset: its input object, every job output object and the rows
 * (jobs cascade). A RUNNING job blocks (409); QUEUED jobs go with the asset.
 * Objects go first and the row stays if storage fails, so a retry is possible
 * and no orphaned objects are left behind a missing row.
 */
export const DELETE = withUser<RouteContext<'/api/v1/assets/[id]'>>(
  async ({ supabase, userId }, _request, ctx) => {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return apiError(404, 'NOT_FOUND', 'Asset not found');

    const { data: asset, error } = await supabase
      .from('assets')
      .select('id, object_key')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) return apiError(500, 'INTERNAL', error.message);
    if (!asset) return apiError(404, 'NOT_FOUND', 'Asset not found');

    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, state, output_key, attempt_id')
      .eq('asset_id', id)
      .eq('owner_id', userId);
    if (jobsErr) return apiError(500, 'INTERNAL', jobsErr.message);

    const rows = jobs ?? [];
    if (rows.some((j) => j.state === 'RUNNING')) {
      return apiError(409, 'ASSET_BUSY', 'A job is running for this asset; cancel it first');
    }

    const keys = new Set<string>([asset.object_key]);
    for (const j of rows) {
      if (j.output_key) keys.add(j.output_key);
      // A failed/cancelled attempt may have uploaded a partial output.
      if (j.attempt_id) keys.add(outputKey(j.id, j.attempt_id));
    }

    try {
      await deleteObjects([...keys]);
    } catch (err) {
      console.error('Asset storage delete failed', err);
      return apiError(502, 'STORAGE_DELETE_FAILED', 'Could not delete stored files; try again');
    }

    const { error: delErr } = await supabase
      .from('assets')
      .delete()
      .eq('id', id)
      .eq('owner_id', userId);
    if (delErr) return apiError(500, 'INTERNAL', delErr.message);

    return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
  },
);
