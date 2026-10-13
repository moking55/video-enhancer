import { withOperator } from '@/lib/auth';
import { apiError, json } from '@/lib/http';
import {
  generateWorkerToken,
  getWorkerTokenInfo,
  hashWorkerToken,
} from '@/lib/worker-tokens';

/** `{ active, createdAt }` of the current token; never the hash. */
export const GET = withOperator(async ({ supabase, userId }) => {
  try {
    return json(await getWorkerTokenInfo(supabase, userId));
  } catch (err) {
    return apiError(500, 'INTERNAL', err instanceof Error ? err.message : 'Query failed');
  }
});

/** Issues a new token (shown once) and revokes every previous active one. */
export const POST = withOperator(async ({ supabase, userId }) => {
  // Revoke first: if the insert then fails the owner has no token (fail closed)
  // rather than an unknown extra active one.
  const { error: revokeErr } = await supabase
    .from('worker_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('owner_id', userId)
    .is('revoked_at', null);
  if (revokeErr) return apiError(500, 'INTERNAL', revokeErr.message);

  const token = generateWorkerToken();
  const { data, error } = await supabase
    .from('worker_tokens')
    .insert({ owner_id: userId, token_sha256: hashWorkerToken(token) })
    .select('created_at')
    .single();
  if (error || !data) return apiError(500, 'INTERNAL', error?.message ?? 'Insert failed');

  return json({ token, createdAt: data.created_at }, 201);
});
