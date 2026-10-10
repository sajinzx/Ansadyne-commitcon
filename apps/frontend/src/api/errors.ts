// API errors carry RFC 7807 problem details (from the server, or from the in-browser backend).
import type { ProblemDetails } from '@pitwall/shared';

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
  }
}

export function problem(status: number, title: string, detail?: string, errors?: { path: string; message: string }[]): ApiError {
  return new ApiError({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}) });
}
