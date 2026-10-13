import 'server-only';

import { createClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

/**
 * Service-role Supabase client. Bypasses RLS: use only in server code after
 * the caller has been authenticated (owner session or worker token), and
 * always scope queries by owner_id. Never import from client components.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
