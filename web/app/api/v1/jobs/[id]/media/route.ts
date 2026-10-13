import { z } from 'zod';

import { withUser } from '@/lib/auth';
import { apiError, json } from '@/lib/http';
import { outputDownloadName, resolveInputInfo, type JobMediaResponse } from '@/lib/media-info';
import { presignGet } from '@/lib/storage';

/** Signed GET lifetime for playback/download (SPEC: 1 hour). */
const MEDIA_URL_TTL_SEC = 3600;

export const GET = withUser<RouteContext<'/api/v1/jobs/[id]/media'>>(
  async ({ supabase, userId }, _request, ctx) => {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return apiError(404, 'NOT_FOUND', 'Job not found');

    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (jobErr) return apiError(500, 'INTERNAL', jobErr.message);
    if (!job) return apiError(404, 'NOT_FOUND', 'Job not found');

    const { data: asset, error: assetErr } = await supabase
      .from('assets')
      .select('filename, object_key, probe, client_meta')
      .eq('id', job.asset_id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (assetErr) return apiError(500, 'INTERNAL', assetErr.message);
    if (!asset) return apiError(404, 'NOT_FOUND', 'Asset not found');

    const inputUrl = await presignGet(asset.object_key, MEDIA_URL_TTL_SEC);
    const input = {
      url: inputUrl,
      ...resolveInputInfo(asset.probe, asset.client_meta, job.output_meta),
    };

    let output: JobMediaResponse['output'] = null;
    if (job.state === 'SUCCEEDED' && job.output_key) {
      const [url, downloadUrl] = await Promise.all([
        presignGet(job.output_key, MEDIA_URL_TTL_SEC),
        presignGet(
          job.output_key,
          MEDIA_URL_TTL_SEC,
          outputDownloadName(asset.filename, job.preset_id),
        ),
      ]);
      output = { url, downloadUrl };
    }

    const body: JobMediaResponse = { input, output };
    return json(body);
  },
);
