import { z } from 'zod';

import { withUser } from '@/lib/auth';
import { toAssetDto } from '@/lib/contracts/uploads';
import { apiError, json } from '@/lib/http';
import { headObject } from '@/lib/storage';

export const POST = withUser<RouteContext<'/api/v1/assets/[id]/complete'>>(
  async ({ supabase, userId }, _request, ctx) => {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return apiError(404, 'NOT_FOUND', 'Asset not found');

    const { data: asset, error } = await supabase
      .from('assets')
      .select('*')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) return apiError(500, 'INTERNAL', error.message);
    if (!asset) return apiError(404, 'NOT_FOUND', 'Asset not found');

    if (asset.state === 'READY') return json(toAssetDto(asset));
    if (asset.state !== 'UPLOADING') {
      return apiError(409, 'INVALID_STATE', `Asset is ${asset.state}, expected UPLOADING`);
    }

    const head = await headObject(asset.object_key);
    if (!head) return apiError(409, 'UPLOAD_MISSING', 'No uploaded file found for this asset');
    if (head.size !== Number(asset.size_bytes)) {
      return apiError(
        409,
        'UPLOAD_SIZE_MISMATCH',
        `Uploaded ${head.size} bytes, expected ${asset.size_bytes}`,
      );
    }

    const { data: updated, error: updErr } = await supabase
      .from('assets')
      .update({ state: 'READY' })
      .eq('id', id)
      .eq('owner_id', userId)
      .eq('state', 'UPLOADING')
      .select('*')
      .maybeSingle();
    if (updErr) return apiError(500, 'INTERNAL', updErr.message);
    if (updated) return json(toAssetDto(updated));

    // Lost a race: re-read so a concurrent complete stays idempotent.
    const { data: current, error: rereadErr } = await supabase
      .from('assets')
      .select('*')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (rereadErr) return apiError(500, 'INTERNAL', rereadErr.message);
    if (current?.state === 'READY') return json(toAssetDto(current));
    return apiError(409, 'INVALID_STATE', 'Asset is no longer UPLOADING');
  },
);
