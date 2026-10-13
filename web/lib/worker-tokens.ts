import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/supabase/database.types';

export const WORKER_TOKEN_PREFIX = 've_';

/** Shape check (`ve_` + 43 base64url chars) before hitting the DB. */
export const WORKER_TOKEN_PATTERN = /^ve_[A-Za-z0-9_-]{43}$/;

/** `ve_` + base64url of 32 random bytes. */
export function generateWorkerToken(): string {
  return WORKER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** Only this hex digest is stored; the raw token is shown once. */
export function hashWorkerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type WorkerTokenInfo = { active: boolean; createdAt: string | null };

/** Newest un-revoked token of the owner (never returns the hash). */
export async function getWorkerTokenInfo(
  supabase: SupabaseClient<Database>,
  ownerId: string,
): Promise<WorkerTokenInfo> {
  const { data, error } = await supabase
    .from('worker_tokens')
    .select('created_at')
    .eq('owner_id', ownerId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { active: data !== null, createdAt: data?.created_at ?? null };
}
