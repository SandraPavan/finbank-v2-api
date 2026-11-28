import type { OnboardingStatus } from '../domain/approval-policy.js';
import { ADULT_AGE, ageOn, type OnboardingDraft, OnboardingValidationError } from '../domain/onboarding-request.js';
import { generateStatusCredential, hashStatusCredential } from '../domain/status-credential.js';

/** Workspace localizado pelo alias; o alias não é credencial. */
export interface OnboardingWorkspace {
  readonly id: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

/** Solicitação pronta para gravar: dados normalizados, hash da senha, data simulada usada e hash da credencial de consulta. */
export interface NewOnboardingRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly cpf: string;
  readonly birthDate: string;
  readonly email: string;
  readonly phone: string;
  readonly passwordHash: string;
  readonly businessDate: string;
  readonly clockRevision: number;
  /** Gravado só se a política vigente deixar a solicitação PENDING. */
  readonly statusCredentialHash: string;
}

export type OnboardingInsert =
  | { readonly kind: 'APPROVED'; readonly requestId: string }
  | { readonly kind: 'PENDING'; readonly requestId: string; readonly statusCredentialExpiresAt: Date }
  | { readonly kind: 'DUPLICATE'; readonly fields: readonly ('cpf' | 'email')[] }
  | { readonly kind: 'ARCHIVED' };

/** Porta de persistência. */
export interface OnboardingStore {
  findWorkspace(alias: string): Promise<OnboardingWorkspace | null>;
  /**
   * Numa transação sob a trava do workspace: reconfere o estado e a unicidade (inclusive clientes) e lê a política vigente.
   * AUTOMATIC: cria cliente, senha, conta e vínculo e grava `APPROVED` com auditoria. MANUAL: grava `PENDING` com a credencial.
   */
  insert(request: NewOnboardingRequest, correlationId: string): Promise<OnboardingInsert>;
  /** Estado da solicitação se a credencial confere e não venceu (relógio do banco); senão null. */
  findStatus(requestId: string, credentialHash: string): Promise<OnboardingStatus | null>;
}

/** Portas dos módulos vizinhos, satisfeitas pelos serviços de inscrição e do relógio. */
export interface EnrollmentPort {
  check(workspaceId: string, provided: string | null): Promise<'ACCEPTED' | 'REQUIRED' | 'INVALID'>;
}
export interface ClockPort {
  today(workspaceId: string): Promise<{ readonly date: string; readonly revision: number }>;
}
/** Limita tentativas inválidas por assunto; `attempt` sinaliza falha com o erro de `invalidAttempt`. */
export interface EnrollmentAttempts {
  run<T>(subject: string, attempt: () => Promise<T>): Promise<T>;
}
export interface OnboardingHasher {
  hash(password: string): Promise<string>;
}

export interface OnboardingDependencies {
  readonly store: OnboardingStore;
  readonly enrollment: EnrollmentPort;
  readonly clock: ClockPort;
  readonly attempts: EnrollmentAttempts;
  /** Converte a tentativa inválida no erro que o limitador conta como falha. */
  readonly invalidAttempt: () => Error;
  readonly hasher: OnboardingHasher;
}

export type OnboardingErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_ARCHIVED'
  | 'ENROLLMENT_CODE_REQUIRED'
  | 'ENROLLMENT_CODE_INVALID'
  | 'UNDERAGE'
  | 'DUPLICATE'
  | 'STATUS_NOT_FOUND';

/** Recusa pelas regras; `fields` só nos duplicados. Sem valores recebidos. */
export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingErrorCode,
    readonly fields: readonly ('cpf' | 'email')[] = [],
  ) {
    super(`Solicitação de abertura recusada: ${code}.`);
    this.name = 'OnboardingError';
  }
}

export type SubmittedOnboarding =
  | { readonly requestId: string; readonly status: 'APPROVED' }
  | { readonly requestId: string; readonly status: 'PENDING'; readonly statusCredential: string; readonly statusCredentialExpiresAt: string };

export interface OnboardingStatusView {
  readonly requestId: string;
  readonly status: OnboardingStatus;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Submissão atômica da solicitação de abertura e consulta do estado com a credencial individual. */
export class OnboardingService {
  constructor(private readonly deps: OnboardingDependencies) {}

  async submit(draft: OnboardingDraft, correlationId: string): Promise<SubmittedOnboarding> {
    const { store, clock, hasher } = this.deps;
    const workspace = await store.findWorkspace(draft.alias);
    if (workspace === null) {
      throw new OnboardingError('WORKSPACE_NOT_FOUND');
    }
    if (workspace.status !== 'ACTIVE') {
      throw new OnboardingError('WORKSPACE_ARCHIVED');
    }
    await this.checkEnrollment(workspace.id, draft);
    const today = await clock.today(workspace.id);
    if (draft.birthDate > today.date) {
      throw new OnboardingValidationError(['birthDate']);
    }
    if (ageOn(draft.birthDate, today.date) < ADULT_AGE) {
      throw new OnboardingError('UNDERAGE');
    }
    const statusCredential = generateStatusCredential();
    const result = await store.insert(
      {
        workspaceId: workspace.id,
        name: draft.name,
        cpf: draft.cpf,
        birthDate: draft.birthDate,
        email: draft.email,
        phone: draft.phone,
        passwordHash: await hasher.hash(draft.password),
        businessDate: today.date,
        clockRevision: today.revision,
        statusCredentialHash: hashStatusCredential(statusCredential) ?? '',
      },
      correlationId,
    );
    switch (result.kind) {
      case 'DUPLICATE':
        throw new OnboardingError('DUPLICATE', result.fields);
      case 'ARCHIVED':
        throw new OnboardingError('WORKSPACE_ARCHIVED');
      case 'APPROVED':
        return Object.freeze({ requestId: result.requestId, status: 'APPROVED' });
      case 'PENDING':
        return Object.freeze({
          requestId: result.requestId,
          status: 'PENDING',
          statusCredential,
          statusCredentialExpiresAt: result.statusCredentialExpiresAt.toISOString(),
        });
    }
  }

  /**
   * Só o estado, a quem tem a credencial ainda válida. Credencial errada, vencida ou solicitação inexistente
   * são a mesma recusa; as falhas contam no limite por solicitação.
   */
  async status(rawRequestId: string, rawCredential: string): Promise<OnboardingStatusView> {
    const { store, attempts, invalidAttempt } = this.deps;
    const credentialHash = hashStatusCredential(rawCredential);
    if (!UUID.test(rawRequestId) || credentialHash === null) {
      throw new OnboardingError('STATUS_NOT_FOUND');
    }
    const invalid = invalidAttempt();
    try {
      const status = await attempts.run(JSON.stringify(['onboarding-status', rawRequestId]), async () => {
        const found = await store.findStatus(rawRequestId, credentialHash);
        if (found === null) {
          throw invalid;
        }
        return found;
      });
      return Object.freeze({ requestId: rawRequestId, status });
    } catch (error) {
      if (error === invalid) {
        throw new OnboardingError('STATUS_NOT_FOUND');
      }
      throw error;
    }
  }

  /** Só o código inválido conta como tentativa; o par alias + e-mail limita sem travar a turma inteira. */
  private async checkEnrollment(workspaceId: string, draft: OnboardingDraft): Promise<void> {
    const { enrollment, attempts, invalidAttempt } = this.deps;
    const invalid = invalidAttempt();
    try {
      // Só o aceite zera o contador: o pedido sem código sai por erro, sem contar nem zerar.
      await attempts.run(JSON.stringify(['enrollment', draft.alias, draft.email]), async () => {
        const checked = await enrollment.check(workspaceId, draft.enrollmentCode);
        if (checked === 'INVALID') {
          throw invalid;
        }
        if (checked === 'REQUIRED') {
          throw new OnboardingError('ENROLLMENT_CODE_REQUIRED');
        }
      });
    } catch (error) {
      if (error === invalid) {
        throw new OnboardingError('ENROLLMENT_CODE_INVALID');
      }
      throw error;
    }
  }
}
