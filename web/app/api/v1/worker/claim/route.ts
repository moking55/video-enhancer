import {
  ClaimRequest,
  INPUT_URL_TTL_SEC,
  type ClaimResponse,
} from '@/lib/contracts/worker';
import { getPreset, listPresets } from '@/lib/contracts/presets';
import { apiError, json } from '@/lib/http';
import { inputKey, presignGet } from '@/lib/storage';
import { withWorker } from '@/lib/worker-auth';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const POST = withWorker(async ({ admin }, request) => {
  // Empty body = "claim anything I can".
  let body: unknown = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return apiError(400, 'INVALID_JSON', 'Request body must be JSON');
    }
  }
  const parsed = ClaimRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(400, 'VALIDATION', 'Invalid request', parsed.error.issues);
  }
  const { presets: requested, gpu } = parsed.data;

  // Only presets this deployment offers (mock-x2 only when enabled).
  const offered = listPresets().map((p) => p.id);
  const presets = requested ? offered.filter((id) => requested.includes(id)) : offered;
  if (presets.length === 0) return noWork();

  const { data: claimed, error: claimErr } = await admin.rpc('claim_job', {
    p_presets: presets,
  });
  if (claimErr) return apiError(500, 'INTERNAL', claimErr.message);
  const job = claimed?.[0];
  if (!job || !job.attempt_id) return noWork();

  const { data: asset, error: assetErr } = await admin
    .from('assets')
    .select('id, filename, size_bytes, object_key, state')
    .eq('id', job.asset_id)
    .maybeSingle();
  if (assetErr) return apiError(500, 'INTERNAL', assetErr.message);
  if (!asset || asset.state !== 'READY') {
    // Do not leave the job RUNNING with nothing to download.
    await admin
      .from('jobs')
      .update({
        state: 'FAILED',
        error_code: 'ASSET_MISSING',
        error_message: 'Input asset is missing or not ready',
        finished_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('attempt_id', job.attempt_id)
      .eq('state', 'RUNNING');
    return apiError(409, 'ASSET_MISSING', 'Input asset is missing or not ready');
  }

  const { error: infoErr } = await admin
    .from('jobs')
    .update({ worker_info: gpu ? { gpu } : {} })
    .eq('id', job.id)
    .eq('attempt_id', job.attempt_id);
  if (infoErr) return apiError(500, 'INTERNAL', infoErr.message);

  const inputUrl = await presignGet(asset.object_key || inputKey(asset.id), INPUT_URL_TTL_SEC);

  // Prefer the params snapshot taken at job creation over the live registry.
  const params = isRecord(job.params) ? job.params : {};
  const registry = getPreset(job.preset_id);
  const response: ClaimResponse = {
    jobId: job.id,
    attemptId: job.attempt_id,
    preset: {
      id: job.preset_id,
      model: typeof params.model === 'string' ? params.model : (registry?.model ?? ''),
      scale: typeof params.scale === 'number' ? params.scale : (registry?.scale ?? 0),
      params: job.params,
    },
    inputUrl,
    input: {
      assetId: asset.id,
      sizeBytes: Number(asset.size_bytes),
      filename: asset.filename,
    },
  };
  return json(response);
});

function noWork(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
}
