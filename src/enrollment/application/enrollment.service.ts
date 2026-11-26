import type { WorkspaceAccess } from '../../identity/domain/workspace-access.js';
import type { WorkspaceModality } from '../../identity/domain/workspace-modality.js';
import {
  checkEnrollment,
  type EnrollmentCheck,
  type EnrollmentCodeHash,
  generateEnrollmentCode,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
} from '../domain/enrollment-code.js';

/** Situação de inscrição de um workspace. Revisão 0 = nenhum código jamais gerado. */
export interface EnrollmentState {
  readonly modality: WorkspaceModality;
  readonly currentHash: EnrollmentCodeHash | null;
  readonly revision: number;
}

/** Resultado da gravação: o vínculo pode ter acabado ou o workspace ter sido arquivado. */
export type EnrollmentWrite = { readonly kind: 'WRITTEN'; readonly revision: number } | { readonly kind: 'UNCHANGED'; readonly revision: number } | { readonly kind: 'DENIED' } | { readonly kind: 'ARCHIVED' };

/** Porta de persistência das revisões. */
export interface EnrollmentStore {
  /** Situação vigente, ou null se o workspace não existe. */
  state(workspaceId: string): Promise<EnrollmentState | null>;
  /**
   * Numa transação serializada por workspace, com auditoria e reconferência do vínculo e do estado do workspace:
   * grava o hash numa revisão nova, ou, com null, revoga o vigente (sem vigente, UNCHANGED sem gravar).
   */
  write(access: WorkspaceAccess, hash: EnrollmentCodeHash | null, correlationId: string): Promise<EnrollmentWrite>;
}

export interface EnrollmentView {
  readonly workspaceId: string;
  readonly active: boolean;
  readonly revision: number;
  readonly required: boolean;
}

/** Devolvido uma única vez: é a única cópia em claro. */
export interface IssuedEnrollmentCode extends EnrollmentView {
  readonly code: string;
}

/** Acesso perdido entre a guarda e a gravação. */
export class EnrollmentAccessLostError extends Error {
  constructor() {
    super('Acesso ao workspace encerrado.');
    this.name = 'EnrollmentAccessLostError';
  }
}

export class EnrollmentWorkspaceArchivedError extends Error {
  constructor() {
    super('Workspace arquivado não aceita alteração do código de inscrição.');
    this.name = 'EnrollmentWorkspaceArchivedError';
  }
}

export class EnrollmentWorkspaceNotFoundError extends Error {
  constructor() {
    super('Workspace inexistente.');
    this.name = 'EnrollmentWorkspaceNotFoundError';
  }
}

/** Código de inscrição: geração e revogação pelo facilitador; verificação para o onboarding. */
export class EnrollmentService {
  constructor(private readonly store: EnrollmentStore) {}

  /** Gera ou rotaciona: o anterior deixa de valer. */
  async issue(access: WorkspaceAccess, correlationId: string): Promise<IssuedEnrollmentCode> {
    const state = await this.state(access.workspaceId);
    const code = generateEnrollmentCode();
    const result = written(await this.store.write(access, hashEnrollmentCode(normalizeEnrollmentCode(code) ?? ''), correlationId));
    return Object.freeze({ ...view(access.workspaceId, state.modality, true, result), code });
  }

  /** Revoga o vigente; sem vigente, nada muda. */
  async revoke(access: WorkspaceAccess, correlationId: string): Promise<EnrollmentView> {
    const state = await this.state(access.workspaceId);
    const result = written(await this.store.write(access, null, correlationId));
    return view(access.workspaceId, state.modality, false, result);
  }

  /** Verificação para o onboarding; o limite de tentativas fica com quem chama. */
  async check(workspaceId: string, provided: string | null): Promise<EnrollmentCheck> {
    const state = await this.state(workspaceId);
    return checkEnrollment(state.modality, state.currentHash, provided);
  }

  private async state(workspaceId: string): Promise<EnrollmentState> {
    const state = await this.store.state(workspaceId);
    if (state === null) {
      throw new EnrollmentWorkspaceNotFoundError();
    }
    return state;
  }
}

function written(result: EnrollmentWrite): number {
  if (result.kind === 'DENIED') {
    throw new EnrollmentAccessLostError();
  }
  if (result.kind === 'ARCHIVED') {
    throw new EnrollmentWorkspaceArchivedError();
  }
  return result.revision;
}

function view(workspaceId: string, modality: WorkspaceModality, active: boolean, revision: number): EnrollmentView {
  return Object.freeze({ workspaceId, active, revision, required: modality === 'SHARED' });
}
