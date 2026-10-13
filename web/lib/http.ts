/** Shared headers: API responses are per-user and must never be cached. */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown };
};

/** JSON success response with `Cache-Control: private, no-store`. */
export function json<T>(data: T, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

/** Error envelope `{"error":{"code","message","details?"}}`, never cached. */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return Response.json(body, { status, headers: NO_STORE });
}
