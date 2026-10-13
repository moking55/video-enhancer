import 'server-only';

import { isOperatorEmail } from '@/lib/allowlist';
import { apiError } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/admin';
import { WORKER_TOKEN_PATTERN, hashWorkerToken } from '@/lib/worker-tokens';

export type Worker = {
  /** Owner of the token; verified to still be an operator. */
  operatorId: string;
  tokenId: string;
  /** Service-role client (bypasses RLS). Jobs are not owner-scoped: the operator's worker serves every user. */
  admin: ReturnType<typeof createAdminClient>;
};

/** Thrown by requireWorker(); withWorker maps it to 401 INVALID_WORKER_TOKEN. */
export class WorkerAuthError extends Error {
  readonly status = 401;
  readonly code = 'INVALID_WORKER_TOKEN';

  constructor() {
    super('Invalid or revoked worker token');
    this.name = 'WorkerAuthError';
  }
}

/**
 * `Authorization: Bearer ve_...` -> SHA-256 -> un-revoked row in worker_tokens.
 * Lookup is by hash of a 256-bit random token, so timing leaks nothing useful.
 */
export async function requireWorker(request: Request): Promise<Worker> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  const token = match?.[1];
  if (!token || !WORKER_TOKEN_PATTERN.test(token)) throw new WorkerAuthError();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_tokens')
    .select('id, owner_id')
    .eq('token_sha256', hashWorkerToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new WorkerAuthError();

  // The token is only as good as its owner's current operator status. Fail
  // closed: a lookup error or unknown user is treated as "not an operator".
  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(
    data.owner_id,
  );
  if (userErr || !isOperatorEmail(userData?.user?.email)) {
    throw new WorkerAuthError();
  }

  return { operatorId: data.owner_id, tokenId: data.id, admin };
}

/**
 * Wraps a Route Handler so it only runs for a valid worker token:
 *   export const POST = withWorker(async ({ operatorId, admin }, request, ctx) => ...)
 */
export function withWorker<Ctx = unknown>(
  handler: (worker: Worker, request: Request, ctx: Ctx) => Promise<Response>,
) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    try {
      const worker = await requireWorker(request);
      return await handler(worker, request, ctx);
    } catch (err) {
      if (err instanceof WorkerAuthError) {
        return apiError(err.status, err.code, err.message);
      }
      console.error('Unhandled worker route error', err);
      return apiError(500, 'INTERNAL', 'Internal server error');
    }
  };
}
