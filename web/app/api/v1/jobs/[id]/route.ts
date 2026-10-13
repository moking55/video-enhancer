import { z } from 'zod';

import { withUser } from '@/lib/auth';
import { toJobDto } from '@/lib/contracts/jobs';
import { apiError, json } from '@/lib/http';

export const GET = withUser<RouteContext<'/api/v1/jobs/[id]'>>(
  async ({ supabase, userId }, _request, ctx) => {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return apiError(404, 'NOT_FOUND', 'Job not found');

    const { data, error } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) return apiError(500, 'INTERNAL', error.message);
    if (!data) return apiError(404, 'NOT_FOUND', 'Job not found');
    return json(toJobDto(data));
  },
);
