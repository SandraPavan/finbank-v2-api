export interface WorkspaceSummary {
  readonly workspaceId: string;
  readonly alias: string | null;
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
