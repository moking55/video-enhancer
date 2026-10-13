import { withOperator } from '@/lib/auth';
import { isStale, type JobState } from '@/lib/contracts/jobs';
import {
  QUEUE_FINISHED_LIMIT,
  QUEUE_FINISHED_WINDOW_MS,
  type QueueItem,
  type QueueResponse,
} from '@/lib/contracts/queue';
import { apiError, json } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/admin';

const COLUMNS =
  'id, owner_id, asset_id, preset_id, state, stage, processed_frames, total_frames, heartbeat_at, started_at, created_at';

/**
 * Operator-only view of every user's pending work. It crosses owners, so it
 * uses the service-role client; only whitelisted columns are selected and the
 * response never contains URLs, object keys or attempt ids.
 */
export const GET = withOperator(async () => {
  const admin = createAdminClient();
  const now = new Date();
  const since = new Date(now.getTime() - QUEUE_FINISHED_WINDOW_MS).toISOString();

  const [active, finished] = await Promise.all([
    admin
      .from('jobs')
      .select(COLUMNS)
      .in('state', ['QUEUED', 'RUNNING'])
      .order('created_at', { ascending: true }),
    admin
      .from('jobs')
      .select(COLUMNS)
      .in('state', ['SUCCEEDED', 'FAILED', 'CANCELLED'])
      .gte('finished_at', since)
      .order('finished_at', { ascending: false })
      .limit(QUEUE_FINISHED_LIMIT),
  ]);
  if (active.error) return apiError(500, 'INTERNAL', active.error.message);
  if (finished.error) return apiError(500, 'INTERNAL', finished.error.message);
  const rows = [...(active.data ?? []), ...(finished.data ?? [])];

  const assetIds = [...new Set(rows.map((r) => r.asset_id))];
  const filenames = new Map<string, string>();
  if (assetIds.length > 0) {
    const { data, error } = await admin.from('assets').select('id, filename').in('id', assetIds);
    if (error) return apiError(500, 'INTERNAL', error.message);
    for (const a of data ?? []) filenames.set(a.id, a.filename);
  }

  // At most a handful of users: one page of the auth admin list is plenty.
  const emails = new Map<string, string>();
  if (rows.length > 0) {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return apiError(500, 'INTERNAL', error.message);
    for (const u of data?.users ?? []) if (u.email) emails.set(u.id, u.email);
  }

  const jobs: QueueItem[] = rows.map((r) => ({
    id: r.id,
    state: r.state as JobState,
    presetId: r.preset_id,
    stage: r.stage,
    processedFrames: r.processed_frames,
    totalFrames: r.total_frames,
    stale: isStale(r, now),
    createdAt: r.created_at,
    ownerEmail: emails.get(r.owner_id) ?? null,
    filename: filenames.get(r.asset_id) ?? null,
  }));
  return json<QueueResponse>({ jobs });
});
