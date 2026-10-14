import { withUser } from '@/lib/auth';
import { isStale } from '@/lib/contracts/jobs';
import { toAssetDto, type AssetJobSummary } from '@/lib/contracts/uploads';
import { apiError, json } from '@/lib/http';

const LIST_LIMIT = 50;

export const GET = withUser(async ({ supabase, userId }) => {
  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('owner_id', userId)
    .neq('state', 'DELETED')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return apiError(500, 'INTERNAL', error.message);
  const assets = data ?? [];

  // One extra query for all listed assets; the newest job per asset wins.
  const latest = new Map<string, AssetJobSummary>();
  if (assets.length > 0) {
    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select(
        'id, asset_id, preset_id, state, created_at, stage, processed_frames, total_frames, heartbeat_at, started_at, cancel_requested, error_code',
      )
      .eq('owner_id', userId)
      .in(
        'asset_id',
        assets.map((a) => a.id),
      )
      .order('created_at', { ascending: false });
    if (jobsErr) return apiError(500, 'INTERNAL', jobsErr.message);
    const now = new Date();
    for (const j of jobs ?? []) {
      if (!latest.has(j.asset_id)) {
        latest.set(j.asset_id, {
          id: j.id,
          presetId: j.preset_id,
          state: j.state,
          createdAt: j.created_at,
          stage: j.stage ?? null,
          processedFrames: j.processed_frames ?? null,
          totalFrames: j.total_frames ?? null,
          stale: isStale(j, now),
          cancelRequested: j.cancel_requested ?? false,
          errorCode: j.error_code ?? null,
        });
      }
    }
  }

  return json({ assets: assets.map((a) => toAssetDto(a, latest.get(a.id) ?? null)) });
});
