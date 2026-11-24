import type { NestExpressApplication } from '@nestjs/platform-express';
import { type HttpRequest, type HttpResponse, header, isApiPath } from './http-types.js';
import { correlationIdOf, ProblemError, sendProblem } from './problem.js';

export const BODY_LIMIT_BYTES = 10 * 1024;
const CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** Opções de criação exigidas por `configureHttp` (o leitor de corpo é registrado por ele). */
export const HTTP_APPLICATION_OPTIONS = { bodyParser: false } as const;

/** Correlação, cabeçalhos e limites de entrada, aplicados antes das rotas. Sem CORS. */
export function configureHttp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use((request: HttpRequest, response: HttpResponse, next: () => void) => {
    if (!isApiPath(request.originalUrl)) {
      next();
      return;
    }
    const received = header(request, 'x-correlation-id');
    if (received !== undefined && CORRELATION_ID.test(received)) {
      request.correlationId = received;
    }
    response.setHeader('X-Correlation-ID', correlationIdOf(request));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (hasBody(request) && !JSON_TYPE.test(header(request, 'content-type') ?? '')) {
      sendProblem(request, response, new ProblemError('UNSUPPORTED_MEDIA_TYPE'));
      return;
    }
    next();
  });
  app.useBodyParser('json', { limit: BODY_LIMIT_BYTES, inflate: false });
}

function hasBody(request: HttpRequest): boolean {
  const length = header(request, 'content-length');
  return request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}
