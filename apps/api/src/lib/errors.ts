import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
/** The record is still used elsewhere (super admins are offered a force delete). */
export const inUse = (message: string) => new AppError(409, 'in_use', message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);

/** Extracts a postgres error from a driver/drizzle error (which may wrap it in `cause`). */
function pgError(err: unknown): { code?: string; detail?: string; constraint?: string } | null {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 3 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e as never;
    e = e.cause as typeof e;
  }
  return null;
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    return reply.status(400).send({ error: { code: 'validation_error', message: 'Validation failed', details: { fields } } });
  }
  const pg = pgError(err);
  if (pg?.code === '23505') {
    return reply
      .status(409)
      .send({ error: { code: 'duplicate', message: 'A record with the same unique value already exists', details: pg.detail } });
  }
  if (pg?.code === '23503') {
    return reply.status(409).send({
      error: {
        code: 'in_use',
        message: 'This record is referenced by other records. Deactivate it instead, or remove the references first.',
      },
    });
  }
  if (pg?.code === '22P02' || pg?.code === '22007' || pg?.code === '22008') {
    return reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid value supplied' } });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'error', message: fe.message } });
  }
  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred' } });
}
