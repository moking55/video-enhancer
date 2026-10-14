import { z } from 'zod';

import { COMMON_LIMITS } from '@/lib/contracts/presets';
import type { Database } from '@/lib/supabase/database.types';

export type AssetRow = Database['public']['Tables']['assets']['Row'];

export const ASSET_STATES = ['UPLOADING', 'READY', 'DELETED'] as const;
export type AssetState = (typeof ASSET_STATES)[number];

export const MAX_UPLOAD_BYTES = COMMON_LIMITS.maxSizeBytes;
export const UPLOAD_CONTENT_TYPE = 'video/mp4' as const;
/** Signed PUT lifetime (SPEC: 15 minutes). */
export const UPLOAD_URL_TTL_SEC = 900;

const positive = z.number().finite().positive();

export const ClientMeta = z.object({
  width: positive.optional(),
  height: positive.optional(),
  durationSec: positive.optional(),
});
export type ClientMeta = z.infer<typeof ClientMeta>;

export const CreateUploadRequest = z.object({
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  contentType: z.literal(UPLOAD_CONTENT_TYPE),
  clientMeta: ClientMeta.optional(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const CreateUploadResponse = z.object({
  assetId: z.uuid(),
  putUrl: z.string(),
  headers: z.object({ 'Content-Type': z.literal(UPLOAD_CONTENT_TYPE) }),
  expiresAt: z.string(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

/** Newest job of an asset, only the fields a list row needs. */
export const AssetJobSummary = z.object({
  id: z.uuid(),
  presetId: z.string(),
  state: z.string(),
  createdAt: z.string(),
  stage: z.string().nullable(),
  processedFrames: z.number().int().nullable(),
  totalFrames: z.number().int().nullable(),
  /** RUNNING with no recent heartbeat ("Colab disconnected?"). */
  stale: z.boolean(),
  cancelRequested: z.boolean(),
  errorCode: z.string().nullable(),
});
export type AssetJobSummary = z.infer<typeof AssetJobSummary>;

export const AssetDto = z.object({
  id: z.uuid(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  state: z.enum(ASSET_STATES),
  clientMeta: ClientMeta,
  probe: z.unknown(),
  createdAt: z.string(),
  latestJob: AssetJobSummary.nullable().optional(),
});
export type AssetDto = z.infer<typeof AssetDto>;

/**
 * Strips path separators and control chars so the stored name is a plain
 * file name. Falls back to `video.mp4` when nothing usable remains.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'video.mp4';
}

/**
 * Stored `client_meta` uses `duration` (what the preset check reads);
 * the API speaks `durationSec`.
 */
export function toStoredClientMeta(meta: ClientMeta | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (meta?.width !== undefined) out.width = meta.width;
  if (meta?.height !== undefined) out.height = meta.height;
  if (meta?.durationSec !== undefined) out.duration = meta.durationSec;
  return out;
}

function fromStoredClientMeta(stored: unknown): ClientMeta {
  const m = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const out: ClientMeta = {};
  const width = num(m.width);
  const height = num(m.height);
  const durationSec = num(m.duration ?? m.durationSec);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (durationSec !== undefined) out.durationSec = durationSec;
  return out;
}

/** DB row -> camelCase DTO. `object_key` and `owner_id` stay server-side. */
export function toAssetDto(row: AssetRow, latestJob?: AssetJobSummary | null): AssetDto {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    state: row.state as AssetState,
    clientMeta: fromStoredClientMeta(row.client_meta),
    probe: row.probe,
    createdAt: row.created_at,
    ...(latestJob === undefined ? {} : { latestJob }),
  };
}
