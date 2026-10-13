import { withUser } from '@/lib/auth';
import {
  CreateJobRequest,
  ListJobsQuery,
  MAX_ACTIVE_JOBS,
  toJobDto,
} from '@/lib/contracts/jobs';
import { checkPresetCompatibility, getPreset } from '@/lib/contracts/presets';
import { apiError, json } from '@/lib/http';

export const GET = withUser(async ({ supabase, userId }, request) => {
  const url = new URL(request.url);
  const parsed = ListJobsQuery.safeParse({
    assetId: url.searchParams.get('assetId') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return apiError(400, 'VALIDATION', 'Invalid query', parsed.error.issues);
  }
  const { assetId, limit } = parsed.data;

  let query = supabase.from('jobs').select('*').eq('owner_id', userId);
  if (assetId) query = query.eq('asset_id', assetId);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);
  if (error) return apiError(500, 'INTERNAL', error.message);

  const now = new Date();
  return json({ jobs: (data ?? []).map((row) => toJobDto(row, now)) });
});

export const POST = withUser(async ({ supabase, userId }, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'INVALID_JSON', 'Request body must be JSON');
  }
  const parsed = CreateJobRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(400, 'VALIDATION', 'Invalid request', parsed.error.issues);
  }
  const { assetId, presetId } = parsed.data;

  const { data: asset, error: assetErr } = await supabase
    .from('assets')
    .select('id, state, size_bytes, client_meta')
    .eq('id', assetId)
    .eq('owner_id', userId)
    .maybeSingle();
  if (assetErr) return apiError(500, 'INTERNAL', assetErr.message);
  if (!asset) return apiError(404, 'ASSET_NOT_FOUND', 'Asset not found');
  if (asset.state !== 'READY') {
    return apiError(409, 'ASSET_NOT_READY', 'Asset upload is not complete');
  }

  const preset = getPreset(presetId);
  if (!preset) return apiError(422, 'PRESET_UNKNOWN', `Unknown preset: ${presetId}`);

  const compat = checkPresetCompatibility(preset, asset.client_meta, Number(asset.size_bytes));
  if (!compat.ok) return apiError(422, compat.code, compat.reason);

  const { count, error: countErr } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .in('state', ['QUEUED', 'RUNNING']);
  if (countErr) return apiError(500, 'INTERNAL', countErr.message);
  if ((count ?? 0) >= MAX_ACTIVE_JOBS) {
    return apiError(
      429,
      'TOO_MANY_ACTIVE_JOBS',
      `At most ${MAX_ACTIVE_JOBS} jobs can be queued or running at once`,
    );
  }

  const { data: job, error: insertErr } = await supabase
    .from('jobs')
    .insert({
      owner_id: userId,
      asset_id: asset.id,
      preset_id: preset.id,
      state: 'QUEUED',
      // Snapshot so later registry edits never change a queued job.
      params: {
        model: preset.model,
        scale: preset.scale,
        maxInput: preset.maxInput,
        limits: preset.limits,
      },
    })
    .select('*')
    .single();
  if (insertErr || !job) {
    return apiError(500, 'INTERNAL', insertErr?.message ?? 'Insert failed');
  }
  return json(toJobDto(job), 201);
});
