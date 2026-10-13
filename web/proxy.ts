import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 "proxy" (formerly middleware). Refreshes the Supabase session
 * cookies on every matched request and does an optimistic redirect to /login
 * for unauthenticated page requests. Real authorization (ALLOWED_EMAILS) happens
 * in requireUser(); /api/* returns its own 401 JSON.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  let cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          cacheHeaders = headers;
          Object.entries(headers).forEach(([k, v]) =>
            response.headers.set(k, v),
          );
        },
      },
    },
  );

  // Validates the JWT and refreshes the session cookies if needed.
  const { data } = await supabase.auth.getClaims();

  const { pathname } = request.nextUrl;
  const isPublic =
    pathname === "/login" || pathname === "/api" || pathname.startsWith("/api/");

  if (!data?.claims && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    // Carry over any cookies (e.g. cleared stale session) and cache headers.
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    Object.entries(cacheHeaders).forEach(([k, v]) =>
      redirect.headers.set(k, v),
    );
    return redirect;
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next internals and static files (anything with a file extension).
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$).*)",
  ],
};
