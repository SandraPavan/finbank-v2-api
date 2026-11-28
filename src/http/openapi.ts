import { PAGE_DEFAULT_LIMIT, PAGE_MAX_LIMIT, PAGE_MAX_OFFSET } from './page.js';
import { PROBLEMS, type ProblemCode } from './problem.js';
import { CLOCK_TIME_ZONE, MAX_BUSINESS_DATE, MIN_BUSINESS_DATE } from '../simulation-clock/domain/business-date.js';

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

const RECOVERY: ProblemCode[] = ['PASSWORD_CHANGE_REQUIRED'];

const customerState = (operationId: string, summary: string) => ({
  post: {
    operationId,
    summary,
    security: SESSION_SECURITY,
    parameters: [
      { $ref: '#/components/parameters/WorkspaceId' },
      { $ref: '#/components/parameters/CustomerId' },
      ...CSRF_PARAMETER,
    ],
    responses: {
      200: { description: 'Estado atual; repetir não tem efeito', headers: CORRELATION, content: json('CustomerState') },
      ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
    },
  },
});

const decision = (operationId: string, summary: string) => ({
  post: {
    operationId,
    summary: `${summary}. Repetir a mesma decisão devolve o estado; a oposta é 409`,
    security: SESSION_SECURITY,
    parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, { $ref: '#/components/parameters/RequestId' }, ...CSRF_PARAMETER],
    responses: {
      200: { description: 'Estado decidido', headers: CORRELATION, content: json('OnboardingDecision') },
      ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'WORKSPACE_ARCHIVED', 'ONBOARDING_ALREADY_DECIDED', 'ONBOARDING_DUPLICATE'),
    },
  },
});

const accountStatus = (operationId: string, summary: string) => ({
  post: {
    operationId,
    summary: `${summary}. O mesmo estado devolve o atual sem gravar; o saldo nunca é tocado`,
    security: SESSION_SECURITY,
    parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, { $ref: '#/components/parameters/CustomerId' }, ...CSRF_PARAMETER],
    requestBody: { required: true, content: json('AccountStatusChange') },
    responses: {
      200: { description: 'Estado da conta', headers: CORRELATION, content: json('AccountState') },
      ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'WORKSPACE_ARCHIVED'),
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
  passwordChangeRequired: { type: 'boolean', description: 'Sessão restrita: só permite concluir a recuperação ou sair' },
  workspaceId: { type: ['string', 'null'], format: 'uuid', description: 'Workspace do cliente; null para facilitador' },
  idleExpiresAt: { type: 'string', format: 'date-time' },
  absoluteExpiresAt: { type: 'string', format: 'date-time' },
};
const ENROLLMENT_FIELDS = {
  active: { type: 'boolean', description: 'Há código vigente' },
  revision: { type: 'integer', minimum: 0, description: '0 = nenhum código jamais gerado' },
  required: { type: 'boolean', description: 'SHARED: o onboarding exige código' },
};
const WORKSPACE_FIELDS = {
  workspaceId: { type: 'string', format: 'uuid' },
  alias: { type: ['string', 'null'] },
  modality: { type: 'string', enum: ['SHARED', 'ISOLATED'] },
  status: { type: 'string', enum: ['ACTIVE', 'ARCHIVED'] },
  enrollment: fields(ENROLLMENT_FIELDS),
};
const DEFECT_ID = { type: 'string', pattern: '^d-[0-9a-f]{16}$' };
const BUSINESS_DATE = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' };
const ONBOARDING_STATUS = { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] };
const ACCOUNT_STATUS = { type: 'string', enum: ['ACTIVE', 'BLOCKED'] };
const ACCOUNT_STATE_FIELDS = {
  workspaceId: { type: 'string', format: 'uuid' },
  customerId: { type: 'string', format: 'uuid' },
  accountId: { type: 'string', format: 'uuid' },
  status: ACCOUNT_STATUS,
};
const CUSTOMER_FIELDS = {
  customerId: { type: 'string', format: 'uuid' },
  status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
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
          ...problems(...POST, ...SESSION, ...RECOVERY, 'AUTH_CURRENT_PASSWORD_INVALID', 'PASSWORD_POLICY_VIOLATION', 'RATE_LIMIT_EXCEEDED'),
        },
      },
    },
    '/api/v1/auth/password/recovery': {
      post: {
        operationId: 'completeRecovery',
        summary: 'Na sessão restrita, define a senha, encerra as sessões e abre uma normal',
        security: SESSION_SECURITY,
        parameters: CSRF_PARAMETER,
        requestBody: { required: true, content: json('PasswordRecovery') },
        responses: {
          200: { description: 'Senha definida; nova sessão no cookie', headers: CORRELATION, content: json('OpenedSession') },
          ...problems(...POST, ...SESSION, 'PASSWORD_POLICY_VIOLATION', 'RATE_LIMIT_EXCEEDED'),
        },
      },
    },
    '/api/v1/facilitator/workspaces': {
      get: {
        operationId: 'listFacilitatorWorkspaces',
        summary: 'Workspaces com vínculo ativo do facilitador',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Offset' }],
        responses: {
          200: { description: 'Página, por ordem de criação', headers: CORRELATION, content: json('WorkspacePage') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}': {
      get: {
        operationId: 'getFacilitatorWorkspace',
        summary: 'Workspace com vínculo ativo do facilitador',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }],
        responses: {
          200: { description: 'Workspace', headers: CORRELATION, content: json('Workspace') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/flags': {
      get: {
        operationId: 'getEducationalConfig',
        summary: 'Configuração educacional vigente do workspace',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }],
        responses: {
          200: { description: 'Revisão vigente resolvida; 0 = padrão sem defeitos', headers: CORRELATION, content: json('EducationalConfig') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
      patch: {
        operationId: 'changeEducationalConfig',
        summary: 'Grava a revisão seguinte; baseRevision deve ser a vigente',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, ...CSRF_PARAMETER],
        requestBody: { required: true, content: json('EducationalConfigChange') },
        responses: {
          200: { description: 'Nova revisão resolvida', headers: CORRELATION, content: json('EducationalConfig') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'CONFIGURATION_CONFLICT', 'EDUCATIONAL_CONFIG_INVALID'),
        },
      },
    },
    '/api/v1/onboarding/requests': {
      post: {
        operationId: 'submitOnboardingRequest',
        summary: 'Submete a solicitação de abertura. Política AUTOMATIC: aprovada com cliente e conta; MANUAL: PENDING com credencial de consulta. Sem sessão: CSRF do contexto pré-autenticado',
        security: PREAUTH_SECURITY,
        parameters: CSRF_PARAMETER,
        requestBody: { required: true, content: json('OnboardingRequest') },
        responses: {
          201: { description: 'APPROVED: o cliente entra pelo login de sempre. PENDING: credencial de consulta mostrada só nesta resposta', headers: CORRELATION, content: json('OnboardingSubmitted') },
          ...problems(
            ...POST, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'WORKSPACE_ARCHIVED', 'ONBOARDING_DUPLICATE', 'ENROLLMENT_CODE_REQUIRED',
            'ENROLLMENT_CODE_INVALID', 'ONBOARDING_UNDERAGE', 'RATE_LIMIT_EXCEEDED',
          ),
        },
      },
    },
    '/api/v1/onboarding/requests/status': {
      post: {
        operationId: 'getOnboardingRequestStatus',
        summary: 'Estado da solicitação com a credencial individual (24 h). Não abre sessão',
        security: PREAUTH_SECURITY,
        parameters: CSRF_PARAMETER,
        requestBody: { required: true, content: json('OnboardingStatusQuery') },
        responses: {
          200: { description: 'Só o estado', headers: CORRELATION, content: json('OnboardingStatus') },
          ...problems(...POST, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'RATE_LIMIT_EXCEEDED'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/onboarding-policy': {
      get: {
        operationId: 'getOnboardingPolicy',
        summary: 'Política de aprovação vigente; revisão 0 = AUTOMATIC',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }],
        responses: {
          200: { description: 'Política vigente', headers: CORRELATION, content: json('OnboardingPolicy') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
      patch: {
        operationId: 'changeOnboardingPolicy',
        summary: 'Grava a revisão seguinte; baseRevision deve ser a vigente; o mesmo modo não grava nada',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, ...CSRF_PARAMETER],
        requestBody: { required: true, content: json('OnboardingPolicyChange') },
        responses: {
          200: { description: 'Política vigente após a alteração', headers: CORRELATION, content: json('OnboardingPolicy') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'ONBOARDING_POLICY_CONFLICT', 'WORKSPACE_ARCHIVED'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests': {
      get: {
        operationId: 'listOnboardingRequests',
        summary: 'Solicitações do workspace, por ordem de criação; sem CPF, telefone nem credencial',
        security: SESSION_SECURITY,
        parameters: [
          { $ref: '#/components/parameters/WorkspaceId' },
          { $ref: '#/components/parameters/OnboardingStatusFilter' },
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/Offset' },
        ],
        responses: {
          200: { description: 'Página', headers: CORRELATION, content: json('OnboardingRequestPage') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests/{requestId}/approve': decision('approveOnboardingRequest', 'Aprova uma PENDING: cria cliente, senha, conta e vínculo'),
    '/api/v1/facilitator/workspaces/{workspaceId}/onboarding-requests/{requestId}/reject': decision('rejectOnboardingRequest', 'Rejeita uma PENDING; CPF e e-mail ficam livres'),
    '/api/v1/facilitator/workspaces/{workspaceId}/clock': {
      get: {
        operationId: 'getSimulationClock',
        summary: 'Data simulada vigente do workspace',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }],
        responses: {
          200: { description: 'Revisão vigente; 0 = data de criação do workspace no fuso do relógio', headers: CORRELATION, content: json('SimulationClock') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
      patch: {
        operationId: 'changeSimulationClock',
        summary: 'Grava a revisão seguinte; baseRevision deve ser a vigente; a mesma data não grava nada',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, ...CSRF_PARAMETER],
        requestBody: { required: true, content: json('SimulationClockChange') },
        responses: {
          200: { description: 'Data vigente após a alteração', headers: CORRELATION, content: json('SimulationClock') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'CLOCK_CONFLICT', 'WORKSPACE_ARCHIVED', 'CLOCK_DATE_INVALID'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/enrollment-code': {
      post: {
        operationId: 'issueEnrollmentCode',
        summary: 'Gera ou rotaciona o código de inscrição; o anterior deixa de valer',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, ...CSRF_PARAMETER],
        responses: {
          200: { description: 'Código em claro, mostrado só nesta resposta', headers: CORRELATION, content: json('IssuedEnrollmentCode') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'WORKSPACE_ARCHIVED'),
        },
      },
      delete: {
        operationId: 'revokeEnrollmentCode',
        summary: 'Revoga o código vigente; sem código vigente, nada muda',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, ...CSRF_PARAMETER],
        responses: {
          200: { description: 'Situação de inscrição, sem código', headers: CORRELATION, content: json('EnrollmentState') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'WORKSPACE_ARCHIVED'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/customers': {
      get: {
        operationId: 'listWorkspaceCustomers',
        summary: 'Clientes do workspace',
        security: SESSION_SECURITY,
        parameters: [
          { $ref: '#/components/parameters/WorkspaceId' },
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/Offset' },
        ],
        responses: {
          200: { description: 'Página, por ordem de criação', headers: CORRELATION, content: json('CustomerPage') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account': {
      get: {
        operationId: 'getCustomerAccount',
        summary: 'Estado da conta do cliente e histórico de bloqueios, do mais recente ao mais antigo',
        security: SESSION_SECURITY,
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }, { $ref: '#/components/parameters/CustomerId' }],
        responses: {
          200: { description: 'Conta e histórico', headers: CORRELATION, content: json('CustomerAccount') },
          ...problems(...COMMON, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND'),
        },
      },
    },
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account/block': accountStatus('blockCustomerAccount', 'Bloqueia a conta: não envia nem recebe movimentações'),
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/account/unblock': accountStatus('unblockCustomerAccount', 'Desbloqueia a conta'),
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/disable': customerState(
      'disableCustomer',
      'Desativa o cliente e encerra as sessões dele',
    ),
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/enable': customerState(
      'enableCustomer',
      'Reativa o cliente, sem restaurar sessões',
    ),
    '/api/v1/facilitator/workspaces/{workspaceId}/customers/{customerId}/password-reset': {
      post: {
        operationId: 'resetCustomerPassword',
        summary: 'Invalida senha e sessões do cliente e emite credencial temporária, mostrada só nesta resposta',
        security: SESSION_SECURITY,
        parameters: [
          { $ref: '#/components/parameters/WorkspaceId' },
          { $ref: '#/components/parameters/CustomerId' },
          ...CSRF_PARAMETER,
        ],
        responses: {
          200: { description: 'Emitida; repetir emite outra e revoga esta', headers: CORRELATION, content: json('IssuedCredential') },
          ...problems(...POST, ...SESSION, ...RECOVERY, 'RESOURCE_NOT_FOUND', 'IDENTITY_STATE_CONFLICT'),
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
      WorkspaceId: {
        name: 'workspaceId',
        in: 'path',
        required: true,
        description: 'Sem vínculo, inexistente ou malformado: o mesmo 404',
        schema: { type: 'string', format: 'uuid' },
      },
      RequestId: {
        name: 'requestId',
        in: 'path',
        required: true,
        description: 'De outro workspace, inexistente ou malformado: o mesmo 404',
        schema: { type: 'string', format: 'uuid' },
      },
      OnboardingStatusFilter: {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
      },
      CustomerId: {
        name: 'customerId',
        in: 'path',
        required: true,
        description: 'De outro workspace, inexistente ou malformado: o mesmo 404',
        schema: { type: 'string', format: 'uuid' },
      },
      Limit: {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: PAGE_MAX_LIMIT, default: PAGE_DEFAULT_LIMIT },
      },
      Offset: {
        name: 'offset',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: PAGE_MAX_OFFSET, default: 0 },
      },
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
      PasswordRecovery: fields({ newPassword: text }),
      IssuedCredential: fields({
        customerId: { type: 'string', format: 'uuid' },
        temporaryCredential: { type: 'string', pattern: '^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$' },
        expiresAt: { type: 'string', format: 'date-time' },
      }),
      PasswordChange: fields({ currentPassword: text, newPassword: text }),
      Session: fields(SESSION_FIELDS),
      OpenedSession: fields({ ...SESSION_FIELDS, csrfToken: CSRF_TOKEN }),
      Workspace: fields(WORKSPACE_FIELDS),
      WorkspacePage: fields({
        items: { type: 'array', items: fields(WORKSPACE_FIELDS) },
        nextOffset: { type: ['integer', 'null'], description: 'Início da próxima página; null na última' },
      }),
      EducationalConfig: fields({
        workspaceId: { type: 'string', format: 'uuid' },
        revision: { type: 'integer', minimum: 0 },
        catalogVersion: { type: 'string', pattern: '^[0-9]{4}\\.(0[1-9]|1[0-2])\\.[1-9][0-9]{0,3}$' },
        stale: { type: 'boolean', description: 'Revisão criada com outra versão do catálogo: nenhum defeito vale' },
        mode: { type: 'string', enum: ['STUDENT', 'CONTROLLED'] },
        preset: { oneOf: [{ type: 'null' }, fields({ kind: { type: 'string', enum: ['NONE', 'ALL', 'LAB'] } })] },
        enabledDefectIds: { type: 'array', items: DEFECT_ID },
        environment: { type: 'string', enum: ['ISOLATED', 'SHARED'] },
        availableDefectIds: { type: 'array', items: DEFECT_ID },
      }),
      EducationalConfigChange: fields({
        baseRevision: { type: 'integer', minimum: 0 },
        configuration: {
          type: 'object',
          description: 'STUDENT: { mode, preset: { kind: NONE | ALL } ou { kind: LAB, code } }. CONTROLLED: { mode, enabledDefectIds? }',
        },
      }),
      EnrollmentState: fields({ workspaceId: { type: 'string', format: 'uuid' }, ...ENROLLMENT_FIELDS }),
      IssuedEnrollmentCode: fields({
        workspaceId: { type: 'string', format: 'uuid' },
        ...ENROLLMENT_FIELDS,
        code: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$' },
      }),
      OnboardingRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['alias', 'name', 'cpf', 'birthDate', 'email', 'phone', 'password'],
        properties: {
          alias: text,
          enrollmentCode: { type: ['string', 'null'], description: 'Exigido em SHARED; em ISOLATED, só se houver código vigente' },
          name: { type: 'string', description: '2 a 120 caracteres; espaços repetidos viram um' },
          cpf: { type: 'string', description: '11 dígitos, com ou sem máscara 000.000.000-00; dígitos verificadores conferidos' },
          birthDate: { type: 'string', description: 'YYYY-MM-DD; 18 anos completos na data simulada do workspace' },
          email: text,
          phone: { type: 'string', description: 'DDD e número, 10 ou 11 dígitos; +55 opcional' },
          password: { type: 'string', description: '12 a 128 caracteres; guarda-se só o hash' },
        },
      },
      OnboardingSubmitted: {
        oneOf: [
          fields({ requestId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['APPROVED'] } }),
          fields({
            requestId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['PENDING'] },
            statusCredential: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$', description: 'Mostrada só aqui' },
            statusCredentialExpiresAt: { type: 'string', format: 'date-time' },
          }),
        ],
      },
      OnboardingStatusQuery: fields({ requestId: text, credential: text }),
      OnboardingStatus: fields({ requestId: { type: 'string', format: 'uuid' }, status: ONBOARDING_STATUS }),
      OnboardingPolicy: fields({
        workspaceId: { type: 'string', format: 'uuid' },
        mode: { type: 'string', enum: ['AUTOMATIC', 'MANUAL'] },
        revision: { type: 'integer', minimum: 0 },
      }),
      OnboardingPolicyChange: fields({ baseRevision: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['AUTOMATIC', 'MANUAL'] } }),
      OnboardingRequestPage: fields({
        items: {
          type: 'array',
          items: fields({
            requestId: { type: 'string', format: 'uuid' },
            status: ONBOARDING_STATUS,
            name: text,
            email: text,
            businessDate: BUSINESS_DATE,
            createdAt: { type: 'string', format: 'date-time' },
            decidedAt: { type: ['string', 'null'], format: 'date-time' },
          }),
        },
        nextOffset: { type: ['integer', 'null'], description: 'Início da próxima página; null na última' },
      }),
      OnboardingDecision: fields({
        workspaceId: { type: 'string', format: 'uuid' },
        requestId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
      }),
      AccountStatusChange: fields({ justification: { type: 'string', description: '10 a 200 caracteres; fica só no histórico da conta' } }),
      AccountState: fields(ACCOUNT_STATE_FIELDS),
      CustomerAccount: fields({
        ...ACCOUNT_STATE_FIELDS,
        history: {
          type: 'array',
          items: fields({
            fromStatus: ACCOUNT_STATUS,
            toStatus: ACCOUNT_STATUS,
            justification: text,
            changedBy: { type: 'string', format: 'uuid' },
            changedAt: { type: 'string', format: 'date-time' },
          }),
        },
      }),
      SimulationClock: fields({
        workspaceId: { type: 'string', format: 'uuid' },
        date: BUSINESS_DATE,
        revision: { type: 'integer', minimum: 0 },
        timeZone: { type: 'string', enum: [CLOCK_TIME_ZONE], description: 'Fuso de apresentação; a data não sofre conversão' },
      }),
      SimulationClockChange: fields({
        baseRevision: { type: 'integer', minimum: 0 },
        date: { type: 'string', description: `YYYY-MM-DD entre ${MIN_BUSINESS_DATE} e ${MAX_BUSINESS_DATE}` },
      }),
      CustomerPage: fields({
        items: { type: 'array', items: fields({ ...CUSTOMER_FIELDS, email: text }) },
        nextOffset: { type: ['integer', 'null'], description: 'Início da próxima página; null na última' },
      }),
      CustomerState: fields(CUSTOMER_FIELDS),
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
