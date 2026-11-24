import { PROBLEMS, type ProblemCode } from './problem.js';

// Contrato de /api/v1, escrito à mão e conferido por testes contra as rotas e respostas reais.

const json = (schema: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } });

const CORRELATION = { 'X-Correlation-ID': { $ref: '#/components/headers/CorrelationId' } };

function problems(...codes: ProblemCode[]): Record<string, unknown> {
  const byStatus = new Map<number, ProblemCode[]>();
  for (const code of codes) {
    const status = PROBLEMS[code][0];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus].map(([status, list]) => [
      String(status),
      {
        description: list.join(', '),
        headers: {
          ...CORRELATION,
          ...(status === 429 ? { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } } : {}),
        },
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      },
    ]),
  );
}

const COMMON: ProblemCode[] = ['VALIDATION_ERROR', 'ACCESS_DENIED', 'INTERNAL_ERROR', 'TEMPORARY_UNAVAILABLE'];
const POST: ProblemCode[] = [...COMMON, 'CSRF_VALIDATION_FAILED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE'];
const SESSION: ProblemCode[] = ['AUTH_SESSION_REQUIRED', 'AUTH_SESSION_EXPIRED'];
const CSRF_PARAMETER = [{ $ref: '#/components/parameters/CsrfToken' }];
const SESSION_SECURITY = [{ session: [] }];
const PREAUTH_SECURITY = [{ preauth: [] }, { session: [] }];

const login = (operationId: string, summary: string, schema: string) => ({
  post: {
    operationId,
    summary,
    security: PREAUTH_SECURITY,
    parameters: CSRF_PARAMETER,
    requestBody: { required: true, content: json(schema) },
    responses: {
      200: { description: 'Sessão aberta; segredo no cookie', headers: CORRELATION, content: json('OpenedSession') },
      ...problems(...POST, 'AUTH_INVALID_CREDENTIALS', 'RATE_LIMIT_EXCEEDED'),
    },
  },
});

const text = { type: 'string' };
const fields = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const SESSION_FIELDS = {
  identityId: { type: 'string', format: 'uuid' },
  profile: { type: 'string', enum: ['CUSTOMER', 'FACILITATOR'] },
  workspaceId: { type: ['string', 'null'], format: 'uuid', description: 'Workspace do cliente; null para facilitador' },
  idleExpiresAt: { type: 'string', format: 'date-time' },
  absoluteExpiresAt: { type: 'string', format: 'date-time' },
};
const CSRF_TOKEN = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'FinBank V2 API',
    version: '1.0.0',
    description: 'Ambiente educacional com dados fictícios. Nenhuma operação movimenta dinheiro real.',
  },
  paths: {
    '/api/v1/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        summary: 'Este contrato',
        security: [],
        responses: {
          200: { description: 'Documento OpenAPI', headers: CORRELATION, content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/api/v1/auth/csrf': {
      get: {
        operationId: 'getCsrfToken',
        summary: 'Token CSRF do contexto atual; cria o contexto pré-autenticado se não houver',
        security: [],
        responses: { 200: { description: 'Token', headers: CORRELATION, content: json('CsrfToken') }, ...problems(...COMMON) },
      },
    },
    '/api/v1/auth/customer/login': login('loginCustomer', 'Login de cliente', 'CustomerLogin'),
    '/api/v1/auth/facilitator/login': login('loginFacilitator', 'Login de facilitador', 'FacilitatorLogin'),
    '/api/v1/auth/me': {
      get: {
        operationId: 'getCurrentSession',
        summary: 'Identidade autenticada',
        security: SESSION_SECURITY,
        responses: {
          200: { description: 'Sessão atual', headers: CORRELATION, content: json('Session') },
          ...problems(...COMMON, ...SESSION),
        },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        operationId: 'logout',
        summary: 'Encerra a sessão atual; repetir não tem efeito',
        security: [...PREAUTH_SECURITY, {}],
        parameters: [{ $ref: '#/components/parameters/OptionalCsrfToken' }],
        responses: { 204: { description: 'Encerrada; cookies removidos', headers: CORRELATION }, ...problems(...POST) },
      },
    },
    '/api/v1/auth/logout-all': {
      post: {
        operationId: 'logoutAll',
        summary: 'Encerra todas as sessões da própria identidade',
        security: SESSION_SECURITY,
        parameters: CSRF_PARAMETER,
        responses: { 204: { description: 'Encerradas; cookies removidos', headers: CORRELATION }, ...problems(...POST, ...SESSION) },
      },
    },
    '/api/v1/auth/password/change': {
      post: {
        operationId: 'changePassword',
        summary: 'Troca a senha, encerra as sessões e abre uma nova',
        security: SESSION_SECURITY,
        parameters: CSRF_PARAMETER,
        requestBody: { required: true, content: json('PasswordChange') },
        responses: {
          200: { description: 'Senha trocada; nova sessão no cookie', headers: CORRELATION, content: json('OpenedSession') },
          ...problems(...POST, ...SESSION, 'AUTH_CURRENT_PASSWORD_INVALID', 'PASSWORD_POLICY_VIOLATION', 'RATE_LIMIT_EXCEEDED'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      session: { type: 'apiKey', in: 'cookie', name: '__Host-finbank_session', description: 'finbank_session em HTTP local' },
      preauth: { type: 'apiKey', in: 'cookie', name: '__Host-finbank_preauth', description: 'finbank_preauth em HTTP local' },
    },
    headers: { CorrelationId: { schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,64}$' } } },
    parameters: {
      CsrfToken: { name: 'X-CSRF-Token', in: 'header', required: true, schema: CSRF_TOKEN },
      OptionalCsrfToken: {
        name: 'X-CSRF-Token',
        in: 'header',
        required: false,
        description: 'Obrigatório se houver cookie de sessão ou de contexto',
        schema: CSRF_TOKEN,
      },
    },
    schemas: {
      CsrfToken: fields({ csrfToken: CSRF_TOKEN }),
      CustomerLogin: fields({ alias: text, email: text, password: text }),
      FacilitatorLogin: fields({ email: text, password: text }),
      PasswordChange: fields({ currentPassword: text, newPassword: text }),
      Session: fields(SESSION_FIELDS),
      OpenedSession: fields({ ...SESSION_FIELDS, csrfToken: CSRF_TOKEN }),
      Problem: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'status', 'code', 'correlationId'],
        properties: {
          type: { type: 'string', pattern: '^urn:finbank:problem:[a-z_]+$' },
          title: text,
          status: { type: 'integer' },
          code: { type: 'string', enum: Object.keys(PROBLEMS) },
          correlationId: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,64}$' },
          errors: { type: 'array', items: fields({ field: text }) },
        },
      },
    },
  },
};
