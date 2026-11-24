import { randomUUID } from 'node:crypto';
import type { HttpRequest, HttpResponse } from './http-types.js';

/** Catálogo de erros da API: status e título fixos por código estável. */
export const PROBLEMS = {
  VALIDATION_ERROR: [400, 'Solicitação inválida'],
  AUTH_INVALID_CREDENTIALS: [401, 'Credenciais inválidas'],
  AUTH_SESSION_REQUIRED: [401, 'Autenticação necessária'],
  AUTH_SESSION_EXPIRED: [401, 'Sessão expirada'],
  ACCESS_DENIED: [403, 'Acesso não autorizado'],
  CSRF_VALIDATION_FAILED: [403, 'Validação CSRF falhou'],
  RESOURCE_NOT_FOUND: [404, 'Recurso não encontrado'],
  PAYLOAD_TOO_LARGE: [413, 'Corpo da requisição grande demais'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Tipo de conteúdo não suportado'],
  AUTH_CURRENT_PASSWORD_INVALID: [422, 'Senha atual incorreta'],
  PASSWORD_POLICY_VIOLATION: [422, 'A senha deve ter de 12 a 128 caracteres'],
  RATE_LIMIT_EXCEEDED: [429, 'Muitas tentativas; aguarde antes de tentar novamente'],
  INTERNAL_ERROR: [500, 'Falha inesperada'],
  TEMPORARY_UNAVAILABLE: [503, 'Serviço temporariamente indisponível'],
} as const satisfies Record<string, readonly [number, string]>;

export type ProblemCode = keyof typeof PROBLEMS;

/** Nunca leva valores recebidos: `fields` só cita campos declarados no contrato. */
export class ProblemError extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly options: { readonly retryAfterSeconds?: number; readonly fields?: readonly string[] } = {},
  ) {
    super(code);
    this.name = 'ProblemError';
  }
}

export function correlationIdOf(request: HttpRequest): string {
  request.correlationId ??= randomUUID();
  return request.correlationId;
}

/** Problem Details (RFC 9457). */
export function sendProblem(request: HttpRequest, response: HttpResponse, problem: ProblemError): void {
  if (response.headersSent) {
    return;
  }
  const [status, title] = PROBLEMS[problem.code];
  const { retryAfterSeconds, fields } = problem.options;
  const correlationId = correlationIdOf(request);
  response.setHeader('X-Correlation-ID', correlationId);
  response.setHeader('Cache-Control', 'no-store');
  if (retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(retryAfterSeconds));
  }
  response
    .status(status)
    .type('application/problem+json')
    .send(
      JSON.stringify({
        type: `urn:finbank:problem:${problem.code.toLowerCase()}`,
        title,
        status,
        code: problem.code,
        correlationId,
        ...(fields === undefined ? {} : { errors: fields.map((field) => ({ field })) }),
      }),
    );
}
