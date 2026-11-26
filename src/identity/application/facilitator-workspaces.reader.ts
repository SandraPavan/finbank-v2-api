import type { WorkspaceModality } from '../domain/workspace-modality.js';

/** Situação do código de inscrição, nunca o código nem o hash. */
export interface WorkspaceEnrollmentSummary {
  readonly active: boolean;
  /** 0 = nenhum código jamais gerado. */
  readonly revision: number;
  /** SHARED: o onboarding exige código. */
  readonly required: boolean;
}

export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly alias: string | null;
  readonly modality: WorkspaceModality;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly enrollment: WorkspaceEnrollmentSummary;
}

export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

/** Porta de leitura dos workspaces de um facilitador ativo, somente por vínculo ativo. */
export interface FacilitatorWorkspacesReader {
  /** Ordem estável: criação do workspace e identificador. */
  list(identityId: string, page: PageRequest): Promise<WorkspaceSummary[]>;
  find(identityId: string, workspaceId: string): Promise<WorkspaceSummary | null>;
}
