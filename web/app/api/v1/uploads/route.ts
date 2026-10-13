import { withUser } from '@/lib/auth';
import {
  CreateUploadRequest,
  MAX_UPLOAD_BYTES,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_URL_TTL_SEC,
  sanitizeFilename,
  toStoredClientMeta,
  type CreateUploadResponse,
} from '@/lib/contracts/uploads';
import { apiError, json } from '@/lib/http';
import { inputKey, presignPut } from '@/lib/storage';

export const POST = withUser(async ({ supabase, userId }, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'INVALID_JSON', 'Request body must be JSON');
  }

  // Specific codes first, so clients can tell "too big" / "wrong type" from a generic 400.
  if (body && typeof body === 'object') {
    const { sizeBytes, contentType } = body as Record<string, unknown>;
    if (typeof sizeBytes === 'number' && sizeBytes > MAX_UPLOAD_BYTES) {
      return apiError(413, 'TOO_LARGE', `File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB`);
    }
    if (typeof contentType === 'string' && contentType !== UPLOAD_CONTENT_TYPE) {
      return apiError(415, 'UNSUPPORTED_TYPE', `Only ${UPLOAD_CONTENT_TYPE} is accepted`);
    }
  }

  const parsed = CreateUploadRequest.safeParse(body);
  if (!parsed.success) {
    return apiError(400, 'VALIDATION', 'Invalid request', parsed.error.issues);
  }
  const { filename, sizeBytes, clientMeta } = parsed.data;

  // Generated here so object_key = inputKey(id) is known before the insert.
  const assetId = crypto.randomUUID();
  const { error } = await supabase.from('assets').insert({
    id: assetId,
    owner_id: userId,
    object_key: inputKey(assetId),
    filename: sanitizeFilename(filename),
    size_bytes: sizeBytes,
    state: 'UPLOADING',
    client_meta: toStoredClientMeta(clientMeta),
  });
  if (error) return apiError(500, 'INTERNAL', error.message);

  const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString();
  const putUrl = await presignPut(inputKey(assetId), UPLOAD_CONTENT_TYPE, UPLOAD_URL_TTL_SEC);

  const res: CreateUploadResponse = {
    assetId,
    putUrl,
    headers: { 'Content-Type': UPLOAD_CONTENT_TYPE },
    expiresAt,
  };
  return json(res, 201);
});
