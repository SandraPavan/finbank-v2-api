import { ADULT_AGE, ageOn, type OnboardingDraft, OnboardingValidationError } from '../domain/onboarding-request.js';

/** Workspace localizado pelo alias; o alias não é credencial. */
export interface OnboardingWorkspace {
  readonly id: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

/** Solicitação pronta para gravar: dados normalizados, hash da senha e data simulada usada. */
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
}

export type OnboardingInsert =
  | { readonly kind: 'CREATED'; readonly requestId: string }
  | { readonly kind: 'DUPLICATE'; readonly fields: readonly ('cpf' | 'email')[] }
  | { readonly kind: 'ARCHIVED' };

/** Porta de persistência. */
export interface OnboardingStore {
  findWorkspace(alias: string): Promise<OnboardingWorkspace | null>;
  /**
   * Aprovação automática numa transação sob a trava do workspace: reconfere o estado e a unicidade (inclusive clientes),
   * cria o cliente, a senha, a conta comum e o vínculo, grava a solicitação `APPROVED` e a auditoria.
   */
  insert(request: NewOnboardingRequest, correlationId: string): Promise<OnboardingInsert>;
}

/** Portas dos módulos vizinhos, satisfeitas pelos serviços de inscrição e do relógio. */
export interface EnrollmentPort {
  check(workspaceId: string, provided: string | null): Promise<'ACCEPTED' | 'REQUIRED' | 'INVALID'>;
}
export interface ClockPort {
  today(workspaceId: string): Promise<{ readonly date: string; readonly revision: number }>;
}
/** Limita códigos de inscrição inválidos por assunto; `attempt` sinaliza falha com `InvalidAttempt`. */
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
  /** Converte o código inválido no erro que o limitador conta como falha. */
  readonly invalidAttempt: () => Error;
  readonly hasher: OnboardingHasher;
}

export type OnboardingErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_ARCHIVED'
  | 'ENROLLMENT_CODE_REQUIRED'
  | 'ENROLLMENT_CODE_INVALID'
  | 'UNDERAGE'
  | 'DUPLICATE';

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

export interface SubmittedOnboarding {
  readonly requestId: string;
  readonly status: 'APPROVED';
}

/** Submissão atômica da solicitação de abertura, aprovada automaticamente no fluxo normal. */
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
    const result = await store.insert({
      workspaceId: workspace.id,
      name: draft.name,
      cpf: draft.cpf,
      birthDate: draft.birthDate,
      email: draft.email,
      phone: draft.phone,
      passwordHash: await hasher.hash(draft.password),
      businessDate: today.date,
      clockRevision: today.revision,
    }, correlationId);
    if (result.kind === 'DUPLICATE') {
      throw new OnboardingError('DUPLICATE', result.fields);
    }
    if (result.kind === 'ARCHIVED') {
      throw new OnboardingError('WORKSPACE_ARCHIVED');
    }
    return Object.freeze({ requestId: result.requestId, status: 'APPROVED' });
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
