import "server-only";

import { connection } from "next/server";

import { isOperatorEmail, parseEmailList } from "@/lib/allowlist";
import { apiError } from "@/lib/http";
import { createClient } from "@/lib/supabase/server";

type UserSupabase = Awaited<ReturnType<typeof createClient>>;

export type User = {
  supabase: UserSupabase;
  userId: string;
  email: string;
  isOperator: boolean;
};

export type AuthErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "SERVER_MISCONFIGURED";

const STATUS: Record<AuthErrorCode, 401 | 403 | 500> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SERVER_MISCONFIGURED: 500,
};

/** Thrown by requireUser(); routes map it to 401/403/500 via authErrorResponse. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: 401 | 403 | 500;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = STATUS[code];
  }
}

/**
 * Verifies the session JWT (getClaims, not getSession) and that the email is
 * in ALLOWED_EMAILS (or OPERATOR_EMAILS: an operator not listed in
 * ALLOWED_EMAILS is still allowed). Use in Route Handlers, Server Components
 * and Server Actions. Empty ALLOWED_EMAILS is a misconfiguration, never
 * "allow all".
 */
export async function requireUser(): Promise<User> {
  // createClient() awaits cookies() first. That marks the call as request-time
  // under cacheComponents, so env checks below never run during prerender/build.
  const supabase = await createClient();

  const allowed = parseEmailList(process.env.ALLOWED_EMAILS);
  if (allowed.length === 0) {
    throw new AuthError(
      "SERVER_MISCONFIGURED",
      "ALLOWED_EMAILS is not configured",
    );
  }

  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) {
    throw new AuthError("UNAUTHENTICATED", "Authentication required");
  }

  const email = typeof claims.email === "string" ? claims.email : "";
  const isOperator = isOperatorEmail(email);
  if (!email || !(isOperator || allowed.includes(email.trim().toLowerCase()))) {
    throw new AuthError("FORBIDDEN", "This account is not allowed");
  }

  return { supabase, userId: claims.sub, email, isOperator };
}

/** Like requireUser(), but 403 FORBIDDEN unless the email is in OPERATOR_EMAILS. */
export async function requireOperator(): Promise<User> {
  const user = await requireUser();
  if (!user.isOperator) {
    throw new AuthError("FORBIDDEN", "Operator access required");
  }
  return user;
}

/** Maps an AuthError to the JSON error envelope (message is generic for 500). */
export function authErrorResponse(err: AuthError): Response {
  return apiError(
    err.status,
    err.code,
    err.status === 500 ? "Server misconfigured" : err.message,
  );
}

type Handler<Ctx> = (
  user: User,
  request: Request,
  ctx: Ctx,
) => Promise<Response>;

function wrap<Ctx>(require: () => Promise<User>, handler: Handler<Ctx>) {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    // Opt out of prerendering: every user route reads per-request auth state
    // (and runtime env), so it must never run during `next build`. Kept outside
    // the try: during prerender this promise rejects on purpose, and the catch
    // below must not swallow that signal.
    await connection();
    try {
      const user = await require();
      return await handler(user, request, ctx);
    } catch (err) {
      if (err instanceof AuthError) return authErrorResponse(err);
      console.error("Unhandled route error", err);
      return apiError(500, "INTERNAL", "Internal server error");
    }
  };
}

/**
 * Wraps a Route Handler so it only runs for an allowed user:
 *   export const GET = withUser(async ({ supabase }, request, ctx) => ...)
 * AuthError -> 401/403/500; any other thrown error -> 500 INTERNAL.
 */
export function withUser<Ctx = unknown>(handler: Handler<Ctx>) {
  return wrap(requireUser, handler);
}

/** Same as withUser, but only for operators (403 FORBIDDEN otherwise). */
export function withOperator<Ctx = unknown>(handler: Handler<Ctx>) {
  return wrap(requireOperator, handler);
}
