import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "./database.types";

/**
 * Supabase client for Client Components (login form). Call it inside event
 * handlers/effects, not at module top level, so builds never need env vars.
 * NEXT_PUBLIC_* values are inlined by Next.js at build time.
 */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
