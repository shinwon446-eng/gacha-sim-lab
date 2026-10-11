/** Contract status codes: 400 input, 401/403 auth, 404 missing, 409 conflict (incl. balance), 429 rate limit. */
export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly code: string, readonly detail?: Record<string, unknown>) { super(code); }
}
