// Administração do onboarding pelo facilitador vinculado: política de aprovação, lista e decisão das solicitações.
import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import {
  type ApprovalMode,
  isApprovalMode,
  isOnboardingStatus,
  type OnboardingDecision,
  type OnboardingStatus,
} from '../domain/approval-policy.js';

export interface PolicyState {
  readonly mode: ApprovalMode;
  /** 0 = nenhuma revisão gravada (AUTOMATIC). */
  readonly revision: number;
}

/** Resultado de uma gravação: o vínculo pode ter acabado, o workspace ter sido arquivado ou outra revisão ter chegado antes. */
export type PolicyPublish = 'PUBLISHED' | 'CONFLICT' | 'DENIED' | 'ARCHIVED';

export interface OnboardingRequestSummary {
  readonly requestId: string;
  readonly status: OnboardingStatus;
  readonly name: string;
  readonly email: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export type DecisionResult =
  | { readonly kind: 'DECIDED' | 'UNCHANGED'; readonly status: OnboardingDecision }
  | { readonly kind: 'NOT_FOUND' | 'DENIED' | 'ARCHIVED' | 'ALREADY_DECIDED' }
  | { readonly kind: 'DUPLICATE' };

/** Porta de persistência da administração. */
export interface OnboardingAdministrationStore {
  policy(workspaceId: string): Promise<PolicyState>;
  /** Grava a revisão numa transação com auditoria, reconferindo vínculo e estado do workspace; CONFLICT se já existe. */
  publishPolicy(access: WorkspaceAccess, revision: number, mode: ApprovalMode, correlationId: string): Promise<PolicyPublish>;
  /** Solicitações do workspace, por ordem de criação. */
  list(workspaceId: string, status: OnboardingStatus | null, page: { limit: number; offset: number }): Promise<OnboardingRequestSummary[]>;
  /**
   * Numa transação: reconfere vínculo e workspace, trava a solicitação do workspace e decide uma PENDING.
   * Aprovar cria cliente, senha, conta e vínculo pelo caminho da aprovação automática. Sempre com auditoria.
   */
  decide(access: WorkspaceAccess, requestId: string, decision: OnboardingDecision, correlationId: string): Promise<DecisionResult>;
}

export interface PolicyView extends PolicyState {
  readonly workspaceId: string;
}

export interface OnboardingRequestPage {
  readonly items: readonly OnboardingRequestSummary[];
  readonly nextOffset: number | null;
}

export interface DecisionView {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly status: OnboardingDecision;
}

export type OnboardingAdministrationErrorCode =
  | 'INVALID_REQUEST'
  | 'POLICY_CONFLICT'
  | 'ACCESS_LOST'
  | 'WORKSPACE_ARCHIVED'
  | 'REQUEST_NOT_FOUND'
  | 'ALREADY_DECIDED'
  | 'DUPLICATE';

export class OnboardingAdministrationError extends Error {
  constructor(readonly code: OnboardingAdministrationErrorCode) {
    super(`Administração do onboarding recusada: ${code}.`);
    this.name = 'OnboardingAdministrationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class OnboardingAdministrationService {
  constructor(private readonly store: OnboardingAdministrationStore) {}

  async policy(access: WorkspaceAccess): Promise<PolicyView> {
    return Object.freeze({ workspaceId: access.workspaceId, ...(await this.store.policy(access.workspaceId)) });
  }

  /** `baseRevision` precisa ser a vigente. O mesmo modo não grava nada. */
  async changePolicy(access: WorkspaceAccess, raw: unknown, correlationId: string): Promise<PolicyView> {
    const { baseRevision, mode } = parsePolicyChange(raw);
    const current = await this.store.policy(access.workspaceId);
    if (current.revision !== baseRevision) {
      throw new OnboardingAdministrationError('POLICY_CONFLICT');
    }
    if (current.mode === mode) {
      return Object.freeze({ workspaceId: access.workspaceId, ...current });
    }
    const revision = current.revision + 1;
    const result = await this.store.publishPolicy(access, revision, mode, correlationId);
    if (result === 'CONFLICT') {
      throw new OnboardingAdministrationError('POLICY_CONFLICT');
    }
    if (result === 'DENIED') {
      throw new OnboardingAdministrationError('ACCESS_LOST');
    }
    if (result === 'ARCHIVED') {
      throw new OnboardingAdministrationError('WORKSPACE_ARCHIVED');
    }
    return Object.freeze({ workspaceId: access.workspaceId, mode, revision });
  }

  async list(access: WorkspaceAccess, rawStatus: unknown, page: { limit: number; offset: number }): Promise<OnboardingRequestPage> {
    if (rawStatus !== undefined && !isOnboardingStatus(rawStatus)) {
      throw new OnboardingAdministrationError('INVALID_REQUEST');
    }
    const rows = await this.store.list(access.workspaceId, rawStatus ?? null, { limit: page.limit + 1, offset: page.offset });
    return Object.freeze({ items: rows.slice(0, page.limit), nextOffset: rows.length > page.limit ? page.offset + page.limit : null });
  }

  async decide(access: WorkspaceAccess, rawRequestId: unknown, decision: OnboardingDecision, correlationId: string): Promise<DecisionView> {
    if (typeof rawRequestId !== 'string' || !UUID.test(rawRequestId)) {
      throw new OnboardingAdministrationError('REQUEST_NOT_FOUND');
    }
    const result = await this.store.decide(access, rawRequestId, decision, correlationId);
    switch (result.kind) {
      case 'DECIDED':
      case 'UNCHANGED':
        return Object.freeze({ workspaceId: access.workspaceId, requestId: rawRequestId, status: result.status });
      case 'NOT_FOUND':
        throw new OnboardingAdministrationError('REQUEST_NOT_FOUND');
      case 'DENIED':
        throw new OnboardingAdministrationError('ACCESS_LOST');
      case 'ARCHIVED':
        throw new OnboardingAdministrationError('WORKSPACE_ARCHIVED');
      case 'ALREADY_DECIDED':
        throw new OnboardingAdministrationError('ALREADY_DECIDED');
      case 'DUPLICATE':
        throw new OnboardingAdministrationError('DUPLICATE');
    }
  }
}

/** Corpo: exatamente `baseRevision` (inteiro ≥ 0) e `mode`. */
export function parsePolicyChange(raw: unknown): { baseRevision: number; mode: ApprovalMode } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new OnboardingAdministrationError('INVALID_REQUEST');
  }
  const body = raw as Record<string, unknown>;
  const { baseRevision, mode } = body;
  if (Object.keys(body).sort().join(',') !== 'baseRevision,mode' || !Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0 || !isApprovalMode(mode)) {
    throw new OnboardingAdministrationError('INVALID_REQUEST');
  }
  return { baseRevision: baseRevision as number, mode };
}
