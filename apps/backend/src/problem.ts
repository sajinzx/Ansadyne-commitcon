// RFC 7807 problem details and Zod validation helpers.
import type { ProblemDetails } from '@pitwall/shared';
import type { ZodType, ZodTypeDef } from 'zod';

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(detail ?? title);
  }

  toJSON(instance?: string): ProblemDetails {
    return {
      type: `https://pitwall.local/problems/${this.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(instance ? { instance } : {}),
      ...(this.errors ? { errors: this.errors } : {}),
    };
  }
}

export const notFound = (what: string) => new ProblemError(404, 'Not found', `${what} not found`);
export const conflict = (detail: string) => new ProblemError(409, 'Conflict', detail);

/** Parse a request part with a Zod schema; failures become 422 problem details with the failing paths. */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  throw new ProblemError(
    422,
    'Invalid request',
    'the request failed validation',
    r.error.issues.map((i) => ({ path: i.path.length ? i.path.join('.') : '$', message: i.message })),
  );
}
